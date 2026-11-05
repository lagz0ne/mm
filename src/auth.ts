// mm.auth: the accounts and the one sign-in for every board, on Better Auth (the owner, 2026-11-05, sy-nwp).
// People (admin plugin), projects = organizations with the roles designer/member/viewer (organization plugin), the
// login = a single-use link that mm prints (magic-link plugin; no mail, no password). One session on the gateway's
// host opens every board the person is granted: each board gets its own host-only cookie through a one-time callback
// (sy-p2i: no cookie on the parent domain). Tools use a bearer token bound to one project. Design: docs/auth-gateway.md.
//   HTTP (loopback, and bind_host for the web proxy in docker), on the gateway's host:
//     /api/auth/*                      Better Auth (the link's verify step sets the session, then /s/done)
//     GET  /s?b=<board host>&r=<path>  signed in -> the board's callback; else "ask the owner for a link"
//     GET  /s/done                     after the link: the boards this person can open
//     POST /s/out                      ends the session (and its board sessions)
//   On a board host:
//     GET  /_mm/auth/callback?c=…      a one-time code -> that board's own cookie (mm_board, host-only, Strict)
//     GET  /verify                     forward-auth: the board cookie or `Authorization: Bearer` -> 200 + a signed
//                                      assertion (person, role, host, 60 s), or 302 to sign in
//   Socket ($MM_HOME/run/auth.sock, 0600): users, links, grants, tokens, sessions (`mm user|grant|revoke|token`).
// State: $MM_HOME/auth/ (0700): accounts.db (Better Auth + mm's tokens and board sessions), secret, signing.key (0600).
import { Database } from 'bun:sqlite'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { admin, bearer, magicLink, organization } from 'better-auth/plugins'
import { createAccessControl } from 'better-auth/plugins/access'
import { getPath, loadConfig } from './config'
import { expand, machineInputs } from './inputs'
import { DIRS } from './env'

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

// ---------- the gateway ----------
export async function gateway() {
  ensureStore()
  const key = createPrivateKey(readFileSync(join(AUTH_DIR, 'signing.key'), 'utf8'))
  const cfg = loadConfig(), domain = String(getPath(cfg, 'domain') ?? '')
  const authHost = String(getPath(cfg, 'auth_host') ?? (domain ? `auth.${domain}` : 'auth.localhost'))
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
  let hostMap: { at: number; map: Record<string, string>; hosts: Record<string, string> } = { at: 0, map: {}, hosts: {} }
  const loadHosts = () => {
    if (now() - hostMap.at < 30e3) return hostMap
    const map: Record<string, string> = {}, hosts: Record<string, string> = {}
    // the host's projects and the project boxes (mm registers each box in pc/boxes)
    for (const pdir of [join(DIRS.pc, 'projects'), join(DIRS.pc, 'boxes')]) for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith('.yaml')) : []) {
      const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(pdir, f), 'utf8')); if (!m) continue
      try {
        const s = JSON.parse(readFileSync(join(m[1].replace(/^~(?=\/)/, process.env.HOME || ''), '.run', 'services.json'), 'utf8'))
        for (const sv of Object.values(s.services || {}) as { public_url?: string; public?: { auth?: string } }[])
          if (sv.public_url && sv.public?.auth === 'required') { const host = new URL(sv.public_url).host; map[host] = s.project; hosts[s.project] ||= host }
      } catch {}
    }
    return (hostMap = { at: now(), map, hosts })
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
    // Better Auth (the gateway's host): the link's verify step lands here, sets the session, goes to /s/done
    if (path.startsWith('/api/auth/')) {
      const ip = clientIp(req, srv)
      if (limited(`ba:${ip}`, 60, 60e3)) return json({ error: 'too many requests' }, 429)
      const hdrs = new Headers(req.headers); hdrs.delete('cf-connecting-ip'); hdrs.set('x-mm-client-ip', ip) // only mm says where it came from
      const inner = new Request(`https://${authHost}${path}${u.search}`, { method: req.method, headers: hdrs, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer() })
      const r = await auth.handler(inner)
      if (path === '/api/auth/magic-link/verify') { // a link was used: who, from where (the owner sees it in mm user ls and the log)
        const set = r.headers.getSetCookie?.().find((x) => /session_token=/.test(x)), tok = set && decodeURIComponent(set.split(';')[0].split('=').slice(1).join('=')).split('.')[0]
        const who = tok ? (db.query('SELECT u.name AS name FROM session s JOIN user u ON u.id = s.userId WHERE s.token = ?').get(tok) as { name: string } | null)?.name : null
        if (tok) db.run('UPDATE session SET ipAddress = ? WHERE token = ?', [ip, tok])
        log(tok ? 'info' : 'warn', tok ? 'signed in by link' : 'link refused', { user: who || undefined, ip, link: short(u.searchParams.get('token') || '') })
        if (tok) tellOwner(`${who || 'someone'} signed in with a link, from ${ip}. If that wasn't them: mm revoke ${who || '<name>'}`)
      }
      return r
    }
    if (path === '/s') {
      const board = u.searchParams.get('b') || '', back = safeBack(u.searchParams.get('r')), p = await personOf(req)
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
      const { hosts } = loadHosts(), open = Object.entries(hosts).filter(([proj]) => roleOn(p.userId, proj))
      return html(page(`Signed in as <b>${esc(p.name)}</b>. ${open.length ? `Your boards:</p><ul>${open.map(([proj, h0]) => `<li><a href="https://${esc(h0)}/">${esc(proj)}</a></li>`).join('')}</ul><p>` : 'You have no board yet; the owner can grant you one.'}`))
    }
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
function codePage(code: string, board: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">Sign in${board ? ` to ${esc(board)}` : ''}</h1>
<p>Give this code to the owner to approve, or open the sign-in link they sent you:</p>
<p id="code" style="font:700 2.4rem ui-monospace,monospace;letter-spacing:.15em">${esc(code)}</p>
<p id="state" style="color:#555">Waiting for approval… (valid ${Math.round(CODE_MS / 60e3)} minutes)</p>
<p style="color:#555;font-size:.9rem">The code does nothing by itself. Only the owner can approve it.</p>
<script src="/s/app.js"></script>`
}
const CODE_JS = `(function poll(){fetch('/s/poll',{credentials:'same-origin'}).then(function(r){return r.json().then(function(j){
if(j.state==='approved'){document.getElementById('state').textContent='Approved. Signing you in…';location.href=j.next;return}
if(j.state==='expired'){document.getElementById('state').textContent='This code has expired. Reload the page for a new one.';return}
setTimeout(poll,2000)})}).catch(function(){setTimeout(poll,4000)})})()`
function page(text: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">Sign in</h1><p>${text}</p>`
}
