// Work site server: serves the built board and proxies an allowlist of Beads HTTP routes to `bd serve`.
// It, not the browser, sets who made a change: BOARD_ACTOR now, the Cloudflare Access email later.
// No dependencies: node server.mjs
import http from 'node:http'
import { execFile, fetch, httpSpan, log, routeOf, spawn, startMetrics, startSpan, withSpan } from '../bin/lib/obs.mjs'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configApi } from './config-api.mjs'
import * as P_ from '../bin/lib/paseo.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, 'dist')
import { dirs, endpoints, projectName, requireUrl, servicesDef, svcPublic } from '../bin/lib/svc.mjs'
// PORT is assigned by the process manager (portless); HOST is where the machine wants services bound.
const PORT = Number(process.env.PORT || process.env.BOARD_PORT)
if (!PORT) { console.error('board: set PORT'); process.exit(2) }
// Loopback (portless sets HOST); a public board is reached through mm's forwarder on the machine's bind_host. MM_BIND: an explicit override
const HOST = process.env.MM_BIND || process.env.HOST || process.env.BOARD_HOST || '127.0.0.1'
const BD = new URL(process.env.BD_SERVE || requireUrl('bd-serve'))
const ACTOR = process.env.BOARD_ACTOR || 'guest' // until the visitor names themselves
const ACCESS_HEADER = 'cf-access-authenticated-user-email' // trusted only behind Cloudflare Access
const TRUST_ACCESS = process.env.BOARD_TRUST_ACCESS === '1'
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

// Cloudflare Access: when ACCESS_TEAM (e.g. <team>.cloudflareaccess.com) and ACCESS_AUD are set, every request must carry
// a valid Access JWT (Cf-Access-Jwt-Assertion, RS256, signed by the team's keys, audience = the app's AUD tag);
// the actor is the email in it. Without them the board relies on the proxy's basic auth (BOARD_ACTOR).
const ACCESS_TEAM = process.env.ACCESS_TEAM || ''
const ACCESS_AUD = process.env.ACCESS_AUD || ''
let jwks = { at: 0, keys: new Map() }
async function accessKeys() {
  if (Date.now() - jwks.at < 3600e3 && jwks.keys.size) return jwks.keys
  const r = await fetch(`https://${ACCESS_TEAM}/cdn-cgi/access/certs`).then((x) => x.json())
  jwks = { at: Date.now(), keys: new Map((r.keys || []).map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])) }
  return jwks.keys
}
async function accessEmail(req) {
  const tok = req.headers['cf-access-jwt-assertion']
  if (typeof tok !== 'string') return null
  const [h, p, sig] = tok.split('.')
  if (!sig) return null
  try {
    const head = JSON.parse(Buffer.from(h, 'base64url')); const body = JSON.parse(Buffer.from(p, 'base64url'))
    const key = (await accessKeys()).get(head.kid)
    if (!key || head.alg !== 'RS256') return null
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) return null
    const aud = Array.isArray(body.aud) ? body.aud : [body.aud]
    const now = Date.now() / 1000
    if (!aud.includes(ACCESS_AUD) || body.exp < now || (body.nbf && body.nbf > now + 60) || body.iss !== `https://${ACCESS_TEAM}`) return null
    return typeof body.email === 'string' ? body.email : null
  } catch { return null }
}

// Self-identification: the visitor picks a name (cookie board_user). Lead and system names are reserved, so a human
// can never post as a lead. A verified Access login, when configured, always wins.
const RESERVED = new Set([...ROLES, 'setup', 'wake', 'watchdog', 'smoke', 'ui', 'beads', 'system', 'admin', 'brain'])
function cookieUser(req) {
  const m = /(?:^|;\s*)board_user=([^;]*)/.exec(req.headers.cookie || '')
  const name = m ? decodeURIComponent(m[1]).trim().toLowerCase() : ''
  return validName(name) ? name : null
}
const validName = (n) => /^[a-z][a-z0-9._-]{1,31}$/.test(n) && !RESERVED.has(n) && !RESERVED.has(n.split('/')[0])
function whoSource(req) {
  if (req.gateway) return 'gateway'
  if (req.accessEmail) return 'access'
  if (cookieUser(req)) return 'self'
  return 'default'
}

function who(req) {
  if (req.gateway) return req.gateway.u // the public side: only the gateway's signed assertion says who
  if (req.accessEmail) return req.accessEmail.split('@')[0]
  const self = cookieUser(req)
  if (self) return self
  const email = TRUST_ACCESS && req.headers[ACCESS_HEADER]
  return typeof email === 'string' && email ? email.split('@')[0] : ACTOR
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

async function proxy(req, res, apiPath, search) {
  if (!ALLOW.some(([m, re]) => m === req.method && re.test(apiPath))) {
    return send(res, 403, { title: 'Not allowed from the board', path: apiPath })
  }
  let body
  if (req.method !== 'GET') {
    let data = {}
    try { data = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, { title: 'Bad JSON' }) }
    const actor = who(req)
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
        const workerRole = ROLE_DEFS.find((r) => r.workers)?.id || 'code'
        for (const a of list) {
          const cwd = String(a.cwd || '').replace(/^~(?=\/|$)/, HOME_DIR)
          if (cwd !== ROOT && !cwd.startsWith(ROOT + '/')) continue
          const rel = cwd.slice(ROOT.length + 1)
          const info = { id: a.shortId || a.id, name: a.name, status: a.status, provider: a.provider, thinking: a.thinking, cwd: a.cwd, created: a.created }
          let m
          if ((m = /^leads\/([\w-]+)$/.exec(rel)) && m[1] in data && !data[m[1]]) data[m[1]] = info
          else if (rel === 'setup' && !data.setup) data.setup = info
          else if ((m = /^worktrees\/w-(.+)$/.exec(rel))) data._workers.push({ id: info.id, role: workerRole, status: a.status, item: m[1] })
        }
        agents = { at: Date.now(), data }
      }
    } catch {}
    setTimeout(pollAgents, 4000)
  })
}
pollAgents()
async function leads() {
  for (let i = 0; !agents.data && i < 50; i++) await new Promise((r) => setTimeout(r, 100)) // first poll only
  return agents.data || Object.fromEntries([...ROLES, 'setup'].map((r) => [r, null]))
}

// From the Beads event journal: who created each item (bd serve leaves created_by empty) and the last comment.
const meta = { seq: 0, creators: {}, last: {}, lastAct: {} }
async function refreshMeta() {
  for (;;) {
    const r = await fetch(new URL(`/v0/beads/events?since=${meta.seq}&limit=500`, BD), { minMs: 1000 }).then((x) => x.json())
    const recs = r.records || []
    for (const e of recs) {
      meta.seq = Math.max(meta.seq, e.seq)
      if (e.op === 'create' && e.actor && !meta.creators[e.issue_id]) meta.creators[e.issue_id] = e.actor
      if (e.op === 'comment' && e.comment) meta.last[e.issue_id] = { author: e.comment.author, at: e.comment.created_at || e.ts }
      if (e.actor) meta.lastAct[e.actor] = { item: e.issue_id, at: e.ts }
    }
    if (recs.length < 500) break
  }
}
async function sendMeta(res) {
  try {
    const [l] = await Promise.all([leads(), refreshMeta()])
    let personas = null
    try { personas = JSON.parse(readText('leads/personas.json') || 'null') } catch {}
    let raci = null
    try { raci = JSON.parse(readText('leads/raci.json') || 'null') } catch {}
    send(res, 200, { project: PROJECT, leads: l, creators: meta.creators, last: meta.last, personas, roles: ROLE_DEFS, raci, panels: PANELS })
  } catch (e) { send(res, 502, { title: 'meta failed', detail: e.message }) }
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
async function sendProjectItem(req, res) {
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
    return { role, cwd: dir, agent: l[role], layers, start: start.replaceAll('{role}', role).replaceAll('{project}', PROJECT), startTemplate: start,
      skills, permissions, settingsPath: `${dir}/.claude/settings.tmpl.json`, settingsRaw }
  })
  const setup = { role: 'setup', cwd: 'setup', agent: l.setup,
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

async function sendContent(res, id) {
  if (!ID_RE.test(id)) return send(res, 400, { title: 'bad id' })
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

// Workers on an item: Paseo agents labelled item=<id> (role=<role>-worker) (archived too), their branch's unlanded
// commits, and the tail of their activity. Humans may watch workers; the code lead may not (it reads only reports).
async function sendWorkers(res, id) {
  if (!ID_RE.test(id)) return send(res, 400, { title: 'bad id' })
  const run = (cmd, args, timeout = 15000) => new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (e, out) => ok(e ? '' : out)))
  let list = []
  try { list = await P_.list({ project: PROJECT, item: id }, { archived: true }) } catch {}
  const branch = `w-${id}`
  const has = (await run('git', ['-C', CODE, 'rev-parse', '--verify', '--quiet', branch])).trim()
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
      const tail = (id) => new Promise((ok) => execFile(PASEO, ['logs', id], { timeout: 8000, maxBuffer: 16 << 20, minMs: 2000 }, (e, out) => {
        const lines = (e ? '' : out).split('\n').filter((x) => x.trim())
        ok(lines[lines.length - 1] || '')
      }))
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
    if (c.h !== host || !(c.exp > Date.now()) || !['owner', 'member', 'viewer'].includes(c.r) || !validGatewayName(c.u)) return null
    return c
  } catch { return null }
}
const validGatewayName = (n) => typeof n === 'string' && /^[a-z][a-z0-9._-]{1,31}$/.test(n)
const SIGN_IN = '<!doctype html><meta charset="utf-8"><title>Sign in</title><p>Sign in through the gateway: open this board\'s address again.</p>'
async function handlePublic(req, res) {
  const c = assertion(req)
  if (!c) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(SIGN_IN) }
  req.gateway = c
  if (c.r === 'viewer' && !['GET', 'HEAD'].includes(req.method)) return send(res, 403, { title: 'Viewers can look, not change: ask the owner for member access.' })
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/whoami' && req.method === 'POST') return send(res, 403, { title: 'Your name comes from your sign-in.' })
  return handle(req, res)
}

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
  if (ACCESS_TEAM && ACCESS_AUD) {
    req.accessEmail = await accessEmail(req)
    if (!req.accessEmail) return send(res, 403, { title: 'Cloudflare Access login required' })
  }
  const url = new URL(req.url || '/', 'http://x')
  if (/^\/api\/(config|skills|leads)\//.test(url.pathname)) {
    cfg ||= configApi({ ROOT, ROLES, PROJECT, PASEO, BD, send, readBody, who })
    if (await cfg(req, res, url)) return
  }
  if (url.pathname === '/api/whoami' && req.method === 'GET') return send(res, 200, { actor: who(req), source: whoSource(req) })
  if (url.pathname === '/api/whoami' && req.method === 'POST') {
    let name = ''
    try { name = String(JSON.parse(await readBody(req)).name || '').trim().toLowerCase() } catch {}
    if (!validName(name)) return send(res, 400, { title: 'Pick 2–32 characters: a-z, 0-9, . _ -, starting with a letter. Lead and system names are taken.' })
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    res.setHeader('set-cookie', `board_user=${encodeURIComponent(name)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`)
    return send(res, 200, { actor: name, source: 'self' })
  }
  if (url.pathname === '/api/meta' && req.method === 'GET') return sendMeta(res)
  if (url.pathname === '/api/links' && req.method === 'GET') return sendLinks(res)
  if (url.pathname === '/api/mermaid' && req.method === 'POST') return sendMermaid(req, res, url).catch((e) => send(res, 500, { error: e.message }))
  if (url.pathname === '/api/presence' && req.method === 'GET') return sendPresence(res)
  const wm = /^\/api\/workers\/([\w.-]+)$/.exec(url.pathname)
  if (wm && req.method === 'GET') return sendWorkers(res, wm[1]).catch((e) => send(res, 500, { title: e.message }))
  const cm = /^\/api\/content\/([\w.-]+)$/.exec(url.pathname)
  if (cm && req.method === 'GET') return sendContent(res, cm[1]).catch((e) => send(res, 500, { title: e.message }))
  if (url.pathname.startsWith('/files/') && req.method === 'GET') return sendFile(res, decodeURIComponent(url.pathname.slice(7)), url.searchParams.get('rev'), url.searchParams.get('annotate') === '1')
  if (PANELS.includes('machine') && url.pathname === '/api/machine' && req.method === 'GET') return sendMachine(res).catch((e) => send(res, 502, { title: e.message }))
  if (PANELS.includes('machine') && url.pathname === '/api/project-item' && req.method === 'POST') return sendProjectItem(req, res).catch((e) => send(res, 500, { title: e.message }))
  if (url.pathname === '/api/settings' && req.method === 'GET') return sendSettings(res).catch((e) => send(res, 500, { title: e.message }))
  if (url.pathname.startsWith('/api/')) return proxy(req, res, url.pathname.slice(4), url.search)
  serveFile(res, url.pathname)
}
