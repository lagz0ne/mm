#!/usr/bin/env node
// bin/wake: whom a person's comment wakes (sy-uykv). No pick: the board's Lead (roles.json `lead`), told to answer it or
// route it on; a pick (the comment's first line `→ <role>`, the board's To; on the public side after `[owner] `): that
// role; a pick of no role of the board: the Lead. A lead's comment wakes the assignee as before, and on a board with no
// Lead a person's comment wakes the assignee too (today's rule). lib/to.mjs: pickOf, splitPick, withPick.
// Hermetic: temp folder, stub paseo and bd, a small fake bd serve (events), no obs.
//   node test/wake-person-to.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pickOf, splitPick, withPick } from '../template/bin/lib/to.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-person-to-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

console.log('== lib/to.mjs')
const R = ['ops', 'review', 'platform']
ok('withPick: the pick line on top; none: the text as it is', withPick('hi', 'review') === '→ review\nhi' && withPick('hi', '') === 'hi')
ok('pickOf reads the pick, also after the public side\'s [owner] and with ->', pickOf('→ review\nhi', R) === 'review' && pickOf('[owner] → platform\nhi', R) === 'platform' && pickOf('-> ops\nx', R) === 'ops')
ok('...no pick: null; not a role of the board: null; a message header is no pick', pickOf('hi', R) === null && pickOf('→ nobody\nhi', R) === null && pickOf('ASK → review\nWhy: x', R) === null)
ok('splitPick: the pick and the words (the [owner] prefix kept)', JSON.stringify(splitPick('[owner] → review\nline 1\nline 2', R)) === JSON.stringify({ to: 'review', body: '[owner] line 1\nline 2' }))

const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true })
const roles = (lead) => fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ ...(lead ? { lead } : {}), roles: R.map((id) => ({ id })) }))
roles('ops')
fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), '#!/bin/sh\n', { mode: 0o755 })
const SENT = path.join(T, 'sent.txt')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${R.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"idle\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })

const now = () => new Date().toISOString()
const items = new Map()
for (const id of ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']) items.set(id, { id, title: `title of ${id}`, status: 'in_progress', assignee: 'platform', labels: [], updated_at: now() })
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
  if (m) return items.has(decodeURIComponent(m[1])) ? json({ ...items.get(decodeURIComponent(m[1])), comments: [] }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'ws',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '600000' }
delete env.MM_SERVICE
let w = null, out = ''
const start = () => { w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)) }
const sent = () => { try { return fs.readFileSync(SENT, 'utf8') } catch { return '' } }
const opsLog = () => { try { return fs.readFileSync(path.join(PROJ, '.run', 'logs', 'ops.log'), 'utf8') } catch { return '' } }
const to = (role, from = 0) => sent().slice(from).split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')
let seq = 0, n = 0
const emit = (e) => { e.seq = ++seq; e.ts = now(); records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const comment = (id, author, text) => emit({ op: 'comment', issue_id: id, actor: author, issue: { ...items.get(id) }, comment: { id: `c${++n}`, author, text } })

try {
  start()
  await until(() => /watching/.test(opsLog()))
  console.log('== a person\'s comment (the board has a Lead: ops)')
  let q = sent().length
  comment('p-1', 'alex', 'Why is this taking so long?\nPlease look.')
  ok('no pick: the board\'s Lead (ops) is woken, told to answer or route it on, and who the assignee is',
    await until(() => /alex commented #?\d* ?on p-1 \(quoted below\), to you as the board's Lead \(they picked no role\): answer it, or route it on[^\n]*the assignee: platform/.test(to('ops', q))))
  await sleep(800)
  ok('...the assignee (platform) is not woken for it', !/p-1/.test(to('platform', q)))
  q = sent().length
  comment('p-2', 'alex', withPick('Review this one, please.', 'review'))
  ok('a pick (→ review): review is woken, told the person picked it', await until(() => /alex commented #?\d* ?on p-2 \(quoted below\), to you: they picked you/.test(to('review', q))))
  await sleep(800)
  ok('...not the Lead, not the assignee', !/p-2/.test(to('ops', q)) && !/p-2/.test(to('platform', q)))
  q = sent().length
  comment('p-3', 'alex', '[owner] → platform\nfrom the public side')
  ok('a pick on the public side ([owner] → platform): platform, the assignee, is woken', await until(() => /alex commented #?\d* ?on p-3 \(quoted below\), to you: they picked you/.test(to('platform', q))))
  q = sent().length
  comment('p-4', 'alex', '→ nobody\nhello')
  ok('a pick that is no role of the board: the Lead', await until(() => /on p-4 \(quoted below\), to you as the board's Lead/.test(to('ops', q))))
  q = sent().length
  comment('p-5', 'review', 'NOTE → platform\nlooked at it')
  ok('a lead\'s comment: the assignee (platform), as before, with no routing words', await until(() => /review commented #?\d* ?on p-5 \(quoted below\)\n/.test(to('platform', q))))
  await sleep(800)
  ok('...not the Lead', !/p-5/.test(to('ops', q)))
  q = sent().length
  comment('p-6', 'watchdog', 'a finding')
  ok('the system\'s comment (watchdog): the assignee, as before, not the Lead', await until(() => /watchdog commented #?\d* ?on p-6 \(quoted below\)\n/.test(to('platform', q))) && !/p-6/.test(to('ops', q)))

  console.log('== a board with no Lead: a person\'s comment wakes the assignee (today\'s rule)')
  w.kill(); await sleep(500)
  roles('')
  start()
  await until(() => opsLog().split(/watching/).length > 2)
  await sleep(500)
  q = sent().length
  comment('p-7', 'alex', 'anyone?')
  ok('no Lead, no pick: the assignee (platform) is woken, with no routing words', await until(() => /alex commented #?\d* ?on p-7 \(quoted below\)\n/.test(to('platform', q))))
  ok('...not ops', !/p-7/.test(to('ops', q)))
} finally {
  w?.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-25).join('\n')}\n${out.slice(-1500)}\n--- sent\n${sent().slice(-2500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
