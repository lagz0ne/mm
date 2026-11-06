// A lead's run for one person, on that person's own long-term Claude token (sy-8n4w). Only bin/lead start --as calls
// this, and only mm run-as starts that (the owner's or mm's; refused in an agent's shell). The token comes on stdin
// (from mm, which opened it from the vault into the secrets tmpfs for this run only), never on a command line, in a
// file or in a log. The run is made as `paseo run` makes it, through Paseo's own client library, with the token added
// to that run's environment only: CLAUDE_CODE_OAUTH_TOKEN, in the unmodified Claude Code binary.
//   node bin/lib/run-as.mjs <person> <paseo run options...> <prompt>    (the token on stdin)
// What else the run's environment gets, so nothing else signs its calls and its own commands can't read the token:
//   ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL empty (a box's mm.ai key and URL, or any other, are not
//   used: the person's token goes to the model's own API only), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (Claude Code strips
//   its credentials from the shells and hooks it runs), MM_PERSON=<person>.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const die = (m, code = 1) => { console.error(`lead: ${m}`); process.exit(code) }
if (process.env.CLAUDECODE) die("--as runs on a person's own Claude token: only mm run-as starts it, never an agent")
const [person, ...args] = process.argv.slice(2)
if (!/^[a-z][a-z0-9._-]{1,31}$/.test(person || '')) die(`not a person's name: ${person}`, 2)
let token = ''
try { token = fs.readFileSync(0, 'utf8').split('\n')[0].trim() } catch {}
if (!/^sk-ant-oat01-[A-Za-z0-9_-]{40,400}$/.test(token)) die(`no Claude token came for ${person} (or not one in a token's shape): no run`)
const scrub = (s) => String(s ?? '').split(token).join('[token]')

// the options bin/lead gives `paseo run`
const o = { wait: true, env: [], label: [] }
let prompt
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => { if (i + 1 >= args.length) die(`${a} needs a value`, 2); return args[++i] }
  if (a === '--no-wait') o.wait = false
  else if (a === '-q') o.quiet = true
  else if (a === '--title') o.title = v()
  else if (a === '--provider') o.provider = v()
  else if (a === '--mode') o.mode = v()
  else if (a === '--workspace') o.workspace = v()
  else if (a === '--cwd') o.cwd = v()
  else if (a === '--env') o.env.push(v())
  else if (a === '--label') o.label.push(v())
  else if (i === args.length - 1 && !a.startsWith('-')) prompt = a
  else die(`unknown option ${a}`, 2)
}
if (!prompt) die('no prompt', 2)
const SET_HERE = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_SUBPROCESS_ENV_SCRUB|MM_PERSON)=/
o.env = [...o.env.filter((e) => !SET_HERE.test(e)), `CLAUDE_CODE_OAUTH_TOKEN=${token}`, 'ANTHROPIC_API_KEY=', 'ANTHROPIC_AUTH_TOKEN=', 'ANTHROPIC_BASE_URL=',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1', `MM_PERSON=${person}`]

// Paseo's CLI package, from the paseo bin/lead uses (as box/paseo-join.mjs finds it)
let bin = process.env.PASEO_BIN || ''
if (!bin || !bin.includes('/')) { try { bin = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', bin || 'paseo'], { encoding: 'utf8' }).trim() } catch { die('no paseo on this machine') } }
let cli = fs.realpathSync(bin)
const isCli = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === '@getpaseo/cli' } catch { return false } }
while (cli !== path.dirname(cli) && !isCli(cli)) cli = path.dirname(cli)
if (!isCli(cli)) die(`can't find Paseo's package from ${bin}`)
try {
  const { runRunCommand } = await import(pathToFileURL(path.join(cli, 'dist', 'commands', 'agent', 'run.js')).href)
  const { selectDaemonTarget } = await import(pathToFileURL(path.join(cli, 'dist', 'utils', 'daemon-target.js')).href)
  o.daemonTarget = selectDaemonTarget({}, process.env)
  const r = await runRunCommand(prompt, o)
  console.log(r?.data?.agentId ?? r?.data?.id ?? '')
  process.exit(0)
} catch (e) { die(`paseo did not start the run: ${scrub(e?.message || e?.code || e)}`) }
