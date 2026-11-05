#!/usr/bin/env node
// bin/wake after a restart (sy-6ym, sy-670): a lead whose Paseo agent shows `closed` and has work waiting (in progress or
// blocked) is started again once with bin/lead start (a resumed agent has none of bin/lead's env); a closed lead with
// nothing open, and an idle one, are left alone; a failed start is tried again; a lead that closes again soon is not
// restarted twice within WAKE_RESUME_MS.
// Hermetic: temp folder, stub paseo and bd-serve, no obs.
//   node test/wake-resume.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-resume-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(T, 'proj', 'bin'), { recursive: true })
fs.mkdirSync(path.join(T, 'proj', 'leads'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'qa' }, { id: 'ops' }, { id: 'dev' }] }))
fs.mkdirSync(path.join(T, 'proj', 'control'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'bin', 'bd'), '#!/bin/sh\n', { mode: 0o755 })
// stub bin/lead: `start <role>` is recorded, and that role's lead is then running (idle), as after bin/lead start
const STARTED = path.join(T, 'started.txt')
fs.writeFileSync(path.join(T, 'proj', 'bin', 'lead'), `#!/bin/sh
[ "$1" = start ] || exit 2
[ -f "${T}/failstart" ] && { rm -f "${T}/failstart"; echo "paseo refused" >&2; exit 1; }
echo "START $2" >>"${STARTED}"; echo idle >"${T}/$2.status"
`, { mode: 0o755 })
// stub paseo: each role's agent status lives in <role>.status; `send` records the prompt (per agent) and the agent
// then runs (idle), as a resumed Paseo agent does
const SENT = path.join(T, 'sent.txt'), st = (r, s) => fs.writeFileSync(path.join(T, `${r}.status`), s)
st('qa', 'closed'); st('ops', 'closed'); st('dev', 'idle')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in qa ops dev; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"$(cat ${T}/$r.status)\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) [ -f "${T}/failsend" ] && { rm -f "${T}/failsend"; echo "send failed" >&2; exit 1; }
        id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done
        echo idle >"${T}/\${id#agent-}.status" ;;
esac
`, { mode: 0o755 })

const items = [
  { id: 'p-1', assignee: 'qa', status: 'in_progress', title: 'half done before the reboot' },
  { id: 'p-2', assignee: 'dev', status: 'in_progress', title: 'dev is idle, not closed' },
  { id: 'p-3', assignee: 'ops', status: 'open', title: 'open, not in progress' },
]
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  if (u.pathname.startsWith('/v0/beads/issues')) return json({ items })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wr',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '60000' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const sent = () => { try { return fs.readFileSync(SENT, 'utf8') } catch { return '' } }
const opsLog = () => { try { return fs.readFileSync(path.join(T, 'proj', '.run', 'logs', 'ops.log'), 'utf8') } catch { return '' } }
const starts = (r) => { try { return (fs.readFileSync(STARTED, 'utf8').match(new RegExp(`^START ${r}$`, 'gm')) || []).length } catch { return 0 } }

try {
  console.log('== after a restart: a closed lead with work in progress')
  ok('qa is started again with bin/lead start (its own env, its own Claude folder; sy-670)', await until(() => starts('qa') === 1))
  ok('...not resumed with a message to the old agent', !/TO agent-qa\nYou were closed/.test(sent()))
  ok('...logged, with its handover count', await until(() => /restarted qa \(was qa, closed\): 0 reason\(s\) wait for it, 1 item\(s\) in its handover/.test(opsLog())))
  await sleep(1500)
  ok('a closed lead with nothing in progress or blocked (ops) is left alone', starts('ops') === 0)
  ok('an idle lead (dev) is not restarted', starts('dev') === 0)

  console.log('== once, not on every check')
  st('qa', 'closed'); await sleep(1500)
  ok('qa closes again soon after: not restarted twice (WAKE_RESUME_MS)', starts('qa') === 1)

  console.log('== a failed start is tried again; a blocked item counts as work')
  fs.writeFileSync(path.join(T, 'failstart'), ''); items.push({ id: 'p-4', assignee: 'ops', status: 'blocked', title: 'ops waits on a human' })
  ok('the failure is logged, with the reason (reasons kept)', await until(() => /restart of ops failed \(reasons kept\): paseo refused/.test(opsLog())))
  ok('...and ops is started at the next check', await until(() => starts('ops') === 1))
} finally {
  w.kill(); srv.close()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-15).join('\n')}\n${out.slice(-1500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
