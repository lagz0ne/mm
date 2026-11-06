// mm.api: the project API for boxes (sy-b15.8; docs/project-api.md). Inside a box, Paseo's permission prompts are not
// the boundary (the box's agents can answer their own), so every action that matters for a box is a call here, and it
// is decided on the host, by the owner, never from inside the box and never by a label.
//
//   The way in: one Unix socket per box, $MM_HOME/box/<project>/api/api.sock (made here for each box in pc/boxes).
//   Only that box mounts the folder, read-only, at /run/mm/api. The project is the socket the call came in on, never a
//   name in the call (review sy-b15.8 5). No TCP port. Four calls, each with one field in a fixed format:
//     POST /route   {"name": "<a-z0-9->"}   a public route <name>.<project>.<domain> to the box's app slot
//     POST /egress  {"site": "<host name>"}  an exact site on the box's egress list
//     POST /release {"build": "<folder>"}    the build in release/<build>/ on the box's app slot
//     POST /secret  {"name": "<a-z0-9->"}   a NEW secret <project>.<name> in the vault; never a value
//   The box gets back only a status (pending, done, refused) and the request's and its item's ids.
//   And one more, decided by rules, not by the owner: /person-run (src/boxruns.ts, sy-9618), a lead's run for one person
//   of the box's project on their own token, while wake.person_runs is on (mm.api runs for it alone too; then the four
//   calls are refused).
//   Each new request files an item on the system board, the box's value shown as data in a frame mm writes.
//
//   The decision: only through the owner's approve socket, $MM_HOME/api/approve.sock (0600 in a 0700 folder; the
//   bridge's Allow tap calls it, and `mm api approve <id>` in the owner's own terminal). Every agent session is denied it
//   (the template's rendered denies; the guard is ops'). An approval names the request and its hash, sha256 of
//   [project, call, value]: mm applies exactly that request, checks its format again, and posts the undo on the item.
//   An egress site also needs review's sign-off on the item first (`signed-off`), then the owner's tap.
//   The one-time code (sy-35f2): the hash is printed in the item, and every host session runs as the same user, so the
//   hash alone doesn't show that the owner decided. Each request gets a random code, sent only to the owner on Telegram
//   (in the text and in the Allow button), kept here only as a slow hash. An approval needs the code too: a wrong one
//   counts (5, then the code is void and `mm api code <id>` sends a new one), a used one never works again.
//
//   The store: $MM_HOME/api/ (0700): api.db (0600: requests, calls), granted/<project>.json (src/apistate.ts).
import { Database } from 'bun:sqlite'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'bun'
import { API_DIR, APPROVE_SOCK, apiEnabled, apiSocket, apiSocketDir, type Call, CALLS, FIELD, formatOk, granted, grantedProjects, PROJECT_ID, saveGranted } from './apistate'
import * as boxRuns from './boxruns'
import { gatewayHost, hostClaims } from './auth'
import { boxRoute } from './names'
import { appReload, egressList, egressReload } from './box'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, run, toolPath } from './env'
import { expand, machineInputs } from './inputs'
import { readAnswers, routeRm, routeTool, routeUp } from './project'
import * as vault from './vault'

const RATE = Number(process.env.MM_API_RATE) || 10        // new calls an hour, per box (refused ones count too)
const OPEN_MAX = 5                                         // open requests per box
const REPEAT_RATE = 120                                    // asking again for the same thing (its status), an hour
const SYNC_MS = Number(process.env.MM_API_SYNC_MS) || 5000
const now = () => Date.now()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export const hashOf = (project: string, call: string, value: string) => sha(JSON.stringify([project, call, value]))
const log = (level: string, msg: string, attrs: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, project: 'mm', service: 'api', ...attrs }))

type Req = { id: string; project: string; call: Call; value: string; hash: string; status: 'pending' | 'done' | 'refused' | 'failed' | 'undone'
  item: string; created: number; decided: number | null; by: string | null; detail: string | null; open: number
  code: string | null; code_exp: number | null; code_tries: number; codes: number }

// ---------- the one-time code (sy-35f2): random, to the owner on Telegram only, kept as a slow hash ----------
const CODE_TTL = 86400e3   // valid until the request is decided, or 24 h
const CODE_TRIES = 5       // wrong tries, then the code is void
const CODE_MAX = 5         // codes per request (the first and 4 new ones)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** 8 base32 characters: 40 random bits. */
function newCode(): string {
  const b = randomBytes(5); let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  let s = ''; for (let i = 7; i >= 0; i--) s += B32[Number((n >> BigInt(i * 5)) & 31n)]
  return s
}
/** What the owner typed: case and spaces or dashes don't matter. */
export const normCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '')
const CODE_RE = /^[A-Z2-7]{8}$/
const slow = (code: string, salt: Buffer) => scryptSync(code, salt, 32, { N: 16384, r: 8, p: 1 })
const sealCode = (code: string) => { const salt = randomBytes(16); return `scrypt:${salt.toString('hex')}:${slow(code, salt).toString('hex')}` }
function codeOk(code: string, sealed: string): boolean {
  const [k, s, h] = sealed.split(':')
  if (k !== 'scrypt' || !s || !h || !CODE_RE.test(code)) return false
  const want = Buffer.from(h, 'hex'), got = slow(code, Buffer.from(s, 'hex'))
  return want.length === got.length && timingSafeEqual(want, got)
}

// ---------- the store ----------
export function store(): Database {
  mkdirSync(API_DIR, { recursive: true, mode: 0o700 }); chmodSync(API_DIR, 0o700)
  const d = new Database(join(API_DIR, 'api.db'), { create: true })
  d.run('PRAGMA journal_mode = WAL'); d.run('PRAGMA busy_timeout = 5000')
  d.run(`CREATE TABLE IF NOT EXISTS request (id TEXT PRIMARY KEY, project TEXT NOT NULL, call TEXT NOT NULL, value TEXT NOT NULL, hash TEXT NOT NULL,
    status TEXT NOT NULL, item TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, decided INTEGER, by TEXT, detail TEXT, open INTEGER NOT NULL DEFAULT 0)`)
  d.run('CREATE INDEX IF NOT EXISTS request_ph ON request (project, hash)')
  // the one-time code's columns (sy-35f2), added to a store made before them: only its slow hash, never the code
  const cols = new Set((d.query('PRAGMA table_info(request)').all() as { name: string }[]).map((c) => c.name))
  for (const [c, t] of [['code', 'TEXT'], ['code_exp', 'INTEGER'], ['code_tries', 'INTEGER NOT NULL DEFAULT 0'], ['codes', 'INTEGER NOT NULL DEFAULT 0']])
    if (!cols.has(c)) d.run(`ALTER TABLE request ADD COLUMN ${c} ${t}`)
  d.run('CREATE TABLE IF NOT EXISTS calls (at INTEGER NOT NULL, project TEXT NOT NULL, call TEXT NOT NULL, outcome TEXT NOT NULL)')
  d.run('CREATE INDEX IF NOT EXISTS calls_pa ON calls (project, at)')
  for (const f of readdirSync(API_DIR)) { const p = join(API_DIR, f); try { if (lstatSync(p).isFile()) chmodSync(p, 0o600) } catch {} }
  return d
}

// ---------- the box's project, from the host's own registry (pc/boxes, which the host writes) ----------
export function boxRoot(project: string): string | null {
  if (!PROJECT_ID.test(project)) return null
  try {
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(DIRS.pc, 'boxes', `${project}.yaml`), 'utf8'))
    const root = m ? m[1].replace(/^~(?=\/)/, HOME) : ''
    return root && readAnswers(root).project === project ? root : null
  } catch { return null }
}
const domainOf = () => { const c = loadConfig(); return String(getPath(c, 'access') ?? '') === 'domain' ? String(getPath(c, 'domain') ?? '') : '' }
const appSpec = (root: string) => { try { return (Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { services?: Record<string, { secrets?: string[] }> }).services || {} } catch { return {} } }

/** Is this host someone else's already: a board's (the gateway's host map, sy-b15.17), another box's granted route, or
 *  a route the router has that this box was never granted? */
export function hostTaken(project: string, name: string, host: string): string | null {
  const { claims, hosts } = hostClaims()
  if (claims[host]) return `${host} is a board's (the gateway's host map)`
  // any project's other public service too (the app slot's open route, under names: project app.<project>), and the
  // gateway's own host (sy-b15.3)
  if (hosts[host]) return `${host} is ${[...hosts[host]].sort().join(', ')}'s public service`
  if (host === gatewayHost()) return `${host} is the sign-in gateway's host`
  // another box's granted route, behind the sign-in or open
  for (const p of grantedProjects()) if (p !== project && granted(p).routes.some((r) => r.host === host)) return `${host} is granted to another box`
  const root = boxRoot(project), tool = root ? routeTool(readAnswers(root)) : null
  if (tool && !granted(project).routes.some((r) => r.name === name)) {
    const ls = run([tool, 'ls'], { timeoutMs: 30_000 })
    if (ls.ok && ls.out.split('\n').some((l) => l.startsWith(`https://${boxRoute(project, name)}.`))) return `the router has a route ${boxRoute(project, name)} already`
  }
  return null
}
/** release/ and release/<build> are real folders in the project, not links (lstat; nothing is followed or read). */
function buildRefusal(root: string, build: string): string | null {
  const rel = join(root, 'release'), dir = join(rel, build)
  try {
    const a = lstatSync(rel); if (!a.isDirectory() || a.isSymbolicLink()) return 'release/ is not a folder'
    const b = lstatSync(dir); if (!b.isDirectory() || b.isSymbolicLink()) return `release/${build} is not a folder`
    if (realpathSync(dir) !== join(realpathSync(root), 'release', build)) return `release/${build} goes through a link`
  } catch { return `no release/${build}` }
  return null
}
/** Why a box may not ask for this secret name: it exists (sealed, declared, a machine input's name), or is granted. */
function secretRefusal(project: string, root: string, name: string): string | null {
  if (vault.sealed(vault.projectSecretName(project, name))) return 'exists'
  if (Object.keys(machineInputs()).includes(name)) return 'exists'
  let declared: string[] = []
  try { const s = JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8')); declared = [...(s.required || []), ...(s.optional || [])].map((x: { name: string }) => String(x.name).toLowerCase()) } catch {}
  declared.push(...Object.values(appSpec(root)).flatMap((x) => (x.secrets || []).map((y) => String(y).toLowerCase())))
  if (declared.includes(name)) return 'exists'
  return null
}

// ---------- the board (the system board; boxes can't write it) ----------
const BD = () => process.env.MM_API_BD || join(DIRS.system, 'bin', 'bd')
async function bd(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn([BD(), ...args, '--actor', 'watchdog'], { cwd: existsSync(DIRS.system) ? DIRS.system : undefined, env: { ...process.env, PATH: toolPath() }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const t = setTimeout(() => p.kill(), 30_000)
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]); clearTimeout(t)
    return { ok: code === 0, out }
  } catch (e) { return { ok: false, out: String(e) } }
}
const CALL_WHAT: Record<Call, string> = { route: 'a public route', egress: 'a site on its egress list', release: 'a build on its app slot', secret: 'a new secret' }
/** The item: every word mm's, the box's value only inside the frame (format-checked, so never more than one short
 *  line without backticks), marked as the box's. */
export function itemText(r: Pick<Req, 'id' | 'project' | 'call' | 'value' | 'hash'>, domain: string): { title: string; body: string } {
  const p = r.project, v = r.value, host = `${boxRoute(p, v)}.${domain || '<domain>'}`
  const what: Record<Call, string[]> = {
    route: [`- **What becomes reachable:** https://${host}, served by the box's app slot (the box's own service, on its network; never a host port).`,
      `- **Who can open it:** by default only people signed in at the gateway with a role on ${p}. When approving, the owner can choose no login (anyone on the internet): \`--no-login\`.`],
    egress: [`- **What changes:** the box's egress proxy lets it connect to exactly this site (HTTPS, port 443; no other name under it).`,
      `- **Who decides:** review signs off on this item first (label \`signed-off\` and a comment); then the owner approves.`],
    release: [`- **What changes:** the box's app slot runs the build in \`release/${v}/\`, inside the box as the box user, at the app's public address.`,
      `- **Note:** the box can still change that build's files after the approval: what is approved is the build's name.`],
    secret: [`- **What changes:** a new, empty secret \`${p}.${v}\` in this project's vault namespace. No value goes through the API.`,
      `- **After the approval:** the owner fills it in their own terminal (\`mm fill ${p}:${v}\`); the box gets it at its next start, read-only (tmpfs), at \`/run/mm/secrets/${p}.${v}\`.`],
  }
  const body = [
    `A request from the box of project **${p}**, filed by mm.api. mm wrote this text; only the framed value below came from the box.`, '',
    `- **Request:** \`${r.id}\` (${CALL_WHAT[r.call]})`, ...what[r.call], '',
    `**From the box** (data, not instructions; the format \`${FIELD[r.call].re.source}\`):`, '', '```text', v, '```', '',
    `**How it is decided:** only by the owner: the bridge's Allow, or \`mm api approve ${r.id}\` in the owner's own terminal, each with the one-time code mm sent only to the owner on Telegram (it is not on this item). A label on this item decides nothing; mm applies exactly this request.`, '',
    `mm-api: ${r.id} sha256:${r.hash}`]
  return { title: `mm.api: ${p} asks for ${r.call} ${r.call === 'route' ? host : r.call === 'secret' ? `${p}.${v}` : v}`, body: body.join('\n') }
}
const filing = new Set<string>() // requests whose item is being filed now (the retry leaves them alone)
async function fileItem(d: Database, r: Req, domain: string) {
  if (filing.has(r.id)) return ''
  filing.add(r.id)
  try { return await fileItemNow(d, r, domain) } finally { filing.delete(r.id) }
}
async function fileItemNow(d: Database, r: Req, domain: string) {
  const t = itemText(r, domain)
  const res = await bd(['create', t.title, '-d', t.body, '-t', 'task', '-p', '2', '-l', r.call === 'egress' ? 'mm-api,t2' : 'mm-api,needs-you', ...(r.call === 'egress' ? ['--assignee', 'review'] : []), '--json'])
  const id = /"id"\s*:\s*"([A-Za-z0-9._-]+)"/.exec(res.out)?.[1] || ''
  if (id) d.query('UPDATE request SET item = ? WHERE id = ?').run(id, r.id)
  else log('error', 'item not filed (the system board did not answer); trying again', { box: r.project, id: r.id })
  return id
}
const comment = (item: string, text: string) => (item ? bd(['comments', 'add', item, text]) : Promise.resolve({ ok: false, out: '' }))
async function labels(item: string): Promise<string[]> {
  if (!item) return []
  const r = await bd(['show', item, '--json'])
  try { const j = JSON.parse(r.out); const i = Array.isArray(j) ? j[0] : j; return Array.isArray(i?.labels) ? i.labels.map(String) : [] } catch { return [] }
}

// ---------- the owner hears every request and every change, with the undo (as mm.auth does) ----------
// A request's one-time code goes only into this message (its text and its Allow buttons, for the bridge): what is
// logged is the notice without it. The bridge's contract is in docs/project-api.md ("The bridge").
type CodeNotice = { id: string; hash: string; code: string; route: boolean }
function tellOwner(text: string, c?: CodeNotice) {
  const chat = String(getPath(loadConfig(), 'telegram.owner_id') ?? ''), tf = expand(String(machineInputs()['telegram-bot-token']?.path || ''))
  let token = ''; try { token = readFileSync(tf, 'utf8').trim() } catch {}
  const attrs = c ? { notice: text, id: c.id, code: 'sent to the owner only' } : { notice: text }
  if (!chat || !token) { log('warn', 'owner not told (no Telegram bot token or owner id)', c ? { ...attrs, code: `not sent: mm api code ${c.id} once Telegram is set up` } : attrs); return }
  const msg: Record<string, unknown> = { chat_id: chat, text: `mm: ${text}` }
  if (c) {
    msg.text = `mm: ${text}\n\nCode: ${c.code} (for ${c.id} only, once, valid 24 h; never type it into an agent's chat)\n\nmm-api: ${c.id} sha256:${c.hash}`
    msg.reply_markup = { inline_keyboard: [[{ text: 'Allow', callback_data: `mmapi:allow:${c.id}:${c.code}` },
      ...(c.route ? [{ text: 'Allow, no login', callback_data: `mmapi:open:${c.id}:${c.code}` }] : []), { text: 'Deny', callback_data: `mmapi:deny:${c.id}` }]] }
  }
  fetch(`${process.env.MM_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(msg), signal: AbortSignal.timeout(10000) })
    .then((r) => log(r.ok ? 'info' : 'warn', r.ok ? 'owner told' : 'owner not told', attrs)).catch(() => log('warn', 'owner not told', attrs))
}

// ---------- applying an approved request, and undoing it ----------
type Applied = { ok: boolean; detail: string }
function apply(r: Req, open: boolean): Applied {
  const root = boxRoot(r.project)
  if (!root) return { ok: false, detail: `${r.project} is not a registered box now` }
  const a = readAnswers(root), g = granted(r.project), steps: { status: string; detail: string }[] = []
  if (r.call === 'route') {
    const domain = domainOf(); if (!domain) return { ok: false, detail: 'this machine has no domain (access: domain)' }
    const host = `${boxRoute(r.project, r.value)}.${domain}`, taken = hostTaken(r.project, r.value, host)
    if (taken) return { ok: false, detail: taken }
    g.routes = [...g.routes.filter((x) => x.name !== r.value), { name: r.value, host, open, id: r.id }]; saveGranted(r.project, g)
    // to the app slot's public port (the box's own service, forwarded from the host to the box's address)
    let port: number | undefined
    try { port = (JSON.parse(readFileSync(join(DIRS.mm, 'box', r.project, 'ports.json'), 'utf8')).services?.app?.public_port) as number | undefined } catch {}
    if (port && Number.isInteger(port)) steps.push(routeUp(a, boxRoute(r.project, r.value), port, !open, `https://${host}`))
    else steps.push({ status: 'skip', detail: 'the box has no app slot running yet: the route is written when it runs (mm up)' })
    return { ok: !steps.some((s) => s.status === 'fail'), detail: `https://${host} ${open ? 'with no login (the owner chose it)' : 'behind the sign-in'}: ${steps.map((s) => s.detail).join('; ')}` }
  }
  if (r.call === 'egress') {
    g.egress = [...g.egress.filter((x) => x.site !== r.value), { site: r.value, id: r.id }]; saveGranted(r.project, g)
    const s = egressReload(root)
    return { ok: s.status !== 'fail', detail: `${r.value} on the egress list (${egressList(root).length} names): ${s.detail}` }
  }
  if (r.call === 'release') {
    const why = buildRefusal(root, r.value); if (why) return { ok: false, detail: why }
    g.release = { build: r.value, id: r.id }; saveGranted(r.project, g)
    const st = appReload(root)
    return { ok: !st.some((s) => s.status === 'fail'), detail: `release/${r.value} on the app slot: ${st.map((s) => s.detail).join('; ')}` }
  }
  const why = secretRefusal(r.project, root, r.value); if (why) return { ok: false, detail: `${r.project}.${r.value} ${why}` }
  g.secrets = [...g.secrets.filter((x) => x.name !== r.value), { name: r.value, id: r.id }]; saveGranted(r.project, g)
  return { ok: true, detail: `${r.project}.${r.value} may be filled now: mm fill ${r.project}:${r.value} (in your own terminal). The box gets it at its next start (mm up ${a.client}/${a.name})` }
}
function undo(r: Req): Applied {
  const root = boxRoot(r.project), g = granted(r.project)
  if (r.call === 'route') {
    g.routes = g.routes.filter((x) => x.id !== r.id); saveGranted(r.project, g)
    const s = root ? routeRm(readAnswers(root), boxRoute(r.project, r.value)) : { status: 'skip', detail: 'not a box now' }
    return { ok: s.status !== 'fail', detail: `route ${boxRoute(r.project, r.value)} removed: ${s.detail}` }
  }
  if (r.call === 'egress') {
    g.egress = g.egress.filter((x) => x.id !== r.id); saveGranted(r.project, g)
    const s = root ? egressReload(root) : { status: 'skip', detail: 'not a box now' }
    return { ok: s.status !== 'fail', detail: `${r.value} off the egress list: ${s.detail}` }
  }
  if (r.call === 'release') {
    if (g.release?.id === r.id) { g.release = null; saveGranted(r.project, g) }
    const st = root ? appReload(root) : []
    return { ok: !st.some((s) => s.status === 'fail'), detail: `release/${r.value} off the app slot (no build runs there until the owner approves one): ${st.map((s) => s.detail).join('; ') || 'not a box now'}` }
  }
  g.secrets = g.secrets.filter((x) => x.id !== r.id); saveGranted(r.project, g)
  return { ok: true, detail: `${r.project}.${r.value}: the box no longer gets it from its next start (the sealed value stays in the vault)` }
}

// ---------- the service ----------
export async function serve() {
  const d = store()
  const find = (id: string) => (d.query('SELECT * FROM request WHERE id = ? OR (item != \'\' AND item = ?)').get(id, id) as Req | null)
  const count = (project: string, since: number, outcomes: string) => (d.query(`SELECT COUNT(*) AS n FROM calls WHERE project = ? AND at >= ? AND outcome ${outcomes}`).get(project, since) as { n: number }).n
  const record = (project: string, call: string, outcome: string) => d.query('INSERT INTO calls (at, project, call, outcome) VALUES (?, ?, ?, ?)').run(now(), project, call, outcome)
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  // what the box sees: a status, the request's id and its item's id; why only as one fixed word
  const answer = (status: 'pending' | 'done' | 'refused', http: number, o: { id?: string; item?: string; why?: string } = {}) => json({ status, ...o }, http)
  const shown = (r: Req) => (r.status === 'pending' ? 'pending' : r.status === 'done' ? 'done' : 'refused') as 'pending' | 'done' | 'refused'
  /** A new one-time code for a pending request: its slow hash in the store, the code itself only in the owner's message. */
  const issueCode = (r: Req, notice: string): boolean => {
    if (r.codes >= CODE_MAX) return false
    const code = newCode()
    d.query('UPDATE request SET code = ?, code_exp = ?, code_tries = 0, codes = codes + 1 WHERE id = ?').run(sealCode(code), now() + CODE_TTL, r.id)
    tellOwner(notice, { id: r.id, hash: r.hash, code, route: r.call === 'route' })
    return true
  }

  async function boxCall(req: Request, project: string, server?: Server<undefined>): Promise<Response> {
    const call = new URL(req.url).pathname.replace(/^\/+/, '')
    const hour = now() - 3600e3
    // a run for one person of the box's project, on their own token (sy-9618, src/boxruns.ts): its own rules and limits
    if (call === boxRuns.CALL) return boxRuns.handle(req, project, boxRoot(project), server, log)
    const known = (CALLS as readonly string[]).includes(call)
    // mm.api also runs for person runs alone (wake.person_runs): then the four calls are off, as with no mm.api
    if (known && !apiEnabled()) { log('warn', 'call refused: the project API is off', { box: project, call }); return answer('refused', 403, { why: 'api-off' }) }
    if (req.method !== 'POST' || !known) {
      record(project, 'unknown', 'refused'); log('warn', 'call refused: not one of the four', { box: project, method: req.method, call: call.slice(0, 40) })
      return answer('refused', 404, { why: 'unknown-call' })
    }
    const c = call as Call
    let body: Record<string, unknown> = {}
    try { const j = await req.json(); if (j && typeof j === 'object' && !Array.isArray(j)) body = j as Record<string, unknown> } catch {}
    // only this call's one field is read; a project named in the body is never looked at (the socket names it)
    const raw = body[FIELD[c].key], value = typeof raw === 'string' ? raw : ''
    if (count(project, hour, "!= 'repeat'") >= RATE) {
      record(project, c, 'limited'); log('warn', 'call refused: rate limit', { box: project, call: c, limit: RATE })
      return answer('refused', 429, { why: 'rate' })
    }
    if (!formatOk(c, value)) {
      record(project, c, 'format'); log('warn', 'call refused: format', { box: project, call: c, value_len: value.length })
      return answer('refused', 400, { why: 'format' })
    }
    const root = boxRoot(project)
    if (!root) { record(project, c, 'refused'); log('error', 'call refused: the socket\'s box is not registered', { box: project, call: c }); return answer('refused', 403, { why: 'no-box' }) }
    const g = granted(project), domain = domainOf()
    const refuse = (why: string, detail: string) => { record(project, c, 'refused'); log('warn', 'call refused', { box: project, call: c, value, why: detail }); return answer('refused', 403, { why }) }
    // already granted: done, nothing new filed
    const had = c === 'route' ? g.routes.find((x) => x.name === value)?.id : c === 'egress' ? g.egress.find((x) => x.site === value)?.id || (egressList(root).includes(value) ? 'base' : undefined)
      : c === 'release' ? (g.release?.build === value ? g.release.id : undefined) : g.secrets.find((x) => x.name === value)?.id
    if (had) { record(project, c, 'repeat'); log('info', 'call: granted already', { box: project, call: c, value, id: had }); return answer('done', 200, { id: had }) }
    if (c === 'route') {
      if (!domain) return refuse('no-domain', 'this machine has no domain')
      const t = hostTaken(project, value, `${boxRoute(project, value)}.${domain}`); if (t) return refuse('taken', t)
    }
    if (c === 'release') {
      if (!appSpec(root).app) return refuse('no-app-slot', 'the project has no app slot (services.yaml: app)')
      const why = buildRefusal(root, value); if (why) return refuse('no-build', why)
    }
    if (c === 'secret') { const why = secretRefusal(project, root, value); if (why) return refuse(why, `${project}.${value} ${why}`) }
    // the same request again: its status (a box polls this way); no new item
    const hash = hashOf(project, c, value)
    const prev = d.query('SELECT * FROM request WHERE project = ? AND hash = ? AND (status = \'pending\' OR decided >= ?) ORDER BY created DESC LIMIT 1').get(project, hash, now() - 86400e3) as Req | null
    if (prev) {
      if (count(project, hour, "= 'repeat'") >= REPEAT_RATE) { record(project, c, 'limited'); return answer('refused', 429, { why: 'rate' }) }
      record(project, c, 'repeat'); return answer(shown(prev), prev.status === 'pending' ? 202 : 200, { id: prev.id, item: prev.item || undefined })
    }
    const open = (d.query('SELECT COUNT(*) AS n FROM request WHERE project = ? AND status = \'pending\'').get(project) as { n: number }).n
    if (open >= OPEN_MAX) return refuse('open-limit', `${open} requests open already`)
    let id = ''
    for (let i = 0; i < 5 && !id; i++) {
      const t = `r-${randomBytes(4).toString('hex')}`
      try { d.query('INSERT INTO request (id, project, call, value, hash, status, created) VALUES (?, ?, ?, ?, ?, \'pending\', ?)').run(t, project, c, value, hash, now()); id = t } catch {}
    }
    record(project, c, 'filed')
    const r = find(id)!
    const item = await fileItem(d, r, domain)
    log('info', 'call: request filed', { box: project, call: c, value, id, item: item || undefined, hash: hash.slice(0, 12) })
    issueCode(r, `the box of ${project} asks for ${c} ${value} (${item || 'item pending'}, ${id}). ${c === 'egress' ? 'Review signs off first; then approve' : 'Approve'}: tap Allow, or mm api approve ${id} in your own terminal and type the code`)
    return answer('pending', 202, { id, item: item || undefined })
  }

  // ---------- the owner's socket ----------
  // what the owner's socket shows of a request: never its code's hash, only whether a code works now
  const codeValid = (r: Req) => !!r.code && (r.code_exp ?? 0) > now()
  const owner = (r: Req) => ({ id: r.id, item: r.item, project: r.project, call: r.call, value: r.value, hash: r.hash, status: r.status, created: new Date(r.created).toISOString(),
    decided: r.decided ? new Date(r.decided).toISOString() : null, by: r.by, detail: r.detail, open: !!r.open,
    code: r.status !== 'pending' ? 'none' : codeValid(r) ? `valid until ${new Date(r.code_exp!).toISOString()}, ${CODE_TRIES - r.code_tries} tries left` : 'none valid (mm api code <id> sends a new one)',
    codes_left: Math.max(0, CODE_MAX - r.codes) })
  const tries: number[] = []
  async function ownerCall(req: Request): Promise<Response> {
    const u = new URL(req.url), b = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
    const by = String(b.by || 'cli').replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'cli'
    if (u.pathname === '/ls') return json((d.query('SELECT * FROM request WHERE status = \'pending\' OR created >= ? ORDER BY created DESC LIMIT 200').all(now() - 7 * 86400e3) as Req[]).map(owner))
    if (u.pathname === '/show') { const r = find(String(u.searchParams.get('id') || '')); return r ? json(owner(r)) : json({ error: 'no such request' }, 404) }
    if (req.method !== 'POST' || !['/approve', '/deny', '/undo', '/code'].includes(u.pathname)) return json({ error: 'unknown' }, 404)
    const t = now(); while (tries.length && t - tries[0] > 600e3) tries.shift(); tries.push(t)
    if (tries.length > 30) { log('warn', 'decisions limited', { by }); return json({ error: 'too many attempts; wait' }, 429) }
    const r = find(String(b.id || ''))
    if (!r) { log('warn', 'decision refused: no such request', { by }); return json({ error: 'no such request' }, 404) }
    // a decided request's code goes with the decision (valid until the request is decided)
    const decide = (status: Req['status'], detail: string, open = false) => d.query('UPDATE request SET status = ?, decided = ?, by = ?, detail = ?, open = ?, code = NULL WHERE id = ?').run(status, now(), by, detail.slice(0, 1000), open ? 1 : 0, r.id)
    if (u.pathname === '/code') {
      // a new code, to the owner on Telegram only (the old one stops working): it shows nobody the code
      if (r.status !== 'pending') return json({ error: `${r.id} is ${r.status}, not pending` }, 409)
      if (!issueCode(r, `a new code for ${r.id} (${r.item || 'no item yet'}): the box of ${r.project} asks for ${r.call} ${r.value}. The code before this one no longer works`)) {
        log('warn', 'new code refused: the request had its codes', { box: r.project, id: r.id, by, codes: r.codes })
        return json({ error: `${r.id} had ${CODE_MAX} codes already: deny it; the box may ask again` }, 429)
      }
      log('info', 'new code sent to the owner', { box: r.project, id: r.id, by })
      return json({ ok: true, id: r.id, sent: 'to the owner on Telegram' })
    }
    if (u.pathname === '/deny') {
      if (r.status !== 'pending') return json({ error: `${r.id} is ${r.status}, not pending` }, 409)
      decide('refused', `refused by the owner${b.why ? `: ${String(b.why).slice(0, 200)}` : ''}`)
      log('info', 'request refused', { box: r.project, call: r.call, value: r.value, id: r.id, by })
      await comment(r.item, `Refused by the owner (${by}). Nothing changed. The box sees: refused.`); if (r.item) await bd(['close', r.item, '--reason', 'refused by the owner (mm.api)'])
      return json({ ok: true, id: r.id, status: 'refused' })
    }
    if (u.pathname === '/undo') {
      if (r.status !== 'done') return json({ error: `${r.id} is ${r.status}: only a done request is undone` }, 409)
      const x = undo(r); decide(x.ok ? 'undone' : 'done', `undone by ${by}: ${x.detail}`, !!r.open)
      log(x.ok ? 'info' : 'error', x.ok ? 'request undone' : 'undo failed', { box: r.project, call: r.call, value: r.value, id: r.id, by, detail: x.detail })
      await comment(r.item, `${x.ok ? 'Undone' : 'Undo failed'} (${by}): ${x.detail}`); tellOwner(`${r.project}: ${r.call} ${r.value} ${x.ok ? 'undone' : 'undo FAILED'} (${r.id})`)
      return json({ ok: x.ok, id: r.id, detail: x.detail }, x.ok ? 200 : 500)
    }
    // approve: exactly this request (its hash), its format again, and for egress review's sign-off first
    if (r.status !== 'pending') return json({ error: `${r.id} is ${r.status}, not pending` }, 409)
    const hash = String(b.hash || '')
    if (hash !== r.hash || hash !== hashOf(r.project, r.call, r.value)) {
      log('warn', 'approval refused: it names another request', { box: r.project, id: r.id, by, hash: hash.slice(0, 12) })
      return json({ error: `that approval is not for ${r.id} (its hash differs): nothing applied` }, 409)
    }
    // the one-time code (sy-35f2): only the owner has it (Telegram). Wrong or missing: counts; at CODE_TRIES it is void.
    // Logged at warn, never with what was sent.
    if (!codeValid(r)) {
      log('warn', 'approval refused: no valid code (expired, void or never sent)', { box: r.project, id: r.id, by })
      return json({ error: `${r.id} has no valid code now: mm api code ${r.id} sends a new one to the owner. Nothing applied` }, 409)
    }
    if (!codeOk(normCode(typeof b.code === 'string' ? b.code : ''), r.code!)) {
      const n = r.code_tries + 1, voided = n >= CODE_TRIES
      d.query(`UPDATE request SET code_tries = ?${voided ? ', code = NULL' : ''} WHERE id = ?`).run(n, r.id)
      log('warn', 'approval refused: wrong code', { box: r.project, id: r.id, by, tries: n, ...(voided ? { code: 'void now' } : {}) })
      return json({ error: `wrong code for ${r.id}: nothing applied${voided ? `. ${CODE_TRIES} wrong tries: the code is void (mm api code ${r.id} sends a new one)` : ''}` }, 403)
    }
    if (!formatOk(r.call, r.value)) { decide('failed', 'the value does not pass its format now'); return json({ error: 'the value does not pass its format: nothing applied' }, 409) }
    const open = b.open === true
    if (open && r.call !== 'route') return json({ error: 'no login is a choice for a route only' }, 400)
    if (r.call === 'egress' && !(await labels(r.item)).includes('signed-off')) {
      // the code stays valid: the owner taps Allow again after review's sign-off
      log('warn', 'approval refused: review has not signed off', { box: r.project, id: r.id, item: r.item, by })
      return json({ error: `review has not signed off on ${r.item || r.id} yet (label signed-off): nothing applied; the code still works` }, 409)
    }
    // used once: taken before anything is applied (two taps at once: only one finds it)
    if (d.query('UPDATE request SET code = NULL WHERE id = ? AND code = ? AND status = \'pending\'').run(r.id, r.code!).changes !== 1) {
      log('warn', 'approval refused: the code was used already', { box: r.project, id: r.id, by })
      return json({ error: `${r.id}'s code was used already: nothing applied` }, 409)
    }
    let x: Applied
    try { x = apply(r, open) } catch (e) { x = { ok: false, detail: (e as Error).message } }
    decide(x.ok ? 'done' : 'failed', x.detail, open)
    log(x.ok ? 'info' : 'error', x.ok ? 'request applied' : 'apply failed', { box: r.project, call: r.call, value: r.value, id: r.id, by, open, detail: x.detail })
    await comment(r.item, x.ok ? `Approved by the owner (${by}) and applied by mm.api: ${x.detail}\n\nUndo: \`mm api undo ${r.id}\` (the owner's terminal).` : `Approved (${by}), but mm.api could not apply it: ${x.detail}. Nothing is granted; the box sees: refused.`)
    if (r.item && x.ok) { await bd(['label', 'add', r.item, 'approved']); await bd(['close', r.item, '--reason', 'applied by mm.api']) }
    tellOwner(`${r.project}: ${r.call} ${r.value} ${x.ok ? `applied (${r.id}). Undo: mm api undo ${r.id}` : `NOT applied: ${x.detail}`}`)
    return json({ ok: x.ok, id: r.id, status: x.ok ? 'done' : 'failed', detail: x.detail }, x.ok ? 200 : 500)
  }

  // the owner's socket: 0600 in the store's 0700 folder
  rmSync(APPROVE_SOCK, { force: true })
  Bun.serve({ unix: APPROVE_SOCK, maxRequestBodySize: 8192, fetch: (req) => ownerCall(req) }); chmodSync(APPROVE_SOCK, 0o600)
  // one socket per box (pc/boxes), kept in step with the registry; and items the board didn't take yet
  const servers = new Map<string, Server<undefined>>()
  const sync = async () => {
    const dir = join(DIRS.pc, 'boxes')
    // MM_API_ONLY: a test's mm.api on a live machine serves its own box only (test/box.sh), never the others' sockets
    const only = process.env.MM_API_ONLY
    const want = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).filter((p) => PROJECT_ID.test(p) && (!only || p === only)) : [])
    for (const [p, s] of servers) if (!want.has(p)) { s.stop(true); servers.delete(p); rmSync(apiSocket(p), { force: true }); log('info', 'socket closed', { box: p }) }
    for (const p of want) {
      if (servers.has(p)) continue
      const sock = apiSocket(p), sd = apiSocketDir(p); mkdirSync(sd, { recursive: true, mode: 0o750 }); chmodSync(sd, 0o750); rmSync(sock, { force: true })
      try {
        servers.set(p, Bun.serve({ unix: sock, maxRequestBodySize: 16384, fetch: (req, srv) => boxCall(req, p, srv) }))
        chmodSync(sock, 0o660) // the box's user has the owner's group (src/box.ts); only this box mounts the folder
        log('info', 'socket open', { box: p })
      } catch (e) { log('error', 'socket failed', { box: p, error: (e as Error).message }) }
    }
    for (const r of d.query('SELECT * FROM request WHERE status = \'pending\' AND item = \'\' AND created < ? LIMIT 10').all(now() - 30e3) as Req[]) await fileItem(d, r, domainOf())
    d.query('DELETE FROM calls WHERE at < ?').run(now() - 30 * 86400e3)
  }
  let busy = false
  const tick = () => { if (busy) return; busy = true; sync().catch((e) => log('error', 'sync failed', { error: (e as Error).message })).finally(() => { busy = false }) }
  tick(); setInterval(tick, SYNC_MS)
  log('info', 'mm.api up', { approve: APPROVE_SOCK, rate: RATE, open_max: OPEN_MAX })
  await new Promise(() => {})
}

/** Call the running mm.api's owner socket (mm api ls|show|approve|deny|undo). */
export async function callOwner(path: string, body?: Record<string, unknown>) {
  const r = await fetch(`http://api${path}`, { unix: APPROVE_SOCK, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined } as RequestInit)
  return { status: r.status, data: await r.json().catch(() => ({})) as Record<string, unknown> }
}
