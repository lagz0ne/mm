#!/usr/bin/env node
// bin/supervisor (profile system) against a fake bd-serve, a stub paseo, a stub mm and throwaway git repos, step by step
// on a fake clock (SUPERVISOR_NOW): each finding opens (stall, handoff, idle, dirty), a change becomes a comment, nothing
// is opened twice, each clears and closes; a comment, a commit or an agent turn each keeps an item from stalling; a
// failing source, a lost state file and an item closed by someone. Hermetic: temp folder only; nothing live is touched.
//   node test/supervisor.mjs            exit 0 = every check passed
import { execFileSync, spawn } from 'node:child_process'
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
fs.writeFileSync(path.join(T, 'ls.json'), JSON.stringify([{ project: 'p1', root: P1 }, { project: 'p2', root: P2, throwaway: true }, { project: 'sysqa', root: SYS }]))
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
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (fs.existsSync(path.join(T, 'bd.fail'))) return json({ error: 'down' }, 503)
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') {
    const label = u.searchParams.get('label')
    return json({ items: [...items.values()].filter((i) => !label || i.labels.includes(label)).map(snap), has_more: false })
  }
  if (req.method === 'GET' && u.pathname === '/v0/beads/ready') return json({ items: [...items.values()].filter((i) => i.status === 'open').map(snap) })
  if (req.method === 'GET' && u.pathname === '/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0), limit = Number(u.searchParams.get('limit') || 500)
    return json({ head: seq, records: events.filter((e) => e.seq > since).slice(0, limit) })
  }
  if (req.method === 'POST' && u.pathname === '/v0/beads/issues') return json({ id: item(`sy-s${nextId++}`, { ...b, labels: b.labels }, b.actor).id })
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname))) { comment(m[1], b.author, b.text); return json({}) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+):close$/.exec(u.pathname))) { update(m[1], { status: 'closed', close_reason: b.reason }, b.actor); return json({}) }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`

const STATE = path.join(SYS, '.supervisor.json'), LOG = path.join(T, 'run.log')
const ENV = { PATH: process.env.PATH, HOME, MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_BIN: path.join(T, 'mm'), MM_BRAIN: path.join(T, 'brain'),
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
item('sy-4', { title: 'handed over', status: 'in_progress', priority: 2, assignee: 'platform' }); comment('sy-4', 'platform', 'Built it.\nHANDOFF review 1a2b3c4\nThanks.')
item('sy-5', { title: 'ready P0 for review', priority: 0, assignee: 'review' })
item('sy-7', { title: 'waits for the owner', priority: 2, assignee: 'platform' }); comment('sy-7', 'platform', 'HANDOFF owner approve the plan')
item('sy-8', { title: 'P2 in progress, quiet', status: 'in_progress', priority: 2, assignee: 'platform' })

step('run 1 (+0 min): only the old uncommitted worktree')
ok('exit 0', (await supervise()) === 0)
ok(`open: ${DIRTY} (not p1: touched now; not p2: throwaway; not the board's own repo)`, openKeys() === DIRTY)
const D = openOf(DIRTY)
ok('item for ops, label supervisor, task, P2, by watchdog', D && D.assignee === 'ops' && D.labels.join() === 'supervisor' && D.priority === 2 && events.find((e) => e.issue_id === D.id).actor === 'watchdog')
ok('it names the file', D && D.description.includes('src.ts') && D.description.includes('feat'))

step('run 2 (+12 min): handoff and idle')
clock = T0 + 12 * MIN
git(P1, ['add', 'fresh']); git(P1, ['commit', '-qm', 'fresh']) // p1's work got committed
ok('exit 0', (await supervise()) === 0)
ok('open: dirty, handoff:sy-4, idle:review (HANDOFF owner and P2 in progress are not watched)', openKeys() === `${DIRTY} handoff:sy-4 idle:review`)
ok('handoff item names the role', openOf('handoff:sy-4')?.title.includes('review'))
ok('idle item names the P0 item and the lead state', /sy-5/.test(openOf('idle:review')?.description) && /idle/.test(openOf('idle:review')?.description))

step('run 3 (+17 min): nothing changed: no duplicate, no comment')
clock = T0 + 17 * MIN
ok('exit 0', (await supervise()) === 0)
ok('no duplicates', openKeys() === `${DIRTY} handoff:sy-4 idle:review` && sup().length === 3)
ok('no comments on unchanged findings', sup().every((i) => i.comments.length === 0))

step('run 4 (+20 min): a finding changes -> one comment')
clock = T0 + 20 * MIN
item('sy-6', { title: 'another ready P0 for review', priority: 0, assignee: 'review' }, 'alex')
ok('exit 0', (await supervise()) === 0)
const I = openOf('idle:review')
ok('the idle item got one "Changed" comment naming sy-6', I.comments.length === 1 && /Changed/.test(I.comments[0].text) && I.comments[0].text.includes('sy-6'))
ok('still one item per key', byKey('idle:review').length === 1 && sup().length === 3)

step('run 5 (+35 min): stall; a commit and an agent turn each prevent one')
clock = T0 + 30 * MIN
write(path.join(MMR, 'b.txt'), 'b\n', clock); git(MMR, ['add', 'b.txt']); git(MMR, ['commit', '-qm', 'more of it', '-m', 'sy-2'])
comment('sy-8', 'watchdog', 'a system note does not count') // and a P2 never stalls anyway
comment('sy-1', 'wake', 'Paused: a system author is not activity')
clock = T0 + 35 * MIN
ok('exit 0', (await supervise()) === 0)
ok('stall:sy-1 opened; not sy-2 (commit 5 min ago), not sy-3 (ops lead running)', openKeys() === `${DIRTY} handoff:sy-4 idle:review stall:sy-1`)
ok('stall item is P1 and says when it last moved', openOf('stall:sy-1')?.priority === 1 && openOf('stall:sy-1').description.includes(iso(T0).replace(/\.\d+Z$/, 'Z')))

step('run 6 (+40 min): every finding clears -> closed with a comment')
clock = T0 + 36 * MIN
comment('sy-4', 'review/w1', 'Looking at 1a2b3c4.') // a worker of review answers the handoff
comment('sy-1', 'alex', 'Any news?') // a human comment is activity
lead('review', 'running')
git(WT, ['add', 'src.ts']); git(WT, ['commit', '-qm', 'done'])
clock = T0 + 40 * MIN
const before = sup().map((i) => i.id)
ok('exit 0', (await supervise()) === 0)
ok('no supervisor item open', openKeys() === '')
ok('each closed one got a "Cleared" comment', before.every((id) => items.get(id).status === 'closed' && /Cleared/.test(items.get(id).comments.at(-1).text)))

update('sy-1', { status: 'closed' }, 'platform'); update('sy-2', { status: 'closed' }, 'platform')

step('run 7 (+46 min): a source fails (paseo): its checks say so, the others go on')
clock = T0 + 46 * MIN
fs.writeFileSync(path.join(T, 'paseo.fail'), '')
write(path.join(WT, 'again.ts'), 'x\n', clock - 31 * MIN)
ok('exit 0 (the failure is on the board)', (await supervise()) === 0)
ok('supervisor:stall and supervisor:idle opened; dirty still found', openKeys() === `${DIRTY} supervisor:idle supervisor:stall`)
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
ok('old handoffs from the journal are read again, and stay answered', !openKeys().includes('handoff'))

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
