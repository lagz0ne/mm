#!/usr/bin/env node
// bin/wake, a kept role (roles.json `keep`, the owner's contact) whose agent can't be found and then comes back
// (sy-ujtp): one note item for the owner (assigned to mm's owner_name, needs-you, kept:<role>; its count follows the
// board), needs-you only on the P0/P1 items that wait, written one at a time (never two at once) with a Dolt 1213
// retried (the stub refuses the first label write once); wake remembers its labels in .wake-state.json, also over a
// restart; a label someone removes is never written again and is no longer wake's; when the agent is back, the note
// is closed and only wake's own labels are removed: one a person or a lead set stays.
// Hermetic: temp folder and MM_HOME, a fake board (bd serve's API, and a stub bin/bd that changes it), stub paseo and
// bin/lead, no obs.
//   node test/wake-kept.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-kept-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: [{ id: 'ops', keep: true, capacity: 4 }, { id: 'dev' }] }))
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
fs.writeFileSync(path.join(MMH, 'config.yaml'), 'layout: one-root\nowner_name: alex\nrestore:\n  hold: false\n')

// ---------- the fake board ----------
const items = new Map()
const add = (id, f = {}) => items.set(id, { id, title: `title of ${id}`, status: 'open', priority: 2, assignee: 'ops', labels: [], updated_at: new Date().toISOString(), ...f })
for (let n = 1; n <= 50; n++) add(`p-${n}`, { priority: 1 }) // 50 P1 items wait for ops: labelled
for (let n = 1; n <= 8; n++) add(`l-${n}`, { priority: 2 }) // P2: counted, not labelled
add('z-1', { priority: 0, status: 'in_progress' }) // a P0 in progress: labelled
add('h-1', { priority: 1, labels: ['needs-you'] }) // a person set needs-you before: never wake's
const records = [], streams = []
let seq = 0, nextId = 1, busyOnce = true, labelsNow = 0, labelsMax = 0, closeRefused = 0
const emit = (op, id, actor, extra = {}) => { const e = { seq: ++seq, ts: new Date().toISOString(), op, issue_id: id, actor, issue: { ...items.get(id) }, ...extra }; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const change = (id, actor, f, op = 'update') => { Object.assign(items.get(id), f, { updated_at: new Date().toISOString() }); emit(op, id, actor) }
const label = (id, actor, l, on = true) => change(id, actor, { labels: on ? [...new Set([...items.get(id).labels, l])] : items.get(id).labels.filter((x) => x !== l) })
async function bdCli(args) {
  const actor = args[args.indexOf('--actor') + 1] || 'nobody', flag = (f) => { const k = args.indexOf(f); return k >= 0 ? args[k + 1] : undefined }
  const [cmd, a1, a2, a3] = args
  if (cmd === 'create') {
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
    label(i.id, actor, a3, a1 === 'add'); return { code: 0 }
  }
  if (cmd === 'update') { const f = {}; if (flag('--title')) f.title = flag('--title'); if (flag('-d')) f.description = flag('-d'); if (flag('-s')) f.status = flag('-s'); change(i.id, actor, f); return { code: 0 } }
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
st('ops', 'none'); st('dev', 'idle')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ops dev; do case "$*" in *role=$r\\ *|*role=$r) s=$(cat ${T}/$r.status); [ "$s" = none ] && { echo '[]'; exit 0; }
        echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"$s\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) exit 0 ;;
esac
`, { mode: 0o755 })

const env = { ...process.env, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wk', MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '700', WAKE_RESUME_MS: '1000', WAKE_IDLE_CLOSE_MS: '0', WAKE_SOON_MS: '200',
  WAKE_RETRY_MS: '100', WAKE_LABEL_GAP_MS: '20' }
delete env.MM_SERVICE; delete env.WAKE_CAP
let w, out = ''
const start = () => { w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)) }
const stop = async () => { w.kill(); await new Promise((r) => (w.exitCode !== null ? r() : w.on('exit', r))) }
const bdlog = () => read(BDLOG), log = () => read(path.join(PROJ, '.run', 'logs', 'ops.log'))
const wstate = () => { try { return JSON.parse(read(path.join(PROJ, '.wake-state.json'))) } catch { return {} } }
const I = (id) => items.get(id), has = (id) => I(id).labels.includes('needs-you')
const adds = () => (bdlog().match(/^label add \S+ needs-you --actor wake$/gm) || []).length
const notes = () => [...items.values()].filter((i) => i.labels.includes('kept:ops'))
const P01 = [...Array.from({ length: 50 }, (_, n) => `p-${n + 1}`), 'z-1']

try {
  start()
  await until(() => /watching/.test(log()))
  console.log('== ops (kept) has no agent and 60 items wait')
  ok('one note is opened for the owner', await until(() => notes().length === 1))
  const n = notes()[0] || { labels: [] }
  ok('...assigned to the owner (owner_name alex), P1, labelled needs-you', n.assignee === 'alex' && n.priority === 1 && n.labels.includes('needs-you'))
  ok('...its title counts what waits (60 items)', /^The ops lead's agent can't be found: 60 item\(s\) wait for it$/.test(n.title || ''))
  ok('...its text says why wake starts none, and what to do', /kept role/.test(n.description || '') && /role=ops/.test(n.description || ''))
  ok('all 51 P0/P1 items are labelled needs-you, with no failure', await until(() => P01.every(has)) && !/label \S+ failed/.test(log()))
  ok('...the 1213 was tried again (logged)', /label p-\d+: the board was busy \(Error 1213/.test(log()))
  ok('...one at a time (never two label writes at once)', labelsMax === 1)
  ok('...51 writes and the one retry, no more', adds() === 52)
  ok('the P2 items are not labelled', [1, 2, 3, 4, 5, 6, 7, 8].every((k) => !has(`l-${k}`)))
  ok('h-1 (needs-you from a person) is not written again', !/label add h-1 /.test(bdlog()))
  ok('wake remembers its 51 labels in .wake-state.json', await until(() => Object.keys(wstate()._kept?.ops?.labelled || {}).length === 51) && !wstate()._kept.ops.labelled['h-1'])
  ok('the note lists the items (40 at most), the labelled ones marked', /p-1 \(P1, open, labelled needs-you by wake\)/.test(I(n.id)?.description || '')  && /- \.\.\. and 20 more/.test(I(n.id)?.description || ''))
  ok('ops is never started', !read(STARTED))

  console.log('== the note follows the board; a person removes a label')
  add('l-9'); emit('create', 'l-9', 'alex')
  ok('a new item: the note says 61 (the same note)', await until(() => /: 61 item\(s\) wait/.test(I(n.id).title)) && notes().length === 1)
  label('p-2', 'alex', 'needs-you', false) // alex has seen it
  label('p-3', 'alex', 'needs-you', false); await sleep(50); label('p-3', 'dev', 'needs-you') // dev sets it again: dev's now
  ok('wake forgets the labels a person removed', await until(() => !wstate()._kept?.ops?.labelled?.['p-2'] && !wstate()._kept?.ops?.labelled?.['p-3']))
  await sleep(1500)
  ok('...and never writes p-2 again', !has('p-2') && (bdlog().match(/^label add p-2 /gm) || []).length === 1)

  console.log('== wake restarts while the agent is still gone')
  await stop()
  const before = adds()
  start()
  await until(() => (log().match(/watching/g) || []).length === 2)
  await sleep(2500)
  ok('no label is written again, and no second note', adds() === before && [...items.values()].filter((i) => /can't be found/.test(i.title)).length === 1)
  ok('...the state still has its labels (49: p-2, p-3 left)', Object.keys(wstate()._kept?.ops?.labelled || {}).length === 49)

  console.log('== the agent is back')
  // review sy-71up: an item a person made, with wake's label, is never closed by wake; one whose close is refused is
  // said once and never tried again
  add('x-1', { title: "The ops lead's agent can't be found: a person's copy", assignee: 'alex', labels: ['kept:ops'], created_by: 'alex' }); emit('create', 'x-1', 'alex')
  add('x-2', { title: "The ops lead's agent can't be found: locked", assignee: 'alex', labels: ['kept:ops'], created_by: 'wake', locked: true }); emit('create', 'x-2', 'wake')
  st('ops', 'idle')
  ok('the note is closed, by wake', await until(() => I(n.id).status === 'closed') && /found again/.test(I(n.id).close_reason || ''))
  ok('every needs-you wake added is removed', await until(() => P01.filter((id) => !['p-2', 'p-3'].includes(id)).every((id) => !has(id))))
  ok('...one at a time', labelsMax === 1)
  ok('h-1 (a person) keeps its needs-you', has('h-1') && !/label remove h-1 /.test(bdlog()))
  ok('p-3 (set again by dev, a lead) keeps its needs-you', has('p-3') && !/label remove p-3 /.test(bdlog()))
  ok('p-2 (removed by the person) is not written', !/label remove p-2 /.test(bdlog()))
  ok('the state forgets ops', await until(() => !wstate()._kept?.ops))
  const after = bdlog()
  await sleep(2000)
  ok('then quiet: no more writes', bdlog() === after)
  ok('the note (assigned to the owner) closed with --force, wake\'s own', /^close n-\d+ --force /m.test(bdlog()))
  ok('a person\'s item with the kept:ops label is never closed', I('x-1').status !== 'closed' && !/^close x-1 /m.test(bdlog()))
  const tries = (bdlog().match(/^close x-2 /gm) || []).length
  ok('a refused close is said once, as left for the owner', (log().match(/closing x-2 was refused: left for the owner, not tried again/g) || []).length === 1)
  // the agent goes and comes back: a new note cycle, which closes its new note and leaves x-2 alone
  st('ops', 'none'); await until(() => notes().some((x) => x.status !== 'closed' && x.id !== 'x-2' && x.created_by === 'wake')); st('ops', 'idle')
  await until(() => !notes().some((x) => x.status !== 'closed' && x.id !== 'x-2' && x.created_by === 'wake')); await sleep(1500)
  ok('...and never tried again (one bd step, its own retries only)', tries >= 1 && tries <= 3 && (bdlog().match(/^close x-2 /gm) || []).length === tries)
} finally {
  w?.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${log().split('\n').slice(-40).join('\n')}\n${out.slice(-1500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
