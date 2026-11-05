// mm.auth: one sign-in for every board, by a code on the screen approved over the chat bot (or `mm auth approve`).
// No token in a link, no password: a code grants nothing by itself. Design: docs/auth-gateway.md.
//   HTTP (loopback, and bind_host for the web proxy in docker):
//     GET /s?b=<board host>&r=<path>   sign-in page: a code (8 chars, 5 min, single use, bound to this browser)
//     GET /s/poll                      the waiting page: approved -> session (mm_auth) and the board's callback
//     GET /_mm/auth/callback?c=…       on a board host: a one-time code -> that board's own cookie (mm_board)
//     GET /verify                      the web proxy's forward-auth: 200 + a signed assertion, or 302 to sign in
//   Socket ($MM_HOME/run/auth.sock, 0600): approve, pending, grant, revoke, grants, sessions (the bot, `mm auth`).
// State: $MM_HOME/auth/ (0700): grants.json, sessions.json, signing.key (0600 each); pending codes live in memory.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'

export const AUTH_DIR = join(DIRS.mm, 'auth')
export const AUTH_SOCK = join(DIRS.mm, 'run', 'auth.sock')
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U
const CODE_MS = Number(process.env.MM_AUTH_CODE_MS) || 5 * 60e3, SESSION_MS = 12 * 3600e3, BOARD_CODE_MS = 30e3, ASSERT_MS = 60e3
const ROLES = ['owner', 'member', 'viewer'] as const
type Role = typeof ROLES[number]
export interface Grant { name: string; telegram_id?: string; scope: string[]; role: Role; expires?: string; created: string; by: string }
interface Session { user: string; role: Role; scope: string[]; created: number; expires: number; host?: string; parent?: string }
interface Pending { id: string; code: string; board: string; back: string; created: number; ip: string; ua: string; approved?: { user: string; role: Role; scope: string[] } }

const h = (s: string) => createHash('sha256').update(s).digest('hex')
const short = (s: string) => h(s).slice(0, 6) // what logs carry instead of a code, cookie or session id
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
  let grants: Grant[] = readJson('grants.json', [])
  const sessions: Record<string, Session> = readJson('sessions.json', {}) // key: sha256(session id)
  const pending = new Map<string, Pending>()    // sha256(pending id) -> pending
  const byCode = new Map<string, string>()      // sha256(code) -> sha256(pending id)
  const boardCodes = new Map<string, { session: string; host: string; back: string; exp: number }>() // sha256(code) -> …
  const hits = new Map<string, number[]>()
  const save = () => { writeAtomic(join(AUTH_DIR, 'grants.json'), JSON.stringify(grants, null, 1)); writeAtomic(join(AUTH_DIR, 'sessions.json'), JSON.stringify(sessions)) }
  const limited = (k: string, n: number, ms: number) => { const t = now(), a = (hits.get(k) || []).filter((x) => t - x < ms); a.push(t); hits.set(k, a); return a.length > n }
  const sweep = () => {
    const t = now()
    for (const [k, p] of pending) if (t - p.created > CODE_MS) { pending.delete(k); byCode.delete(h(p.code)) }
    for (const [k, c] of boardCodes) if (c.exp < t) boardCodes.delete(k)
    let dirty = false
    for (const [k, s] of Object.entries(sessions)) if (s.expires < t) { delete sessions[k]; dirty = true }
    grants = grants.filter((g) => !g.expires || Date.parse(g.expires) > t)
    if (dirty) save()
  }
  setInterval(sweep, 30e3).unref?.()

  const cfg = loadConfig(), domain = String(getPath(cfg, 'domain') ?? '')
  const authHost = String(getPath(cfg, 'auth_host') ?? (domain ? `auth.${domain}` : 'auth.localhost'))
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
  const inScope = (scope: string[], project: string | null) => !!project && (scope.includes('all') || scope.includes(project))
  const grantOf = (user: string) => grants.find((g) => g.name === user && (!g.expires || Date.parse(g.expires) > now()))
  const ownerId = String(getPath(cfg, 'telegram.owner_id') ?? ''), ownerName = String(getPath(cfg, 'owner_name') ?? 'owner')
  const cookies = (req: Request) => Object.fromEntries((req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))] }))
  const secure = (req: Request) => (req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:' ? '; Secure' : '')
  const setCookie = (req: Request, name: string, value: string, maxAge: number, sameSite: 'Lax' | 'Strict') =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(maxAge / 1000)}${secure(req)}`
  const headers = { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers, ...extra } })
  // the browser's address: Cloudflare's CF-Connecting-IP (Cloudflare sets it, and the router's 443 takes only
  // Cloudflare's ranges), else the socket peer. Never X-Forwarded-For: anyone can send it (sy-lbe, sy-76e).
  const ipOf = (req: Request, srv?: { requestIP?: (r: Request) => { address: string } | null }) => req.headers.get('cf-connecting-ip')?.trim() || srv?.requestIP?.(req)?.address || '?'
  const newCode = () => { let c = ''; const b = randomBytes(8); for (let i = 0; i < 8; i++) c += ALPHABET[b[i] & 31]; return `${c.slice(0, 4)}-${c.slice(4)}` }
  const normCode = (c: string) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/^(.{4})(.{4})$/, '$1-$2')
  const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  const signAssertion = (user: string, role: Role, host: string) => {
    const body = Buffer.from(JSON.stringify({ u: user, r: role, h: host, exp: now() + ASSERT_MS, n: randomBytes(6).toString('hex') })).toString('base64url')
    return `${body}.${sign(null, Buffer.from(body), key).toString('base64url')}`
  }
  const mintBoardCode = (sessionKey: string, host: string, back: string) => {
    const c = randomBytes(24).toString('base64url'); boardCodes.set(h(c), { session: sessionKey, host, back, exp: now() + BOARD_CODE_MS }); return c
  }
  const sessionFrom = (req: Request, name: string) => { const v = cookies(req)[name]; if (!v) return null; const k = h(v), s = sessions[k]; return s && s.expires > now() ? { k, s } : null }
  const safeBack = (r: string | null) => (r && r.startsWith('/') && !r.startsWith('//') ? r : '/')

  async function http(req: Request, srv?: { requestIP?: (r: Request) => { address: string } | null }): Promise<Response> {
    const u = new URL(req.url), host = req.headers.get('x-forwarded-host') || u.host, path = u.pathname
    // forward-auth: the web proxy asks for every request to a board host
    if (path === '/verify') {
      const fwdUri = req.headers.get('x-forwarded-uri') || '/'
      if (fwdUri.startsWith('/_mm/auth/')) return new Response(null, { status: 200 }) // the callback itself goes to us
      const project = projectOf(host), bs = sessionFrom(req, 'mm_board')
      const ok = bs && bs.s.host === host && inScope(bs.s.scope, project) && (bs.s.role === 'owner' || grantOf(bs.s.user))
      if (ok) {
        const g = grantOf(bs!.s.user), role = (bs!.s.role === 'owner' ? 'owner' : g?.role || bs!.s.role) as Role
        return new Response(null, { status: 200, headers: { 'x-mm-assertion': signAssertion(bs!.s.user, role, host), 'x-board-user': bs!.s.user, 'x-board-role': role } })
      }
      const to = `https://${authHost}/s?b=${encodeURIComponent(host)}&r=${encodeURIComponent(safeBack(fwdUri))}`
      return new Response(null, { status: 302, headers: { location: to, 'x-mm-assertion': '-', 'x-board-user': '-', 'x-board-role': '-' } }) // always set: an empty one would be dropped, and a client's copy could pass
    }
    // a board host: its one-time callback code -> that board's own cookie
    if (path === '/_mm/auth/callback') {
      const c = u.searchParams.get('c') || '', k = h(c), bc = boardCodes.get(k)
      boardCodes.delete(k) // single use, whatever happens next
      if (!bc || bc.exp < now() || bc.host !== host || !sessions[bc.session]) { log('warn', 'board callback refused', { host, code: short(c) }); return new Response('Sign-in expired. Open the board again.', { status: 403, headers }) }
      const p = sessions[bc.session], id = randomBytes(32).toString('base64url')
      sessions[h(id)] = { user: p.user, role: p.role, scope: p.scope, created: now(), expires: Math.min(p.expires, now() + SESSION_MS), host, parent: bc.session }
      save(); log('info', 'board session', { user: p.user, host })
      return new Response(null, { status: 302, headers: { location: safeBack(bc.back), 'set-cookie': setCookie(req, 'mm_board', id, SESSION_MS, 'Strict'), ...headers } })
    }
    // the sign-in page and its poll live on the auth host
    if (path === '/s') {
      const board = u.searchParams.get('b') || '', back = safeBack(u.searchParams.get('r'))
      const live = sessionFrom(req, 'mm_auth')
      if (live && inScope(live.s.scope, projectOf(board)))
        return new Response(null, { status: 302, headers: { location: `https://${board}/_mm/auth/callback?c=${mintBoardCode(live.k, board, back)}`, ...headers } })
      const ip = ipOf(req, srv)
      if (limited(`issue:${ip}`, 10, 10 * 60e3)) { log('warn', 'code issuing limited', { ip }); return new Response('Too many sign-in attempts from here. Wait a few minutes.', { status: 429, headers }) }
      const id = randomBytes(32).toString('base64url'), code = newCode()
      const p: Pending = { id: h(id), code, board, back, created: now(), ip, ua: (req.headers.get('user-agent') || '').slice(0, 160) }
      pending.set(p.id, p); byCode.set(h(code), p.id)
      log('info', 'code issued', { board, code: short(code), ip })
      return new Response(page(code, board), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': setCookie(req, 'mm_pending', id, CODE_MS, 'Lax'), ...headers } })
    }
    if (path === '/s/app.js') return new Response(APP_JS, { headers: { 'content-type': 'text/javascript', ...headers } })
    if (path === '/s/poll') {
      const v = cookies(req).mm_pending, p = v ? pending.get(h(v)) : undefined
      if (!p || now() - p.created > CODE_MS) return json({ state: 'expired' }, 410)
      if (!p.approved) return json({ state: 'waiting' })
      pending.delete(p.id); byCode.delete(h(p.code))
      const id = randomBytes(32).toString('base64url'), k = h(id) // a new id, never the pending one
      sessions[k] = { user: p.approved.user, role: p.approved.role, scope: p.approved.scope, created: now(), expires: now() + SESSION_MS }
      save(); log('info', 'signed in', { user: p.approved.user, board: p.board })
      const next = inScope(p.approved.scope, projectOf(p.board)) ? `https://${p.board}/_mm/auth/callback?c=${mintBoardCode(k, p.board, p.back)}` : null
      const res = json({ state: 'approved', next })
      res.headers.append('set-cookie', setCookie(req, 'mm_auth', id, SESSION_MS, 'Lax')); res.headers.append('set-cookie', 'mm_pending=; Path=/; Max-Age=0')
      return res
    }
    return new Response('not found', { status: 404, headers })
  }

  // the socket API: only the bot and `mm auth` (same user; the socket is 0600 in a 0700 folder)
  // names a guest can't take: the system's actors, the leads, and the owner's own name (so nobody signs in as them)
  const NAME = /^[a-z][a-z0-9._-]{1,31}$/, RESERVED = new Set(['wake', 'watchdog', 'brain', 'ui', 'beads', 'smoke', 'system', 'admin', 'setup', 'guest', 'human', 'owner', 'ops', 'review', 'platform',
    'sentinel', 'steward', 'assistant', 'mm', 'root', 'bridge', ownerName.toLowerCase()])
  async function api(req: Request): Promise<Response> {
    const u = new URL(req.url), b = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {}
    const caller = String(b.by || u.searchParams.get('by') || 'cli')
    if (u.pathname === '/pending') { // what the bot shows before a self-approval ("This is me")
      const pid = byCode.get(h(normCode(String(u.searchParams.get('code'))))), p = pid ? pending.get(pid) : undefined
      return p ? json({ board: p.board, ip: p.ip, ua: p.ua, age_s: Math.round((now() - p.created) / 1000) }) : json({ error: 'no such code' }, 404)
    }
    if (u.pathname === '/approve') {
      const code = normCode(String(b.code)), who = String(b.telegram_id || b.as || '')
      if (limited(`approve:${who}`, 5, 10 * 60e3) || limited('approve:all', 100, 3600e3)) { log('warn', 'approvals limited', { by: caller }); return json({ error: 'too many attempts; wait' }, 429) }
      const pid = byCode.get(h(code)), p = pid ? pending.get(pid) : undefined
      if (!p || !sameHash(h(p.code), h(code)) || now() - p.created > CODE_MS || p.approved) { log('warn', 'approval refused: unknown or used code', { by: caller, code: short(code) }); return json({ error: 'no such code (or expired, or used)' }, 404) }
      let user: string, role: Role, scope: string[]
      if (b.as) { // the owner approves someone on the spot: a named grant
        const name = String(b.as)
        if (!NAME.test(name) || RESERVED.has(name)) return json({ error: `${name}: not a usable name` }, 400)
        role = (b.role === 'viewer' ? 'viewer' : 'member') as Role; scope = String(b.scope || '').split(',').filter(Boolean) // never owner
        if (!scope.length) return json({ error: 'scope: a project, several (a,b) or all' }, 400)
        // an on-the-spot grant always ends: no days given = 7; 0 (no end) is refused here, as by the bridge. Only
        // /grant, the owner's deliberate grant, may have no end (days 0).
        if (b.days !== undefined && !(Number(b.days) >= 1 && Number(b.days) <= 365)) return json({ error: 'an approval needs an end: 1 to 365 days (an open-ended grant is mm auth grant)' }, 400)
        const days = Number(b.days ?? 7), g: Grant = { name, scope, role, created: new Date().toISOString(), by: caller, ...(days > 0 ? { expires: new Date(now() + days * 864e5).toISOString() } : {}) }
        grants = [...grants.filter((x) => x.name !== name), g]; user = name
      } else if (ownerId && String(b.telegram_id) === ownerId) { // the owner, for themselves
        user = ownerName; role = 'owner'; scope = ['all']
      } else { // a granted person approves their own code
        const g = grants.find((x) => x.telegram_id && x.telegram_id === String(b.telegram_id) && (!x.expires || Date.parse(x.expires) > now()))
        if (!g) { log('warn', 'approval refused: no grant', { by: caller }); return json({ error: 'no grant for this identity' }, 403) }
        user = g.name; role = g.role; scope = g.scope
      }
      p.approved = { user, role, scope }; byCode.delete(h(p.code)) // burnt: a second approval finds nothing
      save(); log('info', 'approved', { user, role, scope: scope.join(','), board: p.board, by: caller, code: short(code) })
      return json({ ok: true, user, role, scope, board: p.board })
    }
    if (u.pathname === '/grant') {
      const name = String(b.name || ''), scope = String(b.scope || '').split(',').filter(Boolean), role = (b.role === 'viewer' ? 'viewer' : 'member') as Role
      if (!NAME.test(name) || RESERVED.has(name) || !scope.length) return json({ error: 'name and scope needed' }, 400)
      const days = Number(b.days || 0), g: Grant = { name, scope, role, created: new Date().toISOString(), by: caller, ...(b.telegram_id ? { telegram_id: String(b.telegram_id) } : {}), ...(days > 0 ? { expires: new Date(now() + days * 864e5).toISOString() } : {}) }
      grants = [...grants.filter((x) => x.name !== name), g]; save(); log('info', 'granted', { user: name, role, scope: scope.join(','), by: caller })
      return json({ ok: true, grant: g })
    }
    if (u.pathname === '/revoke') {
      const name = String(b.name || ''), scope = b.scope ? String(b.scope) : null
      if (name === 'all') { for (const k of Object.keys(sessions)) delete sessions[k]; save(); log('info', 'revoked all sessions', { by: caller }); return json({ ok: true }) }
      const g = grantOf(name); if (!g) return json({ error: `no grant ${name}` }, 404)
      if (scope) g.scope = g.scope.filter((s) => s !== scope); if (!scope || !g.scope.length) grants = grants.filter((x) => x.name !== name)
      for (const [k, s] of Object.entries(sessions)) if (s.user === name) delete sessions[k] // their sessions end at once
      save(); log('info', 'revoked', { user: name, scope: scope || 'all', by: caller })
      return json({ ok: true })
    }
    if (u.pathname === '/grants') return json(grants)
    if (u.pathname === '/sessions') return json(Object.values(sessions).map((s) => ({ user: s.user, role: s.role, host: s.host || authHost, created: new Date(s.created).toISOString(), expires: new Date(s.expires).toISOString() })))
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

/** Call the running gateway's socket API (mm auth …). */
export async function callApi(path: string, body?: Record<string, unknown>) {
  const r = await fetch(`http://auth${path}`, { unix: AUTH_SOCK, method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined } as RequestInit)
  return { status: r.status, data: await r.json().catch(() => ({})) }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
function page(code: string, board: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">Sign in to ${esc(board)}</h1>
<p>Send this code to the bot, or give it to the owner to approve:</p>
<p id="code" style="font:700 2.4rem ui-monospace,monospace;letter-spacing:.15em">${esc(code)}</p>
<p id="state" style="color:#555">Waiting for approval… (valid 5 minutes)</p>
<p style="color:#555;font-size:.9rem">The code does nothing by itself. Only approve a code you see on your own screen.</p>
<script src="/s/app.js"></script>`
}
const APP_JS = `(function poll(){fetch('/s/poll',{credentials:'same-origin'}).then(function(r){return r.json().then(function(j){
if(j.state==='approved'){document.getElementById('state').textContent='Approved. Opening the board…';if(j.next)location.href=j.next;return}
if(j.state==='expired'){document.getElementById('state').textContent='Expired. Reload for a new code.';return}
setTimeout(poll,2000)})}).catch(function(){setTimeout(poll,4000)})})()`
