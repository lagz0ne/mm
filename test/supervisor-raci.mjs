#!/usr/bin/env node
// bin/supervisor (profile system) and the RACI (sy-lusk): an ASK to a role that is only C in the item's row (act:<id>)
// is never late (no answer by By = "no input"); a HANDOFF to the row's V waits for a VERDICT (re #n or on its Head), an
// ANSWER is not one ("no VERDICT after By", in V's digest); an ASK to a role that is only I is "ASK outside the RACI"
// (in its writer's digest); an item with no activity keeps "no answer after By"; open items without a valid Task are one
// list (task:open), edited in place, closed when none is left.
// Hermetic: temp folder, a fake bd-serve, a stub paseo and mm; a fake clock (SUPERVISOR_NOW). The harness is
// test/supervisor-digest.mjs's.
//   node test/supervisor-raci.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-raci-'))
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

fs.writeFileSync(path.join(SYS, 'leads/raci.json'), JSON.stringify({ activities: [
  { id: 'chg', title: 'A change', raci: { platform: 'R', review: 'VA', ops: 'C', human: 'I' }, consult: ['ops: when it changes a port'] },
  { id: 'sec', title: 'Security', raci: { review: 'RA', ops: 'I', platform: 'R' } }] }))
const TASK = (act) => `## Task\n- **Task:** Add the port check.\n- **Act:** ${act}\n- **Done when:** the check runs.\n- **Verify:** test/x.sh → 3 passed\n`
const msg = (head, lines) => [head, ...lines].join('\n')
const EXP = (role) => [`Expect: ${role}: say if port 8080 is free.`, 'Done when: an ANSWER names it.', 'Verify: ss -ltn → no :8080', 'By: next wake · Else: platform picks another']
const ASK = (role) => msg(`ASK → ${role}`, [...EXP(role), 'Why: the service needs a port'])
const HO = (head) => msg('HANDOFF → review', [`Head: mm@${head}`, 'Expect: review: sign off or block this head.', `Done when: a VERDICT on mm@${head}.`, `Verify: bd show x → signed-head:mm@${head}`, 'By: next wake · Else: nothing rolls out', 'Ready: the gate'])
const VERDICT = (head, re) => msg(`VERDICT → platform · re #${re}`, [`Head: mm@${head}`, 'Expect: platform: land this head.', 'Done when: main has it.', 'Verify: git log main → it', 'By: today · Else: it waits', 'Result: signed off'])
const ANSWER = (re) => msg(`ANSWER → platform · re #${re}`, ['Expect: none', 'Verify: the thread → #1', 'Answer: looking at it'])
try {
  item('sy-1', { assignee: 'platform', labels: ['act:chg'], description: TASK('chg') }, 'platform'); comment('sy-1', 'platform', ASK('ops'))
  item('sy-2', { assignee: 'platform', labels: ['act:chg'], description: TASK('chg') }, 'platform'); comment('sy-2', 'platform', HO('aaaaaaa')); comment('sy-2', 'review', ANSWER(1))
  item('sy-3', { assignee: 'platform', labels: ['act:chg'], description: TASK('chg') }, 'platform'); comment('sy-3', 'platform', HO('bbbbbbb')); comment('sy-3', 'review', VERDICT('bbbbbbb', 1))
  item('sy-4', { assignee: 'platform', labels: ['act:sec'], description: TASK('sec') }, 'platform'); comment('sy-4', 'platform', ASK('ops'))
  item('sy-5', { assignee: 'platform', description: TASK('chg') }, 'platform'); comment('sy-5', 'platform', ASK('review'))
  item('sy-6', { assignee: 'ops', description: 'Older item, no Task.' }, 'alex')
  item('sy-7', { assignee: 'ops', description: TASK('nope') }, 'alex')
  at(90); await supervise()
  const rv = openOf('digest:review')?.description || '', pf = openOf('digest:platform')?.description || '', tk = openOf('task:open')
  ok('an ASK to ops, only C in act:chg, 90 min after its By: no line (no input), no digest for ops', !openOf('digest:ops') && !/sy-1 /.test(rv + pf))
  ok('a HANDOFF to review (V) answered by an ANSWER only: "no VERDICT after By" in review\'s digest', /no VERDICT after By: sy-2 #1 HANDOFF from platform → review \(head mm@aaaaaaa\)/.test(rv))
  ok('...not also as "no answer after By"', !/no answer after By: sy-2/.test(rv))
  ok('a HANDOFF with a VERDICT re #1: no line', !/sy-3/.test(rv + pf))
  ok('an ASK to ops, only I in act:sec: "ASK outside the RACI" in platform\'s digest (its writer)', /ASK outside the RACI: sy-4 #1 from platform → ops, who is I in sec/.test(pf))
  ok('an ASK on an item with no activity: still "no answer after By"', /no answer after By: sy-5 #1 ASK from platform → review/.test(rv))
  ok('task:open lists the open items without a valid Task (no Task; Act not in raci.json), and only those',
    !!tk && tk.priority === 3 && /- sy-6 \(ops\): no Task/.test(tk.description) && /- sy-7 \(ops\): Act "nope" is not an activity/.test(tk.description) && !/sy-[1-5] /.test(tk.description))
  update('sy-6', { description: TASK('sec') }, 'ops'); update('sy-7', { status: 'closed' }, 'ops')
  at(95); await supervise()
  ok('...the Tasks fixed (or the item closed): task:open closes itself', !openOf('task:open') && byKey('task:open').length === 1)
} finally {
  srv.close()
  if (fail) console.log(out.slice(-3000))
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
