#!/usr/bin/env node
// The board's lead states (sy-809m): leads are on demand, so a lead is "ready" unless a request is on it, "working on
// <item>" in a turn, "waiting for you" on needs-you, "blocked" on a blocked item (the bd state; a comment is never a
// state), "start failed" when
// wake could not start it; never "offline". (1) site/lead-state.mjs on its own; (2) the board's server (site/server.mjs)
// against a fake bd-serve and a stub paseo: /api/meta and /api/settings carry the states.
// Hermetic: temp folder, no obs, no built site needed.
//   node test/lead-state.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-state-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { leadState } = await import(path.join(SRC, 'template', 'site', 'lead-state.mjs'))
console.log('== site/lead-state.mjs')
const it = (id, assignee, status, labels = []) => ({ id, assignee, status, labels })
ok('no agent, nothing open: ready (not offline)', leadState({ role: 'qa', agent: null }).label === 'ready')
ok('an idle agent, an open item: ready', leadState({ role: 'qa', agent: { status: 'idle' }, items: [it('a-1', 'qa', 'open')] }).state === 'ready')
ok('a closed agent: ready', leadState({ role: 'qa', agent: { status: 'closed' } }).state === 'ready')
const w = leadState({ role: 'qa', agent: { status: 'running' }, wake: { items: ['a-2'], at: '2026-01-01T00:00:02Z' }, lastAct: { item: 'a-1', at: '2026-01-01T00:00:01Z' } })
ok('in a turn: "working on" the item wake handed it (newer than its last action)', w.state === 'working' && w.label === 'working on a-2')
ok('...or the item it touched last, when that is newer', leadState({ role: 'qa', agent: { status: 'running' }, wake: { items: ['a-2'], at: '2026-01-01T00:00:01Z' }, lastAct: { item: 'a-1', at: '2026-01-01T00:00:02Z' } }).label === 'working on a-1')
ok('a needs-you item of its own: "waiting for you"', leadState({ role: 'qa', agent: { status: 'idle' }, items: [it('a-3', 'qa', 'in_progress', ['needs-you'])] }).label === 'waiting for you')
ok('...not for someone else\'s item, nor a closed one', leadState({ role: 'qa', agent: null, items: [it('a-3', 'dev', 'open', ['needs-you']), it('a-4', 'qa', 'closed', ['needs-you'])] }).state === 'ready')
ok('a blocked item of its own: "blocked"', leadState({ role: 'qa', agent: null, items: [it('a-5', 'qa', 'blocked')] }).label === 'blocked')
ok('an item in progress (whatever its comments say): not blocked', leadState({ role: 'qa', agent: null, items: [it('a-6', 'qa', 'in_progress')] }).state === 'ready')
const e = leadState({ role: 'qa', agent: null, wake: { startError: { error: 'paseo refused', items: ['a-7'] } } })
ok('a failed start: "start failed", with the item and the error', e.state === 'error' && e.label === 'start failed' && e.item === 'a-7' && e.error === 'paseo refused')
ok('...but not once an agent runs again', leadState({ role: 'qa', agent: { status: 'idle' }, wake: { startError: { error: 'x', items: [] } } }).state === 'ready')

console.log('== the board serves them')
const B = path.join(T, 'board')
fs.cpSync(path.join(SRC, 'template', 'site'), path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules|\/dist(\/|$)/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
for (const r of ['qa', 'dev', 'ops', 'arch']) fs.mkdirSync(path.join(B, 'leads', r), { recursive: true })
fs.mkdirSync(path.join(B, 'setup'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: ['qa', 'dev', 'ops', 'arch'].map((id) => ({ id, title: id, initial: 'X', color: '#000000' })) }))
fs.mkdirSync(path.join(B, '.run'), { recursive: true }); fs.writeFileSync(path.join(B, '.run', 'wake-state.json'), JSON.stringify({ ops: { startError: { error: 'paseo refused', items: ['i-4'], at: '2026-01-01T00:00:00Z' } }, dev: { items: ['i-2'], at: '2026-01-01T00:00:00Z' } }))
// stub paseo: dev in a turn (in leads/dev), qa idle; ops, arch and setup have no agent
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) echo '[{"id":"agent-dev","shortId":"dev","status":"running","cwd":"${B}/leads/dev"},{"id":"agent-qa","shortId":"qa","status":"idle","cwd":"${B}/leads/qa"}]' ;;
  logs) echo '[Read] {"file_path":"${B}/x"}' ;;
esac
`, { mode: 0o755 })
const items = [
  { id: 'i-1', assignee: 'qa', status: 'open', title: 'open, ready', labels: [] },
  { id: 'i-3', assignee: 'arch', status: 'in_progress', title: 'arch asked the human', labels: ['needs-you'] },
  { id: 'i-4', assignee: 'ops', status: 'open', title: 'ops could not start', labels: [] },
  { id: 'i-5', assignee: 'setup', status: 'blocked', title: 'setup is stuck', labels: [] },
  { id: 'i-6', assignee: 'qa', status: 'in_progress', title: 'qa wrote an old signal line', labels: [] },
]
const records = [{ seq: 1, op: 'comment', issue_id: 'i-6', actor: 'qa', ts: '2026-01-01T00:00:00Z', comment: { id: 'c1', author: 'qa', text: 'Tried twice.\nBLOCKED the key is missing' } }]
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events') return json({ head: 1, records: records.filter((x) => x.seq > Number(u.searchParams.get('since') || 0)) })
  if (u.pathname === '/v0/beads/issues') return json({ items })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const PORT = probe.address().port; probe.close()
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1',
  BOARD_PROJECT: 'ls', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
delete env.MM_SERVICE; delete env.MM_BIND
const s = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; s.stdout.on('data', (d) => (out += d)); s.stderr.on('data', (d) => (out += d))
const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json())
try {
  let meta = null
  for (let i = 0; i < 50 && !meta; i++) { try { meta = await get('/api/meta') } catch { await sleep(200) } }
  const st = meta?.states || {}
  ok('/api/meta has a state for every role and setup', ['qa', 'dev', 'ops', 'arch', 'setup'].every((r) => st[r]?.label))
  ok('qa (idle, an open item; a BLOCKED comment line on an item in progress): ready', st.qa?.label === 'ready')
  ok('dev (in a turn): working on the item wake handed it', st.dev?.label === 'working on i-2')
  ok('arch (no agent, a needs-you item): waiting for you, on i-3', st.arch?.label === 'waiting for you' && st.arch?.item === 'i-3')
  ok('ops (no agent, a failed start): start failed, on i-4, with the error', st.ops?.label === 'start failed' && st.ops?.item === 'i-4' && st.ops?.error === 'paseo refused')
  ok('setup (no agent, an item set to blocked): blocked', st.setup?.label === 'blocked' && st.setup?.item === 'i-5')
  ok('nothing says offline', !/offline|not running/.test(JSON.stringify(st)))
  const set = await get('/api/settings')
  ok('/api/settings carries the same states (the Leads page)', set.roles?.find((r) => r.role === 'arch')?.state?.label === 'waiting for you' && set.setup?.state?.label === 'blocked')
} finally {
  s.kill(); srv.close()
  if (fail) console.log(`--- board output\n${out.slice(-2000)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
