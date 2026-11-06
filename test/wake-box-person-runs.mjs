#!/usr/bin/env node
// bin/wake in a box, person runs (sy-9618): a box's wake can't reach mm or the vault, so it asks the host on the box's
// own mm.api socket. The host says whether person runs are on and who the sponsor is (the box can't read the machine's
// config), and starts each run: wake sends {role, person, items, next} and never runs mm or a plain lead for a person's
// work. Item work runs as its requester, upkeep as the sponsor the host named; a refusal (no token) comes back in the
// host's words, and the item gets the plain comment; a box Paseo restart deletes the runs made before; the host off:
// the leads run as before (plain), and no run is asked for. Hermetic: temp folder and MM_HOME, a stand-in host socket,
// stub paseo (a real process stands for the box Paseo's worker), stub mm (never called), bin/bd and bd-serve, no obs.
//   node test/wake-box-person-runs.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 12000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(150) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

async function scenario(hostOn) {
  console.log(`== the host says person runs are ${hostOn ? 'on' : 'off'}`)
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-box-person-'))
  const PR = path.join(T, 'proj')
  fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PR, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(PR, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PR, 'control'), { recursive: true })
  fs.writeFileSync(path.join(PR, '.mm-answers.yaml'), 'client: acme\nname: wp\nproject: wp\nbox: true\n')
  fs.writeFileSync(path.join(PR, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'qa', capacity: 2 }, { id: 'dev' }, { id: 'ops' }] }))
  const BDLOG = path.join(T, 'bd.log')
  fs.writeFileSync(path.join(PR, 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${BDLOG}"\n`, { mode: 0o755 })
  // a plain start: bin/lead's (as a box lead starts today); recorded, and it makes a plain agent
  const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
  // the box's view of mm's home: no machine config it can read (no owner_name, no wake.person_runs)
  const AG = path.join(T, 'agents.json'); fs.writeFileSync(AG, '[]')
  const lib = `const fs = require('fs'), T = ${JSON.stringify(T)}, AG = T + '/agents.json'
const agents = () => JSON.parse(fs.readFileSync(AG, 'utf8')), save = (a) => { fs.writeFileSync(AG + '.' + process.pid, JSON.stringify(a)); fs.renameSync(AG + '.' + process.pid, AG) }
const worker = () => { const pid = fs.readFileSync(T + '/worker.pid', 'utf8').trim(); const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return pid + '.' + s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }
`
  fs.writeFileSync(path.join(PR, 'bin', 'lead'), `#!/usr/bin/env node
${lib}
const role = process.argv[3]; fs.appendFileSync(T + '/plain.log', 'PLAIN ' + role + '\\n')
const l = agents(); l.push({ id: 'plain-' + role + '-' + l.length, status: 'idle', labels: { project: 'wp', role } }); save(l)
`, { mode: 0o755 })
  const workers = []
  const newWorker = () => { const w = spawn('sleep', ['100000'], { stdio: 'ignore' }); workers.push(w); fs.writeFileSync(path.join(T, 'worker.pid'), String(w.pid)); return w.pid }
  newWorker()
  fs.writeFileSync(path.join(T, 'paseo'), `#!/usr/bin/env node
${lib}
const [cmd, ...a] = process.argv.slice(2)
if (cmd === 'ls') {
  const want = {}; for (let i = 0; i < a.length; i++) if (a[i] === '--label') { const [k, v] = a[++i].split('='); want[k] = v }
  const list = agents().filter((x) => !x.archived && Object.entries(want).every(([k, v]) => x.labels[k] === v))
  if (a.includes('-q')) { console.log(list.map((x) => x.id).join('\\n')); process.exit(0) }
  console.log(JSON.stringify(list.map((x) => ({ id: x.id, shortId: x.id, status: x.status, labels: x.labels }))))
} else if (cmd === 'daemon') console.log(JSON.stringify({ workerPid: Number(fs.readFileSync(T + '/worker.pid', 'utf8')) }))
else if (cmd === 'archive') { const id = a.filter((x) => x !== '--force')[0], l = agents(); for (const x of l) if (x.id === id) x.archived = true; save(l) }
else if (cmd === 'delete') { const id = a[0]; save(agents().filter((x) => x.id !== id)); fs.appendFileSync(T + '/deleted.log', id + '\\n') }
else if (cmd === 'send') { fs.appendFileSync(T + '/sent.log', 'TO ' + a[0] + '\\n' + a[a.indexOf('--prompt') + 1] + '\\n----\\n') }
`, { mode: 0o755 })
  // mm: never run in a box (it can't reach it)
  fs.writeFileSync(path.join(T, 'mm-stub'), `#!/bin/sh\necho "$*" >>"${T}/mm.log"\nexit 1\n`, { mode: 0o755 })
  // the host's side of the box's socket (src/boxruns.ts), standing in: on/off and the sponsor; a run made as the
  // host makes it (labelled with the box Paseo's worker); carol has no token
  const asks = []
  const workerOf = () => { const pid = read(path.join(T, 'worker.pid')).trim(); const s = read(`/proc/${pid}/stat`); return `${pid}.${s.slice(s.lastIndexOf(')') + 2).split(' ')[19]}` }
  const SOCK = path.join(T, 'api.sock')
  const host = http.createServer((req, res) => {
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.url !== '/person-run') return json(404, { status: 'refused', why: 'unknown-call' })
    if (req.method === 'GET') return json(200, hostOn ? { status: 'on', sponsor: 'boss' } : { status: 'off' })
    let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => {
      const b = JSON.parse(s); asks.push(b)
      if (!hostOn) return json(403, { status: 'refused', why: 'off', message: 'person runs are off on this machine' })
      if (b.person === 'carol') return json(403, { status: 'refused', why: 'no-token', message: 'carol has no Claude token, so the run does not start: set your Claude token on the home page (https://auth.example.org/s/token). mm never uses the owner\'s token for another person.' })
      const l = JSON.parse(read(AG)); for (const x of l) if (x.labels.role === b.role) x.archived = true
      const id = `run-${b.person}-${b.role}-${l.length}`
      l.push({ id, status: 'idle', labels: { project: 'wp', role: b.role, person: b.person, 'paseo-worker': workerOf() } }); fs.writeFileSync(`${AG}.h`, JSON.stringify(l)); fs.renameSync(`${AG}.h`, AG)
      json(200, { status: 'done', agent: id })
    })
  })
  await new Promise((r) => host.listen(SOCK, r))

  const items = [
    { id: 'q-1', assignee: 'qa', status: 'open', priority: 1, title: "alice's report", labels: [] },
    { id: 'd-1', assignee: 'dev', status: 'open', priority: 2, title: 'a check nobody asked for', labels: [] },
    { id: 'o-1', assignee: 'ops', status: 'open', priority: 2, title: "carol's ask", labels: [] },
  ]
  let seq = 0
  const ev = (op, id, actor, extra = {}) => ({ seq: ++seq, op, issue_id: id, actor, ts: new Date().toISOString(), issue: items.find((i) => i.id === id), ...extra })
  const records = [ev('create', 'q-1', 'alice'), ev('create', 'd-1', 'watchdog'), ev('create', 'o-1', 'carol')]
  const streams = []
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return }
    if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since) }) }
    if (u.pathname === '/v0/beads/ready') return json({ items: items.filter((i) => i.status === 'open').sort((x, y) => x.priority - y.priority) })
    if (u.pathname === '/v0/beads/issues') return json({ items })
    if (u.pathname.startsWith('/v0/beads/issues/')) return json({ ...items.find((i) => i.id === decodeURIComponent(u.pathname.split('/').pop())), comments: [] })
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wp',
    WAKE_MM: path.join(T, 'mm-stub'), WAKE_DISPATCH_SOCK: SOCK, PASEO_WORKER_TTL_MS: '200',
    MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_LOG_STDERR: '1', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500',
    WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '1500', WAKE_IDLE_CLOSE_MS: '0' }
  delete env.MM_SERVICE; delete env.WAKE_PERSON_RUNS
  const w = spawn('node', [path.join(PR, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
  const plain = () => read(path.join(T, 'plain.log')), live = () => JSON.parse(read(AG)).filter((x) => !x.archived), bdlog = () => read(BDLOG)
  const deleted = () => read(path.join(T, 'deleted.log')), sent = () => read(path.join(T, 'sent.log'))
  try {
    if (!hostOn) {
      ok('the host says off: the leads start as before (bin/lead start), for every role with work', await until(() => ['qa', 'dev', 'ops'].every((r) => plain().includes(`PLAIN ${r}`))))
      ok('...no run is asked for, and mm is never run', asks.length === 0 && !read(path.join(T, 'mm.log')))
      ok('...wake says what the host said', /person runs in this box: off on the host/.test(out))
      return
    }
    ok('item work runs as its requester: the qa lead is asked of the host for alice, with her queue head', await until(() => asks.some((a) => a.role === 'qa' && a.person === 'alice'))
      && (() => { const a = asks.find((x) => x.person === 'alice'); return Array.isArray(a.items) && a.next.length === 1 && a.next[0].id === 'q-1' && a.next[0].priority === 1 && a.next[0].title === "alice's report" })())
    ok("upkeep runs as the sponsor the host named (boss; the box has no owner_name of its own)", await until(() => asks.some((a) => a.role === 'dev' && a.person === 'boss' && a.next.some((n) => n.id === 'd-1'))))
    ok('...never through mm (the box has none) or a plain bin/lead start', !read(path.join(T, 'mm.log')) && !plain())
    const e1 = ev('comment', 'q-1', 'alice', { comment: { id: 'c1', author: 'alice', text: 'any news?' } }); records.push(e1); for (const s of streams) s.write(`data: ${JSON.stringify(e1)}\n\n`)
    ok("...the run is the one the host made: alice's comment goes to it", await until(() => sent().split('----').some((m) => m.includes('TO run-alice-qa') && m.includes('any news?'))))
    ok('a person with no token (carol): asked, refused, no run of hers', await until(() => asks.some((a) => a.role === 'ops' && a.person === 'carol')) && !live().some((x) => x.labels.person === 'carol'))
    ok("...her item says why, in the host's words, with where to set the token", await until(() => /comments add o-1 No run yet: this item's work runs as carol \(who asked for it\).*carol has no Claude token set.*https:\/\/auth\.example\.org\/s\/token/.test(bdlog())))
    ok("...and no one else's run (nor a plain lead) took her work", !asks.some((a) => a.person !== 'carol' && a.next.some((n) => n.id === 'o-1')) && !plain().includes('PLAIN ops'))
    ok('wake said person runs are on, from the host', /person runs in this box: on: the host starts them \(the sponsor: boss\)/.test(out))
    // the box's Paseo restarts: a new worker; the runs made before are deleted
    const before = live().filter((x) => x.labels.person).map((x) => x.id)
    newWorker()
    ok(`a box Paseo restart: the person runs made before are deleted (${before.join(', ')})`, before.length > 0 && await until(() => before.every((id) => deleted().includes(id))))
    // the host's socket stops answering: wake keeps what it said last (on): no plain lead for a person's work
    await new Promise((r) => host.close(r)); fs.rmSync(SOCK, { force: true }); fs.writeFileSync(SOCK, '')
    const n = asks.length
    items.push({ id: 'q-2', assignee: 'qa', status: 'open', priority: 1, title: 'another', labels: [] })
    const e = ev('create', 'q-2', 'alice'); records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`)
    await sleep(3000)
    ok("the host's socket gone quiet: no plain lead starts for a person's work (what the host said last holds)", !plain() && asks.length === n && /person runs in this box: the host's socket did not answer \(kept: on\)/.test(out))
  } finally {
    w.kill(); srv.close(); try { host.close() } catch {} for (const x of workers) x.kill()
    if (fail) console.log(out.split('\n').slice(-25).join('\n'))
    fs.rmSync(T, { recursive: true, force: true })
  }
}
await scenario(true)
await scenario(false)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
