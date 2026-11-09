#!/usr/bin/env node
// bin/wake's hop limit counts only lead-to-lead wakes with no progress in between (sy-ydoe): a turn that moves the item
// (a new Head in a valid message, a new signed-head: label, a new artifact, a closed child, the status, a third role)
// makes the next wake hop 1 again; turns with nothing new pause it, as before (sy-0omb).
//   - 5 turns, each a HANDOFF with a new Head: never paused;
//   - HANDOFF (head) → VERDICT on it with its signed-head: label → HANDOFF (next head) → ...: never paused;
//   - turns with the same Head and nothing else new: paused on the 4th;
//   - the ping-pong between two roles is no progress, a third role is; a new artifact and a closed child are.
// Hermetic: temp folder, stub paseo, stub bin/bd (logs only), a small fake bd-serve.
//   node test/wake-hops.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-hops-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

const ROLES = ['ops', 'review', 'platform']
const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: ROLES.map((id) => ({ id })) }))
fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
const SENT = path.join(T, 'sent.txt'), BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"idle\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(BDLOG)}\n`, { mode: 0o755 })

const now = () => new Date().toISOString()
const items = new Map()
const add = (id, f) => items.set(id, { id, title: `title of ${id}`, status: 'open', assignee: 'platform', labels: [], description: '', updated_at: now(), ...f })
for (const id of ['n-1', 'n-2', 's-1', 'r-1', 'a-1', 'c-1']) add(id)
add('c-1.1', { status: 'in_progress', assignee: 'ops' })
const records = [], streams = []
let seq = 0, n = 0
const emit = (e) => { e.seq = ++seq; e.ts = now(); records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const change = (id, actor, f) => { const i = items.get(id); Object.assign(i, f, { updated_at: now() }); emit({ op: 'update', issue_id: id, actor, issue: { ...i } }) }
const comment = (id, author, text) => emit({ op: 'comment', issue_id: id, actor: author, issue: { ...items.get(id) }, comment: { id: `c${++n}`, author, text } })
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json({ comments: [], ...items.get(decodeURIComponent(m[1])) }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wh',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '600000', WAKE_LABEL_GAP_MS: '20' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const sent = () => read(SENT), bdlog = () => read(BDLOG), opsLog = () => read(path.join(PROJ, '.run', 'logs', 'ops.log'))
const to = (role) => sent().split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')
const times = (role, re) => (to(role).match(re) || []).length
const paused = (id) => new RegExp(`label add ${id.replace('.', '\\.')} paused`).test(bdlog())

const HO = (next, h) => `HANDOFF → ${next}\nHead: mm@${h}\nExpect: ${next}: verify this head.\nDone when: a VERDICT on mm@${h}.\nVerify: bd show x → labels include signed-head:mm@${h}\nBy: next wake · Else: nothing rolls out\nReady: the change and its tests\nSurfaces: none`
const VE = (h) => `VERDICT → platform\nResult: signed off\nHead: mm@${h}\nExpect: platform: land this head.\nDone when: the head is on main.\nVerify: git log main → mm@${h}\nBy: next wake · Else: it waits`
const HEADS = ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd', 'eeeeeee', 'fffffff']
/** One turn: `from` does `before` (comments, labels), then hands the item to `next`; resolves once `next` was woken. */
async function turn(id, from, next, before = () => {}) {
  const re = new RegExp(`on ${id.replace('.', '\\.')}`, 'g'), had = times(next, re)
  before()
  change(id, from, { assignee: next, status: 'open' })
  return until(() => times(next, re) > had, 8000)
}
const pair = (i) => (i % 2 ? ['review', 'platform'] : ['platform', 'review'])

try {
  await until(() => /watching/.test(opsLog()))

  console.log('== 5 turns, each a HANDOFF with a new Head: never paused')
  let all = true
  for (let i = 0; i < 5; i++) { const [from, next] = pair(i); all = (await turn('n-1', from, next, () => comment('n-1', from, HO(next, HEADS[i])))) && all }
  ok('every turn wakes the next lead', all)
  await sleep(1000)
  ok('...and n-1 is never paused', !paused('n-1') && !/PAUSED: n-1/.test(to('ops')))

  console.log('== HANDOFF (head) → VERDICT with its signed-head: label → HANDOFF (next head) → ...: never paused')
  all = true
  for (let i = 0; i < 5; i++) {
    const h = HEADS[Math.floor(i / 2)]
    all = (await (i % 2
      ? turn('r-1', 'review', 'platform', () => { change('r-1', 'review', { labels: [...items.get('r-1').labels, `signed-head:mm@${h}`] }); comment('r-1', 'review', VE(h)) })
      : turn('r-1', 'platform', 'review', () => comment('r-1', 'platform', HO('review', h))))) && all
  }
  ok('every turn wakes the next lead', all)
  await sleep(1000)
  ok('...and r-1 is never paused', !paused('r-1'))

  console.log('== the same Head and nothing else new: paused on the 4th turn')
  for (let i = 0; i < 3; i++) { const [from, next] = pair(i); await turn('s-1', from, next, () => comment('s-1', from, HO(next, 'abcdef1'))) }
  const had = times('platform', /on s-1/g)
  comment('s-1', 'review', HO('platform', 'abcdef1')); change('s-1', 'review', { assignee: 'platform', status: 'open' })
  ok('s-1 is labelled paused', await until(() => paused('s-1')))
  ok('...the board\'s Lead (ops) gets it', await until(() => /PAUSED: s-1 had 3 lead-to-lead wakes/.test(to('ops'))))
  await sleep(1500); ok('...and the 4th wake is not sent', times('platform', /on s-1/g) === had)

  console.log('== the ping-pong between two roles is no progress; a third role is')
  for (let i = 0; i < 3; i++) { const [from, next] = pair(i); await turn('n-2', from, next) }
  ok('a 4th turn to a third role (ops) is sent', await turn('n-2', 'review', 'ops'))
  ok('...and n-2 is not paused', !paused('n-2'))

  console.log('== a new artifact and a closed child are progress')
  for (let i = 0; i < 3; i++) { const [from, next] = pair(i); await turn('a-1', from, next) }
  ok('a 4th turn that quotes a new artifact is sent', await turn('a-1', 'review', 'platform', () => comment('a-1', 'review', 'NOTE → platform\nThe run: artifacts/a-1/run.txt')))
  ok('...and a-1 is not paused', !paused('a-1'))
  for (let i = 0; i < 3; i++) { const [from, next] = pair(i); await turn('c-1', from, next) }
  change('c-1.1', 'ops', { status: 'closed' })
  ok('a 4th turn after its child c-1.1 closed is sent', await turn('c-1', 'review', 'platform'))
  ok('...and c-1 is not paused', !paused('c-1'))
  for (let i = 0; i < 3; i++) await turn('c-1', ...pair(i))
  ok('...and turns with nothing new after that pause it again', await until(() => paused('c-1')))

  const errs = opsLog().split('\n').filter((l) => /"level":"error"/.test(l))
  ok('no errors logged', errs.length === 0)
} finally {
  w.kill(); srv.close(); for (const s of streams) s.end()
  if (fail) console.log(out.slice(-3000))
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
