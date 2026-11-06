#!/usr/bin/env node
// bin/wake at start (sy-u43j): an item whose last comment is a human's gets a start note ("has an unanswered comment");
// one whose last comment is its lead's own gets none, also when that comment is past the journal's first page (bd serve
// gives at most 500 events a read: wake reads every page); `brain` (the system board's ops before 2026-11-05) is never a
// human; the events missed while wake was stopped are all replayed, also more than one page of them.
// Hermetic: temp folder, stub paseo, bd and bd-serve (a fake board whose journal pages as bd serve's does), no obs.
//   node test/wake-start.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-start-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

const ROLES = ['ops', 'review', 'platform']
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(T, 'proj', 'bin'), { recursive: true })
fs.mkdirSync(path.join(T, 'proj', 'leads'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: ROLES.map((id) => ({ id })) }))
fs.mkdirSync(path.join(T, 'proj', 'control'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'bin', 'bd'), '#!/bin/sh\n', { mode: 0o755 })
const SENT = path.join(T, 'sent.txt')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"idle\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })

// the board: items, and a journal written before wake starts
const now = () => new Date().toISOString()
const items = new Map()
const add = (id, f) => items.set(id, { id, title: `title of ${id}`, status: 'in_progress', assignee: 'platform', labels: [], updated_at: now(), ...f })
for (const id of ['a-1', 'a-2', 'a-3', 'b-1']) add(id)
add('f-1', { assignee: '', status: 'open' })
const records = []
let n = 0
const emit = (e) => records.push({ seq: records.length + 1, ts: now(), issue: { ...items.get(e.issue_id) }, ...e })
const comment = (id, author, text) => emit({ op: 'comment', issue_id: id, actor: author, comment: { id: `c${++n}`, author, text } })
comment('a-1', 'alex', 'please look at a-1')         // seq 1: a human asks...
comment('a-2', 'alex', 'and a-2 too')                 // seq 2: unanswered to the end
comment('b-1', 'brain', 'ops (as brain) noted this')  // seq 3: the last comment on b-1
const SAVED = records.length                          // wake stopped here (its saved place)
for (let i = 0; i < 597; i++) emit({ op: 'update', issue_id: 'f-1', actor: 'ops' }) // more than a page of other events
comment('a-1', 'platform', 'done, see the commit')    // ...the lead answered a-1 (past the first page)
comment('a-3', 'alex', 'late question on a-3')        // a human, past the first page, and past 500 after SAVED
const HEAD = records.length
fs.writeFileSync(path.join(T, 'proj', '.wake-state.json'), JSON.stringify({ _seq: SAVED }))

const reads = []
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); return }
  if (u.pathname === '/v0/beads/events') { // as bd serve: oldest first, at most `limit` a read, and the board's head
    const since = Number(u.searchParams.get('since') || 0), limit = Math.min(Number(u.searchParams.get('limit') || 500), 500)
    reads.push(since)
    return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since).slice(0, limit) })
  }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json({ ...items.get(decodeURIComponent(m[1])), comments: [] }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'ws',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '600000', WAKE_RESUME_CHECK_MS: '600000', WAKE_LEASE_MS: '86400000' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const sent = () => { try { return fs.readFileSync(SENT, 'utf8') } catch { return '' } }
const opsLog = () => { try { return fs.readFileSync(path.join(T, 'proj', '.run', 'logs', 'ops.log'), 'utf8') } catch { return '' } }
const to = (role) => sent().split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')

try {
  ok('wake starts', await until(() => /watching .* from seq (\d+)/.test(opsLog())))
  ok(`...from the board's head (seq ${HEAD}), past the first page of the journal`, new RegExp(`from seq ${HEAD} `).test(opsLog()))
  ok('the journal is read page by page (since 0, 500, ...)', reads.includes(0) && reads.includes(500))
  ok('an item whose last comment is a human\'s gets a start note', await until(() => /a-2 has an unanswered comment from alex[\s\S]*a-2: title of a-2/.test(to('platform'))))
  await sleep(1500)
  const p = to('platform')
  ok('an item whose last comment is its lead\'s own (past the first page) gets no start note', !/a-1/.test(p))
  ok('a comment by brain is never "unanswered from a human"', !/from brain/.test(sent()) && !/b-1/.test(sent()))
  ok(`the events missed while stopped are all replayed (${HEAD - SAVED}, more than a page): the late comment on a-3 is delivered`,
    /alex commented on a-3 \(quoted below\)[\s\S]*a-3: title of a-3\na-3 comment by alex: late question on a-3/.test(p) && new RegExp(`replayed ${HEAD - SAVED} event\\(s\\)`).test(opsLog()))
} finally {
  w.kill(); srv.close()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-25).join('\n')}\n${out.slice(-1500)}\n--- sent\n${sent().slice(-2500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
