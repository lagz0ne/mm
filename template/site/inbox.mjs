// An item's inbox (sy-seqz): a person signed in through the gateway puts a file, or a zip, on an item; it lands, checked,
// in <project>/inbox/<item-id>/<upload>/ for the project's leads to read. No commit: inbox/ is outside every repo
// (the config repo keeps only what its .gitignore lists; code/ is its own repo). No dependency: the zip is read here.
//   POST   /api/inbox/<item>?name=<file name>   the file's bytes (application/octet-stream), from the board's own page
//   GET    /api/inbox/<item>                     the item's uploads: name, path, who, when, files (path and size)
//   DELETE /api/inbox/<item>/<upload>            the uploader or the owner: the folder goes, and a comment says so
// Who uploads: only the public side (the gateway's signed assertion), the owner, a designer or a member; never a viewer
// and never the local side (the leads write with bd and read the folder). Same-origin, as the owner's actions.
// The checks, before anything lands: the body's size; a zip is a zip (no zip64, no encryption, stored or deflated
// only), its names (no absolute path, no "..", no backslash, no control character, no .git, no clash), its entries
// (files and folders only: no link, no device, no fifo), its file count and its unpacked size, read from the
// directory and then held to while it inflates (a zip bomb stops at the limit), each file's CRC; the secret scan
// (bin/lib/secret-scan.mjs) on every file: a hit refuses it all and names the file and the kind, never the secret.
// The files are written without an executable bit, into a hidden temp folder beside the target, then renamed in.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { secretsIn } from '../bin/lib/secret-scan.mjs'

const MB = 1 << 20
const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
/** The limits: the environment can change each one (the board's service env). */
export const limits = (env = process.env) => ({
  bytes: Math.floor(num(env.BOARD_UPLOAD_MAX_MB, 50) * MB), // the upload itself (the file or the zip)
  files: Math.floor(num(env.BOARD_UPLOAD_MAX_FILES, 1000)), // the files in a zip
  unpacked: Math.floor(num(env.BOARD_UPLOAD_MAX_UNPACKED_MB, 200) * MB), // a zip's files, unpacked, together
})
export const WRITERS = new Set(['owner', 'designer', 'member'])
const ITEM = /^[a-z][a-z0-9]*-[a-z0-9]+(?:\.\d+)*$/
const UPLOAD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const META = '.uploads.json'
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

class Refused extends Error { constructor(code, msg) { super(msg); this.code = code } }
const no = (code, msg) => { throw new Refused(code, msg) }
export const human = (n) => (n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`)

/** A name inside a zip, checked: its parts, or a refusal that says why. Folders end with "/". */
export function entryPath(name) {
  const shown = JSON.stringify(name.slice(0, 120))
  if (!name || CONTROL.test(name)) no(400, `${shown}: a name with a control character`)
  if (name.includes('\\')) no(400, `${shown}: a backslash in a path`)
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) no(400, `${shown}: an absolute path`)
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.includes('..')) no(400, `${shown}: a ".." path`)
  if (parts.some((p) => p === '' || p === '.')) no(400, `${shown}: an empty or "." part in a path`)
  if (parts.some((p) => p.toLowerCase() === '.git')) no(400, `${shown}: a .git folder`)
  if (parts.length > 32 || name.length > 1024 || parts.some((p) => Buffer.byteLength(p) > 255)) no(400, `${shown}: a path too long or too deep`)
  return parts
}

/** The entries of a zip: [{ name, parts, dir, data }], every check above done. Throws Refused. */
export function unzip(buf, lim) {
  const u16 = (o) => buf.readUInt16LE(o), u32 = (o) => buf.readUInt32LE(o)
  let eocd = -1
  for (let o = buf.length - 22; o >= Math.max(0, buf.length - 22 - 0xffff); o--) if (u32(o) === 0x06054b50) { eocd = o; break }
  if (eocd < 0) no(400, 'not a zip (no central directory)')
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) no(400, 'a zip64 file: not taken (make it a plain zip under the size limit)')
  const count = u16(eocd + 10), cdSize = u32(eocd + 12), cdAt = u32(eocd + 16)
  if (count === 0xffff || cdAt === 0xffffffff || cdAt + cdSize > eocd) no(400, 'a zip64 or broken zip')
  if (count > lim.files) no(413, `${count} entries: more than the ${lim.files} files a zip may hold`)
  const entries = [], seen = new Map()
  let o = cdAt, declared = 0, files = 0
  for (let i = 0; i < count; i++) {
    if (o + 46 > eocd || u32(o) !== 0x02014b50) no(400, 'a broken zip (its directory)')
    const madeBy = u16(o + 4) >> 8, flags = u16(o + 8), method = u16(o + 10), crc = u32(o + 16), csize = u32(o + 20), usize = u32(o + 24)
    const nl = u16(o + 28), el = u16(o + 30), cl = u16(o + 32), ext = u32(o + 38), at = u32(o + 42)
    const name = buf.subarray(o + 46, o + 46 + nl).toString(flags & 0x800 ? 'utf8' : 'latin1')
    o += 46 + nl + el + cl
    if (/^__MACOSX(\/|$)/.test(name)) continue // the Finder's resource forks: not files of the upload
    const parts = entryPath(name), shown = JSON.stringify(name.slice(0, 120))
    if (flags & 1) no(400, `${shown}: encrypted (send it without a password)`)
    const mode = madeBy === 3 ? ext >>> 16 : 0, type = mode & 0o170000
    const dir = name.endsWith('/') || type === 0o040000 || (madeBy !== 3 && (ext & 0x10) !== 0)
    if (type === 0o120000) no(400, `${shown}: a link (links are not taken)`)
    if (type && type !== 0o100000 && type !== 0o040000) no(400, `${shown}: a device, fifo or socket (only files and folders are taken)`)
    const key = parts.join('/')
    if (seen.has(key)) no(400, `${shown}: twice in the zip`)
    seen.set(key, dir)
    if (dir) { entries.push({ name: key, parts, dir: true }); continue }
    if (method !== 0 && method !== 8) no(400, `${shown}: packed with method ${method} (only stored or deflated are taken)`)
    if (++files > lim.files) no(413, `more than ${lim.files} files`)
    declared += usize
    if (declared > lim.unpacked) no(413, `more than ${human(lim.unpacked)} unpacked (a zip bomb, or too big)`)
    if (at + 30 > buf.length || u32(at) !== 0x04034b50) no(400, `${shown}: a broken zip (its local header)`)
    const start = at + 30 + u16(at + 26) + u16(at + 28)
    if (start + csize > buf.length) no(400, `${shown}: a broken zip (cut short)`)
    const raw = buf.subarray(start, start + csize)
    let data
    if (method === 0) data = raw
    else {
      // held to the size the directory says: a file that inflates past it stops here (maxOutputLength)
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }) } catch { no(413, `${shown}: inflates past its declared size (a zip bomb) or is broken`) }
    }
    if (data.length !== usize || zlib.crc32(data) !== crc) no(400, `${shown}: its size or checksum is wrong (a broken zip)`)
    entries.push({ name: key, parts, dir: false, data })
  }
  // a file where another entry needs a folder ("a" and "a/b")
  for (const e of entries) for (let k = 1; k < e.parts.length; k++) {
    const up = e.parts.slice(0, k).join('/')
    if (seen.get(up) === false) no(400, `${JSON.stringify(up)}: a file and a folder at once`)
  }
  return entries
}

/** The checked upload, ready to write: { kind, files: [{ rel, data }] }. Throws Refused. */
export function check(fileName, buf, lim) {
  if (buf.length > lim.bytes) no(413, `${human(buf.length)}: more than the ${human(lim.bytes)} an upload may be`)
  const isZip = /\.zip$/i.test(fileName)
  let files
  if (isZip) {
    if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(0) !== 0x06054b50) no(400, `${fileName}: not a zip`)
    files = unzip(buf, lim).filter((e) => !e.dir).map((e) => ({ rel: e.name, data: e.data }))
    if (!files.length) no(400, `${fileName}: an empty zip`)
  } else files = [{ rel: fileName, data: buf }]
  for (const f of files) {
    const kinds = secretsIn(f.data)
    if (kinds.length) no(422, `${f.rel}: looks like ${kinds[0]}. Nothing was taken: take the secret out and send it again`)
  }
  return { kind: isZip ? 'zip' : 'file', files }
}

/** The upload's file name, checked: a plain name (no folder), the characters most names have. */
export function uploadName(raw) {
  const n = String(raw || '').normalize('NFC').trim()
  if (!n || n.includes('/') || n.includes('\\') || CONTROL.test(n)) return null
  const clean = n.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(-100)
  return /^[A-Za-z0-9]/.test(clean) && clean !== '.' ? clean : null
}

// one change to an inbox at a time (this process is the only writer)
let chain = Promise.resolve()
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }

/** The routes. ctx: { ROOT, send, log, getItem, comment(item, author, role, text) -> bool, sameOrigin(req), env } */
export function inboxApi(ctx) {
  const INBOX = path.join(ctx.ROOT, 'inbox')
  const lim = () => limits(ctx.env || process.env)
  // the inbox and the item's folder: real folders, never a link (a link would send the files elsewhere)
  function itemDir(item, make) {
    for (const d of [INBOX, path.join(INBOX, item)]) {
      let st = null
      try { st = fs.lstatSync(d) } catch {}
      if (st && !st.isDirectory()) no(500, 'the inbox is not a plain folder here: ask ops')
      if (!st) { if (!make) return null; fs.mkdirSync(d, { mode: 0o2775 }) }
    }
    return path.join(INBOX, item)
  }
  const readMeta = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')) || {} } catch { return {} } }
  function writeMeta(dir, m) {
    const tmp = path.join(dir, `.uploads.${crypto.randomUUID()}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n', { mode: 0o664, flag: 'wx' }); fs.renameSync(tmp, path.join(dir, META))
  }
  function list(item) {
    const dir = itemDir(item, false); if (!dir) return []
    const m = readMeta(dir)
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && UPLOAD.test(d.name)).map((d) => {
      const r = m[d.name] || {}
      return { name: d.name, path: `inbox/${item}/${d.name}/`, by: r.by || null, at: r.at || null, files: Array.isArray(r.files) ? r.files : [], total: r.total || 0 }
    }).sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }
  async function readBody(req, max) {
    const declared = Number(req.headers['content-length'] || 0)
    const chunks = []; let n = 0, over = declared > max
    for await (const c of req) {
      n += c.length
      if (n > max) { over = true; chunks.length = 0 }
      if (over) { if (n > 4 * max + MB) { req.destroy(); break } continue } // drain a little, so the answer is read
      chunks.push(c)
    }
    if (over) no(413, `${human(Math.max(n, declared))}: more than the ${human(max)} an upload may be`)
    return Buffer.concat(chunks)
  }
  function who(req, what) {
    const g = req.gateway
    if (!g) no(403, `Not allowed: ${what} signed in on the board's public address (the leads read the inbox, they do not fill it).`)
    if (!WRITERS.has(g.r)) no(403, `Not allowed: a ${g.r} can look, not ${what}.`)
    if (!ctx.sameOrigin(req)) no(403, 'Not allowed: use the board\'s own page.')
    return g
  }
  async function liveItem(item) {
    if (!ITEM.test(item)) no(400, 'Not an item id.')
    const it = await ctx.getItem(item)
    if (!it || typeof it !== 'object' || it.id !== item) no(404, `${item}: no such item here.`)
    return it
  }

  async function upload(req, item, url) {
    const g = who(req, 'upload')
    if (!/^application\/octet-stream\b/i.test(String(req.headers['content-type'] || ''))) no(415, 'Send the file\'s bytes (application/octet-stream) from the board\'s own page.')
    const fileName = uploadName(url.searchParams.get('name'))
    if (!fileName) no(400, 'A file name: letters, digits, . _ - (no folder).')
    const it = await liveItem(item)
    if (it.status === 'closed') no(409, `${item} is closed.`)
    const L = lim(), buf = await readBody(req, L.bytes)
    if (!buf.length) no(400, 'An empty file.')
    const up = check(fileName, buf, L)
    return serial(async () => {
      const dir = itemDir(item, true)
      const base = (fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'upload').slice(0, 72).replace(/[.-]+$/, '') || 'upload'
      let name = base
      for (let k = 2; fs.existsSync(path.join(dir, name)); k++) { if (k > 99) no(409, 'Too many uploads of that name: remove one first.'); name = `${base}-${k}` }
      const tmp = fs.mkdtempSync(path.join(dir, '.incoming-'))
      try {
        for (const f of up.files) {
          const to = path.join(tmp, ...f.rel.split('/'))
          if (!to.startsWith(tmp + path.sep)) no(400, `${f.rel}: outside the upload`)
          fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o2775 })
          // no executable bit, never through a link, never over a file (O_EXCL)
          const fd = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o664)
          try { fs.writeSync(fd, f.data) } finally { fs.closeSync(fd) }
        }
        fs.renameSync(tmp, path.join(dir, name))
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e }
      const files = up.files.map((f) => ({ path: f.rel, size: f.data.length })), total = files.reduce((s, f) => s + f.size, 0)
      const m = readMeta(dir); m[name] = { by: g.u, role: g.r, at: new Date().toISOString(), from: fileName, kind: up.kind, files, total }; writeMeta(dir, m)
      const where = `inbox/${item}/${name}/`
      const shownFiles = files.slice(0, 40).map((f) => `- \`${f.path}\` (${human(f.size)})`)
      const text = `Uploaded ${up.kind === 'zip' ? `${fileName}, unpacked,` : fileName} to \`${where}\` (in the project's folder): ${files.length} file${files.length === 1 ? '' : 's'}, ${human(total)}.\n\n${shownFiles.join('\n')}${files.length > 40 ? `\n- and ${files.length - 40} more` : ''}`
      if (!(await ctx.comment(item, g.u, g.r, text))) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true }); delete m[name]; writeMeta(dir, m)
        no(502, 'The board could not write the comment: nothing was kept. Try again.')
      }
      ctx.log('info', `upload to ${where} by ${g.u}: ${files.length} file(s), ${total} bytes`, { op: 'inbox', action: 'upload', actor: g.u, role: g.r, item, files: files.length, bytes: total })
      return { ok: true, name, path: where, files, total, title: `${files.length} file${files.length === 1 ? '' : 's'} in ${where}` }
    })
  }

  async function remove(req, item, name) {
    const g = who(req, 'remove an upload')
    if (!ITEM.test(item) || !UPLOAD.test(name)) no(400, 'Not an upload.')
    await liveItem(item)
    return serial(async () => {
      const dir = itemDir(item, false), at = dir && path.join(dir, name)
      let st = null
      try { st = at && fs.lstatSync(at) } catch {}
      if (!st || !st.isDirectory()) no(404, `inbox/${item}/${name}/: no such upload.`)
      const m = readMeta(dir), by = m[name]?.by
      if (g.r !== 'owner' && by !== g.u) no(403, 'Not allowed: only the person who uploaded it, or the owner, removes it.')
      fs.rmSync(at, { recursive: true, force: true }); delete m[name]; writeMeta(dir, m)
      await ctx.comment(item, g.u, g.r, `Removed the upload \`inbox/${item}/${name}/\`.`)
      ctx.log('info', `upload inbox/${item}/${name}/ removed by ${g.u}`, { op: 'inbox', action: 'remove', actor: g.u, role: g.r, item })
      return { ok: true, title: `Removed inbox/${item}/${name}/` }
    })
  }

  /** Handles /api/inbox/...; returns false for any other path. */
  return async function inbox(req, res, url) {
    const m = /^\/api\/inbox\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname)
    if (!m) return false
    let item, name
    try { item = decodeURIComponent(m[1]); name = m[2] && decodeURIComponent(m[2]) } catch { ctx.send(res, 400, { title: 'Bad path' }); return true }
    try {
      if (req.method === 'GET' && !name) {
        if (!ITEM.test(item)) no(400, 'Not an item id.')
        const l = lim()
        ctx.send(res, 200, { uploads: list(item), can: !!(req.gateway && WRITERS.has(req.gateway.r)), me: req.gateway?.u || null, owner: req.gateway?.r === 'owner', limits: l })
      } else if (req.method === 'POST' && !name) ctx.send(res, 200, await upload(req, item, url))
      else if (req.method === 'DELETE' && name) ctx.send(res, 200, await remove(req, item, name))
      else ctx.send(res, 405, { title: 'Not here' })
    } catch (e) {
      if (!(e instanceof Refused)) throw e
      ctx.log('info', `inbox refused: ${e.message}`, { op: 'inbox', actor: req.gateway?.u, role: req.gateway?.r, item })
      if (!req.complete) req.resume()
      ctx.send(res, e.code, { title: e.message })
    }
    return true
  }
}
