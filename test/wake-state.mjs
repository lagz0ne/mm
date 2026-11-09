#!/usr/bin/env node
// bin/wake's own state (sy-965o): a box's wake may not make a file in the project's top level (the root is not
// group-writable, review sy-b15.6 2), only in its folders. Wake keeps its state in .run/wake-state.json: it carries the
// old root .wake-state.json over (its _seq), saves while the root refuses new files, and a save that fails writes one
// warn line per cause, not one per event.
// Hermetic: temp folder, stub paseo and bd, a fake board (its journal and event stream), no obs.
//   node test/wake-state.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-state-'))
const P = path.join(T, 'proj'), RUN = path.join(P, '.run')
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

const ROLES = ['ops', 'platform']
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(P, 'bin'), { recursive: true })
fs.mkdirSync(path.join(P, 'leads'), { recursive: true })
fs.writeFileSync(path.join(P, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: ROLES.map((id) => ({ id })) }))
fs.mkdirSync(path.join(P, 'control'), { recursive: true })
fs.mkdirSync(path.join(RUN, 'logs'), { recursive: true })
fs.writeFileSync(path.join(P, 'bin', 'bd'), '#!/bin/sh\n', { mode: 0o755 })
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"idle\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
esac
`, { mode: 0o755 })

const now = () => new Date().toISOString()
const items = new Map([['f-1', { id: 'f-1', title: 'title of f-1', status: 'open', assignee: '', labels: [], updated_at: now() }]])
const records = []
const emit = () => { const e = { seq: records.length + 1, ts: now(), op: 'update', issue_id: 'f-1', actor: 'ops', issue: { ...items.get('f-1') } }; records.push(e); return e }
for (let i = 0; i < 5; i++) emit()
const SAVED = 3
// the old state, in the root: then the root as a box's wake sees it (no new file there; .run/ stays writable)
fs.writeFileSync(path.join(P, '.wake-state.json'), JSON.stringify({ _seq: SAVED, ops: { items: ['f-1'], at: '2026-01-01T00:00:00Z' } }))
fs.chmodSync(P, 0o555)

const streams = new Set()
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return }
  if (u.pathname === '/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0)
    return json({ head: records.at(-1)?.seq || 0, records: records.filter((e) => e.seq > since).slice(0, 500) })
  }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json({ ...items.get(decodeURIComponent(m[1])), comments: [] }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  res.writeHead(404); res.end('{}')
})
const push = () => { const e = emit(); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const env = { ...process.env, BD_SERVE: `http://127.0.0.1:${srv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'ws',
  MM_OBS_TRACES: '', MM_OBS_METRICS: '', WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '600000', WAKE_RESUME_CHECK_MS: '600000', WAKE_LEASE_MS: '86400000' }
delete env.MM_SERVICE
let out = ''
const start = () => { const w = spawn('node', [path.join(P, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d)); return w }
const stop = (w) => new Promise((r) => { w.once('exit', r); w.kill() })
const opsLog = () => { try { return fs.readFileSync(path.join(RUN, 'logs', 'ops.log'), 'utf8') } catch { return '' } }
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(RUN, 'wake-state.json'), 'utf8')) } catch { return {} } }
const warns = () => opsLog().split('\n').filter((l) => /"level":"warn"/.test(l) && /wake state not saved/.test(l))

let w
try {
  w = start()
  ok('wake starts', await until(() => /watching .* from seq/.test(opsLog())))
  ok(`it carries the root's old state over without its _seq: no replay from seq ${SAVED}`, /carried over without its _seq/.test(opsLog()) && !/replayed \d+ event/.test(opsLog()))
  ok(`its state is saved in .run/wake-state.json while the root refuses new files (_seq ${records.length})`, await until(() => state()._seq === records.length))
  ok('...with what the old state had (a role\'s entry)', state().ops?.items?.[0] === 'f-1')
  push(); push()
  ok('a later event moves _seq on', await until(() => state()._seq === records.length))
  ok('no warn line while saves work', warns().length === 0)
  ok('the root\'s old file is left as it was', JSON.parse(fs.readFileSync(path.join(P, '.wake-state.json'), 'utf8'))._seq === SAVED)

  // a save that fails: .run/ refuses new files too now (its tmp file can't be made)
  fs.chmodSync(RUN, 0o555)
  const at = state()._seq
  for (let i = 0; i < 3; i++) { push(); await sleep(2600) } // 3 saves (wake saves _seq at most every 2 s)
  ok('a failed save writes a warn line', warns().length >= 1)
  ok('...once per cause, not on each save (3 failed saves, 1 line)', warns().length === 1)
  ok('...naming the file and why', /wake-state\.json.*(EACCES|permission denied)/i.test(warns()[0] || ''))
  ok('the state stays as it was (never half a file)', state()._seq === at)
  fs.chmodSync(RUN, 0o755)
  push()
  ok('once .run/ is writable again, the state is saved', await until(() => state()._seq === records.length))
} finally {
  if (w) await stop(w)
  srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-25).join('\n')}\n${out.slice(-1500)}`)
  try { fs.chmodSync(RUN, 0o755) } catch {}
  fs.chmodSync(P, 0o755); fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
