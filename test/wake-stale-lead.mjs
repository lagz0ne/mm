#!/usr/bin/env node
// bin/wake, a plain lead made before the Paseo daemon restarted (sy-vsh5): Paseo keeps no agent's env, so a lead it
// resumes runs without bin/lead's (its Claude folder, its board actor). bin/lead start labels each lead
// paseo-worker=<the daemon's worker>; a lead labelled with another worker is never sent to: with work waiting it is
// started again with bin/lead start, with nothing waiting it is archived (never deleted), one in a turn is left. One
// labelled with the current worker, or with no label (made before the label), is sent to as before. A kept role is not
// started (as for a closed lead). The daemon can't say its worker: nothing changes (the send, nothing archived).
// Hermetic: temp folder, stub paseo (a real process stands for the daemon's worker), stub bin/lead, bin/bd, bd-serve.
//   node test/wake-stale-lead.mjs            exit 0 = every check passed
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
const stat22 = (pid) => { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }

async function scenario(known) {
  console.log(`== ${known ? "the daemon says its worker (it restarted: a new one)" : "the daemon can't say its worker"}`)
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-stale-'))
  const PR = path.join(T, 'proj')
  fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PR, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(PR, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PR, 'control'), { recursive: true })
  fs.writeFileSync(path.join(PR, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'qa' }, { id: 'dev' }, { id: 'ops' }, { id: 'doc' }, { id: 'busy' }, { id: 'own', keep: true }] }))
  fs.writeFileSync(path.join(PR, 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${T}/bd.log"\n`, { mode: 0o755 })
  const AG = path.join(T, 'agents.json')
  const lib = `const fs = require('fs'), T = ${JSON.stringify(T)}, AG = T + '/agents.json'
const agents = () => JSON.parse(fs.readFileSync(AG, 'utf8')), save = (a) => { fs.writeFileSync(AG + '.' + process.pid, JSON.stringify(a)); fs.renameSync(AG + '.' + process.pid, AG) }
const worker = () => { const pid = fs.readFileSync(T + '/worker.pid', 'utf8').trim(); const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return pid + '.' + s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }
`
  // stub bin/lead: recorded; archives the role's leads and makes a new one on the current worker (as bin/lead does)
  fs.writeFileSync(path.join(PR, 'bin', 'lead'), `#!/usr/bin/env node
${lib}
const role = process.argv[3]
fs.appendFileSync(T + '/started.log', role + '\\n'); fs.appendFileSync(T + '/next.log', role + ': ' + (process.env.LEAD_NEXT || '') + '\\n')
const l = agents(); for (const x of l) if (x.labels.role === role && !x.archived) { x.archived = true; fs.appendFileSync(T + '/archived.log', x.id + '\\n') }
const id = 'new-' + role; l.push({ id, status: 'idle', labels: { project: 'ws', role, 'paseo-worker': worker() } }); save(l); console.log(id)
`, { mode: 0o755 })
  // stub paseo: agents in agents.json, listed with their labels (as the SDK gives them); `daemon status` says the worker
  fs.writeFileSync(path.join(T, 'paseo'), `#!/usr/bin/env node
${lib}
const [cmd, ...a] = process.argv.slice(2)
if (cmd === 'ls') {
  const want = {}; for (let i = 0; i < a.length; i++) if (a[i] === '--label') { const [k, v] = a[++i].split('='); want[k] = v }
  const list = agents().filter((x) => !x.archived && Object.entries(want).every(([k, v]) => x.labels[k] === v))
  if (a.includes('-q')) { console.log(list.map((x) => x.id).join('\\n')); process.exit(0) }
  console.log(JSON.stringify(list.map((x) => ({ id: x.id, shortId: x.id, status: x.status, labels: x.labels }))))
} else if (cmd === 'daemon') { if (!fs.existsSync(T + '/worker.pid')) { console.error('no worker'); process.exit(1) } console.log(JSON.stringify({ workerPid: Number(fs.readFileSync(T + '/worker.pid', 'utf8')) })) }
else if (cmd === 'archive') { const id = a.filter((x) => x !== '--force')[0], l = agents(); for (const x of l) if (x.id === id) x.archived = true; save(l); fs.appendFileSync(T + '/archived.log', id + '\\n') }
else if (cmd === 'delete') { fs.appendFileSync(T + '/deleted.log', a[0] + '\\n'); save(agents().filter((x) => x.id !== a[0])) }
else if (cmd === 'send') fs.appendFileSync(T + '/sent.log', 'TO ' + a[0] + '\\n')
`, { mode: 0o755 })
  // the daemon's worker now: a real process; the old leads were made on another (a pid and start that are not it)
  const wk = spawn('sleep', ['100000'], { stdio: 'ignore' })
  if (known) fs.writeFileSync(path.join(T, 'worker.pid'), String(wk.pid))
  const cur = `${wk.pid}.${stat22(wk.pid)}`, old = '1.1'
  fs.writeFileSync(AG, JSON.stringify([
    { id: 'old-qa', status: 'idle', labels: { project: 'ws', role: 'qa', 'paseo-worker': old } }, // stale, work waits
    { id: 'cur-dev', status: 'idle', labels: { project: 'ws', role: 'dev', 'paseo-worker': cur } }, // current, work waits
    { id: 'nolabel-ops', status: 'idle', labels: { project: 'ws', role: 'ops' } }, // made before the label, work waits
    { id: 'old-doc', status: 'idle', labels: { project: 'ws', role: 'doc', 'paseo-worker': old } }, // stale, nothing waits
    { id: 'old-busy', status: 'running', labels: { project: 'ws', role: 'busy', 'paseo-worker': old } }, // stale, in a turn
    { id: 'old-own', status: 'idle', labels: { project: 'ws', role: 'own', 'paseo-worker': old } }, // kept role, stale, work waits
  ]))
  const items = ['qa', 'dev', 'ops', 'own'].map((r, k) => ({ id: `${r}-1`, assignee: r, status: 'open', priority: 2, title: `work for ${r}`, labels: [] }))
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); return }
    if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
    if (u.pathname === '/v0/beads/ready') return json({ items: items.filter((i) => i.status === 'open') })
    if (u.pathname === '/v0/beads/issues') return json({ items })
    if (u.pathname.startsWith('/v0/beads/issues/')) return json({ ...items.find((i) => i.id === decodeURIComponent(u.pathname.split('/').pop())), comments: [] })
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH); fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\n')
  const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'ws',
    PASEO_WORKER_TTL_MS: '200', MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_LOG_STDERR: '1', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500',
    WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '60000', WAKE_IDLE_CLOSE_MS: '0', WAKE_PERSON_RUNS: '0' }
  delete env.MM_SERVICE; delete env.CLAUDECODE; delete env.PASEO_AGENT_ID
  const w = spawn('node', [path.join(PR, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
  const sent = () => read(path.join(T, 'sent.log')), started = () => read(path.join(T, 'started.log')).split('\n').filter(Boolean)
  const archived = () => read(path.join(T, 'archived.log')).split('\n').filter(Boolean)
  try {
    ok('a lead labelled with the current worker (dev) is sent its work', await until(() => /^TO cur-dev$/m.test(sent())))
    ok('a lead with no label (ops, made before the label) is sent its work, as before', await until(() => /^TO nolabel-ops$/m.test(sent())))
    if (known) {
      ok('a stale lead with work waiting (qa) is started again with bin/lead start', await until(() => started().includes('qa')))
      ok('...its work (qa-1) in the new lead\'s first prompt (LEAD_NEXT)', /^qa: .*qa-1/m.test(read(path.join(T, 'next.log'))))
      ok('...and nothing ever went to the stale one', !/^TO old-qa$/m.test(sent()))
      ok('a stale lead with nothing waiting (doc) is archived, not deleted, and not started', await until(() => archived().includes('old-doc')) && !read(path.join(T, 'deleted.log')).includes('old-doc') && !started().includes('doc'))
      await sleep(2000)
      ok('a stale lead in a turn (busy) is left: not archived, not started, not sent to', !archived().includes('old-busy') && !started().includes('busy') && !/^TO old-busy$/m.test(sent()))
      ok('a kept role\'s stale lead (own) is not started, not archived, not sent to', !started().includes('own') && !archived().includes('old-own') && !/^TO old-own$/m.test(sent()))
      ok('...the owner is told, as for a closed kept lead (one note)', /create .*own/.test(read(path.join(T, 'bd.log'))))
      ok('no other role is started (dev, ops keep their leads)', !started().includes('dev') && !started().includes('ops'))
      ok('each stale lead is said once in the log, what happens to it', (out.match(/qa's lead old-qa is stale .*: started again with bin\/lead start/g) || []).length === 1
        && /archived doc's stale lead old-doc/.test(out) && (out.match(/busy's lead old-busy is stale .*in a turn/g) || []).length === 1
        && (out.match(/own's lead old-own is stale/g) || []).length <= 2)
    } else {
      ok("the daemon can't say: the stale-labelled lead (qa) is sent its work, as before", await until(() => /^TO old-qa$/m.test(sent())))
      await sleep(2000)
      ok('...nothing is started and nothing archived', !started().length && !archived().length)
    }
  } finally {
    w.kill(); wk.kill(); srv.close()
    if (fail) console.log(`--- wake output\n${out.slice(-3000)}`)
    fs.rmSync(T, { recursive: true, force: true })
  }
}

await scenario(true)
await scenario(false)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
