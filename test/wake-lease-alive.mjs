#!/usr/bin/env node
// bin/wake's lease and the work alive for an item (sy-brny): a claim with no update past WAKE_LEASE_MS is requeued,
// unless work for that item is alive: a worker running on it (any role's), or a gate run for it (test/gates --item
// <id> marks .run/gates/<id>.<pid>.pid while it runs). Proves: a stale claim with a running worker -> kept; with a live
// gate run -> kept; with a dead pid -> requeued as before (and its file removed); a pid used again by another program
// (another start) -> requeued; when the worker or the gate run ends, the lease counts from then (kept a while, then
// requeued). sy-mv69.1, a claim that waits is alive: an idle worker on it (live until its lead stops it, as `lead
// worker ls` lists it) -> kept; a new commit on its branch (w-<id>, or the live worker's name) -> kept, as of the
// commit; an old commit -> requeued; no comment is written for a renewal.
// Hermetic: temp folder and MM_HOME, a fake bd serve, a stub bd (logs), a stub paseo (leads idle, workers from a file),
// `sleep` processes as gate runs, no obs.
//   node test/wake-lease-alive.mjs            exit 0 = every check passed
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-lease-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ roles: [
  { id: 'plat', workers: true, worker: { kind: 'write', repo: '{home}/mm' }, capacity: 9 }, { id: 'rev', capacity: 9 }] }))
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\nrestore:\n  hold: false\n')
const old = new Date(Date.now() - 120 * 60000).toISOString()
const items = new Map()
const add = (id, assignee) => items.set(id, { id, title: `title of ${id}`, status: 'in_progress', priority: 2, assignee, labels: [], updated_at: old })
for (const id of ['p-w', 'p-n', 'p-i', 'p-c', 'p-o', 'p-k']) add(id, 'plat')
for (const id of ['r-g', 'r-d', 'r-x']) add(id, 'rev')
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(m[1]) ? json(items.get(m[1])) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`
// stub bin/bd: logs; the board does not change, so an expired claim is requeued on every pass (one line each)
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/bin/sh\necho "$*" >>"${BDLOG}"\nexit 0\n`, { mode: 0o755 })
fs.writeFileSync(path.join(PROJ, 'bin', 'lead'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
// stub paseo: both leads idle (a lead in a turn holds every claim of its role); plat's workers are workers.json
const WJ = path.join(T, 'workers.json')
const setWorkers = (ws) => fs.writeFileSync(WJ, JSON.stringify(ws.map(([name, item, status]) => ({ id: `wid-${name}`, shortId: name, title: `wl · plat worker ${name} on ${item}`, status }))))
setWorkers([['w1', 'p-w', 'running'], ['w2', 'p-i', 'idle']])
// the board's repo (code/): p-c's branch w-p-c gets commits while the checks run, p-o's an old one (3 h), p-k's worker's branch k1 a
// commit from now (its worker is gone: the branch alone renews it)
const CODE = path.join(PROJ, 'code'); fs.mkdirSync(CODE)
const git = (args, when = new Date()) => spawnSync('git', ['-C', CODE, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org', GIT_AUTHOR_DATE: when.toISOString(), GIT_COMMITTER_DATE: when.toISOString() } })
const commitOn = (branch, when) => { git(['checkout', '-q', '-B', branch, 'main']); fs.writeFileSync(path.join(CODE, 'f'), `${branch} ${when.getTime()}\n`); git(['add', '-A']); git(['commit', '-qm', branch], when); git(['checkout', '-q', 'main']) }
git(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(CODE, 'f'), '0\n'); git(['add', '-A']); git(['commit', '-qm', 'base'], new Date(Date.now() - 300 * 60000))
commitOn('w-p-c', new Date()); commitOn('w-p-o', new Date(Date.now() - 180 * 60000))
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) case "$*" in *role=plat-worker*) cat ${WJ}; exit 0 ;; *role=plat\\ *|*role=plat) echo '[{"id":"agent-plat","shortId":"plat","status":"idle"}]'; exit 0 ;;
        *role=rev\\ *|*role=rev) echo '[{"id":"agent-rev","shortId":"rev","status":"idle"}]'; exit 0 ;; esac; echo '[]' ;;
esac
exit 0
`, { mode: 0o755 })

// gate runs: a live one for r-g (its real start), a dead pid for r-d, a live pid with another start for r-x (reused)
const GD = path.join(PROJ, '.run', 'gates'); fs.mkdirSync(GD, { recursive: true })
const procStart = (pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19] || '' } catch { return '' } }
const mark = (item, pid, start) => { const f = path.join(GD, `${item}.${pid}.pid`); fs.writeFileSync(f, JSON.stringify({ pid, item, start }) + '\n'); return f }
const gate = spawn('sleep', ['120'], { stdio: 'ignore' })
await sleep(100)
const fG = mark('r-g', gate.pid, procStart(gate.pid))
const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim() // a pid that has exited
const fD = mark('r-d', Number(dead), '1')
const fX = fs.existsSync('/proc/self/stat') ? mark('r-x', process.pid, 'not-its-start') : null

const LEASE = 4000
const env = { ...process.env, HOME: T, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wl', MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_LEASE_MS: String(LEASE), WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '1000', WAKE_IDLE_CLOSE_MS: '0', WAKE_SOON_MS: '200', WAKE_RETRY_MS: '100' }
delete env.MM_SERVICE; delete env.WAKE_CAP
let out = ''
const w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const requeued = (id) => new RegExp(`update ${id.replace('.', '\\.')} -s open -a \\w+ --if-assignee \\w+ --if-status in_progress --actor wake`).test(read(BDLOG))

// p-c's branch gets a new commit every 700 ms while the first checks run (stopped before the k1 ones)
const pc = setInterval(() => commitOn('w-p-c', new Date()), 700)
try {
  console.log('== stale claims (no update for 2 h, lease 4 s)')
  ok('p-n (nothing alive for it): requeued as before', await until(() => requeued('p-n')))
  ok('r-d (its gate run\'s pid is dead): requeued as before', await until(() => requeued('r-d')))
  ok('...and its mark is removed', await until(() => !fs.existsSync(fD)))
  if (fX) ok('r-x (its pid lives, but another program started there): requeued, mark removed', await until(() => requeued('r-x') && !fs.existsSync(fX)))
  await sleep(2500)
  ok('p-w (a worker runs on it): kept', !requeued('p-w'))
  ok('r-g (a live gate run for it, test/gates --item r-g): kept, its mark left', !requeued('r-g') && fs.existsSync(fG))
  ok('p-i (an idle worker on it: live, as lead worker ls lists it): kept', !requeued('p-i'))
  ok('p-c (new commits on its branch w-p-c): kept', !requeued('p-c'))
  ok('...and wake says why in its log', /p-c: a new commit on its branch/.test(out + read(path.join(PROJ, '.run', 'logs', 'ops.log'))))
  ok('p-o (its branch\'s last commit is 3 h old): requeued as before', await until(() => requeued('p-o')))
  ok('no renewal writes a comment (only the requeues do)', !/comments add (p-w|p-i|p-c|r-g) /.test(read(BDLOG)))

  clearInterval(pc)
  console.log('== commits on the branch of a worker that has stopped (its name, k1)')
  ok('p-k (nothing alive, no branch yet): requeued', await until(() => requeued('p-k')))
  setWorkers([['w1', 'p-w', 'running'], ['w2', 'p-i', 'idle'], ['k1', 'p-k', 'idle']])
  await sleep(1200)
  setWorkers([['w1', 'p-w', 'running'], ['w2', 'p-i', 'idle']]) // k1 stops; its lead goes on on its branch
  const t0 = Date.now()
  while (Date.now() - t0 < LEASE + 3000) { commitOn('k1', new Date()); await sleep(700) }
  fs.writeFileSync(BDLOG, read(BDLOG).replace(/^update p-k .*\n/gm, ''))
  for (let k = 0; k < 4; k++) { commitOn('k1', new Date()); await sleep(700) }
  ok('...while commits come on k1, past a whole lease after the worker stopped: kept', !requeued('p-k'))
  ok('...the commits stop: requeued a lease later', await until(() => requeued('p-k'), LEASE + 6000))
  console.log('== the work ends (the worker stopped, the gate run gone): the lease counts from then')
  setWorkers([['w2', 'p-i', 'idle']]); gate.kill('SIGKILL')
  const ended = Date.now()
  await sleep(1500)
  ok('right after: p-w and r-g still kept (their lease renewed until the work ended)', !requeued('p-w') && !requeued('r-g'))
  ok('r-g\'s mark (dead pid now) is removed', await until(() => !fs.existsSync(fG)))
  ok('after the lease from the end: p-w requeued', await until(() => requeued('p-w'), 10000) && Date.now() - ended >= LEASE - 1000)
  ok('...and r-g requeued', await until(() => requeued('r-g'), 10000))
} finally {
  clearInterval(pc); w.kill(); srv.close(); try { gate.kill('SIGKILL') } catch {}
  if (fail) console.log(`--- wake output\n${out.slice(-2000)}\n${read(path.join(PROJ, '.run', 'logs', 'ops.log')).slice(-2000)}\n--- bd\n${read(BDLOG).slice(-1500)}`)
  if (fail && process.env.KEEP) console.log(`kept ${T}`); else fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
