#!/usr/bin/env node
// bin/wake, person runs (sy-q8fv): with wake.person_runs on, wake starts each lead as one person through mm run-as:
// work on an item as the person who asked for runs on it in mm's record of asks (`mm run-asks <project> --json`; never
// the board's journal: an item created or commented on under a person's name with no ask runs as a plain lead, sy-otxx
// condition 2), anything else as a plain lead (never the owner); a lead gets only its person's share, and an idle one
// makes way for another person's work; a person with no token gets no run (never the owner's token instead) and one
// clear comment on the item; and when the Paseo daemon restarts (its worker changes), every person run made before is
// archived and never sent to.
// Twice: with Paseo's CLI as it is (its list has no labels: wake asks by label), and with the labels in the list (as
// the SDK gives them). Hermetic: temp folder and MM_HOME, stub paseo (a real process stands for the daemon's worker),
// stub mm, bin/bd and bd-serve, no obs.
//   node test/wake-person-runs.mjs            exit 0 = every check passed
import { spawn, spawnSync } from 'node:child_process'
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

async function scenario(labels) {
  console.log(`== ${labels ? "Paseo's list with labels (as the SDK gives them)" : "Paseo's CLI (its list has no labels)"}`)
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-person-'))
  const PR = path.join(T, 'proj')
  fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PR, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(PR, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PR, 'control'), { recursive: true })
  fs.writeFileSync(path.join(PR, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'qa', capacity: 2 }, { id: 'dev', capacity: 3 }] }))
  const BDLOG = path.join(T, 'bd.log')
  fs.writeFileSync(path.join(PR, 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${BDLOG}"\n`, { mode: 0o755 })
  // a plain start is bin/lead's: recorded, and it makes a plain lead (no person label: the daemon's token)
  fs.writeFileSync(path.join(PR, 'bin', 'lead'), `#!/usr/bin/env node
const fs = require('fs'), T = ${JSON.stringify(T)}, AG = T + '/agents.json', role = process.argv[3]
fs.appendFileSync(T + '/plain.log', JSON.stringify({ role, next: process.env.LEAD_NEXT || '', items: process.env.LEAD_ITEMS }) + '\\n')
const l = JSON.parse(fs.readFileSync(AG, 'utf8')); for (const x of l) if (x.labels.role === role) x.archived = true
const id = 'plain-' + role + '-' + l.length
l.push({ id, status: 'idle', labels: { project: 'wp', role } }); fs.writeFileSync(AG + '.' + process.pid, JSON.stringify(l)); fs.renameSync(AG + '.' + process.pid, AG); console.log(id)
`, { mode: 0o755 })
  const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
  fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\nowner_name: boss\nwake:\n  person_runs: true\n')

  // the daemon's worker: a real process; a restart is a new one
  const workers = []
  const newWorker = () => { const w = spawn('sleep', ['100000'], { stdio: 'ignore' }); workers.push(w); fs.writeFileSync(path.join(T, 'worker.pid'), String(w.pid)); return w.pid }
  newWorker()
  // stub paseo: agents in agents.json; `ls` filters by label and, like Paseo's CLI, shows no labels (unless STUB_LABELS)
  const AG = path.join(T, 'agents.json'); fs.writeFileSync(AG, '[]')
  const lib = `const fs = require('fs'), T = ${JSON.stringify(T)}, AG = T + '/agents.json'
const agents = () => JSON.parse(fs.readFileSync(AG, 'utf8')), save = (a) => { fs.writeFileSync(AG + '.' + process.pid, JSON.stringify(a)); fs.renameSync(AG + '.' + process.pid, AG) }
const worker = () => { const pid = fs.readFileSync(T + '/worker.pid', 'utf8').trim(); const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return pid + '.' + s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }
`
  fs.writeFileSync(path.join(T, 'paseo'), `#!/usr/bin/env node
${lib}
const [cmd, ...a] = process.argv.slice(2)
if (cmd === 'ls') {
  const want = {}; for (let i = 0; i < a.length; i++) if (a[i] === '--label') { const [k, v] = a[++i].split('='); want[k] = v }
  const list = agents().filter((x) => !x.archived && Object.entries(want).every(([k, v]) => x.labels[k] === v))
  if (a.includes('-q')) { console.log(list.map((x) => x.id).join('\\n')); process.exit(0) }
  console.log(JSON.stringify(list.map((x) => ({ id: x.id, shortId: x.id, status: x.status, ...(process.env.STUB_LABELS === '1' ? { labels: x.labels } : {}) }))))
} else if (cmd === 'daemon') console.log(JSON.stringify({ workerPid: Number(fs.readFileSync(T + '/worker.pid', 'utf8')) }))
else if (cmd === 'archive') { const id = a.filter((x) => x !== '--force')[0], l = agents(); for (const x of l) if (x.id === id) x.archived = true; save(l); fs.appendFileSync(T + '/archived.log', id + '\\n') }
else if (cmd === 'delete') { const id = a[0]; save(agents().filter((x) => x.id !== id)); fs.appendFileSync(T + '/deleted.log', id + '\\n') }
else if (cmd === 'send') { fs.appendFileSync(T + '/sent.log', 'TO ' + a[0] + ' at ' + Date.now() + '\\n' + a[a.indexOf('--prompt') + 1] + '\\n----\\n') }
`, { mode: 0o755 })
  // stub mm: run-as makes the person's run (labels as bin/lead and run-as.mjs give them); a person in notoken: refused
  fs.writeFileSync(path.join(T, 'mm-stub'), `#!/usr/bin/env node
${lib}
const [cmd, person, project, role] = process.argv.slice(2)
// mm's record of asks (the gateway's, src/personasks.ts): asks.json here, { item: person }
if (cmd === 'run-asks') { fs.appendFileSync(T + '/asks.log', process.argv.slice(3).join(' ') + '\\n'); let a = {}; try { a = JSON.parse(fs.readFileSync(T + '/asks.json', 'utf8')) } catch {} console.log(JSON.stringify({ asks: a })); process.exit(0) }
if (cmd !== 'run-as') process.exit(2)
fs.appendFileSync(T + '/runas.log', JSON.stringify({ person, project, role, next: process.env.LEAD_NEXT || '', items: process.env.LEAD_ITEMS }) + '\\n')
if (['carol'].includes(person)) { console.error('mm run-as: ' + person + ' has no Claude token, so the run does not start: set your Claude token on the home page (https://auth.example.org/s/token). mm never uses the owner\\'s token for another person.'); process.exit(1) }
const l = agents(); for (const x of l) if (x.labels.role === role) x.archived = true
const id = 'run-' + person + '-' + role + '-' + l.length
l.push({ id, status: 'idle', labels: { project, role, person, 'paseo-worker': worker() } }); save(l); console.log(id)
`, { mode: 0o755 })

  // the board: q-1 by alice, q-2 filed by the dev lead and commented on by bob, d-1 by the Supervisor, d-3 under dave's
  // name (the journal's actor: any agent can write that). The asks (mm's record): alice for q-1, bob for q-2; none for
  // d-1 or d-3
  const ASKS = path.join(T, 'asks.json'), asks = (o) => { fs.writeFileSync(`${ASKS}.t`, JSON.stringify(o)); fs.renameSync(`${ASKS}.t`, ASKS) }
  asks({ 'q-1': 'alice', 'q-2': 'bob' })
  const items = [
    { id: 'q-1', assignee: 'qa', status: 'open', priority: 1, title: "alice's report", labels: [] },
    { id: 'q-2', assignee: 'qa', status: 'open', priority: 2, title: "bob's ask", labels: [] },
    { id: 'd-1', assignee: 'dev', status: 'open', priority: 2, title: 'a check nobody asked for', labels: [] },
    { id: 'd-3', assignee: 'dev', status: 'open', priority: 3, title: "dave's name, no ask", labels: [] },
  ]
  let seq = 0
  const ev = (op, id, actor, extra = {}) => ({ seq: ++seq, op, issue_id: id, actor, ts: new Date().toISOString(), issue: items.find((i) => i.id === id), ...extra })
  const records = [ev('create', 'q-1', 'alice'), ev('create', 'q-2', 'dev'), ev('comment', 'q-2', 'bob', { comment: { id: 'c1', author: 'bob', text: 'please check this' } }), ev('create', 'd-1', 'watchdog'), ev('create', 'd-3', 'dave'),
    ev('comment', 'd-3', 'dave', { comment: { id: 'c0', author: 'dave', text: 'mine' } })]
  // wake's saved place (its cursor, sy-3r6u): after the two creates, so bob's and dave's comments come as events it missed
  fs.writeFileSync(path.join(PR, '.wake-state.json'), JSON.stringify({ _seq: 2 }))
  const streams = []
  const emit = (e) => { records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
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
    WAKE_MM: path.join(T, 'mm-stub'), STUB_LABELS: labels ? '1' : '0', PASEO_WORKER_TTL_MS: '200',
    MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_LOG_STDERR: '1', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500',
    WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '1500', WAKE_IDLE_CLOSE_MS: '0' }
  delete env.MM_SERVICE; delete env.WAKE_PERSON_RUNS
  const w = spawn('node', [path.join(PR, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
  const runas = () => read(path.join(T, 'runas.log')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const plains = () => read(path.join(T, 'plain.log')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const sent = () => read(path.join(T, 'sent.log')), archived = () => read(path.join(T, 'deleted.log')), softArchived = () => read(path.join(T, 'archived.log')), bdlog = () => read(BDLOG)
  const live = () => JSON.parse(read(AG)).filter((x) => !x.archived)

  try {
    ok('item work runs as its requester: the qa lead starts as alice (mm run-as alice wp qa), with her item only', await until(() => runas().some((r) => r.person === 'alice' && r.role === 'qa'))
      && runas().find((r) => r.person === 'alice').next.includes('q-1') && !runas().find((r) => r.person === 'alice').next.includes('q-2')
      && runas().find((r) => r.person === 'alice').project === 'wp')
    ok("wake reads mm's record of asks for its project (mm run-asks wp --json)", /^wp --json$/m.test(read(path.join(T, 'asks.log'))))
    ok('items nobody asked for (d-1, and d-3 under dave\'s name): the dev lead starts plain (bin/lead start dev), never as the owner', await until(() => plains().some((r) => r.role === 'dev' && r.next.includes('d-1'))))
    ok("...an item created and commented on under a person's name with no ask starts no run on their token (no mm run-as dave), nor the owner's", !runas().some((r) => r.person === 'dave' || r.person === 'boss'))
    ok("...the plain dev lead is sent dave's comment on d-3 (a plain lead's work: nobody asked on the host)", await until(() => sent().split('----').some((m) => /TO plain-dev-/.test(m) && /dave commented on d-3/.test(m))))
    ok('...the person runs\' handover names only that person\'s items in progress (LEAD_ITEMS set, empty here)', runas().every((r) => r.items === ''))
    ok('...the qa lead never starts plain (each of its items has an ask)', !plains().some((r) => r.role === 'qa'))
    // alice's run, idle, while only bob's work waits (his comment): it makes way, and bob's run starts
    ok("alice's run makes way for bob's: archived, then the qa lead starts as bob", await until(() => runas().some((r) => r.person === 'bob' && r.role === 'qa'))
      && archived().includes('run-alice-qa') && /deleted qa's run for alice .*idle: only other people's work waits \(bob\)/.test(out))
    ok("...and his waiting item goes to his run", await until(() => sent().split('----').some((m) => /TO run-bob-qa/.test(m) && m.includes('q-2'))))
    ok("...and nothing of bob's went to alice's run", !sent().split('----').some((m) => m.includes('TO run-alice') && m.includes('q-2')))
    const bobRun = () => live().find((x) => x.labels.person === 'bob')?.id
    // a comment by bob on his item: sent to his run
    items.find((i) => i.id === 'q-2').status = 'in_progress'
    emit(ev('comment', 'q-2', 'bob', { comment: { id: 'c2', author: 'bob', text: 'any news?' } }))
    ok("bob's comment on his item goes to bob's run", await until(() => sent().split('----').some((m) => bobRun() && m.includes(`TO ${bobRun()} `) && m.includes('any news?')))
      || (console.log(`       bob's run ${bobRun()}; agents ${read(AG)}\n       sent:\n${sent()}\n${out.split('\n').slice(-15).join('\n')}`), false))
    // the daemon can't say its worker (a status call that fails): nothing is archived, nothing sent to a person run
    fs.renameSync(path.join(T, 'worker.pid'), path.join(T, 'worker.off'))
    const s0 = sent().length, a0 = archived().length
    emit(ev('comment', 'q-2', 'bob', { comment: { id: 'c2b', author: 'bob', text: 'while unknown' } }))
    await sleep(2500)
    ok("the daemon can't say its worker: no person run is archived, and nothing is sent to one (it waits)", archived().length === a0 && !sent().slice(s0).includes('while unknown'))
    fs.renameSync(path.join(T, 'worker.off'), path.join(T, 'worker.pid'))
    const r0 = bobRun(), t0 = Date.now()
    ok('...once it can again, the waiting comment goes to the same run of bob', await until(() => sent().slice(s0).includes('while unknown')) && sent().slice(s0).includes(`TO ${r0} `) && archived().length === a0
      || (console.log(`       after ${Date.now() - t0} ms; bob's run ${r0}, now ${bobRun()}; sent:\n${sent().slice(s0)}\n       archived: ${archived().slice(0)}`), false))
    // dave asks for d-3 at the gateway (now in mm's record): the plain dev lead makes way, and dave's run starts
    asks({ 'q-1': 'alice', 'q-2': 'bob', 'd-3': 'dave' })
    ok('wake reads the new ask on its next pass', await until(() => /people asked for on the host \(3 now\)/.test(out)))
    emit(ev('comment', 'd-3', 'dave', { comment: { id: 'c0b', author: 'dave', text: 'asked for it now' } }))
    ok("dave's live ask for d-3: the plain dev lead makes way, and the dev lead starts as dave (mm run-as dave wp dev)", await until(() => runas().some((r) => r.person === 'dave' && r.role === 'dev'))
      && /deleted dev's plain lead \(plain-dev-\d+\), idle: only other people's work waits \(dave\)/.test(out))
    ok("...and d-3's waiting comment goes to dave's run; it is never pointed at d-1 (nobody's: not in its queue line either)", await until(() => sent().split('----').some((m) => /TO run-dave-dev-/.test(m) && m.includes('asked for it now')))
      && !sent().split('----').some((m) => /TO run-dave-dev-/.test(m) && m.includes('d-1')))
    // no token: carol asks the dev lead for something; the run in place makes way, carol's is refused
    items.push({ id: 'd-2', assignee: 'dev', status: 'open', priority: 1, title: "carol's ask", labels: [] })
    asks({ 'q-1': 'alice', 'q-2': 'bob', 'd-3': 'dave', 'd-2': 'carol' })
    emit(ev('create', 'd-2', 'carol'))
    ok('a person with no token: mm run-as carol was tried, and no run is hers', await until(() => runas().some((r) => r.person === 'carol' && r.next.includes('d-2'))) && !live().some((x) => x.labels.person === 'carol'))
    ok('...the item says why, in plain words, with where to set the token', await until(() => /comments add d-2 No run yet: this item's work runs as carol \(who asked for it\).*carol has no Claude token set.*https:\/\/auth\.example\.org\/s\/token.*does not use the owner's token/.test(bdlog())))
    ok("...the owner's token is never used for her item (no other person's run got d-2)", !runas().some((r) => r.person !== 'carol' && r.next.includes('d-2'))
      && !sent().split('----').some((m) => m.includes('d-2')))
    await sleep(2500)
    ok('...said once (the next tries wait in a backoff)', (bdlog().match(/comments add d-2 No run yet/g) || []).length === 1)
    // the Paseo daemon restarts: a new worker
    const before = live().filter((x) => x.labels.person).map((x) => x.id)
    const n0 = runas().length
    newWorker()
    ok(`a daemon restart: every person run made before is archived (${before.join(', ')})`, before.length > 0 && await until(() => before.every((id) => archived().includes(id))))
    ok('...wake said why', await until(() => /deleted .*run for (bob|dave).*the Paseo daemon restarted/.test(out), 4000))
    const sentBefore = sent().length
    emit(ev('comment', 'q-2', 'bob', { comment: { id: 'c3', author: 'bob', text: 'after the restart' } }))
    ok("...bob's next comment goes to a new run of his (on the new worker), never to the archived one", await until(() => runas().slice(n0).some((r) => r.person === 'bob'))
      && await until(() => sent().slice(sentBefore).includes('after the restart')) && !before.some((id) => sent().slice(sentBefore).includes(`TO ${id}`))
      && live().filter((x) => x.labels.person === 'bob').every((x) => x.labels['paseo-worker'].startsWith(fs.readFileSync(path.join(T, 'worker.pid'), 'utf8') + '.')))
    // a person run wake never started (the owner's own mm run-as, for a role that is no lead here), and a plain agent
    const l = JSON.parse(read(AG)); l.push({ id: 'manual-y', status: 'idle', labels: { project: 'wp', role: 'other', person: 'alice', 'paseo-worker': '1.1' } },
      { id: 'plain-x', status: 'running', labels: { project: 'wp', role: 'other' } }); fs.writeFileSync(`${AG}.t`, JSON.stringify(l)); fs.renameSync(`${AG}.t`, AG)
    ok('the tidy archives any person run of the project made on another worker (also one wake did not start), and says why', await until(() => archived().includes('manual-y')
      && /deleted (a|other) run for alice \(manual-y\): the Paseo daemon restarted since it was made/.test(out), 6000))
    ok('...and never a plain agent (no person label)', !archived().includes('plain-x'))
    // deleted, not archived: a send to an archived run would bring it back on the daemon's token (sy-q8fv)
    ok('...a person run is deleted for good, never only archived (it is gone from Paseo)', !softArchived().includes('manual-y')
      && !JSON.parse(read(AG)).some((x) => x.id === 'manual-y' || x.id === 'run-alice-qa'))
  } finally {
    w.kill(); srv.close(); for (const x of workers) x.kill()
    if (process.env.WAKE_TEST_OUT) fs.writeFileSync(`${process.env.WAKE_TEST_OUT}.${labels ? 'labels' : 'cli'}`, `${out}\n--- runas\n${read(path.join(T, 'runas.log'))}\n--- archived\n${archived()}\n--- bd\n${bdlog()}`)
    else if (fail) console.log(out.split('\n').slice(-25).join('\n'))
    fs.rmSync(T, { recursive: true, force: true })
  }
}
await scenario(false)
await scenario(true)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
