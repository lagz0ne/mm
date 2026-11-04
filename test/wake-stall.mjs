#!/usr/bin/env node
// bin/wake against a fake bd-serve: (1) its event stream hangs (open, a keepalive, then nothing) while the board keeps
// changing: wake must notice (poll), deliver the missed event, log the stall, reconnect, and wake the lead; an event
// the stream does deliver must not be delivered twice or count as a stall. (2) No reason is ever dropped silently:
// the hop limit pauses visibly (needs-you + a note) instead of dropping; a burst of events from one lead action is one
// hop; a human resumes a paused item; a failed send keeps its reasons; events while wake is stopped are replayed.
// Hermetic: temp folder, stub paseo and bd, no obs.
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
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'qa' }, { id: 'ops' }] }))
fs.mkdirSync(path.join(T, 'proj', 'control'), { recursive: true })
const BDLOG = path.join(T, 'bd.log') // stub bin/bd: what wake asks the board to do (label, comment)
fs.writeFileSync(path.join(T, 'proj', 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${BDLOG}"\n`, { mode: 0o755 })
// stub paseo: one idle qa lead; `send` appends its prompt to a file
const SENT = path.join(T, 'sent.txt')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) case "$*" in *role=qa*) echo '[{"id":"agent-qa","shortId":"agentqa","status":"idle"}]' ;; *) echo '[]' ;; esac ;;
  send) [ -f "${T}/failsend" ] && { rm -f "${T}/failsend"; echo "send failed" >&2; exit 1; }
        shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && { printf '%s\\n----\\n' "$2" >>"${SENT}"; }; shift; done ;;
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
let w, out = ''
const start = () => { w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)) }
start()
const bdlog = () => { try { return fs.readFileSync(BDLOG, 'utf8') } catch { return '' } }
const times = (re) => (sent().match(re) || []).length
let seq = 2
const emit = (e) => { e.seq = ++seq; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`); return e }
const byOps = (id, title) => ({ op: 'update', issue_id: id, actor: 'ops', issue: { assignee: 'qa', status: 'open', title } })
const byHuman = (id, title) => ({ op: 'update', issue_id: id, actor: 'alex', issue: { assignee: 'qa', status: 'open', title } })
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

  console.log('== the hop limit pauses visibly, never drops silently')
  for (let i = 1; i <= 3; i++) { emit(byOps('h-1', `hop item ${i}`)); ok(`lead-to-lead wake ${i} of 3 is sent`, await until(() => times(/h-1 "hop item/g) === i)) }
  emit(byOps('h-1', 'hop item 4'))
  ok('the 4th is not sent', !(await until(() => times(/h-1 "hop item/g) > 3, 2500)))
  ok('...the item is labelled needs-you (pause visible)', await until(() => /label add h-1 needs-you/.test(bdlog())))
  ok('...with a Paused note on it', /comments add h-1 Paused:/.test(bdlog()))
  emit(byOps('h-1', 'hop item 5')); await sleep(1500)
  ok('paused once, not on every later event', (bdlog().match(/label add h-1 needs-you/g) || []).length === 1)
  emit(byHuman('h-1', 'human resumes'))
  ok('a human event resumes it (the lead is woken)', await until(() => /h-1 "human resumes"/.test(sent())))

  console.log('== a burst of events from one lead action is one hop')
  for (let i = 0; i < 5; i++) emit(byOps('h-2', `burst ${i}`))
  ok('one wake for the burst', await until(() => times(/h-2 "burst/g) === 1) && !(await until(() => times(/h-2 "burst/g) > 1, 1500)))
  ok('...and no pause for it', !/label add h-2/.test(bdlog()))

  console.log('== a failed send keeps its reasons')
  fs.writeFileSync(path.join(T, 'failsend'), '')
  emit(byHuman('f-1', 'after a failed send'))
  ok('the send fails once (logged)', await until(() => /send to qa failed \(reasons kept\)/.test(opsLog())))
  ok('...and the reason goes out on the next try', await until(() => /f-1 "after a failed send"/.test(sent())))

  console.log('== events while wake is stopped are replayed when it starts')
  await sleep(2500) // the last seq is saved (2 s throttle)
  w.kill(); await sleep(500)
  const e9 = { op: 'create', issue_id: 'r-1', actor: 'alex', issue: { assignee: 'qa', status: 'open', title: 'while stopped' } }
  e9.seq = ++seq; records.push(e9) // on the board, while no wake runs
  start()
  ok('wake replays it (logged)', await until(() => /replayed 1 event/.test(opsLog())))
  ok('...and wakes the lead for it', await until(() => /r-1 "while stopped"/.test(sent())))
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-15).join('\n')}\n${out.slice(-1500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
