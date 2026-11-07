#!/usr/bin/env node
// bin/wake and a lead's workers (sy-asaw, bin/lib/places.mjs): a role's places are its live workers (Paseo agents
// labelled role=<role>-worker) and its items in progress that no worker works on, each once; the project's cap counts
// the same. Proves: one worker on the one item it holds -> 1 place (the next ready item waits at capacity 1); two
// workers on it -> 2 places, and the project's cap (2) holds another role's item; a worker that finishes its turn
// (running, then idle) wakes its lead with "finished its turn"; a stray worker (its item closed) still holds a place;
// archived, it frees it and the next item is handed. The same rule, on its own (places()).
// Hermetic: temp folder and MM_HOME, a fake bd serve, a stub paseo (leads and workers from files), no obs.
//   node test/wake-workers.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-workers-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

console.log('== places(), on its own')
const { places, total, asWorker } = await import(path.join(SRC, 'template', 'bin', 'lib', 'places.mjs'))
const it = (id, assignee, status = 'in_progress') => ({ id, assignee, status })
const wk = (name, item, status = 'running', role = 'plat') => ({ id: `w-${name}`, role, name, item, status })
ok('one item, no worker: 1', places('plat', [it('p-1', 'plat')], []).used === 1)
ok('one item and its worker: 1 (counted once)', places('plat', [it('p-1', 'plat')], [wk('a', 'p-1')]).used === 1)
ok('one item, two workers on it: 2', places('plat', [it('p-1', 'plat')], [wk('a', 'p-1'), wk('b', 'p-1')]).used === 2)
ok('a worker whose item is closed: 1', places('plat', [it('p-1', 'plat', 'closed')], [wk('a', 'p-1', 'idle')]).used === 1)
ok('a claim by a worker actor (plat/x) counts for plat', places('plat', [it('p-1', 'plat/x')], []).used === 1)
ok('closed or archived workers hold nothing', places('plat', [], [wk('a', 'p-1', 'closed'), { ...wk('b', 'p-1'), archived: true }]).used === 0)
ok('another role\'s workers are not plat\'s', places('plat', [], [wk('a', 'r-1', 'running', 'rev')]).used === 0)
ok('the project total adds every role', total(['plat', 'rev'], [it('p-1', 'plat'), it('r-1', 'rev')], [wk('a', 'p-1'), wk('b', 'p-1')]) === 3)
const cliW = asWorker({ id: 'x', name: 'acme · plat worker w1 on p-1', status: 'idle', labels: { project: 'acme', role: 'plat-worker' } }, 'plat')
ok('a worker from the CLI list (no labels): name and item from its title', cliW.name === 'w1' && cliW.item === 'p-1')

// ---------- wake against a fake board ----------
const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ roles: [
  { id: 'plat', workers: true, worker: { kind: 'write', repo: '{home}/mm' }, capacity: 1 }, { id: 'rev' }] }))
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\nrestore:\n  hold: false\nwake:\n  cap: "2"\n')
const items = new Map()
const add = (id, assignee, f = {}) => items.set(id, { id, title: `title of ${id}`, status: 'open', priority: 2, assignee, labels: [], updated_at: new Date().toISOString(), ...f })
add('p-1', 'plat', { status: 'in_progress' }); add('p-2', 'plat'); add('r-1', 'rev')
const records = [], streams = []
let seq = 0
const change = (id, f) => { Object.assign(items.get(id), f, { updated_at: new Date().toISOString() }); const e = { seq: ++seq, ts: new Date().toISOString(), op: 'update', issue_id: id, actor: 'someone', issue: { ...items.get(id) } }; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [...items.values()].filter((i) => i.status === 'open').sort((a, b) => a.priority - b.priority) })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(m[1]) ? json(items.get(m[1])) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/bin/sh\necho "$*" >>"${BDLOG}"\nexit 0\n`, { mode: 0o755 })
fs.writeFileSync(path.join(PROJ, 'bin', 'lead'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
// stub paseo: both leads idle; plat's workers are workers.json (the CLI's shape: no labels, the title says it)
const SENT = path.join(T, 'sent.txt'), WJ = path.join(T, 'workers.json')
const setWorkers = (ws) => fs.writeFileSync(WJ, JSON.stringify(ws.map(([name, item, status]) => ({ id: `wid-${name}`, shortId: name, title: `wr · plat worker ${name} on ${item}`, status }))))
setWorkers([['w1', 'p-1', 'running']])
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) case "$*" in *role=plat-worker*) cat ${WJ}; exit 0 ;; *role=plat\\ *|*role=plat) echo '[{"id":"agent-plat","shortId":"plat","status":"idle"}]'; exit 0 ;;
        *role=rev\\ *|*role=rev) echo '[{"id":"agent-rev","shortId":"rev","status":"idle"}]'; exit 0 ;; esac; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })
const env = { ...process.env, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wr', MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '700', WAKE_RESUME_MS: '1000', WAKE_IDLE_CLOSE_MS: '0', WAKE_SOON_MS: '200', WAKE_RETRY_MS: '100' }
delete env.MM_SERVICE; delete env.WAKE_CAP
let out = ''
const w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const logs = () => out + read(path.join(PROJ, '.run', 'logs', 'ops.log'))
const to = (role) => read(SENT).split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')

try {
  console.log('== one worker on the one item plat holds: 1 place, at capacity 1')
  ok('p-2 waits in plat\'s queue: "plat has 1 of 1 in progress"', await until(() => /plat has 1 of 1 in progress \(the project 1 of its cap 2\): waiting in its queue p-2/.test(logs())))
  ok('...and the project has room: rev is handed r-1', await until(() => /r-1 \(P\d\) is next in your queue/.test(to('rev'))))
  ok('plat is not handed p-2', !/p-2 \(P\d\) is next in your queue/.test(to('plat')))

  console.log('== the worker finishes its turn (running, then idle): its lead is told')
  setWorkers([['w1', 'p-1', 'idle']])
  ok('plat gets "Your worker w1 on p-1 finished its turn", with how to read its report', await until(() => /Your worker w1 on p-1 finished its turn: read its report \(lead worker report plat w1\)/.test(to('plat'))))

  console.log('== two workers on that item: 2 places; the project cap (2) holds rev')
  change('r-1', { status: 'open' }) // rev's item again, as new work
  setWorkers([['w1', 'p-1', 'idle'], ['w2', 'p-1', 'running']])
  ok('"plat has 2 of 1 in progress (the project 2 of its cap 2)"', await until(() => /plat has 2 of 1 in progress \(the project 2 of its cap 2\)/.test(logs())))
  ok('...and rev\'s r-1 waits on the project cap: "rev has 0 of 1 in progress (the project 2 of its cap 2)"', await until(() => /rev has 0 of 1 in progress \(the project 2 of its cap 2\): waiting in its queue r-1/.test(logs())))

  console.log('== the item closes, a worker stays (stray): it still holds a place; archived, the next item is handed')
  change('p-1', { status: 'closed' })
  setWorkers([['w1', 'p-1', 'idle']])
  ok('"plat has 1 of 1": the stray worker holds its place', await until(() => /plat has 1 of 1 in progress \(the project 1 of its cap 2\): waiting in its queue p-2/.test(logs())))
  setWorkers([])
  ok('archived: p-2 is handed to plat', await until(() => /p-2 \(P\d\) is next in your queue/.test(to('plat'))))

  console.log('== a worker running on an item keeps its claim alive (sy-28ev); an item no worker runs on expires')
  const old = new Date(Date.now() - 120 * 60000).toISOString()
  add('p-7', 'plat', { status: 'in_progress', updated_at: old }); add('p-8', 'plat', { status: 'in_progress', updated_at: old })
  setWorkers([['w3', 'p-8', 'running']])
  ok('p-7 (no worker, no update for 2 h): requeued', await until(() => /update p-7 -s open -a plat --if-assignee plat --if-status in_progress --actor wake/.test(read(BDLOG))))
  await sleep(1500)
  ok('p-8 (its worker w3 runs on it): kept, not requeued', !/update p-8 /.test(read(BDLOG)))
  setWorkers([['w3', 'p-8', 'idle']])
  ok('...its worker idle (its turn done): p-8 expires too', await until(() => /update p-8 -s open -a plat --if-assignee plat --if-status in_progress --actor wake/.test(read(BDLOG))))
} finally {
  w.kill(); srv.close()
  if (fail && process.env.KEEP) console.log(`kept ${T}`); else fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
