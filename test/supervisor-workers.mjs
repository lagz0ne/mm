#!/usr/bin/env node
// bin/supervisor (profile system) and a lead's workers (sy-asaw): a running worker on an item is an agent turn (no
// stall:<item>); a role with workers over its capacity (each live worker one place, each item in progress no worker works
// on one) opens overcap:<role>, which clears when a worker goes; while any role has workers, the board over its cap
// (wake.cap) opens overcap:board; a role without workers holding more items than its capacity is left to wake (no item).
// Hermetic: temp folder, a fake bd-serve, a stub paseo (leads and workers from files), a stub mm; a fake clock.
//   node test/supervisor-workers.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-workers-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const MIN = 60000, T0 = Date.now()
let clock = T0
const iso = (t) => new Date(t).toISOString()

const HOME = path.join(T, 'home'), SYS = path.join(T, 'sys'), MMH = path.join(HOME, '.mm')
fs.mkdirSync(path.join(SYS, 'bin'), { recursive: true }); fs.mkdirSync(path.join(SYS, 'leads'), { recursive: true }); fs.mkdirSync(MMH, { recursive: true })
fs.copyFileSync(path.join(SRC, 'template/profiles/system/bin/supervisor'), path.join(SYS, 'bin/supervisor'))
fs.cpSync(path.join(SRC, 'template/bin/lib'), path.join(SYS, 'bin/lib'), { recursive: true })
fs.writeFileSync(path.join(SYS, 'leads/roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' },
  { id: 'platform', workers: true, capacity: 1, worker: { kind: 'write', repo: '{home}/mm' } }] }))
fs.writeFileSync(path.join(MMH, 'config.yaml'), 'wake:\n  cap: "3"\n')

// stub paseo: agents/<label value>.json (leads by role=<role>, workers by role=<role>-worker; the CLI's shape, no labels)
const AG = path.join(T, 'agents'); fs.mkdirSync(AG)
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
[ "$1" = ls ] || exit 9
for a in "$@"; do case "$a" in role=*) f="${AG}/\${a#role=}.json"; [ -f "$f" ] && cat "$f" || echo '[]'; exit 0 ;; esac; done
echo '[]'
`, { mode: 0o755 })
const put = (k, v) => fs.writeFileSync(path.join(AG, `${k}.json`), JSON.stringify(v))
const lead = (role, status) => put(role, [{ id: `agent-${role}`, shortId: role, status }])
const workers = (ws) => put('platform-worker', ws.map(([name, item, status]) => ({ id: `w-${name}`, shortId: name, title: `sysqa · platform worker ${name} on ${item}`, status })))
fs.writeFileSync(path.join(T, 'mm'), `#!/bin/sh\n[ "$1 $2" = "ls -o" ] && { echo '[]'; exit 0; }\nexit 9\n`, { mode: 0o755 })

// fake bd-serve
const items = new Map(), events = []
let seq = 0, nextId = 1
const snap = (i) => ({ ...i, comments: undefined })
const record = (op, i, actor, t) => events.push({ seq: ++seq, op, issue_id: i.id, actor, ts: iso(t), issue: snap(i) })
function item(id, f, actor = 'ops', t = clock) {
  const i = { id, title: f.title || id, status: f.status || 'open', priority: f.priority ?? 2, assignee: f.assignee || '', labels: f.labels || [], description: f.description || '', updated_at: iso(t), comments: [] }
  items.set(id, i); record('create', i, actor, t); return i
}
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}, json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') { const label = u.searchParams.get('label'); return json({ items: [...items.values()].filter((i) => !label || i.labels.includes(label)).map(snap), has_more: false }) }
  if (req.method === 'GET' && u.pathname === '/v0/beads/ready') return json({ items: [...items.values()].filter((i) => i.status === 'open').map(snap) })
  if (req.method === 'GET' && u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: events.filter((e) => e.seq > since) }) }
  if (req.method === 'POST' && u.pathname === '/v0/beads/issues') return json({ id: item(`sy-s${nextId++}`, b, b.actor).id })
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname))) { items.get(m[1]).comments.push({ author: b.author, text: b.text }); return json({}) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+):close$/.exec(u.pathname))) { Object.assign(items.get(m[1]), { status: 'closed' }); return json({}) }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const ENV = { PATH: process.env.PATH, HOME, MM_HOME: MMH, MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_BIN: path.join(T, 'mm'), MM_BRAIN: path.join(T, 'brain'),
  SVC_URL_BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
let out = ''
const supervise = () => new Promise((resolve) => {
  const p = spawn('node', [path.join(SYS, 'bin/supervisor')], { env: { ...ENV, SUPERVISOR_NOW: String(clock) }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.on('close', resolve)
})
const KEY = /supervisor key: `([^`]+)`/
const openKeys = () => [...items.values()].filter((i) => i.labels.includes('supervisor') && i.status !== 'closed').map((i) => KEY.exec(i.description)?.[1]).sort()
const openOf = (k) => [...items.values()].find((i) => i.labels.includes('supervisor') && i.status !== 'closed' && KEY.exec(i.description)?.[1] === k)

try {
  // platform holds sy-1 (a worker on it, running) and sy-2 (no worker): 2 places, capacity 1. ops holds 2 items (no
  // workers: wake's business, not an item). Nothing has moved on sy-1 for an hour, but its worker is running.
  lead('ops', 'idle'); lead('review', 'idle'); lead('platform', 'idle')
  item('sy-1', { status: 'in_progress', priority: 1, assignee: 'platform' }, 'platform', clock - 60 * MIN)
  item('sy-2', { status: 'in_progress', priority: 2, assignee: 'platform' }, 'platform', clock - 60 * MIN)
  item('sy-3', { status: 'in_progress', priority: 2, assignee: 'ops' }, 'ops', clock - 5 * MIN)
  item('sy-4', { status: 'in_progress', priority: 2, assignee: 'ops' }, 'ops', clock - 5 * MIN)
  workers([['w1', 'sy-1', 'running']])
  console.log('== a running worker is an agent turn; platform over its capacity')
  await supervise()
  ok('no stall:sy-1 (its worker is running), though nothing moved for an hour', !openOf('stall:sy-1'))
  ok('overcap:platform opened (2 places: worker w1 on sy-1, and sy-2 with no worker; capacity 1)', /worker\(s\) \(w1 on sy-1\), 1 item\(s\) in progress no worker works on \(sy-2\)/.test(openOf('overcap:platform')?.description || ''))
  ok('no overcap:ops (a role without workers is wake\'s business)', !openOf('overcap:ops'))
  ok('overcap:board opened: 4 places over all roles, the cap is 3', /holds 4 places, its cap is 3/.test(openOf('overcap:board')?.title || ''))

  console.log('== the worker finishes (idle, still there): sy-1 may stall again; the places stay')
  workers([['w1', 'sy-1', 'idle']]); clock += 5 * MIN
  await supervise()
  ok('stall:sy-1 opened (no turn: its worker is idle, and nothing moved for an hour)', !!openOf('stall:sy-1'))
  ok('overcap:platform still open', !!openOf('overcap:platform'))

  console.log('== the lead stops the worker and hands sy-2 over: within capacity and the cap again')
  workers([]); Object.assign(items.get('sy-2'), { status: 'open', assignee: 'review' }); record('update', items.get('sy-2'), 'platform', clock); clock += 5 * MIN
  await supervise()
  ok('overcap:platform cleared and closed', !openOf('overcap:platform'))
  ok('overcap:board cleared (3 places, cap 3)', !openOf('overcap:board'))
  ok('open now: only stall:sy-1', openKeys().join(' ') === 'stall:sy-1')
} finally {
  srv.close()
  if (fail) console.log(out.slice(-3000))
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
