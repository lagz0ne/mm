#!/usr/bin/env node
// bin/flow (the engine's flow collector) and `mm obs flow` / `mm obs item`, against an in-process fake bd serve (a fixture
// board's event journal), a fake VictoriaMetrics (import + export; keeps duplicates, as the real one does) and a fake
// VictoriaTraces (OTLP in, LogsQL rows out). Checks: the exact value of every sample; the clock pauses on the rails
// (an item that waited 2 h for sign-off has the same cycle time as one that didn't); labels count only through their
// event's actor; no series or span carries a person, a title or comment text; the span path of one item; the collector
// run twice, from an empty state, and in two steps gives the same series; a pruned journal and a store that is down;
// the table pairs each speed metric with its quality one and names the event range. Hermetic: a temp folder only.
//   node test/flow.mjs            exit 0 = every check passed
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'))
const BUN = process.env.BUN || path.join(os.homedir(), '.bun', 'bin', 'bun')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const MIN = 60000
const NOW = Date.parse('2026-11-05T12:00:00Z'), T0 = NOW - 600 * MIN, K = NOW - 3 * 86400e3
const iso = (t) => new Date(t).toISOString()
const PROJECT = 'qa-board'

// ---------- the board folder: bin/flow + bin/lib, leads/roles.json ----------
const BRD = path.join(T, 'board')
fs.mkdirSync(path.join(BRD, 'leads'), { recursive: true })
fs.cpSync(path.join(SRC, 'template/bin/lib'), path.join(BRD, 'bin/lib'), { recursive: true })
fs.copyFileSync(path.join(SRC, 'template/bin/flow'), path.join(BRD, 'bin/flow'))
fs.writeFileSync(path.join(BRD, 'leads/roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))

// ---------- the fixture journal ----------
const TITLE = 'TITLE-NOT-FOR-STORES', TEXT = 'COMMENT-NOT-FOR-STORES'
const events = [], cur = {}
let seq = 0
const rec = (op, id, actor, t, extra = {}) => events.push({ seq: ++seq, ts: iso(t), op, issue_id: id, actor, issue: { ...cur[id] }, ...extra })
const create = (id, actor, t, f) => { cur[id] = { id, title: `${TITLE} ${id}`, status: 'open', assignee: '', labels: [], priority: 1, issue_type: 'task', ...f }; rec('create', id, actor, t) }
const upd = (id, actor, t, f) => { Object.assign(cur[id], f); rec(f.status === 'closed' ? 'close' : 'update', id, actor, t) }
const label = (id, actor, t, l, on = true) => upd(id, actor, t, { labels: on ? [...cur[id].labels, l] : cur[id].labels.filter((x) => x !== l) })
const comment = (id, actor, t, text) => rec('comment', id, actor, t, { comment: { id: `c${seq + 1}`, author: actor, text: `${text} ${TEXT}`, created_at: iso(t) } })
const dep = (id, actor, t, target, kind) => rec('dep_add', id, actor, t, { dep: { kind, target, metadata: '' } })
const m = (n) => T0 + n * MIN

// an old item (3 days ago): only in the 7 d window
create('sy-k', 'ops', K, { assignee: 'platform' }); upd('sy-k', 'platform', K + 60 * MIN, { status: 'in_progress' }); upd('sy-k', 'platform', K + 180 * MIN, { status: 'closed' })
// sy-a: reviewed twice (round 1 not signed off), waits 30 + 120 min on review
create('sy-a', 'ops', m(0), { assignee: 'platform' })
create('sy-b', 'ops', m(0), { assignee: 'platform' })
create('sy-c', 'ops', m(0), { assignee: 'platform' })
create('sy-d', 'ops', m(0), { assignee: 'ops', labels: ['t2'] })
create('sy-e', 'ops', m(0), { assignee: 'platform' })
create('sy-g', 'ops', m(0), { assignee: 'platform' }); dep('sy-g', 'ops', m(0), 'sy-b', 'blocks')
create('sy-x', 'alex', m(0), { assignee: 'alex' }) // a person's own item: no sample
cur['sy-h'] = { id: 'sy-h', title: `${TITLE} sy-h`, status: 'open', assignee: 'ops', labels: [], priority: 1, issue_type: 'task' }
upd('sy-h', 'ops', m(5), { status: 'in_progress', assignee: 'ops' }) // never created in the journal: first seen mid-life
upd('sy-x', 'alex', m(5), { status: 'in_progress' })
upd('sy-d', 'ops', m(10), { status: 'in_progress' })
upd('sy-x', 'alex', m(10), { status: 'closed' })
upd('sy-h', 'ops', m(15), { status: 'closed' })
label('sy-d', 'ops', m(20), 'needs-you')
comment('sy-d', 'alex', m(50), 'Answer: yes.')
label('sy-d', 'ops', m(60), 'needs-you', false)
upd('sy-a', 'platform', m(30), { status: 'in_progress' })
upd('sy-b', 'platform', m(30), { status: 'in_progress' })
upd('sy-c', 'platform/w1', m(30), { status: 'in_progress' }) // a worker of platform
upd('sy-e', 'platform', m(60), { status: 'in_progress' })
upd('sy-d', 'ops', m(70), { assignee: 'review' })
upd('sy-c', 'platform', m(80), { assignee: 'review' })
label('sy-d', 'review', m(90), 'signed-off')
upd('sy-a', 'platform', m(90), { status: 'open', assignee: 'review' })
upd('sy-d', 'review', m(92), { assignee: 'ops' })
label('sy-d', 'ops', m(95), 'approved') // a lead's approved: does not count
upd('sy-a', 'review', m(100), { status: 'in_progress' })
label('sy-d', 'ops', m(100), 'approved', false)
comment('sy-a', 'review', m(110), 'Not signed off: the test is missing.')
upd('sy-a', 'review', m(120), { assignee: 'platform' })
upd('sy-e', 'platform', m(120), { status: 'closed' })
comment('sy-a', 'platform', m(125), 'On it.')
upd('sy-b', 'platform', m(130), { status: 'closed' })
upd('sy-g', 'platform', m(140), { status: 'in_progress' })
upd('sy-a', 'platform', m(150), { assignee: 'review' })
label('sy-d', 'bridge', m(150), 'approved') // the owner's go, through the bridge
upd('sy-d', 'ops', m(160), { status: 'closed' })
upd('sy-e', 'alex', m(180), { status: 'open' }) // a person reopens it
label('sy-c', 'review', m(200), 'signed-off')
upd('sy-e', 'platform', m(200), { status: 'in_progress' })
upd('sy-c', 'review', m(250), { status: 'closed' })
upd('sy-e', 'platform', m(260), { status: 'closed' })
label('sy-a', 'review', m(270), 'signed-off')
upd('sy-a', 'review', m(280), { status: 'closed' })
create('sy-f', 'ops', m(300), { assignee: 'platform', issue_type: 'bug' }); dep('sy-f', 'ops', m(300), 'sy-e', 'discovered-from'); dep('sy-f', 'ops', m(301), 'sy-e', 'discovered-from')
create('sy-i', 'ops', m(400), { assignee: 'review' }); upd('sy-i', 'review', m(410), { status: 'in_progress' }); label('sy-i', 'review', m(420), 'needs-you')
create('sy-j', 'ops', m(500), { assignee: 'platform' }); upd('sy-j', 'platform', m(505), { status: 'in_progress' }); upd('sy-j', 'wake', m(530), { status: 'open' })
events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq).forEach((e, i) => { e.seq = i + 1 })
const LAST = events.length

// ---------- fake bd serve (journal), fake VictoriaMetrics, fake VictoriaTraces ----------
let journalUpTo = LAST, floor = 1, vmDown = false
const vm = [], vt = [] // what each store took (duplicates kept)
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''; for await (const ch of req) body += ch
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)) }
  if (req.method === 'GET' && u.pathname === '/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0), limit = Number(u.searchParams.get('limit') || 500)
    if (since < floor - 1) return json({ code: 'events_journal_truncated', since, floor, head: journalUpTo }, 410)
    return json({ head: journalUpTo, records: events.filter((e) => e.seq > since && e.seq <= journalUpTo).slice(0, Math.min(limit, 7)) }) // small pages
  }
  if (req.method === 'POST' && u.pathname === '/api/v1/import/prometheus') {
    if (vmDown) return json({ error: 'down' }, 503)
    vm.push(...body.split('\n').filter(Boolean)); res.writeHead(204); return res.end()
  }
  if (req.method === 'GET' && u.pathname === '/api/v1/export') {
    const by = new Map()
    for (const line of vm) {
      const mm = /^(\w+)\{(.*)\} (\S+) (\d+)$/.exec(line); if (!mm) continue
      const metric = { __name__: mm[1], ...Object.fromEntries([...mm[2].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]])) }
      const k = mm[1] + mm[2]
      if (!by.has(k)) by.set(k, { metric, values: [], timestamps: [] })
      by.get(k).values.push(Number(mm[3])); by.get(k).timestamps.push(Number(mm[4]))
    }
    res.writeHead(200); return res.end([...by.values()].map((x) => JSON.stringify(x)).join('\n') + '\n')
  }
  if (req.method === 'POST' && u.pathname === '/insert/opentelemetry/v1/traces') {
    for (const rs of JSON.parse(body).resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) vt.push({ resource: rs.resource, span: s })
    return json({})
  }
  if (req.method === 'POST' && u.pathname === '/select/logsql/query') {
    const q = new URLSearchParams(body).get('query'), item = /"span_attr:item":="([^"]+)"/.exec(q)?.[1]
    const rows = vt.filter((x) => x.span.attributes.some((a) => a.key === 'item' && a.value.stringValue === item)).map(({ resource, span }) => ({
      trace_id: span.traceId, span_id: span.spanId, parent_span_id: span.parentSpanId, name: span.name, start_time_unix_nano: span.startTimeUnixNano, end_time_unix_nano: span.endTimeUnixNano,
      ...Object.fromEntries(span.attributes.map((a) => [`span_attr:${a.key}`, String(Object.values(a.value)[0])])),
      ...Object.fromEntries(resource.attributes.map((a) => [`resource_attr:${a.key}`, String(Object.values(a.value)[0])])) }))
    res.writeHead(200); return res.end(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port, URL_ = `http://127.0.0.1:${PORT}`

const STATE = path.join(BRD, '.run', 'flow.json')
const ENV = { PATH: process.env.PATH, HOME: path.join(T, 'home'), MM_PROJECT: PROJECT, SVC_URL_BD_SERVE: URL_,
  MM_OBS_METRICS: `${URL_}/api/v1/import/prometheus`, MM_OBS_TRACES: `${URL_}/insert/opentelemetry/v1/traces` }
const runp = (cmd, args, env) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
  p.on('close', (code) => resolve({ code, out, err }))
})
const collect = (now = NOW) => runp('node', [path.join(BRD, 'bin/flow')], { ...ENV, FLOW_NOW: String(now) })
// mm itself, with a throwaway home whose config points the stores at the fakes
const MMH = path.join(T, 'mmhome'); fs.mkdirSync(MMH, { recursive: true }); fs.mkdirSync(ENV.HOME, { recursive: true })
fs.writeFileSync(path.join(MMH, 'config.yaml'), `metrics_port: ${PORT}\ntraces_port: ${PORT}\nlogs_port: ${PORT}\n`)
const mm = (...args) => runp(BUN, [path.join(SRC, 'src/cli.ts'), ...args], { PATH: process.env.PATH, HOME: ENV.HOME, MM_HOME: MMH, MM_OBS_TRACES: '', MM_FLOW_NOW: String(NOW), NO_COLOR: '1' })

const parse = (line) => { const x = /^(\w+)\{(.*)\} (\S+) (\d+)$/.exec(line); return { name: x[1], labels: Object.fromEntries([...x[2].matchAll(/(\w+)="([^"]*)"/g)].map((y) => [y[1], y[2]])), v: Number(x[3]), t: Number(x[4]) } }
const GAUGES = /^mm_flow_(wip|capacity|needs_you_age_seconds|journal_\w+)$/
const short = (s) => `${s.name.replace(/^mm_flow_/, '')} ${s.labels.role}${s.labels.item ? ` ${s.labels.item}` : ''}${s.labels.rail ? ` ${s.labels.rail}` : ''} @${s.t === NOW ? 'now' : s.t < T0 ? `K+${(s.t - K) / MIN}` : (s.t - T0) / MIN} = ${s.v}`
const sampleSet = (lines, gauges = false) => [...new Set(lines)].map(parse).filter((s) => GAUGES.test(s.name) === gauges).map(short).sort()

// ---------- run 1 ----------
step('run 1: the fixture journal -> every sample, exactly')
let r = await collect()
ok('exit 0', r.code === 0, r.err)
const want = [
  'queue_wait_seconds platform sy-k @K+60 = 3600', 'cycle_seconds platform sy-k @K+180 = 7200', 'paused_seconds platform sy-k all @K+180 = 0',
  'queue_wait_seconds platform sy-a @30 = 1800', 'queue_wait_seconds review sy-a @100 = 600', 'handoff_wait_seconds review sy-a @100 = 600',
  'review_first_pass platform sy-a @110 = 0', 'handoff_wait_seconds platform sy-a @125 = 300', 'handoff_wait_seconds review sy-a @270 = 7200',
  'cycle_seconds platform sy-a @280 = 6000', 'paused_seconds platform sy-a all @280 = 9000', 'paused_seconds platform sy-a sign-off @280 = 9000',
  'queue_wait_seconds platform sy-b @30 = 1800', 'cycle_seconds platform sy-b @130 = 6000', 'paused_seconds platform sy-b all @130 = 0',
  'queue_wait_seconds platform sy-c @30 = 1800', 'handoff_wait_seconds review sy-c @200 = 7200', 'review_first_pass platform sy-c @200 = 1',
  'cycle_seconds platform sy-c @250 = 6000', 'paused_seconds platform sy-c all @250 = 7200', 'paused_seconds platform sy-c sign-off @250 = 7200',
  'queue_wait_seconds ops sy-d @10 = 600', 'handoff_wait_seconds review sy-d @90 = 1200', 'review_first_pass ops sy-d @90 = 1', 'handoff_wait_seconds ops sy-d @95 = 0', // 3 min, all of it while the t2 waits for the owner (approval rail)
  'cycle_seconds ops sy-d @160 = 1800', 'paused_seconds ops sy-d all @160 = 7200', 'paused_seconds ops sy-d needs-you @160 = 2400',
  'paused_seconds ops sy-d sign-off @160 = 1200', 'paused_seconds ops sy-d approval @160 = 3600',
  'queue_wait_seconds platform sy-e @60 = 3600', 'cycle_seconds platform sy-e @120 = 3600', 'paused_seconds platform sy-e all @120 = 0',
  'reopened_total platform sy-e @180 = 1', 'queue_wait_seconds platform sy-e @200 = 1200', 'cycle_seconds platform sy-e @260 = 3600',
  'paused_seconds platform sy-e all @260 = 0', 'escaped_total platform sy-e @300 = 1',
  'queue_wait_seconds platform sy-g @140 = 600', 'queue_wait_seconds review sy-i @410 = 600',
  'queue_wait_seconds platform sy-j @505 = 300', 'lease_expired_total platform sy-j @530 = 1',
].sort()
const got = sampleSet(vm)
ok(`${want.length} samples, each exact (and no other)`, JSON.stringify(got) === JSON.stringify(want),
  `missing: ${want.filter((x) => !got.includes(x)).join(' | ')}\n        extra: ${got.filter((x) => !want.includes(x)).join(' | ')}`)
const g = sampleSet(vm, true)
const wantG = ['wip ops @now = 0', 'wip review @now = 1', 'wip platform @now = 1', 'wip setup @now = 0', 'needs_you_age_seconds review sy-i @now = 10800',
  'journal_first_seq undefined @now = 1', `journal_last_seq undefined @now = ${LAST}`, `journal_first_time undefined @now = ${K / 1000}`, `journal_last_time undefined @now = ${m(530) / 1000}`].sort()
ok('gauges: WIP per role, needs-you age (a state, per item and role), the event range; no capacity (sy-5582)', JSON.stringify(g) === JSON.stringify(wantG), g.join(' | '))
const cyc = (it) => got.find((x) => x.startsWith(`cycle_seconds platform ${it} `))?.split(' = ')[1]
ok('the clock pauses on the rails: sy-c waited 2 h for sign-off and has the cycle time of sy-b, which did not (6000 s)', cyc('sy-c') === '6000' && cyc('sy-b') === '6000')
ok('the paused time is its own series (all + per rail)', got.includes('paused_seconds platform sy-c sign-off @250 = 7200'))
ok('a lead\'s own `approved` does not end the approval wait; the bridge\'s does (sy-d approval 60 min)', got.includes('paused_seconds ops sy-d approval @160 = 3600'))
ok('first pass from review\'s own events only: sy-a 0 (not signed off first), sy-c and sy-d 1', got.filter((x) => x.startsWith('review_first_pass')).length === 3)
ok('a person\'s item (sy-x) and an item first seen mid-life (sy-h) give no sample', !got.some((x) => / sy-[xh] /.test(x)))
const all = vm.join('\n')
ok('no series carries a person (alex, bridge) or a title or comment text', !/alex|bridge/.test(all) && !all.includes(TITLE) && !all.includes(TEXT))
const flowSpans = () => vt.filter((x) => x.span.name.startsWith('flow '))
const spanText = JSON.stringify(flowSpans())
ok('spans carry no title, no comment text, no person', !spanText.includes(TITLE) && !spanText.includes(TEXT) && !/alex|bridge/.test(spanText))
ok('span attributes: item, role, kind, priority only', flowSpans().every((x) => x.span.attributes.every((a) => ['item', 'role', 'kind', 'priority'].includes(a.key))))
const tid = createHash('sha256').update(`${PROJECT}/sy-a`).digest('hex').slice(0, 32)
const spansA = flowSpans().filter((x) => x.span.attributes.some((a) => a.key === 'item' && a.value.stringValue === 'sy-a'))
ok('one trace per item: every sy-a span has trace id sha256(project/item)', spansA.length > 0 && spansA.every((x) => x.span.traceId === tid))
ok('the project of a span is the board that sent it', flowSpans().every((x) => x.resource.attributes.some((a) => a.key === 'service.namespace' && a.value.stringValue === PROJECT)))
const lines1 = [...vm], spans1 = flowSpans().map((x) => JSON.stringify(x.span)).sort()

step('mm obs item sy-a: its path')
r = await mm('-o', 'json', 'obs', 'item', 'sy-a')
ok('exit 0', r.code === 0, r.err)
let pathA = []; try { pathA = JSON.parse(r.out).map((s) => `${s.kind} ${s.role} ${(Date.parse(s.from) - T0) / MIN}-${(Date.parse(s.to) - T0) / MIN}`) } catch {}
const wantPath = ['item platform 0-280', 'queued platform 0-30', 'worked platform 30-90', 'handoff review 90-100', 'queued review 90-100', 'sign-off review 90-120',
  'review review 100-120', 'handoff platform 120-125', 'worked platform 120-150', 'handoff review 150-270', 'sign-off review 150-270', 'review review 150-280', 'done platform 280-280']
ok(`ready -> claimed -> worked -> handoff -> review -> done: ${wantPath.length} spans in order`, JSON.stringify(pathA) === JSON.stringify(wantPath), pathA.join(' | '))
r = await mm('-o', 'json', 'obs', 'item', 'sy-e')
let pathE = []; try { pathE = JSON.parse(r.out).map((s) => s.kind) } catch {}
ok('sy-e: reopened and done twice; the item span once (the longest)', pathE.filter((k) => k === 'done').length === 2 && pathE.includes('reopened') && pathE.filter((k) => k === 'item').length === 1, pathE.join(' '))

step('mm obs flow: the table')
r = await mm('-o', 'json', 'obs', 'flow')
ok('exit 0', r.code === 0, r.err)
let table = null; try { table = JSON.parse(r.out) } catch {}
const row = (role, w) => table?.rows.find((x) => x.project === PROJECT && x.role === role && x.window === w) || {}
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]))
const K1 = ['done', 'queue_p50', 'queue_p95', 'first_pass', 'reviewed', 'cycle_p50', 'cycle_p95', 'paused_p50', 'reopened', 'escaped', 'handoff_p50', 'handoff_p95', 'wip', 'capacity', 'leases_expired', 'needs_you', 'needs_you_max']
const expect = {
  'platform 24h': { done: 4, queue_p50: 1200, queue_p95: 1800, first_pass: 0.5, reviewed: 2, cycle_p50: 6000, cycle_p95: 6000, paused_p50: 0, reopened: 1, escaped: 1, handoff_p50: 300, handoff_p95: 300, wip: 1, capacity: null, leases_expired: 1, needs_you: 0, needs_you_max: null },
  'platform 7d': { done: 5, queue_p50: 1800, queue_p95: 3600, first_pass: 0.5, reviewed: 2, cycle_p50: 6000, cycle_p95: 7200, paused_p50: 0, reopened: 1, escaped: 1, handoff_p50: 300, handoff_p95: 300, wip: 1, capacity: null, leases_expired: 1, needs_you: 0, needs_you_max: null },
  'review 24h': { done: 0, queue_p50: 600, queue_p95: 600, first_pass: null, reviewed: 0, cycle_p50: null, cycle_p95: null, paused_p50: null, reopened: 0, escaped: 0, handoff_p50: 7200, handoff_p95: 7200, wip: 1, capacity: null, leases_expired: 0, needs_you: 1, needs_you_max: 10800 },
  'ops 24h': { done: 1, queue_p50: 600, queue_p95: 600, first_pass: 1, reviewed: 1, cycle_p50: 1800, cycle_p95: 1800, paused_p50: 7200, reopened: 0, escaped: 0, handoff_p50: 0, handoff_p95: 0, wip: 0, capacity: null, leases_expired: 0, needs_you: 0, needs_you_max: null },
}
for (const [k, v] of Object.entries(expect)) { const [role, w] = k.split(' '); ok(`${k}: exact`, JSON.stringify(pick(row(role, w), K1)) === JSON.stringify(v), JSON.stringify(pick(row(role, w), K1))) }
ok('rows for every role (ops, platform, review, setup) and window', table?.rows.length === 8)
ok('it names the event range it used', JSON.stringify(table?.events) === JSON.stringify([{ project: PROJECT, first_seq: 1, last_seq: LAST, first: iso(K).replace(/\.\d+Z$/, 'Z'), last: iso(m(530)).replace(/\.\d+Z$/, 'Z') }]), JSON.stringify(table?.events))
r = await mm('obs', 'flow', PROJECT)
const header = r.out.split('\n')[0].trim().split(/\s+/)
// PAIRS as src/flow.ts declares it (the source of the table's columns)
const pairs = JSON.parse(/export const PAIRS[^=]*=\s*(\{.*\})/.exec(fs.readFileSync(path.join(SRC, 'src/flow.ts'), 'utf8'))[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'))
ok('every speed metric has its quality pair in the same table (queue: first pass; cycle: reopened, escaped)',
  pairs.cycle.includes('reopened') && pairs.cycle.includes('escaped') && pairs.queue.includes('first_pass') &&
  Object.entries(pairs).every(([speed, q]) => header.includes(`${speed.toUpperCase()}_P50`) && header.includes(`${speed.toUpperCase()}_P95`) && q.every((c) => header.includes(c.toUpperCase()))), header.join(' '))
ok('the table says the event range', r.out.includes(`events: ${PROJECT} seq 1..${LAST}`), r.out.split('\n').slice(-3).join(' / '))

step('run 2 (same time): nothing new, same series')
r = await collect()
ok('exit 0', r.code === 0, r.err)
ok('no new sample or span (only the same gauges again)', sampleSet(vm).join() === sampleSet(lines1).join() && flowSpans().length === spans1.length && vm.length - lines1.length === wantG.length)
ok('the series are the same set', JSON.stringify([...new Set(vm)].sort()) === JSON.stringify([...new Set(lines1)].sort()))

step('rebuild: an empty state, into the same store and into an empty one')
fs.rmSync(STATE)
r = await collect()
ok('exit 0', r.code === 0, r.err)
ok('into the same store: the same set of series (the duplicates are exact copies)', JSON.stringify([...new Set(vm)].sort()) === JSON.stringify([...new Set(lines1)].sort()))
r = await mm('-o', 'json', 'obs', 'flow')
ok('mm obs flow over the duplicated store: the same table', r.out === JSON.stringify(table, null, 2) + '\n')
r = await mm('-o', 'json', 'obs', 'item', 'sy-a')
ok('mm obs item over duplicated spans: the same path', JSON.stringify((JSON.parse(r.out || '[]')).map((s) => `${s.kind} ${s.role} ${(Date.parse(s.from) - T0) / MIN}-${(Date.parse(s.to) - T0) / MIN}`)) === JSON.stringify(wantPath))
vm.length = 0; vt.length = 0; fs.rmSync(STATE)
r = await collect()
ok('into an empty store: the same series and the same spans', JSON.stringify([...new Set(vm)].sort()) === JSON.stringify([...new Set(lines1)].sort()) && JSON.stringify(flowSpans().map((x) => JSON.stringify(x.span)).sort()) === JSON.stringify(spans1))
vm.length = 0; vt.length = 0; fs.rmSync(STATE)
r = await collect()
ok('twice from empty: the same again', JSON.stringify([...new Set(vm)].sort()) === JSON.stringify([...new Set(lines1)].sort()))

step('in two steps (half the journal, then the rest): the same samples and spans as at once')
vm.length = 0; vt.length = 0; fs.rmSync(STATE)
journalUpTo = Math.floor(LAST / 2)
r = await collect(m(200))
journalUpTo = LAST
const r2 = await collect()
ok('both exit 0', r.code === 0 && r2.code === 0, r.err + r2.err)
ok('the same samples', sampleSet(vm).join() === sampleSet(lines1).join(), `${sampleSet(vm).length} vs ${sampleSet(lines1).length}`)
ok('the same spans', JSON.stringify(flowSpans().map((x) => JSON.stringify(x.span)).sort()) === JSON.stringify(spans1))

step('a store is down: exit non-zero, the place is kept, then sent')
const before = fs.readFileSync(STATE, 'utf8')
vmDown = true; vm.length = 0; vt.length = 0
events.push({ seq: LAST + 1, ts: iso(m(590)), op: 'update', issue_id: 'sy-g', actor: 'platform', issue: { ...cur['sy-g'], status: 'closed' } }); journalUpTo = LAST + 1
r = await collect()
ok('exit non-zero', r.code !== 0)
ok('state unchanged', fs.readFileSync(STATE, 'utf8') === before)
vmDown = false
r = await collect()
ok('back: the new cycle sample is sent', r.code === 0 && sampleSet(vm).includes('cycle_seconds platform sy-g @590 = 27000'), sampleSet(vm).join(' | '))

step('the board pruned the journal: start again from its oldest record')
fs.rmSync(STATE); vm.length = 0; floor = 20
r = await collect()
ok('exit 0', r.code === 0, r.err)
ok('the event range starts at the floor', sampleSet(vm, true).includes('journal_first_seq undefined @now = 20'), sampleSet(vm, true).join(' | '))
const createdAt = Object.fromEntries(events.filter((e) => e.op === 'create').map((e) => [e.issue_id, e.seq]))
const fromMid = [...new Set(vm)].map(parse).filter((s) => /cycle|first_pass|paused/.test(s.name) && !(createdAt[s.labels.item] >= 20))
ok('an item first seen past the floor: no cycle, paused or first-pass sample for the round that began before; sy-e\'s round after its reopen counts',
  fromMid.map(short).sort().join(' | ') === 'cycle_seconds platform sy-e @260 = 3600 | paused_seconds platform sy-e all @260 = 0', fromMid.map(short).join(' | '))

step('the owner\'s name (owner_name in .run/endpoints.json, mm writes it) is an approver too (sy-44xa, sy-h2yt)')
create('sy-o', 'ops', m(600), { assignee: 'ops', labels: ['t2'] }); upd('sy-o', 'ops', m(605), { status: 'in_progress' })
label('sy-o', 'review', m(610), 'signed-off'); label('sy-o', 'alex', m(620), 'approved'); upd('sy-o', 'ops', m(640), { status: 'closed' })
events.forEach((e, i) => { e.seq = i + 1 }); journalUpTo = events.length; floor = 1
const approvalWait = async (owner) => {
  fs.rmSync(STATE, { force: true }); vm.length = 0
  fs.writeFileSync(path.join(BRD, '.run', 'endpoints.json'), JSON.stringify({ ...(owner ? { owner_name: owner } : {}), services: {} }))
  const x = await collect(); return x.code === 0 ? sampleSet(vm).find((s) => s.startsWith('paused_seconds ops sy-o approval ')) : `exit ${x.code} ${x.err}`
}
let wait = await approvalWait('alex')
ok('approved by the owner\'s name ends the approval wait (10 min)', wait === 'paused_seconds ops sy-o approval @640 = 600', wait)
wait = await approvalWait('')
ok('...no owner_name: the same label does not count (the wait runs to the close, 30 min)', wait === 'paused_seconds ops sy-o approval @640 = 1800', wait)

step('the ledger switched on (sy-1jmi): the label counts only with a signed line of its item, whoever added it')
if (fs.existsSync('/etc/mm-approve.conf')) console.log('  skip: this machine has /etc/mm-approve.conf (the verifiers never read a test config then)')
else {
  const AP = path.join(SRC, 'box/mm-approve'), AD = path.join(T, 'approve'), ACONF = path.join(T, 'mm-approve.conf')
  fs.mkdirSync(AD, { mode: 0o755 }); fs.chmodSync(AD, 0o755)
  fs.writeFileSync(path.join(T, 'plan'), '#!/bin/sh\necho "the plan of $1"\n', { mode: 0o755 })
  fs.writeFileSync(ACONF, `verifier = ledger\nuser = ${os.userInfo().username}\ndir = ${AD}\npublic_key = ${AD}/key.pub\nplan_command = ${path.join(T, 'plan')}\nowner_telegram_id = 4242\n`)
  const signer = (args) => execFileSync(AP, args, { env: { PATH: process.env.PATH, MM_APPROVE_CONF: ACONF }, encoding: 'utf8' })
  signer(['keygen'])
  ENV.MM_APPROVE_CONF = ACONF
  wait = await approvalWait('alex')
  ok('the owner\'s label with no ledger line does not count (the wait runs to the close)', wait === 'paused_seconds ops sy-o approval @640 = 1800', wait)
  signer(['tap', JSON.parse(signer(['offer', 'sy-o', '--subject', `git:${'a'.repeat(40)}`])).offer, '4242'])
  wait = await approvalWait('')
  ok('...a signed line of sy-o: the label counts, even with no owner_name (10 min)', wait === 'paused_seconds ops sy-o approval @640 = 600', wait)
  fs.chmodSync(path.join(AD, 'ledger.jsonl'), 0o666)
  wait = await approvalWait('alex')
  ok('...the ledger writable by others: nothing counts', wait === 'paused_seconds ops sy-o approval @640 = 1800', wait)
  delete ENV.MM_APPROVE_CONF
}

if (process.env.FLOW_SHOW) console.log((await mm('obs', 'flow')).out + (await mm('obs', 'item', 'sy-d')).out) // to look at the tables
srv.close()
fs.rmSync(T, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
