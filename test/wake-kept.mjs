#!/usr/bin/env node
// bin/wake, a kept role (roles.json `keep`, the owner's contact) whose agent can't be found and then comes back
// (sy-ujtp, sy-mv69.1): wake starts no new agent and never asks the owner: no note item, no needs-you, no bd write at
// all. It says so once per gone spell: an error line (mm obs sees it) and, when the board's Lead is another role, one
// reason to the Lead ("... is yours"), with the items that wait. What a wake before sy-mv69.1 added (its note for the
// owner and the needs-you on P0/P1 items, kept in .run/wake-state.json `_kept`) is undone when the agent is back: the
// note closed (wake's own only; a refused close said once, never tried again), only wake's own labels removed, one at
// a time, a Dolt 1213 retried (the stub refuses the first label write once); a label a person removed, or set again,
// is not wake's.
// Hermetic: temp folder and MM_HOME, a fake board (bd serve's API, and a stub bin/bd that changes it), stub paseo and
// bin/lead, no obs.
//   node test/wake-kept.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { parseCard } = await import(path.join(SRC, 'template', 'bin', 'lib', 'owner-card.mjs'))
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-kept-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: [{ id: 'ops', keep: true, capacity: 4 }, { id: 'chat', keep: true }, { id: 'dev' }] }))
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\nowner_name: alex\nrestore:\n  hold: false\n')

// ---------- the fake board ----------
const items = new Map()
const add = (id, f = {}) => items.set(id, { id, title: `title of ${id}`, status: 'open', priority: 2, assignee: 'ops', labels: [], updated_at: new Date().toISOString(), ...f })
for (let n = 1; n <= 50; n++) add(`p-${n}`, { priority: 1 }) // 50 P1 items wait for ops
for (let n = 1; n <= 8; n++) add(`l-${n}`, { priority: 2 })
add('z-1', { priority: 0, status: 'in_progress' }) // a P0 in progress
add('c-1', { priority: 1, assignee: 'chat' }) // waits for chat (kept too, not the Lead)
// what a wake before sy-mv69.1 left: its note for the owner and needs-you on p-1..p-3 (in its state), and h-1's from a person
const OLD = new Date(Date.now() - 3600000).toISOString()
add('n-0', { title: "The ops lead's agent can't be found: 3 item(s) wait for it", assignee: 'alex', priority: 1, labels: ['needs-you', 'kept:ops'], created_by: 'wake' })
for (const id of ['p-1', 'p-2', 'p-3']) items.get(id).labels = ['needs-you']
add('h-1', { priority: 1, labels: ['needs-you'] }) // a person set needs-you: never wake's
const records = [], streams = []
let seq = 0, nextId = 1, busyOnce = true, labelsNow = 0, labelsMax = 0, closeRefused = 0
const emit = (op, id, actor, extra = {}) => { const e = { seq: ++seq, ts: new Date().toISOString(), op, issue_id: id, actor, issue: { ...items.get(id) }, ...extra }; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const change = (id, actor, f, op = 'update') => { Object.assign(items.get(id), f, { updated_at: new Date().toISOString() }); emit(op, id, actor) }
const label = (id, actor, l, on = true) => change(id, actor, { labels: on ? [...new Set([...items.get(id).labels, l])] : items.get(id).labels.filter((x) => x !== l) })
async function bdCli(args) {
  const actor = args[args.indexOf('--actor') + 1] || 'nobody', flag = (f) => { const k = args.indexOf(f); return k >= 0 ? args[k + 1] : undefined }
  const [cmd, a1, a2, a3] = args
  // bd's gate (sy-z5lz, sy-0omb): needs-you only with a valid owner card at the top of the description
  const noCard = (d, ls) => !parseCard(d || '', ls).ok
  if (cmd === 'create') {
    if ((flag('-l') || '').split(',').includes('needs-you') && noCard(flag('-d'), [])) return { code: 1, err: 'bd: refused: needs-you only with a valid owner card; (the new item): it has no owner card' }
    const id = `n-${nextId++}`
    items.set(id, { id, title: a1, description: flag('-d'), status: 'open', priority: Number(flag('-p')), assignee: flag('-a'), labels: (flag('-l') || '').split(',').filter(Boolean), created_by: actor, updated_at: new Date().toISOString() })
    emit('create', id, actor); return { code: 0, out: JSON.stringify({ id }) }
  }
  const i = items.get(cmd === 'label' ? a2 : a1)
  if (!i) return { code: 1, err: 'no such issue' }
  if (cmd === 'label') {
    labelsNow++; labelsMax = Math.max(labelsMax, labelsNow)
    await sleep(30)
    labelsNow--
    if (busyOnce) { busyOnce = false; return { code: 1, err: 'Error 1213 (40001): serialization failure: this transaction conflicts with a committed transaction from another client, try restarting transaction' } }
    if (a1 === 'add' && a3 === 'needs-you' && noCard(i.description, i.labels)) return { code: 1, err: `bd: refused: needs-you only with a valid owner card; ${i.id}: it has no owner card` }
    label(i.id, actor, a3, a1 === 'add'); return { code: 0 }
  }
  if (cmd === 'update') { const f = {}; if (flag('--title')) f.title = flag('--title'); if (flag('-d')) f.description = flag('-d'); if (flag('--body-file')) f.description = fs.readFileSync(flag('--body-file'), 'utf8'); if (flag('-s')) f.status = flag('-s'); change(i.id, actor, f); return { code: 0 } }
  if (cmd === 'close') {
    // bd's guard: an item assigned to someone else closes only with --force; a 'locked' one never (a stand-in for any refusal)
    if (i.locked) { closeRefused++; return { code: 1, err: `cannot close ${i.id}: it is locked` } }
    if (i.assignee && i.assignee !== actor && !args.includes('--force')) { closeRefused++; return { code: 1, err: `cannot close ${i.id}: assignee is ${i.assignee}, actor is ${actor}; reclaim or use --force` } }
    change(i.id, actor, { status: 'closed', close_reason: flag('--reason') }, 'close'); return { code: 0 }
  }
  if (cmd === 'comments' && a1 === 'add') { emit('comment', i.id, actor, { comment: { id: `c${seq + 1}`, author: actor, text: a3 } }); return { code: 0 } }
  return { code: 1, err: `stub bd: ${cmd}?` }
}
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [...items.values()].filter((i) => i.status === 'open').sort((a, b) => a.priority - b.priority) })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json(items.get(decodeURIComponent(m[1]))) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  if (u.pathname === '/stub-bd') { let body = ''; for await (const c of req) body += c; return json(await bdCli(JSON.parse(body))) }
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`

const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/usr/bin/env node
const fs = require('node:fs'); const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(BDLOG)}, a.map((x) => x.replace(/\\n/g, ' ')).join(' ') + '\\n')
fetch(${JSON.stringify(`${BD}/stub-bd`)}, { method: 'POST', body: JSON.stringify(a) }).then((r) => r.json()).then((r) => { if (r.out) console.log(r.out); if (r.err) console.error(r.err); process.exit(r.code) })
`, { mode: 0o755 })
const STARTED = path.join(T, 'started.txt')
fs.writeFileSync(path.join(PROJ, 'bin', 'lead'), `#!/bin/sh\necho "START $2" >>"${STARTED}"\n`, { mode: 0o755 })
const st = (r, s) => fs.writeFileSync(path.join(T, `${r}.status`), s)
st('ops', 'none'); st('chat', 'none'); st('dev', 'idle')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ops chat dev; do case "$*" in *role=$r\\ *|*role=$r) s=$(cat ${T}/$r.status); [ "$s" = none ] && { echo '[]'; exit 0; }
        echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"$s\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${T}/sent.txt"; shift; done; exit 0 ;;
esac
`, { mode: 0o755 })

const env = { ...process.env, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wk', MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '700', WAKE_RESUME_MS: '1000', WAKE_IDLE_CLOSE_MS: '0', WAKE_SOON_MS: '200',
  WAKE_RETRY_MS: '100', WAKE_LABEL_GAP_MS: '20' }
delete env.MM_SERVICE; delete env.WAKE_CAP
fs.mkdirSync(path.join(PROJ, '.run'), { recursive: true })
fs.writeFileSync(path.join(PROJ, '.run', 'wake-state.json'), JSON.stringify({ _kept: { ops: { note: 'n-0', n: 3, labelled: { 'p-1': OLD, 'p-2': OLD, 'p-3': OLD } } } }))
let w, out = ''
const start = () => { w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)) }
const stop = async () => { w.kill(); await new Promise((r) => (w.exitCode !== null ? r() : w.on('exit', r))) }
const bdlog = () => read(BDLOG), log = () => read(path.join(PROJ, '.run', 'logs', 'ops.log'))
const wstate = () => { try { return JSON.parse(read(path.join(PROJ, '.run', 'wake-state.json'))) } catch { return {} } }
const I = (id) => items.get(id), has = (id) => I(id).labels.includes('needs-you')
const sent = () => read(path.join(T, 'sent.txt'))
const errs = (re) => log().split('\n').filter((l) => /"level":"error"/.test(l) && re.test(l)).length
const writes = () => bdlog().split('\n').filter((l) => /^(create|update|label|comments|close) /.test(l))

try {
  start()
  await until(() => /watching/.test(log()))
  console.log('== ops (kept, the Lead) and chat (kept) have no agent; 60 items wait for ops, one for chat')
  ok('ops: one error line, naming what waits, that no owner is asked', await until(() => errs(/ops is kept \(the owner's contact\) and its agent can't be found \(no agent has its labels\): 60 item\(s\) wait \(p-/) === 1)
    && errs(/ops is kept[^\n]*asks no owner/) === 1)
  ok('chat: its error line says the Lead (ops) is told', await until(() => errs(/chat is kept [^\n]*1 item\(s\) wait \(c-1\)[^\n]*the Lead \(ops\) is told/) === 1))
  await sleep(2500)
  ok('...each once, not on every pass', errs(/ops is kept/) === 1 && errs(/chat is kept/) === 1)
  ok('no note item, no needs-you, no card: no bd write at all', writes().length === 0 && !items.has('n-1'))
  ok('...the needs-you from before stay as they are while the agent is gone', ['p-1', 'p-2', 'p-3', 'h-1'].every(has) && I('n-0').status === 'open')
  ok('neither kept role is started', !read(STARTED))

  console.log('== wake restarts while the agents are still gone')
  await stop()
  start()
  await until(() => (log().match(/watching/g) || []).length === 2)
  await sleep(2500)
  ok('it says it once more (a new spell for this wake), still writes nothing', errs(/ops is kept/) === 2 && writes().length === 0)
  ok('...the state from before is kept (3 labels of wake\'s)', Object.keys(wstate()._kept?.ops?.labelled || {}).length === 3)
  label('p-2', 'alex', 'needs-you', false) // alex has seen it: no longer wake's
  label('p-3', 'alex', 'needs-you', false); await sleep(50); label('p-3', 'dev', 'needs-you') // dev sets it again: dev's now
  ok('wake forgets the labels a person removed', await until(() => !wstate()._kept?.ops?.labelled?.['p-2'] && !wstate()._kept?.ops?.labelled?.['p-3']))

  console.log('== ops is back')
  // review sy-71up: an item a person made, with wake's label, is never closed by wake; one whose close is refused is
  // said once and never tried again
  add('x-1', { title: "The ops lead's agent can't be found: a person's copy", assignee: 'alex', labels: ['kept:ops'], created_by: 'alex' }); emit('create', 'x-1', 'alex')
  add('x-2', { title: "The ops lead's agent can't be found: locked", assignee: 'alex', labels: ['kept:ops'], created_by: 'wake', locked: true }); emit('create', 'x-2', 'wake')
  st('ops', 'idle')
  ok('the old note (wake\'s, from before) is closed, by wake, with --force', await until(() => I('n-0').status === 'closed') && /found again/.test(I('n-0').close_reason || '') && /^close n-0 --force /m.test(bdlog()))
  ok('wake\'s own old needs-you (p-1) is removed, the 1213 tried again', await until(() => !has('p-1')) && /unlabel p-1: the board was busy \(Error 1213/.test(log()))
  ok('...one at a time', labelsMax === 1)
  ok('h-1 (a person) keeps its needs-you', has('h-1') && !/label remove h-1 /.test(bdlog()))
  ok('p-3 (set again by dev, a lead) keeps its needs-you', has('p-3') && !/label remove p-3 /.test(bdlog()))
  ok('p-2 (removed by the person) is not written', !/label \S+ p-2 /.test(bdlog().replace(/^label remove p-2 needs-you --actor alex$/gm, '')))
  ok('the state forgets ops', await until(() => !wstate()._kept?.ops))
  ok('a person\'s item with the kept:ops label is never closed', I('x-1').status !== 'closed' && !/^close x-1 /m.test(bdlog()))
  ok('a refused close is said once, as left for the owner', await until(() => (log().match(/closing x-2 was refused: left for the owner, not tried again/g) || []).length === 1))
  ok('the Lead (ops), back, is told of chat, once: "This is yours", the item that waits, no needs-you',
    await until(() => /- The chat lead's agent can't be found \(no agent has its labels\), and 1 item\(s\) wait for it: c-1\. This is yours[^\n]*Only you ask the owner/.test(sent())))
  const after = bdlog()
  await sleep(2000)
  ok('then quiet: no more writes, the chat line not sent again', bdlog() === after && (sent().match(/The chat lead's agent can't be found/g) || []).length === 1)
  ok('in all of it, wake added needs-you nowhere and opened no item', !/^label add \S+ needs-you --actor wake/m.test(bdlog()) && !/^create /m.test(bdlog()))
  console.log('== chat is back, and gone again: a new spell is said again')
  st('chat', 'idle')
  ok('chat back: logged', await until(() => /chat's agent is back \(chat\)/.test(log())))
  st('chat', 'none'); add('c-4', { priority: 1, assignee: 'chat' }); emit('create', 'c-4', 'alex') // gone again, and new work waits
  ok('...gone again: said again', await until(() => (sent().match(/The chat lead's agent can't be found/g) || []).length === 2))
} finally {
  w?.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${log().split('\n').slice(-40).join('\n')}\n${out.slice(-1500)}\n--- bd\n${bdlog().slice(-1500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
