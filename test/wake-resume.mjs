#!/usr/bin/env node
// bin/wake after a restart (sy-6ym): a lead whose Paseo agent shows `closed` and has work waiting is resumed once with a
// message to the same agent; a closed lead with nothing open, and an idle one, are left alone; a failed send is tried
// again; a lead that closes again soon is not resumed twice within WAKE_RESUME_MS.
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
const to = (r) => (sent().match(new RegExp(`TO agent-${r}\\n`, 'g')) || []).length

try {
  console.log('== after a restart: a closed lead with work in progress')
  ok('qa is resumed, in its own agent (context kept)', await until(() => to('qa') === 1))
  ok('...told why, with its item in progress', /closed by a restart[\s\S]*p-1 "half done before the reboot" is in progress/.test(sent()))
  ok('...logged', await until(() => /resumed qa \(qa\): it was closed with 1 open reason/.test(opsLog())))
  await sleep(1500)
  ok('a closed lead with nothing in progress (ops) is left alone', to('ops') === 0)
  ok('an idle lead (dev) is not sent a resume', !/TO agent-dev\nYou were closed/.test(sent()))

  console.log('== once, not on every check')
  st('qa', 'closed'); await sleep(1500)
  ok('qa closes again soon after: not resumed twice (WAKE_RESUME_MS)', to('qa') === 1)

  console.log('== a failed send is tried again')
  fs.writeFileSync(path.join(T, 'failsend'), ''); items.push({ id: 'p-4', assignee: 'ops', status: 'in_progress', title: 'ops now has work' })
  ok('the failure is logged (reasons kept)', await until(() => /resume of ops failed \(reasons kept\)/.test(opsLog())))
  ok('...and ops is resumed at the next check', await until(() => to('ops') === 1 && /p-4 "ops now has work"/.test(sent())))
} finally {
  w.kill(); srv.close()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-15).join('\n')}\n${out.slice(-1500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
