#!/usr/bin/env node
// The system board's machine panel on the public side (sy-fei0): POST /api/project-item (it files an item on another
// project's board, as the signed-in person) is the owner's only; members, designers and viewers get 403, logged, and
// nothing is filed for them. The local side is as before (a self-named person files).
// Hermetic: a temp folder, a fake bd serve, a stub mm (ls) and a stub bin/project-item, a throwaway gateway key.
//   node test/project-item.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'project-item-'))
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the board: a copy of the template's site and bin, the machine panel on ----------
const PROJECT = 'sys', OTHER = 'acme-shop', HOST = 'board-sys.example.test'
const B = path.join(T, 'board'), MMH = path.join(T, 'home', '.mm')
fs.cpSync(path.join(SRC, 'template', 'site'), path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules|\/dist(\/|$)/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads', 'ops'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'ops' }] }))
fs.mkdirSync(MMH, { recursive: true })

// ---------- stand-ins: mm (only `ls -o json`) and bin/project-item (records its argv and the actor it was given) ----------
const FILED = path.join(T, 'filed.jsonl')
fs.writeFileSync(path.join(T, 'mm'), `#!/usr/bin/env node
if (process.argv[2] === 'ls') process.stdout.write(JSON.stringify([{ project: ${JSON.stringify(PROJECT)} }, { project: ${JSON.stringify(OTHER)} }]))
`, { mode: 0o755 })
fs.writeFileSync(path.join(B, 'bin', 'project-item'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(FILED)}, JSON.stringify({ argv: process.argv.slice(2), actor: process.env.PROJECT_ITEM_ACTOR }) + '\\n')
process.stdout.write('${OTHER}-' + fs.readFileSync(${JSON.stringify(FILED)}, 'utf8').trim().split('\\n').length + ' filed\\n')
`, { mode: 0o755 })
const filed = () => (fs.existsSync(FILED) ? fs.readFileSync(FILED, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

// ---------- a fake bd serve (the board starts against one; nothing here goes to it) ----------
const bdSrv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: [], has_more: false, head: 0, records: [] })) })
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))

// ---------- the gateway's key and its assertions ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const mk = (u, r, h = HOST, ms = 60000) => {
  const b = Buffer.from(JSON.stringify({ u, r, h, exp: Date.now() + ms, n: crypto.randomBytes(4).toString('hex') })).toString('base64url')
  return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}`
}
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PUB = await freePort()
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BOARD_PUBLIC_PORT: String(PUB), BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`,
  BOARD_PANELS: 'machine', MM_BIN: path.join(T, 'mm'), BOARD_PROJECT: PROJECT, MM_PROJECT: PROJECT, MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  HOME: path.join(T, 'home'), MM_HOME: MMH, MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) }
delete env.MM_SERVICE; delete env.MM_BIND; delete env.BOARD_ACTOR
const s = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; s.stdout.on('data', (d) => (out += d)); s.stderr.on('data', (d) => (out += d))
const OPS_LOG = path.join(B, '.run', 'logs', 'ops.log')
const opsLog = () => { try { return fs.readFileSync(OPS_LOG, 'utf8') } catch { return '' } }

// a request on the public side (with an assertion) or the local side (none)
async function call(method, p, { as, body, headers = {} } = {}) {
  const port = as ? PUB : PORT
  const h = { 'content-type': 'application/json', ...(as ? { 'x-forwarded-host': HOST, 'x-mm-assertion': as } : {}), ...headers }
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => ({})) }
}
const fileOn = (as, headers) => call('POST', '/api/project-item', { as, headers, body: { project: OTHER, title: 'panel probe', description: 'from the machine panel', assignee: 'setup' } })

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); await fetch(`http://127.0.0.1:${PUB}/`); break } catch { await sleep(200) } }
  const OWNER = mk('boss', 'owner'), MEMBER = mk('alex', 'member'), DESIGNER = mk('dee', 'designer'), VIEWER = mk('vic', 'viewer')

  step('the public side: filing on another project\'s board is the owner\'s')
  for (const [who, a] of [['a member', MEMBER], ['a designer', DESIGNER], ['a viewer', VIEWER]]) {
    const r = await fileOn(a)
    ok(`${who}: POST /api/project-item 403`, r.status === 403, `${r.status} ${JSON.stringify(r.data)}`)
  }
  ok('...and nothing was filed for them', filed().length === 0, JSON.stringify(filed()))
  await sleep(200)
  const log = opsLog()
  ok('...each refusal logged (who, role), as the rails are', /refused on the public side: \/api\/project-item is the owner's/.test(log)
    && log.includes('"actor":"alex"') && log.includes('"role":"member"') && log.includes('"actor":"dee"') && log.includes('"role":"designer"')
    && log.includes('"actor":"vic"') && log.includes('"role":"viewer"'), log.slice(-800))
  const m = await call('GET', '/api/machine', { as: MEMBER })
  ok('a member still reads the machine panel (GET /api/machine)', m.status === 200 && Array.isArray(m.data.projects), String(m.status))
  const o = await fileOn(OWNER)
  ok('the owner files (200), as the owner', o.status === 200 && o.data.id === `${OTHER}-1` && filed().at(-1)?.actor === 'boss', JSON.stringify(o))
  ok('...on that project, with the title and assignee', filed().at(-1)?.argv[0] === OTHER && filed().at(-1)?.argv[1] === 'panel probe' && filed().at(-1)?.argv.includes('setup'), JSON.stringify(filed().at(-1)))

  step('the local side (no assertion) is as before')
  const g = await fileOn(undefined)
  ok('a guest (no name) is refused (401)', g.status === 401, String(g.status))
  const l = await fileOn(undefined, { cookie: 'board_user=alex' })
  ok('a self-named person files (200), as themselves', l.status === 200 && filed().at(-1)?.actor === 'alex', JSON.stringify(l))
  ok('...two items in all: the owner\'s and the local one', filed().length === 2)
} finally {
  s.kill(); bdSrv.close()
  if (fail) console.log(`--- board output\n${out.slice(-2000)}\n--- ops.log\n${opsLog().slice(-2000)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
