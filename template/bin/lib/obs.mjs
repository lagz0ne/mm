// Observability for engine code (no dependencies). Every system operation of the project goes through here:
//   traces  -> VictoriaTraces (OTLP/HTTP JSON), parent/child via AsyncLocalStorage and the TRACEPARENT env/header
//   logs    -> one JSON line per record: stdout for services the process manager runs (it writes .run/logs/<svc>.log),
//              else appended to .run/logs/ops.log; mm ships both to VictoriaLogs
//   metrics -> VictoriaMetrics (Prometheus text push), long-running services only
// Endpoints: env MM_OBS_TRACES / MM_OBS_METRICS, else .run/endpoints.json "observability". None = traces/metrics off,
// logs still written. Nothing here throws into the caller.
import { AsyncLocalStorage } from 'node:async_hooks'
import cp, { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { endpoints, projectName, ROOT } from './svc.mjs'

const E = process.env
const ep = (() => { try { return endpoints().observability || {} } catch { return {} } })()
const TRACES = E.MM_OBS_TRACES ?? ep.traces ?? ''
const METRICS = E.MM_OBS_METRICS ?? ep.metrics ?? ''
export const PROJECT = projectName()
export const SERVICE = E.MM_SERVICE || path.basename(process.argv[1] || 'node')
const UNDER_PM = !!E.MM_SERVICE // run by the process manager: stdout is the service log
delete E.MM_SERVICE // ...but not for the commands this service runs: they log to ops.log
const OPS_LOG = path.join(ROOT, '.run', 'logs', 'ops.log')
const als = new AsyncLocalStorage()
const hex = (n) => randomBytes(n).toString('hex')
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n

// ---------- traces ----------
let queue = [], timer = null
const envParent = (() => { const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(E.TRACEPARENT || ''); return m ? { traceId: m[1], spanId: m[2] } : null })()
export const current = () => als.getStore() || null
/** Parse a W3C traceparent header value. */
export function fromHeader(v) { const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(v || ''); return m ? { traceId: m[1], spanId: m[2] } : null }

/** Start a span; call .end() (or .fail(err)). Parent: explicit, else the active span, else TRACEPARENT. */
export function startSpan(name, attrs = {}, parent = current() || envParent, kind = 1, opts = {}) {
  const minMs = opts.minMs ?? parent?.minMs ?? 0 // quiet span (pollers): kept only when slow or failed; children inherit
  const s = { minMs,
    name, kind, traceId: parent?.traceId || hex(16), spanId: hex(8), parentSpanId: parent?.spanId || '', start: nowNs(),
    attrs: { ...attrs }, events: [], status: { code: 0 }, done: false,
    set(k, v) { s.attrs[k] = v; return s },
    event(n, a = {}) { s.events.push({ name: n, timeUnixNano: String(nowNs()), attributes: kv(a) }); return s },
    fail(err) { s.status = { code: 2, message: String(err?.message || err).slice(0, 500) }; return s.end() },
    end(extra = {}) {
      if (s.done) return s
      s.done = true; Object.assign(s.attrs, extra)
      if (!s.status.code) s.status = { code: 1 }
      if (s.minMs && s.status.code !== 2 && Number(nowNs() - s.start) / 1e6 < s.minMs) return s
      push({ traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name, kind: s.kind,
        startTimeUnixNano: String(s.start), endTimeUnixNano: String(nowNs()), attributes: kv(s.attrs), events: s.events, status: s.status })
      return s
    },
    traceparent: () => `00-${s.traceId}-${s.spanId}-01`,
  }
  return s
}
/** Run fn inside a span (sync or async). Errors mark the span failed and are re-thrown. */
export function span(name, attrs, fn, opts = {}) {
  const s = startSpan(name, attrs, undefined, opts.kind ?? 1, opts)
  let r
  try { r = als.run(s, () => fn(s)) } catch (e) { s.fail(e); throw e }
  if (r && typeof r.then === 'function') return r.then((v) => { s.end(); return v }, (e) => { s.fail(e); throw e })
  s.end(); return r
}
/** Run fn with `s` as the active span (for spans started by hand, e.g. per HTTP request). */
export const withSpan = (s, fn) => als.run(s, fn)
/** traceparent of the active span, for outgoing HTTP headers and child process env. */
export const traceparent = () => current()?.traceparent() || (envParent ? `00-${envParent.traceId}-${envParent.spanId}-01` : undefined)
export const childEnv = (env = process.env) => { const t = traceparent(); return t ? { ...env, TRACEPARENT: t } : env }

function kv(o) {
  return Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([key, v]) => ({ key,
    value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v).slice(0, 2000) } }))
}
function push(span) {
  if (!TRACES) return
  queue.push(span)
  if (queue.length >= 200) flushTraces()
  else if (!timer) { timer = setTimeout(flushTraces, 1000); timer.unref?.() }
}
function body(spans) {
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: kv({ 'service.name': `${PROJECT}/${SERVICE}`, 'service.namespace': PROJECT, project: PROJECT, service: SERVICE, 'host.name': E.HOSTNAME }) },
    scopeSpans: [{ scope: { name: 'mm-engine' }, spans }] }] })
}
let inflight = Promise.resolve()
function flushTraces() {
  clearTimeout(timer); timer = null
  if (!queue.length || !TRACES) return inflight
  const spans = queue; queue = []
  inflight = inflight.then(() => globalThis.fetch(TRACES, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(spans), signal: AbortSignal.timeout(3000) }).then((r) => r.arrayBuffer()).catch(() => {}))
  return inflight
}


// ---------- traced child processes and HTTP calls (same signatures as node's) ----------
const opName = (cmd, args) => `exec ${path.basename(String(cmd))}${args?.[0] && !String(args[0]).startsWith('-') ? ` ${path.basename(String(args[0]))}` : ''}`
/** child_process.execFile in a child span; the child gets TRACEPARENT. */
export function execFile(cmd, args = [], opts = {}, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  const { minMs, ...o } = opts; opts = o
  const s = startSpan(opName(cmd, args), { 'process.command': String(cmd), 'process.args': args.join(' ').slice(0, 300) }, undefined, 3, { minMs })
  return cp.execFile(cmd, args, { ...opts, env: { ...(opts.env || process.env), TRACEPARENT: s.traceparent() } }, (err, out, errOut) => {
    if (err) { s.set('exit_code', err.code ?? null).set('stderr', String(errOut || '').slice(-500)); s.fail(err.killed ? `timeout/killed (${err.signal})` : err.message) } else s.end({ exit_code: 0 })
    cb?.(err, out, errOut)
  })
}
/** child_process.spawn in a child span (ends when the process closes). */
export function spawn(cmd, args = [], opts = {}) {
  const s = startSpan(opName(cmd, args), { 'process.command': String(cmd), 'process.args': args.join(' ').slice(0, 300) }, undefined, 3)
  const c = cp.spawn(cmd, args, { ...opts, env: { ...(opts.env || process.env), TRACEPARENT: s.traceparent() } })
  c.on('error', (e) => s.fail(e))
  c.on('close', (code, sig) => (code || sig ? s.set('exit_code', code).fail(sig ? `signal ${sig}` : `exit ${code}`) : s.end({ exit_code: 0 })))
  return c
}
/** fetch in a client span, with the traceparent header. Streams (SSE) end the span when the response starts. */
export async function fetch(url, init = {}) {
  const u = new URL(url), { minMs, ...i } = init; init = i
  const s = startSpan(`${init.method || 'GET'} ${u.host}${routeOf(u.pathname)}`, { 'http.method': init.method || 'GET', 'url.full': `${u.origin}${u.pathname}` }, undefined, 3, { minMs })
  try {
    const r = await globalThis.fetch(url, { ...init, headers: { ...(init.headers || {}), traceparent: s.traceparent() } })
    s.set('http.status_code', r.status); r.ok ? s.end() : s.fail(`HTTP ${r.status}`)
    return r
  } catch (e) { s.fail(e); throw e }
}
/** /api/v0/beads/issues/cr-1a2.3 -> /api/v0/beads/issues/:id  (ids, hashes and file names out of span names) */
export const routeOf = (p) => p.split('/').map((x) => (/^v\d+$/.test(x) ? x : /\d/.test(x) || x.length > 24 ? ':id' : x)).join('/').replace(/^\/assets\/.*/, '/assets/:file')

/** Server side: one span per HTTP request (parent from the caller's traceparent) + request metrics. Returns end(). */
export function httpSpan(req, res, opts = {}) {
  const u = new URL(req.url, 'http://x'), route = routeOf(u.pathname)
  const s = startSpan(`${req.method} ${route}`, { 'http.method': req.method, 'http.route': route, 'url.path': u.pathname }, fromHeader(req.headers.traceparent), 2, opts)
  const t0 = performance.now()
  res.on('close', () => {
    const code = res.statusCode, secs = (performance.now() - t0) / 1000
    s.set('http.status_code', code); code >= 500 ? s.fail(`HTTP ${code}`) : s.end()
    count('mm_http_requests_total', { route, method: req.method, code })
    if (!route.startsWith('/assets')) observe('mm_http_request_duration_seconds', { route, method: req.method }, secs)
    if (code >= 500) log('error', `${req.method} ${u.pathname} -> ${code}`, { route, status: code, duration_ms: Math.round(secs * 1000), trace_id: s.traceId })
  })
  return s
}

// ---------- logs ----------
/** One structured record. Carries the active trace so logs and traces join. */
export function log(level, msg, attrs = {}) {
  const s = current()
  const rec = { time: new Date().toISOString(), level, msg: String(msg), project: PROJECT, service: SERVICE,
    ...(s ? { trace_id: s.traceId, span_id: s.spanId } : envParent ? { trace_id: envParent.traceId } : {}), ...attrs }
  const line = JSON.stringify(rec)
  if (UNDER_PM) { (level === 'error' ? process.stderr : process.stdout).write(line + '\n'); return }
  try { fs.mkdirSync(path.dirname(OPS_LOG), { recursive: true }); fs.appendFileSync(OPS_LOG, line + '\n') } catch {}
  if (level === 'error' || E.MM_LOG_STDERR) process.stderr.write(`${level}: ${msg}\n`)
}
export const info = (m, a) => log('info', m, a), warn = (m, a) => log('warn', m, a), error = (m, a) => log('error', m, a)

// ---------- metrics (long-running services) ----------
const counters = new Map(), hists = new Map()
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
const key = (name, labels) => `${name}{${Object.entries({ project: PROJECT, service: SERVICE, ...labels }).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',')}}`
export function count(name, labels = {}, v = 1) { const k = key(name, labels); counters.set(k, (counters.get(k) || 0) + v) }
export function observe(name, labels = {}, seconds) {
  const k = JSON.stringify([name, labels]); let h = hists.get(k)
  if (!h) hists.set(k, (h = { name, labels, b: BUCKETS.map(() => 0), sum: 0, n: 0 }))
  BUCKETS.forEach((le, i) => { if (seconds <= le) h.b[i]++ }); h.sum += seconds; h.n++
}
function exposition() {
  const out = []
  for (const [k, v] of counters) out.push(`${k} ${v}`)
  for (const h of hists.values()) {
    h.b.forEach((c, i) => out.push(`${key(`${h.name}_bucket`, { ...h.labels, le: BUCKETS[i] })} ${c}`))
    out.push(`${key(`${h.name}_bucket`, { ...h.labels, le: '+Inf' })} ${h.n}`, `${key(`${h.name}_sum`, h.labels)} ${h.sum}`, `${key(`${h.name}_count`, h.labels)} ${h.n}`)
  }
  return out.join('\n') + '\n'
}
/** Push metrics every `everyMs` (call once from a long-running service). Also counts the process's up time. */
export function startMetrics(everyMs = 15000) {
  if (!METRICS) return
  const t = setInterval(() => {
    counters.set(key('mm_process_up', {}), 1)
    globalThis.fetch(METRICS, { method: 'POST', body: exposition(), signal: AbortSignal.timeout(3000) }).then((r) => r.arrayBuffer()).catch(() => {})
  }, everyMs)
  t.unref?.()
}

// ---------- CLI scripts ----------
/**
 * For an engine script run as a command: one root span for the whole run (child of TRACEPARENT when a caller set it),
 * active for everything the script does; ended on exit with the exit code, and sent synchronously (curl) because
 * scripts leave through process.exit. Child processes get TRACEPARENT via childEnv().
 */
export function cli(name = SERVICE, attrs = {}) {
  const root = startSpan(name, { args: process.argv.slice(2).join(' ').slice(0, 300), cwd: path.relative(ROOT, process.cwd()) || '.', ...attrs }, envParent, 1)
  als.enterWith(root)
  process.env.TRACEPARENT = root.traceparent()
  process.on('exit', (code) => {
    // root.refused: the command said no to its caller (bd: "not claimable", "blocked", a guarded update that lost):
    // the caller has the answer; it is not a failure of the service, so it is a warn and the span stays unset
    const refused = Boolean(code && root.refused)
    if (code && !refused) root.status = { code: 2, message: `exit ${code}` }
    root.end({ exit_code: code, ...(refused ? { outcome: 'refused' } : {}) })
    log(refused ? 'warn' : code ? 'error' : 'info', `${name} ${refused ? `refused (exit ${code})` : code ? `failed (exit ${code})` : 'done'}`,
      { op: name, exit_code: code, ...(refused ? { outcome: 'refused' } : {}), duration_ms: Number((nowNs() - root.start) / 1000000n) })
    clearTimeout(timer); timer = null
    if (!queue.length || !TRACES) return
    try { execFileSync('curl', ['-sf', '-m', '2', '-o', '/dev/null', '-H', 'content-type: application/json', '--data-binary', '@-', TRACES], { input: body(queue), stdio: ['pipe', 'ignore', 'ignore'] }) } catch {}
    queue = []
  })
  return root
}

// ---------- series rebuilt from a journal (bin/flow) ----------
// Samples and spans with their own times and fixed ids, so sending the same ones again (a rerun, a rebuild) gives the
// same values. Each resolves to true when the store took them, or when that store is off (nothing to send to).
const post = async (url, data, type) => {
  try { const r = await globalThis.fetch(url, { method: 'POST', headers: type ? { 'content-type': type } : {}, body: data, signal: AbortSignal.timeout(10000) }); await r.arrayBuffer(); return r.ok } catch { return false }
}
/** Prometheus text lines, each with its timestamp in ms. */
export async function pushSamples(lines) {
  if (!METRICS || !lines.length) return true
  let ok = true
  for (let i = 0; i < lines.length; i += 5000) ok = (await post(METRICS, lines.slice(i, i + 5000).join('\n') + '\n')) && ok
  return ok
}
/** Spans: { traceId, spanId, parentSpanId, name, start, end (ms), attrs }. */
export async function pushSpans(list) {
  if (!TRACES || !list.length) return true
  let ok = true
  for (let i = 0; i < list.length; i += 500) {
    const spans = list.slice(i, i + 500).map((s) => ({ traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || '', name: s.name, kind: 1,
      startTimeUnixNano: `${Math.round(s.start)}000000`, endTimeUnixNano: `${Math.round(s.end)}000000`, attributes: kv(s.attrs || {}), status: { code: 1 } }))
    ok = (await post(TRACES, body(spans), 'application/json')) && ok
  }
  return ok
}

// ---------- exit ----------
/** Send what is queued. Await this before process.exit in scripts. */
export const flush = () => flushTraces()
process.on('beforeExit', () => { if (queue.length) flushTraces() })
