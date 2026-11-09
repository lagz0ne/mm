#!/usr/bin/env node
// bin/supervisor (profile system) against a fake bd-serve, a stub paseo, a stub mm and throwaway git repos, step by step
// on a fake clock (SUPERVISOR_NOW): each finding opens (a role's digest of stalls, handoffs and idle leads, dirty, t2-unapproved), a change becomes a comment (a digest: an edit), nothing
// is opened twice, each clears and closes; a comment, a commit or an agent turn each keeps an item from stalling; a
// failing source, a lost state file and an item closed by someone. Hermetic: temp folder only; nothing live is touched.
//   node test/supervisor.mjs            exit 0 = every check passed
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const MIN = 60000
const T0 = Date.now()
let clock = T0
const iso = (t) => new Date(t).toISOString()

// ---------- the board folder as the system profile lays it out: <sys>/bin/supervisor + bin/lib, leads/roles.json ----------
const HOME = path.join(T, 'home'), SYS = path.join(T, 'sys')
fs.mkdirSync(path.join(SYS, 'bin'), { recursive: true }); fs.mkdirSync(path.join(SYS, 'leads'), { recursive: true }); fs.mkdirSync(HOME)
fs.copyFileSync(path.join(SRC, 'template/profiles/system/bin/supervisor'), path.join(SYS, 'bin/supervisor'))
fs.cpSync(path.join(SRC, 'template/bin/lib'), path.join(SYS, 'bin/lib'), { recursive: true })
fs.writeFileSync(path.join(SYS, 'leads/roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))
// this timeline runs on shorter windows than the defaults (stall 60, handoff 30: test/supervisor-digest.mjs), through the
// config; and its t2 items set blocked by hand (sy-12) are not about blocked lines (those: test/supervisor-digest.mjs), so
// config ignore leaves them out (it applies to a digest line's key)
const BASE_CONF = JSON.stringify({ minutes: { stall: 30, handoff: 10 }, ignore: ['^blocked:'] })
fs.writeFileSync(path.join(SYS, 'supervisor.json'), BASE_CONF)

// ---------- stub paseo (agents/<role>.json = that lead; paseo.fail = it breaks) and stub mm (ls.json) ----------
const AG = path.join(T, 'agents'); fs.mkdirSync(AG)
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
[ -f "${T}/paseo.fail" ] && { echo "paseo daemon not running" >&2; exit 1; }
[ "$1" = ls ] || { echo "stub paseo: only ls" >&2; exit 9; }
for a in "$@"; do case "$a" in role=*) f="${AG}/\${a#role=}.json"; [ -f "$f" ] && cat "$f" || echo '[]'; exit 0 ;; esac; done
echo '[]'
`, { mode: 0o755 })
const lead = (role, status) => (status ? fs.writeFileSync(path.join(AG, `${role}.json`), JSON.stringify([{ id: `agent-${role}-0001`, shortId: `ag${role}`, status, cwd: SYS }])) : fs.rmSync(path.join(AG, `${role}.json`), { force: true }))
fs.writeFileSync(path.join(T, 'mm'), `#!/bin/sh\n[ "$1 $2" = "ls -o" ] && exec cat "${T}/ls.json"\necho "stub mm: $*" >&2; exit 9\n`, { mode: 0o755 })

// ---------- throwaway git repos: the mm repo (~/mm) with a worktree, a project p1, a throwaway project p2 ----------
const GENV = { ...process.env, HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, args, t = clock) => execFileSync('git', ['-C', dir, ...args], { env: { ...GENV, GIT_AUTHOR_DATE: iso(t), GIT_COMMITTER_DATE: iso(t) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const touch = (f, t) => fs.utimesSync(f, new Date(t), new Date(t))
const write = (f, s, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); touch(f, t) }
function repo(dir) { fs.mkdirSync(dir, { recursive: true }); git(dir, ['init', '-q', '-b', 'main']); write(path.join(dir, 'README'), 'x\n', clock - 600 * MIN); git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'init'], clock - 600 * MIN) }
const MMR = path.join(HOME, 'mm'), WT = path.join(HOME, 'mm-wt', 'feat'), P1 = path.join(T, 'p1'), P2 = path.join(T, 'p2')
repo(MMR); repo(P1); repo(P2)
git(MMR, ['worktree', 'add', '-q', '-b', 'feat', WT])
write(path.join(WT, 'src.ts'), 'half done\n', clock - 60 * MIN) // left an hour ago: dirty at once
write(path.join(P2, 'junk'), 'x\n', clock - 60 * MIN) // a throwaway project: never reported
write(path.join(P1, 'fresh'), 'x\n', clock) // being worked on now: not yet
// review sy-futg: box projects are never read (p3: its answers say box; p4: mm keeps a host folder for it), and no repo's
// own config runs anything (p5, a clean host project). Each repo's core.fsmonitor is a trap that writes a canary file.
const P3 = path.join(T, 'p3'), P4 = path.join(T, 'p4'), P5 = path.join(T, 'p5'), canary = (p) => path.join(T, `ran-${path.basename(p)}`)
for (const p of [P3, P4, P5]) {
  repo(p)
  fs.writeFileSync(path.join(T, `trap-${path.basename(p)}`), `#!/bin/sh\necho ran >"${canary(p)}"\n`, { mode: 0o755 })
  git(p, ['config', 'core.fsmonitor', path.join(T, `trap-${path.basename(p)}`)])
}
fs.writeFileSync(path.join(P3, '.mm-answers.yaml'), 'project: p3\nbox: true\n'); touch(path.join(P3, '.mm-answers.yaml'), clock - 60 * MIN)
write(path.join(P3, 'boxjunk'), 'x\n', clock - 60 * MIN); write(path.join(P4, 'boxjunk'), 'x\n', clock - 60 * MIN) // dirty and old: would be found if read
fs.mkdirSync(path.join(HOME, '.mm', 'box', 'p4'), { recursive: true })
fs.writeFileSync(path.join(T, 'ls.json'), JSON.stringify([{ project: 'p1', root: P1 }, { project: 'p2', root: P2, throwaway: true }, { project: 'sysqa', root: SYS },
  { project: 'p3', root: P3 }, { project: 'p4', root: P4 }, { project: 'p5', root: P5 }]))
git(SYS, ['init', '-q', '-b', 'main']) // the board's own repo: everything it writes is ignored, so it stays clean
fs.writeFileSync(path.join(SYS, '.gitignore'), '/*\n!/.gitignore\n'); git(SYS, ['add', '.gitignore']); git(SYS, ['commit', '-qm', 'init'], clock - 600 * MIN)

// ---------- fake bd-serve: items, comments, the event journal ----------
const items = new Map(), events = []
let seq = 0, nextId = 1
const snap = (i) => ({ ...i, comments: undefined })
const record = (op, i, actor, t, comment) => events.push({ seq: ++seq, op, issue_id: i.id, actor, ts: iso(t), issue: snap(i), ...(comment ? { comment } : {}) })
function item(id, f, actor = 'ops', t = clock) {
  const i = { id, title: f.title || id, status: f.status || 'open', priority: f.priority ?? 2, assignee: f.assignee || '', labels: f.labels || [], description: f.description || '', updated_at: iso(t), comments: [] }
  items.set(id, i); record('create', i, actor, t); return i
}
function comment(id, author, text, t = clock) {
  const i = items.get(id), c = { id: `c${seq + 1}`, author, text, created_at: iso(t) }
  i.comments.push(c); i.updated_at = iso(t); record('comment', i, author, t, c)
}
function update(id, f, actor, t = clock) { const i = items.get(id); Object.assign(i, f, { updated_at: iso(t) }); record(f.status === 'closed' ? 'close' : 'update', i, actor, t) }
// the go as it is given since sy-6gz6: the card names its Head, review signed that head (review's own write, first), and
// the approver writes approved with approved-head:<that head>. go(): an approver's approved, the way the bridge writes it.
const GH = 'mm@0a1b2c3'
const GCARD = (head = GH) => `## Owner\n- **What:** Open a port.\n- **Why:** The service needs it.\n- **You:** Tap Approve\n- **If yes:** Ops opens it.\n- **If no:** It stays shut.\n- **Risk:** low, one port\n- **Head:** ${head}\n\nThe plan.`
function go(id, labels, actor, t = clock) {
  const i = items.get(id), sh = `signed-head:${GH}`
  if (!/\*\*Head:\*\*/.test(i.description) || !i.labels.includes(sh)) update(id, { description: GCARD(), labels: [...new Set([...i.labels, sh])] }, 'review', t)
  update(id, { labels: [...new Set([...labels, sh, `approved-head:${GH}`])] }, actor, t)
}
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (fs.existsSync(path.join(T, 'bd.fail'))) return json({ error: 'down' }, 503)
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') {
    // as bd serve does: closed items are left out unless a status asks for them (sy-7xq0)
    const label = u.searchParams.get('label'), status = u.searchParams.get('status')?.split(',')
    return json({ items: [...items.values()].filter((i) => (!label || i.labels.includes(label)) && (status ? status.includes(i.status) : i.status !== 'closed')).map(snap), has_more: false })
  }
  if (req.method === 'GET' && u.pathname === '/v0/beads/ready') return json({ items: [...items.values()].filter((i) => i.status === 'open').map(snap) })
  if (req.method === 'GET' && u.pathname === '/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0), limit = Number(u.searchParams.get('limit') || 500)
    return json({ head: seq, records: events.filter((e) => e.seq > since).slice(0, limit) })
  }
  if (req.method === 'POST' && u.pathname === '/v0/beads/issues') return json({ id: item(`sy-s${nextId++}`, { ...b, labels: b.labels }, b.actor).id })
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname))) { comment(m[1], b.author, b.text); return json({}) }
  if (req.method === 'PATCH' && (m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname))) { update(m[1], b.patch, b.actor); return json({ issue: snap(items.get(m[1])) }) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+):close$/.exec(u.pathname))) {
    // as bd does: a close by another actor than the assignee is refused unless forced (sy-pp2a)
    const it = items.get(m[1])
    if (it && it.assignee && b.actor && it.assignee !== b.actor && !b.force) { res.writeHead(409, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: `cannot close ${m[1]}: assignee is "${it.assignee}", actor is "${b.actor}"; reclaim or use --force to override` })) }
    update(m[1], { status: 'closed', close_reason: b.reason }, b.actor); return json({})
  }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`

const STATE = path.join(SYS, '.supervisor.json'), LOG = path.join(T, 'run.log')
const ENV = { PATH: process.env.PATH, HOME, MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_BIN: path.join(T, 'mm'), MM_BRAIN: path.join(T, 'brain'), BRAIN_STATE: path.join(T, 'brain-state'),
  SVC_URL_BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
/** One supervisor run at `clock`; resolves with its exit code (its output goes to run.log). */
const supervise = () => new Promise((resolve) => {
  const p = spawn('node', [path.join(SYS, 'bin/supervisor')], { env: { ...ENV, SUPERVISOR_NOW: String(clock) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  p.on('close', (code) => { fs.appendFileSync(LOG, `--- at +${Math.round((clock - T0) / MIN)} min (exit ${code})\n${out}`); resolve(code) })
})
const KEY = /supervisor key: `([^`]+)`/
const sup = () => [...items.values()].filter((i) => i.labels.includes('supervisor'))
const openKeys = () => sup().filter((i) => i.status !== 'closed').map((i) => KEY.exec(i.description)?.[1]).sort().join(' ')
const byKey = (k) => sup().filter((i) => KEY.exec(i.description)?.[1] === k)
const openOf = (k) => byKey(k).find((i) => i.status !== 'closed')
const DIRTY = 'dirty:~/mm-wt/feat'

// ---------- the board at T0 ----------
lead('ops', 'running'); lead('review', 'idle'); lead('platform', 'idle')
item('sy-1', { title: 'stalls', status: 'in_progress', priority: 1, assignee: 'platform' }); comment('sy-1', 'platform', 'Plan: do it.')
item('sy-2', { title: 'moves by commits', status: 'in_progress', priority: 1, assignee: 'platform' }); comment('sy-2', 'platform', 'Plan: commits.')
item('sy-3', { title: 'moves by agent turns', status: 'in_progress', priority: 0, assignee: 'ops' }); comment('sy-3', 'ops', 'Working.')
item('sy-4', { title: 'handed over', status: 'in_progress', priority: 2, assignee: 'platform' }); comment('sy-4', 'platform', 'Built it: 1a2b3c4.')
update('sy-4', { assignee: 'review', status: 'open' }, 'platform') // the handoff: a reassign (bd update -a review --if-assignee platform)
item('sy-5', { title: 'ready P0 for review', priority: 0, assignee: 'review' })
item('sy-7', { title: 'waits for the owner', priority: 2, assignee: 'platform' }); update('sy-7', { assignee: 'alex' }, 'platform') // to a person: needs-you's
item('sy-10', { title: 'an old signal line', priority: 2, assignee: 'platform' }); comment('sy-10', 'platform', 'Done.\nHANDOFF review 9z9z9z9') // words, not a reassign
item('sy-8', { title: 'P2 in progress, quiet', status: 'in_progress', priority: 2, assignee: 'platform' })

step('run 1 (+0 min): only the old uncommitted worktree')
ok('exit 0', (await supervise()) === 0)
ok(`open: ${DIRTY} (not p1: touched now; not p2: throwaway; not the board's own repo)`, openKeys() === DIRTY)
const D = openOf(DIRTY)
ok('item for ops, label supervisor, task, P2, by watchdog', D && D.assignee === 'ops' && D.labels.join() === 'supervisor' && D.priority === 2 && events.find((e) => e.issue_id === D.id).actor === 'watchdog')
ok('it names the file', D && D.description.includes('src.ts') && D.description.includes('feat'))
ok('box projects are never read: no dirty finding for p3 (answers box) or p4 (host box folder) (review sy-futg)', !openKeys().includes('p3') && !openKeys().includes('p4'))
ok('no repo config ran: no core.fsmonitor command in p3, p4 or p5 (review sy-futg)', [P3, P4, P5].every((p) => !fs.existsSync(canary(p))))

step('run 2 (+12 min): handoff and idle: two lines of one digest (review)')
clock = T0 + 12 * MIN
git(P1, ['add', 'fresh']); git(P1, ['commit', '-qm', 'fresh']) // p1's work got committed
ok('exit 0', (await supervise()) === 0)
ok('open: dirty and digest:review (a reassign to a person, a HANDOFF comment line and P2 in progress are not watched)', openKeys() === `digest:review ${DIRTY}`)
const R = openOf('digest:review')
ok('one digest, two lines: the handoff of sy-4 and the idle lead (sy-5)', /^- handoff waits: sy-4 was handed to review/m.test(R?.description) && /^- idle: the review lead is idle .*sy-5/m.test(R?.description) && /Supervisor digest: review \(2 waiting\)/.test(R?.title))

step('run 3 (+17 min): nothing changed: no duplicate, no comment, no edit')
clock = T0 + 17 * MIN
const ev3 = events.length
ok('exit 0', (await supervise()) === 0)
ok('no duplicates', openKeys() === `digest:review ${DIRTY}` && sup().length === 2)
ok('no comments, no edits on unchanged findings', sup().every((i) => i.comments.length === 0) && !events.slice(ev3).some((e) => e.actor === 'watchdog'))

step('run 4 (+20 min): a line changes -> the digest is edited in place, no comment')
clock = T0 + 20 * MIN
item('sy-6', { title: 'another ready P0 for review', priority: 0, assignee: 'review' }, 'alex')
ok('exit 0', (await supervise()) === 0)
const I = openOf('digest:review')
ok('the digest names sy-6 now, with no comment', I.id === R.id && I.description.includes('sy-6') && I.comments.length === 0)
ok('still one item per key', byKey('digest:review').length === 1 && sup().length === 2)

step('run 5 (+35 min): stall; a commit and an agent turn each prevent one')
clock = T0 + 30 * MIN
write(path.join(MMR, 'b.txt'), 'b\n', clock); git(MMR, ['add', 'b.txt']); git(MMR, ['commit', '-qm', 'more of it', '-m', 'sy-2'])
comment('sy-8', 'watchdog', 'a system note does not count') // and a P2 never stalls anyway
comment('sy-1', 'wake', 'Paused: a system author is not activity')
clock = T0 + 35 * MIN
ok('exit 0', (await supervise()) === 0)
ok('digest:platform opened for sy-1; not sy-2 (commit 5 min ago), not sy-3 (ops lead running)', openKeys() === `digest:platform digest:review ${DIRTY}` && !/sy-2|sy-3/.test(openOf('digest:platform').description))
ok('its stall line says when sy-1 last moved; the digest is P1', /^- stalled: sy-1 \(P1/m.test(openOf('digest:platform')?.description) && openOf('digest:platform').priority === 1 && openOf('digest:platform').description.includes(iso(T0).replace(/\.\d+Z$/, 'Z')))

step('run 6 (+40 min): every finding clears -> closed; a digest with no comment')
clock = T0 + 36 * MIN
comment('sy-4', 'review/w1', 'Looking at 1a2b3c4.') // a worker of review answers the handoff
comment('sy-1', 'alex', 'Any news?') // a human comment is activity
lead('review', 'running')
git(WT, ['add', 'src.ts']); git(WT, ['commit', '-qm', 'done'])
clock = T0 + 40 * MIN
const before = sup().map((i) => i.id)
ok('exit 0', (await supervise()) === 0)
ok('no supervisor item open', openKeys() === '')
ok('all closed; the digests with no comment, the dirty one with "Cleared"', before.every((id) => items.get(id).status === 'closed') &&
  sup().filter((i) => /digest:/.test(i.description)).every((i) => i.comments.length === 0) && /Cleared/.test(byKey(DIRTY)[0].comments.at(-1).text))

update('sy-1', { status: 'closed' }, 'platform'); update('sy-2', { status: 'closed' }, 'platform')

step('run 7 (+46 min): a source fails (paseo): its checks say so, the others go on')
clock = T0 + 46 * MIN
fs.writeFileSync(path.join(T, 'paseo.fail'), '')
write(path.join(WT, 'again.ts'), 'x\n', clock - 31 * MIN)
ok('exit 0 (the failure is on the board)', (await supervise()) === 0)
ok('supervisor:stall, supervisor:idle and supervisor:twoleads opened; dirty still found', openKeys() === `${DIRTY} supervisor:idle supervisor:stall supervisor:twoleads`)
fs.rmSync(path.join(T, 'paseo.fail'))
clock = T0 + 51 * MIN
ok('exit 0', (await supervise()) === 0)
ok('paseo back: supervisor:* closed', openKeys() === DIRTY)

step('run 8 (+56 min): state lost: no duplicate, no made-up comment')
fs.rmSync(STATE)
clock = T0 + 56 * MIN
ok('exit 0', (await supervise()) === 0)
ok('the open item is adopted, not opened again', openKeys() === DIRTY && byKey(DIRTY).filter((i) => i.status !== 'closed').length === 1)
ok('no comment made up after state loss', openOf(DIRTY).comments.length === 0)
ok('old handoffs from the journal are read again, and stay answered', !openKeys().includes('digest'))

step('run 9 (+61 min): someone closes an item while its finding is there: muted until it clears')
const D2 = openOf(DIRTY)
update(D2.id, { status: 'closed' }, 'alex')
clock = T0 + 61 * MIN
ok('exit 0', (await supervise()) === 0)
ok('not opened again', openKeys() === '' && byKey(DIRTY).length === 2)
ok('muted in state', !!JSON.parse(fs.readFileSync(STATE, 'utf8')).muted[DIRTY])
git(WT, ['add', 'again.ts']); git(WT, ['commit', '-qm', 'again'])
clock = T0 + 66 * MIN
await supervise()
ok('cleared: mute lifted', !JSON.parse(fs.readFileSync(STATE, 'utf8')).muted[DIRTY])
write(path.join(WT, 'third.ts'), 'x\n', clock - 31 * MIN)
clock = T0 + 71 * MIN
await supervise()
ok('it comes back: a new item', byKey(DIRTY).length === 3 && !!openOf(DIRTY))

step('run 9b (+76 min): wake requeues an expired claim: no finding (wake\'s own comment on the item says it)')
item('sy-9', { title: 'claimed, then quiet', status: 'in_progress', priority: 1, assignee: 'platform' }, 'platform', T0 + 20 * MIN)
clock = T0 + 76 * MIN
update('sy-9', { status: 'open' }, 'wake') // the requeue: status open, assignee the role, by wake
comment('sy-9', 'wake', 'Requeued: its claim expired.')
ok('exit 0', (await supervise()) === 0)
ok('no stall:sy-9 for the requeue (nor anything else for it)', openKeys() === DIRTY && !sup().some((i) => /sy-9/.test(i.description)))
clock = T0 + 81 * MIN
comment('sy-9', 'platform', 'Taking it again.')
ok('exit 0', (await supervise()) === 0)
ok('still nothing for it', openKeys() === DIRTY)

step('run 9b2 (+82..84 min): an item a role took over still closes when it clears (sy-pp2a)')
const D3 = openOf(DIRTY)
update(D3.id, { assignee: 'platform' }, 'ops') // the handoff: ops reassigns the Supervisor's item to platform
git(WT, ['add', 'third.ts']); git(WT, ['commit', '-qm', 'third'])
clock = T0 + 82 * MIN
ok('exit 0: the run does not stop on it', (await supervise()) === 0)
ok('the reassigned item is closed (with force: bd refuses another actor\'s close otherwise), with "Cleared"', items.get(D3.id).status === 'closed' && /Cleared/.test(items.get(D3.id).comments.at(-1).text))
write(path.join(WT, 'fourth.ts'), 'x\n', clock - 31 * MIN) // dirty again, so the runs below see what they did before
clock = T0 + 84 * MIN
await supervise()
ok('...and it comes back as a new item when the worktree is dirty again', !!openOf(DIRTY))

step('run 9c (+86 min): t2 items that go ahead without the approver\'s approved (sy-6v8p)')
// the approvers: the bridge's actor (default `bridge`) and the owner's name, from the board's run files
fs.mkdirSync(path.join(SYS, '.run'), { recursive: true }); fs.writeFileSync(path.join(SYS, '.run/endpoints.json'), JSON.stringify({ owner_name: 'alex', services: {} }))
const BRAIN = ENV.MM_BRAIN, MIGS = path.join(BRAIN, 'migrations'), DONE = path.join(ENV.BRAIN_STATE, 'migrations')
fs.mkdirSync(MIGS, { recursive: true }); fs.mkdirSync(DONE, { recursive: true })
// tier: the header's (0: no tier line); body/rollback: the scripts' commands; mark: the tier bin/brain wrote in the state mark
const migration = (name, summary, applied, tier = 2, { body = 'true', rollback = 'true', mark } = {}) => {
  fs.writeFileSync(path.join(MIGS, `${name}.sh`), `# brain:summary=${summary}\n${tier ? `# brain:tier=${tier}\n` : ''}${body}\n`)
  fs.writeFileSync(path.join(MIGS, `${name}.rollback.sh`), `# brain:summary=undo (${summary})\n${rollback}\n`)
  if (applied) fs.writeFileSync(path.join(DONE, `${name}.sh`), `${iso(clock)} abc1234${mark ? ` tier=${mark}` : ''}\n`)
}
clock = T0 + 86 * MIN
item('sy-11', { title: 't2 claimed, no approval', priority: 2, assignee: 'ops', labels: ['t2', 'signed-off'] }, 'review') // review's own sign-off (sy-9bss)
update('sy-11', { status: 'in_progress' }, 'ops')
item('sy-12', { title: 't2, approved by a lead', priority: 2, assignee: 'ops', labels: ['t2'] })
update('sy-12', { labels: ['t2', 'approved'] }, 'platform'); update('sy-12', { status: 'in_progress' }, 'ops')
item('sy-13', { title: 't2, approved by the bridge', priority: 2, assignee: 'ops', labels: ['t2'] })
go('sy-13', ['t2', 'approved'], 'bridge'); update('sy-13', { status: 'in_progress' }, 'ops')
item('sy-14', { title: 't2, its migration applied while open', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000001-fw', 'open a port (sy-14)', true)
item('sy-15', { title: 't2, its migration not applied', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000002-fw', 'close a port (sy-15)', false)
item('sy-16', { title: 't1 in progress', status: 'in_progress', priority: 2, assignee: 'ops', labels: ['t1'] })
item('sy-17', { title: 't2, applied then closed', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000003-ssh', 'sshd change (sy-17)', true); update('sy-17', { status: 'closed' }, 'ops')
item('sy-18', { title: 'created with approved by a lead, then claimed', status: 'open', priority: 2, assignee: 'ops', labels: ['t2', 'approved'] }, 'platform')
update('sy-18', { status: 'in_progress' }, 'ops')
// sy-hqa1: a tier-1 migration that names a t2 item only as its reason opens nothing; one with no tier line counts
item('sy-19', { title: 't2, only a tier-1 migration names it', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000004-podman', 'install podman (for sy-19)', true, 1)
item('sy-20', { title: 't2, its migration has no tier line', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000005-fw', 'open a port (sy-20)', true, 0)
// sy-0cvx: in progress alone is not live; a commit naming them on mm's main is (sy-11, sy-12, sy-18)
git(MMR, ['commit', '-q', '--allow-empty', '-m', 'landed t2 work', '-m', 'sy-11 sy-12 sy-18'])
// sy-1jmi: a supervisor.json an agent wrote, naming a lead as an approver and ignoring the t2 keys, changes nothing
const CONFIG = path.join(SYS, 'supervisor.json')
fs.writeFileSync(CONFIG, JSON.stringify({ approvers: ['platform'], ignore: ['^t2-unapproved:'] }))
ok('exit 0', (await supervise()) === 0)
fs.writeFileSync(CONFIG, BASE_CONF) // this timeline's own config again
const T2 = (id) => `t2-unapproved:${id}`
ok('open: t2-unapproved for sy-11 (claimed), sy-12 and sy-18 (approved by a lead), sy-14 (migration applied), sy-17 (applied, then closed), sy-20 (no tier line: tier 2); not sy-13 (bridge), sy-15 (not applied), sy-16 (t1), sy-19 (tier-1 migration)',
  openKeys() === `${DIRTY} ${T2('sy-11')} ${T2('sy-12')} ${T2('sy-14')} ${T2('sy-17')} ${T2('sy-18')} ${T2('sy-20')}`)
ok('...with a supervisor.json naming platform an approver and ignoring t2 keys: sy-12 (approved by platform) still open (sy-1jmi)', !!openOf(T2('sy-12')))
const U = openOf(T2('sy-12'))
ok('the item is for ops, P1, and says a lead\'s approved does not count', U?.assignee === 'ops' && U.priority === 1 && /added by platform/.test(U.description) && /not an approver/.test(U.description))
ok('the migration finding names the migration', /1800000001-fw\.sh/.test(openOf(T2('sy-14'))?.description || ''))

step('run 9d (+91 min): approved by the bridge or the owner clears it; leaving in progress clears it; a lead\'s still does not')
clock = T0 + 91 * MIN
go('sy-11', ['t2', 'signed-off', 'approved'], 'bridge')
go('sy-14', ['t2', 'approved'], 'alex') // the owner's name (endpoints.json owner_name)
go('sy-17', ['t2', 'approved'], 'bridge') // after the fact, on a closed item
go('sy-20', ['t2', 'approved'], 'bridge')
update('sy-12', { status: 'blocked' }, 'ops') // no longer in progress, no migration
update('sy-18', { labels: ['t2', 'approved', 'signed-off'] }, 'review') // approved was already there (a lead's): still not the approver's
ok('exit 0', (await supervise()) === 0)
ok('only sy-18 stays (its approved came from a lead)', openKeys() === `${DIRTY} ${T2('sy-18')}`)
ok('each cleared one is closed with "Cleared"', ['sy-11', 'sy-12', 'sy-14', 'sy-17'].every((id) => byKey(T2(id)).every((i) => i.status === 'closed' && /Cleared/.test(i.comments.at(-1).text))))
update('sy-18', { labels: ['t2', 'signed-off'] }, 'ops'); go('sy-18', ['t2', 'signed-off', 'approved'], 'bridge')
clock = T0 + 96 * MIN
ok('exit 0', (await supervise()) === 0)
ok('approved removed, then set by the bridge: cleared', openKeys() === DIRTY)

step('run 9e (+101 min): the tier bin/brain applied, not the header (sy-7xq0 point 1)')
clock = T0 + 101 * MIN
item('sy-21', { title: 't2, a tier-1 header that writes /etc/', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000006-wrap', 'wrapper policy (sy-21)', true, 1, { body: 'install -m 644 policy /etc/mm-docker.conf' })
item('sy-22', { title: 't2, a tier-1 header whose rollback writes /usr/local/', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000007-bin', 'a tool (sy-22)', true, 1, { rollback: 'rm -f /usr/local/bin/tool' })
item('sy-23', { title: 't2, a tier-1 header, /etc/ only in a comment', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000008-doc', 'a note (sy-23)', true, 1, { body: '# nothing under /etc/ here\ntrue' })
item('sy-24', { title: 't2, a tier-1 header, the mark says tier 2', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000009-guard', 'guarded (sy-24)', true, 1, { mark: 2 })
item('sy-25', { title: 't2, no tier line, the mark says tier 1', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000010-small', 'small (sy-25)', true, 0, { mark: 1 })
ok('exit 0', (await supervise()) === 0)
ok('open: sy-21 (/etc/ in the script), sy-22 (/usr/local/ in the rollback), sy-24 (mark tier=2); not sy-23 (a comment), sy-25 (mark tier=1)',
  openKeys() === `${DIRTY} ${T2('sy-21')} ${T2('sy-22')} ${T2('sy-24')}`)
ok('the finding names the tier it read', /tier-2 migration 1800000006-wrap\.sh/.test(openOf(T2('sy-21'))?.description || ''))
for (const id of ['sy-21', 'sy-22', 'sy-24']) go(id, ['t2', 'approved'], 'bridge')
clock = T0 + 106 * MIN
await supervise()
ok('approved by the bridge: cleared', openKeys() === DIRTY)

step('run 9f (+111 min): an item a tier-2 migration names is t2 without the label; taking t2 off is reported (sy-7xq0 point 2)')
clock = T0 + 111 * MIN
item('sy-26', { title: 'no t2 label, a tier-2 migration names it', priority: 2, assignee: 'ops', labels: ['t1'] })
migration('1800000011-bridge', 'bridge v2 (sy-26)', true)
item('sy-27', { title: 'labelled t2, then a lead takes it off', priority: 2, assignee: 'ops', labels: ['t2'] })
migration('1800000012-probe', 'probe (sy-27)', true)
update('sy-27', { labels: [] }, 'platform')
item('sy-29', { title: 'no label, only a tier-1 migration names it', priority: 2, assignee: 'ops' })
migration('1800000013-tool', 'a tool (sy-29)', true, 1)
ok('exit 0', (await supervise()) === 0)
ok('open: sy-26 (no label), sy-27 (label removed); not sy-29 (tier 1)', openKeys() === `${DIRTY} ${T2('sy-26')} ${T2('sy-27')}`)
ok('sy-26\'s finding says it is not labelled t2', /not labelled t2, but a tier-2 migration names it/.test(openOf(T2('sy-26'))?.description || ''))
ok('sy-27\'s finding names who took t2 off', /removed by platform/.test(openOf(T2('sy-27'))?.description || '') && /platform removed its t2 label/.test(openOf(T2('sy-27'))?.title || ''))

step('run 9g (+116..131 min): a t2-unapproved finding is never muted by closing it; a closed t2 item stays watched (sy-7xq0 point 3)')
const F = openOf(T2('sy-26'))
update(F.id, { status: 'closed' }, 'ops') // a lead closes the finding; sy-26 is still unapproved
clock = T0 + 116 * MIN
ok('exit 0', (await supervise()) === 0)
ok('it is back on the next run: a new item, not muted', !!openOf(T2('sy-26')) && openOf(T2('sy-26')).id !== F.id && !JSON.parse(fs.readFileSync(STATE, 'utf8')).muted[T2('sy-26')])
ok('the new item says the earlier one was closed', /earlier item was closed/.test(openOf(T2('sy-26'))?.description || ''))
const G = openOf(T2('sy-27'))
update('sy-27', { status: 'closed' }, 'ops') // the item itself closes before any approval (sy-2c3w): closed items are left out of the board's default list
clock = T0 + 121 * MIN
ok('exit 0', (await supervise()) === 0)
ok('the closed item\'s finding stays open (the same item, not cleared)', items.get(G.id).status !== 'closed' && openOf(T2('sy-27'))?.id === G.id)
fs.rmSync(path.join(DONE, '1800000012-probe.sh')) // rolled back: its state mark is gone
go('sy-26', ['t1', 'approved'], 'alex')
clock = T0 + 126 * MIN
ok('exit 0', (await supervise()) === 0)
ok('rollback clears sy-27, the owner\'s approved clears sy-26', openKeys() === DIRTY && /Cleared/.test(items.get(G.id).comments.at(-1).text))

step('run 9h (+136 min): branch work is not live; a commit on a live main is; mm\'s records before it went in progress are not (sy-0cvx)')
// mm's own line per command (<mm>/pc/mm.log, as cli.ts writes it), and a service line inside process-compose's (api.log)
const PCD = path.join(HOME, '.mm', 'pc'); fs.mkdirSync(PCD, { recursive: true })
const mmLine = (op, args, t, extra = {}) => fs.appendFileSync(path.join(PCD, 'mm.log'), JSON.stringify({ time: iso(t), level: 'info', msg: `${op} ok`, project: 'mm', service: 'mm', op, duration_ms: 5, trace_id: 'x', args, exit_code: 0, ok: true, ...extra }) + '\n')
const svcLine = (file, proc, rec, t) => fs.appendFileSync(path.join(PCD, file), JSON.stringify({ level: 'info', process: proc, replica: 0, time: iso(t), message: JSON.stringify({ time: iso(t), level: 'info', project: 'mm', ...rec }) }) + '\n')
const BRAIN_REPO = ENV.MM_BRAIN; repo(BRAIN_REPO) // the brain as a git repo: its main is live too
clock = T0 + 130 * MIN
mmLine('mm config set', 'ai.budget 5', clock) // a t2 key, but before sy-30 went in progress
clock = T0 + 136 * MIN
item('sy-30', { title: 't2, built on a branch only', priority: 2, assignee: 'platform', labels: ['t2'] }); update('sy-30', { status: 'in_progress' }, 'platform')
item('sy-31', { title: 't2, a commit naming it on the brain\'s main', priority: 2, assignee: 'ops', labels: ['t2'] }); update('sy-31', { status: 'in_progress' }, 'ops')
git(WT, ['commit', '-q', '--allow-empty', '-m', 'build it', '-m', 'sy-30']) // on branch feat, in a worktree
git(BRAIN_REPO, ['commit', '-q', '--allow-empty', '-m', 'promote', '-m', 'sy-31'])
mmLine('mm config set', 'wake.cap 9', clock) // not a t2 key
mmLine('mm config set', 'api.enabled 1', clock, { ok: false, level: 'error', exit_code: 1 }) // failed: nothing changed
mmLine('mm box on', 'tp', clock, { mm_throwaway: 'tp' }) // a throwaway project's
ok('exit 0', (await supervise()) === 0)
ok('open: sy-31 only (commit on the brain\'s main); not sy-30 (branch commit; earlier, failed, throwaway or non-t2 records of mm)', openKeys() === `${DIRTY} ${T2('sy-31')}`)
ok('sy-31\'s finding names the commit and the main it is on', /on ~?\S*brain's main/.test(openOf(T2('sy-31'))?.description || '') && /has a commit on main/.test(openOf(T2('sy-31'))?.title || ''))
item('sy-32', { title: 't2, a commit naming it on mm\'s main', priority: 2, assignee: 'platform', labels: ['t2'] }); update('sy-32', { status: 'in_progress' }, 'platform')
git(MMR, ['commit', '-q', '--allow-empty', '-m', 'land', '-m', 'sy-32'])
clock = T0 + 141 * MIN
ok('exit 0', (await supervise()) === 0)
ok('a commit naming it on mm\'s main opens one (sy-32)', openKeys() === `${DIRTY} ${T2('sy-31')} ${T2('sy-32')}` && openOf(T2('sy-32'))?.priority === 1)
// sy-donx: a commit that names a t2 item but changes only tests, docs (mm) or plans, the journal, memory (the brain) runs
// nothing: no finding. One that changes code does.
item('sy-39', { title: 't2, only a test fix and a plan name it', priority: 2, assignee: 'platform', labels: ['t2'] }); update('sy-39', { status: 'in_progress' }, 'platform')
fs.mkdirSync(path.join(MMR, 'test'), { recursive: true }); fs.writeFileSync(path.join(MMR, 'test', 'x.sh'), 'x\n'); fs.writeFileSync(path.join(MMR, 'README.md'), 'x\n')
git(MMR, ['add', 'test/x.sh', 'README.md']); git(MMR, ['commit', '-q', '-m', 'tests: a fixture', '-m', 'found on sy-39'])
fs.mkdirSync(path.join(BRAIN_REPO, 'plans'), { recursive: true }); fs.writeFileSync(path.join(BRAIN_REPO, 'plans', 'p.md'), 'x\n')
git(BRAIN_REPO, ['add', 'plans/p.md']); git(BRAIN_REPO, ['commit', '-q', '-m', 'plan', '-m', 'sy-39'])
clock = T0 + 142 * MIN
ok('exit 0', (await supervise()) === 0)
ok('a test-only commit on mm\'s main and a plans-only one on the brain\'s, naming a t2 item: no finding (sy-39)', openKeys() === `${DIRTY} ${T2('sy-31')} ${T2('sy-32')}`)
fs.mkdirSync(path.join(MMR, 'src'), { recursive: true }); fs.writeFileSync(path.join(MMR, 'src', 'a.ts'), 'x\n')
git(MMR, ['add', 'src/a.ts']); git(MMR, ['commit', '-q', '-m', 'the change', '-m', 'sy-39'])
clock = T0 + 143 * MIN
ok('exit 0', (await supervise()) === 0)
ok('...a commit with code naming it: the finding opens', openKeys() === `${DIRTY} ${T2('sy-31')} ${T2('sy-32')} ${T2('sy-39')}`)
// review sy-xpkc #2: test/gates, test/gates.map and test/lib/ choose the tests a sign-off needs: they count as live
item('sy-38', { title: 't2, only the gates map names it', priority: 2, assignee: 'platform', labels: ['t2'] }); update('sy-38', { status: 'in_progress' }, 'platform')
fs.writeFileSync(path.join(MMR, 'test', 'gates.map'), 'x\n'); git(MMR, ['add', 'test/gates.map']); git(MMR, ['commit', '-q', '-m', 'gates: drop a suite', '-m', 'sy-38'])
clock = T0 + 144 * MIN
ok('exit 0', (await supervise()) === 0)
ok('...a commit that changes only test/gates.map, naming a t2 item: the finding opens (sy-38)', openKeys().includes(T2('sy-38')))
go('sy-38', ['t2', 'approved'], 'bridge')
go('sy-31', ['t2', 'approved'], 'bridge'); go('sy-32', ['t2', 'approved'], 'bridge'); go('sy-39', ['t2', 'approved'], 'bridge')

step('run 9i (+377..441 min): unapproved t2 items in progress over 4 h with nothing live: one P3 list, refreshed')
clock = T0 + 200 * MIN
item('sy-33', { title: 't2, also on a branch', priority: 2, assignee: 'ops', labels: ['t2'] }); update('sy-33', { status: 'in_progress' }, 'ops')
ok('exit 0', (await supervise()) === 0)
ok('under 4 h: no list, no P1', openKeys() === DIRTY)
clock = T0 + 377 * MIN
ok('exit 0', (await supervise()) === 0)
const W = openOf('t2-waiting')
ok('sy-30 (over 4 h) is on one P3 item; sy-33 (under 4 h) is not; no P1', openKeys() === `${DIRTY} t2-waiting` && W?.priority === 3 && /sy-30/.test(W.description) && !/sy-33/.test(W.description))
clock = T0 + 441 * MIN
ok('exit 0', (await supervise()) === 0)
ok('both now: the same item, one comment naming both', openOf('t2-waiting')?.id === W.id && byKey('t2-waiting').length === 1 && W.comments.length === 1 && /sy-30/.test(W.comments[0].text) && /sy-33/.test(W.comments[0].text))

step('run 9j (+446..451 min): a live step mm recorded while they are in progress opens a P1 (sy-0cvx c)')
clock = T0 + 445 * MIN
mmLine('mm config set', 'api.enabled s3cr3tvalue', clock)
svcLine('api.log', 'mm.api', { msg: 'request applied', service: 'api', box: 'p9', call: 'route', value: 'p9.example', id: 'r1', by: 'bridge' }, clock)
svcLine('api.log', 'mm.api', { msg: 'request applied', service: 'api', box: 'p9', call: 'route', value: 'p9.example', id: 'r2', by: 'cli' }, clock) // its mm.log line counts instead
clock = T0 + 446 * MIN
ok('exit 0', (await supervise()) === 0)
const L = openOf(T2('sy-30'))
ok('sy-30 and sy-33 get a P1; the list clears', openKeys() === `${DIRTY} ${T2('sy-30')} ${T2('sy-33')}` && L?.priority === 1 && byKey('t2-waiting').every((i) => i.status === 'closed'))
ok('it names the action and its time, never the value', /mm config set api\.enabled" at /.test(L?.description || '') && L.description.includes(iso(T0 + 445 * MIN).replace(/\.\d+Z$/, 'Z')) && !L.description.includes('s3cr3t'))
ok('and the bridge\'s applied request from mm.api\'s log, not the CLI\'s twice', /mm\.api applied route for p9 \(r1, by bridge\)/.test(L?.description || '') && !/r2/.test(L.description))
for (const id of ['sy-30', 'sy-33']) go(id, ['t2', 'approved'], 'bridge')
clock = T0 + 451 * MIN
ok('exit 0', (await supervise()) === 0)
ok('approved by the bridge: cleared', openKeys() === DIRTY)

step('run 9k (+456..461 min): a summary from an older Supervisor is read again from the start (sy-m5qr)')
item('sy-40', { title: 't2, approved by the bridge before an upgrade', priority: 2, assignee: 'ops', labels: ['t2'] })
go('sy-40', ['t2', 'approved'], 'bridge')
clock = T0 + 456 * MIN
ok('exit 0', (await supervise()) === 0)
ok('the state carries its version', JSON.parse(fs.readFileSync(STATE, 'utf8')).v === 5)
// as an older Supervisor left it: no version, its position at the head, and no summary of sy-40's approval
{ const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); delete s.v; delete s.items['sy-40']; fs.writeFileSync(STATE, JSON.stringify(s)) }
migration('1800000024-fw', 'open a port (sy-40)', true)
clock = T0 + 461 * MIN
ok('exit 0', (await supervise()) === 0)
ok('the bridge\'s approval from before the upgrade still counts: no finding for sy-40', !openOf(T2('sy-40')) && openKeys() === DIRTY)

step('run 9k2 (+462..464 min): only review signs off: a signed-off or signed-head:* another actor added opens signoff:<item> (sy-9bss)')
const SO = (id) => `signoff:${id}`
clock = T0 + 462 * MIN
item('sy-45', { title: 'a plan, signed off by ops', priority: 3, assignee: 'ops', labels: ['t2'] })
update('sy-45', { labels: ['t2', 'signed-off'] }, 'ops')
item('sy-46', { title: 'a plan, signed off by review', priority: 3, assignee: 'ops', labels: ['t2'] })
update('sy-46', { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'] }, 'review')
item('sy-47', { title: 'a plan, signed off by a review worker; its head by platform', priority: 3, assignee: 'ops', labels: ['t2'] })
update('sy-47', { labels: ['t2', 'signed-off'] }, 'review/w1'); update('sy-47', { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'] }, 'platform')
item('sy-48', { title: 'created with signed-off by platform', priority: 3, assignee: 'ops', labels: ['t2', 'signed-off'] }, 'platform')
ok('exit 0', (await supervise()) === 0)
ok('open: signoff for sy-45 (ops), sy-47 (its head by platform), sy-48 (created with it by platform); not sy-46 (review), not sy-47\'s signed-off (review/w1)',
  openKeys() === `${DIRTY} ${SO('sy-45')} ${SO('sy-47')} ${SO('sy-48')}`)
const SF = openOf(SO('sy-45')), SH = openOf(SO('sy-47'))
ok('...for ops, P1, labelled supervisor and audit, and it says who added it', SF?.assignee === 'ops' && SF.priority === 1 && SF.labels.includes('supervisor') && SF.labels.includes('audit') && /`signed-off`: added by ops/.test(SF.description))
ok('...sy-47 names only its signed-head (by platform), not review/w1\'s signed-off', /signed-head:mm@0a1b2c3`: added by platform/.test(SH?.description || '') && !/`signed-off`/.test(SH?.description || ''))
clock = T0 + 463 * MIN
update('sy-45', { labels: ['t2'] }, 'ops') // removed
update('sy-47', { labels: ['t2', 'signed-off'] }, 'platform'); update('sy-47', { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'] }, 'review') // re-added by review
update('sy-46', { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3', 'x'] }, 'ops') // another label by ops: review's sign-off stays review's
ok('exit 0', (await supervise()) === 0)
ok('removed (sy-45), re-added by review (sy-47): cleared; a later change by ops keeps sy-46 clean; sy-48 stays', openKeys() === `${DIRTY} ${SO('sy-48')}`)
ok('...each cleared one closed with "Cleared"', ['sy-45', 'sy-47'].every((id) => byKey(SO(id)).every((i) => i.status === 'closed' && /Cleared/.test(i.comments.at(-1).text))))
clock = T0 + 464 * MIN
update('sy-48', { status: 'closed' }, 'ops')
ok('exit 0', (await supervise()) === 0)
ok('a closed item is not watched: sy-48 cleared', openKeys() === DIRTY)

step('run 9l (+466..472 min): a route mm added or removed is a live step; a throwaway project\'s or a failed one is not (sy-n9zp)')
clock = T0 + 466 * MIN
item('sy-41', { title: 't2, a public route', priority: 2, assignee: 'platform', labels: ['t2'] }); update('sy-41', { status: 'in_progress' }, 'platform')
clock = T0 + 467 * MIN
mmLine('route add', 'tq tq 4300 open', clock, { mm_throwaway: 'tq' }) // a test's project
mmLine('route rm', 'p7 p7-old', clock, { ok: false, level: 'error' }) // failed: nothing changed
clock = T0 + 468 * MIN
ok('exit 0', (await supervise()) === 0)
ok('throwaway and failed route lines: nothing opens', openKeys() === DIRTY)
mmLine('route add', 'p7 app.p7 4310 open', T0 + 469 * MIN)
mmLine('route rm', 'p7 p7-old', T0 + 470 * MIN)
clock = T0 + 471 * MIN
ok('exit 0', (await supervise()) === 0)
const RL = openOf(T2('sy-41'))
ok('a recorded route add while sy-41 is in progress, unapproved: a P1', openKeys() === `${DIRTY} ${T2('sy-41')}` && RL?.priority === 1)
ok('it names the route and its time, the removal too', RL?.description.includes(`"mm route add p7 app.p7 4310 open" at ${iso(T0 + 469 * MIN).replace(/\.\d+Z$/, 'Z')}`) && /"mm route rm p7 p7-old" at /.test(RL.description) && !/tq/.test(RL.description))
go('sy-41', ['t2', 'approved'], 'bridge')
clock = T0 + 472 * MIN
ok('exit 0', (await supervise()) === 0)
ok('approved by the bridge: cleared', openKeys() === DIRTY)

step('run 9l2 (+473..476 min): approved counts only for the head it was given for (sy-6gz6)')
clock = T0 + 473 * MIN
// sy-50: the bridge's go for mm@0a1b2c3, then the head moved (a rebase) and review signed the new head: no go for it
item('sy-50', { title: 't2, approved, then its head moved', priority: 2, assignee: 'ops', labels: ['t2'] })
go('sy-50', ['t2', 'approved'], 'bridge')
update('sy-50', { description: GCARD('mm@9f8e7d6'), labels: [...items.get('sy-50').labels.filter((l) => !l.startsWith('signed-head:')), 'signed-head:mm@9f8e7d6'] }, 'review')
migration('1800000030-fw', 'open a port (sy-50)', true)
// sy-51: an approved from before the head was recorded (no approved-head:), by the bridge: a new tap is needed
item('sy-51', { title: 't2, approved with no approved-head', priority: 2, assignee: 'ops', labels: ['t2', 'signed-off', `signed-head:${GH}`], description: GCARD() }, 'review')
update('sy-51', { labels: ['t2', 'signed-off', `signed-head:${GH}`, 'approved'] }, 'bridge')
migration('1800000031-fw', 'open a port (sy-51)', true)
// sy-52: the bridge's approved, but a lead wrote the approved-head (to the new head): it does not count
item('sy-52', { title: 't2, approved-head by a lead', priority: 2, assignee: 'ops', labels: ['t2', 'signed-off', `signed-head:${GH}`], description: GCARD() }, 'review')
update('sy-52', { labels: ['t2', 'signed-off', `signed-head:${GH}`, 'approved'] }, 'bridge')
update('sy-52', { labels: ['t2', 'signed-off', `signed-head:${GH}`, 'approved', `approved-head:${GH}`] }, 'platform')
migration('1800000032-fw', 'open a port (sy-52)', true)
// sy-53: closed, with an old approved and no approved-head (from before heads were recorded): no finding (review #5)
item('sy-53', { title: 't2, closed, old approved', priority: 2, assignee: 'ops', labels: ['t2', 'signed-off', `signed-head:${GH}`], description: GCARD() }, 'review')
update('sy-53', { labels: ['t2', 'signed-off', `signed-head:${GH}`, 'approved'] }, 'bridge')
migration('1800000033-fw', 'open a port (sy-53)', true)
update('sy-53', { status: 'closed' }, 'ops')
ok('exit 0', (await supervise()) === 0)
ok('open: sy-50 (head moved), sy-51 (no approved-head), sy-52 (approved-head by a lead); not sy-53 (closed, old approved)', openKeys() === `${DIRTY} ${T2('sy-50')} ${T2('sy-51')} ${T2('sy-52')}`)
ok('sy-50 says for which head the go was and that a new one is needed',
  /approved for mm@0a1b2c3; the Head is now mm@9f8e7d6: a new go is needed/.test(openOf(T2('sy-50'))?.description || ''))
ok('sy-51 says its approved names no head', /approved names no head/.test(openOf(T2('sy-51'))?.description || ''))
ok('sy-52 names who wrote its approved-head', /approved-head:mm@0a1b2c3 was added by platform, who is not an approver/.test(openOf(T2('sy-52'))?.description || ''))
// the owner's new go for each head now: cleared
update('sy-50', { labels: ['t2', 'approved', 'signed-head:mm@9f8e7d6', 'approved-head:mm@9f8e7d6'] }, 'bridge')
update('sy-51', { labels: [...items.get('sy-51').labels, `approved-head:${GH}`] }, 'bridge')
update('sy-52', { labels: items.get('sy-52').labels.filter((l) => !l.startsWith('approved-head:')) }, 'ops')
update('sy-52', { labels: [...items.get('sy-52').labels, `approved-head:${GH}`] }, 'bridge')
clock = T0 + 476 * MIN
ok('exit 0', (await supervise()) === 0)
ok('a new go for the head now (the bridge\'s approved-head): all three cleared', openKeys() === DIRTY)

step('run 9m (+481..491 min): the ledger switched on (sy-1jmi): only signed lines count, each for its migration\'s subject')
if (fs.existsSync('/etc/mm-approve.conf')) console.log('  skip: this machine has /etc/mm-approve.conf (the verifiers never read a test config then)')
else {
  // the signer (box/mm-approve) in test mode: its home a throwaway folder, this test's user as its user, a stub plan command
  const AP = path.join(SRC, 'box/mm-approve'), AD = path.join(T, 'approve'), APUB = path.join(T, 'approve-pub'), ACONF = path.join(T, 'mm-approve.conf')
  fs.mkdirSync(AD, { mode: 0o755 }); fs.mkdirSync(APUB, { mode: 0o755 }); fs.chmodSync(AD, 0o755); fs.chmodSync(T, 0o755)
  // the stub plan command prints the item's blocks (sy-4py1: the signer takes the subjects only from them)
  const PLANS = path.join(T, 'plans'); fs.mkdirSync(PLANS)
  fs.writeFileSync(path.join(T, 'plan'), `#!/bin/sh\necho "the plan of $1"\ncat "${PLANS}/$1" 2>/dev/null || true\n`, { mode: 0o755 })
  fs.writeFileSync(ACONF, `verifier = ledger\nuser = ${os.userInfo().username}\ndir = ${AD}\npublic_key = ${APUB}/key.pub\nplan_command = ${path.join(T, 'plan')}\nowner_telegram_id = 4242\n`)
  const signer = (args) => execFileSync(AP, args, { env: { PATH: process.env.PATH, MM_APPROVE_CONF: ACONF }, encoding: 'utf8' })
  signer(['keygen']); fs.copyFileSync(path.join(AD, 'key.pub'), path.join(APUB, 'key.pub')); fs.chmodSync(path.join(APUB, 'key.pub'), 0o644)
  const subjectOf = (name) => signer(['subject', 'migration', path.join(MIGS, `${name}.sh`), path.join(MIGS, `${name}.rollback.sh`)]).trim()
  // approve(item, [git:<head> | a migration's name]): the plan shows each as a block, the owner taps
  const block = (s) => s.startsWith('git:') ? `=== mm-approve head ${s.slice(4)} range ${'0'.repeat(40)}..${s.slice(4)}\n`
    : signer(['block', 'migration', s, path.join(MIGS, `${s}.sh`), path.join(MIGS, `${s}.rollback.sh`)])
  const offer = (sign, id, refs) => {
    fs.writeFileSync(path.join(PLANS, id), refs.map(block).join(''))
    return JSON.parse(sign(['offer', id, ...refs.flatMap((s) => ['--subject', s.startsWith('git:') ? s : subjectOf(s)])])).offer
  }
  const approve = (id, refs) => signer(['tap', offer(signer, id, refs), '4242'])
  ENV.MM_APPROVE_CONF = ACONF
  clock = T0 + 481 * MIN
  item('sy-60', { title: 't2 in progress, approved by the bridge, no ledger line', priority: 2, assignee: 'ops', labels: ['t2'] })
  go('sy-60', ['t2', 'approved'], 'bridge'); update('sy-60', { status: 'in_progress' }, 'ops')
  item('sy-61', { title: 't2 in progress, a signed line', priority: 2, assignee: 'ops', labels: ['t2'] })
  update('sy-61', { status: 'in_progress' }, 'ops'); approve('sy-61', ['git:' + 'a'.repeat(40)])
  item('sy-62', { title: 't2, migration applied, a line for another subject', priority: 2, assignee: 'ops', labels: ['t2'] })
  migration('1800000014-fw', 'a port (sy-62)', true); approve('sy-62', ['git:' + 'b'.repeat(40)])
  item('sy-63', { title: 't2, migration applied, a line for its subject', priority: 2, assignee: 'ops', labels: ['t2'] })
  migration('1800000015-fw', 'a port (sy-63)', true); approve('sy-63', ['1800000015-fw'])
  item('sy-64', { title: 't1, approved label by the bridge, no line', priority: 2, assignee: 'ops', labels: ['t1'] })
  go('sy-64', ['t1', 'approved'], 'bridge')
  item('sy-65', { title: 't2, a line for its subject, then a second migration naming it', priority: 2, assignee: 'ops', labels: ['t2'] })
  migration('1800000016-a', 'step a (sy-65)', true); approve('sy-65', ['1800000016-a']); migration('1800000017-b', 'step b (sy-65)', true)
  // a forged line: well formed, signed by another key, for sy-60 (the ledger's owner may append; it doesn't count)
  const FD = path.join(T, 'forger'); fs.mkdirSync(FD, { mode: 0o755 }); fs.chmodSync(FD, 0o755)
  const FCONF = path.join(T, 'forger.conf'); fs.writeFileSync(FCONF, fs.readFileSync(ACONF, 'utf8').replace(AD, FD).replace(`${APUB}/key.pub`, `${FD}/key.pub`))
  const forger = (args) => execFileSync(AP, args, { env: { PATH: process.env.PATH, MM_APPROVE_CONF: FCONF }, encoding: 'utf8' })
  forger(['keygen']); forger(['tap', offer(forger, 'sy-60', ['git:' + 'c'.repeat(40)]), '4242'])
  fs.appendFileSync(path.join(AD, 'ledger.jsonl'), fs.readFileSync(path.join(FD, 'ledger.jsonl')))
  ok('exit 0', (await supervise()) === 0)
  const keys = openKeys().split(' ')
  ok('open: sy-60 (the bridge\'s label, a forged line), sy-62 (a line for another subject), sy-64 (an approved label with no line), sy-65 (its second migration unsigned)',
    ['sy-60', 'sy-62', 'sy-64', 'sy-65'].every((id) => keys.includes(T2(id))))
  ok('...not sy-61 (in progress, signed), sy-63 (its migration\'s subject signed)', !keys.includes(T2('sy-61')) && !keys.includes(T2('sy-63')))
  ok('...and the bridge-approved items of the actor era (sy-11, sy-13) open again: their labels have no line', keys.includes(T2('sy-11')) && keys.includes(T2('sy-13')))
  ok('sy-62\'s finding names the migration with no signed line, sy-65\'s only its second one',
    /no signed ledger line of sy-62 for 1800000014-fw\.sh/.test(openOf(T2('sy-62'))?.description || '') && /1800000017-b\.sh/.test(openOf(T2('sy-65'))?.description || '') && !/1800000016-a\.sh/.test(openOf(T2('sy-65'))?.description || ''))
  ok('sy-60\'s finding says its approved label does not count', /approved label \(added by bridge\) does not count/.test(openOf(T2('sy-60'))?.description || ''))
  fs.chmodSync(path.join(AD, 'ledger.jsonl'), 0o666)
  clock = T0 + 486 * MIN
  ok('exit 0', (await supervise()) === 0)
  // (sy-61 is only in progress, with nothing live: under sy-0cvx's rule that waits quietly, signed or not)
  ok('a ledger anyone can write: t2-unapproved:ledger, and sy-63 (its applied migration) opens too: nothing counts', ['ledger', 'sy-63'].every((k) => openKeys().split(' ').includes(T2(k))) && !openKeys().split(' ').includes(T2('sy-61')))
  fs.chmodSync(path.join(AD, 'ledger.jsonl'), 0o644)
  approve('sy-65', ['1800000017-b'])
  clock = T0 + 491 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('mode right again: the ledger finding, sy-61 and sy-63 clear; sy-65 clears with its second migration signed',
    !['ledger', 'sy-61', 'sy-63', 'sy-65'].some((k) => openKeys().split(' ').includes(T2(k))) && openKeys().split(' ').includes(T2('sy-60')))
  delete ENV.MM_APPROVE_CONF
}

step('run 9n (+500..510 min): two leads of one role on two passes in a row: a line in its digest (sy-p8pc)')
{
  const line = (role) => (openOf(`digest:${role}`)?.description || '').split('\n').find((l) => l.startsWith('- two leads:')) || ''
  fs.writeFileSync(path.join(AG, 'platform.json'), JSON.stringify([{ id: 'agent-platform-0001', shortId: 'agplatform', status: 'idle', cwd: SYS },
    { id: 'agent-platform-0002', shortId: 'agplatform2', status: 'idle', cwd: SYS }]))
  fs.writeFileSync(path.join(AG, 'review.json'), JSON.stringify([{ id: 'agent-review-0001', shortId: 'agreview', status: 'idle', cwd: SYS },
    { id: 'agent-review-0009', shortId: 'agrun', status: 'idle', cwd: SYS, title: 'sysqa · review lead (for sam)' }])) // a person's run
  clock = T0 + 500 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('one pass with two platform leads: no line yet (wake may archive the older one on its next pass)', !line('platform'))
  clock = T0 + 505 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('the second pass in a row: a "two leads" line in digest:platform (P1), naming both agents', /the platform role has 2 lead agents at once .*agplatform, agplatform2/.test(line('platform')) && openOf('digest:platform')?.priority === 1)
  ok("a person's run next to the review lead is not a second lead", !line('review'))
  lead('platform', 'idle'); lead('review', 'idle')
  clock = T0 + 510 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('one lead again: the line drops off', !line('platform'))
}

step('run 9o (+520..535 min): a needs-you item with no valid owner card: a finding to its role, refreshed, cleared (sy-z5lz)')
{
  const CARD = '## Owner\n- **What:** Every item that needs you shows a fixed short card at the top; the board checks it.\n- **Why:** You see what is asked and why without reading the agents\' threads.\n- **You:** Check: the card on the board\n\nThe rest.'
  item('sy-40', { title: 'asks the owner, no card', assignee: 'platform/w1', labels: ['needs-you'], description: 'Please decide.' }, 'platform')
  item('sy-41', { title: 'asks the owner, a card', assignee: 'review', labels: ['needs-you'], description: CARD }, 'review')
  item('sy-42', { title: 't2, a card without its t2 keys', assignee: 'ops', labels: ['needs-you', 't2'], description: CARD.replace('**You:** Check: the card on the board', '**You:** Tap Approve') }, 'ops') // a go ask (sy-t9tg)
  item('sy-43', { title: 'no card, no needs-you', assignee: 'ops', description: 'Text.' }, 'ops')
  item('sy-44', { title: 'needs-you on a card that asks nothing', assignee: 'review', labels: ['needs-you'], description: CARD.replace('**You:** Check: the card on the board', '**You:** Nothing') }, 'review')
  // old data (sy-e234): closed before closing removed needs-you; a closed item waits on nobody, so no finding
  item('sy-90', { title: 'closed, still labelled, no card', status: 'closed', assignee: 'ops', labels: ['needs-you'], description: 'Done.' }, 'ops')
  clock = T0 + 520 * MIN
  ok('exit 0', (await supervise()) === 0)
  const C = openOf('card:sy-40'), C2 = openOf('card:sy-42'), C4 = openOf('card:sy-44')
  ok('card:sy-44 (needs-you, You: Nothing) opened to review: it asks the owner nothing (sy-e234)', C4 && C4.assignee === 'review' && /Owner card asks nothing: sy-44/.test(C4.title) && /You is "Nothing"/.test(C4.description))
  ok('card:sy-40 opened to the item\'s role (platform), P2, with the reason', C && C.assignee === 'platform' && C.priority === 2 && /Owner card missing: sy-40/.test(C.title) && /does not start with "## Owner"/.test(C.description))
  ok('card:sy-42 (t2) opened to ops, naming the t2 keys', C2 && C2.assignee === 'ops' && /Owner card invalid/.test(C2.title) && /If yes is missing \(required with t2\)/.test(C2.description))
  ok('none for sy-41 (a valid card) or sy-43 (no needs-you)', !openOf('card:sy-41') && !openOf('card:sy-43'))
  ok('none for sy-90: closed, its needs-you (old data) is not counted (sy-e234)', !byKey('card:sy-90').length)
  clock = T0 + 525 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('nothing changed: no duplicate, no comment', byKey('card:sy-40').length === 1 && openOf('card:sy-40').comments.length === 0)
  update('sy-40', { description: `${CARD.replace('**You:** Check: the card on the board', '**You:** Look')}` }, 'platform')
  clock = T0 + 530 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('the reason changed (a card now, You invalid): one comment saying so', openOf('card:sy-40')?.comments.length === 1 && /You starts with none of/.test(openOf('card:sy-40').comments[0].text))
  update('sy-40', { description: CARD }, 'platform'); update('sy-42', { labels: ['t2'] }, 'ops'); update('sy-44', { labels: [] }, 'review')
  clock = T0 + 535 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('the card fixed, needs-you removed: both cleared and closed', !openOf('card:sy-40') && !openOf('card:sy-42') && byKey('card:sy-40')[0].status === 'closed' && /Cleared/.test(byKey('card:sy-42')[0].comments.at(-1).text))
  ok('...and sy-44\'s needs-you removed: cleared', !openOf('card:sy-44'))
}

step('run 9p (+540..555 min): the gates\' history: a flaky and a slow suite, one P1 each to platform, not duplicated (sy-sbjh.4)')
{
  const HIST = path.join(HOME, '.cache', 'mm-gates', 'history.jsonl'), DAY = 24 * 60 * MIN
  const h = (suite, group, status, secs, t) => JSON.stringify({ suite, head: 'abcdef0123456789', group, status, secs, date: iso(t) })
  const lines = (t) => [
    h('test/a.mjs', 'hermetic', 'flaky', 20, t - 3 * DAY), h('test/a.mjs', 'hermetic', 'passed', 20, t - 2 * DAY), h('test/a.mjs', 'hermetic', 'flaky', 21, t - DAY), // flaky twice in 7 days
    h('test/b.sh', 'ports', 'passed', 400, t - 3 * DAY), h('test/b.sh', 'ports', 'failed', 350, t - 2 * DAY), h('test/b.sh', 'ports', 'passed', 512.4, t - DAY), // slow 3 runs in a row
    h('test/c.sh', 'docker', 'passed', 900, t - 3 * DAY), h('test/c.sh', 'docker', 'passed', 900, t - 2 * DAY), h('test/c.sh', 'docker', 'passed', 900, t - DAY), // docker: slow by design
    h('test/d.mjs', 'hermetic', 'flaky', 5, t - 9 * DAY), h('test/d.mjs', 'hermetic', 'flaky', 5, t - DAY), // once in 7 days
    h('test/e.sh', 'hermetic', 'passed', 400, t - 3 * DAY), h('test/e.sh', 'hermetic', 'passed', 400, t - 2 * DAY), h('test/e.sh', 'hermetic', 'passed', 60, t - DAY), // fast again
    h('test/f.sh', 'hermetic', 'passed', 400, t - 2 * DAY), h('test/f.sh', 'hermetic', 'skipped', 0, t - DAY), h('test/f.sh', 'hermetic', 'passed', 400, t - DAY), // two runs only
    'not json', JSON.stringify({ suite: 'bad name`**', status: 'flaky', date: iso(t) }), JSON.stringify({ suite: 'bad name`**', status: 'flaky', date: iso(t) }),
  ]
  fs.mkdirSync(path.dirname(HIST), { recursive: true })
  clock = T0 + 540 * MIN
  fs.writeFileSync(HIST, lines(clock).join('\n') + '\n')
  ok('exit 0', (await supervise()) === 0)
  const A = openOf('suite:test/a.mjs'), B = openOf('suite:test/b.sh')
  ok('a flaky suite (twice in 7 days): "Flaky suite: test/a.mjs", P1, to platform', A && A.title === 'Flaky suite: test/a.mjs' && A.priority === 1 && A.assignee === 'platform' && /flaky 2 times in 7 days/.test(A.description))
  ok('a slow suite (its last 3 runs over 300 s, ports): "Slow suite: test/b.sh (512 s)", P1, to platform', B && B.title === 'Slow suite: test/b.sh (512 s)' && B.priority === 1 && B.assignee === 'platform' && /last 3 runs over 300 s/.test(B.description))
  ok('only those two: not docker, not once in 7 days, not fast again, not two runs, not a bad line', openKeys().split(' ').filter((k) => k.startsWith('suite:')).join(' ') === 'suite:test/a.mjs suite:test/b.sh', openKeys())
  ok('...and no supervisor:suites (the bad lines are skipped)', !openOf('supervisor:suites'))
  clock = T0 + 545 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('the next pass, the same history: not duplicated, no comment', byKey('suite:test/a.mjs').length === 1 && byKey('suite:test/b.sh').length === 1 && openOf('suite:test/a.mjs').comments.length === 0 && openOf('suite:test/b.sh').comments.length === 0)
  fs.appendFileSync(HIST, h('test/a.mjs', 'hermetic', 'flaky', 22, clock - MIN) + '\n')
  clock = T0 + 550 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('flaky once more: the same item, one comment (3 times)', byKey('suite:test/a.mjs').length === 1 && openOf('suite:test/a.mjs')?.comments.length === 1 && /flaky 3 times/.test(openOf('suite:test/a.mjs').comments[0].text))
  fs.writeFileSync(HIST, [h('test/a.mjs', 'hermetic', 'passed', 20, clock - MIN), h('test/b.sh', 'ports', 'passed', 30, clock - MIN)].join('\n') + '\n')
  clock = T0 + 555 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('the history shows neither any more (a passed, b fast): both cleared and closed', !openOf('suite:test/a.mjs') && !openOf('suite:test/b.sh') && byKey('suite:test/b.sh')[0].status === 'closed')
  fs.rmSync(HIST)
}

step('run 9q (+560..580 min): the nightly gates run (bin/nightly-gates --run, a stub test/gates): a failed night is ONE P1 to platform with its files, a passing one closes it (sy-sbjh.5)')
{
  const ND = path.join(T, 'nightly'), NR = path.join(T, 'nightly-repo'), ART = path.join(T, 'artifact.calls')
  fs.copyFileSync(path.join(SRC, 'template/profiles/system/bin/nightly-gates'), path.join(SYS, 'bin/nightly-gates'))
  fs.writeFileSync(path.join(T, 'artifact'), `#!/bin/sh\necho "$BEADS_ACTOR $*" >>"${ART}"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(T, 'nmm'), `#!/bin/sh\n[ "$1 $2 $3" = "config get gates.repo" ] && { echo "${NR}"; exit 0; }\nexit 1\n`, { mode: 0o755 })
  repo(NR)
  // the stub test/gates: a result file as test/gates writes it; the suites that fail: <T>/nightly.fail (one per line)
  fs.mkdirSync(path.join(NR, 'test'))
  fs.writeFileSync(path.join(NR, 'test/gates'), `#!/bin/sh
out=$4; logs=\${out%.txt}.logs; mkdir -p "$logs"; h=$(git rev-parse main); rc=0
{ echo "head: $h init"; echo "range: --all main"; echo "result: x"; echo
  echo "test/a.sh  hermetic  passed  1 ok, 0 FAIL  1s  $logs/a.sh.log"
  if [ -f "${T}/nightly.fail" ]; then while read -r s; do echo "boom in $s" >"$logs/$s.log"; echo "test/$s  docker  failed (exit 1, again alone)  -  9s  $logs/$s.log"; done <"${T}/nightly.fail"; fi
} >"$out"
[ -s "${T}/nightly.fail" ] && exit 1; exit 0
`, { mode: 0o755 })
  const night = () => spawnSync('node', [path.join(SYS, 'bin/nightly-gates'), '--run'], { encoding: 'utf8', cwd: SYS, env: { ...ENV, MM_BIN: path.join(T, 'nmm'), MM_GATES_NIGHTLY: ND, NIGHTLY_NOW: String(clock) } })
  Object.assign(ENV, { MM_GATES_NIGHTLY: ND, SUPERVISOR_ARTIFACT: path.join(T, 'artifact') })
  const arts = () => (fs.existsSync(ART) ? fs.readFileSync(ART, 'utf8').trim().split('\n') : [])
  const sha7 = git(NR, ['rev-parse', '--short=7', 'main']).trim()

  clock = T0 + 560 * MIN
  ok('no nightly run yet (no last.json): no finding', (await supervise()) === 0 && !openOf('nightly:gates'))
  fs.writeFileSync(path.join(T, 'nightly.fail'), 'clean-box.sh\nrestore-drill.sh\n')
  let n = night()
  ok('a failed night: the job exits 1', n.status === 1, n.stdout + n.stderr)
  clock = T0 + 565 * MIN
  ok('exit 0', (await supervise()) === 0)
  const N = openOf('nightly:gates')
  ok(`ONE item: "Nightly gates failed on main@${sha7}: clean-box.sh, restore-drill.sh", P1, to platform, act:mm-template`, byKey('nightly:gates').length === 1 && N?.title === `Nightly gates failed on main@${sha7}: clean-box.sh, restore-drill.sh` && N.priority === 1 && N.assignee === 'platform' && N.labels.includes('act:mm-template'), N)
  ok('its result file and the failed logs attached, as the watchdog (artifact <id> <result> <failed>)', arts().length === 1 && new RegExp(`^watchdog ${N?.id} ${ND}/nightly-\\S+-${sha7}\\.txt ${ND}/nightly-\\S+-${sha7}-failed\\.txt$`).test(arts()[0]), arts())
  clock = T0 + 570 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('the next pass: not duplicated, no comment, attached once', byKey('nightly:gates').length === 1 && openOf('nightly:gates').comments.length === 0 && arts().length === 1)
  // the next night: main moved, another suite fails
  write(path.join(NR, 'c.txt'), 'c\n', clock); git(NR, ['add', 'c.txt']); git(NR, ['commit', '-qm', 'more'])
  const sha7b = git(NR, ['rev-parse', '--short=7', 'main']).trim()
  fs.writeFileSync(path.join(T, 'nightly.fail'), 'auth-e2e.sh\n')
  clock = T0 + 572 * MIN; night()
  clock = T0 + 575 * MIN
  ok('exit 0', (await supervise()) === 0)
  const N2 = openOf('nightly:gates')
  ok(`another failed night: the same item, retitled (main@${sha7b}: auth-e2e.sh), one comment, its files attached`, byKey('nightly:gates').length === 1 && N2?.id === N.id && N2.title === `Nightly gates failed on main@${sha7b}: auth-e2e.sh` && N2.comments.length === 1 && /failed: test\/auth-e2e\.sh/.test(N2.comments[0].text) && arts().length === 2 && arts()[1].includes(sha7b), { title: N2?.title, arts: arts() })
  fs.rmSync(path.join(T, 'nightly.fail'))
  n = night()
  ok('a passing night: the job exits 0', n.status === 0, n.stdout + n.stderr)
  clock = T0 + 580 * MIN
  ok('exit 0', (await supervise()) === 0)
  ok('...the item is cleared and closed; no new one', !openOf('nightly:gates') && byKey('nightly:gates').length === 1 && byKey('nightly:gates')[0].status === 'closed' && /Cleared/.test(byKey('nightly:gates')[0].comments.at(-1).text))
  delete ENV.MM_GATES_NIGHTLY; delete ENV.SUPERVISOR_ARTIFACT
}

step('run 10: the board is down: exit non-zero, nothing written')
fs.writeFileSync(path.join(T, 'bd.fail'), '')
const n = sup().length
ok('exit non-zero', (await supervise()) !== 0)
ok('no items', sup().length === n)
fs.rmSync(path.join(T, 'bd.fail'))

srv.close()
if (fail) console.log(`\n--- supervisor output\n${fs.readFileSync(LOG, 'utf8')}`)
fs.rmSync(T, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
