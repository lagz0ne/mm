#!/usr/bin/env node
// bin/wake, one live lead per role (sy-p8pc): after a machine restart Paseo can resume an old lead after bin/lead start
// looked, and two leads of one role worked side by side. Proves: two idle leads of a role (the older listed first): the
// older is archived with a plain archive, and a wake goes to the newer only; an older lead in a turn is never
// interrupted (no --force) and is archived on a later pass, once its turn ends; said once per agent; a worker
// (role=<role>-worker) and a person's run (its title "(for <person>)": the CLI gives no labels) are never a second lead.
// Hermetic: temp folder and MM_HOME, stub paseo (agents in a JSON file), bin/lead, bin/bd and bd-serve, no obs.
//   node test/wake-twoleads.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-twoleads-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const ROLES = ['qa', 'dev', 'ops']
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(T, 'proj', 'bin'), { recursive: true })
fs.mkdirSync(path.join(T, 'proj', 'leads'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ roles: ROLES.map((id) => ({ id })) }))
fs.mkdirSync(path.join(T, 'proj', 'control'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'bin', 'bd'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
fs.writeFileSync(path.join(T, 'proj', 'bin', 'lead'), `#!/bin/sh\necho "START $2" >>"${T}/started.txt"\n`, { mode: 0o755 })
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\nrestore:\n  hold: false\n')

// stub paseo: the agents in agents.json ({id, status, createdAt, title, labels}); ls filters by --label k=v and, as the
// CLI does, gives no labels back; a plain archive refuses a running agent; --force is recorded and refused
const AG = path.join(T, 'agents.json'), SENT = path.join(T, 'sent.txt'), ARCH = path.join(T, 'archived.txt')
const at = (min) => new Date(Date.now() - min * 60000).toISOString()
const agent = (id, role, status, min, f = {}) => ({ id, shortId: id, status, createdAt: at(min), title: `wt · ${role} lead`, labels: { project: 'wt', role }, ...f })
let agents = [
  agent('qa-old', 'qa', 'idle', 90), agent('qa-new', 'qa', 'idle', 5), // the older listed first
  agent('dev-new', 'dev', 'idle', 5), agent('dev-old', 'dev', 'running', 90), // the older in a turn
  agent('ops-lead', 'ops', 'idle', 5),
  agent('ops-w1', 'ops', 'idle', 1, { title: 'wt · ops worker w1', labels: { project: 'wt', role: 'ops-worker' } }),
  agent('ops-sam', 'ops', 'idle', 1, { title: 'wt · ops lead (for sam)', labels: { project: 'wt', role: 'ops', person: 'sam' } }),
]
const save = () => fs.writeFileSync(AG, JSON.stringify(agents))
const setStatus = (id, s) => { agents = JSON.parse(read(AG)); agents.find((a) => a.id === id).status = s; save() }
save()
fs.writeFileSync(path.join(T, 'paseo.mjs'), `import fs from 'node:fs'
const a = process.argv.slice(2), AG = ${JSON.stringify(AG)}, all = JSON.parse(fs.readFileSync(AG, 'utf8'))
if (a[0] === 'ls') {
  const want = []; for (let k = 0; k < a.length; k++) if (a[k] === '--label') want.push(a[k + 1].split('='))
  console.log(JSON.stringify(all.filter((x) => want.every(([k, v]) => x.labels[k] === v)).map(({ labels, ...x }) => x)))
} else if (a[0] === 'send') {
  fs.appendFileSync(${JSON.stringify(SENT)}, 'TO ' + a[1] + '\\n' + a[a.indexOf('--prompt') + 1] + '\\n----\\n')
} else if (a[0] === 'archive') {
  if (a.includes('--force')) { fs.appendFileSync(${JSON.stringify(ARCH)}, 'FORCED ' + a.at(-1) + '\\n'); process.exit(1) }
  const x = all.find((y) => y.id === a[1]); if (!x) { console.error('no such agent'); process.exit(1) }
  if (x.status === 'running') { console.error('agent is running (use --force)'); process.exit(1) }
  fs.appendFileSync(${JSON.stringify(ARCH)}, 'ARCHIVE ' + a[1] + '\\n'); fs.writeFileSync(AG, JSON.stringify(all.filter((y) => y.id !== a[1])))
}
`)
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh\nexec node "${T}/paseo.mjs" "$@"\n`, { mode: 0o755 })

const items = [], records = [], streams = []
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wt',
  MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500',
  WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '1500', WAKE_IDLE_CLOSE_MS: '0' }
delete env.MM_SERVICE; delete env.CLAUDECODE; delete env.PASEO_AGENT_ID
const w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const archived = () => read(ARCH), opsLog = () => read(path.join(T, 'proj', '.run', 'logs', 'ops.log'))
const to = (id) => read(SENT).split('----\n').filter((b) => b.startsWith(`TO ${id}\n`)).join('\n')
let seq = 0
const emit = (e) => { e.seq = ++seq; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const create = (id, role, title) => { items.push({ id, assignee: role, status: 'open', priority: 2, title, labels: [] }); emit({ op: 'create', issue_id: id, actor: 'alex', issue: { assignee: role, status: 'open', priority: 2, title } }) }
const n = (re, s) => (s.match(re) || []).length

try {
  await until(() => /watching/.test(opsLog()))
  console.log('== two idle leads of a role')
  ok('the older qa lead is archived (a plain archive), the newer stays', await until(() => /^ARCHIVE qa-old$/m.test(archived())) && !/qa-new/.test(archived()))
  ok('...logged, naming the lead kept', await until(() => /archived an older qa lead \(qa-old, idle\): qa-new is the role's lead/.test(opsLog())))
  create('q-1', 'qa', 'a new item for qa')
  ok('a wake goes to the newer one', await until(() => /q-1: a new item for qa/.test(to('qa-new'))))
  ok('...and never to the older', !to('qa-old'))

  console.log('== the older lead in a turn')
  await sleep(1500)
  ok('dev-old, in a turn, is not archived, and never with --force', !/dev-old/.test(archived()) && !/FORCED/.test(archived()))
  ok('...said once (left until its turn ends), not on every pass', n(/dev has a second lead \(dev-old, older than dev-new\), in a turn: left until its turn ends/g, opsLog()) === 1)
  create('d-1', 'dev', 'a new item for dev')
  ok('a wake for dev goes to the newer one only', await until(() => /d-1: a new item for dev/.test(to('dev-new'))) && !to('dev-old'))
  setStatus('dev-old', 'idle')
  ok('its turn ends: archived on a later pass', await until(() => /^ARCHIVE dev-old$/m.test(archived())))
  ok('...logged once', await until(() => n(/archived an older dev lead \(dev-old, idle\)/g, opsLog()) === 1))

  console.log('== a worker and a person run are not a second lead')
  await sleep(1500)
  ok('ops: its worker and its person run are left alone', !/ops-/.test(archived()))
  ok('...and nothing says ops has a second lead', !/older ops lead|ops has a second lead/.test(opsLog()))
  ok('nothing was ever forced', !/FORCED/.test(archived()))
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-30).join('\n')}\n${out.slice(-1500)}\n--- archived\n${archived()}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
