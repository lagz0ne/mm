#!/usr/bin/env node
// bin/sentinel through the table (sy-mv69.2), hermetic: a scratch system board (the template's bin and the system
// profile's, and the system profile's own leads/raci.json with its first when rows), a fake bd-serve in this process, a
// stub brain (its status lines), a stub mm (projects, errors), a brain state folder (applied migrations), a gates
// history, and a fake clock and boot (SENTINEL_NOW, SENTINEL_BOOT). Proves: a problem that matches a when case inside
// its bounds opens no item, and its next and verify are logged once; one that matches none, is outside its bounds or
// whose correct says unexpected opens one item labelled unexpected, for ops, that says why; every [brain] status line
// goes through the table, not only ALERT and drift.
//   node test/sentinel-routine.mjs          exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-routine-'))
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }))
let pass = 0, fail = 0
const ok = (d, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${extra && !c ? `  (${extra})` : ''}`) }
const MIN = 60000, T0 = Date.parse('2026-11-10T12:00:00Z')
const iso = (t) => new Date(t).toISOString()

// the board: bin, and the system profile's leads (roles and the RACI with its when rows)
const B = path.join(T, 'sys'), HOME = path.join(T, 'home')
fs.mkdirSync(HOME, { recursive: true })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.cpSync(path.join(SRC, 'template', 'profiles', 'system', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads'))
for (const f of ['raci.json', 'roles.json']) fs.copyFileSync(path.join(SRC, 'template', 'profiles', 'system', 'leads', f), path.join(B, 'leads', f))
fs.writeFileSync(path.join(B, '.mm-answers.yaml'), 'project: sysqa\nclient: system\nname: qa\nprofile: system\n')
// stubs: the brain (status.txt), mm (ls.json, errors.json), a project p1 with a cron log
const BR = path.join(T, 'brain'), STATUS = path.join(T, 'status.txt'), P1 = path.join(T, 'p1')
fs.mkdirSync(path.join(BR, 'bin'), { recursive: true }); fs.mkdirSync(path.join(P1, '.run', 'logs'), { recursive: true })
fs.writeFileSync(path.join(BR, 'bin', 'brain'), `#!/bin/sh\ncat "${STATUS}"\n`, { mode: 0o755 })
fs.writeFileSync(path.join(T, 'mm'), `#!/bin/sh\ncase "$1 $2" in\n  "ls -o") cat "${T}/ls.json" ;;\n  "obs errors") cat "${T}/errors.json" ;;\n  "obs status") exit 0 ;;\n  *) exit 9 ;;\nesac\n`, { mode: 0o755 })
fs.writeFileSync(path.join(T, 'ls.json'), JSON.stringify([{ project: 'p1', root: P1 }]))
fs.writeFileSync(path.join(T, 'errors.json'), '[]')
const status = (...lines) => fs.writeFileSync(STATUS, lines.map((l) => `[brain] ${l}\n`).join(''))
const cronlog = (job, code, msg, t) => fs.appendFileSync(path.join(P1, '.run', 'logs', 'cron.log'), `${JSON.stringify({ time: iso(t), msg, job, exit_code: code })}\n`)
const errs = (rows) => fs.writeFileSync(path.join(T, 'errors.json'), JSON.stringify(rows.map(([project, service, t]) => ({ kind: 'log', project, service, n: 2, last: iso(t), sample: [`Error: ${service} broke`] }))))
// an applied migration at T0+2 min (its state mark), a gates run from T0-30 to T0+15 min
const BS = path.join(T, 'brain-state'); fs.mkdirSync(path.join(BS, 'migrations'), { recursive: true })
fs.writeFileSync(path.join(BS, 'migrations', '1800000001-x.sh'), `${iso(T0 + 2 * MIN)} tier=1\n`)
fs.writeFileSync(path.join(T, 'history.jsonl'), `${JSON.stringify({ suite: 'test/a.sh', status: 'passed', secs: 45 * 60, date: iso(T0 + 15 * MIN) })}\n`)

// fake bd-serve: what the sentinel uses
const items = new Map(); let next = 1
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}, json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') { const l = u.searchParams.get('label'); return json({ items: [...items.values()].filter((i) => !l || i.labels.includes(l)) }) }
  if (req.method === 'POST' && u.pathname === '/v0/beads/issues') { const id = `sy-r${next++}`; items.set(id, { ...b, id, status: 'open', comments: [] }); return json({ id }) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname))) { items.get(m[1])?.comments.push(b.text); return json({}) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+):close$/.exec(u.pathname))) { const i = items.get(m[1]); if (i) i.status = 'closed'; return json({}) }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))

const ENV = { PATH: process.env.PATH, HOME, MM_HOME: path.join(HOME, '.mm'), MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  MM_BIN: path.join(T, 'mm'), SENTINEL_BRAIN: BR, SENTINEL_STATE: path.join(T, 'sentinel.json'), SENTINEL_CONFIG: path.join(T, 'none.json'),
  BRAIN_STATE: BS, MM_GATES_HISTORY: path.join(T, 'history.jsonl'), SENTINEL_BOOT: String(T0 - 5 * MIN), SVC_URL_BD_SERVE: `http://127.0.0.1:${srv.address().port}` }
let out = ''
const sentinel = (min) => new Promise((resolve) => {
  const p = spawn('node', [path.join(B, 'bin', 'sentinel')], { cwd: B, env: { ...ENV, SENTINEL_NOW: String(T0 + min * MIN) }, stdio: ['ignore', 'pipe', 'pipe'] })
  out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  p.on('close', (code) => resolve(code))
})
const key = (k) => [...items.values()].filter((i) => (i.description || '').includes(`sentinel key: \`${k}\``))
const openK = (k) => key(k).find((i) => i.status !== 'closed')
const keys = () => [...items.values()].filter((i) => i.status !== 'closed').map((i) => /sentinel key: `([^`]+)`/.exec(i.description)?.[1]).sort()

try {
  console.log('== run 1 (+0 min)')
  status('score 3', 'ALERT 4 security updates available', 'LINT ERROR memory/svc-x.md: no ttl_days', 'failed units: user:mm-sync.service',
    'no backup in 27 h for p1', 'ALERT RAID md0 degraded', 'last drift (2026-11-10T11:00:00+00:00): + services_system: a.service')
  cronlog('supervisor', 1, 'supervisor failed (exit 1): bd-serve not up', T0 - 1 * MIN) // 4 min after the boot
  errs([['mm', 'board', T0 - 1 * MIN], ['p1', 'board', T0 - 1 * MIN]])
  ok('exit 0', (await sentinel(0)) === 0, out)
  const lint = openK('brain:LINT ERROR memory/svc-x.md: no ttl_days')
  ok('a status line that is not ALERT or drift, with no when case: one item, labelled unexpected, for ops, that says why', !!lint && lint.assignee === 'ops' &&
    lint.labels.includes('unexpected') && lint.labels.includes('act:incident') && /\*\*Unexpected:\*\* no row of leads\/raci\.json has a when case for it/.test(lint.description), JSON.stringify(keys()))
  ok('a status line that is not ALERT or drift, with a case: routine (score; the failed mm-sync unit; no backup in 27 h): no item',
    !key('brain:score #').length && !key('brain:failed units: user:mm-sync.service').length && !key('brain:no backup in # h for p#').length)
  ok('...its next and verify are logged', /brain:score #: routine, no item: posture \(when #2: brain:score \*\); next: none/.test(out) &&
    /brain:failed units: user:mm-sync\.service: routine, no item: incident .*next: ops: systemctl --user reset-failed mm-sync\.service.*verify: systemctl --user is-failed mm-sync\.service → not failed/.test(out), out)
  ok('an ALERT of security updates, no kernel or openssh (t1-change): routine, no item', !key('alert:# security updates available').length)
  const raid = openK('alert:RAID md# degraded')
  ok('an ALERT a case matches but whose correct says unexpected (RAID): an unexpected item with its case', !!raid && raid.labels.includes('unexpected') &&
    /t2-change \(when #2\) says: unexpected: the T2 steps of svc-storage/.test(raid.description), raid?.description)
  ok('a failed supervisor run 4 min after the boot: routine, no item', !key('cron:p1/supervisor').length)
  ok('the first run records the drift, no item (as before)', !key('drift').length)

  console.log('== runs 2, 3 (+5, +10 min)')
  status('score 3', 'ALERT 2 security updates available: kernel, openssh', 'last drift (2026-11-10T12:04:00+00:00): + login_users: admin')
  errs([['mm', 'board', T0 + 4 * MIN], ['p1', 'board', T0 + 4 * MIN]])
  await sentinel(5)
  const sec = openK('alert:# security updates available: kernel, openssh')
  ok('an ALERT the case matches but bounds.exclude names (kernel): an unexpected item, outside the bounds', !!sec && sec.labels.includes('unexpected') &&
    /outside the bounds of t1-change \(when #1\): "2 security updates available: kernel, openssh" matches bounds\.exclude/.test(sec.description), sec?.description)
  ok('drift of the owner\'s admin login: routine, no drift item', !key('drift').length && /drift: routine, no item: incident \(when #1/.test(out), out)
  ok('the lines gone (the unit, the backup line): no item ever', !key('brain:failed units: user:mm-sync.service').length && !key('brain:no backup in # h for p#').length)
  status('score 3', 'last drift (2026-11-10T12:09:00+00:00): + services_system: b.service', 'no backup in 27 h for p1')
  errs([['mm', 'board', T0 + 9 * MIN], ['p1', 'board', T0 + 9 * MIN]])
  await sentinel(10)
  ok('drift 7 min after an applied migration: routine, no item', !key('drift').length && /drift: routine, no item: incident \(when #2/.test(out), out)
  ok('errors of mm 3 checks in a row, inside a gates run: routine, no item', !key('errors:mm/board').length && /errors:mm\/board: routine, no item: incident \(when #3/.test(out), out)
  const p1e = openK('errors:p1/board')
  ok('errors of p1 3 checks in a row: no case: an unexpected item', !!p1e && p1e.labels.includes('unexpected'), JSON.stringify(keys()))
  ok('the alerts gone: their items closed (as before)', !openK('alert:# security updates available: kernel, openssh') && !openK('alert:RAID md# degraded'))

  console.log('== runs 4, 5 (+80, +135 min)')
  status('score 4', 'last drift (2026-11-10T13:19:00+00:00): + services_system: c.service', 'failed units: user:mm-sync.service', 'no backup in 27 h for p1')
  cronlog('supervisor', 1, 'supervisor failed (exit 1): bd-serve not up', T0 + 79 * MIN)
  errs([])
  await sentinel(80)
  const d = openK('drift')
  ok('drift 77 min after the last migration: an unexpected item that says which bound', !!d && d.labels.includes('unexpected') &&
    /outside the bounds of incident \(when #2\): not within 60 min after the last migration/.test(d.description), d?.description)
  ok('a failed supervisor run 84 min after the boot: an unexpected item', !!openK('cron:p1/supervisor') && /not within 10 min after the last boot/.test(openK('cron:p1/supervisor')?.description || ''))
  ok('the mm-sync unit failed a 2nd time in 24 h (bounds.times 1): an unexpected item', /episode 2 in 24 h \(at most 1\)/.test(openK('brain:failed units: user:mm-sync.service')?.description || ''), JSON.stringify(keys()))
  ok('no backup, present 70 min (bounds.for_min 120): still routine', !key('brain:no backup in # h for p#').length)
  ok('the score changed (#: the same key): still routine', !key('brain:score #').length)
  await sentinel(135)
  ok('no backup, present 125 min: now an unexpected item', /present for more than 120 min/.test(openK('brain:no backup in # h for p#')?.description || ''), JSON.stringify(keys()))
  ok('each item is one per key (no duplicate)', new Set(keys()).size === keys().length)
} finally { srv.close() }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
