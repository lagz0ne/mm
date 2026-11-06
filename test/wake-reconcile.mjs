#!/usr/bin/env node
// bin/wake as the pull model's dispatcher, a reconcile loop (plans/slp shapes 5 and 6; sy-5582): the board is the queue
// (bd ready --assignee <role>), a lead pulls with bd update <id> --claim, up to its role's capacity (roles.json) inside
// the project's cap (wake.cap in mm's config.yaml). Proves: a ready item -> the lead is started with the queue head and
// claims it; two ready items, capacity 1 -> the second waits; closing one releases the capacity; an expired claim is
// requeued through bd's compare-and-set guard (exit 13: left alone; a lead in a turn keeps its claim; the 3rd expiry ->
// needs-you); a reassign lands in review's queue; wake killed in the middle of a handoff and started again: the item
// lands; a failed start is retried with backoff and after 3 tries -> needs-you; the project cap holds a start.
// Hermetic: temp folder and MM_HOME, a fake board (bd serve's API, and a stub bin/bd that changes it, with the guards),
// stub paseo and bin/lead, no obs.
//   node test/wake-reconcile.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-reconcile-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const ROLES = ['dev', 'qa', 'review', 'arch', 'sec', 'ux']
const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true }); fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ roles: ROLES.map((id) => ({ id, ...(id === 'qa' ? { capacity: 2 } : {}) })) }))
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
const config = (cap) => fs.writeFileSync(path.join(MMH, 'config.yaml'), `layout: one-root\nrestore:\n  hold: false\n${cap ? `wake:\n  cap: "${cap}"\n` : ''}`)
config(0)
// wake's state from an earlier run: q-3 expired twice already
fs.writeFileSync(path.join(PROJ, '.wake-state.json'), JSON.stringify({ _expiries: { 'q-3': 2 } }))

// ---------- the fake board ----------
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const items = new Map()
const add = (id, assignee, f = {}) => items.set(id, { id, title: `title of ${id}`, status: 'open', priority: 2, assignee, labels: [], updated_at: ago(0), ...f })
add('d-1', 'dev', { priority: 1 }); add('d-2', 'dev', { priority: 2 })
add('q-1', 'qa', { status: 'in_progress', updated_at: ago(120) }) // expired: requeued
add('q-2', 'qa', { status: 'in_progress', updated_at: ago(120) }) // expired, but someone moves it first: the guard says 13
add('q-3', 'qa', { status: 'in_progress', updated_at: ago(120) }) // its 3rd expiry
add('r-1', 'arch', { status: 'in_progress', updated_at: ago(120) }) // arch's lead is in a turn: kept
add('a-1', 'arch', { status: 'in_progress' }); add('k-1', 'arch', { status: 'in_progress', priority: 1 })
add('s-1', 'sec', { priority: 1 })
const race = new Set(['q-2'])
const records = [], streams = []
let seq = 0
const emit = (op, id, actor, extra = {}) => { const e = { seq: ++seq, ts: new Date().toISOString(), op, issue_id: id, actor, issue: { ...items.get(id) }, ...extra }; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
/** A change on the board by `actor`, as bd makes it (one event). */
const change = (id, actor, f, op = 'update') => { Object.assign(items.get(id), f, { updated_at: new Date().toISOString() }); emit(op, id, actor) }
// bin/bd, as the stub calls it: update (with -s/-a, the guards, --claim), label add|remove, comments add, close
function bdCli(args) {
  const actor = args[args.indexOf('--actor') + 1] || 'nobody', flag = (f) => { const k = args.indexOf(f); return k >= 0 ? args[k + 1] : undefined }
  const [cmd, a1, a2, a3] = args, i = items.get(cmd === 'update' || cmd === 'close' ? a1 : a2)
  if (!i) return { code: 1, err: 'no such issue' }
  if (cmd === 'update') {
    const ifA = flag('--if-assignee'), ifS = flag('--if-status')
    if (ifA !== undefined || ifS !== undefined) {
      if (race.has(i.id)) return { code: 13, err: `assignee mismatch: ${i.id} is held by "someone"` }
      if ((ifA !== undefined && ifA !== i.assignee) || (ifS !== undefined && ifS !== i.status)) return { code: 13, err: 'guard mismatch' }
    }
    if (args.includes('--claim')) {
      if (i.assignee && i.assignee !== actor) return { code: 1, err: `issue already claimed: already assigned to "${i.assignee}"` }
      change(i.id, actor, { assignee: actor, status: 'in_progress' }); return { code: 0 }
    }
    const f = {}; if (flag('-s')) f.status = flag('-s'); if (flag('-a')) f.assignee = flag('-a')
    change(i.id, actor, f); return { code: 0 }
  }
  if (cmd === 'label') { if (a1 === 'add' && !i.labels.includes(a3)) i.labels.push(a3); if (a1 === 'remove') i.labels = i.labels.filter((l) => l !== a3); emit('update', i.id, actor); return { code: 0 } }
  if (cmd === 'comments' && a1 === 'add') { (i.comments ||= []).push({ author: actor, text: a3 }); i.updated_at = new Date().toISOString(); emit('comment', i.id, actor, { comment: { id: `c${seq + 1}`, author: actor, text: a3 } }); return { code: 0 } }
  if (cmd === 'close') { change(i.id, actor, { status: 'closed' }, 'close'); return { code: 0 } }
  return { code: 1, err: `stub bd: ${cmd}?` }
}
const snapOf = (i) => ({ ...i, comments: undefined })
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') {
    const who = u.searchParams.get('assignee')
    return json({ items: [...items.values()].filter((i) => i.status === 'open' && (!who || i.assignee === who)).sort((a, b) => a.priority - b.priority).map(snapOf) })
  }
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json(snapOf(items.get(decodeURIComponent(m[1])))) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()].map(snapOf) })
  if (u.pathname === '/stub-bd') { let body = ''; for await (const c of req) body += c; return json(bdCli(JSON.parse(body))) }
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`

// stub bin/bd: logs its arguments, asks the fake board, exits with its code (13 when a guard no longer holds)
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/usr/bin/env node
const fs = require('node:fs'); const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(BDLOG)}, a.join(' ') + '\\n')
fetch(${JSON.stringify(`${BD}/stub-bd`)}, { method: 'POST', body: JSON.stringify(a) }).then((r) => r.json()).then((r) => { if (r.err) console.error(r.err); process.exit(r.code) })
`, { mode: 0o755 })
// stub bin/lead: `start <role>` fails while fail-<role> exists; else it records the start and its queue head (LEAD_NEXT),
// that role's lead then runs (idle), and it claims the head, as a lead does first
const STARTED = path.join(T, 'started.txt')
fs.writeFileSync(path.join(PROJ, 'bin', 'lead'), `#!/bin/sh
[ "$1" = start ] || exit 2
[ -f "${T}/fail-$2" ] && { echo "paseo refused" >&2; exit 1; }
printf 'START %s\\n%s\\n--\\n' "$2" "$LEAD_NEXT" >>"${STARTED}"; echo idle >"${T}/$2.status"
id=$(printf '%s\\n' "$LEAD_NEXT" | sed -n '1s/^- \\([^ ]*\\) .*/\\1/p')
[ -z "$id" ] || "${PROJ}/bin/bd" update "$id" --claim --actor "$2" >/dev/null 2>&1
exit 0
`, { mode: 0o755 })
// stub paseo: <role>.status (none = no agent); send records the prompt per agent
const SENT = path.join(T, 'sent.txt'), st = (r, s) => fs.writeFileSync(path.join(T, `${r}.status`), s)
st('dev', 'none'); st('qa', 'idle'); st('review', 'idle'); st('arch', 'running'); st('sec', 'none'); st('ux', 'none')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r\\ *|*role=$r) s=$(cat ${T}/$r.status); [ "$s" = none ] && { echo '[]'; exit 0; }
        echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"$s\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })
fs.writeFileSync(path.join(T, 'fail-sec'), '')

const env = { ...process.env, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wr', MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '700', WAKE_RESUME_MS: '1000', WAKE_IDLE_CLOSE_MS: '0', WAKE_SOON_MS: '200', WAKE_RETRY_MS: '100' }
delete env.MM_SERVICE; delete env.WAKE_CAP
let w, out = ''
const start = () => { w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)) }
const sent = () => read(SENT), bdlog = () => read(BDLOG), log = () => read(path.join(PROJ, '.run', 'logs', 'ops.log'))
const to = (role) => sent().split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')
const starts = (r) => read(STARTED).split('--\n').filter((b) => b.startsWith(`START ${r}\n`))
const wstate = () => { try { return JSON.parse(read(path.join(PROJ, '.wake-state.json'))) } catch { return {} } }
const I = (id) => items.get(id)

try {
  start()
  await until(() => /watching/.test(log()))
  console.log('== a ready item: the lead is started with the queue head, and claims it')
  ok('dev (no agent, two ready items) is started', await until(() => starts('dev').length === 1))
  ok('...its first prompt has the head of its queue (d-1, P1), not the second (capacity 1)', /- d-1 \(P1\): title of d-1/.test(starts('dev')[0] || '') && !/d-2/.test(starts('dev')[0] || ''))
  ok('...and it claims it (bd update d-1 --claim): in progress, assignee dev', await until(() => I('d-1').status === 'in_progress' && I('d-1').assignee === 'dev'))

  console.log('== two ready items, capacity 1: the second waits; closing one releases the capacity')
  ok('d-2 waits (logged)', await until(() => /dev has 1 of 1 in progress: waiting in its queue d-2/.test(log())))
  await sleep(2500)
  ok('...and dev is not told of d-2 while it holds d-1', !/d-2/.test(to('dev')))
  change('d-1', 'dev', { status: 'closed' }, 'close')
  ok('dev closes d-1: d-2 is handed to it ("next in your queue: claim it")', await until(() => /d-2 "title of d-2" \(P2\) is next in your queue: claim it with bd update d-2 --claim/.test(to('dev'))))
  ok('...with its queue and capacity in the update', /Your queue \(bd ready --assignee dev\): 1 item\(s\), next d-2[^\n]*In progress: 0 of your capacity 1\./.test(to('dev')))

  console.log('== a P0 may go past capacity by one (the owner, 2026-11-06)')
  change('d-2', 'dev', { status: 'in_progress' }) // dev claims d-2: at its capacity 1
  add('d-3', 'dev', { priority: 0 }); emit('create', 'd-3', 'ops')
  add('d-4', 'dev', { priority: 2 }); emit('create', 'd-4', 'ops')
  ok('a P0 (d-3) is handed although dev is at its capacity 1 (its own event, or the queue head)', await until(() => /d-3 "title of d-3"/.test(to('dev'))))
  ok('...and the update says a P0 may go past capacity by one, naming it', /a P0 may go past it by one: claim d-3 now/.test(to('dev')))
  ok('...a P2 (d-4) still waits', await until(() => /waiting in its queue d-4/.test(log())) && !/d-4 "title of d-4"/.test(to('dev')))
  change('d-3', 'dev', { status: 'in_progress' }) // dev claims the P0: 2 in progress, capacity 1
  add('d-5', 'dev', { priority: 0 }); emit('create', 'd-5', 'ops')
  ok('...but only one past: a second P0 (d-5) waits while dev holds 2 of 1', await until(() => /dev has 2 of 1 in progress: waiting in its queue (d-5 d-4|d-4 d-5)/.test(log())))
  await sleep(1500)
  ok('...and dev is not told of d-5', !/d-5 "title of d-5"/.test(to('dev')))
  for (const id of ['d-2', 'd-3', 'd-4', 'd-5']) change(id, 'dev', { status: 'closed' }, 'close') // out of the way of the project cap below

  console.log('== an expired claim goes back to the queue')
  ok('q-1 (in progress, no update for 2 h): requeued through the guard', await until(() => /update q-1 -s open -a qa --if-assignee qa --if-status in_progress --actor wake/.test(bdlog()) && I('q-1').status === 'open' && I('q-1').assignee === 'qa'))
  ok('...said on the item, and counted (expiry 1)', await until(() => (I('q-1').comments || []).some((c) => c.author === 'wake' && /Requeued: .*expiry 1 of 3/.test(c.text))) && wstate()._expiries?.['q-1'] === 1)
  ok('...and it is in qa\'s queue: handed to qa', await until(() => /q-1 "title of q-1" \(P2\) is next in your queue/.test(to('qa'))))
  ok('the guard says 13 (q-2 moved first): left as it is, not counted', await until(() => /lease of q-2 expired, but it changed first \(the guard\): left as it is/.test(log())) && I('q-2').status === 'in_progress' && !wstate()._expiries?.['q-2'] && !(I('q-2').comments || []).length)
  ok('the 3rd expiry of one item (q-3): needs-you', await until(() => I('q-3').labels.includes('needs-you') && wstate()._expiries?.['q-3'] === 3))
  ok('a lead in a turn keeps its claim (r-1, arch running)', I('r-1').status === 'in_progress' && !/update r-1/.test(bdlog()))

  console.log('== a reassign lands in review\'s queue')
  change('a-1', 'arch', { assignee: 'review', status: 'open' })
  ok('arch hands a-1 to review (a reassign): review is woken', await until(() => /HANDOFF to you from arch on a-1 "title of a-1" \(was arch, now open\)/.test(to('review'))))
  ok('...it is review\'s queue head (bd ready --assignee review)', /Your queue \(bd ready --assignee review\): 1 item\(s\), next a-1/.test(to('review')))
  await sleep(1500)
  ok('...told once (the reconcile does not hand it again)', to('review').split('TO agent-review').filter((m) => /a-1/.test(m)).length === 1)
  bdCli(['update', 'a-1', '--claim', '--actor', 'review']); change('a-1', 'review', { status: 'closed' }, 'close')

  console.log('== wake killed in the middle of a handoff, started again: the item lands')
  st('review', 'running')
  change('k-1', 'arch', { assignee: 'review', status: 'open' })
  ok('the handoff is noted while review is busy (not sent yet)', await until(() => /HANDOFF on k-1 by arch: waking review/.test(log())) && !/k-1/.test(to('review')))
  w.kill('SIGKILL'); await new Promise((r) => w.once('exit', r))
  st('review', 'idle')
  start()
  ok('wake again: k-1 reaches review (replayed from the journal, and from the board: its queue head)', await until(() => /k-1 "title of k-1"/.test(to('review')) && /next k-1/.test(to('review'))))

  console.log('== a failed start: retried with backoff; after 3 tries, needs-you')
  ok('sec\'s start failed 3 times, each later than the one before', /start of sec failed \(reasons kept\): paseo refused \(try 1; the next in 1 s\)/.test(log()) && /\(try 2; the next in 1 s\)|\(try 2; the next in 2 s\)/.test(log()) && /\(try 3; the next in 3 s\)/.test(log()))
  ok('...said once on the item, then needs-you with an error', /comments add s-1 Error: wake could not start the sec lead for this item: paseo refused/.test(bdlog()) && I('s-1').labels.includes('needs-you') && (I('s-1').comments || []).some((c) => /could not start the sec lead 3 times in a row/.test(c.text)))

  console.log('== the project cap')
  config(2) // in progress now: q-2 (qa), r-1 (arch): 2 of 2
  add('u-1', 'ux', { priority: 1 }); emit('create', 'u-1', 'alex')
  ok('the project is at its cap: ux (no agent, a ready item) is not started (logged)', await until(() => /ux has 0 of 1 in progress \(the project 2 of its cap 2\): waiting in its queue u-1/.test(log())) && !starts('ux').length)
  config(3)
  ok('the cap raised: ux is started with u-1', await until(() => starts('ux').length === 1 && /- u-1 \(P1\)/.test(starts('ux')[0])))

  console.log('== the human fixes it: the start works again')
  config(0); fs.rmSync(path.join(T, 'fail-sec')); bdCli(['label', 'remove', 's-1', 'needs-you', '--actor', 'alex'])
  ok('sec is started (after its backoff) and claims s-1', await until(() => starts('sec').length === 1 && I('s-1').status === 'in_progress', 30000))
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${log().split('\n').slice(-40).join('\n')}\n${out.slice(-1500)}\n--- bd\n${bdlog().slice(-1500)}\n--- sent\n${sent().slice(-2500)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
