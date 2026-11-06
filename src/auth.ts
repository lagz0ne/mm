// mm.auth: the accounts and the one sign-in for every board, on Better Auth (the owner, 2026-11-05, sy-nwp).
// People (admin plugin), projects = organizations with the roles designer/member/viewer (organization plugin), the
// login = a single-use link that mm prints (magic-link plugin; no mail, no password). One session on the gateway's
// host opens every board the person is granted: each board gets its own host-only cookie through a one-time callback
// (sy-p2i: no cookie on the parent domain). Tools use a bearer token bound to one project. Design: docs/auth-gateway.md.
//   HTTP (loopback, and bind_host for the web proxy in docker), on the gateway's host:
//     /api/auth/*                      Better Auth (the link's verify step sets the session, then /s/done)
//     GET  /s?b=<board host>&r=<path>  signed in -> the board's callback; else "ask the owner for a link"
//     GET  / , GET /s/done             the home page: the boards this person holds a role on, with each board's counts
//     POST /s/out                      ends the session (and its board sessions)
//   On a board host:
//     GET  /_mm/auth/callback?c=…      a one-time code -> that board's own cookie (mm_board, host-only, Strict)
//     GET  /verify                     forward-auth: the board cookie or `Authorization: Bearer` -> 200 + a signed
//                                      assertion (person, role, host, 60 s), or 302 to sign in
//   Socket ($MM_HOME/run/auth.sock, 0600): users, links, grants, tokens, sessions (`mm user|grant|revoke|token`).
// State: $MM_HOME/auth/ (0700): accounts.db (Better Auth + mm's tokens and board sessions), secret, signing.key (0600).
import { Database } from 'bun:sqlite'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { chmodSync, closeSync, constants as fsc, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { admin, bearer, magicLink, organization } from 'better-auth/plugins'
import { createAccessControl } from 'better-auth/plugins/access'
import { granted, grantedProjects } from './apistate'
import { getPath, loadConfig } from './config'
import { expand, machineInputs } from './inputs'
import { DIRS } from './env'
import { boxRoute, NAMES_MODES, type NamesMode, namesMode } from './names'
import { resolve } from './project'

export const AUTH_DIR = join(DIRS.mm, 'auth')
export const AUTH_SOCK = join(DIRS.mm, 'run', 'auth.sock')
// a sign-in link is a bearer link that may travel through chat apps: 1 h by default (review sy-b15.14), `--ttl` for more,
// up to the plugin's ceiling (each link's own row is set to its ttl after it is made)
const SESSION_S = 12 * 3600, BOARD_CODE_MS = 30e3, ASSERT_MS = 60e3, LINK_S = Number(process.env.MM_AUTH_LINK_S) || 3600, LINK_MAX_S = 7 * 86400, TOKEN_DAYS = 30
const CODE_MS = Number(process.env.MM_AUTH_CODE_MS) || 5 * 60e3, CODE_LINK_S = 120 // a code lives 5 min; its link 2 min
// designer = a member who also edits the project's Doop (the owner, 2026-11-05; plans/ui-access.md, doop.md)
const ROLES = ['owner', 'designer', 'member', 'viewer'] as const
type Role = typeof ROLES[number]
const guestRole = (r: unknown): Role => (r === 'viewer' ? 'viewer' : r === 'designer' ? 'designer' : 'member') // never owner
const emailOf = (name: string) => `${name}@users.mm.invalid` // Better Auth wants an email; mm never sends one

const h = (s: string) => createHash('sha256').update(s).digest('hex')
const short = (s: string) => h(s).slice(0, 6) // what logs carry instead of a token, cookie or session id
const now = () => Date.now()
const log = (level: string, msg: string, attrs: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, project: 'mm', service: 'auth', ...attrs }))

// ---------- the folder, the signing key (boards verify assertions with its public half) ----------
function ensureStore() {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 }); chmodSync(AUTH_DIR, 0o700)
  mkdirSync(dirname(AUTH_SOCK), { recursive: true, mode: 0o700 }); chmodSync(dirname(AUTH_SOCK), 0o700)
  signingKeyOnce(); fileOnce('secret', () => randomBytes(32).toString('base64url'))
  for (const f of readdirSync(AUTH_DIR)) { const p = join(AUTH_DIR, f); if ((statSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600) }
}
/** A file made once: the gateway and `mm up` (writing each board's public key) may both get here first; link() into
 *  place fails if it is already there, so there is only ever one, whoever made it. */
function fileOnce(name: string, make: () => string) {
  const k = join(AUTH_DIR, name)
  if (existsSync(k)) return
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 }); chmodSync(AUTH_DIR, 0o700)
  const t = `${k}.new-${process.pid}`
  writeFileSync(t, make(), { mode: 0o600 })
  try { linkSync(t, k) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e } finally { rmSync(t, { force: true }) }
}
const signingKeyOnce = () => fileOnce('signing.key', () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
/** The public key boards verify assertions with (PEM); mm writes it into each board's endpoints.json. With the
 *  gateway on, the key is made here if it isn't there yet, so a board started before the gateway still gets it. */
export function publicKeyPem(): string | null {
  const on = getPath(loadConfig(), 'auth.enabled')
  if (on === true || on === 'true') try { signingKeyOnce() } catch {}
  try { return createPublicKey(createPrivateKey(readFileSync(join(AUTH_DIR, 'signing.key'), 'utf8'))).export({ type: 'spki', format: 'pem' }) as string } catch { return null }
}

// ---------- Better Auth ----------
const ac = createAccessControl({ board: ['read', 'comment', 'steer'], doop: ['read', 'edit'] } as const)
const ORG_ROLES = {
  owner: ac.newRole({ board: ['read', 'comment', 'steer'], doop: ['read', 'edit'] }),
  designer: ac.newRole({ board: ['read', 'comment', 'steer'], doop: ['read', 'edit'] }),
  member: ac.newRole({ board: ['read', 'comment', 'steer'], doop: ['read'] }),
  viewer: ac.newRole({ board: ['read'], doop: ['read'] }),
}
function makeAuth(db: Database, authHost: string, links: Map<string, string>) {
  return betterAuth({
    baseURL: `https://${authHost}`, basePath: '/api/auth', secret: readFileSync(join(AUTH_DIR, 'secret'), 'utf8').trim(),
    telemetry: { enabled: false }, database: db, emailAndPassword: { enabled: false },
    session: { expiresIn: SESSION_S, updateAge: 3600 },
    // host-only cookies (no crossSubDomainCookies): the session lives on the gateway's host only (sy-p2i)
    // the client address comes only from mm (x-mm-client-ip, set by the gateway from a trusted proxy or the peer)
    advanced: { useSecureCookies: true, ipAddress: { ipAddressHeaders: ['x-mm-client-ip'] } },
    plugins: [
      admin(),
      organization({ ac, roles: ORG_ROLES, allowUserToCreateOrganization: false }),
      magicLink({ expiresIn: LINK_MAX_S, disableSignUp: true, sendMagicLink: async ({ email, url }) => { links.set(email, url) } }), // mm prints it
      bearer(),
    ],
  })
}
type Auth = ReturnType<typeof makeAuth>

// ---------- the host map: which project each public host belongs to ----------
const upstreamOf = (bind: string | undefined, port: number | undefined) => {
  if (!port) return ''
  const b = !bind || bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind
  return `http://${b.includes(':') ? `[${b}]` : b}:${port}`
}
/**
 * Every host a project claims: its boards (services with `public.auth: required`) with the address the router sends
 * them to, and the routes the owner granted a box behind the sign-in (src/api.ts; an open route is not the gateway's).
 * The host's projects and the project boxes (mm registers each box in pc/boxes). Never from <root>/.run/, which a box
 * can write (review sy-b15.17): the project is the registry file's name (the host writes pc/), and its public names
 * come from resolve() (services.yaml and .mm-answers.yaml, read-only in a box), as mm cron takes a box's jobs; a box's
 * routes from the host's own record of what the owner granted (never the box's files).
 */
export function hostClaims(names?: NamesMode): { claims: Record<string, Map<string, string>>; routes: Record<string, Set<string>>; odd: string[]; roots: Record<string, string>; hosts: Record<string, Set<string>> } {
  const claims: Record<string, Map<string, string>> = {}, routes: Record<string, Set<string>> = {}, odd: string[] = [], roots: Record<string, string> = {}
  const hosts: Record<string, Set<string>> = {} // every public host (a board's or an open one, e.g. the app slot) -> its projects
  const boxes = new Set<string>()
  for (const pdir of [join(DIRS.pc, 'projects'), join(DIRS.pc, 'boxes')]) for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith('.yaml')) : []) {
    const project = f.slice(0, -'.yaml'.length)
    if (pdir.endsWith('boxes')) boxes.add(project)
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(pdir, f), 'utf8')); if (!m) continue
    try {
      const root = m[1].replace(/^~(?=\/)/, process.env.HOME || ''), r = resolve(root, { names })
      if (r.answers.project !== project) { odd.push(`${f}: the project's answers name ${r.answers.project}`); continue }
      roots[project] = root
      for (const sv of Object.values(r.services)) {
        if (sv.public_url) (hosts[new URL(sv.public_url).host] ||= new Set()).add(project)
        if (sv.public_url && sv.public?.auth === 'required') (claims[new URL(sv.public_url).host] ||= new Map()).set(project, upstreamOf(sv.public_bind, sv.public_port))
      }
    } catch (e) { if (/names: project|config names/.test((e as Error).message)) odd.push(`${f}: ${(e as Error).message}`) }
  }
  for (const p of grantedProjects()) {
    if (!boxes.has(p)) continue // a project that is no box (any more) has no box routes
    for (const r of granted(p).routes) if (!r.open) (routes[r.host] ||= new Set()).add(p)
  }
  return { claims, routes, odd, roots, hosts }
}
/**
 * `mm names` (read-only, sy-b15.3): each registered project's public hosts under both rules, what is wrong under each
 * (nameClash), and the routes a switch from the machine's rule to the other adds and leaves behind. A box's granted
 * routes (<name>.<project>) are the same under both. Changes nothing.
 */
export function namesPlan() {
  const cfg = loadConfig(), domain = String(getPath(cfg, 'access') ?? '') === 'domain' ? String(getPath(cfg, 'domain') ?? '') : ''
  let now: NamesMode | 'invalid' = 'legacy', why = ''
  try { now = namesMode(cfg) } catch (e) { now = 'invalid'; why = (e as Error).message }
  const to: NamesMode = now === 'project' ? 'legacy' : 'project', from: NamesMode = now === 'project' ? 'project' : 'legacy'
  type Row = { project: string; service: string; legacy: string; project_mode: string; gate: string; port: number | null; note: string }
  const rows: Row[] = [], route: Record<NamesMode, Map<string, { port: number | null; gate: string }>> = { legacy: new Map(), project: new Map() }
  const { roots } = hostClaims('legacy')
  for (const [project, root] of Object.entries(roots).sort(([a], [b]) => a.localeCompare(b))) {
    const by: Partial<Record<NamesMode, ReturnType<typeof resolve>>> = {}, err: Partial<Record<NamesMode, string>> = {}, clash: Partial<Record<NamesMode, string>> = {}
    for (const m of NAMES_MODES) {
      try { by[m] = resolve(root, { names: m }) } catch (e) { err[m] = (e as Error).message; continue }
      try { const c = nameClash(root, m); if (c) clash[m] = c } catch (e) { clash[m] = (e as Error).message }
    }
    const services = new Set(NAMES_MODES.flatMap((m) => Object.entries(by[m]?.services || {}).filter(([, s]) => s.public_url).map(([n]) => n)))
    for (const n of [...services].sort()) {
      const host = (m: NamesMode) => { const u = by[m]?.services[n]?.public_url; return u ? new URL(u).host : err[m] ? '(refused)' : '-' }
      const s = (by.legacy || by.project)!.services[n], gate = s.public?.auth === 'required' ? 'sign-in' : 'open'
      for (const m of NAMES_MODES) { const x = by[m]?.services[n]; if (x?.public?.name) route[m].set(x.public.name, { port: x.public_port ?? null, gate }) }
      rows.push({ project, service: n, legacy: host('legacy'), project_mode: host('project'), gate, port: s.public_port ?? null,
        note: NAMES_MODES.flatMap((m) => (err[m] || clash[m] ? [`${m}: ${err[m] || clash[m]}`] : [])).join('; ') })
    }
    for (const g of granted(project).routes) {
      for (const m of NAMES_MODES) route[m].set(boxRoute(project, g.name), { port: null, gate: g.open ? 'open' : 'sign-in' })
      rows.push({ project, service: `route ${g.name}`, legacy: g.host, project_mode: g.host, gate: g.open ? 'open' : 'sign-in', port: null, note: 'granted to the box (the same under both)' })
    }
  }
  const add = [...route[to]].filter(([n]) => !route[from].has(n)).map(([name, r]) => ({ name, ...r }))
  const remove = [...route[from].keys()].filter((n) => !route[to].has(n))
  // a name two labels deep (<service>.<project>): the domain's DNS and certificate must cover *.<project>.<domain>
  const nested = [...new Set([...route[to].keys()].filter((n) => n.includes('.')).map((n) => n.slice(n.indexOf('.') + 1)))].sort()
  return { names: now, ...(why ? { invalid: why } : {}), domain, switch_to: to, rows, add, remove, nested }
}
/** The gateway's own sign-in host: never a project's. */
export const gatewayHost = (cfg = loadConfig()) => { const domain = String(getPath(cfg, 'domain') ?? ''); return String(getPath(cfg, 'auth_host') ?? (domain ? `auth.${domain}` : 'auth.localhost')) }
const sameDir = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b) } catch { return a === b } }
/**
 * Why this project's public hosts can't be its own, or null (sy-b15.3): two projects never get one host. A host is
 * refused when it is the gateway's, another project's (any public service, open or behind the sign-in), a route the
 * owner granted a box (src/api.ts), or one of its own services' twice; and a project id that another folder holds.
 * mm up and mm new ask before the project is registered, so a refused project never takes a board's host from the
 * gateway (which gives a host two projects claim to neither). `names`: under that rule instead of the machine's.
 */
export function nameClash(root: string, names?: NamesMode): string | null {
  const r = resolve(root, { names }), project = r.answers.project
  const mine = Object.entries(r.services).flatMap(([n, s]) => (s.public_url ? [[n, new URL(s.public_url).host] as const] : []))
  const { hosts, roots } = hostClaims(names)
  if (roots[project] && !sameDir(roots[project], root)) return `the project id ${project} is already ${roots[project]}'s`
  if (!mine.length) return null
  const gw = gatewayHost(), seen = new Map<string, string>()
  for (const [n, h] of mine) {
    if (seen.has(h)) return `${h} is both its ${seen.get(h)} and its ${n}`
    seen.set(h, n)
    if (h === gw) return `${h} (its ${n}) is the sign-in gateway's host`
    const others = [...(hosts[h] || [])].filter((p) => p !== project).sort()
    if (others.length) return `${h} (its ${n}) is ${others.join(', ')}'s already`
    for (const p of grantedProjects()) if (granted(p).routes.some((g) => g.host === h)) return `${h} (its ${n}) is a route the owner granted ${p === project ? 'its box' : `the box ${p}`}`
  }
  return null
}

// ---------- the gateway ----------
export async function gateway() {
  ensureStore()
  const key = createPrivateKey(readFileSync(join(AUTH_DIR, 'signing.key'), 'utf8'))
  const cfg = loadConfig()
  const authHost = gatewayHost(cfg)
  const ownerName = String(getPath(cfg, 'owner_name') ?? 'owner')
  // the owner hears every access change, on Telegram, in fixed text with the undo (review sy-b15.13 4): the same-user
  // limit stays (a process can still reach the socket), so this is the control that catches a change nobody asked for.
  // The bot token is read by path at send time, never logged (the URL carries it, so errors are logged without it).
  const tellOwner = (text: string) => {
    const chat = String(getPath(loadConfig(), 'telegram.owner_id') ?? ''), tf = expand(String(machineInputs()['telegram-bot-token']?.path || ''))
    let token = ''; try { token = readFileSync(tf, 'utf8').trim() } catch {}
    if (!chat || !token) { log('warn', 'owner not told (no Telegram bot token or owner id)', { notice: text }); return }
    const api = process.env.MM_TELEGRAM_API || 'https://api.telegram.org'
    fetch(`${api}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `mm: ${text}` }), signal: AbortSignal.timeout(10000) })
      .then((r) => log(r.ok ? 'info' : 'warn', r.ok ? 'owner told' : 'owner not told', { notice: text, ...(r.ok ? {} : { status: r.status }) }))
      .catch((e) => log('warn', 'owner not told', { notice: text, error: (e as Error).name }))
  }
  // the browser's address: CF-Connecting-IP only when the TCP peer is a trusted proxy (auth.trusted_proxies: the web
  // proxy's address, which takes it only from Cloudflare), else the peer itself (review sy-b15.14 4, sy-b15.7 2)
  const trusted = new Set(([] as string[]).concat(getPath(cfg, 'auth.trusted_proxies') as string[] || []).map(String))
  const clientIp = (req: Request, srv?: { requestIP?: (r: Request) => { address: string } | null }) => {
    const peer = (srv?.requestIP?.(req)?.address || '').replace(/^::ffff:/, '')
    const cf = req.headers.get('cf-connecting-ip')?.trim()
    return peer && trusted.has(peer) && cf ? cf : peer || 'unknown'
  }
  const db = new Database(join(AUTH_DIR, 'accounts.db'), { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  const links = new Map<string, string>()
  const auth: Auth = makeAuth(db, authHost, links)
  const { runMigrations } = await getMigrations(auth.options); await runMigrations()
  for (const f of readdirSync(AUTH_DIR)) { const p = join(AUTH_DIR, f); if ((statSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600) }
  const ctx = await auth.$context
  // mm's own: tool tokens (each for one project) and board sessions (each under its person's session)
  db.exec(`CREATE TABLE IF NOT EXISTS mm_token (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, project TEXT NOT NULL, label TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mm_board_session (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent TEXT NOT NULL, host TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)`)
  const boardCodes = new Map<string, { parent: string; userId: string; host: string; back: string; exp: number }>() // sha256(code) -> …
  // a sign-in by code (for the bridge): the page shows a short code, bound to that browser by a pending cookie; an
  // approve (socket) for a named person turns it into a 2-minute single-use link that only that browser receives
  type Pending = { code: string; board: string; back: string; created: number; ip: string; ua: string; link?: string; user?: string }
  const pending = new Map<string, Pending>()   // sha256(pending id) -> …
  const byCode = new Map<string, string>()      // sha256(code) -> sha256(pending id)
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U
  const newCode = () => { const r = randomBytes(8); let c = ''; for (let i = 0; i < 8; i++) c += ALPHABET[r[i] & 31]; return `${c.slice(0, 4)}-${c.slice(4)}` }
  const normCode = (c: string) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/^(.{4})(.{4})$/, '$1-$2')
  const hits = new Map<string, number[]>()
  const limited = (k: string, n: number, ms: number) => { const t = now(), a = (hits.get(k) || []).filter((x) => t - x < ms); a.push(t); hits.set(k, a); return a.length > n }
  setInterval(() => {
    const t = now()
    for (const [k, c] of boardCodes) if (c.exp < t) boardCodes.delete(k)
    for (const [k, p] of pending) if (t - p.created > CODE_MS) { pending.delete(k); byCode.delete(h(p.code)) }
    db.run('DELETE FROM mm_token WHERE expires < ?', [t]); db.run('DELETE FROM mm_board_session WHERE expires < ?', [t])
  }, 30e3).unref?.()

  // a board host -> its project (from where mm put each board's public name); cached briefly
  const HOST_CACHE_MS = Number(process.env.MM_AUTH_HOST_CACHE_MS) || 30e3 // the tests make it short
  // ups: a board host -> where the router sends it (the board's gated public side at public_bind:public_port, from
  // resolve(), as routeUp gives the router), so the home page asks each board at the address the host gave it
  // roles: a project -> its role ids (rolesAt(), for the home card's worst signal, sy-6h43)
  let hostMap: { at: number; map: Record<string, string>; hosts: Record<string, string>; ups: Record<string, string>; roles: Record<string, Set<string>>; said: string } = { at: 0, map: {}, hosts: {}, ups: {}, roles: {}, said: '' }
  const loadHosts = () => {
    if (now() - hostMap.at < HOST_CACHE_MS) return hostMap
    const map: Record<string, string> = {}, hosts: Record<string, string> = {}, ups: Record<string, string> = {}
    const { claims, routes, odd, roots } = hostClaims()
    const roles = Object.fromEntries(Object.entries(roots).map(([p, root]) => [p, rolesAt(root)]))
    // a host two projects claim goes to neither (no "last one wins"); a board's host is never also a box's route
    for (const [host, ps] of Object.entries(claims)) {
      if (ps.size > 1 || routes[host]) { odd.push(`${host}: claimed by ${[...new Set([...ps.keys(), ...(routes[host] || [])])].sort().join(', ')}`); continue }
      const [[p, up]] = ps; map[host] = p; hosts[p] ||= host; if (up) ups[host] = up
    }
    // a box's route the owner granted behind the sign-in (src/api.ts): forward-auth knows its project; it is no board,
    // so it gets no card on the home page
    for (const [host, ps] of Object.entries(routes)) {
      if (claims[host]) continue
      if (ps.size > 1) { odd.push(`${host}: claimed by ${[...ps].sort().join(', ')}`); continue }
      map[host] = [...ps][0]
    }
    const said = odd.sort().join('\n')
    if (said && said !== hostMap.said) log('warn', 'board hosts refused', { refused: odd })
    return (hostMap = { at: now(), map, hosts, ups, roles, said })
  }
  const projectOf = (host: string) => loadHosts().map[host] || null
  const userByName = (name: string) => db.query('SELECT * FROM user WHERE name = ?').get(name) as { id: string; name: string; role?: string; banned?: number } | null
  const userById = (id: string) => db.query('SELECT * FROM user WHERE id = ?').get(id) as { id: string; name: string; role?: string; banned?: number } | null
  const isOwner = (u: { role?: string } | null) => u?.role === 'admin'
  const orgOf = (project: string) => db.query('SELECT id FROM organization WHERE slug = ?').get(project) as { id: string } | null
  /** A person's role on a project, or null: the owner is owner everywhere; anyone else needs a membership. */
  const roleOn = (userId: string, project: string | null): Role | null => {
    const u = userById(userId); if (!u || u.banned || !project) return null
    if (isOwner(u)) return 'owner'
    const o = orgOf(project); if (!o) return null
    const m = db.query('SELECT role FROM member WHERE organizationId = ? AND userId = ?').get(o.id, userId) as { role: string } | null
    return m && ROLES.includes(m.role as Role) ? (m.role as Role) : null
  }
  const liveSession = (token: string) => db.query('SELECT id, userId, expiresAt FROM session WHERE token = ?').get(token) as { id: string; userId: string; expiresAt: number | string } | null
  const alive = (s: { expiresAt: number | string } | null) => !!s && new Date(s.expiresAt).getTime() > now()
  const cookies = (req: Request) => Object.fromEntries((req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))] }))
  const secure = (req: Request) => (req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:' ? '; Secure' : '')
  const setCookie = (req: Request, name: string, value: string, maxAgeMs: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure(req)}`
  // the pending cookie is Lax: the page that holds the code may be opened from a chat (a cross-site link)
  const setPendingCookie = (req: Request, id: string) => `mm_pending=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CODE_MS / 1000)}${secure(req)}`
  const headers = { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers, ...extra } })
  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
  const signAssertion = (user: string, role: Role, host: string) => {
    const body = Buffer.from(JSON.stringify({ u: user, r: role, h: host, exp: now() + ASSERT_MS, n: randomBytes(6).toString('hex') })).toString('base64url')
    return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`
  }
  const safeBack = (r: string | null) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/')
  /** The person's session on the gateway host (Better Auth's cookie), with the raw session token for board sessions. */
  const personOf = async (req: Request) => {
    const s = await auth.api.getSession({ headers: req.headers }).catch(() => null)
    return s?.session && s.user ? { userId: s.user.id, name: s.user.name, token: s.session.token } : null
  }
  const callbackFor = (p: { userId: string; token: string }, board: string, back: string) => {
    if (!board || !roleOn(p.userId, projectOf(board))) return null
    const c = randomBytes(24).toString('base64url'); boardCodes.set(h(c), { parent: p.token, userId: p.userId, host: board, back, exp: now() + BOARD_CODE_MS })
    return `https://${board}/_mm/auth/callback?c=${c}`
  }
  const denied = { 'x-mm-assertion': '-', 'x-board-user': '-', 'x-board-role': '-' } // always set: an empty one would be dropped, and a client's copy could pass
  const assertion = (userId: string, role: Role, host: string) => {
    const u = userById(userId)!
    return new Response(null, { status: 200, headers: { 'x-mm-assertion': signAssertion(u.name, role, host), 'x-board-user': u.name, 'x-board-role': role } })
  }

  // ---------- the home page (sy-ukbz): every board this person holds a role on, with that board's counts ----------
  // Each board is asked for this person with one fresh assertion (this person, this role, that board's host, 60 s), at
  // the address the host gave its route (never a project's .run/), no redirects, 3 s, 16 KB; all boards at once; no
  // cache, so a revoke shows on the next load. What a board sends back is untrusted: only whole numbers and one time.
  // The "Waiting for you" list (sy-vdi8; review's rules in sy-6h43 #5) is asked the same way, from /api/waiting, 32 KB:
  // only id, plain title and age in minutes leave a board, with the labels the ask needs; the gateway checks each item
  // (waitingOf) and writes the ask and the link itself. A board on an older template has no such answer: no list.
  const SUMMARY_MS = 3000, SUMMARY_MAX = 16 * 1024, WAITING_MAX = 32 * 1024
  /** One board's JSON answer for this person: one fresh assertion, no redirects, 3 s, at most `max` bytes. */
  const askBoard = async <T,>(what: string, path: string, max: number, parse: (o: unknown) => T | null, quiet: (status: number) => boolean,
    project: string, host: string, up: string, name: string, role: Role): Promise<{ v: T | null; older?: boolean }> => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), SUMMARY_MS)
    let why = ''
    try {
      const r = await fetch(`${up}${path}`, { redirect: 'manual', signal: ac.signal, headers: { 'x-mm-assertion': signAssertion(name, role, host),
        'x-forwarded-host': host, 'x-forwarded-proto': 'https', accept: 'application/json', 'accept-encoding': 'identity' } })
      if (r.status !== 200 || !r.body) { ac.abort(); if (quiet(r.status)) return { v: null, older: true }; why = `HTTP ${r.status}`; return { v: null } }
      if (Number(r.headers.get('content-length') || 0) > max) { why = 'too big'; ac.abort(); return { v: null } }
      const rd = r.body.getReader(), parts: Uint8Array[] = []
      for (let n = 0; ;) {
        const { done, value } = await rd.read(); if (done) break
        n += value.byteLength; if (n > max) { why = 'too big'; ac.abort(); return { v: null } }
        parts.push(value)
      }
      let o: unknown; try { o = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { why = 'not JSON'; return { v: null } }
      const v = parse(o); if (!v) why = `not a ${what}`
      return { v }
    } catch (e) { why = ac.signal.aborted ? 'timeout' : (e as Error).name || 'error'; return { v: null } }
    finally { clearTimeout(timer); if (why) log('warn', `board ${what} unavailable`, { project, host, why }) }
  }
  const home = async (p: { userId: string; name: string }) => {
    const { hosts, ups, roles } = loadHosts()
    const granted = Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([project, host]) => { const role = roleOn(p.userId, project); return role ? [{ project, host, role }] : [] })
    const cards = await Promise.all(granted.map(async (c) => {
      const up = ups[c.host]
      if (!up) return { ...c, s: null, w: null, older: false }
      const [s, w] = await Promise.all([
        askBoard('summary', '/api/summary?signal=1', SUMMARY_MAX, (o) => summaryOf(o, roles[c.project] || new Set()), () => false, c.project, c.host, up, p.name, c.role),
        // an older board answers 404 or 403 ("not allowed from the board"): no list, no error
        askBoard('waiting list', '/api/waiting', WAITING_MAX, (o) => waitingOf(o, c.role === 'owner'), (st) => st === 404 || st === 403, c.project, c.host, up, p.name, c.role)])
      return { ...c, s: s.v, w: w.v, older: !!w.older }
    }))
    return html(homePage(p.name, cards))
  }

  async function http(req: Request, srv?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> {
    const u = new URL(req.url), host = req.headers.get('x-forwarded-host') || u.host, path = u.pathname
    // forward-auth: the web proxy asks for every request to a board host
    if (path === '/verify') {
      const fwdUri = req.headers.get('x-forwarded-uri') || '/'
      // the board's callback is ours (no assertion needed): exactly that path, raw, so no `..` or encoding gets past it
      if (fwdUri.split('?')[0] === '/_mm/auth/callback') return new Response(null, { status: 200 })
      const project = projectOf(host)
      const bearerTok = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1]
      if (bearerTok) { // a tool: its token is for one project; nothing else is tried
        const t = db.query('SELECT user_id, project, expires FROM mm_token WHERE hash = ?').get(h(bearerTok)) as { user_id: string; project: string; expires: number } | null
        const role = t && t.expires > now() && t.project === project ? roleOn(t.user_id, project) : null
        if (role) return assertion(t!.user_id, role, host)
        log('warn', 'bearer refused', { host, token: short(bearerTok) })
        return new Response('invalid token', { status: 401, headers: { ...denied, 'www-authenticate': 'Bearer' } })
      }
      const v = cookies(req).mm_board
      const bs = v ? db.query('SELECT user_id, parent, host, expires FROM mm_board_session WHERE hash = ?').get(h(v)) as { user_id: string; parent: string; host: string; expires: number } | null : null
      // a board session lives only while its person's session lives: sign out or `mm user rm` ends it at once
      const role = bs && bs.host === host && bs.expires > now() && alive(liveSession(bs.parent)) ? roleOn(bs.user_id, project) : null
      if (role) return assertion(bs!.user_id, role, host)
      return new Response(null, { status: 302, headers: { location: `https://${authHost}/s?b=${encodeURIComponent(host)}&r=${encodeURIComponent(safeBack(fwdUri))}`, ...denied } })
    }
    // a board host: its one-time callback code -> that board's own cookie
    if (path === '/_mm/auth/callback') {
      const c = u.searchParams.get('c') || '', k = h(c), bc = boardCodes.get(k)
      boardCodes.delete(k) // single use, whatever happens next
      const parent = bc ? liveSession(bc.parent) : null
      if (!bc || bc.exp < now() || bc.host !== host || !alive(parent)) { log('warn', 'board callback refused', { host, code: short(c) }); return new Response('Sign-in expired. Open the board again.', { status: 403, headers }) }
      const id = randomBytes(32).toString('base64url'), exp = Math.min(new Date(parent!.expiresAt).getTime(), now() + SESSION_S * 1000)
      db.run('INSERT INTO mm_board_session (hash, user_id, parent, host, created, expires) VALUES (?, ?, ?, ?, ?, ?)', [h(id), bc.userId, bc.parent, host, now(), exp])
      log('info', 'board session', { user: userById(bc.userId)?.name, host })
      return new Response(null, { status: 302, headers: { location: safeBack(bc.back), 'set-cookie': setCookie(req, 'mm_board', id, exp - now()), ...headers } })
    }
    // a sign-in link (review sy-g8v 2): opening it only shows a Continue button. Chat previews (Telegram) and mail
    // scanners open links; a GET that signed in would use the single-use link up, or sign the fetcher in. Only the
    // button's POST, from this host's own page, runs Better Auth's verify step.
    if (path === '/api/auth/magic-link/verify') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('use the link\'s page', { status: 405, headers })
      return html(continuePage(u.searchParams.get('token') || '', u.searchParams.get('callbackURL') || '/s/done'))
    }
    if (path === '/s/l') {
      if (req.method !== 'POST') return new Response(null, { status: 302, headers: { location: '/s/done', ...headers } })
      const ip = clientIp(req, srv)
      if (limited(`ba:${ip}`, 60, 60e3)) return json({ error: 'too many requests' }, 429)
      // only the Continue page's own form (CSRF). Our pages are served with Referrer-Policy: no-referrer, so a browser
      // sends `Origin: null` on that form's POST (sy-9tbm). A page can't set Sec-Fetch-Site. So: an Origin of another
      // host is always refused; when the browser sends Sec-Fetch-Site, only same-origin passes (cross-site, same-site,
      // none refused; a sandboxed frame elsewhere sends Origin null but cross-site); without it (an older browser),
      // Origin must be this host. A non-browser client gains nothing here: it could post the token anyway.
      const site = req.headers.get('sec-fetch-site'), origin = req.headers.get('origin') || ''
      let from = ''; try { from = new URL(origin).host } catch {}
      const foreign = origin !== '' && origin !== 'null' && from !== authHost
      if (foreign || (site ? site !== 'same-origin' : from !== authHost)) { log('warn', 'link post refused (not from the link page)', { ip, origin: req.headers.get('origin') || undefined, site: site || undefined }); return html(page('Open the sign-in link itself, then press Continue.'), 403) }
      const f = await req.formData().catch(() => null), t = String(f?.get('t') || ''), c = String(f?.get('c') || '/s/done')
      const hdrs = new Headers(req.headers); hdrs.delete('cf-connecting-ip'); hdrs.delete('content-type'); hdrs.delete('content-length'); hdrs.set('x-mm-client-ip', ip)
      const r = await auth.handler(new Request(`https://${authHost}/api/auth/magic-link/verify?${new URLSearchParams({ token: t, callbackURL: c })}`, { method: 'GET', headers: hdrs }))
      { // a link was used: who, from where (the owner sees it in mm user ls and the log)
        const set = r.headers.getSetCookie?.().find((x) => /session_token=/.test(x)), tok = set && decodeURIComponent(set.split(';')[0].split('=').slice(1).join('=')).split('.')[0]
        const who = tok ? (db.query('SELECT u.name AS name FROM session s JOIN user u ON u.id = s.userId WHERE s.token = ?').get(tok) as { name: string } | null)?.name : null
        if (tok) db.run('UPDATE session SET ipAddress = ? WHERE token = ?', [ip, tok])
        log(tok ? 'info' : 'warn', tok ? 'signed in by link' : 'link refused', { user: who || undefined, ip, link: short(t) })
        if (tok) tellOwner(`${who || 'someone'} signed in with a link, from ${ip}. If that wasn't them: mm revoke ${who || '<name>'}`)
      }
      return r
    }
    // Better Auth's other routes (the gateway's host)
    if (path.startsWith('/api/auth/')) {
      const ip = clientIp(req, srv)
      if (limited(`ba:${ip}`, 60, 60e3)) return json({ error: 'too many requests' }, 429)
      const hdrs = new Headers(req.headers); hdrs.delete('cf-connecting-ip'); hdrs.set('x-mm-client-ip', ip) // only mm says where it came from
      const inner = new Request(`https://${authHost}${path}${u.search}`, { method: req.method, headers: hdrs, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer() })
      return auth.handler(inner)
    }
    if (path === '/s') {
      const board = u.searchParams.get('b') || '', back = safeBack(u.searchParams.get('r')), p = await personOf(req)
      if (p && !board) return new Response(null, { status: 302, headers: { location: '/', ...headers } }) // signed in, no board asked: home
      const next = p && callbackFor(p, board, back)
      if (next) return new Response(null, { status: 302, headers: { location: next, ...headers } })
      if (p) return html(page(`Signed in as <b>${esc(p.name)}</b>, but you have no access to ${esc(board || 'this board')}. Ask the owner.`))
      // not signed in: a code on the screen, bound to this browser, for the owner to approve (or a link from them)
      const ip = clientIp(req, srv)
      if (limited(`code:${ip}`, 10, 10 * 60e3)) { log('warn', 'code issuing limited', { ip }); return html(page('Too many sign-in attempts from here. Wait a few minutes.'), 429) }
      const id = randomBytes(32).toString('base64url'), code = newCode()
      pending.set(h(id), { code, board, back, created: now(), ip, ua: (req.headers.get('user-agent') || '').slice(0, 160) }); byCode.set(h(code), h(id))
      log('info', 'code issued', { board, code: short(code), ip })
      const r = html(codePage(code, board)); r.headers.append('set-cookie', setPendingCookie(req, id)); return r
    }
    if (path === '/s/app.js') return new Response(CODE_JS, { headers: { 'content-type': 'text/javascript', ...headers } })
    if (path === '/s/poll') {
      const v = cookies(req).mm_pending, k = v ? h(v) : '', pp = k ? pending.get(k) : undefined
      if (!pp || now() - pp.created > CODE_MS) return json({ state: 'expired' }, 410)
      if (!pp.link) return json({ state: 'waiting' })
      pending.delete(k); byCode.delete(h(pp.code)) // the link goes to this browser only, once
      return json({ state: 'approved', next: pp.link }, 200, { 'set-cookie': 'mm_pending=; Path=/; Max-Age=0' })
    }
    if (path === '/s/done') {
      const p = await personOf(req)
      if (!p) return html(page('That link has expired or was used already. Ask the owner for a new one.'), 403)
      return home(p)
    }
    // the home page on the gateway's own host; no session: the sign-in page
    if (path === '/' && req.method === 'GET' && host === authHost) {
      const p = await personOf(req)
      return p ? home(p) : new Response(null, { status: 302, headers: { location: '/s', ...headers } })
    }
    if (path === '/s/app.css') return new Response(APP_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', ...headers, 'cache-control': 'public, max-age=3600' } }) // the one file that may be cached
    if (path === '/s/out' && req.method === 'POST') {
      const p = await personOf(req)
      if (p) { db.run('DELETE FROM mm_board_session WHERE parent = ?', [p.token]); db.run('DELETE FROM session WHERE token = ?', [p.token]); log('info', 'signed out', { user: p.name }) }
      return json({ ok: true })
    }
    return new Response('not found', { status: 404, headers })
  }

  // the socket API: only `mm user|grant|revoke|token` (same user; the socket is 0600 in a 0700 folder)
  // names a person can't take: the system's actors, the leads, and the owner's name (unless it is the owner)
  const NAME = /^[a-z][a-z0-9._-]{1,31}$/, RESERVED = new Set(['wake', 'watchdog', 'brain', 'ui', 'beads', 'smoke', 'system', 'admin', 'setup', 'guest', 'human', 'owner', 'ops', 'review', 'platform',
    'sentinel', 'steward', 'assistant', 'mm', 'root', 'bridge'])
  const PROJECT = /^[a-z][a-z0-9-]{0,62}$/
  const endSessions = (userId: string) => {
    for (const s of db.query('SELECT token FROM session WHERE userId = ?').all(userId) as { token: string }[]) db.run('DELETE FROM mm_board_session WHERE parent = ?', [s.token])
    db.run('DELETE FROM session WHERE userId = ?', [userId])
  }
  /** A single-use sign-in link for a person (Better Auth's magic link; mm captures it), with its own lifetime. */
  async function mintLink(name: string, ttl: number, callbackURL: string): Promise<{ link: string; expires: string } | null> {
    links.delete(emailOf(name))
    const before = new Set((db.query('SELECT id FROM verification').all() as { id: string }[]).map((x) => x.id))
    await auth.api.signInMagicLink({ body: { email: emailOf(name), callbackURL }, headers: new Headers() })
    const link = links.get(emailOf(name)); links.delete(emailOf(name))
    const made = (db.query('SELECT id FROM verification').all() as { id: string }[]).filter((x) => !before.has(x.id))
    if (!link || made.length !== 1) return null
    const expires = new Date(now() + ttl * 1000).toISOString()
    db.run('UPDATE verification SET expiresAt = ? WHERE id = ?', [expires, made[0].id]) // this link's own lifetime
    return { link, expires }
  }

  async function api(req: Request): Promise<Response> {
    const u = new URL(req.url), b = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
    const caller = String(b.by || u.searchParams.get('by') || 'cli'), name = String(b.name || '').trim().toLowerCase()
    if (u.pathname === '/user/add') {
      const owner = b.owner === true
      if (!NAME.test(name) || (RESERVED.has(name) && !(owner && name === 'owner')) || (!owner && name === ownerName.toLowerCase())) return json({ error: `${name}: not a usable name` }, 400)
      if (userByName(name)) return json({ error: `${name} exists (mm user link ${name} for a new link)` }, 409)
      if (owner && (db.query("SELECT 1 FROM user WHERE role = 'admin'").get())) return json({ error: 'there is an owner already' }, 409)
      const usr = await ctx.internalAdapter.createUser({ email: emailOf(name), name, emailVerified: true, ...(owner ? { role: 'admin' } : {}) }, { method: 'admin' })
      log('info', 'user added', { user: name, owner, by: caller }); tellOwner(`${owner ? 'the owner' : 'a person'} added: ${name}. Undo: mm user rm ${name}`)
      return json({ ok: true, name, owner, id: usr.id })
    }
    if (u.pathname === '/user/link') { // a single-use link; one session from it opens every board granted
      const usr = userByName(name); if (!usr) return json({ error: `no user ${name} (mm user add ${name})` }, 404)
      const ttl = b.ttl ? Number(b.ttl) : LINK_S
      if (b.ttl && !(ttl >= 60 && ttl <= LINK_MAX_S)) return json({ error: `ttl: 60 s to ${LINK_MAX_S / 86400} days` }, 400)
      const m = await mintLink(name, ttl, '/s/done')
      if (!m) return json({ error: 'no link was made' }, 500)
      log('info', 'link made', { user: name, ttl_s: ttl, link: short(new URL(m.link).searchParams.get('token') || ''), by: caller }); tellOwner(`a sign-in link was made for ${name} (valid ${Math.round(ttl / 60)} min, works once). If that wasn't you: mm revoke ${name}`)
      return json({ ok: true, name, link: m.link, expires: m.expires, note: 'works once; send it to them yourself' })
    }
    if (u.pathname === '/user/rm') {
      const usr = userByName(name); if (!usr) return json({ error: `no user ${name}` }, 404)
      endSessions(usr.id); db.run('DELETE FROM mm_token WHERE user_id = ?', [usr.id]); db.run('DELETE FROM member WHERE userId = ?', [usr.id])
      await ctx.internalAdapter.deleteUser(usr.id)
      log('info', 'user removed', { user: name, by: caller }); tellOwner(`${name} was removed (grants, sessions and tokens ended)`); return json({ ok: true })
    }
    if (u.pathname === '/user/ls') {
      const rows = db.query('SELECT id, name, role, createdAt FROM user ORDER BY name').all() as { id: string; name: string; role?: string; createdAt: string }[]
      return json(rows.map((x) => ({ name: x.name, owner: x.role === 'admin',
        grants: x.role === 'admin' ? 'owner (every project)' : (db.query('SELECT o.slug AS p, m.role AS r FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = ? ORDER BY o.slug').all(x.id) as { p: string; r: string }[]).map((g) => `${g.p}:${g.r}`).join(', '),
        sessions: (db.query('SELECT COUNT(*) AS n FROM session WHERE userId = ? AND expiresAt > ?').get(x.id, new Date().toISOString()) as { n: number }).n,
        last_signin: (db.query('SELECT createdAt AS t, ipAddress AS ip FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1').get(x.id) as { t: string; ip: string } | null)?.t || null,
        tokens: (db.query('SELECT COUNT(*) AS n FROM mm_token WHERE user_id = ?').get(x.id) as { n: number }).n })))
    }
    if (u.pathname === '/grant') {
      const project = String(b.project || ''), role = guestRole(b.role), usr = userByName(name)
      if (!usr) return json({ error: `no user ${name} (mm user add ${name})` }, 404)
      if (isOwner(usr)) return json({ error: `${name} is the owner (every project already)` }, 400)
      if (!PROJECT.test(project)) return json({ error: 'a project id (mm ls)' }, 400)
      let org = orgOf(project)
      if (!org) { // the project's organization, made on the first grant, owned by the owner
        const own = db.query("SELECT id FROM user WHERE role = 'admin'").get() as { id: string } | null
        if (!own) return json({ error: 'no owner yet: mm user add <your name> --owner' }, 409)
        org = await auth.api.createOrganization({ body: { name: project, slug: project, userId: own.id } }) as { id: string }
      }
      const m = db.query('SELECT id FROM member WHERE organizationId = ? AND userId = ?').get(org!.id, usr.id) as { id: string } | null
      if (m) db.run('UPDATE member SET role = ? WHERE id = ?', [role, m.id])
      else await auth.api.addMember({ body: { userId: usr.id, organizationId: org!.id, role } })
      log('info', 'granted', { user: name, project, role, by: caller }); tellOwner(`${name} was granted ${project} as ${role}. Undo: mm revoke ${name} ${project}`); return json({ ok: true, name, project, role })
    }
    if (u.pathname === '/revoke') {
      const project = b.project ? String(b.project) : null, usr = userByName(name)
      if (!usr) return json({ error: `no user ${name}` }, 404)
      if (project) {
        const o = orgOf(project), n = o ? db.run('DELETE FROM member WHERE organizationId = ? AND userId = ?', [o.id, usr.id]).changes : 0
        if (!n) return json({ error: `no grant for ${name} on ${project}` }, 404)
        db.run('DELETE FROM mm_token WHERE user_id = ? AND project = ?', [usr.id, project])
      } else { db.run('DELETE FROM member WHERE userId = ?', [usr.id]); db.run('DELETE FROM mm_token WHERE user_id = ?', [usr.id]); endSessions(usr.id) }
      log('info', 'revoked', { user: name, project: project || 'all', by: caller }); tellOwner(`${name}'s access to ${project || 'every project'} was revoked`); return json({ ok: true })
    }
    if (u.pathname === '/token') {
      const project = String(b.project || ''), days = Number(b.days || TOKEN_DAYS), usr = userByName(name)
      if (!usr) return json({ error: `no user ${name}` }, 404)
      if (!roleOn(usr.id, project)) return json({ error: `${name} has no grant on ${project}` }, 403)
      if (!(days >= 1 && days <= 365)) return json({ error: 'days: 1 to 365' }, 400)
      const t = `mmt_${randomBytes(32).toString('base64url')}`, exp = now() + days * 864e5
      db.run('INSERT INTO mm_token (hash, user_id, project, label, created, expires) VALUES (?, ?, ?, ?, ?, ?)', [h(t), usr.id, project, b.label ? String(b.label).slice(0, 60) : null, now(), exp])
      log('info', 'token made', { user: name, project, days, token: short(t), by: caller }); tellOwner(`a token for tools was made for ${name} on ${project} (${days} days). If that wasn't you: mm revoke ${name} ${project}`)
      return json({ ok: true, token: t, project, expires: new Date(exp).toISOString(), note: 'shown once' })
    }
    // sign-in by code (the bridge's /login and its Allow button): what is asking, then approve it for a named person
    if (u.pathname === '/pending') {
      const pid = byCode.get(h(normCode(String(u.searchParams.get('code') || '')))), p = pid ? pending.get(pid) : undefined
      return p && now() - p.created <= CODE_MS && !p.link ? json({ board: p.board, ip: p.ip, ua: p.ua, age_s: Math.round((now() - p.created) / 1000) }) : json({ error: 'no such code (or expired, or used)' }, 404)
    }
    if (u.pathname === '/approve') {
      const code = normCode(String(b.code || ''))
      if (limited(`approve:${caller}`, 5, 10 * 60e3) || limited('approve:all', 100, 3600e3)) { log('warn', 'approvals limited', { by: caller }); return json({ error: 'too many attempts; wait' }, 429) }
      const pid = byCode.get(h(code)), p = pid ? pending.get(pid) : undefined
      if (!p || now() - p.created > CODE_MS || p.link) { log('warn', 'approval refused: unknown, expired or used code', { by: caller, code: short(code) }); return json({ error: 'no such code (or expired, or used)' }, 404) }
      const usr = userByName(name); if (!usr || usr.banned) return json({ error: `no user ${name} (mm user add ${name})` }, 404)
      byCode.delete(h(code)) // burnt now: a second approval finds nothing
      const m = await mintLink(name, CODE_LINK_S, `/s?b=${encodeURIComponent(p.board)}&r=${encodeURIComponent(p.back)}`)
      if (!m) return json({ error: 'no link was made' }, 500)
      p.link = m.link; p.user = name
      log('info', 'approved by code', { user: name, board: p.board, ip: p.ip, by: caller, code: short(code) })
      tellOwner(`${name} was signed in by code on ${p.board || 'the gateway'} (from ${p.ip}), approved by ${caller}. If that wasn't them: mm revoke ${name}`)
      return json({ ok: true, name, board: p.board })
    }
    if (u.pathname === '/grants') return json(db.query('SELECT u.name AS name, o.slug AS project, m.role AS role FROM member m JOIN organization o ON o.id = m.organizationId JOIN user u ON u.id = m.userId ORDER BY o.slug, u.name').all())
    if (u.pathname === '/sessions') return json([
      ...(db.query('SELECT u.name AS user, s.expiresAt AS expires FROM session s JOIN user u ON u.id = s.userId WHERE s.expiresAt > ?').all(now()) as { user: string; expires: string }[]).map((s) => ({ user: s.user, host: authHost, expires: new Date(s.expires).toISOString() })),
      ...(db.query('SELECT u.name AS user, b.host AS host, b.expires AS expires FROM mm_board_session b JOIN user u ON u.id = b.user_id WHERE b.expires > ?').all(now()) as { user: string; host: string; expires: number }[]).map((s) => ({ user: s.user, host: s.host, expires: new Date(s.expires).toISOString() }))])
    return json({ error: 'unknown' }, 404)
  }
  return { http, api, authHost, publicKey: publicKeyPem }
}

export async function serve() {
  const g = await gateway(), c = loadConfig()
  const port = Number(getPath(c, 'auth_port') ?? 9440), bind = String(getPath(c, 'bind_host') ?? '127.0.0.1')
  const hosts = [...new Set(['127.0.0.1', bind])]
  for (const hostname of hosts) Bun.serve({ hostname, port, fetch: (req, srv) => g.http(req, srv) })
  rmSync(AUTH_SOCK, { force: true })
  Bun.serve({ unix: AUTH_SOCK, fetch: (req) => g.api(req) })
  chmodSync(AUTH_SOCK, 0o600)
  log('info', `mm.auth on ${hosts.map((x) => `${x}:${port}`).join(', ')}; api ${AUTH_SOCK}; sign-in host ${g.authHost}`)
}

/** Call the running gateway's socket API (mm user|grant|revoke|token). */
export async function callApi(path: string, body?: Record<string, unknown>) {
  const r = await fetch(`http://auth${path}`, { unix: AUTH_SOCK, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined } as RequestInit)
  return { status: r.status, data: await r.json().catch(() => ({})) }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// ---------- the home page's parts (sy-ukbz) ----------
type Summary = { open: number; p0: number; blocked: number; needs_you: number; mine: number; last?: string
  needs_you_min?: number; approvals?: number; queue?: number; queue_min?: number; queue_role?: string }
const COUNTS = ['open', 'p0', 'blocked', 'needs_you', 'mine'] as const
/** The worst signal's parts (sy-6h43), each optional (a board on an older template sends none): whole numbers again. */
const SIGNALS = ['needs_you_min', 'approvals', 'queue', 'queue_min'] as const
const ROLE_ID = /^[a-z][a-z0-9-]{0,30}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/
/** A board's answer, read strictly: the five counts as whole numbers 0..1e6, `last` an ISO time or absent; the worst
 *  signal's numbers (SIGNALS) whole numbers 0..1e6 or absent, and `queue_role` absent or one of `roles` (that project's
 *  role ids, as the gateway knows them: rolesAt()); nothing else. */
export function summaryOf(o: unknown, roles: Set<string> = new Set()): Summary | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const x = o as Record<string, unknown>
  if (Object.keys(x).some((k) => k !== 'last' && k !== 'queue_role' && !(COUNTS as readonly string[]).includes(k) && !(SIGNALS as readonly string[]).includes(k))) return null
  const whole = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e6
  for (const k of COUNTS) if (!whole(x[k])) return null
  for (const k of SIGNALS) if (x[k] !== undefined && !whole(x[k])) return null
  if (x.last !== undefined && (typeof x.last !== 'string' || !ISO.test(x.last) || Number.isNaN(Date.parse(x.last)))) return null
  if (x.queue_role !== undefined && (typeof x.queue_role !== 'string' || !ROLE_ID.test(x.queue_role) || !roles.has(x.queue_role))) return null
  const n = (k: typeof COUNTS[number]) => x[k] as number
  const sig = Object.fromEntries(SIGNALS.filter((k) => x[k] !== undefined).map((k) => [k, x[k] as number]))
  return { open: n('open'), p0: n('p0'), blocked: n('blocked'), needs_you: n('needs_you'), mine: n('mine'), ...(x.last ? { last: new Date(x.last as string).toISOString() } : {}),
    ...sig, ...(x.queue_role ? { queue_role: x.queue_role as string } : {}) }
}
/** A project's role ids, as the gateway knows them (sy-6h43): its leads/roles.json, and setup (every board has it). Read
 *  only inside the project's folder (opened without following a final link, then checked by where the open file really
 *  is), at most 64 KB, only ids that look like one. Anything else: setup alone. */
export function rolesAt(root: string): Set<string> {
  const out = new Set<string>(['setup'])
  let fd = -1
  try {
    fd = openSync(join(root, 'leads', 'roles.json'), fsc.O_RDONLY | fsc.O_NOFOLLOW)
    const real = (() => { try { return readlinkSync(`/proc/self/fd/${fd}`) } catch { return realpathSync(join(root, 'leads', 'roles.json')) } })()
    const st = fstatSync(fd)
    if (!real.startsWith(realpathSync(root) + '/') || !st.isFile() || st.size > 65536) return out
    const d = JSON.parse(readFileSync(fd, 'utf8'))
    for (const r of Array.isArray(d?.roles) ? d.roles : []) if (typeof r?.id === 'string' && ROLE_ID.test(r.id)) out.add(r.id)
  } catch {} finally { if (fd >= 0) closeSync(fd) }
  return out
}
const mins = (m: number) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`)
/** The card's one line (sy-6h43), made here from the board's numbers and its checked role id, never from a board's
 *  text: the worst signal. Red (hot) only when it needs the owner: items that need you (needs-you, or for the owner a
 *  t2 waiting for the approval). null: a board on an older template (no signal sent). */
export function worstOf(s: Summary): { text: string; hot: boolean } | null {
  const oldest = (m: number | undefined) => (m === undefined ? '' : `, oldest ${mins(m)}`)
  if (s.needs_you > 0) {
    const a = Math.min(s.approvals ?? 0, s.needs_you), other = s.needs_you - a
    const what = !a ? `needs you ${s.needs_you}` : !other ? `${a} approval${a === 1 ? ' waits' : 's wait'} for you` : `needs you ${s.needs_you} (${a} approval${a === 1 ? '' : 's'})`
    return { text: what + oldest(s.needs_you_min), hot: true }
  }
  if (s.queue_role && s.queue) return { text: `${s.queue_role} queue ${s.queue}${oldest(s.queue_min)}`, hot: false }
  if (s.blocked > 0) return { text: `${s.blocked} blocked`, hot: false }
  return s.queue !== undefined ? { text: 'nothing waiting', hot: false } : null
}
/** One entry of the "Waiting for you" list (sy-vdi8): what the board sent, checked, and the ask the gateway wrote. */
type Waiting = { id: string; title: string; age_min: number; ask: string; hot: boolean }
const ITEM_ID = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/ // the boards' id pattern (template/site/server.mjs ID_RE)
// control characters (C0, DEL, C1), the line and paragraph separators, and the bidi controls
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const ASK_LABELS = new Set(['needs-you', 't2', 'signed-off'])
const WAIT_KEYS = new Set(['id', 'title', 'age_min', 'labels'])
/** A board's /api/waiting answer, read strictly (review sy-6h43 #5). The answer: an object with `items` (an array) and
 *  `more` (a whole number, optional), nothing else, or the board's whole list is dropped. Each item: an id of the boards'
 *  pattern (at most 64 characters), a plain-text title (1..200 characters, no control characters), age_min a whole
 *  number, labels only from needs-you/t2/signed-off, and nothing else, or that item is dropped. The ask is the gateway's:
 *  for the owner "approve (t2, signed off)" (t2 + signed-off) or "needs you" (needs-you), else the item is dropped; for
 *  anyone else "assigned to you" (the board sends them only their own items). A repeated id: kept once. */
export function waitingOf(o: unknown, owner: boolean): { items: Waiting[]; more: number } | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const x = o as Record<string, unknown>
  if (Object.keys(x).some((k) => k !== 'items' && k !== 'more') || !Array.isArray(x.items) || x.items.length > 1000) return null
  const whole = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
  if (x.more !== undefined && !whole(x.more, 1e6)) return null
  const items: Waiting[] = [], seen = new Set<string>()
  for (const it of x.items as unknown[]) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue
    const e = it as Record<string, unknown>
    if (Object.keys(e).some((k) => !WAIT_KEYS.has(k))) continue
    if (typeof e.id !== 'string' || e.id.length > 64 || !ITEM_ID.test(e.id) || seen.has(e.id)) continue
    if (typeof e.title !== 'string' || CONTROL.test(e.title)) continue
    const n = [...e.title].length; if (n < 1 || n > 200) continue
    if (!whole(e.age_min, 1e8)) continue
    const labels = e.labels === undefined ? [] : e.labels
    if (!Array.isArray(labels) || labels.length > 3 || labels.some((l) => typeof l !== 'string' || !ASK_LABELS.has(l))) continue
    let ask: string, hot: boolean
    if (owner) {
      if (labels.includes('t2') && labels.includes('signed-off')) { ask = 'approve (t2, signed off)'; hot = true }
      else if (labels.includes('needs-you')) { ask = 'needs you'; hot = true }
      else continue
    } else { ask = 'assigned to you'; hot = false }
    seen.add(e.id)
    items.push({ id: e.id, title: e.title, age_min: e.age_min as number, ask, hot })
  }
  return { items, more: (x.more as number | undefined) ?? 0 }
}
// ---------- the gateway's pages (sy-vey6): the boards' Swiss style, one stylesheet, no inline style ----------
// The CSP (default-src 'self') blocks style="" and <style>, so every page links /s/app.css, served from here. The same
// header line as a board: the page's name large and bold, a small nav, a solid rule under it.
function shell(title: string, nav: string, body: string, tail = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="/s/app.css">
<body><header class="top"><h1>${esc(title)}</h1><nav>${nav}</nav></header>
<main class="wrap">${body}</main>${tail}`
}
const SIGN_IN_NAV = '<span class="here">Sign in</span>'
/** Made on the server, no script; every value escaped; the name and link from the gateway's own data, never a board's. */
type Card = { project: string; host: string; role: string; s: Summary | null; w: { items: Waiting[]; more: number } | null; older: boolean }
/** The "Waiting for you" list (sy-vdi8), the first thing on the home page: every checked item of every board the person
 *  holds a role on, oldest first: the ask, the title, the board, the id, the age. The link is the gateway's own: the
 *  board's host (from the host's registry) and the checked id, through the one-redirect flow, to the board's item view
 *  (`/?item=<id>`). No list at all when no board has one (boards on an older template); a board whose answer failed the
 *  check is named in a note. */
function waitingList(cards: Card[]) {
  const withList = cards.filter((c) => c.w), failed = cards.filter((c) => !c.w && !c.older && c.s)
  if (!withList.length && !failed.length) return ''
  const rows = withList.flatMap((c) => c.w!.items.map((i) => ({ ...i, project: c.project, host: c.host })))
    .sort((a, b) => b.age_min - a.age_min || a.project.localeCompare(b.project) || a.id.localeCompare(b.id))
  const href = (host: string, id: string) => `/s?b=${encodeURIComponent(host)}&amp;r=${encodeURIComponent(`/?item=${id}`)}`
  const row = (r: typeof rows[number]) => `<li><a href="${href(r.host, r.id)}"><span class="w-ask${r.hot ? ' hot' : ''}">${esc(r.ask)}</span><span class="w-age">${esc(mins(r.age_min))}</span><span class="w-title">${esc(r.title)}</span><span class="w-where"><span class="w-board">${esc(r.project)}</span><span class="w-id">${esc(r.id)}</span></span></a></li>`
  const more = withList.filter((c) => c.w!.more > 0).map((c) => `<p class="w-note">${esc(c.project)}: ${c.w!.more} more on the board.</p>`).join('')
  const notes = failed.map((c) => `<p class="w-note">${esc(c.project)}: the list is unavailable right now.</p>`).join('')
  return `<section class="waiting" aria-labelledby="waiting-h"><h2 id="waiting-h">Waiting for you${rows.length ? ` <span class="w-n">${rows.length}</span>` : ''}</h2>
${rows.length ? `<ol class="w-list">${rows.map(row).join('\n')}</ol>` : '<p class="w-none">Nothing is waiting for you.</p>'}${more}${notes}</section>\n`
}
function homePage(name: string, cards: Card[]) {
  const count = (label: string, hint: string, v: number, hot = false) => `<div${hot && v ? ' class="hot"' : ''} title="${hint}"><dt>${label}</dt><dd>${v}</dd></div>`
  const card = (c: typeof cards[number]) => `<section class="card"><h2>${esc(c.project)}</h2>
<p class="role">You are <b>${esc(c.role)}</b>${c.role === 'viewer' ? ' (read-only)' : ''}</p>
${(() => { const w = c.s && worstOf(c.s); return w ? `<p class="worst${w.hot ? ' hot' : ''}">${esc(w.text)}</p>\n` : '' })()}${c.s ? `<dl class="counts">${count('Open', 'open items', c.s.open)}${count('P0', 'open P0 items', c.s.p0, true)}${count('Blocked', 'blocked items', c.s.blocked)}${count('Needs you', 'items that need a human', c.s.needs_you, true)}${count('Mine', 'open items assigned to you', c.s.mine)}</dl>
${c.s.last ? `<p class="last">Last activity: ${esc(c.s.last.slice(0, 16).replace('T', ' '))} UTC</p>` : ''}` : '<p class="na">Summary unavailable right now.</p>'}
<p class="go"><a class="${c.role === 'viewer' ? 'view' : 'open'}" href="/s?b=${encodeURIComponent(c.host)}&amp;r=%2F">${c.role === 'viewer' ? 'View the board (read-only)' : 'Open the board'}</a></p></section>`
  const nav = `<span class="here">Boards</span><span class="who">Signed in as <b>${esc(name)}</b></span><form method="post" action="/s/out"><button type="submit" class="quiet">Sign out</button></form>`
  return shell('Your boards', nav, cards.length ? `${waitingList(cards)}<div class="cards">${cards.map(card).join('\n')}</div>` : '<p>You have no board yet; the owner can grant you one.</p>')
}
// the boards' tokens (template/site/src/index.css): near-black on near-white, hairline rules, one red, no radius
const APP_CSS = `:root{--fg:oklch(0.16 0 0);--bg:oklch(0.995 0 0);--muted:oklch(0.48 0 0);--rule:oklch(0.88 0 0);--swiss:oklch(0.58 0.235 27)}
*,*::before,*::after{box-sizing:border-box}
html{font-family:'Inter Variable','Helvetica Neue',Helvetica,Arial,sans-serif;font-feature-settings:'cv11','ss01';-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;color:var(--fg);background:var(--bg)}
body{margin:0;font-size:15px;line-height:1.45}
a{color:inherit;text-underline-offset:3px}
b{font-weight:600}
:focus-visible{outline:2px solid var(--swiss);outline-offset:2px}
.top{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.75rem 1.5rem;padding:1rem 1rem .75rem;border-bottom:1px solid var(--fg)}
.top h1{margin:0;font-size:2.25rem;line-height:1;font-weight:700;letter-spacing:-.025em}
.top nav{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.25rem 1rem;font-size:13px;font-weight:600;padding-bottom:2px}
.top nav .here{border-bottom:2px solid var(--fg);padding-bottom:2px}
.top nav .who{color:var(--muted);font-weight:500;padding-bottom:4px}
.top nav form{margin:0}
.wrap{padding:1.5rem 1rem 3rem;max-width:72rem}
.wrap>p,.wrap>form{max-width:34rem}
p{margin:0 0 .75rem;overflow-wrap:anywhere}
.muted,.note{color:var(--muted)}
.note{font-size:13px;border-top:1px solid var(--rule);padding-top:.75rem;margin-top:1.5rem}
.label{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.code{margin:.25rem 0 1rem;padding:.75rem 0;border-top:1px solid var(--fg);border-bottom:1px solid var(--fg);font:700 2.5rem/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.12em;font-variant-numeric:tabular-nums}
button{font:inherit;font-size:14px;font-weight:600;min-height:44px;padding:.6rem 1.5rem;border:1px solid var(--fg);border-radius:0;background:var(--fg);color:var(--bg);cursor:pointer}
button:hover{background:var(--swiss);border-color:var(--swiss)}
button.quiet{min-height:0;padding:0 0 2px;border:0;border-bottom:2px solid transparent;background:none;color:var(--fg);font-size:13px}
button.quiet:hover{border-bottom-color:var(--swiss);color:var(--swiss)}
.cards{display:grid;grid-template-columns:1fr;column-gap:2rem;border-top:1px solid var(--fg)}
.card{padding:1rem 0 1.25rem;border-bottom:1px solid var(--rule)}
.card h2{margin:0 0 .15rem;font-size:1.25rem;line-height:1.2;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.card .role,.card .last,.card .na{margin:0;font-size:13px;color:var(--muted)}
.card .role b{color:var(--fg)}
.card .worst{margin:.6rem 0 0;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.card .worst.hot{color:var(--swiss);border-left:3px solid var(--swiss);padding-left:.5rem}
.counts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0 .75rem;margin:.9rem 0 .6rem}
.counts dt{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.counts dd{margin:.2rem 0 0;font-size:1.75rem;line-height:1;font-weight:700;font-variant-numeric:tabular-nums}
.counts .hot dt,.counts .hot dd{color:var(--swiss)}
.card .go{margin:.9rem 0 0}
.card .go a{font-size:14px;font-weight:600;text-decoration:none;border-bottom:2px solid var(--fg);padding-bottom:1px}
.card .go a:hover{color:var(--swiss);border-bottom-color:var(--swiss)}
.waiting{margin:0 0 2rem}
.waiting h2{margin:0 0 .5rem;font-size:1.25rem;line-height:1.2;font-weight:700;letter-spacing:-.01em}
.waiting .w-n{color:var(--swiss);font-variant-numeric:tabular-nums}
.w-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--fg)}
.w-list li{border-bottom:1px solid var(--rule)}
.w-list a{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"ask age" "title title" "where where";gap:.2rem .75rem;min-height:44px;padding:.7rem 0;text-decoration:none}
.w-list a:hover .w-title{color:var(--swiss)}
.w-ask{grid-area:ask;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.w-ask.hot{color:var(--swiss)}
.w-age{grid-area:age;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.w-title{grid-area:title;font-size:15px;font-weight:600;text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px;overflow-wrap:anywhere}
.w-where{grid-area:where;display:flex;flex-wrap:wrap;gap:0 .75rem;font-size:13px;color:var(--muted)}
.w-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.w-none,.w-note{margin:.6rem 0 0;font-size:13px;color:var(--muted)}
@media (min-width:48rem){.w-list a{grid-template-columns:12rem minmax(0,1fr) 9rem 7rem 4.5rem;grid-template-areas:"ask title board id age";align-items:baseline}.w-where{display:contents}.w-board{grid-area:board;overflow-wrap:anywhere}.w-id{grid-area:id}}
@media (min-width:40rem){.top{padding:1rem 1.5rem .75rem}.wrap{padding:2rem 1.5rem 3rem}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:64rem){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}}`
function codePage(code: string, board: string) {
  return shell('Sign in', SIGN_IN_NAV, `${board ? `<p class="label">Board</p><p>${esc(board)}</p>` : ''}
<p>Give this code to the owner to approve, or open the sign-in link they sent you:</p>
<p id="code" class="code">${esc(code)}</p>
<p id="state" class="muted">Waiting for approval… (valid ${Math.round(CODE_MS / 60e3)} minutes)</p>
<p class="note">The code does nothing by itself. Only the owner can approve it.</p>`, '\n<script src="/s/app.js"></script>')
}
const CODE_JS = `(function poll(){fetch('/s/poll',{credentials:'same-origin'}).then(function(r){return r.json().then(function(j){
if(j.state==='approved'){document.getElementById('state').textContent='Approved. Signing you in…';var u=new URL(j.next,location.href),f=document.createElement('form');f.method='post';f.action='/s/l';
[['t',u.searchParams.get('token')||''],['c',u.searchParams.get('callbackURL')||'/s/done']].forEach(function(x){var i=document.createElement('input');i.type='hidden';i.name=x[0];i.value=x[1];f.appendChild(i)});document.body.appendChild(f);f.submit();return}
if(j.state==='expired'){document.getElementById('state').textContent='This code has expired. Reload the page for a new one.';return}
setTimeout(poll,2000)})}).catch(function(){setTimeout(poll,4000)})})()`
/** What a sign-in link opens: a button. Its POST signs in (a preview or a scanner only sees this page). No script. */
function continuePage(token: string, callbackURL: string) {
  return shell('Sign in', SIGN_IN_NAV, `<p>This link signs you in once. Press Continue to use it.</p>
<form method="post" action="/s/l"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="c" value="${esc(callbackURL)}">
<button type="submit">Continue</button></form>`)
}
/** A short message (expired link, refused, no access): `text` is the caller's, with any value in it escaped. */
function page(text: string) {
  return shell('Sign in', SIGN_IN_NAV, `<p>${text}</p>`)
}
