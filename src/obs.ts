// Observability: the machine's Victoria stack (metrics, logs, traces; loopback only, run by mm-pc in namespace mm),
// the log shipper (`mm ship`), queries for people and the brain (`mm obs ...`), and mm's own spans.
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, run, servicePath, toolPath, which } from './env'

export const DATA = join(DIRS.mm, 'data')
const cfgPort = (k: string, d: number) => Number(getPath(loadConfig(), k) ?? d)
export function obsPorts() { return { metrics: cfgPort('metrics_port', 8428), logs: cfgPort('logs_port', 9428), traces: cfgPort('traces_port', 10428) } }
export const obsInstalled = () => !!(which('victoria-metrics') && which('victoria-logs') && which('victoria-traces'))
/** Where engine code sends telemetry (env + .run/endpoints.json); empty when the stack is not installed. */
export function obsEndpoints() {
  if (!obsInstalled()) return {}
  const p = obsPorts(), h = '127.0.0.1'
  return {
    traces: `http://${h}:${p.traces}/insert/opentelemetry/v1/traces`,
    metrics: `http://${h}:${p.metrics}/api/v1/import/prometheus`,
    logs: `http://${h}:${p.logs}`,
    ui: { metrics: `http://${h}:${p.metrics}/vmui/`, logs: `http://${h}:${p.logs}/select/vmui/`, traces: `http://${h}:${p.traces}/select/vmui/` },
  }
}

/**
 * How process-compose writes every mm service's log file (namespace mm; sy-7e99). Without it, process-compose buffers
 * the file (4 KiB, so a quiet service's lines stay in its memory and never reach the shipper) and opens it truncated
 * at every start (the lines before a restart are gone). Flush each line; rotation also makes it append.
 */
export const MM_LOG_CONFIG = { add_timestamp: true, flush_each_line: true, rotation: { max_size_mb: 20, max_backups: 2 } }

/** Process-compose entries for the stack and the shipper (namespace mm). */
export function obsProcesses(): Record<string, unknown> {
  if (!obsInstalled()) return {}
  const p = obsPorts(), env = [`PATH=${servicePath()}`]
  mkdirSync(DATA, { recursive: true })
  const scrape = join(DIRS.pc, 'scrape.yaml')
  writeFileSync(scrape, `# Written by mm. VictoriaMetrics scrapes the stack itself; engine services push.\nscrape_configs:\n  - job_name: victoria\n    scrape_interval: 30s\n    static_configs:\n      - targets: ["127.0.0.1:${p.metrics}", "127.0.0.1:${p.logs}", "127.0.0.1:${p.traces}"]\n`)
  const svc = (name: string, cmd: string, port: number) => ({
    namespace: 'mm', command: cmd, environment: env, log_location: join(DIRS.pc, `${name}.log`),
    log_configuration: MM_LOG_CONFIG,
    availability: { restart: 'always', backoff_seconds: 3 },
    readiness_probe: { exec: { command: `curl -sf -o /dev/null --max-time 2 http://127.0.0.1:${port}/health` }, period_seconds: 5, failure_threshold: 20 },
  })
  const mm = which('mm') || join(DIRS.bin, 'mm')
  return {
    'mm.metrics': svc('metrics', `victoria-metrics -httpListenAddr=127.0.0.1:${p.metrics} -storageDataPath=${join(DATA, 'metrics')} -retentionPeriod=90d -promscrape.config=${scrape} -loggerFormat=json`, p.metrics),
    'mm.logs': svc('logs', `victoria-logs -httpListenAddr=127.0.0.1:${p.logs} -storageDataPath=${join(DATA, 'logs')} -retentionPeriod=30d -retention.maxDiskSpaceUsageBytes=20GiB -loggerFormat=json`, p.logs),
    'mm.traces': svc('traces', `victoria-traces -httpListenAddr=127.0.0.1:${p.traces} -storageDataPath=${join(DATA, 'traces')} -retentionPeriod=14d -retention.maxDiskSpaceUsageBytes=20GiB -loggerFormat=json`, p.traces),
    'mm.ship': { namespace: 'mm', command: `${mm} ship`, environment: env, log_location: join(DIRS.pc, 'ship.log'), log_configuration: MM_LOG_CONFIG,
      availability: { restart: 'always', backoff_seconds: 5 }, depends_on: { 'mm.logs': { condition: 'process_healthy' } } },
  }
}

// ---------- mm ship: service log files -> VictoriaLogs ----------
type Off = Record<string, { ino: number; off: number }>
const SHIP_STATE = join(DATA, 'ship.json')
/**
 * The files to ship: the process manager's own logs and every project's .run/logs/*.log. A box's (~/.mm/pc/boxes) are
 * written by the box, so (review sy-b15.7 3, sy-b15.6 2): each one is opened only if it really is that file (no
 * symlink, checked on the open file itself), and its records carry the box's project, whatever a line says. Its cron
 * log is the host's own (~/.mm/box/<project>/cron.log).
 */
type ShipFile = { f: string; project?: string; inside?: string }
function shipFiles(): ShipFile[] {
  const out: ShipFile[] = []
  const add = (d: string, project?: string, inside?: string) => { try { for (const f of readdirSync(d)) if (f.endsWith('.log')) out.push({ f: join(d, f), project, inside }) } catch {} }
  add(DIRS.pc)
  for (const [pdir, box] of [[join(DIRS.pc, 'projects'), false], [join(DIRS.pc, 'boxes'), true]] as const) for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith('.yaml')) : []) {
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(pdir, f), 'utf8'))
    if (!m) continue
    const root = m[1].replace(/^~(?=\/)/, HOME), project = f.replace(/\.yaml$/, '')
    if (!box) { add(join(root, '.run', 'logs')); continue }
    let real = ''; try { real = join(realpathSync(root), '.run', 'logs') } catch { continue }
    add(join(root, '.run', 'logs'), project, real)
    add(join(DIRS.mm, 'box', project), project)
    // its egress proxy's connection log (every site allowed or refused; sy-b15.1): the proxy writes it, so it is opened
    // the same careful way, and stamped with the box's project
    const eg = join(DIRS.mm, 'box', project, 'egress'); add(eg, project, eg)
  }
  return out
}
/** Open a log for reading; for a box's file, only the real file at its own path (O_NOFOLLOW, then the open file's path). */
function openLog(x: ShipFile): number | null {
  try {
    const fd = openSync(x.f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!x.inside || (fstatSync(fd).isFile() && readlinkSync(`/proc/self/fd/${fd}`) === join(x.inside, x.f.split('/').pop()!))) return fd
    closeSync(fd)
  } catch {}
  return null
}
/** One log line -> one record. Process-compose lines carry {process, message}; engine lines are JSON themselves. */
/** Lines a tool logs as errors that are not: Dolt's note that a client hung up (every restart and every bd command
 *  that exits makes one). Shipped as info, so they don't count as errors anywhere (mm obs errors, the sentinel). */
export const BENIGN = [/Error reading packet from client \d+.*use of closed network connection/, /io\.ReadFull\(header size\) failed/]
export function toRecord(line: string, file: string): Record<string, unknown> | null {
  if (!line.trim()) return null
  let r: Record<string, unknown>
  try { r = JSON.parse(line) } catch { r = { msg: line } }
  const inner = typeof r.message === 'string' && r.message.startsWith('{') ? (() => { try { return JSON.parse(r.message as string) } catch { return null } })() : null
  const proc = String(r.process || '')
  const [project, service] = proc.includes('.') ? [proc.slice(0, proc.indexOf('.')), proc.slice(proc.indexOf('.') + 1)] : ['', '']
  const base = file.split('/').pop()!.replace(/\.log$/, '')
  const rec: Record<string, unknown> = {
    time: r.time || r.ts || new Date().toISOString(), level: r.level || 'info',
    project: (r.project as string) || project || (file.startsWith(DIRS.pc) ? 'mm' : file.split('/').slice(-5, -3).join('-')), service: (r.service as string) || service || base,
    msg: r.message ?? r.msg ?? '', ...(inner || {}),
  }
  if (inner) rec.msg = inner.msg ?? inner.message ?? ''
  for (const k of Object.keys(r)) if (!['process', 'replica', 'message', 'msg', 'time', 'level'].includes(k) && !(k in rec)) rec[k] = r[k]
  if (rec.msg === '' || rec.msg === undefined) return null
  if (typeof rec.msg !== 'string') rec.msg = JSON.stringify(rec.msg)
  if (!inner) {
    // process-compose marks every stderr line "error": take the level from the line itself
    const m = rec.msg as string
    const kv = [...m.matchAll(/(?:^|\s)([a-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S*)/g)]
    if (kv.length >= 3) for (const [, k, v] of kv) if (!(k in rec)) rec[k] = v.replace(/^"(.*)"$/, '$1')
    const st = Number(rec.status)
    rec.level = BENIGN.some((re) => re.test(m)) ? 'info' : /\b(panic|fatal)\b/i.test(m) || /\blevel=(error|fatal)\b/i.test(m) || /^\s*(error|err)\b[:\s]/i.test(m) || /\b(ERROR|FATAL|Traceback|Unhandled|uncaught)\b/.test(m) || st >= 500 ? 'error'
      : /\blevel=warn/i.test(m) || /\b(WARN|WARNING)\b/.test(m) || /^\s*warn(ing)?\b/i.test(m) ? 'warn' : 'info'
  }
  return rec
}
/** `dryRun`: one pass from the start of every file; print the records, send nothing, keep no state (for tests). */
export async function ship(everyMs = 2000, dryRun = false) {
  const { logs } = obsPorts()
  const url = `http://127.0.0.1:${logs}/insert/jsonline?_stream_fields=project,service&_time_field=time&_msg_field=msg`
  let st: Off = {}
  if (!dryRun) try { st = JSON.parse(readFileSync(SHIP_STATE, 'utf8')) } catch {}
  for (;;) {
    const batch: string[] = [], next: Off = { ...st }
    for (const x of shipFiles()) {
      const f = x.f, fd = openLog(x)
      if (fd === null) continue
      let text = '', o = st[f] ?? { ino: 0, off: 0 }, s
      try {
        s = fstatSync(fd)
        if (o.ino !== s.ino || s.size < o.off) o = { ino: s.ino, off: 0 } // new, rotated or truncated
        if (s.size === o.off) { next[f] = o; continue }
        const len = Math.min(s.size - o.off, 4 << 20), buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, o.off); text = buf.toString('utf8')
      } catch { continue } finally { closeSync(fd) }
      const cut = text.lastIndexOf('\n')
      if (cut < 0) { next[f] = o; continue }
      for (const line of text.slice(0, cut).split('\n')) { const r = toRecord(line, f); if (r) { if (x.project) r.project = x.project; batch.push(JSON.stringify(r)) } }
      next[f] = { ino: s.ino, off: o.off + Buffer.byteLength(text.slice(0, cut + 1)) }
    }
    if (dryRun) { if (batch.length) console.log(batch.join('\n')); return }
    let ok = true
    for (let i = 0; i < batch.length; i += 5000) {
      try { const r = await fetch(url, { method: 'POST', body: batch.slice(i, i + 5000).join('\n') + '\n', signal: AbortSignal.timeout(10_000) }); ok &&= r.ok; await r.arrayBuffer() } catch { ok = false }
    }
    if (ok) { st = next; try { writeFileSync(SHIP_STATE, JSON.stringify(st)) } catch {} }
    else console.log(JSON.stringify({ level: 'warn', msg: `ship: VictoriaLogs did not take ${batch.length} record(s); retrying` }))
    await Bun.sleep(everyMs)
  }
}

// ---------- queries (people and the brain) ----------
export async function logsql(query: string, limit = 200): Promise<Record<string, string>[]> {
  const { logs } = obsPorts()
  const r = await fetch(`http://127.0.0.1:${logs}/select/logsql/query`, { method: 'POST', body: new URLSearchParams({ query, limit: String(limit) }) })
  if (!r.ok) throw new Error(`VictoriaLogs: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
export async function tracesql(query: string, limit = 200): Promise<Record<string, string>[]> {
  const { traces } = obsPorts()
  const r = await fetch(`http://127.0.0.1:${traces}/select/logsql/query`, { method: 'POST', body: new URLSearchParams({ query, limit: String(limit) }) })
  if (!r.ok) throw new Error(`VictoriaTraces: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
export async function promql(query: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const { metrics } = obsPorts()
  const r = await fetch(`http://127.0.0.1:${metrics}/api/v1/query?${new URLSearchParams({ query })}`)
  const j = await r.json() as { data?: { result: never[] } }
  return j.data?.result ?? []
}
export async function health() {
  const p = obsPorts(), rows: Record<string, unknown>[] = []
  for (const [name, port] of Object.entries(p)) {
    const t0 = performance.now()
    const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)
    rows.push({ store: name, port, status: ok ? 'ok' : 'down', ms: Math.round(performance.now() - t0) })
  }
  return rows
}

// ---------- mm's own operations ----------
/** What the running command says about its own span before it exits (sy-ha9x): `attrs` join the span (mm doctor's
 *  mm_throwaway when only a throwaway project fails); `answer` = this exit code is an answer to the caller, not a fault
 *  (mm config get on an unset key exits 1: the span is not failed, its outcome says why). cli.ts reads it at exit. */
export const spanNote: { attrs: Record<string, unknown>; answer?: { code: number; outcome: string } } = { attrs: {} }

/** A root span for one mm command, sent to VictoriaTraces; also a line in ~/.mm/pc/mm.log (shipped). */
export function mmSpan(name: string, attrs: Record<string, unknown>) {
  const traceId = randomBytes(16).toString('hex'), spanId = randomBytes(8).toString('hex'), start = Date.now()
  process.env.TRACEPARENT = `00-${traceId}-${spanId}-01` // children (bin/init, config-check, npm build, ...) join this trace
  return (ok: boolean, extra: Record<string, unknown> = {}) => {
    // (a command on a throwaway project carries attrs.mm_throwaway, set by mm itself from the project's answers: cli.ts)
    const end = Date.now(), all: Record<string, unknown> = { ...attrs, ...extra, ok }
    try { appendFileSync(join(DIRS.pc, 'mm.log'), JSON.stringify({ time: new Date(end).toISOString(), level: ok ? 'info' : 'error', msg: `${name} ${all.outcome ?? (ok ? 'ok' : 'failed')}`, project: 'mm', service: 'mm', op: name, duration_ms: end - start, trace_id: traceId, ...all }) + '\n') } catch {}
    // MM_OBS_TRACES as in the engine (bin/lib/obs.mjs): unset = the stack's endpoint, empty = off (tests, throwaway homes)
    const ep = { traces: process.env.MM_OBS_TRACES ?? (obsEndpoints() as { traces?: string }).traces }
    if (!ep.traces) return
    const kv = Object.entries(all).filter(([, v]) => v !== undefined).map(([key, v]) => ({ key, value: typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v).slice(0, 2000) } }))
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'mm' } }] }, scopeSpans: [{ scope: { name: 'mm' }, spans: [{
      traceId, spanId, name, kind: 1, startTimeUnixNano: `${start}000000`, endTimeUnixNano: `${end}000000`, attributes: kv, status: { code: ok ? 1 : 2 } }] }] }] })
    run(['curl', '-sf', '-m', '2', '-o', '/dev/null', '-H', 'content-type: application/json', '--data-binary', '@-', ep.traces], { stdin: body, timeoutMs: 3000 })
  }
}
