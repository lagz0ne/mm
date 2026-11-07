#!/usr/bin/env node
// bin/supervisor (profile system): the flow findings of a role are lines of one item, its digest (sy-28ev). At the default
// windows (stall 60 min, handoff 30 min): two quiet P1s make one digest:<role> with two lines; a line that clears drops
// off and the item is edited in place (no comment); the last one cleared closes it, with no comment; items blocked or
// labelled needs-you are never a line; a digest closed by hand stays quiet for the lines it had and opens again for a
// new one; an item of an earlier Supervisor (stall:<item>) is closed as cleared.
// Hermetic: temp folder, a fake bd-serve, a stub paseo and mm; a fake clock (SUPERVISOR_NOW).
//   node test/supervisor-digest.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-digest-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const MIN = 60000, T0 = Date.now()
let clock = T0
const iso = (t) => new Date(t).toISOString()

const HOME = path.join(T, 'home'), SYS = path.join(T, 'sys'), MMH = path.join(HOME, '.mm')
fs.mkdirSync(path.join(SYS, 'bin'), { recursive: true }); fs.mkdirSync(path.join(SYS, 'leads'), { recursive: true }); fs.mkdirSync(MMH, { recursive: true })
fs.copyFileSync(path.join(SRC, 'template/profiles/system/bin/supervisor'), path.join(SYS, 'bin/supervisor'))
fs.cpSync(path.join(SRC, 'template/bin/lib'), path.join(SYS, 'bin/lib'), { recursive: true })
fs.writeFileSync(path.join(SYS, 'leads/roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))

// stub paseo: every lead idle; stub mm: no projects
const AG = path.join(T, 'agents'); fs.mkdirSync(AG)
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
[ "$1" = ls ] || exit 9
for a in "$@"; do case "$a" in role=*) f="${AG}/\${a#role=}.json"; [ -f "$f" ] && cat "$f" || echo '[]'; exit 0 ;; esac; done
echo '[]'
`, { mode: 0o755 })
for (const r of ['ops', 'review', 'platform']) fs.writeFileSync(path.join(AG, `${r}.json`), JSON.stringify([{ id: `agent-${r}`, shortId: r, status: 'idle' }]))
fs.writeFileSync(path.join(T, 'mm'), `#!/bin/sh\n[ "$1 $2" = "ls -o" ] && { echo '[]'; exit 0; }\nexit 9\n`, { mode: 0o755 })

// fake bd-serve: items, comments, PATCH, close, the event journal
const items = new Map(), events = []
let seq = 0, nextId = 1
const snap = (i) => ({ ...i, comments: undefined })
const record = (op, i, actor, t = clock, comment) => events.push({ seq: ++seq, op, issue_id: i.id, actor, ts: iso(t), issue: snap(i), ...(comment ? { comment } : {}) })
function item(id, f, actor = 'ops', t = clock) {
  const i = { id, title: f.title || id, status: f.status || 'open', priority: f.priority ?? 2, assignee: f.assignee || '', labels: f.labels || [], description: f.description || '', updated_at: iso(t), comments: [] }
  items.set(id, i); record('create', i, actor, t); return i
}
function comment(id, author, text, t = clock) { const i = items.get(id), c = { author, text, created_at: iso(t) }; i.comments.push(c); i.updated_at = iso(t); record('comment', i, author, t, c) }
function update(id, f, actor, t = clock) { const i = items.get(id); Object.assign(i, f, { updated_at: iso(t) }); record(f.status === 'closed' ? 'close' : 'update', i, actor, t) }
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}, json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') {
    const label = u.searchParams.get('label'), status = u.searchParams.get('status')?.split(',')
    return json({ items: [...items.values()].filter((i) => (!label || i.labels.includes(label)) && (status ? status.includes(i.status) : i.status !== 'closed')).map(snap), has_more: false })
  }
  if (req.method === 'GET' && u.pathname === '/v0/beads/ready') return json({ items: [...items.values()].filter((i) => i.status === 'open').map(snap) })
  if (req.method === 'GET' && u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: events.filter((e) => e.seq > since) }) }
  if (req.method === 'POST' && u.pathname === '/v0/beads/issues') return json({ id: item(`sy-s${nextId++}`, b, b.actor).id })
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname))) { comment(m[1], b.author, b.text); return json({}) }
  if (req.method === 'PATCH' && (m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname))) { update(m[1], b.patch, b.actor); return json({ issue: snap(items.get(m[1])) }) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+):close$/.exec(u.pathname))) { update(m[1], { status: 'closed' }, b.actor); return json({}) }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const ENV = { PATH: process.env.PATH, HOME, MM_HOME: MMH, MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_BIN: path.join(T, 'mm'), MM_BRAIN: path.join(T, 'brain'),
  SVC_URL_BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
let out = ''
const supervise = () => new Promise((resolve) => {
  const p = spawn('node', [path.join(SYS, 'bin/supervisor')], { env: { ...ENV, SUPERVISOR_NOW: String(clock) }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', resolve)
})
const KEY = /supervisor key: `([^`]+)`/
const sup = () => [...items.values()].filter((i) => i.labels.includes('supervisor'))
const openKeys = () => sup().filter((i) => i.status !== 'closed').map((i) => KEY.exec(i.description)?.[1]).sort().join(' ')
const openOf = (k) => sup().find((i) => i.status !== 'closed' && KEY.exec(i.description)?.[1] === k)
const byKey = (k) => sup().filter((i) => KEY.exec(i.description)?.[1] === k)
const at = (min) => { clock = T0 + min * MIN }

try {
  // the board at T0: two quiet P1s of platform, one waiting on the owner (needs-you); handoffs to review, one of them blocked
  item('sy-1', { status: 'in_progress', priority: 1, assignee: 'platform' }, 'platform')
  item('sy-2', { status: 'in_progress', priority: 1, assignee: 'platform' }, 'platform')
  item('sy-3', { status: 'in_progress', priority: 1, assignee: 'platform', labels: ['needs-you'] }, 'platform')
  item('sy-4', { assignee: 'platform' }, 'platform'); update('sy-4', { assignee: 'review' }, 'platform')
  item('sy-5', { assignee: 'platform' }, 'platform'); update('sy-5', { assignee: 'review', status: 'blocked' }, 'platform')
  item('sy-6', { assignee: 'platform', labels: ['needs-you'] }, 'platform'); update('sy-6', { assignee: 'review' }, 'platform')
  // an item of an earlier Supervisor (one per finding)
  item('sy-old', { title: 'Stalled: sy-9', labels: ['supervisor'], assignee: 'ops', description: 'old\n\nsupervisor key: `stall:sy-9`' }, 'watchdog')

  console.log('== +29 min: under the handoff window (30 min): nothing; the earlier Supervisor\'s stall:sy-9 closes')
  at(29); await supervise()
  ok('nothing open', openKeys() === '')
  ok('stall:sy-9 (an earlier Supervisor\'s key) closed as cleared', items.get('sy-old').status === 'closed')

  console.log('== +30 min: the handoff of sy-4 waits 30 min: digest:review; sy-5 (blocked) and sy-6 (needs-you) are not lines')
  at(30); await supervise()
  ok('open: digest:review', openKeys() === 'digest:review')
  const R = openOf('digest:review')
  ok('one line, sy-4; not sy-5 nor sy-6', /^- handoff waits: sy-4 /m.test(R?.description) && !/sy-5|sy-6/.test(R?.description) && /\(1 waiting\)/.test(R?.title))

  console.log('== +59 min: under the stall window (60 min): no digest for platform')
  at(59); await supervise()
  ok('no digest:platform yet', !openOf('digest:platform'))

  console.log('== +60 min: two quiet stalls make one digest with two lines')
  at(60); await supervise()
  const P = openOf('digest:platform')
  ok('one digest:platform, two lines (sy-1, sy-2); not sy-3 (needs-you)', byKey('digest:platform').length === 1 && /^- stalled: sy-1 /m.test(P?.description) && /^- stalled: sy-2 /m.test(P?.description) && !/sy-3/.test(P?.description) && /\(2 waiting\)/.test(P?.title))
  ok('P1, for ops', P?.priority === 1 && P?.assignee === 'ops')

  console.log('== +65 min: sy-1 moves: its line drops off, edited in place, no "Cleared" comment')
  comment('sy-1', 'platform', 'Back on it.')
  at(65); await supervise()
  const P2 = openOf('digest:platform')
  ok('the same item, now only sy-2', P2?.id === P.id && !/sy-1/.test(P2.description) && /^- stalled: sy-2 /m.test(P2.description) && /\(1 waiting\)/.test(P2.title))
  ok('no comment on it', P2.comments.length === 0)

  console.log('== +70 min: sy-2 moves too: nothing left, the digest closes with no comment')
  comment('sy-2', 'platform/w1', 'Built it.')
  at(70); await supervise()
  ok('digest:platform closed, with no comment', items.get(P.id).status === 'closed' && items.get(P.id).comments.length === 0 && !openOf('digest:platform'))

  console.log('== a digest closed by hand: quiet for the lines it had; a new line opens it again')
  update(R.id, { status: 'closed' }, 'alex')
  at(72); await supervise()
  ok('not opened again for the same line', !openOf('digest:review') && byKey('digest:review').length === 1)
  item('sy-7', { assignee: 'platform' }, 'platform'); update('sy-7', { assignee: 'review' }, 'platform')
  at(102); await supervise()
  const R2 = openOf('digest:review')
  ok('a new line (sy-7\'s handoff): a new digest:review with both lines', R2 && R2.id !== R.id && /sy-4/.test(R2.description) && /sy-7/.test(R2.description))
} finally {
  srv.close()
  if (fail) console.log(out.slice(-3000))
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
