#!/usr/bin/env node
// Designs on the board (sy-56e; template/site/designs.mjs): (1) the rules on their own: how an item links a Doop frame,
// threads and what waits for a person, what changed since the last version, the image cache's cap; (2) the board's
// server against a fake bd serve and a Doop stand-in (its MCP on loopback, the read tools the board calls): an item's
// designs, the images through the board's own route (cached, the version before kept), the agent key never in what a
// browser gets, read tools only, the requirement view (a spec's children), and the public side (the gateway's
// assertion; viewers read; no writes). Hermetic: a temp folder, no built site, no real Doop.
//   node test/board-designs.mjs          exit 0 = every check passed
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-designs-'))
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const D = await import(path.join(SRC, 'template', 'site', 'designs.mjs'))

step('the rules (site/designs.mjs)')
{
  const r = D.doopRefs('see doop:Fr4me_0001 and doop:frame/Fr4me_0002, doop:canvas/Canv_00001; not xdoop:Nope_00001 nor doop:ab.\n'
    + 'link https://doop.shop.example.org/c/Canv_00002?frame=Fr4me_0003 and https://doop-shop-acme.example.org/c/Canv_00003 and https://evil.example.org/c/Canv_00009?frame=Fr4me_0009')
  ok('doop:<frame>, doop:frame/<frame>, a Doop link with ?frame=: frames', [...r.frames].sort().join() === 'Fr4me_0001,Fr4me_0002,Fr4me_0003', [...r.frames].join())
  ok('doop:canvas/<canvas>, a Doop link with no frame: canvases; not inside a word, not a short id, not another host', [...r.canvases].sort().join() === 'Canv_00001,Canv_00003', [...r.canvases].join())
  ok('a frame name names an item id only as a whole id (pg-1: not pg-1.2, pg-12, xpg-1)', D.namesItem('pg-1 · Sign-in', 'pg-1') && D.namesItem('Sign-in [pg-1]', 'pg-1')
    && !D.namesItem('pg-1.2 · Part', 'pg-1') && !D.namesItem('pg-12', 'pg-1') && !D.namesItem('xpg-1', 'pg-1') && D.namesItem('pg-1.2 · Part', 'pg-1.2'))
  const F = (id, name, canvasId = 'Canv_00001', f = {}) => ({ id, name, canvasId, ...f })
  const index = { frames: new Map([F('Fr4me_0001', 'Home'), F('Fr4me_0002', 'pg-1 · Sign-in'), F('Fr4me_0003', 'Cart', 'Canv_00002'), F('Fr4me_0004', 'Hidden one', 'Canv_00002', { hidden: true }),
    F('Fr4me_0005', 'pg-1 · About')].map((f) => [f.id, f])), canvases: new Map([['Canv_00002', { id: 'Canv_00002', frames: ['Fr4me_0003', 'Fr4me_0004'] }]]) }
  const l = D.linkedFrames({ id: 'pg-1', description: 'doop:Fr4me_0003', comments: [{ text: 'doop:Gone_00001 and doop:canvas/Canv_00002' }, { text: 'doop:Fr4me_0003 again' }] }, index)
  ok('linked: in the order the item names them, then frames that name the item (by name); each once; a hidden frame never',
    l.frames.map((x) => `${x.frame.id}:${x.how}`).join() === 'Fr4me_0003:link,Fr4me_0005:name,Fr4me_0002:name', JSON.stringify(l.frames.map((x) => x.frame.id)))
  ok('...a reference the index does not know is listed as missing', l.missing.join() === 'doop:Gone_00001')
  const many = { frames: new Map(Array.from({ length: 15 }, (_, k) => F(`Many_${String(k).padStart(5, '0')}`, `pg-2 · ${k}`)).map((f) => [f.id, f])), canvases: new Map() }
  const lm = D.linkedFrames({ id: 'pg-2', comments: [] }, many)
  ok(`at most ${D.MAX_FRAMES} frames per item, the rest counted`, lm.frames.length === D.MAX_FRAMES && lm.more === 3)
  const th = D.threadsOf([{ id: 'a', from: 'alex', text: 'too dark', at: 1 }, { id: 'b', parentId: 'a', from: 'Design lead', text: 'lighter now?', at: 3 }, { id: 'c', from: 'design', text: '@alex which logo?', at: 2 },
    { id: 'd', from: 'bob', text: 'nice', at: 4 }, { id: 'e', parentId: 'zz', from: 'x', text: 'orphan', at: 5 }])
  ok('threads: roots newest first, replies under their root, an orphan reply dropped', th.map((t) => `${t.id}:${t.replies.length}`).join() === 'd:0,c:0,a:1')
  const w = Object.fromEntries(th.map((t) => [t.id, D.waitsFor(t, 'alex')]))
  ok('waits for alex: a thread alex wrote in whose last word is someone else\'s, and one that names @alex; not bob\'s; not with no name',
    w.a && w.c && !w.d && !D.waitsFor(th[2], ''), JSON.stringify(w))
  ok('...not when alex has the last word', !D.waitsFor({ from: 'design', text: '@alex?', replies: [{ from: 'alex', text: 'yes' }] }, 'alex'))
  const ch = D.changeOf({ width: 1440, height: 900, htmlBytes: 5000 }, [{ at: '2026-11-01T00:00:00Z', by: 'Design lead', kind: 'agent', width: 1280, height: 800, htmlBytes: 4000 }, { at: '2026-10-01T00:00:00Z' }])
  ok('what changed: the version before (who, when), resized, the HTML\'s growth, how many versions', ch.versions === 2 && ch.previous.by === 'Design lead' && ch.resized && ch.bytes === 1000)
  ok('...no versions: a first design', D.changeOf({}, []).versions === 0 && D.changeOf({}, []).previous === null)
  const cdir = path.join(T, 'cache'), png = (n, size) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(size - 8, n)])
  const c = D.imageCache(cdir, 3000)
  for (let v = 1; v <= 5; v++) c.put(`Fr4me_0001@${v}`, png(v, 400))
  ok('cache: per frame the current and the two before it', ['5', '4', '3'].every((v) => c.has(`Fr4me_0001@${v}`)) && !c.has('Fr4me_0001@2') && !c.has('Fr4me_0001@1'))
  ok('...the newest version before a given one', c.previous('Fr4me_0001', 5) === 4 && c.previous('Fr4me_0001', 3) === null && c.previous('Other_00001', 9) === null)
  c.get('Fr4me_0001@3')
  for (let k = 0; k < 4; k++) c.put(`Oth${k}_00001@1`, png(k, 500))
  ok('...over the cap the least used go first (the total stays under it)', c.size() <= 3000 && c.has('Oth3_00001@1') && !c.has('Fr4me_0001@4'), `size ${c.size()}`)
  ok('...an image over the cap is not kept; files are 0600 in a 0700 folder', (c.put('Big_000001@1', png(1, 4000)), !c.has('Big_000001@1'))
    && (fs.statSync(path.join(cdir, 'Oth3_00001@1.png')).mode & 0o777) === 0o600 && (fs.statSync(cdir).mode & 0o777) === 0o700)
  ok('...a new cache on the same folder knows what is there', D.imageCache(cdir, 3000).has('Oth3_00001@1'))
}

// ---------- a Doop stand-in: its MCP (stateless, JSON), the design lead's agent key as bearer ----------
const KEY = `dpk_${crypto.randomBytes(18).toString('hex')}`
const H = 3600e3, T0 = Date.parse('2026-11-06T10:00:00Z')
const doop = {
  canvases: [{ id: 'Canv_00001', name: 'Shop', frames: [
    { id: 'Fr4me_0001', name: 'Sign-in', width: 1280, height: 800, updatedAt: T0, updatedBy: 'Design lead', htmlBytes: 4000, approvalStatus: 'needs_review' },
    { id: 'Fr4me_0002', name: 'sb-2 · Cart', width: 390, height: 844, updatedAt: T0 - H, updatedBy: 'alex', htmlBytes: 2000 },
    { id: 'Fr4me_0003', name: 'Not linked', width: 100, height: 100, updatedAt: T0, updatedBy: 'x', htmlBytes: 10 }] },
  { id: 'Canv_00002', name: 'Checkout', frames: [{ id: 'Fr4me_0004', name: 'Pay', width: 800, height: 600, updatedAt: T0, updatedBy: 'Design lead', htmlBytes: 900, approvalStatus: 'ready_for_dev' }] }],
  versions: { Fr4me_0001: [{ id: 'v2', savedAt: T0 - 2 * H, savedBy: 'Design lead', savedByKind: 'agent', width: 1280, height: 720, htmlBytes: 3500 }, { id: 'v1', savedAt: T0 - 5 * H, savedBy: 'Design lead', savedByKind: 'agent', width: 1280, height: 720, htmlBytes: 3000 }] },
  comments: { Canv_00001: [
    { id: 'cm1', canvasId: 'Canv_00001', frameId: 'Fr4me_0001', elementId: 'el-1', snippet: '<b>', from: 'alex', text: 'The button is too small', at: T0 - 3 * H },
    { id: 'cm2', canvasId: 'Canv_00001', frameId: 'Fr4me_0001', parentId: 'cm1', from: 'Design lead', text: 'Bigger now, ok?', at: T0 - H },
    { id: 'cm3', canvasId: 'Canv_00001', frameId: 'Fr4me_0001', from: 'bob', text: '<img src=x onerror=alert(1)> nice', at: T0 - 2 * H },
    { id: 'cm4', canvasId: 'Canv_00001', frameId: 'Fr4me_0002', from: 'Design lead', text: '@alex which one?', at: T0 }] },
}
const calls = [], auths = []
let down = false
const pngOf = (id, v) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`${id}@${v}`)])
const doopSrv = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404); return res.end() }
  auths.push(req.headers.authorization || '')
  if (down) { res.writeHead(503); return res.end() }
  if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}') }
  const j = JSON.parse(body), { name, arguments: a = {} } = j.params || {}
  calls.push(name)
  const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] })
  const frame = (id) => doop.canvases.flatMap((c) => c.frames.map((f) => ({ ...f, canvasId: c.id }))).find((f) => f.id === id)
  const sum = (f) => ({ ...f, updatedAt: new Date(f.updatedAt).toISOString(), approvalStatus: f.approvalStatus || 'draft' })
  let result
  if (name === 'list_canvases') result = text(doop.canvases.map((c) => ({ id: c.id, name: c.name, frameCount: c.frames.length })))
  else if (name === 'get_canvas') { const c = doop.canvases.find((x) => x.id === a.canvas_id); result = c ? { ...text({ id: c.id, name: c.name, frames: c.frames.map(sum) }), structuredContent: { preview: 1 } } : { isError: true, content: [{ type: 'text', text: 'no canvas' }] } }
  else if (name === 'list_frame_versions') result = text({ frame: sum(frame(a.frame_id)), versions: (doop.versions[a.frame_id] || []).map((v) => ({ ...v, savedAt: new Date(v.savedAt).toISOString() })) })
  else if (name === 'get_comments') result = text((doop.comments[a.canvas_id] || []).filter((c) => a.include_resolved !== false || !c.resolvedAt))
  else if (name === 'get_frame_screenshot') { const f = frame(a.frame_id); result = { content: [{ type: 'image', data: pngOf(f.id, f.updatedAt).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: 'Screenshot' }] } }
  else result = { isError: true, content: [{ type: 'text', text: `the stand-in has no ${name}` }] }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }))
})
await new Promise((r) => doopSrv.listen(0, '127.0.0.1', r))
const DOOP = `http://127.0.0.1:${doopSrv.address().port}`

// ---------- a fake bd serve: a spec (sb-1) with two children, an item with a link in a comment ----------
const iso = (t) => new Date(t).toISOString()
const items = [
  { id: 'sb-1', title: 'Spec: checkout', status: 'open', assignee: 'requirement', description: 'The checkout flow. doop:canvas/Canv_00002', comments: [] },
  { id: 'sb-2', title: 'Design the cart', status: 'open', assignee: 'design', parent: 'sb-1', description: 'cart', comments: [] },
  { id: 'sb-3', title: 'Design sign-in', status: 'in_progress', assignee: 'design', parent: 'sb-1', description: 'x',
    comments: [{ id: 'k1', author: 'design', text: 'First version: doop:Fr4me_0001 (and doop:Gone_00001)', created_at: iso(T0) }] },
  { id: 'sb-4', title: 'nothing', status: 'open', assignee: 'code', description: '', comments: [] },
]
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items: items.map(({ comments, ...i }) => i), has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = items.find((x) => x.id === m[1]); return i ? json(i) : json({ title: 'not found' }, 404) }
  json({}, 404)
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))

// ---------- the board: a copy of the template's site and bin ----------
const B = path.join(T, 'board')
fs.cpSync(path.join(SRC, 'template', 'site'), path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules|\/dist(\/|$)/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads', 'design'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'design' }, { id: 'requirement' }, { id: 'qa' }, { id: 'code' }] }))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-sb.example.org'
const sign = (u, r, h = HOST, exp = Date.now() + 60000) => { const b = Buffer.from(JSON.stringify({ u, r, h, exp, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
const baseEnv = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1',
  BOARD_PROJECT: 'sb', MM_PROJECT: 'sb', MM_OBS_TRACES: '', MM_OBS_METRICS: '', BOARD_PUBLIC_PORT: String(PPORT), MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  BOARD_DESIGNS_INDEX_MS: '300' }
delete baseEnv.MM_SERVICE; delete baseEnv.MM_BIND; delete baseEnv.SVC_URL_DOOP
let srv = null, out = ''
async function board(env) {
  if (srv) { srv.kill(); await new Promise((r) => srv.once('close', r)) }
  srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); return } catch { await sleep(100) } }
}
const seen = [] // everything a browser got: bodies and headers
const req = async (p, o = {}, port = PORT) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, o)
  const buf = Buffer.from(await r.arrayBuffer())
  seen.push(JSON.stringify([...r.headers]) + buf.toString('latin1'))
  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch {}
  return { status: r.status, headers: r.headers, buf, json }
}
const get = (p, o) => req(p, o)

try {
  step('the board: no Doop, no key')
  await board({})
  let r = await get('/api/designs/sb-3')
  ok('a project with no Doop: not available, no frames (the panel stays hidden)', r.status === 200 && r.json.available === false && /no Doop/.test(r.json.why) && r.json.frames.length === 0, JSON.stringify(r.json))
  await board({ SVC_URL_DOOP: DOOP })
  r = await get('/api/designs/sb-3')
  ok('Doop on, its agent key not made yet: not available, says why; Doop never asked', r.json.available === false && /agent key/.test(r.json.why) && auths.length === 0, JSON.stringify(r.json))
  fs.mkdirSync(path.join(B, 'secrets'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(B, 'secrets', 'doop-agent-key'), `${KEY}\n`, { mode: 0o600 })

  step('the board: an item\'s designs')
  r = await get('/api/designs/sb-3')
  const f1 = r.json.frames?.[0]
  ok('the frame its comment links (doop:Fr4me_0001), and the reference Doop does not know', r.json.available === true && r.json.frames.length === 1 && f1.id === 'Fr4me_0001' && f1.how === 'link'
    && r.json.missing.join() === 'doop:Gone_00001', JSON.stringify(r.json))
  ok('...with its canvas, size, approval, who changed it last and when', f1.canvas.name === 'Shop' && f1.width === 1280 && f1.approval === 'needs_review' && f1.updatedBy === 'Design lead' && f1.updatedAt === iso(T0))
  ok('...what changed since the last version (by, when, resized 1280x720 -> 1280x800, +500 bytes, 2 versions) and the history',
    f1.change?.versions === 2 && f1.change.previous.by === 'Design lead' && f1.change.previous.height === 720 && f1.change.resized && f1.change.bytes === 500 && f1.history.length === 2, JSON.stringify(f1.change))
  ok('...its open comments as threads (a reply under its root); text as data', f1.comments.length === 2 && f1.comments.find((c) => c.id === 'cm1').replies[0].text === 'Bigger now, ok?'
    && f1.comments.some((c) => c.text.startsWith('<img src=x')))
  ok('...no "open in Doop" link without Doop\'s public name; no image of an earlier version yet', f1.open === null && f1.before === null && r.json.doop === null)
  ok('...the image is the board\'s own route, by version', f1.image === `/api/designs/sb-3/image/Fr4me_0001?v=${T0}`)
  ok('the board asked Doop with the agent key as bearer', auths.length > 0 && auths.every((a) => a === `Bearer ${KEY}`))

  step('the board: images')
  const n0 = calls.filter((c) => c === 'get_frame_screenshot').length
  r = await get(f1.image)
  ok('the image: a PNG from Doop\'s render, through the board', r.status === 200 && r.headers.get('content-type') === 'image/png' && r.buf.equals(pngOf('Fr4me_0001', T0)))
  ok('...with nosniff, a CSP that runs nothing, private caching', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('content-security-policy') === "default-src 'none'" && /^private/.test(r.headers.get('cache-control')))
  r = await get(f1.image)
  ok('...the second time from the cache (Doop renders once)', r.status === 200 && calls.filter((c) => c === 'get_frame_screenshot').length === n0 + 1)
  ok('...kept on disk under .cache/designs', fs.existsSync(path.join(B, '.cache', 'designs', `Fr4me_0001@${T0}.png`)))
  ok('a frame this item does not link: 404 (Fr4me_0003 is in Doop, not on sb-3)', (await get('/api/designs/sb-3/image/Fr4me_0003?v=' + T0)).status === 404)
  ok('a version the board never saw: 404, and Doop is not asked to render it', (await get(`/api/designs/sb-3/image/Fr4me_0001?v=${T0 - H}`)).status === 404 && calls.filter((c) => c === 'get_frame_screenshot').length === n0 + 1)
  ok('a bad version, a bad frame id, a bad item id: 400', (await get('/api/designs/sb-3/image/Fr4me_0001?v=abc')).status === 400 && (await get('/api/designs/sb-3/image/a.b?v=1')).status === 404
    && (await get('/api/designs/SB..3')).status === 400)
  ok('only GET: a POST is refused (read only)', (await get('/api/designs/sb-3', { method: 'POST', body: '{}' })).status === 405)

  step('the board: the frame changes')
  doop.versions.Fr4me_0001.unshift({ id: 'v3', savedAt: T0, savedBy: 'Design lead', savedByKind: 'agent', width: 1280, height: 800, htmlBytes: 4000 })
  const T1 = T0 + H
  Object.assign(doop.canvases[0].frames[0], { updatedAt: T1, htmlBytes: 4400, updatedBy: 'alex' })
  let f1b = null
  for (let i = 0; i < 30 && f1b?.updatedAt !== iso(T1); i++) { await sleep(200); f1b = (await get('/api/designs/sb-3')).json.frames?.[0] }
  ok('the new version: its own image URL, and the one before (the board saw it) as "before"', f1b?.image === `/api/designs/sb-3/image/Fr4me_0001?v=${T1}` && f1b.before?.image === `/api/designs/sb-3/image/Fr4me_0001?v=${T0}`, JSON.stringify(f1b))
  ok('...what changed: 3 versions, +400 bytes since the version before', f1b.change.versions === 3 && f1b.change.bytes === 400 && !f1b.change.resized)
  r = await get(f1b.before.image)
  ok('...the image before still served from the cache, the new one rendered', r.status === 200 && r.buf.equals(pngOf('Fr4me_0001', T0)) && (await get(f1b.image)).buf.equals(pngOf('Fr4me_0001', T1)))

  step('the board: role views\' data')
  r = await get('/api/designs/sb-1')
  ok('a spec (sb-1): its own designs (doop:canvas/Canv_00002: every frame of the canvas)', r.json.frames.map((f) => `${f.id}:${f.how}`).join() === 'Fr4me_0004:canvas' && r.json.frames[0].approval === 'ready_for_dev')
  ok('...and its children\'s (requirement view): sb-2 by the frame\'s name, sb-3 by its link; each image under the child\'s own route',
    r.json.children.map((c) => `${c.id}:${c.frames.map((f) => f.id).join('+')}`).join() === 'sb-2:Fr4me_0002,sb-3:Fr4me_0001'
    && r.json.children[0].frames[0].image.startsWith('/api/designs/sb-2/image/Fr4me_0002?v='), JSON.stringify(r.json.children))
  r = await get('/api/designs/sb-4')
  ok('an item with no designs: available, empty (the panel stays hidden)', r.json.available === true && r.json.frames.length === 0 && r.json.children.length === 0)
  r = await get('/api/designs/sb-2', { headers: { cookie: 'board_user=alex' } })
  ok('the human\'s view: a thread that names @alex waits for alex (the local side: the name they chose)', r.json.me === 'alex' && r.json.frames[0].comments[0].waiting === true)
  r = await get('/api/designs/sb-2')
  ok('...with no name, nothing waits', r.json.me === '' && r.json.frames[0].comments[0].waiting === false)

  step('the public side (the gateway\'s assertion)')
  await board({ SVC_URL_DOOP: DOOP, SVC_URL_DUMMY: '' })
  fs.mkdirSync(path.join(B, '.run'), { recursive: true })
  fs.writeFileSync(path.join(B, '.run', 'endpoints.json'), JSON.stringify({ services: { doop: { url: DOOP, public: 'https://doop.sb.example.org' } } }))
  const pub = (p, who, role, o = {}) => req(p, { ...o, headers: { 'x-forwarded-host': HOST, ...(who ? { 'x-mm-assertion': sign(who, role) } : {}), ...(o.headers || {}) } }, PPORT)
  ok('no assertion: 401', (await pub('/api/designs/sb-3')).status === 401)
  r = await pub('/api/designs/sb-3', 'alex', 'viewer')
  ok('a viewer reads an item\'s designs; "open in Doop" goes to Doop\'s public name, the frame selected', r.status === 200 && r.json.frames[0].open === 'https://doop.sb.example.org/c/Canv_00001?frame=Fr4me_0001' && r.json.doop === 'https://doop.sb.example.org', JSON.stringify(r.json.frames?.[0]))
  ok('...the thread alex wrote in, answered by the design lead, waits for alex (the signed name)', r.json.me === 'alex' && r.json.frames[0].comments.find((c) => c.id === 'cm1').waiting === true && r.json.frames[0].comments.find((c) => c.id === 'cm3').waiting === false)
  r = await pub(r.json.frames[0].image, 'alex', 'viewer')
  ok('...and its image', r.status === 200 && r.headers.get('content-type') === 'image/png')
  ok('a viewer\'s POST: 403 (viewers only read); a member\'s POST: 405 (designs are read only)', (await pub('/api/designs/sb-3', 'alex', 'viewer', { method: 'POST', body: '{}' })).status === 403
    && (await pub('/api/designs/sb-3', 'bob', 'member', { method: 'POST', body: '{}' })).status === 405)
  ok('a cookie name is no identity there: the signed name wins', (await pub('/api/designs/sb-2', 'bob', 'member', { headers: { cookie: 'board_user=alex' } })).json.me === 'bob')

  step('Doop down')
  down = true
  await sleep(400)
  r = await get('/api/designs/sb-3')
  ok('the last index stays (marked stale), the page still answers', r.status === 200 && r.json.available === true && r.json.frames.length === 1)
  await sleep(300)
  r = await get('/api/designs/sb-3')
  ok('...and it says Doop did not answer', /did not answer/.test(r.json.stale || ''), JSON.stringify(r.json.stale))
  down = false

  step('the key and the tools')
  ok('the agent key is in nothing a browser got (bodies, headers)', !seen.some((s) => s.includes(KEY) || s.includes(KEY.slice(4))))
  ok('...nor in the board\'s log', !out.includes(KEY.slice(4)))
  const READ = new Set(['list_canvases', 'get_canvas', 'list_frame_versions', 'get_comments', 'get_frame_screenshot'])
  ok(`the board called only read tools (${[...new Set(calls)].join(', ')})`, calls.length > 0 && calls.every((c) => READ.has(c)))
} finally {
  srv?.kill(); doopSrv.close(); bdSrv.close()
  if (fail) console.log(`\n--- board log ---\n${out.slice(-3000)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
