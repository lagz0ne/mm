#!/usr/bin/env node
// bin/sentinel's assist:<user> source (sy-6dk, sy-la6o), hermetic: a scratch system board (the template's bin and the
// system profile's), a fake bd-serve in this process, a stub mm (no projects, no errors), no brain, and a stub claude
// that only records that it was called. The sentinel runs the board's own `bin/assist tools <user> --chat`, which reads
// the assistant's files and runs nothing. Proves: Skill only -> no item, claude never started; a tool its settings
// don't deny -> one P1 incident for ops (key assist:<user>, the extra tool in it), not opened twice; an unknown MCP
// server and a start hook -> an incident naming them, and neither ran (no mark file); an assistant whose mode is off
// is not audited; back to Skill -> closed; the audit failing -> sentinel:assistants, the open assist: item left as is.
//   node test/sentinel-assist.mjs          exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-assist-'))
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }))
let pass = 0, fail = 0
const ok = (d, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${extra && !c ? `  (${extra})` : ''}`) }

// the board
const B = path.join(T, 'sys'), HOME = path.join(T, 'home')
fs.mkdirSync(HOME, { recursive: true })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.cpSync(path.join(SRC, 'template', 'profiles', 'system', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.writeFileSync(path.join(B, '.mm-answers.yaml'), 'project: sysqa\nclient: system\nname: qa\nprofile: system\n')
for (const [u, mode] of [['alex', 'always'], ['bo', 'off']]) {
  fs.mkdirSync(path.join(B, 'assistants', u), { recursive: true })
  fs.writeFileSync(path.join(B, 'assistants', u, 'CLAUDE.md'), `# Assistant for ${u}\n`); fs.writeFileSync(path.join(B, 'assistants', u, 'mode'), `${mode}\n`)
}
fs.mkdirSync(path.join(B, 'assistants', '_template'), { recursive: true }); fs.writeFileSync(path.join(B, 'assistants', '_template', 'CLAUDE.md'), '# {user}\n')
// stubs: claude (its args per folder, for "who was audited"), mm, an empty brain
const CALLS = path.join(T, 'claude-calls')
fs.writeFileSync(path.join(T, 'claude'), `#!/bin/sh\necho "$(basename "$PWD") $*" >>"${CALLS}"\nexit 1\n`, { mode: 0o755 })
// alex's settings as config-check renders them (every built-in tool and mcp__paseo denied, Skill allowed)
const { DENY } = await import(path.join(B, 'bin', 'lib', 'assist.mjs'))
const A = path.join(B, 'assistants', 'alex'), SET = path.join(A, '.claude', 'settings.json')
fs.mkdirSync(path.dirname(SET), { recursive: true })
const settings = (deny = DENY, extra = {}) => fs.writeFileSync(SET, JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: ['Skill'], deny }, ...extra }))
settings()
const MARK = path.join(T, 'mark'), marked = () => fs.readdirSync(T).filter((f) => f.startsWith('mark'))
fs.writeFileSync(path.join(T, 'mm'), `#!/bin/sh\ncase "$1" in ls|obs) [ "$2" = status ] || echo '[]' ;; esac\nexit 0\n`, { mode: 0o755 })
fs.mkdirSync(path.join(T, 'brain'))

// fake bd-serve: what the sentinel uses
const items = new Map(); let next = 1
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let body = ''; for await (const ch of req) body += ch
  const b = body ? JSON.parse(body) : {}, json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  let m
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') { const l = u.searchParams.get('label'); return json({ items: [...items.values()].filter((i) => !l || i.labels.includes(l)) }) }
  if (req.method === 'POST' && u.pathname === '/v0/beads/issues') { const id = `sy-a${next++}`; items.set(id, { ...b, id, status: 'open', comments: [] }); return json({ id }) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname))) { items.get(m[1])?.comments.push(b.text); return json({}) }
  if (req.method === 'POST' && (m = /^\/v0\/beads\/issues\/([\w.-]+):close$/.exec(u.pathname))) { const i = items.get(m[1]); if (i) i.status = 'closed'; return json({}) }
  json({ error: 'no route' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))

const ENV = { PATH: `${T}:${process.env.PATH}`, HOME, MM_HOME: path.join(HOME, '.mm'), CLAUDE_MANAGED_DIR: path.join(T, 'no-managed'), MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  MM_BIN: path.join(T, 'mm'), SENTINEL_BRAIN: path.join(T, 'brain'), SENTINEL_STATE: path.join(T, 'sentinel.json'), SENTINEL_CONFIG: path.join(T, 'none.json'),
  SVC_URL_BD_SERVE: `http://127.0.0.1:${srv.address().port}`, CLAUDE_BIN: path.join(T, 'claude'), ASSIST_TIMEOUT_MS: '10000' }
const sentinel = (env = {}) => new Promise((resolve) => {
  fs.rmSync(CALLS, { force: true })
  const p = spawn('node', [path.join(B, 'bin', 'sentinel')], { cwd: B, env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
  p.on('close', (code) => resolve({ code, out, calls: fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8') : '' }))
})
const key = (k) => [...items.values()].filter((i) => (i.description || '').includes(`sentinel key: \`${k}\``))
const openK = (k) => key(k).filter((i) => i.status !== 'closed')

let r = await sentinel()
ok('Skill only: the sentinel runs, no assist item', r.code === 0 && key('assist:alex').length === 0, r.out.slice(-300))
ok('...and the pass started no claude (the audit reads files)', r.calls === '', r.calls)

settings(DENY.filter((t) => t !== 'Bash'))
r = await sentinel()
const it = openK('assist:alex')
ok('a tool beyond Skill: one item opened', it.length === 1, r.out.slice(-300))
ok('...P1, an incident for ops, labelled sentinel', it[0]?.priority === 1 && it[0]?.assignee === 'ops' && it[0]?.labels.includes('incident') && it[0]?.labels.includes('sentinel'))
ok('...it names the extra tool and the fix', /Bash/.test(it[0]?.description || '') && /assist stop alex/.test(it[0]?.description || ''), it[0]?.description)
r = await sentinel()
ok('still there: not opened twice', key('assist:alex').length === 1)

r = await sentinel({ MM_HOME: path.join(T, 'claude') }) // a file, not a folder: the audit itself fails (exit 1, not 5)
ok('the audit fails: sentinel:assistants opened', openK('sentinel:assistants').length === 1, r.out.slice(-300))
ok('...and the assist:alex item is left open', openK('assist:alex').length === 1)

settings()
r = await sentinel()
ok('back to Skill only: assist:alex closed', key('assist:alex').length === 1 && openK('assist:alex').length === 0, r.out.slice(-300))
ok('...and sentinel:assistants closed', openK('sentinel:assistants').length === 0)

// an MCP server and a start hook that would each leave a mark file if anything started them
settings(DENY, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${MARK}-hook` }] }] } })
fs.writeFileSync(path.join(A, '.mcp.json'), JSON.stringify({ mcpServers: { gmail: { command: 'sh', args: ['-c', `touch ${MARK}-mcp`] } } }))
r = await sentinel()
const d = openK('assist:alex')[0]?.description || ''
ok('an unknown MCP server and a start hook: the incident names them (unverified tools, hook)', /mcp:gmail \(unverified tools\)/.test(d) && /hook:SessionStart/.test(d), d || r.out.slice(-300))
ok('...and neither ran: no mark file, no claude', marked().length === 0 && r.calls === '', `${marked()} ${r.calls}`)
fs.rmSync(path.join(A, '.mcp.json')); settings()
r = await sentinel()
ok('...cleared: closed again', openK('assist:alex').length === 0, r.out.slice(-300))

srv.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
