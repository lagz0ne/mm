// mm.auth: the accounts and the one sign-in for every board (the owner, plan v6, 2026-11-05). A person gets an invite
// link from `mm user add`, sets a password, and signs in; `mm grant` gives them a role on a project; tools use a bearer
// token from `mm token`. No email, no third-party login, no code over a chat. Design: docs/auth-gateway.md.
//   HTTP (loopback, and bind_host for the web proxy in docker):
//     GET  /i#<invite>                 set a password (the invite rides in the fragment: never in a log or a Referer)
//     POST /i                          {invite, password} -> the password is set, the invite burnt, a session
//     GET  /s?b=<board host>&r=<path>  sign-in page (or, with a live session, straight to the board's callback)
//     POST /s                          {name, password, b, r} -> a session (mm_auth) and the board's callback
//     POST /s/out                      ends this session
//     GET  /_mm/auth/callback?c=…      on a board host: a one-time code -> that board's own cookie (mm_board)
//     GET  /verify                     the web proxy's forward-auth: the board cookie or `Authorization: Bearer`
//                                      -> 200 + a signed assertion (person, role, host, 60 s), or 302 to sign in
//   Socket ($MM_HOME/run/auth.sock, 0600): users, grants, tokens, sessions (`mm user|grant|revoke|token`).
// State: $MM_HOME/auth/ (0700): users.json, grants.json, tokens.json, sessions.json, signing.key (0600 each).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'

export const AUTH_DIR = join(DIRS.mm, 'auth')
export const AUTH_SOCK = join(DIRS.mm, 'run', 'auth.sock')
const SESSION_MS = 12 * 3600e3, BOARD_CODE_MS = 30e3, ASSERT_MS = 60e3
const INVITE_MS = Number(process.env.MM_AUTH_INVITE_MS) || 24 * 3600e3, TOKEN_DAYS = 30, MIN_PASSWORD = 12
// designer = a member who also edits the project's Doop (the owner, 2026-11-05; plans/ui-access.md, doop.md)
const ROLES = ['owner', 'designer', 'member', 'viewer'] as const
type Role = typeof ROLES[number]
const guestRole = (r: unknown): Role => (r === 'viewer' ? 'viewer' : r === 'designer' ? 'designer' : 'member') // never owner
export interface User { name: string; owner?: boolean; hash?: string; invite?: { hash: string; expires: number }; created: string; by: string; last_signin?: string }
export interface Grant { name: string; project: string; role: Role; expires?: string; created: string; by: string }
interface Token { user: string; project: string; created: number; expires: number; label?: string }
interface Session { user: string; created: number; expires: number; host?: string; parent?: string }

const h = (s: string) => createHash('sha256').update(s).digest('hex')
const short = (s: string) => h(s).slice(0, 6) // what logs carry instead of a token, cookie or session id
const now = () => Date.now()
const log = (level: string, msg: string, attrs: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, project: 'mm', service: 'auth', ...attrs }))

// ---------- store (one writer: this process) ----------
function writeAtomic(f: string, data: string) { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, data, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, f) }
function ensureStore() {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 }); chmodSync(AUTH_DIR, 0o700)
  mkdirSync(dirname(AUTH_SOCK), { recursive: true, mode: 0o700 }); chmodSync(dirname(AUTH_SOCK), 0o700)
  signingKeyOnce()
  for (const f of readdirSync(AUTH_DIR)) { const p = join(AUTH_DIR, f); if ((statSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600) }
}
/** The signing key, made once. The gateway and `mm up` (writing each board's public key) may both get here first:
 *  link() into place fails if a key is already there, so there is only ever one key, whoever made it. */
function signingKeyOnce() {
  const k = join(AUTH_DIR, 'signing.key')
  if (existsSync(k)) return
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 }); chmodSync(AUTH_DIR, 0o700)
  const t = `${k}.new-${process.pid}`, { privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(t, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 })
  try { linkSync(t, k) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e } finally { rmSync(t, { force: true }) }
}
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(join(AUTH_DIR, f), 'utf8')) as T } catch { return d } }
/** The public key boards verify assertions with (PEM); mm writes it into each board's endpoints.json. With the
 *  gateway on, the key is made here if it isn't there yet, so a board started before the gateway still gets it. */
export function publicKeyPem(): string | null {
  const on = getPath(loadConfig(), 'auth.enabled')
  if (on === true || on === 'true') try { signingKeyOnce() } catch {}
  try { return createPublicKey(createPrivateKey(readFileSync(join(AUTH_DIR, 'signing.key'), 'utf8'))).export({ type: 'spki', format: 'pem' }) as string } catch { return null }
}

// ---------- the gateway ----------
export function gateway() {
  ensureStore()
  const key = createPrivateKey(readFileSync(join(AUTH_DIR, 'signing.key'), 'utf8'))
  const users: Record<string, User> = readJson('users.json', {})
  let grants: Grant[] = readJson<Grant[]>('grants.json', []).filter((g) => g.project) // older grants (scope lists) don't carry over
  const tokens: Record<string, Token> = readJson('tokens.json', {})       // key: sha256(token)
  const sessions: Record<string, Session> = readJson('sessions.json', {}) // key: sha256(session id)
  const boardCodes = new Map<string, { session: string; host: string; back: string; exp: number }>() // sha256(code) -> …
  const hits = new Map<string, number[]>()
  const save = () => {
    writeAtomic(join(AUTH_DIR, 'users.json'), JSON.stringify(users, null, 1)); writeAtomic(join(AUTH_DIR, 'grants.json'), JSON.stringify(grants, null, 1))
    writeAtomic(join(AUTH_DIR, 'tokens.json'), JSON.stringify(tokens, null, 1)); writeAtomic(join(AUTH_DIR, 'sessions.json'), JSON.stringify(sessions))
  }
  const limited = (k: string, n: number, ms: number) => { const t = now(), a = (hits.get(k) || []).filter((x) => t - x < ms); a.push(t); hits.set(k, a); return a.length > n }
  const sweep = () => {
    const t = now()
    for (const [k, c] of boardCodes) if (c.exp < t) boardCodes.delete(k)
    let dirty = false
    for (const [k, s] of Object.entries(sessions)) if (s.expires < t) { delete sessions[k]; dirty = true }
    for (const [k, x] of Object.entries(tokens)) if (x.expires < t) { delete tokens[k]; dirty = true }
    for (const u of Object.values(users)) if (u.invite && u.invite.expires < t) { delete u.invite; dirty = true }
    const n = grants.length; grants = grants.filter((g) => !g.expires || Date.parse(g.expires) > t); if (grants.length !== n) dirty = true
    if (dirty) save()
  }
  setInterval(sweep, 30e3).unref?.()

  const cfg = loadConfig(), domain = String(getPath(cfg, 'domain') ?? '')
  const authHost = String(getPath(cfg, 'auth_host') ?? (domain ? `auth.${domain}` : 'auth.localhost'))
  const ownerName = String(getPath(cfg, 'owner_name') ?? 'owner')
  // a board host -> its project (from where mm put each board's public name); cached briefly
  let hostMap: { at: number; map: Record<string, string> } = { at: 0, map: {} }
  const projectOf = (host: string) => {
    if (now() - hostMap.at > 30e3) {
      const map: Record<string, string> = {}
      const pdir = join(DIRS.pc, 'projects')
      for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith('.yaml')) : []) {
        const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(pdir, f), 'utf8')); if (!m) continue
        try {
          const s = JSON.parse(readFileSync(join(m[1].replace(/^~(?=\/)/, process.env.HOME || ''), '.run', 'services.json'), 'utf8'))
          for (const sv of Object.values(s.services || {}) as { public_url?: string; public?: { auth?: string } }[])
            if (sv.public_url && sv.public?.auth === 'required') map[new URL(sv.public_url).host] = s.project
        } catch {}
      }
      hostMap = { at: now(), map }
    }
    return hostMap.map[host] || null
  }
  /** A person's role on a project, or null: the owner is owner everywhere; anyone else needs a live grant. */
  const roleOn = (user: string, project: string | null): Role | null => {
    const u = users[user]; if (!u || !project) return null
    if (u.owner) return 'owner'
    const g = grants.find((x) => x.name === user && x.project === project && (!x.expires || Date.parse(x.expires) > now()))
    return g ? g.role : null
  }
  const cookies = (req: Request) => Object.fromEntries((req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))] }))
  const secure = (req: Request) => (req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:' ? '; Secure' : '')
  const setCookie = (req: Request, name: string, value: string, maxAge: number, sameSite: 'Lax' | 'Strict') =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(maxAge / 1000)}${secure(req)}`
  const headers = { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers, ...extra } })
  const html = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers, ...extra } })
  // the browser's address: Cloudflare's CF-Connecting-IP (Cloudflare sets it, and the router's 443 takes only
  // Cloudflare's ranges), else the socket peer. Never X-Forwarded-For: anyone can send it (sy-lbe, sy-76e).
  const ipOf = (req: Request, srv?: { requestIP?: (r: Request) => { address: string } | null }) => req.headers.get('cf-connecting-ip')?.trim() || srv?.requestIP?.(req)?.address || '?'
  const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  const signAssertion = (user: string, role: Role, host: string) => {
    const body = Buffer.from(JSON.stringify({ u: user, r: role, h: host, exp: now() + ASSERT_MS, n: randomBytes(6).toString('hex') })).toString('base64url')
    return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`
  }
  const mintBoardCode = (sessionKey: string, host: string, back: string) => {
    const c = randomBytes(24).toString('base64url'); boardCodes.set(h(c), { session: sessionKey, host, back, exp: now() + BOARD_CODE_MS }); return c
  }
  const sessionFrom = (req: Request, name: string) => { const v = cookies(req)[name]; if (!v) return null; const k = h(v), s = sessions[k]; return s && s.expires > now() && users[s.user] ? { k, s } : null }
  const safeBack = (r: string | null) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/')
  const newSession = (user: string) => { const id = randomBytes(32).toString('base64url'), k = h(id); sessions[k] = { user, created: now(), expires: now() + SESSION_MS }; return { id, k } }
  const callbackFor = (k: string, user: string, board: string, back: string) =>
    board && roleOn(user, projectOf(board)) ? `https://${board}/_mm/auth/callback?c=${mintBoardCode(k, board, back)}` : null
  // a form POST must be JSON from the gateway's own pages (no cross-site form can send that)
  const formOk = (req: Request) => req.method === 'POST' && /^application\/json\b/.test(req.headers.get('content-type') || '') &&
    (!req.headers.get('origin') || new URL(req.headers.get('origin')!).host === (req.headers.get('x-forwarded-host') || new URL(req.url).host))
  // the same work whether or not the name exists, so the answer's timing doesn't tell
  const DUMMY = Bun.password.hashSync(randomBytes(16).toString('hex'), { algorithm: 'argon2id' })

  async function http(req: Request, srv?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> {
    const u = new URL(req.url), host = req.headers.get('x-forwarded-host') || u.host, path = u.pathname
    // forward-auth: the web proxy asks for every request to a board host
    if (path === '/verify') {
      const fwdUri = req.headers.get('x-forwarded-uri') || '/'
      if (fwdUri.startsWith('/_mm/auth/')) return new Response(null, { status: 200 }) // the callback itself goes to us
      const project = projectOf(host)
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1]
      if (bearer) { // a tool: its token is for one project; nothing else is tried
        const t = tokens[h(bearer)], role = t && t.expires > now() && t.project === project ? roleOn(t.user, project) : null
        if (role) return new Response(null, { status: 200, headers: { 'x-mm-assertion': signAssertion(t.user, role, host), 'x-board-user': t.user, 'x-board-role': role } })
        log('warn', 'bearer refused', { host, token: short(bearer) })
        return new Response('invalid token', { status: 401, headers: { 'x-mm-assertion': '-', 'x-board-user': '-', 'x-board-role': '-', 'www-authenticate': 'Bearer' } })
      }
      const bs = sessionFrom(req, 'mm_board'), role = bs && bs.s.host === host ? roleOn(bs.s.user, project) : null
      if (role) return new Response(null, { status: 200, headers: { 'x-mm-assertion': signAssertion(bs!.s.user, role, host), 'x-board-user': bs!.s.user, 'x-board-role': role } })
      const to = `https://${authHost}/s?b=${encodeURIComponent(host)}&r=${encodeURIComponent(safeBack(fwdUri))}`
      return new Response(null, { status: 302, headers: { location: to, 'x-mm-assertion': '-', 'x-board-user': '-', 'x-board-role': '-' } }) // always set: an empty one would be dropped, and a client's copy could pass
    }
    // a board host: its one-time callback code -> that board's own cookie
    if (path === '/_mm/auth/callback') {
      const c = u.searchParams.get('c') || '', k = h(c), bc = boardCodes.get(k)
      boardCodes.delete(k) // single use, whatever happens next
      if (!bc || bc.exp < now() || bc.host !== host || !sessions[bc.session]) { log('warn', 'board callback refused', { host, code: short(c) }); return new Response('Sign-in expired. Open the board again.', { status: 403, headers }) }
      const p = sessions[bc.session], id = randomBytes(32).toString('base64url')
      sessions[h(id)] = { user: p.user, created: now(), expires: Math.min(p.expires, now() + SESSION_MS), host, parent: bc.session }
      save(); log('info', 'board session', { user: p.user, host })
      return new Response(null, { status: 302, headers: { location: safeBack(bc.back), 'set-cookie': setCookie(req, 'mm_board', id, SESSION_MS, 'Strict'), ...headers } })
    }
    if (path === '/s/app.js') return new Response(APP_JS, { headers: { 'content-type': 'text/javascript', ...headers } })
    // sign in
    if (path === '/s' && req.method === 'GET') {
      const board = u.searchParams.get('b') || '', back = safeBack(u.searchParams.get('r')), live = sessionFrom(req, 'mm_auth')
      const next = live && callbackFor(live.k, live.s.user, board, back)
      if (next) return new Response(null, { status: 302, headers: { location: next, ...headers } })
      return html(signInPage(board, live ? live.s.user : ''))
    }
    if (path === '/s' && req.method === 'POST') {
      if (!formOk(req)) return json({ error: 'bad request' }, 400)
      const b = await req.json().catch(() => ({})) as Record<string, unknown>, ip = ipOf(req, srv)
      const name = String(b.name || '').trim().toLowerCase(), password = String(b.password || ''), board = String(b.b || ''), back = safeBack(String(b.r || '/'))
      if (limited(`login-ip:${ip}`, 20, 10 * 60e3) || limited(`login:${name}`, 5, 10 * 60e3)) { log('warn', 'sign-in limited', { user: name, ip }); return json({ error: 'Too many attempts. Wait ten minutes.' }, 429) }
      const usr = users[name], ok = await Bun.password.verify(password, usr?.hash || DUMMY)
      if (!usr?.hash || !ok) { log('warn', 'sign-in refused', { user: name, ip }); return json({ error: 'Wrong name or password.' }, 401) }
      const s = newSession(name); usr.last_signin = new Date().toISOString(); save()
      log('info', 'signed in', { user: name, ip, board })
      const res = json({ ok: true, next: callbackFor(s.k, name, board, back) })
      res.headers.append('set-cookie', setCookie(req, 'mm_auth', s.id, SESSION_MS, 'Lax'))
      return res
    }
    if (path === '/s/out' && req.method === 'POST') {
      if (!formOk(req)) return json({ error: 'bad request' }, 400)
      const live = sessionFrom(req, 'mm_auth')
      if (live) { for (const [k, s] of Object.entries(sessions)) if (k === live.k || s.parent === live.k) delete sessions[k]; save(); log('info', 'signed out', { user: live.s.user }) }
      return json({ ok: true }, 200, { 'set-cookie': 'mm_auth=; Path=/; Max-Age=0' })
    }
    // an invite: set the password
    if (path === '/i' && req.method === 'GET') return html(invitePage())
    if (path === '/i' && req.method === 'POST') {
      if (!formOk(req)) return json({ error: 'bad request' }, 400)
      const b = await req.json().catch(() => ({})) as Record<string, unknown>, ip = ipOf(req, srv)
      if (limited(`invite-ip:${ip}`, 20, 10 * 60e3)) return json({ error: 'Too many attempts. Wait ten minutes.' }, 429)
      const inv = String(b.invite || ''), password = String(b.password || ''), k = h(inv)
      const usr = Object.values(users).find((x) => x.invite && sameHash(x.invite.hash, k) && x.invite.expires > now())
      if (!usr) { log('warn', 'invite refused', { invite: short(inv), ip }); return json({ error: 'This invite link is not valid any more. Ask for a new one.' }, 404) }
      if (password.length < MIN_PASSWORD) return json({ error: `At least ${MIN_PASSWORD} characters, please.` }, 400)
      if (password.toLowerCase().includes(usr.name)) return json({ error: 'The password must not contain your name.' }, 400)
      usr.hash = await Bun.password.hash(password, { algorithm: 'argon2id' }); delete usr.invite // burnt with the same write
      for (const [sk, s] of Object.entries(sessions)) if (s.user === usr.name) delete sessions[sk] // a new password ends the old sessions
      const s = newSession(usr.name); usr.last_signin = new Date().toISOString(); save()
      log('info', 'password set', { user: usr.name, ip })
      return json({ ok: true, name: usr.name }, 200, { 'set-cookie': setCookie(req, 'mm_auth', s.id, SESSION_MS, 'Lax') })
    }
    return new Response('not found', { status: 404, headers })
  }

  // the socket API: only `mm user|grant|revoke|token` (same user; the socket is 0600 in a 0700 folder)
  // names a person can't take: the system's actors, the leads, and the owner's name (unless it is the owner)
  const NAME = /^[a-z][a-z0-9._-]{1,31}$/, RESERVED = new Set(['wake', 'watchdog', 'brain', 'ui', 'beads', 'smoke', 'system', 'admin', 'setup', 'guest', 'human', 'owner', 'ops', 'review', 'platform',
    'sentinel', 'steward', 'assistant', 'mm', 'root', 'bridge'])
  const PROJECT = /^[a-z][a-z0-9-]{0,62}$/
  const inviteLink = (u: User) => { const t = randomBytes(32).toString('base64url'); u.invite = { hash: h(t), expires: now() + INVITE_MS }; return `https://${authHost}/i#${t}` }
  async function api(req: Request): Promise<Response> {
    const u = new URL(req.url), b = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
    const caller = String(b.by || u.searchParams.get('by') || 'cli'), name = String(b.name || '').trim().toLowerCase()
    if (u.pathname === '/user/add') {
      const owner = b.owner === true
      if (!NAME.test(name) || (RESERVED.has(name) && !(owner && name === 'owner')) || (!owner && name === ownerName.toLowerCase())) return json({ error: `${name}: not a usable name` }, 400)
      if (owner && Object.values(users).some((x) => x.owner && x.name !== name)) return json({ error: 'there is an owner already' }, 409)
      const existing = users[name]
      if (existing?.hash && !b.reinvite) return json({ error: `${name} exists (a new link replaces their password: --reinvite)` }, 409)
      const usr: User = existing || { name, created: new Date().toISOString(), by: caller, ...(owner ? { owner: true } : {}) }
      if (b.reinvite) delete usr.hash
      users[name] = usr; const link = inviteLink(usr)
      for (const [k, s] of Object.entries(sessions)) if (s.user === name) delete sessions[k]
      save(); log('info', existing ? 'invite renewed' : 'user added', { user: name, owner, by: caller })
      return json({ ok: true, name, owner, link, expires: new Date(usr.invite!.expires).toISOString() })
    }
    if (u.pathname === '/user/rm') {
      if (!users[name]) return json({ error: `no user ${name}` }, 404)
      delete users[name]; grants = grants.filter((g) => g.name !== name)
      for (const [k, s] of Object.entries(sessions)) if (s.user === name) delete sessions[k]
      for (const [k, t] of Object.entries(tokens)) if (t.user === name) delete tokens[k]
      save(); log('info', 'user removed', { user: name, by: caller }); return json({ ok: true })
    }
    if (u.pathname === '/user/ls') return json(Object.values(users).map((x) => ({
      name: x.name, owner: !!x.owner, password: !!x.hash, invite: x.invite ? new Date(x.invite.expires).toISOString() : null,
      grants: x.owner ? 'owner (every project)' : grants.filter((g) => g.name === x.name).map((g) => `${g.project}:${g.role}`).join(', '),
      tokens: Object.values(tokens).filter((t) => t.user === x.name).length, last_signin: x.last_signin || null })))
    if (u.pathname === '/grant') {
      const project = String(b.project || ''), role = guestRole(b.role), days = Number(b.days || 0)
      if (!users[name]) return json({ error: `no user ${name} (mm user add ${name})` }, 404)
      if (users[name].owner) return json({ error: `${name} is the owner (every project already)` }, 400)
      if (!PROJECT.test(project)) return json({ error: 'a project id (mm ls)' }, 400)
      const g: Grant = { name, project, role, created: new Date().toISOString(), by: caller, ...(days > 0 ? { expires: new Date(now() + days * 864e5).toISOString() } : {}) }
      grants = [...grants.filter((x) => !(x.name === name && x.project === project)), g]; save()
      log('info', 'granted', { user: name, project, role, by: caller }); return json({ ok: true, grant: g })
    }
    if (u.pathname === '/revoke') {
      const project = b.project ? String(b.project) : null
      const before = grants.length; grants = grants.filter((g) => !(g.name === name && (!project || g.project === project)))
      if (grants.length === before) return json({ error: `no grant for ${name}${project ? ` on ${project}` : ''}` }, 404)
      for (const [k, t] of Object.entries(tokens)) if (t.user === name && (!project || t.project === project)) delete tokens[k]
      if (!project) for (const [k, s] of Object.entries(sessions)) if (s.user === name) delete sessions[k] // all projects: their sessions end too
      save(); log('info', 'revoked', { user: name, project: project || 'all', by: caller }); return json({ ok: true })
    }
    if (u.pathname === '/token') {
      const project = String(b.project || ''), days = Number(b.days || TOKEN_DAYS)
      if (!users[name]) return json({ error: `no user ${name}` }, 404)
      if (!roleOn(name, project)) return json({ error: `${name} has no grant on ${project}` }, 403)
      if (!(days >= 1 && days <= 365)) return json({ error: 'days: 1 to 365' }, 400)
      const t = `mmt_${randomBytes(32).toString('base64url')}`
      tokens[h(t)] = { user: name, project, created: now(), expires: now() + days * 864e5, ...(b.label ? { label: String(b.label).slice(0, 60) } : {}) }
      save(); log('info', 'token made', { user: name, project, days, token: short(t), by: caller })
      return json({ ok: true, token: t, project, expires: new Date(now() + days * 864e5).toISOString() })
    }
    if (u.pathname === '/grants') return json(grants)
    if (u.pathname === '/sessions') return json(Object.values(sessions).map((s) => ({ user: s.user, host: s.host || authHost, created: new Date(s.created).toISOString(), expires: new Date(s.expires).toISOString() })))
    return json({ error: 'unknown' }, 404)
  }
  return { http, api, authHost, publicKey: publicKeyPem }
}

export function serve() {
  const g = gateway(), c = loadConfig()
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
const STYLE = 'font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;line-height:1.5'
const FIELD = 'display:block;width:100%;box-sizing:border-box;padding:.5rem;margin:.25rem 0 1rem;font-size:1rem'
function signInPage(board: string, signedInAs: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<body style="${STYLE}"><h1 style="font-size:1.4rem">Sign in${board ? ` to ${esc(board)}` : ''}</h1>
${signedInAs ? `<p>You are signed in as <b>${esc(signedInAs)}</b>, but you have no access to this board. Ask the owner, or sign in as someone else.</p>` : ''}
<form id="signin"><label>Name<input name="name" autocomplete="username" required style="${FIELD}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required style="${FIELD}"></label>
<button style="padding:.5rem 1rem;font-size:1rem">Sign in</button></form><p id="msg" style="color:#a00"></p>
<script src="/s/app.js"></script>`
}
function invitePage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set your password</title>
<body style="${STYLE}"><h1 style="font-size:1.4rem">Set your password</h1>
<p>Choose a password of at least ${MIN_PASSWORD} characters. You sign in with your name and this password.</p>
<form id="invite"><label>Password<input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required style="${FIELD}"></label>
<label>The same again<input name="again" type="password" autocomplete="new-password" required style="${FIELD}"></label>
<button style="padding:.5rem 1rem;font-size:1rem">Set password</button></form><p id="msg" style="color:#a00"></p>
<script src="/s/app.js"></script>`
}
// one script for both pages (CSP: script-src 'self'). The invite token comes from the fragment and goes in the body.
const APP_JS = `(function(){var msg=document.getElementById('msg');function post(url,body){return fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){j.status=r.status;return j})})}
var si=document.getElementById('signin');if(si)si.onsubmit=function(e){e.preventDefault();var q=new URLSearchParams(location.search);post('/s',{name:si.name.value,password:si.password.value,b:q.get('b')||'',r:q.get('r')||'/'}).then(function(j){if(j.ok){if(j.next)location.href=j.next;else msg.textContent='Signed in. You have no board here yet.';}else msg.textContent=j.error||'Not signed in.'})};
var iv=document.getElementById('invite');if(iv){var t=location.hash.slice(1);history.replaceState(null,'',location.pathname);iv.onsubmit=function(e){e.preventDefault();if(iv.password.value!==iv.again.value){msg.textContent='The two passwords are not the same.';return}post('/i',{invite:t,password:iv.password.value}).then(function(j){if(j.ok){msg.style.color='#060';msg.textContent='Done. You are signed in as '+j.name+'. Open your board again.';iv.remove()}else msg.textContent=j.error||'Not set.'})}}})()`
