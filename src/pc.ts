// The machine's one process-compose: API on ~/.mm/pc.sock, started at boot by one systemd user unit (mm-pc.service).
// Projects are added as namespaces later (`mm new` / `mm up`); it starts empty and stays up (--keep-project).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { apiConfigured } from './apistate'
import { personRunsConfigured } from './personruns'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, hasSystemdUser, portlessDir, run, servicePath, toolEnv, which } from './env'
import { MM_LOG_CONFIG, obsProcesses } from './obs'
import { expand, machineInputs } from './inputs'
import { daemonEnv, homeRefusal, listenRefusal, managedHome, paseoManaged, socketPath, TOKEN_INPUT, tokenSource } from './paseo'
import { MACHINE_SCOPE } from './vault'
import { frontEnabled } from './front'

const BASE = join(DIRS.pc, 'base.yaml'), PROJECTS = join(DIRS.pc, 'projects')
const UNIT_DIR = join(HOME, '.config', 'systemd', 'user')

export const answering = () => run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'state'], { timeoutMs: 10_000 }).ok

/** Machine-level processes (namespace mm): the portless proxy that gives every project's HTTP services their names. */
export function writeBase() {
  const pp = Number(getPath(loadConfig(), 'portless_port') ?? 1355)
  const mm = which('mm') || join(DIRS.bin, 'mm')
  // front.enabled: mm's own front (src/front.ts) takes portless_port, on 127.0.0.1 and ::1 only; portless is not
  // started. Off (the default): portless, as before (the rollback)
  const processes: Record<string, unknown> = frontEnabled() ? {
    'mm.front': {
      namespace: 'mm', command: `${mm} front serve --port ${pp}`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
      log_location: join(DIRS.pc, 'front.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 },
    },
  } : which('portless') ? {
    'mm.portless': {
      namespace: 'mm', command: `portless proxy start --foreground --port ${pp} --no-tls`,
      environment: [`PATH=${servicePath()}`, 'PORTLESS_SYNC_HOSTS=0', `PORTLESS_STATE_DIR=${portlessDir()}`],
      log_location: join(DIRS.pc, 'portless.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 },
    },
  } : {}
  processes['mm.cron'] = { namespace: 'mm', command: `${mm} cron`, environment: [`PATH=${servicePath()}`], log_location: join(DIRS.pc, 'cron.log'), log_configuration: MM_LOG_CONFIG,
    availability: { restart: 'always', backoff_seconds: 5 } }   // every project's schedules (process-compose has no scheduler)
  // the sign-in gateway for every board (docs/auth-gateway.md); its state is under $MM_HOME/auth. Off until the machine
  // turns it on (`mm config set auth.enabled true`): a new listener on bind_host is an exposure change (t2, ops).
  if (getPath(loadConfig(), 'auth.enabled') === true || getPath(loadConfig(), 'auth.enabled') === 'true') processes['mm.auth'] = { namespace: 'mm', command: `${mm} auth serve`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
    log_location: join(DIRS.pc, 'auth.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
    readiness_probe: { exec: { command: `test -S ${join(DIRS.mm, 'run', 'auth.sock')}` }, period_seconds: 3, failure_threshold: 20 } }
  // the AI gateway for every box (src/ai.ts, sy-b15.10): one socket per box, no TCP port. Off until the machine turns it
  // on (`mm config set ai.enabled true`) and the owner fills its upstream key (`mm fill ai-upstream-key`).
  const ai = getPath(loadConfig(), 'ai.enabled')
  if (ai === true || ai === 'true') processes['mm.ai'] = { namespace: 'mm', command: `${mm} ai serve`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
    log_location: join(DIRS.pc, 'ai.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 } }
  // the project API for every box (src/api.ts, sy-b15.8): one socket per box, the owner's approve socket, no TCP port.
  // Off until the machine turns it on (`mm config set api.enabled true`; t2: it changes the approval path). Person runs
  // (wake.person_runs) need it too: a box asks for one there (src/boxruns.ts, sy-9618); the four calls stay off then.
  if (apiConfigured() || personRunsConfigured()) processes['mm.api'] = { namespace: 'mm', command: `${mm} api serve`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
    log_location: join(DIRS.pc, 'api.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
    readiness_probe: { exec: { command: `test -S ${join(DIRS.mm, 'api', 'approve.sock')}` }, period_seconds: 3, failure_threshold: 20 } } // never a test's MM_API_DIR
  // the machine's Paseo (src/paseo.ts, sy-11g): the agent daemon the host leads run on, from mm's own npm, its home
  // $MM_HOME/paseo/system (0700; `mm paseo migrate` copies an older ~/.paseo there). Off until the machine turns it on
  // (`mm config set paseo.managed true`, with the old unit stopped: ops, in a window with the owner). umask 077: its
  // logs and state hold agent activity. The agents' login: the machine's Claude token, from the vault once sealed there,
  // else read from its file at the start (the old unit had it in its environment); each lead's CLAUDE_CONFIG_DIR comes with its start (bin/lead). No relay,
  // web UI or listen setting is forced unless paseo.relay / paseo.web_ui / paseo.listen say so: the home's config.json
  // (the old daemon's, copied) keeps deciding, and the app can still change them.
  if (paseoManaged()) {
    // its home: paseo.home (an existing home under mm, used as is) or mm's paseo/system (sy-11g #14)
    const home = managedHome(), env = daemonEnv(), bin = join(DIRS.npm, 'bin', 'paseo'), badHome = homeRefusal(home)
    if (!badHome) { mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(join(home, '..'), 0o700); chmodSync(home, 0o700) }
    const l = env.PASEO_LISTEN, sockFile = socketPath(l), sock = !!sockFile
    // its socket's folder (sy-nli): mm's run/ (the default) made 0700, as mm doctor's `mode ~/.mm` wants it; a socket
    // configured elsewhere under mm gets its folder made 0700 too; one outside mm is the machine's to make
    if (sockFile && !listenRefusal(l) && !relative(DIRS.mm, dirname(sockFile)).startsWith('..')) {
      mkdirSync(dirname(sockFile), { recursive: true, mode: 0o700 }); chmodSync(dirname(sockFile), 0o700)
    }
    // the agents' Claude token (sy-nli): sealed in the vault, `mm vault run _machine` opens it into a new memory-backed
    // file for each start and the shell removes it once read; else the input's file, read at each start, as before.
    // Either way only a path is passed (the vault's: made at the start, never in this file), the value only in the
    // daemon's environment
    const vaulted = tokenSource() === 'vault', tokVar = vaulted ? 'CLAUDE_OAUTH_TOKEN_FILE' : 'MM_PASEO_TOKEN_FILE'
    const tokenEnv = vaulted ? {} : { MM_PASEO_TOKEN_FILE: expand(String(machineInputs()[TOKEN_INPUT]?.path || '')) }
    const readToken = `[ -r "$$${tokVar}" ] && export CLAUDE_CODE_OAUTH_TOKEN="$$(cat "$$${tokVar}")";${vaulted ? ` rm -f "$$${tokVar}";` : ''} unset ${tokVar}`
    const daemon = `sh -c 'umask 077; ${readToken}; exec ${bin} daemon run'`
    // a listen address off loopback, or a home outside mm's paseo/ folder, is refused (review sy-11g #12): the process
    // only says so (a fixed text, never the configured value on a command line) and stops; mm doctor's paseo row names
    // the value and the fix
    if (listenRefusal(l) || badHome) processes['mm.paseo'] = { namespace: 'mm',
      command: `sh -c 'echo "mm.paseo refused: paseo.listen is not 127.0.0.1:<port>, [::1]:<port> or a socket path, or paseo.home is not a folder in mm/paseo (mm doctor)" >&2; exit 1'`,
      environment: [`PATH=${servicePath()}`],
      log_location: join(DIRS.pc, 'paseo.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'no' } }
    else processes['mm.paseo'] = { namespace: 'mm',
      command: vaulted ? `${mm} vault run ${MACHINE_SCOPE} ${TOKEN_INPUT} -- ${daemon}` : daemon,
      environment: Object.entries({ PATH: servicePath(), HOME, MM_HOME: DIRS.mm, ...env, ...tokenEnv }).map(([k, v]) => `${k}=${v}`),
      log_location: join(DIRS.pc, 'paseo.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: sock ? `test -S ${sockFile}` : `curl -s -o /dev/null --max-time 2 http://${l}/` }, period_seconds: 3, failure_threshold: 40 } }
  }
  // sy-duj0: once at each start of the process manager (boot), every box project's full mm up, so no box runs as Docker
  // alone brought it back (an empty secrets folder Docker made). Exits when done; not restarted.
  processes['mm.boxes'] = { namespace: 'mm', command: `${mm} box boot`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
    log_location: join(DIRS.pc, 'boxes.log'), log_configuration: MM_LOG_CONFIG, availability: { restart: 'no' } }
  Object.assign(processes, obsProcesses())
  mkdirSync(DIRS.pc, { recursive: true })
  writeLauncher()
  writeFileSync(BASE, `# mm: the machine process manager. Projects join as namespaces (~/.mm/pc/projects/*.yaml).\nversion: "0.5"\n${Bun.YAML.stringify({ processes }, null, 2)}\n`)
}

/**
 * No systemd user session (a container): start the launcher in its own session with its output in a file. Not on
 * mm's pipes: when mm exits, a write to a closed pipe (SIGPIPE) would kill process-compose and orphan its children.
 */
function startDetached(launcher: string) {
  const out = join(DIRS.pc, 'mm-pc-up.out')
  run(['sh', '-c', 'setsid -f "$0" >>"$1" 2>&1 </dev/null', launcher, out], { timeoutMs: 10_000 })
}

/** Make sure the process manager answers (mm up / new call this): start it the way onboard set it up. */
export function pcRunning(): boolean {
  if (answering()) return true
  const launcher = join(DIRS.bin, 'mm-pc-up')
  if (hasSystemdUser()) run(['systemctl', '--user', 'start', 'mm-pc.service'], { timeoutMs: 30_000 })
  else if (existsSync(launcher)) startDetached(launcher)
  else return false
  for (let i = 0; i < 40; i++) { if (answering()) return true; Bun.sleepSync(250) }
  return answering()
}

/**
 * The launcher (mm-pc-up): loads the base file and every project file, so projects come back after a reboot or restart.
 * It exports the tools' folders under $MM_HOME (env.ts toolEnv): every process the process manager runs inherits them.
 * Written by onboard and again whenever the base file is (a change takes effect at the next restart); null without
 * process-compose.
 */
export function writeLauncher(): string | null {
  const pc = which('process-compose'); if (!pc) return null
  const launcher = join(DIRS.bin, 'mm-pc-up')
  mkdirSync(DIRS.bin, { recursive: true }); mkdirSync(DIRS.pcConfig, { recursive: true }) // else every CLI call logs a debug line
  const body = [
    '#!/bin/sh', '# Written by mm onboard: the machine process manager with the base file and every project file.',
    ...Object.entries(toolEnv()).map(([k, v]) => `export ${k}="${v}"`),
    `set -- -f "${BASE}"`, `for f in "${PROJECTS}"/*.yaml "${join(DIRS.pc, 'box-public')}"/*.yaml; do [ -e "$f" ] && set -- "$@" -f "$f"; done`, `rm -f "${DIRS.socket}"`,
    `exec "${pc}" up -t=false --keep-project -U -u "${DIRS.socket}" -L "${join(DIRS.pc, 'process-compose.log')}" "$@"`, '',
  ].join('\n')
  let now = ''; try { now = readFileSync(launcher, 'utf8') } catch {}
  if (now !== body) writeFileSync(launcher, body, { mode: 0o755 })
  return launcher
}

export async function ensurePc(): Promise<string> {
  mkdirSync(DIRS.pc, { recursive: true })
  writeBase()
  const launcher = writeLauncher()
  if (!launcher) throw new Error('process-compose is not installed')
  if (hasSystemdUser()) {
    mkdirSync(UNIT_DIR, { recursive: true })
    writeFileSync(join(UNIT_DIR, 'mm-pc.service'), [
      '# Written by mm onboard. The machine process manager: one process-compose, a namespace per project.',
      '[Unit]', 'Description=mm: process manager (process-compose)', 'After=network-online.target', '',
      '[Service]', `ExecStart=${launcher}`,
      'Environment=PATH=%h/.mm/bin:%h/.mm/npm/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin',
      'Restart=always', 'RestartSec=3', '', '[Install]', 'WantedBy=default.target', '',
    ].join('\n'))
    run(['systemctl', '--user', 'daemon-reload'])
    const r = run(['systemctl', '--user', 'enable', '--now', 'mm-pc.service'])
    if (!r.ok) throw new Error(`systemctl enable mm-pc: ${r.err.trim()}`)
  } else if (!answering()) startDetached(launcher)
  for (let i = 0; i < 40 && !answering(); i++) await Bun.sleep(250)
  if (!answering()) throw new Error('process-compose did not come up on ~/.mm/pc.sock (see ~/.mm/pc/process-compose.log)')
  return hasSystemdUser() ? 'mm-pc.service enabled and running' : 'running detached (no systemd user session: not started at boot)'
}
