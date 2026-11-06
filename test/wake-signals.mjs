#!/usr/bin/env node
// bin/wake and the typed end signals (plans/slp step 1): a comment line HANDOFF <role> | BLOCKED | DEPENDENCY <item> |
// REOPEN <item> | DONE wakes the named role at once, even when the writer is the item's assignee; HANDOFF owner labels
// needs-you; the hop limit still counts signals; a working lead gets its wake only once it is idle.
// Hermetic: temp folder, stub paseo, bd and bd-serve, no obs.
//   node test/wake-signals.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-signals-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

const ROLES = ['ops', 'review', 'platform']
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(T, 'proj', 'bin'), { recursive: true })
fs.mkdirSync(path.join(T, 'proj', 'leads'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: ROLES.map((id) => ({ id })) }))
fs.writeFileSync(path.join(T, 'proj', 'leads', 'raci.json'), JSON.stringify({ activities: [{ id: 'sec', title: 'Security', raci: { review: 'A', platform: 'R', ops: 'I' } }] }))
fs.mkdirSync(path.join(T, 'proj', 'control'), { recursive: true })
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(T, 'proj', 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${BDLOG}"\n`, { mode: 0o755 })
// stub paseo: each role's agent status in <role>.status; `send` records the prompt per agent
const SENT = path.join(T, 'sent.txt'), st = (r, s) => fs.writeFileSync(path.join(T, `${r}.status`), s)
for (const r of ROLES) st(r, 'idle')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"$(cat ${T}/$r.status)\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })

const issues = {
  'i-dep': { id: 'i-dep', assignee: 'review', status: 'open', title: 'the item others wait on' },
  'i-spec': { id: 'i-spec', assignee: 'ops', status: 'open', title: 'the spec ops wrote' },
}
const records = [], streams = []
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return issues[decodeURIComponent(m[1])] ? json({ ...issues[decodeURIComponent(m[1])], comments: [] }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'ws',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '600000' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const sent = () => { try { return fs.readFileSync(SENT, 'utf8') } catch { return '' } }
const bdlog = () => { try { return fs.readFileSync(BDLOG, 'utf8') } catch { return '' } }
const opsLog = () => { try { return fs.readFileSync(path.join(T, 'proj', '.run', 'logs', 'ops.log'), 'utf8') } catch { return '' } }
// the prompts one agent got, as one string
const to = (role) => sent().split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')
let seq = 0
const emit = (e) => { e.seq = ++seq; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
let n = 0
const comment = (item, author, text, extra = {}) => emit({ op: 'comment', issue_id: item, actor: author,
  issue: { assignee: 'platform', status: 'in_progress', title: `title of ${item}`, ...extra }, comment: { id: `c${++n}`, author, text } })

try {
  await until(() => /watching/.test(opsLog()))
  console.log('== HANDOFF')
  comment('s-1', 'platform', 'Built it on branch wake.\nHANDOFF review abc1234')
  ok('the assignee writes HANDOFF review: review is woken, with the head', await until(() => /HANDOFF to you from platform on s-1 "title of s-1": abc1234/.test(to('review'))))
  ok('...the writer (platform) is not woken by its own line', !/s-1/.test(to('platform')))
  comment('s-2', 'platform', 'Needs the owner to approve.\nHANDOFF owner the plan in #2')
  ok('HANDOFF owner: the item is labelled needs-you', await until(() => /label add s-2 needs-you --actor wake/.test(bdlog())))
  comment('s-3', 'platform', 'HANDOFF reveiw abc')
  ok('HANDOFF to an unknown role: wake says so on the item (nothing dropped silently)', await until(() => /comments add s-3 HANDOFF names "reveiw"/.test(bdlog())))

  console.log('== BLOCKED')
  comment('s-4', 'platform', 'BLOCKED the box has no docker')
  ok('BLOCKED: the board\'s Lead (ops) is woken, with the reason', await until(() => /BLOCKED: platform is blocked on s-4 "title of s-4": the box has no docker/.test(to('ops'))))
  comment('s-5', 'platform', 'BLOCKED waiting on a key', { labels: ['act:sec'] })
  ok('BLOCKED on an item with an activity: its Accountable role (review) is woken instead', await until(() => /BLOCKED: platform is blocked on s-5/.test(to('review'))))
  ok('...and not the Lead', !/s-5/.test(to('ops')))
  comment('s-6', 'ops', 'BLOCKED the provider is down', { assignee: 'ops' })
  ok('BLOCKED by the Lead itself: needs-you (the human)', await until(() => /label add s-6 needs-you/.test(bdlog())))

  console.log('== DEPENDENCY, REOPEN, DONE')
  comment('s-7', 'platform', 'DEPENDENCY i-dep the sign-in fix')
  ok('DEPENDENCY: that item\'s assignee (review) is woken', await until(() => /DEPENDENCY: platform's s-7 "title of s-7" waits on your i-dep "the item others wait on" \(open\): the sign-in fix/.test(to('review'))))
  comment('s-8', 'platform', 'REOPEN i-spec the Verify line asks for a test the box cannot run')
  ok('REOPEN: that item\'s assignee (ops) is woken, with why', await until(() => /REOPEN i-spec "the spec ops wrote": platform says on s-8 .*the Verify line asks/.test(to('ops'))))
  const before = sent()
  comment('s-9', 'platform', 'All checks pass.\nDONE test/x.sh 12 passed')
  await sleep(1500)
  ok('DONE: nobody is woken (the writer is the assignee)', sent() === before)

  console.log('== a working lead is not interrupted')
  st('review', 'running')
  comment('s-10', 'platform', 'HANDOFF review def5678')
  await sleep(1500)
  ok('review is busy: the HANDOFF waits', !/def5678/.test(to('review')))
  st('review', 'idle')
  ok('...and arrives once review is idle', await until(() => /def5678/.test(to('review'))))

  console.log('== the hop limit counts signals')
  for (let i = 1; i <= 3; i++) {
    comment('s-11', i % 2 ? 'platform' : 'review', `round ${i}\nHANDOFF ${i % 2 ? 'review' : 'platform'} h${i}`)
    await until(() => sent().includes(`h${i}`))
  }
  comment('s-11', 'platform', 'round 4\nHANDOFF review h4')
  ok('the 4th lead-to-lead HANDOFF on one item is not sent', !(await until(() => sent().includes('h4'), 2000)))
  ok('...the item is paused visibly (needs-you)', /label add s-11 needs-you/.test(bdlog()))
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-25).join('\n')}\n${out.slice(-1500)}\n--- sent\n${sent().slice(-2500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
