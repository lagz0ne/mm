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
const snap = (i) => ({ ...i, comments: undefined, comment_count: i.comments.length })
const record = (op, i, actor, t = clock, comment) => events.push({ seq: ++seq, op, issue_id: i.id, actor, ts: iso(t), issue: snap(i), ...(comment ? { comment } : {}) })
function item(id, f, actor = 'ops', t = clock) {
  const i = { id, title: f.title || id, status: f.status || 'open', priority: f.priority ?? 2, assignee: f.assignee || '', labels: f.labels || [], description: f.description || '', updated_at: iso(t), comments: [] }
  items.set(id, i); record('create', i, actor, t); return i
}
function comment(id, author, text, t = clock) { const i = items.get(id), c = { author, text, created_at: iso(t) }; i.comments.push(c); i.updated_at = iso(t); record('comment', i, author, t, c) }
function update(id, f, actor, t = clock) { const i = items.get(id); Object.assign(i, f, { updated_at: iso(t) }); record(f.status === 'closed' ? 'close' : 'update', i, actor, t) }
/** bd dep add|remove <id> <target> (a `blocks` edge), as the journal records it */
const dep = (op, id, target, actor = 'platform') => events.push({ seq: ++seq, op, issue_id: id, actor, ts: iso(clock), issue: snap(items.get(id)), dep: { kind: 'blocks', target } })
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}, json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') {
    const label = u.searchParams.get('label'), status = u.searchParams.get('status')?.split(',')
    return json({ items: [...items.values()].filter((i) => (!label || i.labels.includes(label)) && (status ? status.includes(i.status) : i.status !== 'closed')).map(snap), has_more: false })
  }
  if (req.method === 'GET' && (m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname))) { const i = items.get(m[1]); return i ? json({ ...snap(i), ...(u.searchParams.get('include_comments') === 'true' ? { comments: i.comments } : {}) }) : json({ error: 'no' }, 404) }
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

// an item that waits on the owner carries a valid owner card (sy-z5lz; without one the Supervisor opens card:<item>)
const CARD = '## Owner\n- **What:** Pick the name of the new service.\n- **Why:** The leads cannot go on without it.\n- **You:** Reply: which name?'
try {
  // the board at T0: two quiet P1s of platform, one waiting on the owner (needs-you); handoffs to review, one of them blocked
  item('sy-1', { status: 'in_progress', priority: 1, assignee: 'platform' }, 'platform')
  item('sy-2', { status: 'in_progress', priority: 1, assignee: 'platform' }, 'platform')
  item('sy-3', { status: 'in_progress', priority: 1, assignee: 'platform', labels: ['needs-you'], description: CARD }, 'platform')
  item('sy-4', { assignee: 'platform' }, 'platform'); update('sy-4', { assignee: 'review' }, 'platform')
  item('sy-5', { assignee: 'platform' }, 'platform'); update('sy-5', { assignee: 'review', status: 'blocked' }, 'platform'); dep('dep_add', 'sy-5', 'sy-4') // blocked by sy-4
  item('sy-6', { assignee: 'platform', labels: ['needs-you'], description: CARD }, 'platform'); update('sy-6', { assignee: 'review' }, 'platform')
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

  console.log('== "blocked" comes from dependencies: blocked by hand with nothing it waits on is one line in the digest')
  item('sy-20', { status: 'blocked', assignee: 'platform' }, 'platform') // by hand, waits on nothing
  item('sy-21', { status: 'blocked', assignee: 'platform' }, 'platform'); item('sy-22', { assignee: 'ops' }, 'ops'); dep('dep_add', 'sy-21', 'sy-22') // an open blocker
  item('sy-23', { status: 'blocked', assignee: 'platform', labels: ['needs-you'], description: CARD }, 'platform') // waits on a person
  item('sy-24', { status: 'blocked', assignee: 'platform' }, 'platform'); items.get('sy-24').dependencies = [{ depends_on_id: 'sy-22', type: 'blocks' }] // bd's own list
  item('sy-26', { status: 'closed', assignee: 'ops' }, 'ops')
  item('sy-25', { status: 'blocked', assignee: 'platform' }, 'platform'); dep('dep_add', 'sy-25', 'sy-26') // its only blocker is closed
  at(110); await supervise()
  ok('under 10 min blocked: not yet', !openOf('digest:platform'))
  at(113); await supervise()
  const B = openOf('digest:platform')
  ok('digest:platform: sy-20 and sy-25 "blocked with nothing it waits on"', /^- blocked with nothing it waits on: sy-20 /m.test(B?.description) && /^- blocked with nothing it waits on: sy-25 /m.test(B?.description))
  ok('...not sy-21 (an open blocker in the journal), sy-24 (in its dependencies), sy-23 (needs-you)', !/sy-21|sy-23|sy-24/.test(B?.description))
  ok('...only such lines: P2, and it says what to do', B?.priority === 2 && /bd dep add/.test(B.description))
  ok('no item of its own for a blocked item', sup().filter((i) => i.status !== 'closed').length === 2 && openKeys() === 'digest:platform digest:review')
  at(118); await supervise()
  ok('reported once: the same item, no comment, unchanged', openOf('digest:platform')?.id === B.id && B.comments.length === 0 && byKey('digest:platform').filter((i) => i.status !== 'closed').length === 1)
  dep('dep_remove', 'sy-21', 'sy-22'); dep('dep_add', 'sy-20', 'sy-22')
  at(123); await supervise()
  const B2 = openOf('digest:platform')
  ok('a blocker removed (sy-21) adds its line; a blocker added (sy-20) drops one', B2?.id === B.id && /: sy-21 /.test(B2.description) && !/: sy-20 /.test(B2.description) && B2.comments.length === 0)

  console.log('== long thread, no artifact (sy-kmhx): more than 15 comments and no linked file is a line in the digest')
  const talk = (id, n) => { for (let k = 1; k <= n; k++) comment(id, k % 2 ? 'ops' : 'review', `Point ${k}: we went over it again, see #${k} above.`) }
  item('sy-30', { assignee: 'ops' }, 'ops'); talk('sy-30', 16)                                    // wordy, no file
  item('sy-31', { assignee: 'ops' }, 'ops'); talk('sy-31', 15)                                    // at the limit, not over
  item('sy-32', { assignee: 'ops', description: 'Plan: plans/sy-32-rotate.md' }, 'ops'); talk('sy-32', 20) // linked in its description
  item('sy-33', { assignee: 'ops' }, 'ops'); talk('sy-33', 18); comment('sy-33', 'ops', 'The design is in `docs/board/sy-33-layout.md`.') // linked in a comment
  item('sy-34', { assignee: 'ops', status: 'closed' }, 'ops'); talk('sy-34', 30)                 // closed
  item('sy-35', { assignee: 'ops' }, 'ops'); talk('sy-35', 17); comment('sy-35', 'ops', 'Compare mydocs/x.md and https://example.org/docs/y.md.') // not a repo path
  at(130); await supervise()
  const W = openOf('digest:ops')
  ok('digest:ops: sy-30 and sy-35, with their counts', /^- long thread, no artifact: sy-30 \(16 comments, ops\)/m.test(W?.description) && /^- long thread, no artifact: sy-35 \(18 comments, ops\)/m.test(W?.description))
  ok('...not sy-31 (15), sy-32 (description links a plan), sy-33 (a comment links a doc), sy-34 (closed)', !/sy-31|sy-32|sy-33|sy-34/.test(W?.description))
  ok('...low (P2), and it says what to do', W?.priority === 2 && /put the substance in a file/.test(W.description))
  comment('sy-30', 'ops', 'Moved it all to plans/sy-30-backup.md; the description holds the state.')
  at(135); await supervise()
  const W2 = openOf('digest:ops')
  ok('a link appears: sy-30\'s line drops off, the same item, no comment', W2?.id === W.id && !/sy-30/.test(W2.description) && /sy-35/.test(W2.description) && W2.comments.length === 0)
} finally {
  srv.close()
  if (fail) console.log(out.slice(-3000))
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
