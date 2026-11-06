#!/usr/bin/env node
// bin/lib/paseo.mjs in an agent's shell (sy-e5i), hermetic: a stub paseo CLI (no SDK, no daemon) that logs its calls.
// With CLAUDECODE or PASEO_AGENT_ID set, send and archive refuse and never reach paseo; list still works (bin/lead
// start reads through it from the setup agent's shell). Outside an agent, and in the engine's own wake even under
// CLAUDECODE, send and archive go through.
//   node test/paseo-refuse.mjs          exit 0 = every check passed
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-refuse-'))
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }))
let pass = 0, fail = 0
const ok = (d, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${extra && !c ? `  (${extra})` : ''}`) }

// a project's bin/: the library as the template ships it, and a stand-in for the engine's wake that sends
fs.mkdirSync(path.join(T, 'p', 'bin', 'lib'), { recursive: true })
for (const f of ['paseo.mjs', 'svc.mjs']) fs.copyFileSync(path.join(SRC, 'template', 'bin', 'lib', f), path.join(T, 'p', 'bin', 'lib', f))
const caller = `import * as P from './lib/paseo.mjs'
const r = {}
for (const [k, f] of [['list', () => P.list()], ['send', () => P.send('a1', 'hi')], ['archive', () => P.archive('a1')]])
  try { await f(); r[k] = 'ok' } catch (e) { r[k] = e.message }
console.log(JSON.stringify(r))\n`
fs.writeFileSync(path.join(T, 'p', 'bin', 'wake'), caller)
fs.writeFileSync(path.join(T, 'p', 'bin', 'mine.mjs'), caller)           // a script of the agent's own, beside it
const LOG = path.join(T, 'paseo.log')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh\necho "$1" >>"${LOG}"\n[ "$1" = ls ] && echo '[]'\nexit 0\n`, { mode: 0o755 })

const run = (script, extra) => {
  fs.rmSync(LOG, { force: true })
  const env = { ...process.env, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', ...extra }
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete env[k]
  let out = ''; try { out = execFileSync('node', [script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { out = String(e.stdout || '') }
  let r = {}; try { r = JSON.parse(out.trim().split('\n').pop()) } catch {}
  let calls = []; try { calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  return { r, calls }
}
const mine = path.join(T, 'p', 'bin', 'mine.mjs'), wake = path.join(T, 'p', 'bin', 'wake')
const refused = (s) => /refused in an agent's shell/.test(s || '')

for (const [label, env] of [['CLAUDECODE=1', { CLAUDECODE: '1', PASEO_AGENT_ID: undefined }], ['PASEO_AGENT_ID set', { CLAUDECODE: undefined, PASEO_AGENT_ID: 'x1' }]]) {
  const a = run(mine, env)
  ok(`${label}: an agent's script: send refused`, refused(a.r.send), a.r.send)
  ok(`${label}: ...archive refused`, refused(a.r.archive), a.r.archive)
  ok(`${label}: ...and neither reached paseo`, !a.calls.includes('send') && !a.calls.includes('archive'), a.calls.join(','))
  ok(`${label}: ...list still works`, a.r.list === 'ok' && a.calls.includes('ls'), a.r.list)
  const w = run(wake, env)
  ok(`${label}: the engine's wake: send and archive go through`, w.r.send === 'ok' && w.r.archive === 'ok' && w.calls.includes('send') && w.calls.includes('archive'), JSON.stringify(w.r))
}
const n = run(mine, { CLAUDECODE: undefined, PASEO_AGENT_ID: undefined })
ok('outside an agent: send and archive go through', n.r.send === 'ok' && n.r.archive === 'ok' && n.calls.includes('send') && n.calls.includes('archive'), JSON.stringify(n.r))
let e = ''
try { execFileSync('node', ['--input-type=module', '-e', `const P = await import(${JSON.stringify(path.join(T, 'p', 'bin', 'lib', 'paseo.mjs'))}); await P.send('a1', 'hi')`],
  { env: { ...process.env, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', CLAUDECODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (x) { e = String(x.stderr || '') }
ok('CLAUDECODE=1: node -e importing it: send refused', refused(e), e.slice(0, 200))
const s = path.join(T, 'p', 'bin', 'wake-link')
fs.symlinkSync(wake, s)
const l = run(s, { CLAUDECODE: '1' })
ok('a link to the engine\'s wake counts as wake (real paths)', l.r.send === 'ok', l.r.send)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
