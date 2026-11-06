// Designs on the board (plans/doop.md step 5): the project's Doop frames linked to an item, as images, with what changed
// since the last version and "open in Doop", for each role's view (design, requirement, QA, the human's summary).
//
// - Read-only. The board's server asks the project's Doop on loopback through Doop's MCP, with the design lead's agent
//   key ({root}/secrets/doop-agent-key, the file bin/doop-mcp-headers reads). The key stays in this process: it is never
//   sent to a browser, logged or put in a URL. The board's server only calls read tools.
// - What it sees is what the design lead's Doop account sees.
// - How an item links a frame. The design lead (or anyone on the item) writes it:
//     `doop:<frame id>` in the description or a comment; `doop:canvas/<canvas id>` links every frame of a canvas;
//     a Doop link (https://doop.../c/<canvas>?frame=<frame>, or /c/<canvas>) works the same;
//   or Doop's side: a frame whose name names the item id (e.g. "pg-a1b · Sign-in").
// - Images: rendered by Doop (its Chromium), fetched by this server, cached on disk under {root}/.cache/designs with a
//   size cap, and served under the board's own routes (no new public route; viewers only read). The cache key is the
//   frame and its version (updatedAt), so the image of the version before is still there when the frame changes:
//   that is the "before" picture (only when the board saw that version).
import fs from 'node:fs'
import path from 'node:path'
import { fetch, log } from '../bin/lib/obs.mjs'

const DOOP_ID = '[A-Za-z0-9_-]{6,64}'
const DOOP_ID_RE = new RegExp(`^${DOOP_ID}$`)
const ITEM_RE = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/
export const MAX_FRAMES = 12 // per item
export const MAX_CHILDREN = 20 // the requirement view
const MAX_CANVASES = 50
const MAX_IMAGE = 8 << 20

/** The Doop references in a text: `doop:<frame>`, `doop:frame/<frame>`, `doop:canvas/<canvas>`, and links to Doop
 *  (a host that starts with "doop") with /c/<canvas>[?frame=<frame>]. */
export function doopRefs(text) {
  const frames = new Set(), canvases = new Set(), s = String(text || '')
  for (const m of s.matchAll(new RegExp(`(?:^|[^\\w/:.-])doop:(canvas/|frame/)?(${DOOP_ID})(?![\\w-])`, 'g'))) (m[1] === 'canvas/' ? canvases : frames).add(m[2])
  for (const m of s.matchAll(new RegExp(`https?://doop[\\w.-]*(?::\\d+)?/c/(${DOOP_ID})(?:/proto)?(\\?[^\\s#)\\]>"'\`]*)?`, 'g'))) {
    const f = new RegExp(`[?&]frame=(${DOOP_ID})(?![\\w-])`).exec(m[2] || '')
    f ? frames.add(f[1]) : canvases.add(m[1])
  }
  return { frames, canvases }
}

/** Whether a frame's name names the item id (a whole id: pg-1 is not pg-1.2 or pg-12). */
export function namesItem(name, id) {
  const esc = id.replace(/[.]/g, '\\.')
  return new RegExp(`(^|[^a-z0-9.-])${esc}(?![a-z0-9-]|\\.[0-9])`, 'i').test(String(name || ''))
}

/** The frames an item links, in the order the item names them, then by name: [{ frame, how }], and the references the
 *  index does not know (a frame the design lead's account can't see, or gone). */
export function linkedFrames(item, index) {
  const texts = [item.description || '', ...(item.comments || []).map((c) => c.text || '')]
  const out = new Map(), missing = []
  const add = (f, how) => { if (f && !f.hidden && !out.has(f.id)) out.set(f.id, { frame: f, how }) }
  for (const t of texts) {
    const r = doopRefs(t)
    for (const id of r.frames) index.frames.has(id) ? add(index.frames.get(id), 'link') : missing.includes(`doop:${id}`) || missing.push(`doop:${id}`)
    for (const id of r.canvases) {
      const c = index.canvases.get(id)
      if (!c) { missing.includes(`doop:canvas/${id}`) || missing.push(`doop:canvas/${id}`); continue }
      for (const fid of c.frames) add(index.frames.get(fid), 'canvas')
    }
  }
  const named = [...index.frames.values()].filter((f) => namesItem(f.name, item.id)).sort((a, b) => a.name.localeCompare(b.name))
  for (const f of named) add(f, 'name')
  return { frames: [...out.values()].slice(0, MAX_FRAMES), more: Math.max(0, out.size - MAX_FRAMES), missing }
}

/** Doop's comments as threads (a root and its replies, oldest first). Resolved threads are left out by the caller. */
export function threadsOf(comments) {
  const roots = new Map(), replies = []
  for (const c of comments || []) {
    if (c.parentId) replies.push(c)
    else roots.set(c.id, { ...c, replies: [] })
  }
  for (const r of replies) roots.get(r.parentId)?.replies.push(r)
  for (const t of roots.values()) t.replies.sort((a, b) => a.at - b.at)
  return [...roots.values()].sort((a, b) => b.at - a.at)
}

/** A thread waits for a person when its last message is someone else's and it either names them (@name) or they wrote
 *  in it before. No name (the local side's default actor): nothing waits. */
export function waitsFor(thread, me) {
  if (!me) return false
  const all = [thread, ...thread.replies], last = all[all.length - 1]
  if (String(last.from || '').toLowerCase() === me) return false
  const named = new RegExp(`(^|[^\\w@])@${me.replace(/[.]/g, '\\.')}(?![\\w-])`, 'i')
  return all.some((m) => named.test(String(m.text || ''))) || all.some((m) => String(m.from || '').toLowerCase() === me)
}

/** What changed since the last version: Doop keeps every state a change overwrote (newest first; here as
 *  { at, by, kind, width, height, htmlBytes }); the first is the one just before the current design. */
export function changeOf(frame, versions) {
  const prev = versions[0]
  if (!prev) return { versions: 0, previous: null }
  return {
    versions: versions.length,
    previous: { at: prev.at, by: prev.by, kind: prev.kind, width: prev.width, height: prev.height },
    resized: prev.width !== frame.width || prev.height !== frame.height,
    bytes: frame.htmlBytes - prev.htmlBytes,
  }
}

// ---------- the image cache: files <frame>@<version>.png, the oldest go first over the cap ----------
export function imageCache(dir, capBytes) {
  const files = new Map() // key -> { size, used }: used is a counter (the order of use), from the files' age at start
  let uses = 0
  try {
    const found = []
    for (const n of fs.readdirSync(dir)) { const m = /^(.+@\d+)\.png$/.exec(n); if (m) { const st = fs.statSync(path.join(dir, n)); found.push([m[1], st.size, st.mtimeMs]) } }
    for (const [k, size] of found.sort((a, b) => a[2] - b[2])) files.set(k, { size, used: ++uses })
  } catch {}
  const file = (k) => path.join(dir, `${k}.png`)
  const total = () => [...files.values()].reduce((a, b) => a + b.size, 0)
  const drop = (k) => { files.delete(k); try { fs.unlinkSync(file(k)) } catch {} }
  return {
    has: (k) => files.has(k),
    get(k) {
      if (!files.has(k)) return null
      try { const b = fs.readFileSync(file(k)); files.get(k).used = ++uses; return b } catch { files.delete(k); return null }
    },
    put(k, buf) {
      if (buf.length > capBytes) return
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file(k), buf, { mode: 0o600 })
      files.set(k, { size: buf.length, used: ++uses })
      // per frame: the current and the two before it
      const frame = k.split('@')[0], mine = [...files.keys()].filter((x) => x.split('@')[0] === frame).sort((a, b) => Number(b.split('@')[1]) - Number(a.split('@')[1]))
      for (const x of mine.slice(3)) drop(x)
      while (total() > capBytes && files.size > 1) drop([...files.entries()].sort((a, b) => a[1].used - b[1].used)[0][0])
    },
    /** The newest version of a frame the cache holds, older than `before`. */
    previous(frame, before) {
      let best = null
      for (const k of files.keys()) { const [f, v] = k.split('@'); if (f === frame && Number(v) < before && (!best || Number(v) > best)) best = Number(v) }
      return best
    },
    size: total,
  }
}

// ---------- the project's Doop, through its MCP on loopback ----------
export function doopClient({ url, keyFile, timeoutMs = 20000 }) {
  let n = 0
  const key = () => { try { return fs.readFileSync(keyFile, 'utf8').trim() } catch { return '' } }
  return {
    hasKey: () => !!key(),
    /** One read tool: its JSON text, or its image as a Buffer. */
    async call(tool, args = {}) {
      const k = key()
      if (!k) throw Object.assign(new Error('Doop has no agent key yet (the doop service makes it at its first start)'), { code: 'nokey' })
      const r = await fetch(`${url}/mcp`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), minMs: 1000,
        headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name: tool, arguments: args } }) })
      if (!r.ok) throw new Error(`Doop: HTTP ${r.status}`)
      const ct = r.headers.get('content-type') || ''
      let body = await r.text()
      if (/event-stream/.test(ct)) body = (body.split('\n').filter((l) => l.startsWith('data:')).pop() || '').slice(5)
      const j = JSON.parse(body)
      if (j.error) throw new Error(`Doop: ${String(j.error.message || 'error').slice(0, 200)}`)
      const content = j.result?.content || []
      if (j.result?.isError) throw new Error(`Doop: ${String(content.find((c) => c.type === 'text')?.text || 'tool error').slice(0, 200)}`)
      const img = content.find((c) => c.type === 'image')
      if (img) return Buffer.from(String(img.data || ''), 'base64')
      const t = content.find((c) => c.type === 'text')?.text
      return t === undefined ? null : JSON.parse(t)
    },
  }
}

/** The designs API: GET /api/designs/<item> and GET /api/designs/<item>/image/<frame>?v=<version>. */
export function designsApi({ ROOT, send, me: meOf, getItem, allItems, svcUrl, svcPublic, cacheBytes = (Number(process.env.BOARD_DESIGNS_CACHE_MB) || 64) << 20,
  indexMs = Number(process.env.BOARD_DESIGNS_INDEX_MS) || 30000 }) {
  // in a project box, Doop runs on the host and its key is in the box's read-only secrets (sy-wo7y)
  const keyFile = fs.existsSync('/run/mm/secrets') ? '/run/mm/secrets/doop-agent-key' : path.join(ROOT, 'secrets', 'doop-agent-key')
  const cache = imageCache(path.join(ROOT, '.cache', 'designs'), cacheBytes)
  let client = null, clientUrl = null
  const doop = () => {
    const url = svcUrl('doop')
    if (!url) return null
    if (url !== clientUrl) { client = doopClient({ url, keyFile }); clientUrl = url }
    return client
  }
  const publicBase = () => { try { const u = new URL(svcPublic('doop') || ''); return /^https?:$/.test(u.protocol) ? u.origin : null } catch { return null } }

  // the index of every frame the design lead's account sees: 30 s (indexMs), one build at a time; the last one stays on an error
  let idx = { at: 0, data: null, error: null, pending: null }
  async function build(c) {
    const list = (await c.call('list_canvases')) || []
    const frames = new Map(), canvases = new Map()
    for (const cv of (Array.isArray(list) ? list : []).slice(0, MAX_CANVASES)) {
      if (!DOOP_ID_RE.test(String(cv.id))) continue
      const full = await c.call('get_canvas', { canvas_id: cv.id })
      const ids = []
      for (const f of full?.frames || []) {
        if (!DOOP_ID_RE.test(String(f.id))) continue
        ids.push(f.id)
        frames.set(f.id, { id: f.id, name: String(f.name || ''), canvasId: cv.id, canvasName: String(full.name || cv.name || ''), width: Math.round(f.width) || 0,
          height: Math.round(f.height) || 0, updatedAt: Date.parse(f.updatedAt) || 0, updatedBy: String(f.updatedBy || ''), htmlBytes: Number(f.htmlBytes) || 0,
          approval: String(f.approvalStatus || 'draft'), hidden: !!f.hidden })
      }
      canvases.set(cv.id, { id: cv.id, name: String(full?.name || cv.name || ''), frames: ids })
    }
    return { frames, canvases }
  }
  async function index(c) {
    if (!idx.data || Date.now() - idx.at > indexMs) {
      idx.pending ||= build(c).then((d) => { idx = { at: Date.now(), data: d, error: null, pending: null } },
        (e) => { idx = { ...idx, at: Date.now() - indexMs + Math.min(indexMs, 10000), error: e.message, pending: null }; log('warn', `designs: Doop index failed: ${e.message}`, { op: 'designs' }) })
      if (!idx.data) await idx.pending
    }
    if (!idx.data) throw new Error(idx.error || 'Doop did not answer')
    return idx.data
  }
  // versions per frame version, comments per canvas (15 s)
  const memo = new Map()
  function remember(key, ms, fn) {
    const hit = memo.get(key)
    if (hit && Date.now() - hit.at < ms) return hit.p
    const p = fn().catch((e) => { memo.delete(key); throw e })
    memo.set(key, { at: Date.now(), p })
    if (memo.size > 1000) memo.delete(memo.keys().next().value)
    return p
  }
  const versions = (c, f) => remember(`v:${f.id}@${f.updatedAt}`, 3600e3, async () => ((await c.call('list_frame_versions', { frame_id: f.id }))?.versions || []).map((v) => ({
    at: String(v.savedAt || ''), by: String(v.savedBy || ''), kind: String(v.savedByKind || ''), width: Math.round(v.width) || 0, height: Math.round(v.height) || 0, htmlBytes: Number(v.htmlBytes) || 0 })))
  const comments = (c, canvas) => remember(`c:${canvas}`, 15000, async () => {
    const list = await c.call('get_comments', { canvas_id: canvas, include_resolved: false })
    return (Array.isArray(list) ? list : []).map((x) => ({ id: String(x.id), parentId: x.parentId ? String(x.parentId) : undefined, frameId: x.frameId ? String(x.frameId) : undefined,
      from: String(x.from || ''), text: String(x.text || '').slice(0, 4000), at: Number(x.at) || 0, element: !!x.elementId }))
  })

  // renders: at most 2 at once, one per frame version
  let busy = 0
  const queue = [], inflight = new Map()
  function render(c, f) {
    const k = `${f.id}@${f.updatedAt}`
    if (inflight.has(k)) return inflight.get(k)
    const p = new Promise((ok, no) => {
      const run = async () => {
        busy++
        try {
          const buf = await c.call('get_frame_screenshot', { frame_id: f.id, scale: 1 })
          if (!Buffer.isBuffer(buf) || buf.length > MAX_IMAGE || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Doop sent no PNG')
          cache.put(k, buf); ok(buf)
        } catch (e) { no(e) } finally { busy--; inflight.delete(k); queue.shift()?.() }
      }
      busy < 2 ? run() : queue.push(run)
    })
    inflight.set(k, p)
    return p
  }

  const img = (item, f, v) => `/api/designs/${item}/image/${f.id}?v=${v}`
  async function frameView(c, item, { frame: f, how }, me, deep) {
    const open = publicBase()
    const before = cache.previous(f.id, f.updatedAt)
    const base = { id: f.id, name: f.name, canvas: { id: f.canvasId, name: f.canvasName }, how, width: f.width, height: f.height, approval: f.approval,
      updatedAt: f.updatedAt ? new Date(f.updatedAt).toISOString() : null, updatedBy: f.updatedBy, image: img(item, f, f.updatedAt),
      before: before !== null ? { image: img(item, f, before), at: new Date(before).toISOString() } : null,
      open: open ? `${open}/c/${encodeURIComponent(f.canvasId)}?frame=${encodeURIComponent(f.id)}` : null }
    if (!deep) return base
    const [vs, cs] = await Promise.all([versions(c, f).catch(() => null), comments(c, f.canvasId).catch(() => null)])
    const threads = cs ? threadsOf(cs.filter((x) => x.frameId === f.id || (x.parentId && cs.find((r) => r.id === x.parentId)?.frameId === f.id))) : null
    return { ...base, change: vs ? changeOf(f, vs) : null, history: vs ? vs.slice(0, 10) : null,
      comments: threads ? threads.slice(0, 30).map((t) => ({ id: t.id, from: t.from, text: t.text, at: new Date(t.at).toISOString(), element: t.element,
        replies: t.replies.map((r) => ({ from: r.from, text: r.text, at: new Date(r.at).toISOString() })), waiting: waitsFor(t, me) })) : null }
  }

  async function sendItem(req, res, id) {
    const c = doop()
    if (!c) return send(res, 200, { id, available: false, why: 'This project has no Doop (mm doop on <project>).', frames: [] })
    if (!c.hasKey()) return send(res, 200, { id, available: false, why: 'Doop has no agent key yet (its first start makes it).', frames: [] })
    const item = await getItem(id)
    if (!item) return send(res, 404, { title: 'no such item' })
    let ix
    try { ix = await index(c) } catch (e) {
      const refs = [item.description, ...(item.comments || []).map((x) => x.text)].reduce((n, t) => { const r = doopRefs(t); return n + r.frames.size + r.canvases.size }, 0)
      return send(res, 200, { id, available: false, why: `Doop did not answer: ${e.message}`, refs, frames: [] })
    }
    const me = meOf(req)
    const linked = linkedFrames(item, ix)
    const frames = await Promise.all(linked.frames.map((l) => frameView(c, id, l, me, true)))
    // the requirement view: the item's children (a spec's parts) and their designs
    let children = []
    try {
      const kids = (await allItems()).filter((x) => x.parent === id).slice(0, MAX_CHILDREN)
      children = await Promise.all(kids.map(async (k) => {
        const full = (await getItem(k.id)) || k
        const l = linkedFrames(full, ix)
        return { id: k.id, title: String(k.title || ''), status: k.status, assignee: k.assignee || '', frames: await Promise.all(l.frames.map((x) => frameView(c, k.id, x, me, false))) }
      }))
    } catch {}
    send(res, 200, { id, available: true, stale: idx.error ? `Doop did not answer just now (${idx.error}); this is from ${new Date(idx.at).toISOString()}` : undefined,
      me, doop: publicBase(), frames, more: linked.more, missing: linked.missing, children })
  }

  async function sendImage(req, res, id, frameId, v) {
    const c = doop()
    if (!c) return send(res, 404, { title: 'no Doop' })
    const item = await getItem(id)
    if (!item) return send(res, 404, { title: 'no such item' })
    const ix = await index(c)
    // only a frame this item links (an item of the board, a frame of its Doop)
    if (!linkedFrames(item, ix).frames.some((l) => l.frame.id === frameId)) return send(res, 404, { title: 'not a design of this item' })
    const f = ix.frames.get(frameId), k = `${frameId}@${v}`
    let buf = cache.get(k)
    if (!buf && v === f.updatedAt) buf = await render(c, f).catch((e) => { log('warn', `designs: render failed: ${e.message}`, { op: 'designs' }); return null })
    if (!buf) return send(res, v === f.updatedAt ? 502 : 404, { title: v === f.updatedAt ? 'Doop could not render the frame' : 'that version is not kept' })
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'content-disposition': 'inline' })
    res.end(buf)
  }

  /** true when it answered the request */
  return async function designs(req, res, url) {
    const m = /^\/api\/designs\/([\w.-]+)(?:\/image\/([\w-]+))?$/.exec(url.pathname)
    if (!m) { send(res, 404, { title: 'not found' }); return true }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { title: 'read only' }); return true }
    if (!ITEM_RE.test(m[1]) || (m[2] && !DOOP_ID_RE.test(m[2]))) { send(res, 400, { title: 'bad id' }); return true }
    if (m[2]) {
      const v = Number(url.searchParams.get('v'))
      if (!Number.isSafeInteger(v) || v < 0) { send(res, 400, { title: 'bad version' }); return true }
      await sendImage(req, res, m[1], m[2], v).catch((e) => send(res, 502, { title: `designs: ${e.message}` }))
    } else await sendItem(req, res, m[1]).catch((e) => send(res, 502, { title: `designs: ${e.message}` }))
    return true
  }
}
