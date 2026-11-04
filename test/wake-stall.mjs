#!/usr/bin/env node
// bin/wake against a fake bd-serve whose event stream hangs (open, a keepalive, then nothing) while the board keeps
// changing. Wake must notice (poll), deliver the missed event, log the stall, reconnect, and wake the lead; an event
// the stream does deliver must not be delivered twice or count as a stall. Hermetic: temp folder, stub paseo, no obs.
//   node test/wake-stall.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-stall-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

// the project folder wake runs from: its bin/ + one role
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(T, 'proj', 'bin'), { recursive: true })
fs.mkdirSync(path.join(T, 'proj', 'leads'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'qa' }] }))
// stub paseo: one idle qa lead; `send` appends its prompt to a file
const SENT = path.join(T, 'sent.txt')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) echo '[{"id":"agent-qa","shortId":"agentqa","status":"idle"}]' ;;
  send) shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && { printf '%s\\n----\\n' "$2" >>"${SENT}"; }; shift; done ;;
esac
`, { mode: 0o755 })

// fake bd-serve: events live in `records`; the watch stream sends only what `streamLive` allows
const records = [], streams = []
let streamLive = false, watches = 0
const ev = (seq, id, title) => ({ seq, op: 'create', issue_id: id, actor: 'alex', issue: { assignee: 'qa', status: 'open', title } })
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    watches++
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1))
    return // hangs: nothing more unless streamLive
  }
  if (u.pathname === '/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0)
    return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since) })
  }
  if (u.pathname.startsWith('/v0/beads/issues') || u.pathname === '/v0/beads/ready') return json({ items: [] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`

const env = { ...process.env, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), MM_PROJECT: 'wq', MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_STALL_MS: '2000' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const opsLog = () => { try { return fs.readFileSync(path.join(T, 'proj', '.run', 'logs', 'ops.log'), 'utf8') } catch { return '' } }
const sent = () => { try { return fs.readFileSync(SENT, 'utf8') } catch { return '' } }

try {
  console.log('== the stream hangs; an event arrives on the board only')
  ok('wake starts watching', await until(() => watches >= 1 && /watching/.test(opsLog())))
  records.push(ev(1, 't-1', 'stalled item'))
  ok('the stall is logged (error level, with the count)', await until(() => /"level":"error"[^\n]*stream stalled: 1 event/.test(opsLog())))
  ok('the lead is woken for the missed event', await until(() => /t-1 "stalled item"/.test(sent())))
  ok('the stream reconnects', await until(() => watches >= 2 && /stream reconnecting from seq 1/.test(opsLog())))

  console.log('== a healthy stream: the event comes through it, once')
  streamLive = true
  const e2 = ev(2, 't-2', 'live item'); records.push(e2)
  for (const s of streams) s.write(`data: ${JSON.stringify(e2)}\n\n`)
  ok('the lead is woken for it', await until(() => /t-2 "live item"/.test(sent())))
  await sleep(3000) // past STALL_MS: the poll must find nothing missing
  ok('no stall reported for it', (opsLog().match(/stream stalled/g) || []).length === 1)
  ok('delivered once (not again by the poll)', (sent().match(/t-2 "live item"/g) || []).length === 1)
  ok('the missed event was delivered once too', (sent().match(/t-1 "stalled item"/g) || []).length === 1)
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-15).join('\n')}\n${out.slice(-1500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
