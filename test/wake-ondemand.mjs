#!/usr/bin/env node
// bin/wake, leads on demand (sy-809m): a role with no agent is started with bin/lead start when an item waits for it,
// within one check, and then gets the item; nothing starts while the restore hold is on; a failed start is said on the
// item once and kept for the Leads page; a lead idle for WAKE_IDLE_CLOSE_MS with nothing of its own open is closed
// (never one in a turn, or one with an item in progress or labelled needs-you), and the next request starts it again;
// a kept role (roles.json `keep`, the owner's contact) is never closed and never started: its waiting items get needs-you.
// Hermetic: temp folder and MM_HOME, stub paseo, bin/lead, bin/bd and bd-serve, no obs.
//   node test/wake-ondemand.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-ondemand-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

const ROLES = ['qa', 'dev', 'ops', 'arch', 'rev', 'sec', 'own', 'chat'] // own, chat: kept (the owner's contact)
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(T, 'proj', 'bin'), { recursive: true })
fs.mkdirSync(path.join(T, 'proj', 'leads'), { recursive: true })
fs.writeFileSync(path.join(T, 'proj', 'leads', 'roles.json'), JSON.stringify({ roles: ROLES.map((id) => ({ id, ...(['own', 'chat'].includes(id) ? { keep: true } : {}) })) }))
fs.mkdirSync(path.join(T, 'proj', 'control'), { recursive: true })
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(T, 'proj', 'bin', 'bd'), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${BDLOG}"\n`, { mode: 0o755 })
// the machine's config, with the restore hold on at first
const MMH = path.join(T, 'mm'); fs.mkdirSync(MMH)
const hold = (on) => fs.writeFileSync(path.join(MMH, 'config.yaml'), `layout: one-root\nrestore:\n  drill: false\n  hold: ${on}\n`)
hold(true)
// stub bin/lead: `start <role>` is recorded, and that role's lead then runs (idle)
const STARTED = path.join(T, 'started.txt')
fs.writeFileSync(path.join(T, 'proj', 'bin', 'lead'), `#!/bin/sh
[ "$1" = start ] || exit 2
[ -f "${T}/failstart" ] && { rm -f "${T}/failstart"; echo "paseo refused" >&2; exit 1; }
echo "START $2" >>"${STARTED}"; echo idle >"${T}/$2.status"
`, { mode: 0o755 })
// stub paseo: <role>.status holds the agent's status (none = no agent); a plain archive refuses a running agent
const SENT = path.join(T, 'sent.txt'), ARCH = path.join(T, 'archived.txt'), st = (r, s) => fs.writeFileSync(path.join(T, `${r}.status`), s)
st('qa', 'none'); st('dev', 'idle'); st('ops', 'idle'); st('arch', 'running'); st('rev', 'idle'); st('sec', 'none'); st('own', 'idle'); st('chat', 'closed')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r\\ *|*role=$r) s=$(cat ${T}/$r.status); [ "$s" = none ] && { echo '[]'; exit 0; }
        echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"$s\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
  archive) [ "$2" = --force ] && { echo "forced" >>"${ARCH}"; exit 1; }
        r=\${2#agent-}; [ "$(cat ${T}/$r.status)" = running ] && { echo "agent is running" >&2; exit 1; }
        echo "ARCHIVE $r" >>"${ARCH}"; echo none >"${T}/$r.status" ;;
esac
`, { mode: 0o755 })

const items = [
  { id: 'd-1', assignee: 'dev', status: 'in_progress', title: 'dev is on it', labels: [] },
  { id: 'o-1', assignee: 'ops', status: 'open', title: 'waits for the human', labels: ['needs-you'] },
  { id: 'c-1', assignee: 'chat', status: 'in_progress', priority: 1, title: 'the owner asked the contact', labels: [] },
]
const records = [], streams = []
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wo',
  MM_HOME: MMH, MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500',
  WAKE_RESUME_CHECK_MS: '500', WAKE_RESUME_MS: '1500', WAKE_IDLE_CLOSE_MS: '2500' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(T, 'proj', 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const sent = () => read(SENT), bdlog = () => read(BDLOG), archived = () => read(ARCH), opsLog = () => read(path.join(T, 'proj', '.run', 'logs', 'ops.log'))
const wstate = () => { try { return JSON.parse(read(path.join(T, 'proj', '.wake-state.json'))) } catch { return {} } }
const to = (role) => sent().split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')
const starts = (r) => (read(STARTED).match(new RegExp(`^START ${r}$`, 'gm')) || []).length
let seq = 0
const emit = (e) => { e.seq = ++seq; records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const create = (id, role, title, priority = 2) => { items.push({ id, assignee: role, status: 'open', priority, title, labels: [] }); emit({ op: 'create', issue_id: id, actor: 'alex', issue: { assignee: role, status: 'open', priority, title } }) }

try {
  await until(() => /watching/.test(opsLog()))
  console.log('== the restore hold: no lead starts')
  create('q-1', 'qa', 'a new item for qa')
  ok('qa has no agent and an item waits, but the hold is on: not started (logged)', await until(() => /restore hold on: not starting leads/.test(opsLog())) && starts('qa') === 0)
  await sleep(1200)
  ok('...still not started a few checks later', starts('qa') === 0)

  console.log('== a role with no agent and a new item')
  hold(false)
  ok('the hold is lifted: qa is started within one check (bin/lead start)', await until(() => starts('qa') === 1, 1500))
  ok('...logged as a start from no agent, with its reasons', await until(() => /started qa \(no agent\): 1 reason\(s\) wait for it/.test(opsLog())))
  ok('...and the new lead gets the item', await until(() => /q-1: a new item for qa/.test(to('qa'))))
  ok('one agent per role: started once', starts('qa') === 1)

  console.log('== idle leads are closed, never busy ones')
  ok('rev, idle with nothing of its own open, is closed (a plain archive)', await until(() => /^ARCHIVE rev$/m.test(archived())))
  ok('...logged, and the Leads page state says why', await until(() => /closed rev \(rev\): idle \d+ min with nothing of its own open/.test(opsLog()) && wstate().rev?.closed?.why === 'idle'))
  ok('...never with --force', !/forced/.test(archived()))
  await sleep(3500)
  ok('dev (an item in progress) is not closed', !/ARCHIVE dev/.test(archived()))
  ok('ops (an item labelled needs-you) is not closed', !/ARCHIVE ops/.test(archived()))
  ok('arch (in a turn) is not closed', !/ARCHIVE arch/.test(archived()))
  ok('a closed lead with nothing waiting is not started again', starts('rev') === 0)
  ok('a kept role (own) idle longer than WAKE_IDLE_CLOSE_MS is not archived', !/ARCHIVE own/.test(archived()))

  console.log('== a kept role is never started: the human is asked')
  ok('chat (kept) is closed with an item in progress: not started', starts('chat') === 0)
  ok('...its P1 item gets needs-you instead, and it is logged', await until(() => /label add c-1 needs-you --actor wake/.test(bdlog()) && /chat is kept \(the owner's contact\): its agent is closed/.test(opsLog())))
  ok('...once, not on every check', (bdlog().match(/label add c-1 needs-you/g) || []).length === 1)
  ok('...and one note for the owner (needs-you, kept:chat), made once', /^create The chat lead's agent can't be found: 1 item\(s\) wait for it [\s\S]*?-l needs-you,kept:chat/m.test(bdlog()) && (bdlog().match(/^create /gm) || []).length === 1)
  create('c-2', 'chat', 'a new request for the contact')
  await sleep(1500)
  ok('a new P2 item for it: not labelled (only P0/P1 are), still not started', !/label add c-2 needs-you/.test(bdlog()) && starts('chat') === 0)
  st('chat', 'none'); create('c-3', 'chat', 'the contact is gone', 0)
  ok('its agent gone (none) and a P0 waits: still not started, needs-you', await until(() => /label add c-3 needs-you/.test(bdlog())) && starts('chat') === 0)
  ok('...still one note', (bdlog().match(/^create /gm) || []).length === 1)

  console.log('== the next request starts it again')
  create('r-1', 'rev', 'a review for rev')
  ok('rev is started again through the same path', await until(() => starts('rev') === 1, 2000))
  ok('...and gets the item', await until(() => /r-1: a review for rev/.test(to('rev'))))

  console.log('== a failed start is an error on the item')
  fs.writeFileSync(path.join(T, 'failstart'), '')
  create('s-1', 'sec', 'a finding for sec')
  ok('the error is said on the waiting item', await until(() => /comments add s-1 Error: wake could not start the sec lead for this item: paseo refused/.test(bdlog())))
  ok('...and kept for the Leads page', wstate().sec?.startError?.items?.includes('s-1'))
  ok('...the next check starts it', await until(() => starts('sec') === 1))
  ok('...the error is cleared, and was said once', await until(() => !wstate().sec?.startError) && (bdlog().match(/comments add s-1 Error/g) || []).length === 1)
  ok('...and sec gets the item', await until(() => /s-1: a finding for sec/.test(to('sec'))))
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-30).join('\n')}\n${out.slice(-1500)}\n--- archived\n${archived()}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
