// Work site server: serves the built board and proxies an allowlist of Beads HTTP routes to `bd serve`.
// It, not the browser, sets who made a change: the gateway's signed assertion on the public side, else the visitor's
// chosen name, else BOARD_ACTOR.
// No dependencies: node server.mjs
import http from 'node:http'
import { execFile, fetch, httpSpan, log, routeOf, spawn, startMetrics, startSpan, withSpan } from '../bin/lib/obs.mjs'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configApi } from './config-api.mjs'
import { leadState } from './lead-state.mjs'
import { foldRequeues, pullState } from './pull-state.mjs'
import { exportQuery, flowRows, parseExport, PAIRS } from './flow-rows.mjs'
import { waitingFor } from './waiting.mjs'
import { designsApi } from './designs.mjs'
import { headRefusal, SIGNED_HEAD } from '../bin/lib/owner-card.mjs'
import * as P_ from '../bin/lib/paseo.mjs'
import { bridgeSocket, ITEM, loadConf } from '../bin/lib/ledger.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, 'dist')
import { dirs, endpoints, projectName, requireUrl, servicesDef, svcPublic, svcUrl } from '../bin/lib/svc.mjs'
// PORT is assigned by the process manager (portless); HOST is where the machine wants services bound.
const PORT = Number(process.env.PORT || process.env.BOARD_PORT)
if (!PORT) { console.error('board: set PORT'); process.exit(2) }
// Loopback (portless sets HOST); a public board is reached through mm's forwarder on the machine's bind_host. MM_BIND: an explicit override
const HOST = process.env.MM_BIND || process.env.HOST || process.env.BOARD_HOST || '127.0.0.1'
const BD = new URL(process.env.BD_SERVE || requireUrl('bd-serve'))
const ACTOR = process.env.BOARD_ACTOR || 'guest' // until the visitor names themselves
const PROJECT = process.env.BOARD_PROJECT || projectName()
const PASEO = process.env.PASEO_BIN || 'paseo'
// Roles: leads/roles.json, kept in place (same array) so every user of ROLES sees changes without a restart.
const ROLES = []
let ROLE_DEFS = []
function loadRoles() {
  try { ROLE_DEFS = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'leads', 'roles.json'), 'utf8')).roles || [] } catch { ROLE_DEFS = [] }
  ROLES.splice(0, ROLES.length, ...ROLE_DEFS.map((r) => r.id))
}
loadRoles()
fs.watchFile(path.resolve(here, '..', 'leads', 'roles.json'), { interval: 2000 }, loadRoles)

// What the board may do. Delete and sweep are deliberately absent.
const ALLOW = [
  ['GET', /^\/v0\/beads\/(context|stats|ready|issues|events|events:watch|issues\/[\w.-]+)$/],
  ['POST', /^\/v0\/beads\/issues$/],
  ['POST', /^\/v0\/beads\/issues\/[\w.-]+\/comments$/],
  ['POST', /^\/v0\/beads\/issues\/[\w.-]+:(close|reopen)$/],
  ['PATCH', /^\/v0\/beads\/issues\/[\w.-]+$/],
]

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }

// Self-identification: the visitor picks a name (cookie board_user). Lead and system names are reserved, so a human
// can never post as a lead. On the public side the gateway's assertion always wins: it is the only identity there, and
// no request header names anyone (sy-y7th).
const RESERVED = new Set([...ROLES, 'setup', 'wake', 'watchdog', 'smoke', 'ui', 'beads', 'system', 'admin', 'brain', 'mm-upstream', 'bridge'])
function cookieUser(req) {
  const m = /(?:^|;\s*)board_user=([^;]*)/.exec(req.headers.cookie || '')
  const name = m ? decodeURIComponent(m[1]).trim().toLowerCase() : ''
  return selfName(name) ? name : null
}
const validName = (n) => /^[a-z][a-z0-9._-]{1,31}$/.test(n) && !RESERVED.has(n) && !RESERVED.has(n.split('/')[0])
// a name someone picks on the local side: never the owner's (sy-1jmi), whose approved counts; the owner is the owner
// only through the gateway's assertion on the public side
const selfName = (n) => validName(n) && n !== String(endpoints().owner_name || '').trim().toLowerCase()
function whoSource(req) {
  if (req.gateway) return 'gateway'
  if (cookieUser(req)) return 'self'
  return 'default'
}

function who(req) {
  if (req.gateway) return req.gateway.u // the public side: only the gateway's signed assertion says who
  return cookieUser(req) || ACTOR
}

// JSON responses; gzip when the client accepts it and it is worth it.
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  const gz = body.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')
  res.writeHead(code, { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) })
  res.end(gz ? zlib.gzipSync(body) : body)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

// The rails on the public side (people signed in through the gateway; leads write with bd, never through here):
// members steer like the owner (create, prioritise, assign, comment, close, reopen), but only the owner gives the T2 go
// (`approved`) or changes a risk tier (t1/t2/t3), and only the leads sign off or audit. Each write carries its
// author's role: `by:<role>` on a new item, a `[<role>]` prefix on a comment. Unknown label fields: refused.
// The local side (no gateway assertion: a self-chosen name, or the default actor) never adds or removes `approved`
// (sy-h2yt): it says nothing signed about who writes. The owner gives the T2 go on the public side, signed in as the
// owner, or with the bridge's Approve button; the Supervisor counts `approved` only from those two actors.
// `signed-head:<repo>@<sha>` (sy-hzmu: the head review signed off) is the leads' as signed-off is.
const OWNER_ONLY = new Set(['approved', 't1', 't2', 't3']), LEADS_ONLY = new Set(['signed-off', 'audit'])
const LEADS_ONLY_PREFIX = [SIGNED_HEAD]
const SIGNED_ONLY = new Set(['approved'])
function railRefusal(role, added, removed) {
  for (const l of [...added, ...removed]) {
    if (LEADS_ONLY.has(l) || LEADS_ONLY_PREFIX.some((p) => String(l).startsWith(p))) return `only the leads change "${l}"`
    if (OWNER_ONLY.has(l) && role !== 'owner') return `only the owner changes "${l}" (the T2 go and the risk tiers are the owner's)`
    if (/^by:/.test(l)) return 'the author role label is set by the board'
  }
  return null
}
function localRefusal(added, removed) {
  for (const l of [...added, ...removed]) {
    if (SIGNED_ONLY.has(l)) return `"${l}" is not changed on the local side (the owner gives the T2 go signed in on the board's public address, or with the bridge's Approve button)`
  }
  return null
}
// With the ledger on (verifier = ledger in mm-approve's config, read as bin/lib/ledger.mjs reads it; sy-4py1), only the
// owner's tap on Telegram signs an approval: the board writes no `approved` and signs nothing. The owner's web Approve
// (POST /api/approve, the public side) sends only the item id, with the gateway's assertion it came with, to the
// bridge's socket (bridge_socket in that config); the bridge checks the assertion itself and offers the item on
// Telegram (docs/approvals.md).
const ledgerOn = () => loadConf().verifier === 'ledger'
const LEDGER_LABEL = 'with the ledger on, the T2 go is your tap on Telegram: the item\'s Approve sends it there'
const SENT = 'Sent to your Telegram: tap Approve there.'
function toBridge(sock, item, assertionHeader) {
  const body = JSON.stringify({ item })
  return new Promise((resolve) => {
    const r = http.request({ socketPath: sock, method: 'POST', path: '/approve', timeout: 10000,
      headers: { host: 'mm-approve', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-mm-assertion': assertionHeader } }, (up) => {
      let t = ''; up.setEncoding('utf8'); up.on('data', (d) => { if (t.length < 4096) t += d })
      up.on('end', () => { let d = {}; try { d = JSON.parse(t) } catch {} resolve({ code: up.statusCode || 502, d }) })
    })
    r.on('timeout', () => r.destroy(new Error('timed out')))
    r.on('error', (e) => resolve({ code: 0, err: e.message }))
    r.end(body)
  })
}
// ---------- the owner's own actions on an item (sy-92sg): Approve, Not now, Reply, Done ----------
// POST /api/approve | /api/not-now | /api/reply | /api/done, on the public side only, by the owner (the gateway's
// assertion, role owner), from the board's own page: a JSON body, and the request same-origin (an Origin of another
// site is always refused; Sec-Fetch-Site, when the browser sends it, must be same-origin; without it the Origin must be
// the board's public origin, https://<the assertion's host>). A form from another site can send neither JSON nor these
// headers. The gateway's Waiting list calls the same routes server to server, with a fresh owner assertion and the
// same headers: it is checked like a browser, never trusted more.
//   approve   a t2 item review signed off, not approved yet. verifier actor: the board adds `approved` as the owner (the
//             journal's actor is the owner's signed name, as the owner's label PATCH) and a comment. verifier ledger:
//             nothing is written here; the item goes to the bridge, whose Telegram offer the owner taps (the tap signs).
//             Whichever comes first counts (the bridge's label or this one); the second answers "already approved".
//   not-now   the same checks; a comment, and needs-you removed.
//   reply     a comment (1..1000 characters) as the owner.
//   done      an item with needs-you: a comment, and needs-you removed.
// Each one is logged (who, item, what, from where); never the assertion or a cookie.
const T2_NO_SIGNOFF = 'review has not signed it off yet (a t2 item: plan -> review\'s sign-off -> your go)'
/** The T2 go comes after review's sign-off (sy-l9uc, review's sy-16ml #2; the bridge's tap checks the same): the item's
 *  labels after the go must not be t2 without signed-off, and when the item's owner card names a Head, review's
 *  sign-off must name that head (sy-hzmu, owner-card.mjs headRefusal; checked on the labels without `approved`, as the
 *  go is not given yet). One check, for rails() and the board's Approve and Not now. */
const goRefusal = (labels, description) => {
  if (labels.has('t2') && !labels.has('signed-off')) return T2_NO_SIGNOFF
  return headRefusal(description, [...labels].filter((l) => l !== 'approved'))
}
const REPLY_MAX = 1000, ACTION_BODY_MAX = 8192
// control characters but the newline, and the bidi controls (a reply is plain text)
const REPLY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
/** A POST from the board's own page (CSRF), on the public side: see above. */
function sameOrigin(req) {
  const mine = `https://${req.gateway.h}`, site = String(req.headers['sec-fetch-site'] || ''), origin = String(req.headers.origin || '')
  const foreign = origin !== '' && origin !== 'null' && origin !== mine
  return !(foreign || (site ? site !== 'same-origin' : origin !== mine))
}
const clientOf = (req) => String(req.headers['x-mm-client-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || undefined
/** The checks every owner action shares. Sends the refusal and returns null, or returns { g, item, labels, body }. */
async function ownerAction(req, res, what) {
  const g = req.gateway
  const no = (code, title, why = title) => {
    log('info', `${what} refused: ${why}`, { op: 'owner-action', action: what, actor: g?.u, role: g?.r, ip: clientOf(req) })
    send(res, code, { title }); return null
  }
  if (!g) return no(403, 'Not allowed: the owner acts on an item signed in on the board\'s public address (or with the bridge\'s Approve button).', 'the local side')
  if (g.r !== 'owner') return no(403, `Not allowed: only the owner does this (${what}).`, `role ${g.r}`)
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return no(415, 'Not allowed: send JSON from the board\'s own page.', 'not JSON')
  if (!sameOrigin(req)) return no(403, 'Not allowed: use the board\'s own page.', `not same-origin (origin ${String(req.headers.origin || '-').slice(0, 100)}, sec-fetch-site ${String(req.headers['sec-fetch-site'] || '-').slice(0, 20)})`)
  const raw = await readBody(req)
  if (raw.length > ACTION_BODY_MAX) return no(413, 'That is too long.')
  let body
  try { body = JSON.parse(raw || '{}') } catch { return no(400, 'Bad JSON') }
  const item = String(body?.item || '')
  if (!ITEM.test(item)) return no(400, 'Not an item id.')
  const it = await getItem(item)
  if (!it || !Array.isArray(it.labels)) return no(404, `${item}: no such item here (or the board can't read it now).`, `${item} unreadable`)
  if (it.status === 'closed') return no(409, `${item} is closed.`)
  return { g, item, labels: new Set(it.labels), description: typeof it.description === 'string' ? it.description : '', body }
}
/** The T2 go's own checks (approve, not-now): a t2 item, review's sign-off, not approved yet. */
function goState(item, labels, description) {
  if (labels.has('approved')) return { code: 409, title: `${item} is already approved.`, already: true }
  if (!labels.has('t2')) return { code: 403, title: 'Not allowed: not a t2 item, there is no T2 go to give.' }
  const why = goRefusal(labels, description); if (why) return { code: 403, title: `Not allowed: ${why}.` }
  return null
}
async function bdSend(method, apiPath, obj) {
  const r = await fetch(new URL(apiPath, BD), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }).catch(() => null)
  return !!r?.ok
}
// as the rails write for the public side: the author is the signed name, a comment starts with the role
const bdComment = (item, author, text) => bdSend('POST', `/v0/beads/issues/${encodeURIComponent(item)}/comments`, { text: `[owner] ${text}`, author })
const bdLabels = (item, actor, patch) => bdSend('PATCH', `/v0/beads/issues/${encodeURIComponent(item)}`, { patch, actor })
const did = (req, what, a, more = {}) => log('info', `${what} of ${a.item} by ${a.g.u}`, { op: 'owner-action', action: what, actor: a.g.u, item: a.item, ip: clientOf(req), ...more })
function refusedGo(req, res, what, a, st) {
  log('info', `${what} of ${a.item} refused: ${st.title}`, { op: 'owner-action', action: what, actor: a.g.u, item: a.item, ip: clientOf(req) })
  return send(res, st.code, { title: st.title, ...(st.already ? { already: true } : {}) })
}
async function webApprove(req, res) {
  const a = await ownerAction(req, res, 'approve'); if (!a) return
  const { g, item } = a
  const st = goState(item, a.labels, a.description); if (st) return refusedGo(req, res, 'approve', a, st)
  const c = loadConf()
  if (c.verifier !== 'ledger') {
    // verifier actor: the owner's go, written as the owner (what the Supervisor counts), then said on the item
    if (!(await bdLabels(item, g.u, { add_labels: ['approved'] }))) return send(res, 502, { title: 'The board could not write it: nothing was approved.' })
    const said = await bdComment(item, g.u, `Approved on the board by ${g.u}.`)
    // the owner has done what was asked: the item no longer waits on them
    const dropped = a.labels.has('needs-you') ? await bdLabels(item, g.u, { remove_labels: ['needs-you'] }) : null
    did(req, 'approve', a, { mode: 'actor', comment: said, dropped })
    return send(res, 200, { ok: true, approved: true, title: `Approved on the board by ${g.u}.` })
  }
  const b = bridgeSocket(c)
  if (!b.path) {
    log('warn', `web approve of ${item} refused: ${b.why}`, { op: 'approve', actor: g.u, item })
    return send(res, 503, { title: 'No web approval here: the bridge has no endpoint for it. Nothing was sent and nothing was approved: approve on Telegram.' })
  }
  const r = await toBridge(b.path, item, String(req.headers['x-mm-assertion']))
  if (r.code >= 200 && r.code < 300) { did(req, 'approve', a, { mode: 'ledger', sent: 'bridge' }); return send(res, 200, { ok: true, title: SENT }) }
  const said = typeof r.d?.title === 'string' ? r.d.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : ''
  log('warn', `web approve of ${item}: the bridge ${r.err ? `is unreachable (${r.err})` : `answered ${r.code}${said ? `: ${said}` : ''}`}`, { op: 'approve', actor: g.u, item })
  return send(res, 502, { title: r.err ? 'The bridge is not answering: nothing was sent and nothing was approved.' : `The bridge refused it${said ? `: ${said}` : ''}. Nothing was approved.` })
}
async function webNotNow(req, res) {
  const a = await ownerAction(req, res, 'not-now'); if (!a) return
  const st = goState(a.item, a.labels, a.description); if (st) return refusedGo(req, res, 'not-now', a, st)
  if (!(await bdComment(a.item, a.g.u, `Not now, said ${a.g.u} on the board.`))) return send(res, 502, { title: 'The board could not write it.' })
  const dropped = a.labels.has('needs-you') ? await bdLabels(a.item, a.g.u, { remove_labels: ['needs-you'] }) : null
  did(req, 'not-now', a, { dropped })
  return send(res, 200, { ok: true, title: `Not now: said on ${a.item}.` })
}
async function webReply(req, res) {
  const a = await ownerAction(req, res, 'reply'); if (!a) return
  const text = String(a.body.text ?? '').replace(/\r\n?/g, '\n').replace(REPLY_CONTROL, ' ').trim()
  const n = Array.from(text).length
  if (!n || n > REPLY_MAX) return send(res, 400, { title: `Write 1 to ${REPLY_MAX} characters.` })
  if (!(await bdComment(a.item, a.g.u, text))) return send(res, 502, { title: 'The board could not write it.' })
  did(req, 'reply', a, { chars: n })
  return send(res, 200, { ok: true, title: `Your reply is on ${a.item}.` })
}
async function webDone(req, res) {
  const a = await ownerAction(req, res, 'done'); if (!a) return
  if (!a.labels.has('needs-you')) return send(res, 409, { title: `${a.item} does not wait for you (no needs-you).` })
  if (!(await bdComment(a.item, a.g.u, `Checked: done, said ${a.g.u}.`))) return send(res, 502, { title: 'The board could not write it.' })
  const dropped = await bdLabels(a.item, a.g.u, { remove_labels: ['needs-you'] })
  did(req, 'done', a, { dropped })
  return send(res, 200, { ok: true, title: `Checked: done, said on ${a.item}.` })
}
async function currentItem(id) {
  const r = await fetch(new URL(`/v0/beads/issues/${encodeURIComponent(id)}`, BD)).then((x) => x.json()).catch(() => null)
  return Array.isArray(r?.labels) ? { labels: r.labels, description: typeof r.description === 'string' ? r.description : '' } : null
}
const currentLabels = async (id) => (await currentItem(id))?.labels ?? null
const LABEL_FIELDS = { create: ['labels'], patch: ['labels', 'add_labels', 'remove_labels'] }
const names = (v) => v === undefined || (Array.isArray(v) && v.every((l) => typeof l === 'string'))
/** The labels a write adds and removes: { added, removed }, or { why } when it can't be told (a field it does not know). */
async function labelChange(req, apiPath, data) {
  const create = req.method === 'POST' && apiPath === '/v0/beads/issues'
  if (!create && req.method !== 'PATCH') return { added: [], removed: [] }
  const obj = create ? data : (data.patch || {}), known = LABEL_FIELDS[create ? 'create' : 'patch']
  if (Object.keys(obj).some((k) => /label/i.test(k) && !known.includes(k))) return { why: 'unknown label field' }
  if (!known.every((k) => names(obj[k]))) return { why: 'labels are a list of names' }
  if (create) return { added: [...(obj.labels || [])], removed: [] }
  let added = [...(obj.add_labels || [])], removed = [...(obj.remove_labels || [])]
  if (obj.labels) {
    const cur = await currentLabels(apiPath.split('/').pop()); if (!cur) return { why: 'could not read the item to check its labels' }
    added = added.concat(obj.labels.filter((l) => !cur.includes(l))); removed = removed.concat(cur.filter((l) => !obj.labels.includes(l)))
  }
  return { added, removed }
}
async function rails(req, apiPath, data) {
  const g = req.gateway, ch = await labelChange(req, apiPath, data)
  if (ch.why) return ch.why
  if (!g) return localRefusal(ch.added, ch.removed) // the local side: as before, but approved
  const why = railRefusal(g.r, ch.added, ch.removed); if (why) return why
  if (ch.added.includes('approved') && ledgerOn()) return LEDGER_LABEL
  // the T2 go comes after review's sign-off, for the head it signed (goRefusal, sy-l9uc, sy-hzmu)
  if (ch.added.includes('approved')) {
    const create = req.method === 'POST' && apiPath === '/v0/beads/issues'
    const it = create ? { labels: [], description: '' } : await currentItem(apiPath.split('/').pop())
    if (!it) return 'could not read the item to check its labels'
    const after = new Set([...it.labels, ...ch.added].filter((l) => !ch.removed.includes(l)))
    // the description after the write: the one it sets, else the item's own (sy-hzmu: the card's Head)
    const set = create ? data.description : data.patch?.description
    const why = goRefusal(after, typeof set === 'string' ? set : it.description); if (why) return why
  }
  if (req.method === 'POST' && apiPath === '/v0/beads/issues') data.labels = [...new Set([...(data.labels || []), `by:${g.r}`])]
  else if (apiPath.endsWith('/comments')) data.text = `[${g.r}] ${String(data.text || '')}`
  return null
}

async function proxy(req, res, apiPath, search) {
  if (!ALLOW.some(([m, re]) => m === req.method && re.test(apiPath))) {
    return send(res, 403, { title: 'Not allowed from the board', path: apiPath })
  }
  let body
  if (req.method !== 'GET') {
    let data = {}
    try { data = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, { title: 'Bad JSON' }) }
    const actor = who(req)
    const refused = await rails(req, apiPath, data)
    if (refused) { log('info', `refused on the ${req.gateway ? 'public' : 'local'} side: ${refused}`, { op: 'rails', actor, role: req.gateway?.r, path: apiPath }); return send(res, 403, { title: `Not allowed: ${refused}.` }) }
    if (apiPath.endsWith('/comments')) { data.author = actor; delete data.actor } else { data.actor = actor }
    if (req.method === 'POST' && apiPath === '/v0/beads/issues') data.owner = actor
    body = JSON.stringify(data)
  }
  const ps = startSpan(`${req.method} bd-serve${routeOf(apiPath)}`, { 'http.method': req.method, 'url.path': apiPath }, undefined, 3, req.method === 'GET' ? { minMs: 300 } : {})
  const up = http.request({
    host: BD.hostname, port: BD.port, method: req.method, path: apiPath + search,
    headers: { host: BD.host, accept: req.headers.accept || '*/*', traceparent: ps.traceparent(),
      ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
  }, (r) => {
    const headers = { 'content-type': r.headers['content-type'] || 'application/json' }
    if (apiPath.endsWith('events:watch')) Object.assign(headers, { 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    res.writeHead(r.statusCode || 502, headers)
    ps.set('http.status_code', r.statusCode)
    r.on('close', () => ((r.statusCode || 502) >= 500 ? ps.fail(`HTTP ${r.statusCode}`) : ps.end()))
    r.pipe(res)
  })
  up.on('error', (e) => { ps.fail(e); send(res, 502, { title: 'bd serve unreachable', detail: e.message }) })
  req.on('close', () => up.destroy())
  up.end(body)
}

// Agents of this project, kept fresh in the background: one list every few seconds over the Paseo SDK's connection
// (bin/lib/paseo.mjs; ~15 ms, where a `paseo ls` costs ~0.6 s of CLI start-up), never on a request's path. Roles come from where an agent runs: leads/<role>, setup/, or a worker's
// worktrees/w-<item>.
let agents = { at: 0, data: null }
const HOME_DIR = process.env.HOME || ''
function pollAgents() {
  P_.list().then((list) => [null, list], (e) => [e, null]).then(([err, list]) => {
    try {
      if (!err) {
        const data = Object.fromEntries([...ROLES, 'setup'].map((r) => [r, null]))
        data._workers = []
        for (const a of list) {
          const cwd = String(a.cwd || '').replace(/^~(?=\/|$)/, HOME_DIR)
          const inside = cwd === ROOT || cwd.startsWith(ROOT + '/'), rel = inside ? cwd.slice(ROOT.length + 1) : null
          const info = { id: a.shortId || a.id, name: a.name, status: a.status, provider: a.provider, thinking: a.thinking, cwd: a.cwd, created: a.created }
          let m, w
          if (inside && (m = /^leads\/([\w-]+)$/.exec(rel)) && m[1] in data && !data[m[1]]) data[m[1]] = info
          else if (inside && rel === 'setup' && !data.setup) data.setup = info
          else if ((w = workerOf(a, rel))) data._workers.push(w)
        }
        agents = { at: Date.now(), data }
      }
    } catch {}
    setTimeout(pollAgents, 4000)
  })
}
// A worker (sy-6h43): an agent of this project that says it is one: a worker's worktree here (worktrees/w-<item>), or
// the project's label (project=<this>; on the CLI path, which has no labels, a name that starts with the project) with
// a `<role>-worker` role label or "worker" in its name (bin/lead and the briefs name them "<project> · <role> worker
// <item>"). Its role: the role label without -worker, else the name, else the role that has workers; its item: the
// `item` label, else the name, else the worktree.
function workerOf(a, rel) {
  const labels = a.labels || {}, name = String(a.name || ''), wt = rel !== null ? /^worktrees\/w-(.+)$/.exec(rel) : null
  const ours = labels.project === PROJECT || (!labels.project && name.startsWith(`${PROJECT} `))
  if (!wt && !(ours && (/-worker$/.test(labels.role || '') || /\bworker\b/i.test(name)))) return null
  const known = (r) => (r && ROLES.includes(r) ? r : null)
  const role = known(String(labels.role || '').replace(/-worker$/, '')) || known((/([a-z][a-z0-9-]*)[ -]worker\b/i.exec(name) || [])[1]?.toLowerCase())
    || ROLE_DEFS.find((r) => r.workers)?.id || ''
  const item = (ID_RE.test(labels.item || '') && labels.item) || (/\bworker\s+([a-z]+-[a-z0-9]+(?:\.[0-9]+)*)\b/i.exec(name) || [])[1] || wt?.[1] || null
  return { id: a.shortId || a.id, name, role, status: a.status, item }
}
pollAgents()
async function leads() {
  for (let i = 0; !agents.data && i < 50; i++) await new Promise((r) => setTimeout(r, 100)) // first poll only
  return agents.data || Object.fromEntries([...ROLES, 'setup'].map((r) => [r, null]))
}

// From the Beads event journal: who created each item (bd serve leaves created_by empty) and the last comment.
const meta = { seq: 0, creators: {}, last: {}, lastAct: {}, lastTs: 0, requeues: {}, seen: {} }
async function refreshMeta() {
  for (;;) {
    const r = await fetch(new URL(`/v0/beads/events?since=${meta.seq}&limit=500`, BD), { minMs: 1000 }).then((x) => x.json())
    const recs = r.records || []
    for (const e of recs) {
      meta.seq = Math.max(meta.seq, e.seq)
      const t = Date.parse(e.ts); if (t > meta.lastTs) meta.lastTs = t
      if (e.op === 'create' && e.actor && !meta.creators[e.issue_id]) meta.creators[e.issue_id] = e.actor
      if (e.op === 'comment' && e.comment) meta.last[e.issue_id] = { author: e.comment.author, at: e.comment.created_at || e.ts }
      if (e.actor) meta.lastAct[e.actor] = { item: e.issue_id, at: e.ts }
    }
    foldRequeues(meta.requeues, meta.seen, recs) // claims wake requeued (pull-state.mjs)
    if (recs.length < 500) break
  }
}
// Each lead's state for the board (site/lead-state.mjs): ready / working on <item> / waiting for you / blocked / start
// failed; never "offline" (leads are on demand: wake starts them when a request waits). Kept for 3 s.
let statesCache = { at: 0, data: null }
async function leadStates(l) {
  if (statesCache.data && Date.now() - statesCache.at < 3000) return statesCache.data
  let items = [], wake = {}
  try { items = (await fetch(new URL('/v0/beads/issues?limit=500', BD), { minMs: 1000 }).then((x) => x.json())).items || [] } catch {}
  try { wake = JSON.parse(fs.readFileSync(path.join(ROOT, '.wake-state.json'), 'utf8')) } catch {}
  const data = Object.fromEntries([...ROLES, 'setup'].map((role) => [role, leadState({ role, agent: l[role], wake: wake[role], items, lastAct: meta.lastAct[role] })]))
  statesCache = { at: Date.now(), data }
  return data
}
async function sendMeta(res) {
  try {
    const [l] = await Promise.all([leads(), refreshMeta()])
    const states = await leadStates(l)
    let personas = null
    try { personas = JSON.parse(readText('leads/personas.json') || 'null') } catch {}
    let raci = null
    try { raci = JSON.parse(readText('leads/raci.json') || 'null') } catch {}
    send(res, 200, { project: PROJECT, leads: l, states, creators: meta.creators, last: meta.last, personas, roles: ROLE_DEFS, raci, panels: PANELS })
  } catch (e) { send(res, 502, { title: 'meta failed', detail: e.message }) }
}

// Every item on the board (all pages), by id: a page seen twice never counts twice. Over 20 pages: an error, so a count
// is never wrong (the summary's card then says unavailable).
async function allItems() {
  const items = new Map()
  let cursor = ''
  for (let page = 0; page < 20; page++) {
    const r = await fetch(new URL(`/v0/beads/issues?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, BD)).then((x) => (x.ok ? x.json() : Promise.reject(new Error(`bd serve ${x.status}`))))
    for (const i of Array.isArray(r?.items) ? r.items : []) if (i && typeof i.id === 'string') items.set(i.id, i)
    cursor = r?.has_more && typeof r.next_cursor === 'string' ? r.next_cursor : ''
    if (!cursor) break
  }
  if (cursor) throw new Error('too many items to count')
  return [...items.values()]
}
const readyItems = () => fetch(new URL('/v0/beads/ready?limit=500', BD)).then((x) => (x.ok ? x.json() : Promise.reject(new Error(`bd serve ${x.status}`)))).then((r) => (Array.isArray(r?.items) ? r.items : []))
const CAPACITY = () => Object.fromEntries(ROLE_DEFS.filter((r) => Number.isInteger(r.capacity) && r.capacity > 0).map((r) => [r.id, r.capacity]))

// The pull model on the Leads page (sy-6h43; pull-state.mjs): per role its queue, its claims against its capacity, each
// claim's lease, the requeued items and its workers. Read-only, so a viewer may read it. Kept for 3 s.
let pullCache = { at: 0, data: null }
async function pull() {
  if (pullCache.data && Date.now() - pullCache.at < 3000) return pullCache.data
  const [items, ready] = await Promise.all([allItems(), readyItems(), refreshMeta().catch(() => {})])
  const now = Date.now()
  const data = { at: new Date(now).toISOString(), roles: pullState({ roles: [...ROLES, 'setup'], capacity: CAPACITY(), items, ready, requeues: meta.requeues,
    workers: agents.data?._workers || [], now }) }
  pullCache = { at: Date.now(), data }
  return data
}

// The Flow panel (sy-6h43; flow-rows.mjs): the numbers of `mm obs flow` for this board, from the same series, read from
// the machine's metrics store (.run/endpoints.json "observability"; the import address's own export) on the server only;
// the browser never talks to the store. Only this project's series. Kept for 60 s; one read at a time.
const METRICS_IMPORT = process.env.MM_OBS_METRICS ?? endpoints().observability?.metrics ?? ''
let flowCache = { at: 0, data: null, pending: null }
async function flow() {
  if (!METRICS_IMPORT) return { available: false, why: 'no metrics store on this machine (mm onboard installs it)', pairs: PAIRS }
  const now = Number(process.env.BOARD_FLOW_NOW) || Date.now()
  const url = new URL('/api/v1/export', METRICS_IMPORT)
  url.search = exportQuery(PROJECT, now).toString()
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`metrics store: HTTP ${r.status}`)
  const text = await r.text()
  const { rows, ranges } = flowRows(parseExport(text), now)
  return { available: true, at: new Date(now).toISOString(), project: PROJECT, rows: rows.filter((x) => x.project === PROJECT), events: ranges.filter((x) => x.project === PROJECT), pairs: PAIRS }
}
async function sendFlow(res) {
  if (!flowCache.data || Date.now() - flowCache.at > 60000) {
    flowCache.pending ||= flow().then((d) => { flowCache = { at: Date.now(), data: d, pending: null } }, (e) => { flowCache = { at: Date.now() - 50000, data: { available: false, why: e.message, pairs: PAIRS }, pending: null } })
    await flowCache.pending
  }
  send(res, 200, flowCache.data)
}

// The board's summary for the gateway's home page (sy-ukbz): counts and one time only, never item text. Read-only, so a
// viewer may read it; on the public side it is checked like every other request (handlePublic). "mine" = the open items
// assigned to the asking person; "needs_you" = items labelled needs-you, and for the owner also the t2 items review
// signed off that wait for the owner's approved ("approvals", the owner's only).
// The worst signal (sy-6h43), whole numbers and one role id only (the gateway makes the text and checks the id against
// this project's roles): "needs_you_min", the oldest of the needs_you items in minutes since its last update; the queue
// whose head waits longest (bd ready, as wake hands it): "queue_role", its length "queue" and that wait "queue_min".
// Only when asked (?signal=1, the gateway that knows them), so a gateway that reads only the five counts keeps working.
async function sendSummary(req, res, signal = false) {
  const me = who(req), owner = req.gateway?.r === 'owner'
  const [items, ready] = await Promise.all([allItems(), signal ? readyItems() : []])
  await Promise.race([refreshMeta().catch(() => {}), new Promise((ok) => setTimeout(ok, 1000))]) // the gateway waits 3 s in all
  const open = items.filter((i) => i.status !== 'closed'), labels = (i) => (Array.isArray(i.labels) ? i.labels : [])
  let last = meta.lastTs
  for (const i of open) { const t = Date.parse(i.updated_at); if (t > last) last = t }
  const now = Date.now(), min = (i) => Math.max(0, Math.floor((now - (Date.parse(i.updated_at) || now)) / 60000))
  const approval = (i) => owner && labels(i).includes('t2') && labels(i).includes('signed-off') && !labels(i).includes('approved')
  const waits = open.filter((i) => labels(i).includes('needs-you') || approval(i))
  let worst = null
  for (const q of pullState({ roles: [...ROLES, 'setup'], items: [], ready, now })) {
    if (!q.queue.length) continue
    const m = Math.floor(Math.max(...q.queue.map((x) => x.wait_s)) / 60)
    if (!worst || m > worst.min || (m === worst.min && q.queue.length > worst.n)) worst = { role: q.role, n: q.queue.length, min: m }
  }
  send(res, 200, {
    open: open.length,
    p0: open.filter((i) => i.priority === 0).length,
    blocked: open.filter((i) => i.status === 'blocked').length,
    needs_you: waits.length,
    mine: open.filter((i) => i.assignee && i.assignee === me).length,
    ...(last > 0 ? { last: new Date(last).toISOString() } : {}),
    ...(signal ? {
    needs_you_min: waits.length ? Math.max(...waits.map(min)) : 0,
    approvals: open.filter(approval).length,
    queue: worst ? worst.n : 0,
    queue_min: worst ? worst.min : 0,
    ...(worst ? { queue_role: worst.role } : {}) } : {}),
  })
}

// The "Waiting for you" list for the gateway's home page (sy-vdi8; waiting.mjs, review's rules in sy-6h43 #5): the items
// that wait on the asking person (the owner: needs-you and the signed-off t2s without approved; anyone else: only the
// open items assigned to them), each id, plain title, age in minutes and the labels the ask needs. Read-only, so a viewer
// may read it; on the public side it is checked like every other request (handlePublic). No cache: a revoke, a new
// label or a closed item shows on the next load. Under 32 KB.
async function sendWaiting(req, res) {
  const items = await allItems()
  send(res, 200, waitingFor({ items, me: who(req), owner: req.gateway?.r === 'owner', now: Date.now(), cards: waitingCards(new URL(req.url, 'http://x').searchParams) }))
}
// ?card=1: the card's fields (sy-92sg); &head=1 too: its Head and the head's refusal (sy-hzmu)
function waitingCards(q) {
  return q.get('card') !== '1' ? false : q.get('head') === '1' ? 2 : true
}

// ---------- panels (off unless the board's env turns them on: BOARD_PANELS=machine; the system profile does) ----------
// machine: the box's state (brain status + score, observability) and one row per project (mm ls + mm obs status), with a
// row action that files an item on that project's own board (bin/project-item; the system never edits a project).
const PANELS = (process.env.BOARD_PANELS || '').split(',').map((x) => x.trim()).filter(Boolean)
const MM_BIN = process.env.MM_BIN || 'mm'
const sh = (cmd, args, timeout = 60000) => new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, out, errOut) =>
  ok({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '').slice(0, 500) })))
const jsonOf = (r) => { try { return JSON.parse(r.out) } catch { return null } }
let machineCache = { at: 0, data: null, pending: null }
async function machine() {
  const brainBin = path.join(dirs().brain, 'bin', 'brain'), hasBrain = fs.existsSync(brainBin)
  const [st, sc, ls, obs] = await Promise.all([hasBrain ? sh(brainBin, ['status'], 120000) : null, hasBrain ? sh(brainBin, ['score', '--json'], 120000) : null,
    sh(MM_BIN, ['ls', '-o', 'json']), sh(MM_BIN, ['obs', 'status', '-o', 'json'], 30000)])
  const lines = st ? st.out.split('\n').filter((l) => l.startsWith('[brain] ')).map((l) => l.slice(8)) : []
  const kind = (l) => (/^(ALERT|LINT ERROR|UNCOVERED|ACTIVE RUN|WEEKLY HOUSEKEEPING DUE)\b/.exec(l)?.[1] || 'info').toLowerCase()
  const o = jsonOf(obs) || {}, byProject = Object.fromEntries((o.projects || []).map((r) => [r.project, r]))
  return {
    at: new Date().toISOString(),
    brain: hasBrain ? { ok: !!st?.ok, lines: lines.map((text) => ({ kind: kind(text), text })), score: jsonOf(sc), error: st?.ok ? undefined : st?.err } : null,
    obs: { ok: obs.ok, stores: o.stores || [] },
    projects: (jsonOf(ls) || []).map((p) => ({ ...p, self: p.project === PROJECT, ...(byProject[p.project] ? { logs: Number(byProject[p.project].logs), errors: Number(byProject[p.project].errors), spans: Number(byProject[p.project].spans), failed_spans: Number(byProject[p.project].failed_spans) } : {}) })),
  }
}
async function sendMachine(res) {
  const now = Date.now()
  if (!machineCache.data || now - machineCache.at > 30000) {
    machineCache.pending ||= machine().then((d) => { machineCache = { at: Date.now(), data: d, pending: null } }).catch((e) => { machineCache.pending = null; throw e })
    if (!machineCache.data) await machineCache.pending // first load waits; later ones serve the last answer while refreshing
  }
  send(res, 200, machineCache.data)
}
// File an item on a project's own board, as the human at this board (system/<name>), through bin/project-item.
// On the public side it is the owner's only (sy-fei0), as the config API's writes: it steers another project's leads.
async function sendProjectItem(req, res) {
  if (req.gateway && req.gateway.r !== 'owner') {
    log('info', 'refused on the public side: /api/project-item is the owner\'s', { op: 'rails', actor: who(req), role: req.gateway.r, path: '/api/project-item' })
    return send(res, 403, { title: 'Only the owner can file an item on another project\'s board.' })
  }
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { title: 'JSON only' })
  const actor = who(req)
  if (!validName(actor) || actor === ACTOR) return send(res, 401, { title: 'Name yourself on this board first (top right): the item says who asked.' })
  let b
  try { b = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, { title: 'Bad JSON' }) }
  const title = String(b.title || '').trim(), desc = String(b.description || '').trim(), assignee = String(b.assignee || '').trim()
  const type = ['task', 'bug', 'feature'].includes(b.type) ? b.type : 'task', prio = Number.isInteger(b.priority) && b.priority >= 0 && b.priority <= 4 ? b.priority : 2
  if (!title || title.length > 200) return send(res, 400, { title: 'A title of 1–200 characters' })
  if (desc.length > 8000) return send(res, 400, { title: 'Description too long (8000 max)' })
  if (assignee && !/^[a-z][\w-]{0,31}$/.test(assignee)) return send(res, 400, { title: 'Assignee: a role id (e.g. setup)' })
  const known = (jsonOf(await sh(MM_BIN, ['ls', '-o', 'json'])) || []).map((p) => p.project)
  if (!known.includes(b.project) || b.project === PROJECT) return send(res, 400, { title: `Unknown project (or this board): ${String(b.project).slice(0, 40)}` })
  const args = [b.project, title, '-d', desc, '-t', type, '-p', String(prio), ...(assignee ? ['--assignee', assignee] : [])]
  const r = await new Promise((ok) => execFile(path.join(ROOT, 'bin', 'project-item'), args, { timeout: 60000, env: { ...process.env, PROJECT_ITEM_ACTOR: actor } },
    (err, out, errOut) => ok({ ok: !err, out: String(out || '').trim(), err: String(errOut || '').trim().slice(0, 300) })))
  if (!r.ok) return send(res, 502, { title: r.err || 'project-item failed' })
  log('info', `project item ${r.out} by ${actor}`, { op: 'project-item', project: b.project, actor })
  send(res, 200, { id: r.out.split(' ')[0], text: r.out })
}

// Lead settings: what each lead is told (CLAUDE.md chain + start message), its skills and permissions. Read-only.
const ROOT = path.resolve(here, '..')
const readText = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8') } catch { return null } }
function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md || '')
  const meta = {}
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim() }
  return { meta, body: m ? md.slice(m[0].length) : md }
}
async function sendSettings(res) {
  const l = await leads()
  await refreshMeta().catch(() => {})
  const states = await leadStates(l)
  const start = readText('leads/START.md') || ''
  const roles = ROLES.map((role) => {
    const dir = `leads/${role}`
    const layers = ['CLAUDE.md', 'leads/CLAUDE.md', `${dir}/CLAUDE.md`].map((p) => ({ path: p, content: readText(p) }))
    let skills = []
    try {
      skills = fs.readdirSync(path.join(ROOT, dir, '.claude/skills')).filter((n) => !n.startsWith('.')).sort().map((name) => {
        const p = `${dir}/.claude/skills/${name}/SKILL.md`
        const { meta, body } = frontmatter(readText(p))
        let source = null
        try { source = JSON.parse(readText(`${dir}/.claude/skills/${name}/.skills-sh.json`) || 'null') } catch {}
        return { name: meta.name || name, dir: name, description: meta.description || '', path: p, raw: readText(p), body, source }
      })
    } catch {}
    let permissions = null
    try { permissions = JSON.parse(readText(`${dir}/.claude/settings.json`) || 'null')?.permissions || null } catch {}
    const settingsRaw = readText(`${dir}/.claude/settings.tmpl.json`) ?? readText(`${dir}/.claude/settings.json`)
    if (ROLE_DEFS.find((d) => d.id === role)?.workers) layers.push({ path: 'worktrees/CLAUDE.md', content: readText('worktrees/CLAUDE.md') })
    return { role, cwd: dir, agent: l[role], state: states[role], layers, start: start.replaceAll('{role}', role).replaceAll('{project}', PROJECT), startTemplate: start,
      skills, permissions, settingsPath: `${dir}/.claude/settings.tmpl.json`, settingsRaw }
  })
  const setup = { role: 'setup', cwd: 'setup', agent: l.setup, state: states.setup,
    layers: ['CLAUDE.md', 'setup/CLAUDE.md'].map((p) => ({ path: p, content: readText(p) })),
    start: (readText('setup/START.md') || '').replaceAll('{project}', PROJECT), settingsRaw: readText('setup/.claude/settings.tmpl.json') ?? readText('setup/.claude/settings.json') }
  const themes = await new Promise((ok) => execFile('node', [path.join(ROOT, 'bin/persona'), 'themes'], { timeout: 10000 }, (e, out) => ok(e ? '' : out)))
  const themeList = themes.trim().split('\n').filter(Boolean).map((l) => {
    const [name, ...rest] = l.trim().split(/\s+/)
    return { name, sample: rest.join(' ') }
  })
  send(res, 200, { project: PROJECT, roles, setup, themes: themeList })
}

// Content produced for items: files under code/ touched by commits that mention the item id.
const CODE = path.join(ROOT, 'code')
const FILE_TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.js': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }
const git = (args) => new Promise((ok, no) =>
  execFile('git', ['-C', CODE, ...args], { maxBuffer: 8 << 20 }, (e, out) => (e ? no(e) : ok(out))))
const ID_RE = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/
// A board with no code (the system board, or a project before its first commit) is normal: no git call, no error.
const hasCode = () => fs.existsSync(path.join(CODE, '.git'))

async function sendContent(res, id) {
  if (!ID_RE.test(id)) return send(res, 400, { title: 'bad id' })
  // rev-list answers an empty line (exit 0) in a repo with no commits yet, where git log would fail
  if (!hasCode() || !(await git(['rev-list', '-n1', '--all'])).trim()) return send(res, 200, { id, files: [] })
  const pat = id.replaceAll('.', '\\.') + '([^.0-9a-z]|$)'
  const out = await git(['log', '-E', `--grep=${pat}`, '--format=%x1e%H%x1f%h%x1f%s%x1f%cI%x1f%an', '--name-status', '--no-renames'])
  const files = new Map()
  for (const rec of out.split('\x1e').slice(1)) {
    const [head, ...rest] = rec.split('\n')
    const [sha, short, subject, date, author] = head.split('\x1f')
    for (const line of rest) {
      const [st, p] = line.split('\t')
      if (!p) continue
      const f = files.get(p) || { path: p, commits: [] }
      f.commits.push({ sha, short, subject, date, author, status: st })
      files.set(p, f)
    }
  }
  const list = [...files.values()].filter((f) => fs.existsSync(path.join(CODE, f.path)))
  send(res, 200, { id, files: list })
}

// A file from code/ (optionally at a commit). HTML is served sandboxed: scripts run, but it cannot reach the board.
async function sendFile(res, rel, rev, annotate = false) {
  const p = path.normalize(rel || '').replace(/^(\.\.[/\\])+/, '')
  const ext = path.extname(p).toLowerCase()
  if (!p || p.startsWith('..') || path.isAbsolute(p) || !FILE_TYPES[ext] || p.startsWith('data/') || p.includes('/.')) {
    return send(res, 404, { title: 'not available' })
  }
  let body
  try {
    if (rev) {
      if (!/^[0-9a-f]{4,40}$/.test(rev)) return send(res, 400, { title: 'bad rev' })
      body = await new Promise((ok, no) => execFile('git', ['-C', CODE, 'show', `${rev}:${p}`], { encoding: 'buffer', maxBuffer: 16 << 20 },
        (e, out) => (e ? no(e) : ok(out))))
    } else body = fs.readFileSync(path.join(CODE, p))
  } catch { return send(res, 404, { title: 'not found' }) }
  sendBody(res, ext, body, annotate)
}
// The answer for a file the board shows (code/ or artifacts/): its type, no sniffing, HTML and SVG sandboxed.
function sendBody(res, ext, body, annotate) {
  if (ext === '.html' && annotate) {
    const tag = `<script>${fs.readFileSync(path.join(here, 'annotate.js'), 'utf8')}</script>`
    const html = body.toString('utf8')
    body = Buffer.from(/<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag)
  }
  const headers = { 'content-type': FILE_TYPES[ext], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }
  if (ext === '.html' || ext === '.svg') headers['content-security-policy'] = 'sandbox allow-scripts allow-popups; frame-ancestors \'self\''
  res.writeHead(200, headers)
  res.end(body)
}

// An item's artifacts (sy-wxzx): artifacts/<item-id>/<name> in the project root (bin/artifact copies them there and
// commits them), so a board with no code/ (the system board) shows screenshots, logs and notes too. One folder per
// item, plain names (no dotfile, no sub-folder), the viewer's types; no symlinked file, and no item folder that a
// symlink takes out of artifacts/ (realpath).
const ARTIFACTS = path.join(ROOT, 'artifacts')
const ARTIFACT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
/** The real path of artifacts/<id>/<name>, or null when it is not one the board shows. */
function artifactFile(id, name) {
  if (!ID_RE.test(id || '') || !ARTIFACT_NAME.test(name || '') || !FILE_TYPES[path.extname(name).toLowerCase()]) return null
  try {
    const dir = fs.realpathSync(path.join(ARTIFACTS, id)), f = path.join(dir, name)
    if (dir !== path.join(fs.realpathSync(ARTIFACTS), id) || !fs.lstatSync(f).isFile() || path.dirname(fs.realpathSync(f)) !== dir) return null
    return f
  } catch { return null }
}
function sendArtifact(res, rel, annotate) {
  const parts = String(rel || '').split('/')
  const f = parts.length === 2 ? artifactFile(parts[0], parts[1]) : null
  if (!f) return send(res, 404, { title: 'not available' })
  let body
  try { body = fs.readFileSync(f) } catch { return send(res, 404, { title: 'not found' }) }
  sendBody(res, path.extname(f).toLowerCase(), body, annotate)
}
function sendArtifacts(res, id) {
  if (!ID_RE.test(id)) return send(res, 400, { title: 'bad id' })
  let names = []
  try { names = fs.readdirSync(path.join(ARTIFACTS, id)) } catch {}
  const files = names.sort().flatMap((name) => {
    const f = artifactFile(id, name)
    if (!f) return []
    const st = fs.statSync(f)
    return [{ name, path: `artifacts/${id}/${name}`, type: FILE_TYPES[path.extname(name).toLowerCase()].split(';')[0], size: st.size, mtime: st.mtime.toISOString() }]
  })
  send(res, 200, { id, files })
}

// Workers on an item: Paseo agents labelled item=<id> (role=<role>-worker) (archived too), their branch's unlanded
// commits, and the tail of their activity. Humans may watch workers; the code lead may not (it reads only reports).
async function sendWorkers(res, id) {
  if (!ID_RE.test(id)) return send(res, 400, { title: 'bad id' })
  const run = (cmd, args, timeout = 15000) => new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (e, out) => ok(e ? '' : out)))
  let list = []
  try { list = await P_.list({ project: PROJECT, item: id }, { archived: true }) } catch {}
  const branch = `w-${id}`
  // for-each-ref answers an empty line (exit 0) for a branch that isn't there, so a missing branch is not a failed call
  const has = hasCode() ? (await run('git', ['-C', CODE, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).trim() : ''
  const commits = has ? (await run('git', ['-C', CODE, 'log', '--format=%h%x1f%an%x1f%cI%x1f%s', `main..${branch}`])).trim().split('\n').filter(Boolean)
    .map((l) => { const [sha, author, date, subject] = l.split('\x1f'); return { sha, author, date, subject } }) : []
  const stat = has ? (await run('git', ['-C', CODE, 'diff', '--stat=100', `main...${branch}`])).trim() : ''
  const workers = await Promise.all(list.map(async (a) => {
    const log = await run(PASEO, ['logs', a.id], 20000)
    const lines = log.split('\n').filter((l) => l.trim()).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
    return { id: a.shortId || a.id, status: a.status, created: a.created, activity: lines.slice(-60) }
  }))
  send(res, 200, { id, branch: has ? branch : null, landed: !has, commits, stat, workers })
}

// Presence: who is working right now, on which item, doing what ("typing…"). For each running lead or worker:
// the item = a worker's label, else the item the lead touched last since it started working, else what wake just
// handed it; "doing" = its latest activity line, summarised.
function summarise(line) {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line || '')
  if (!m) return line ? 'writing a reply' : 'thinking'
  const [tool, rest] = [m[1].toLowerCase(), m[2]]
  const file = (/(?:"file_path"|"path")\s*:\s*"([^"]+)"/.exec(rest) || [])[1] || (rest.startsWith('/') ? rest.split(/\s/)[0] : '')
  const short = (p) => p.replace(ROOT + '/', '').replace(/^worktrees\/[^/]+\//, '')
  if (/^(edit|write|multiedit)/.test(tool)) return file ? `editing ${short(file)}` : 'editing'
  if (/^read/.test(tool)) return file ? `reading ${short(file)}` : 'reading'
  if (/^(grep|glob|search)/.test(tool)) return 'searching the code'
  if (tool === 'shell' || tool === 'bash') {
    if (/\bnode --test|npm (test|run test)/.test(rest)) return 'running tests'
    if (/^\s*(cd [^&]+&&\s*)?bd\b/.test(rest)) return 'checking the board'
    if (/\b(land|deploy)\b/.test(rest)) return /\bdeploy\b/.test(rest) ? 'deploying' : 'landing on main'
    if (/\bgit (commit|add)\b/.test(rest)) return 'committing'
    if (/\bnpm (ci|install)\b/.test(rest)) return 'installing packages'
    return 'running a command'
  }
  if (/create agent|create_agent/.test(tool)) return 'starting a worker'
  if (/send agent|send_agent/.test(tool)) return 'messaging a worker'
  if (/web|fetch/.test(tool)) return 'reading the web'
  if (tool === 'user') return 'reading new messages'
  return 'working'
}
// Presence, also refreshed in the background (every 3 s): for each running agent, its item and its latest activity.
let presenceCache = { at: 0, data: [] }
const TAIL_MS = Number(process.env.BOARD_TAIL_MS || 15000), tails = new Map() // agent id -> { at, line }
async function pollPresence() {
  try {
    const l = agents.data
    if (l) {
      await refreshMeta().catch(() => {})
      let wakeState = {}
      try { wakeState = JSON.parse(fs.readFileSync(path.join(ROOT, '.wake-state.json'), 'utf8')) } catch {}
      const running = [
        ...Object.entries(l).filter(([k, a]) => k !== '_workers' && a && a.status === 'running').map(([role, a]) => ({ actor: role, kind: 'lead', id: a.id })),
        ...(l._workers || []).filter((w) => w.status === 'running').map((w) => ({ actor: `${w.role}/worker`, kind: 'worker', id: w.id, item: w.item })),
      ]
      // a `paseo logs` is a CLI process (~0.6 s of start-up): at most one per agent per TAIL_MS (sy-aaq3: one per running
      // agent every 3 s was most of the boards' new processes); the poll itself stays at 3 s for who runs
      const now = Date.now()
      for (const id of tails.keys()) if (!running.some((r) => r.id === id)) tails.delete(id)
      const tail = (id) => {
        const t = tails.get(id)
        if (t && now - t.at < TAIL_MS) return t.line
        return new Promise((ok) => execFile(PASEO, ['logs', id], { timeout: 8000, maxBuffer: 16 << 20, minMs: 2000 }, (e, out) => {
          const lines = (e ? '' : out).split('\n').filter((x) => x.trim())
          const line = lines[lines.length - 1] || (t?.line ?? '')
          tails.set(id, { at: Date.now(), line }); ok(line)
        }))
      }
      presenceCache = { at: Date.now(), data: await Promise.all(running.map(async (r) => {
        let item = r.item
        if (!item) { const w = wakeState[r.actor], act = meta.lastAct[r.actor]; item = act && (!w || act.at >= w.at) ? act.item : w?.items?.[0] }
        return { ...r, item: item || null, doing: summarise(await tail(r.id)) }
      })) }
    }
  } catch {}
  setTimeout(pollPresence, 3000)
}
pollPresence()
function sendPresence(res) { send(res, 200, { agents: presenceCache.data }) }

// Links to this project's public services (services.json `public`), using the public URLs the machine assigned.
function sendLinks(res) {
  let svc = {}
  svc = servicesDef()
  const links = Object.entries(svc).filter(([name, d]) => d.public && name !== 'board' && svcPublic(name))
    .map(([name]) => ({ name, label: name === 'app' ? 'App' : name, url: svcPublic(name) }))
  send(res, 200, { links })
}

// Mermaid, rendered server-side by merman-cli (MERMAN_BIN). The source is untrusted text from comments and docs:
// size and time limits, at most 2 renders at once, execFile with args (no shell), and a resvg-safe pipeline (labels as
// plain SVG text, no HTML). The SVG is then sanitised anyway, and the client shows it only as <img> (scripts never run).
// Cached by sha256(theme + source): in memory, and on disk under {root}/.cache/mermaid (errors are cached too).
const MERMAN = process.env.MERMAN_BIN || 'merman-cli'
const MERMAID_MAX = 20 * 1024, MERMAID_TIMEOUT_MS = 5000, MERMAID_CACHE_DIR = path.join(ROOT, '.cache', 'mermaid')
const mermaidMem = new Map() // key -> { svg } | { error }
let mermaidBusy = 0
const mermaidQueue = []
function sanitiseSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none')
}
function renderMermaid(source, theme) {
  return new Promise((resolve) => {
    const run = () => {
      mermaidBusy++
      // spawn with args (never a shell), in its own process group so a timeout kills everything it started
      const child = spawn(MERMAN, ['render', '-q', '-f', 'svg', '--svg-pipeline', 'resvg-safe', '-t', theme, '-b', 'transparent', '-o', '-', '-'],
        { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const out = [], errOut = []; let size = 0, timedOut = false, done = false
      const finish = (r) => {
        if (done) return; done = true; clearTimeout(timer)
        mermaidBusy--; const next = mermaidQueue.shift(); if (next) next()
        resolve(r)
      }
      const timer = setTimeout(() => {
        timedOut = true
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        finish({ error: `render took longer than ${MERMAID_TIMEOUT_MS / 1000}s`, timedOut: true })
      }, MERMAID_TIMEOUT_MS)
      child.stdout.on('data', (c) => { size += c.length; if (size > (4 << 20)) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } else out.push(c) })
      child.stderr.on('data', (c) => errOut.push(c))
      child.on('error', (e) => finish({ error: `renderer unavailable: ${e.message}` }))
      child.on('close', (code) => {
        if (timedOut) return
        if (code === 0) finish({ svg: sanitiseSvg(Buffer.concat(out).toString('utf8')) })
        else finish({ error: (Buffer.concat(errOut).toString('utf8').trim().split('\n')[0] || `renderer exited ${code}`).slice(0, 300) })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(source)
    }
    mermaidBusy < 2 ? run() : mermaidQueue.push(run)
  })
}
async function sendMermaid(req, res, url) {
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'default'
  const chunks = []; let size = 0
  for await (const c of req) { size += c.length; if (size > MERMAID_MAX) return send(res, 413, { error: `diagram source over ${MERMAID_MAX / 1024} KB` }); chunks.push(c) }
  const source = Buffer.concat(chunks).toString('utf8')
  if (!source.trim()) return send(res, 400, { error: 'empty diagram' })
  const key = crypto.createHash('sha256').update(theme + '\0' + source).digest('hex')
  let hit = 'memory', out = mermaidMem.get(key)
  if (!out) {
    hit = 'disk'
    try { out = { svg: fs.readFileSync(path.join(MERMAID_CACHE_DIR, `${key}.svg`), 'utf8') } } catch {
      try { out = { error: fs.readFileSync(path.join(MERMAID_CACHE_DIR, `${key}.err`), 'utf8') } } catch {}
    }
  }
  if (!out) {
    hit = 'miss'
    out = await renderMermaid(source, theme)
    if (!out.timedOut) { // a timeout may be load, not the diagram: don't remember it
      try { fs.mkdirSync(MERMAID_CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(MERMAID_CACHE_DIR, `${key}.${out.svg ? 'svg' : 'err'}`), out.svg ?? out.error) } catch {}
    }
  }
  if (!out.timedOut) { mermaidMem.set(key, out); if (mermaidMem.size > 300) mermaidMem.delete(mermaidMem.keys().next().value) }
  if (out.svg) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'x-mermaid-cache': hit, 'cache-control': 'private, max-age=86400',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' })
    return res.end(out.svg)
  }
  res.setHeader('x-mermaid-cache', hit)
  send(res, out.timedOut ? 504 : 422, { error: out.error })
}

function serveFile(res, urlPath) {
  let file = path.join(DIST, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  const ext = path.extname(file)
  const hashed = file.includes(`${path.sep}assets${path.sep}`)
  // pre-compressed copies from the build (compress.mjs): brotli, else gzip
  const accept = String(res.req?.headers['accept-encoding'] || '')
  const enc = /\bbr\b/.test(accept) && fs.existsSync(file + '.br') ? 'br' : /\bgzip\b/.test(accept) && fs.existsSync(file + '.gz') ? 'gzip' : null
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', vary: 'accept-encoding',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', ...(enc ? { 'content-encoding': enc } : {}) })
  fs.createReadStream(enc ? file + (enc === 'br' ? '.br' : '.gz') : file).pipe(res)
}

// ---------- the public side (mm.auth): only through mm's forwarder; nothing without the gateway's signed assertion ----------
// Its own port (BOARD_PUBLIC_PORT, loopback, reached only by the forwarder on bind_host), so a request from the web
// proxy can't be confused with a local one. The assertion: base64url(JSON {u, r, h, exp, n}) "." Ed25519 signature,
// checked with the gateway's public key (mm writes it into .run/endpoints.json "auth"); no key: refuse everything.
const PUBLIC_PORT = Number(process.env.BOARD_PUBLIC_PORT || 0)
let gwKey = { at: 0, key: null }
function gatewayKey() {
  if (Date.now() - gwKey.at > 60000) {
    let key = null
    const pem = process.env.MM_AUTH_PUBLIC_KEY || endpoints().auth?.public_key
    try { if (pem) key = crypto.createPublicKey(pem) } catch {}
    gwKey = { at: Date.now(), key }
  }
  return gwKey.key
}
function assertion(req) {
  const a = String(req.headers['x-mm-assertion'] || ''), [body, sig] = a.split('.'), key = gatewayKey()
  if (!body || !sig || !key) return null
  try {
    if (!crypto.verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64url'))) return null
    const c = JSON.parse(Buffer.from(body, 'base64url').toString())
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
    if (c.h !== host || !(c.exp > Date.now()) || !['owner', 'designer', 'member', 'viewer'].includes(c.r) || !validGatewayName(c.u)) return null
    return c
  } catch { return null }
}
const validGatewayName = (n) => typeof n === 'string' && /^[a-z][a-z0-9._-]{1,31}$/.test(n)
const SIGN_IN = '<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Sign in through the gateway: open this board\'s address again.</p>'
async function handlePublic(req, res) {
  const c = assertion(req)
  if (!c) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(SIGN_IN) }
  req.gateway = c
  const url = new URL(req.url, 'http://x')
  if (c.r === 'viewer' && !['GET', 'HEAD'].includes(req.method)) {
    log('info', `refused on the public side: a viewer's ${req.method}`, { op: 'rails', actor: c.u, role: c.r, path: url.pathname })
    return send(res, 403, { title: 'Viewers can look, not change: ask the owner for member access.' })
  }
  if (url.pathname === '/api/whoami' && req.method === 'POST') return send(res, 403, { title: 'Your name comes from your sign-in.' })
  return handle(req, res)
}

// Designs (plans/doop.md; site/designs.mjs): the project's Doop frames an item links, read on loopback with the design
// lead's agent key, which never leaves this process. GET only: on the public side, every role may read them.
const getItem = (id) => fetch(new URL(`/v0/beads/issues/${encodeURIComponent(id)}`, BD)).then((x) => (x.ok ? x.json() : null)).catch(() => null)
const designs = designsApi({ ROOT, send, getItem, allItems, svcUrl, svcPublic,
  me: (req) => (req.gateway ? req.gateway.u : cookieUser(req) || '') })

let cfg
startMetrics()
http.createServer((req, res) => withSpan(httpSpan(req, res, req.method === 'GET' ? { minMs: 300 } : {}), () => handle(req, res)).catch((e) => {
  log('error', `request ${req.method} ${req.url} failed: ${e?.stack || e}`, { route: req.url })
  try { if (!res.headersSent) send(res, 500, { title: 'internal error' }); else res.end() } catch {}
})).listen(PORT, HOST, () => log('info', `board on http://${HOST}:${PORT} -> ${BD.href} as ${ACTOR}`))
if (PUBLIC_PORT) http.createServer((req, res) => withSpan(httpSpan(req, res, req.method === 'GET' ? { minMs: 300 } : {}), () => handlePublic(req, res)).catch((e) => {
  log('error', `public request ${req.method} ${req.url} failed: ${e?.stack || e}`, { route: req.url })
  try { if (!res.headersSent) send(res, 500, { title: 'internal error' }); else res.end() } catch {}
})).listen(PUBLIC_PORT, '127.0.0.1', () => log('info', `board public side on 127.0.0.1:${PUBLIC_PORT} (the gateway's assertion required)`))

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://x')
  if (/^\/api\/(config|skills|leads)\//.test(url.pathname)) {
    cfg ||= configApi({ ROOT, ROLES, PROJECT, PASEO, BD, send, readBody, who })
    if (await cfg(req, res, url)) return
  }
  if (url.pathname === '/api/whoami' && req.method === 'GET') {
    // the owner on the public side also learns how the T2 go is given: the label (verifier actor) or Telegram (ledger)
    const owner = req.gateway?.r === 'owner'
    return send(res, 200, { actor: who(req), source: whoSource(req), ...(req.gateway ? { role: req.gateway.r } : {}), ...(owner ? { approval: ledgerOn() ? 'telegram' : 'label' } : {}) })
  }
  if (url.pathname === '/api/approve' && req.method === 'POST') return webApprove(req, res)
  if (url.pathname === '/api/not-now' && req.method === 'POST') return webNotNow(req, res)
  if (url.pathname === '/api/reply' && req.method === 'POST') return webReply(req, res)
  if (url.pathname === '/api/done' && req.method === 'POST') return webDone(req, res)
  if (url.pathname === '/api/whoami' && req.method === 'POST') {
    let name = ''
    try { name = String(JSON.parse(await readBody(req)).name || '').trim().toLowerCase() } catch {}
    if (!selfName(name)) return send(res, 400, { title: 'Pick 2–32 characters: a-z, 0-9, . _ -, starting with a letter. Lead and system names, and the owner\'s, are taken.' })
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    res.setHeader('set-cookie', `board_user=${encodeURIComponent(name)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`)
    return send(res, 200, { actor: name, source: 'self' })
  }
  if (url.pathname === '/api/meta' && req.method === 'GET') return sendMeta(res)
  if (url.pathname === '/api/summary' && req.method === 'GET') return sendSummary(req, res, url.searchParams.get('signal') === '1').catch(() => send(res, 502, { title: 'summary failed' }))
  if (url.pathname === '/api/waiting' && req.method === 'GET') return sendWaiting(req, res).catch(() => send(res, 502, { title: 'waiting list failed' }))
  if (url.pathname === '/api/pull' && req.method === 'GET') return pull().then((d) => send(res, 200, d), (e) => send(res, 502, { title: `pull failed: ${e.message}` }))
  if (url.pathname === '/api/flow' && req.method === 'GET') return sendFlow(res)
  if (url.pathname === '/api/links' && req.method === 'GET') return sendLinks(res)
  if (url.pathname === '/api/mermaid' && req.method === 'POST') return sendMermaid(req, res, url).catch((e) => send(res, 500, { error: e.message }))
  if (url.pathname === '/api/presence' && req.method === 'GET') return sendPresence(res)
  if (url.pathname.startsWith('/api/designs/') && await designs(req, res, url)) return
  const wm = /^\/api\/workers\/([\w.-]+)$/.exec(url.pathname)
  if (wm && req.method === 'GET') return sendWorkers(res, wm[1]).catch((e) => send(res, 500, { title: e.message }))
  const cm = /^\/api\/content\/([\w.-]+)$/.exec(url.pathname)
  if (cm && req.method === 'GET') return sendContent(res, cm[1]).catch((e) => send(res, 500, { title: e.message }))
  const am = /^\/api\/artifacts\/([\w.-]+)$/.exec(url.pathname)
  if (am && req.method === 'GET') return sendArtifacts(res, am[1])
  if (url.pathname.startsWith('/files/artifacts/') && req.method === 'GET') {
    let rel = null
    try { rel = decodeURIComponent(url.pathname.slice('/files/artifacts/'.length)) } catch {}
    return sendArtifact(res, rel, url.searchParams.get('annotate') === '1')
  }
  if (url.pathname.startsWith('/files/') && req.method === 'GET') return sendFile(res, decodeURIComponent(url.pathname.slice(7)), url.searchParams.get('rev'), url.searchParams.get('annotate') === '1')
  if (PANELS.includes('machine') && url.pathname === '/api/machine' && req.method === 'GET') return sendMachine(res).catch((e) => send(res, 502, { title: e.message }))
  if (PANELS.includes('machine') && url.pathname === '/api/project-item' && req.method === 'POST') return sendProjectItem(req, res).catch((e) => send(res, 500, { title: e.message }))
  if (url.pathname === '/api/settings' && req.method === 'GET') return sendSettings(res).catch((e) => send(res, 500, { title: e.message }))
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url.pathname.slice(4), url.search)
  serveFile(res, url.pathname)
}
