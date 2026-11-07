// mm.front: the machine's local names (sockets first, sy-onx; docs/plans/sockets-first.md). Its own process (namespace
// mm), in place of portless when `front.enabled` is on (src/pc.ts writeBase): it listens on `portless_port` (1355) and
// routes `<service>.<project>.localhost` to the service's loopback port or its unix socket. It never signs anything,
// holds no key and reads no secret.
//   - It binds 127.0.0.1 and ::1 only: never bind_host, never a docker bridge (review's condition 1).
//   - It serves local names only: a host that does not end in .localhost is 404, and a board's public side (its
//     `-public` socket, a port mm gave a gated public side) is never a target (review's condition 2): that side stays
//     behind the gateway.
//   - Its table is mm's own files, $MM_HOME/front/routes/<project>.json, which mm up writes from resolve() (only mm
//     writes them: a project's .run/ is not read). Reloaded when the folder changes.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'

/** The front on (`mm config set front.enabled true`): mm.front takes portless_port and mm.portless is not started;
 *  host projects get ports from mm. Off (the default): portless, as before; turning it off is the rollback. */
export function frontEnabled(): boolean {
  const v = getPath(loadConfig(), 'front.enabled')
  return v === true || v === 'true'
}
export const frontDir = () => process.env.MM_FRONT_DIR || join(DIRS.mm, 'front', 'routes')
/** Where the front listens: loopback only, both families. Never configurable (review's condition 1). */
export const FRONT_HOSTS = ['127.0.0.1', '::1'] as const

export type Route = { host: string; port?: number; socket?: string }
/** One project's file: its local names, and the ports of its gated public sides (never a target, whoever names them). */
export type RouteFile = { project: string; routes: Route[]; public_ports?: number[]; held_ports?: number[] }

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const LOCAL_NAME = new RegExp(`^(?:${LABEL}\\.)+localhost$`)
/** Why the front won't take this route, or null. */
export function routeRefusal(r: Route, publicPorts: Set<number>): string | null {
  if (!r || typeof r.host !== 'string' || !LOCAL_NAME.test(r.host)) return `${r?.host}: not a local name (<name>.localhost)`
  if (r.socket !== undefined) {
    if (r.port !== undefined) return `${r.host}: a port and a socket`
    if (typeof r.socket !== 'string' || !r.socket.startsWith('/') || r.socket.includes('\0') || Buffer.byteLength(r.socket) > 107) return `${r.host}: not a socket path`
    if (/-public\.sock$/.test(r.socket)) return `${r.host}: a public side's socket (that side is reached only through the gateway)`
    return null
  }
  if (!Number.isInteger(r.port) || r.port! < 1024 || r.port! > 65535) return `${r.host}: no port 1024-65535 or socket`
  if (publicPorts.has(r.port!)) return `${r.host}: port ${r.port} is a public side's (reached only through the gateway)`
  return null
}

/** The route table from the folder: name -> target. The first file (by name) that names a host keeps it. */
export function loadRoutes(dir = frontDir()): { table: Map<string, Route>; refused: string[] } {
  const files: RouteFile[] = [], refused: string[] = []
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []) {
    try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RouteFile; if (j && Array.isArray(j.routes)) files.push(j); else refused.push(`${f}: no routes`) }
    catch (e) { refused.push(`${f}: ${(e as Error).message}`) }
  }
  const pub = new Set(files.flatMap((f) => (Array.isArray(f.public_ports) ? f.public_ports : []).filter(Number.isInteger)))
  const table = new Map<string, Route>()
  for (const f of files) for (const r of f.routes) {
    const why = routeRefusal(r, pub); if (why) { refused.push(`${f.project}: ${why}`); continue }
    if (table.has(r.host)) { refused.push(`${f.project}: ${r.host} is another project's already`); continue }
    table.set(r.host, r.socket ? { host: r.host, socket: r.socket } : { host: r.host, port: r.port })
  }
  return { table, refused }
}

/** One project's routes, written by mm (a temp name and a rename: the front never reads half a file). */
export function writeRoutes(rf: RouteFile, dir = frontDir()) {
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const f = join(dir, `${rf.project}.json`), body = JSON.stringify(rf, null, 2)
  try { if (readFileSync(f, 'utf8') === body) return } catch {}
  const tmp = join(dir, `.${rf.project}.${randomBytes(6).toString('hex')}.tmp`)
  try { writeFileSync(tmp, body, { mode: 0o644 }); renameSync(tmp, f) } catch (e) { rmSync(tmp, { force: true }); throw e }
}
/** The ports other projects hold (their route files' held_ports, routes and public ports): mm gives none of them out. */
export function heldPorts(except: string, dir = frontDir()): number[] {
  const out: number[] = []
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json') && x !== `${except}.json`) : []) {
    try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RouteFile
      out.push(...[...(j.held_ports || []), ...(j.public_ports || []), ...(j.routes || []).map((r) => r.port)].filter((x): x is number => Number.isInteger(x))) } catch {}
  }
  return out
}
export function removeRoutes(project: string, dir = frontDir()) { rmSync(join(dir, `${project}.json`), { force: true }) }

// request and response headers that belong to one hop, never passed on
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']
const strip = (h: Headers) => { for (const x of (h.get('connection') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) h.delete(x); for (const x of HOP) h.delete(x); return h }
const log = (level: string, msg: string) => console.error(JSON.stringify({ time: new Date().toISOString(), level, msg, service: 'mm.front' }))
/** The name a request asks for: its Host without the port, lower case. */
const nameOf = (host: string) => host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')

type WsData = { url: string; headers: Record<string, string>; protocols: string[]; up?: WebSocket; queue: (string | BufferSource)[] }

/** The front's request handler over a table that `get()` returns (tests call it with their own). */
export function handler(get: () => Map<string, Route>) {
  return async (req: Request, srv: import('bun').Server<WsData>): Promise<Response | undefined> => {
    const hostHdr = req.headers.get('host') || '', name = nameOf(hostHdr)
    const r = get().get(name)
    if (!r) return new Response(`mm front: no local name ${JSON.stringify(name).slice(0, 200)} here\n`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    const u = new URL(req.url), path = `${u.pathname}${u.search}`
    const ip = srv.requestIP(req)?.address || ''
    // the front is the local side's first hop: it says what it saw, it does not pass on what a client claims
    const headers = strip(new Headers(req.headers))
    headers.set('host', hostHdr); headers.set('x-forwarded-host', hostHdr); headers.set('x-forwarded-proto', 'http')
    if (ip) headers.set('x-forwarded-for', ip); else headers.delete('x-forwarded-for')
    if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      if (r.socket) return new Response('mm front: a websocket to a socket target is not supported yet\n', { status: 502 })
      const protocols = (req.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim()).filter(Boolean)
      const fwd: Record<string, string> = {}
      for (const [k, v] of headers) if (!/^sec-websocket-/.test(k)) fwd[k] = v
      const ok = srv.upgrade(req, { data: { url: `ws://127.0.0.1:${r.port}${path}`, headers: fwd, protocols, queue: [] }, ...(protocols[0] ? { headers: { 'sec-websocket-protocol': protocols[0] } } : {}) })
      return ok ? undefined : new Response('mm front: websocket upgrade failed\n', { status: 400 })
    }
    const target = r.socket ? `http://localhost${path}` : `http://127.0.0.1:${r.port}${path}`
    try {
      const res = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'manual', decompress: false, signal: req.signal, ...(r.socket ? { unix: r.socket } : {}) } as RequestInit)
      const out = strip(new Headers(res.headers))
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
    } catch (e) {
      if (req.signal.aborted) return new Response(null, { status: 499 })
      log('warn', `${name}: ${(e as Error).message}`)
      return new Response(`mm front: ${name} does not answer\n`, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
  }
}
const websocket: import('bun').WebSocketHandler<WsData> = {
  open(ws) {
    const d = ws.data
    const up = new WebSocket(d.url, { headers: d.headers, protocols: d.protocols } as unknown as string[])
    up.binaryType = 'arraybuffer'; d.up = up
    up.onopen = () => { for (const m of d.queue.splice(0)) up.send(m) }
    up.onmessage = (e) => ws.send(e.data as string | ArrayBuffer)
    up.onclose = (e) => { try { ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason) } catch {} }
    up.onerror = () => { try { ws.close(1011, 'upstream error') } catch {} }
  },
  message(ws, m) { const up = ws.data.up, x = m as string | BufferSource; if (up?.readyState === WebSocket.OPEN) up.send(x); else ws.data.queue.push(x) },
  close(ws, code, reason) { try { ws.data.up?.close(code === 1005 || code === 1006 ? 1000 : code, reason) } catch {} },
}

/** The kernel has ::1 up (IPv6 on, lo has it). */
const hasV6Loopback = () => { try { return /^0{31}1 /m.test(readFileSync('/proc/net/if_inet6', 'utf8')) } catch { return false } }
/** `mm front serve`: listen on 127.0.0.1 and ::1 (port: portless_port), route by the table, reload it on change. */
export async function serve(o: { port?: number; dir?: string } = {}) {
  const port = o.port ?? Number(getPath(loadConfig(), 'portless_port') ?? 1355), dir = o.dir ?? frontDir()
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  let table = new Map<string, Route>(), sig = ''
  const reload = () => {
    let s = ''
    try { s = readdirSync(dir).filter((x) => x.endsWith('.json')).sort().map((f) => { const st = statSync(join(dir, f)); return `${f}:${st.mtimeMs}:${st.size}:${st.ino}` }).join('|') } catch {}
    if (s === sig) return
    sig = s
    const l = loadRoutes(dir); table = l.table
    for (const x of l.refused) log('warn', `route refused: ${x}`)
    log('info', `routes: ${[...table.keys()].sort().join(' ') || 'none'}`)
  }
  reload()
  try { watch(dir, () => reload()) } catch {}
  setInterval(reload, 2000)
  const fetch = handler(() => table), on: string[] = []
  for (const hostname of FRONT_HOSTS) {
    try { Bun.serve<WsData>({ hostname, port, idleTimeout: 0, fetch, websocket }); on.push(hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`) }
    catch (e) {
      // no IPv6 loopback on this host (a container without it): 127.0.0.1 alone; anything else is fatal
      if (hostname === '::1' && !hasV6Loopback()) { log('warn', `no ::1 on this host: on 127.0.0.1 only`); continue }
      throw e
    }
  }
  log('info', `mm.front on ${on.join(', ')}; routes from ${dir}`)
}
