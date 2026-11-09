#!/usr/bin/env node
// bin/wake never acts again on an event it handled (sy-3r6u). Its cursor (.wake-state.json `_cursor`: seq, ts and the
// keys of the last events) is written after each event: a restart replays nothing it handled, a journal that bd serve
// numbers anew (a re-read: the same events, new seqs) acts on nothing old, and with no cursor wake starts at the head.
// An event older than the item's state now (its updated_at) acts on nothing: an old "blocked" for an item that is
// deferred now. A block is routed on the item as it is now: an upstream:* label added in the same change, missing from
// the event, still means "nobody woken". A fresh event still works, and a lead's Board update holds only new events.
// Hermetic: temp folder, stub paseo, bd and bd-serve, no obs.
//   node test/wake-replay.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-replay-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(150) } return false }

const ROLES = ['ops', 'dev', 'review']
const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: ROLES.map((id) => ({ id })) }))
fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${BDLOG}"\n`, { mode: 0o755 })
const SENT = path.join(T, 'sent.txt')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"idle\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })

// the board: items (each change moves updated_at) and its journal (each change one event, with the item's snapshot)
let clock = Date.now() - 6 * 3600000 // the board's history starts six hours ago
const tick = (ms = 1000) => new Date((clock += ms)).toISOString()
const items = new Map(), records = [], streams = []
let base = 0 // bd serve's numbering: a re-read journal is numbered from here
const push = (e) => { const r = { ...e, seq: base + records.length + 1 }; records.push(r); for (const s of streams) s.write(`data: ${JSON.stringify(r)}\n\n`); return r }
function change(id, actor, f, op = 'update', snapOverride = null) {
  const at = tick()
  const i = { id, title: `title of ${id}`, status: 'open', assignee: 'dev', labels: [], ...(items.get(id) || {}), ...f, updated_at: at }
  items.set(id, i)
  return push({ ts: at, op, issue_id: id, actor, issue: { ...i, ...(snapOverride || {}) } })
}
function comment(id, author, text) {
  const at = tick()
  return push({ ts: at, op: 'comment', issue_id: id, actor: author, issue: { ...items.get(id) }, comment: { id: `c${records.length + 1}`, author, text } })
}
// the history before wake ever ran
change('o-1', 'alex', { status: 'in_progress' }, 'create')
change('o-2', 'alex', {}, 'create')
change('o-3', 'alex', {}, 'create')
comment('o-1', 'alex', 'an old question on o-1')
change('o-2', 'dev', { status: 'blocked' })              // o-2 was blocked hours ago...
change('o-2', 'alex', { status: 'deferred' })            // ...and is deferred now
comment('o-3', 'alex', 'an old question on o-3')

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    const since = Number(u.searchParams.get('since') || 0)
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    for (const r of records) if (r.seq > since) res.write(`data: ${JSON.stringify(r)}\n\n`)
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1))
    return
  }
  if (u.pathname === '/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0), limit = Math.min(Number(u.searchParams.get('limit') || 500), 500)
    return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since).slice(0, limit) })
  }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json({ ...items.get(decodeURIComponent(m[1])), comments: [] }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wy',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '400', WAKE_STALL_MS: '600', WAKE_RESUME_CHECK_MS: '600000',
  WAKE_LEASE_MS: '86400000', WAKE_SETTLE_MS: '300', WAKE_IDLE_CLOSE_MS: '0' }
delete env.MM_SERVICE
let w = null, out = ''
const start = () => { w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)) }
const stop = async () => { if (w && w.exitCode === null) { w.kill(); await new Promise((r) => w.once('exit', r)) } }
const sent = () => { try { return fs.readFileSync(SENT, 'utf8') } catch { return '' } }
const opsLog = () => { try { return fs.readFileSync(path.join(PROJ, '.run', 'logs', 'ops.log'), 'utf8') } catch { return '' } }
const updates = () => sent().split('----\n').filter(Boolean)
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(PROJ, '.wake-state.json'), 'utf8')) } catch { return {} } }
const starts = () => (opsLog().match(/wake for wy: watching/g) || []).length
const quiet = async (ms = 2500) => { const n = sent().length; await sleep(ms); return sent().length === n }

try {
  console.log('== the first start, with no cursor: from the head, nothing old')
  start()
  ok('wake starts at the journal\'s head', await until(() => /no cursor: starting at the journal's head \(seq 7\)/.test(opsLog()) && starts() === 1))
  ok('...and writes its cursor (seq, ts, keys)', await until(() => state()._cursor?.seq === 7 && state()._cursor.ts === Date.parse(records.at(-1).ts) && state()._cursor.keys.length > 0))
  ok('...no lead is told of anything old (no "unanswered comment", no o-1, o-2, o-3)', await quiet() && !/o-[123]/.test(sent()))

  console.log('== a fresh event still works')
  clock = Date.now()
  comment('o-1', 'alex', 'a new question on o-1')
  ok('a new human comment reaches the board\'s Lead', await until(() => /a new question on o-1/.test(sent())))
  ok('...in an update that holds only it (not the old question)', !/an old question/.test(sent()))
  change('n-1', 'alex', {}, 'create'); change('n-1', 'dev', { status: 'blocked' })
  ok('a fresh block (dev, no RACI) wakes the board\'s Lead', await until(() => /BLOCKED: dev set n-1 to blocked/.test(sent())))
  ok('the cursor follows (seq 10)', await until(() => state()._cursor?.seq === 10 && state()._seq === 10))

  console.log('== a restart replays nothing it handled')
  await stop(); const before = sent().length
  start()
  ok('wake starts again', await until(() => starts() === 2))
  ok('...replays nothing (no "replayed")', await quiet() && !/replayed \d+ event/.test(opsLog().split('wake for wy: watching')[1] || ''))
  ok('...and tells no lead anything again', sent().length === before)

  console.log('== events while stopped: replayed, but only what is still true')
  await stop()
  change('n-2', 'alex', {}, 'create')
  change('n-2', 'dev', { status: 'blocked' })              // blocked while wake was down...
  change('n-2', 'alex', { status: 'deferred' })            // ...and deferred before it starts
  const n0 = updates().length
  start()
  ok('wake replays the events after its cursor', await until(() => /replayed 3 event\(s\) from seq 10/.test(opsLog())))
  ok('...an old "blocked" for an item that is deferred now does nothing', await quiet() && !/BLOCKED: dev set n-2/.test(sent()) && !/n-2.*needs-you/.test(fs.existsSync(BDLOG) ? fs.readFileSync(BDLOG, 'utf8') : ''))
  ok('...and no lead update repeats an old event', updates().slice(n0).every((m) => !/o-1|o-2|o-3|n-1/.test(m)))

  console.log('== a re-read journal (bd serve numbers it anew): nothing old acted on')
  const n1 = updates().length, old = records.splice(0), shift = 1000
  base = shift
  for (const r of old) push({ ...r, seq: undefined }) // the same events, seqs 1001.. (the stream sends them too)
  await sleep(2500)
  ok('the re-numbered events are passed over (logged)', /passed over an old event/.test(opsLog()))
  ok('...no lead is told again', updates().length === n1)
  clock = Date.now() + 5000
  comment('o-3', 'alex', 'a newer question on o-3')
  ok('a fresh event after the re-read still works, alone in its update', await until(() => updates().length > n1 && /a newer question on o-3/.test(updates().at(-1))) && !/old question/.test(updates().slice(n1).join('')))

  console.log('== a re-read numbered lower (head behind wake\'s place): read again, nothing old acted on')
  const n2 = updates().length, again = records.splice(0)
  base = 0
  for (const r of again) push({ ...r, seq: undefined })
  ok('wake sees the head behind its place and reads the journal again', await until(() => /journal head \(seq \d+\) is behind wake's place/.test(opsLog())))
  await sleep(1500)
  ok('...no lead is told again', updates().length === n2)
  clock = Date.now() + 10000
  change('n-4', 'alex', {}, 'create'); change('n-4', 'dev', { status: 'blocked' })
  ok('...and a fresh block after it still wakes the Lead', await until(() => /BLOCKED: dev set n-4 to blocked/.test(sent())))

  console.log('== an upstream label added in the same change as the block, missing from the event')
  // the event's labels are older than its status: the item has upstream:engine now
  change('u-1', 'alex', {}, 'create')
  await until(() => /alex created u-1/.test(sent())); await sleep(500)
  const nu = updates().length
  change('u-1', 'dev', { status: 'blocked', labels: ['upstream:engine'] }, 'update', { labels: [] })
  ok('nobody is woken (it waits on the system board), logged', await until(() => /BLOCKED on u-1 by dev: upstream:engine: waits on the system board/.test(opsLog())))
  ok('...no BLOCKED to the Lead, no needs-you', await quiet(1500) && !/u-1/.test(updates().slice(nu).join('')) && !/u-1 needs-you/.test(fs.existsSync(BDLOG) ? fs.readFileSync(BDLOG, 'utf8') : ''))

  console.log('== an old snapshot arriving live (the item changed since): nothing')
  const n3 = updates().length
  const cur = items.get('n-4')
  change('n-4', 'alex', { status: 'deferred' })
  push({ ts: tick(), op: 'update', issue_id: 'n-4', actor: 'review', issue: { ...cur, status: 'blocked', assignee: 'review' } }) // its snapshot is cur's revision
  ok('an event whose snapshot is older than the item now acts on nothing (no handoff, no block)', await quiet() && !/n-4/.test(updates().slice(n3).join('')))
} finally {
  await stop(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-40).join('\n')}\n${out.slice(-2000)}\n--- sent\n${sent().slice(-3000)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
