// The Files view (sy-oprc; docs/board/sy-oprc-files.md): the board's own document folders, one folder at a time, and
// each file's bytes with its type. Read-only. Only the folders in TOPS (each when present); never a dotfile, a
// forbidden name, or a link whose real path leaves its folder. Every refusal is a 404, the same as a missing file.
// plans/ and memory/ are the team's: on the public side only an owner, member or designer sees them (a viewer, a
// client, gets the 404 and no entry). Every file shown or served passes the key scan (bin/lib/secret-scan.mjs): one
// that looks like it holds a key is a 404 and left out of its folder's list, with nothing that says why.
//   GET /api/files?path=<folder>     the folder's entries (no path: the top folders that exist)
//   GET /api/files/raw/<path>        the file (?download=1: as an attachment)
import fs from 'node:fs'
import path from 'node:path'
import { secretsIn } from '../bin/lib/secret-scan.mjs'

/** The folders the view shows, relative to the board's root. */
export const TOPS = ['artifacts', 'docs', 'plans', 'memory', 'code/docs']
/** The folders only the team reads: the local side, or the public side's owner, member or designer. */
export const INNER = new Set(['plans', 'memory'])
export const INNER_ROLES = new Set(['owner', 'member', 'designer'])
// names never shown, at any depth (dotfiles are refused apart: .env*, .git, .run, ...)
const FORBIDDEN = /^(secrets?([._-].*)?|node_modules|inbox|id_[a-z0-9]+|.*\.(pem|key|p12|pfx))$/i
const SEGMENT = /^[^./\\\0][^/\\\0]*$/ // no dotfile, no separator, no NUL
export const VIEW_MAX = 2 << 20 // larger: download only
export const SCAN_MAX = 64 << 20 // larger: not scanned, so never served
const SCAN_CHUNK = 1 << 20, SCAN_OVERLAP = 4096 // a key cut by a chunk's end is whole in the next (every shape is shorter)

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
const KIND_OF_EXT = { '.md': 'markdown', '.markdown': 'markdown', '.mmd': 'mermaid', '.mermaid': 'mermaid', '.html': 'html', '.htm': 'html' }
const BINARY_EXT = new Set(['.pdf', '.zip', '.gz', '.tgz', '.tar', '.mp3', '.mp4', '.webm', '.woff', '.woff2', '.ttf', '.ico', '.db', '.sqlite', '.bin', '.exe', '.so'])
// served headers: never sniffed, never run (the CSP's sandbox has no tokens: no script, no same-origin)
const CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'"

/** The kind of a file: image, markdown, mermaid, html, text or binary (by extension, else the first 8 KB). */
function kindOf(file, size) {
  const ext = path.extname(file).toLowerCase()
  if (IMAGE[ext]) return 'image'
  if (KIND_OF_EXT[ext]) return KIND_OF_EXT[ext]
  if (BINARY_EXT.has(ext)) return 'binary'
  if (!size) return 'text'
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const b = Buffer.alloc(Math.min(8192, size)), n = fs.readSync(fd, b, 0, b.length, 0)
    const s = b.subarray(0, n)
    if (s.includes(0)) return 'binary'
    try { new TextDecoder('utf-8', { fatal: true }).decode(n < size ? s.subarray(0, Math.max(0, n - 3)) : s) } catch { return 'binary' }
    return 'text'
  } catch { return 'binary' } finally { if (fd !== undefined) fs.closeSync(fd) }
}
const typeOf = (file, kind) => IMAGE[path.extname(file).toLowerCase()] || (kind === 'html' ? 'text/html; charset=utf-8'
  : kind === 'binary' ? 'application/octet-stream' : kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')

/** Whether the file open on fd looks like it holds a key (true too when it is too large to scan). Read by position. */
function scanFd(fd, size) {
  if (size > SCAN_MAX) return true
  const b = Buffer.alloc(Math.min(size, SCAN_CHUNK + SCAN_OVERLAP))
  for (let at = 0; at < size; at += SCAN_CHUNK) {
    const want = Math.min(b.length, size - at), n = fs.readSync(fd, b, 0, want, at)
    if (secretsIn(b.subarray(0, n)).length) return true
    if (n < want) break // shorter than its stat: what was read is all there is
  }
  return false
}

/** The scan's answers by real path, kept while the file's mtime, size and inode stay the same. */
export function scanCache(max = 5000) {
  const memo = new Map()
  return function looksLikeKey(real, st, fd) {
    const key = `${st.mtimeMs}:${st.size}:${st.ino}`, hit = memo.get(real)
    if (hit && hit.key === key) return hit.hit
    let own, found
    try {
      if (fd === undefined) own = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      found = scanFd(fd ?? own, st.size)
    } catch { return true } finally { if (own !== undefined) fs.closeSync(own) }
    memo.delete(real)
    if (memo.size >= max) memo.delete(memo.keys().next().value)
    memo.set(real, { key, hit: found })
    return found
  }
}

/** inner(req): whether the asker may see plans/ and memory/ (the local side; the public side's team roles). */
export function filesApi({ ROOT, send, inner = () => true }) {
  const realOf = (p) => { try { return fs.realpathSync(p) } catch { return null } }
  const looksLikeKey = scanCache()
  /** The checked target of a relative path: { rel, real, top } or null (refused or missing). */
  function resolve(rel, req) {
    if (typeof rel !== 'string' || rel.length > 1024) return null
    const parts = rel.replace(/\/$/, '').split('/')
    if (!parts.length || parts.some((s) => !SEGMENT.test(s) || FORBIDDEN.test(s))) return null
    const clean = parts.join('/')
    const top = TOPS.find((t) => clean === t || clean.startsWith(t + '/'))
    if (!top || (INNER.has(top) && !inner(req))) return null
    const root = realOf(ROOT), topReal = realOf(path.join(ROOT, top))
    // the top folder itself must be a folder inside the board's root (no link out of it)
    if (!root || !topReal || !topReal.startsWith(root + path.sep) || topReal !== path.join(root, top)) return null
    const real = realOf(path.join(ROOT, clean))
    if (!real || (real !== topReal && !real.startsWith(topReal + path.sep))) return null
    // every step of the real path, below the top folder, must pass the same name rules (a link to .git, secrets/, ...)
    if (path.relative(topReal, real).split(path.sep).some((s) => s && (!SEGMENT.test(s) || FORBIDDEN.test(s)))) return null
    return { rel: clean, real, top }
  }
  function entry(req, dirRel, name) {
    if (!SEGMENT.test(name) || FORBIDDEN.test(name)) return null
    const t = resolve(`${dirRel}/${name}`, req)
    if (!t) return null
    let st
    try { st = fs.statSync(t.real) } catch { return null }
    if (!st.isDirectory() && !st.isFile()) return null
    if (st.isFile() && looksLikeKey(t.real, st)) return null
    const dir = st.isDirectory()
    return { name, path: t.rel, dir, kind: dir ? 'folder' : kindOf(t.real, st.size), size: dir ? 0 : st.size, mtime: st.mtime.toISOString() }
  }
  const order = (a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name))

  function list(req, res, rel) {
    if (!rel) {
      const entries = TOPS.flatMap((top) => {
        const t = resolve(top, req)
        if (!t) return []
        try { const st = fs.statSync(t.real); return st.isDirectory() ? [{ name: top, path: top, dir: true, kind: 'folder', size: 0, mtime: st.mtime.toISOString() }] : [] } catch { return [] }
      })
      return send(res, 200, { path: '', entries })
    }
    const t = resolve(rel, req)
    let st
    try { st = t && fs.statSync(t.real) } catch {}
    if (!t || !st?.isDirectory()) return send(res, 404, { title: 'not available' })
    let names = []
    try { names = fs.readdirSync(t.real) } catch {}
    send(res, 200, { path: t.rel, entries: names.map((n) => entry(req, t.rel, n)).filter(Boolean).sort(order) })
  }

  function raw(req, res, rel, download) {
    const t = rel && resolve(rel, req)
    let fd, st
    try {
      if (!t) throw new Error('refused')
      fd = fs.openSync(t.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      st = fs.fstatSync(fd)
      if (!st.isFile()) throw new Error('not a file')
      if (looksLikeKey(t.real, st, fd)) throw new Error('refused') // the same 404 as a missing file
    } catch {
      if (fd !== undefined) fs.closeSync(fd)
      return send(res, 404, { title: 'not available' })
    }
    const kind = kindOf(t.real, st.size)
    const name = path.basename(t.real).replace(/[^\w.-]/g, '_')
    res.writeHead(200, { 'content-type': download ? 'application/octet-stream' : typeOf(t.real, kind), 'content-length': st.size,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer',
      ...(download || kind === 'binary' ? { 'content-disposition': `attachment; filename="${name}"` } : {}) })
    if (res.req?.method === 'HEAD') { fs.closeSync(fd); return res.end() }
    fs.createReadStream(null, { fd, start: 0, autoClose: true }).pipe(res)
  }

  /** Answers a Files request; false when the path is not one of its routes. */
  return function files(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (url.pathname === '/api/files') { list(req, res, url.searchParams.get('path') || ''); return true }
    if (url.pathname.startsWith('/api/files/raw/')) {
      let rel = null
      try { rel = decodeURIComponent(url.pathname.slice('/api/files/raw/'.length)) } catch {}
      raw(req, res, rel, url.searchParams.get('download') === '1')
      return true
    }
    return false
  }
}
