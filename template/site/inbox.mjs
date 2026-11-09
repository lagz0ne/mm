// An item's inbox (sy-seqz): a person signed in through the gateway puts a file, or a zip, on an item; it lands, checked,
// in <project>/inbox/<item-id>/<upload>/ for the project's leads to read. No commit: inbox/ is outside every repo
// (the config repo keeps only what its .gitignore lists; code/ is its own repo). No dependency: the zip is read here.
//   POST   /api/inbox/<item>?name=<file name>   the file's bytes (application/octet-stream), from the board's own page
//   GET    /api/inbox/<item>                     the item's uploads: name, path, who, when, files (path and size)
//   DELETE /api/inbox/<item>/<upload>            the uploader or the owner: the folder goes, and a comment says so
// Who uploads: only the public side (the gateway's signed assertion), the owner, a designer or a member; never a viewer
// and never the local side (the leads write with bd and read the folder). Same-origin, as the owner's actions.
// One change to the inbox at a time (a queue in this process, its only writer): an upload or a removal waits for the one
// before it, up to BOARD_UPLOAD_WAIT_S (120 s); past that it is refused with 429, "try again".
// Nothing of an upload is held in memory: the body streams to a spool file on disk (cut at the size limit while it
// streams, and at BOARD_UPLOAD_IDLE_S of silence), and a zip is read from that file, its files inflated one by one,
// in 64 KB pieces, into a hidden temp folder beside the target, then renamed in.
// The checks, before anything lands: the body's size; the inbox's total on disk (all items together, BOARD_INBOX_MAX_MB,
// 2 GB) with this upload in it; a zip is a zip (no zip64, no encryption, stored or deflated only), its names (no
// absolute path, no "..", no backslash, no control character, no .git, no clash), its entries (files and folders only:
// no link, no device, no fifo), its file count and its unpacked size, read from the directory and then held to while it
// inflates (a zip bomb stops at the limit), each file's CRC; the secret scan (bin/lib/secret-scan.mjs) on every file, as
// it streams: a hit refuses it all and names the file and the kind, never the secret. No executable bit.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { SHAPES } from '../bin/lib/secret-scan.mjs'

const MB = 1 << 20
const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
/** The limits: the environment can change each one (the board's service env). */
export const limits = (env = process.env) => ({
  bytes: Math.floor(num(env.BOARD_UPLOAD_MAX_MB, 50) * MB), // the upload itself (the file or the zip)
  files: Math.floor(num(env.BOARD_UPLOAD_MAX_FILES, 1000)), // the files in a zip
  unpacked: Math.floor(num(env.BOARD_UPLOAD_MAX_UNPACKED_MB, 200) * MB), // a zip's files, unpacked, together
  inbox: Math.floor(num(env.BOARD_INBOX_MAX_MB, 2048) * MB), // the whole inbox/ on disk, every item's uploads together
  waitMs: Math.floor(num(env.BOARD_UPLOAD_WAIT_S, 120) * 1000), // how long an upload waits for the one before it
  idleMs: Math.floor(num(env.BOARD_UPLOAD_IDLE_S, 30) * 1000), // a body that sends nothing that long is cut
})
export const WRITERS = new Set(['owner', 'designer', 'member'])
const ITEM = /^[a-z][a-z0-9]*-[a-z0-9]+(?:\.\d+)*$/
const UPLOAD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const META = '.uploads.json'
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/
const CHUNK = 64 * 1024
const BLOCK = 4096
const MAX_DIRECTORY = 8 * MB // a zip's central directory (1000 entries need far less)
const WRITE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW

class Refused extends Error { constructor(code, msg) { super(msg); this.code = code } }
const no = (code, msg) => { throw new Refused(code, msg) }
export const human = (n) => (n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`)
const tooBig = (n, lim) => `${human(n)}: more than the ${human(lim.bytes)} an upload may be`
/** What a file of n bytes takes on disk, about (whole blocks). */
const onDisk = (n) => Math.max(BLOCK, Math.ceil(n / BLOCK) * BLOCK)

/** The secret scan over a stream: each piece with the end of the one before (a key cut in two is still seen). */
export function secretScanner(rel) {
  let tail = ''
  return (chunk) => {
    const text = tail + chunk.toString('latin1')
    const hit = SHAPES.find(([, re]) => re.test(text))
    if (hit) no(422, `${rel}: looks like ${hit[0]}. Nothing was taken: take the secret out and send it again`)
    tail = text.slice(-BLOCK)
  }
}

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

/** len bytes of the file at pos, or a refusal (the zip is cut short). */
function readAt(fd, pos, len, what = 'a broken zip (cut short)') {
  const b = Buffer.alloc(len)
  if (len && fs.readSync(fd, b, 0, len, pos) !== len) no(400, what)
  return b
}
/** The bytes [start, start+len) of the file, in pieces of 64 KB. */
function* pieces(fd, start, len) {
  while (len > 0) {
    const b = Buffer.allocUnsafe(Math.min(len, CHUNK)), k = fs.readSync(fd, b, 0, b.length, start)
    if (!k) no(400, 'a broken zip (cut short)')
    yield k === b.length ? b : b.subarray(0, k)
    start += k; len -= k
  }
}

/** A zip's directory, read from the file (not the file's data): [{ name, parts, dir, method, crc, csize, usize, at, shown }],
 *  every check on names, kinds, counts and declared sizes done. Throws Refused. */
export function zipDirectory(fd, size, lim) {
  if (size < 22) no(400, 'not a zip (no central directory)')
  const tailLen = Math.min(size, 22 + 0xffff), tailAt = size - tailLen, tail = readAt(fd, tailAt, tailLen)
  let e = -1
  for (let o = tail.length - 22; o >= 0; o--) if (tail.readUInt32LE(o) === 0x06054b50) { e = o; break }
  if (e < 0) no(400, 'not a zip (no central directory)')
  const eocd = tailAt + e
  if (eocd >= 20 && readAt(fd, eocd - 20, 4).readUInt32LE(0) === 0x07064b50) no(400, 'a zip64 file: not taken (make it a plain zip under the size limit)')
  const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16)
  if (count === 0xffff || cdAt === 0xffffffff || cdAt + cdSize > eocd) no(400, 'a zip64 or broken zip')
  if (count > lim.files) no(413, `${count} entries: more than the ${lim.files} files a zip may hold`)
  if (cdSize > MAX_DIRECTORY) no(400, 'a zip whose directory is too big')
  const cd = readAt(fd, cdAt, cdSize), u16 = (o) => cd.readUInt16LE(o), u32 = (o) => cd.readUInt32LE(o)
  const entries = [], seen = new Map()
  let o = 0, declared = 0, files = 0
  for (let i = 0; i < count; i++) {
    if (o + 46 > cdSize || u32(o) !== 0x02014b50) no(400, 'a broken zip (its directory)')
    const madeBy = u16(o + 4) >> 8, flags = u16(o + 8), method = u16(o + 10), crc = u32(o + 16), csize = u32(o + 20), usize = u32(o + 24)
    const nl = u16(o + 28), el = u16(o + 30), cl = u16(o + 32), ext = u32(o + 38), at = u32(o + 42)
    if (o + 46 + nl > cdSize) no(400, 'a broken zip (its directory)')
    const name = cd.subarray(o + 46, o + 46 + nl).toString(flags & 0x800 ? 'utf8' : 'latin1')
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
    if (at + 30 > size) no(400, `${shown}: a broken zip (its local header)`)
    entries.push({ name: key, parts, dir: false, method, crc, csize, usize, at, shown })
  }
  // a file where another entry needs a folder ("a" and "a/b")
  for (const x of entries) for (let k = 1; k < x.parts.length; k++) {
    const up = x.parts.slice(0, k).join('/')
    if (seen.get(up) === false) no(400, `${JSON.stringify(up)}: a file and a folder at once`)
  }
  return entries
}

/** One file of the zip, inflated from the zip file to `to` in pieces: held to its declared size (a bomb stops there),
 *  its CRC, the secret scan as it streams. Throws Refused. */
async function extract(fd, size, x, to) {
  const lh = readAt(fd, x.at, 30)
  if (lh.readUInt32LE(0) !== 0x04034b50) no(400, `${x.shown}: a broken zip (its local header)`)
  const start = x.at + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
  if (start + x.csize > size) no(400, `${x.shown}: a broken zip (cut short)`)
  const out = fs.openSync(to, WRITE, 0o664) // no executable bit, never through a link, never over a file
  const scan = secretScanner(x.name)
  let n = 0, crc = 0
  const sink = (c) => {
    n += c.length
    if (n > x.usize) no(413, `${x.shown}: inflates past its declared size (a zip bomb) or is broken`)
    crc = zlib.crc32(c, crc); scan(c); fs.writeSync(out, c)
  }
  try {
    if (x.method === 0) for (const c of pieces(fd, start, x.csize)) sink(c)
    else {
      await pipeline(Readable.from(pieces(fd, start, x.csize), { objectMode: false }), zlib.createInflateRaw(),
        new Writable({ write(c, _, cb) { try { sink(c); cb() } catch (err) { cb(err) } } }))
        .catch((err) => { if (err instanceof Refused) throw err; no(400, `${x.shown}: a broken zip (it does not inflate)`) })
    }
  } finally { fs.closeSync(out) }
  if (n !== x.usize || crc !== x.crc) no(400, `${x.shown}: its size or checksum is wrong (a broken zip)`)
}

/** The request's body, streamed to the file `to` (never held in memory): cut at lim.bytes while it streams (what passes
 *  the limit is not written), and after lim.idleMs without a byte. onPiece sees each piece (the secret scan). Its size. */
function spool(req, to, lim, onPiece) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(to, WRITE, 0o600)
    let n = 0, done = false, timer
    const finish = (err) => {
      if (done) return
      done = true; clearTimeout(timer)
      req.off('data', onData); req.off('end', onEnd); req.off('error', onBroke); req.off('close', onClose)
      fs.closeSync(fd)
      err ? reject(err) : resolve(n)
    }
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Refused(408, `The upload stalled (nothing for ${Math.round(lim.idleMs / 1000)} s): nothing was taken. Send it again.`)), lim.idleMs) }
    const onData = (c) => {
      n += c.length
      if (n > lim.bytes) return finish(new Refused(413, tooBig(n, lim))) // cut here: the rest is never written
      try { fs.writeSync(fd, c); onPiece?.(c) } catch (err) { return finish(err) }
      arm()
    }
    const onEnd = () => finish()
    const onBroke = () => finish(new Refused(400, 'The upload broke off: nothing was taken.'))
    const onClose = () => { if (!req.complete) onBroke() }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onBroke); req.on('close', onClose)
    arm()
  })
}

/** The bytes a folder takes on disk, everything under it (lstat: a link counts as itself, never followed). */
export function diskUse(d) {
  let n = 0, ents
  try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) {
    const p = path.join(d, e.name)
    let st
    try { st = fs.lstatSync(p) } catch { continue }
    n += st.blocks != null ? st.blocks * 512 : st.size
    if (st.isDirectory()) n += diskUse(p)
  }
  return n
}

/** The upload's file name, checked: a plain name (no folder), the characters most names have. */
export function uploadName(raw) {
  const n = String(raw || '').normalize('NFC').trim()
  if (!n || n.includes('/') || n.includes('\\') || CONTROL.test(n)) return null
  const clean = n.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(-100)
  return /^[A-Za-z0-9]/.test(clean) && clean !== '.' ? clean : null
}

// One change to the inbox at a time, in the order they came (this process is the only writer): a queue. A change that
// waits past waitMs gives up with 429; its turn, when it comes, passes at once.
let queue = Promise.resolve()
function turn(waitMs) {
  let release
  const mine = new Promise((r) => (release = r)), before = queue
  queue = before.then(() => mine)
  return new Promise((resolve, reject) => {
    let gaveUp = false
    const t = setTimeout(() => { gaveUp = true; reject(new Refused(429, `Another upload is landing on this board: try again in a minute (waited ${Math.round(waitMs / 1000)} s).`)) }, waitMs)
    before.then(() => { if (gaveUp) return release(); clearTimeout(t); resolve(release) })
  })
}

/** The routes. ctx: { ROOT, send, log, getItem, comment(item, author, role, text) -> bool, sameOrigin(req), env } */
export function inboxApi(ctx) {
  const INBOX = path.join(ctx.ROOT, 'inbox')
  const lim = () => limits(ctx.env || process.env)
  // the inbox and the item's folder: real folders, never a link (a link would send the files elsewhere).
  // { dir, made }: made lists the folders made here (removed again when the upload is refused).
  function itemDir(item, make) {
    const made = []
    for (const d of [INBOX, path.join(INBOX, item)]) {
      let st = null
      try { st = fs.lstatSync(d) } catch {}
      if (st && !st.isDirectory()) no(500, 'the inbox is not a plain folder here: ask ops')
      if (!st) { if (!make) return { dir: null, made }; fs.mkdirSync(d, { mode: 0o2775 }); made.push(d) }
    }
    return { dir: path.join(INBOX, item), made }
  }
  const readMeta = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')) || {} } catch { return {} } }
  function writeMeta(dir, m) {
    const tmp = path.join(dir, `.uploads.${crypto.randomUUID()}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n', { mode: 0o664, flag: 'wx' }); fs.renameSync(tmp, path.join(dir, META))
  }
  function list(item) {
    const { dir } = itemDir(item, false); if (!dir) return []
    const m = readMeta(dir)
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && UPLOAD.test(d.name)).map((d) => {
      const r = m[d.name] || {}
      return { name: d.name, path: `inbox/${item}/${d.name}/`, by: r.by || null, at: r.at || null, files: Array.isArray(r.files) ? r.files : [], total: r.total || 0 }
    }).sort((a, b) => String(a.at).localeCompare(String(b.at)))
  }
  /** Refused when the inbox, with `need` more bytes on disk, would pass its cap. */
  function room(used, need, L) {
    if (used + need > L.inbox) no(413, `The inbox is full: it holds ${human(used)} of its ${human(L.inbox)} and this upload needs ${human(need)}. Nothing was taken: remove an old upload first.`)
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
    const L = lim(), isZip = /\.zip$/i.test(fileName), declared = Number(req.headers['content-length'] || 0)
    if (declared > L.bytes) no(413, tooBig(declared, L)) // before a byte is read
    const release = await turn(L.waitMs)
    let made = [], tmp = null, spoolAt = null
    try {
      const at = itemDir(item, true), dir = at.dir
      made = at.made
      const used = diskUse(INBOX) // nothing else writes it while this upload has its turn
      room(used, isZip ? 0 : declared && onDisk(declared), L) // a plain file says its size: refused before it streams
      tmp = fs.mkdtempSync(path.join(dir, '.incoming-'))
      let files
      if (!isZip) {
        const n = await spool(req, path.join(tmp, fileName), L, secretScanner(fileName))
        if (!n) no(400, 'An empty file.')
        room(used, onDisk(n), L)
        files = [{ path: fileName, size: n }]
      } else {
        spoolAt = path.join(dir, `.spool-${crypto.randomUUID()}`)
        const n = await spool(req, spoolAt, L)
        if (!n) no(400, 'An empty file.')
        const fd = fs.openSync(spoolAt, 'r')
        try {
          const magic = n >= 22 ? readAt(fd, 0, 4).readUInt32LE(0) : 0
          if (magic !== 0x04034b50 && magic !== 0x06054b50) no(400, `${fileName}: not a zip`)
          const entries = zipDirectory(fd, n, L), want = entries.filter((x) => !x.dir)
          if (!want.length) no(400, `${fileName}: an empty zip`)
          room(used, want.reduce((s, x) => s + onDisk(x.usize), 0) + (entries.length - want.length) * BLOCK, L)
          for (const x of want) {
            const to = path.join(tmp, ...x.parts)
            if (!to.startsWith(tmp + path.sep)) no(400, `${x.name}: outside the upload`)
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o2775 })
            await extract(fd, n, x, to)
          }
          files = want.map((x) => ({ path: x.name, size: x.usize }))
        } finally { fs.closeSync(fd) }
      }
      const base = (fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'upload').slice(0, 72).replace(/[.-]+$/, '') || 'upload'
      let name = base
      for (let k = 2; fs.existsSync(path.join(dir, name)); k++) { if (k > 99) no(409, 'Too many uploads of that name: remove one first.'); name = `${base}-${k}` }
      fs.renameSync(tmp, path.join(dir, name)); tmp = null
      const total = files.reduce((s, f) => s + f.size, 0), kind = isZip ? 'zip' : 'file'
      const m = readMeta(dir); m[name] = { by: g.u, role: g.r, at: new Date().toISOString(), from: fileName, kind, files, total }; writeMeta(dir, m)
      const where = `inbox/${item}/${name}/`
      const shownFiles = files.slice(0, 40).map((f) => `- \`${f.path}\` (${human(f.size)})`)
      const text = `Uploaded ${isZip ? `${fileName}, unpacked,` : fileName} to \`${where}\` (in the project's folder): ${files.length} file${files.length === 1 ? '' : 's'}, ${human(total)}.\n\n${shownFiles.join('\n')}${files.length > 40 ? `\n- and ${files.length - 40} more` : ''}`
      if (!(await ctx.comment(item, g.u, g.r, text))) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true }); delete m[name]; writeMeta(dir, m)
        no(502, 'The board could not write the comment: nothing was kept. Try again.')
      }
      ctx.log('info', `upload to ${where} by ${g.u}: ${files.length} file(s), ${total} bytes`, { op: 'inbox', action: 'upload', actor: g.u, role: g.r, item, files: files.length, bytes: total })
      return { ok: true, name, path: where, files, total, title: `${files.length} file${files.length === 1 ? '' : 's'} in ${where}` }
    } catch (e) {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
      for (const d of made.reverse()) try { fs.rmdirSync(d) } catch {} // only if still empty
      throw e
    } finally {
      if (spoolAt) fs.rmSync(spoolAt, { force: true })
      release()
    }
  }

  async function remove(req, item, name) {
    const g = who(req, 'remove an upload')
    if (!ITEM.test(item) || !UPLOAD.test(name)) no(400, 'Not an upload.')
    await liveItem(item)
    const release = await turn(lim().waitMs)
    try {
      const { dir } = itemDir(item, false), at = dir && path.join(dir, name)
      let st = null
      try { st = at && fs.lstatSync(at) } catch {}
      if (!st || !st.isDirectory()) no(404, `inbox/${item}/${name}/: no such upload.`)
      const m = readMeta(dir), by = m[name]?.by
      if (g.r !== 'owner' && by !== g.u) no(403, 'Not allowed: only the person who uploaded it, or the owner, removes it.')
      fs.rmSync(at, { recursive: true, force: true }); delete m[name]; writeMeta(dir, m)
      await ctx.comment(item, g.u, g.r, `Removed the upload \`inbox/${item}/${name}/\`.`)
      ctx.log('info', `upload inbox/${item}/${name}/ removed by ${g.u}`, { op: 'inbox', action: 'remove', actor: g.u, role: g.r, item })
      return { ok: true, title: `Removed inbox/${item}/${name}/` }
    } finally { release() }
  }

  /** What is left of a refused body: read and dropped (never kept), so the client reads the answer; cut past a bound. */
  function drain(req) {
    if (req.complete || req.destroyed) return
    let n = 0
    const max = 2 * lim().bytes + MB
    req.on('data', (c) => { n += c.length; if (n > max) req.destroy() })
    req.on('error', () => {})
    req.resume()
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
      ctx.log('info', `inbox refused: ${e.message}`, { op: 'inbox', actor: req.gateway?.u, role: req.gateway?.r, item, code: e.code })
      if (!res.destroyed) ctx.send(res, e.code, { title: e.message })
      drain(req)
    }
    return true
  }
}
