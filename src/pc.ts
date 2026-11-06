// The machine's one process-compose: API on ~/.mm/pc.sock, started at boot by one systemd user unit (mm-pc.service).
// Projects are added as namespaces later (`mm new` / `mm up`); it starts empty and stays up (--keep-project).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, hasSystemdUser, run, servicePath, toolPath, which } from './env'
import { obsProcesses } from './obs'

const BASE = join(DIRS.pc, 'base.yaml'), PROJECTS = join(DIRS.pc, 'projects')
const UNIT_DIR = join(HOME, '.config', 'systemd', 'user')

export const answering = () => run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'state'], { timeoutMs: 10_000 }).ok

/** Machine-level processes (namespace mm): the portless proxy that gives every project's HTTP services their names. */
export function writeBase() {
  const pp = Number(getPath(loadConfig(), 'portless_port') ?? 1355)
  const processes: Record<string, unknown> = which('portless') ? {
    'mm.portless': {
      namespace: 'mm', command: `portless proxy start --foreground --port ${pp} --no-tls`,
      environment: [`PATH=${servicePath()}`, 'PORTLESS_SYNC_HOSTS=0'],
      log_location: join(DIRS.pc, 'portless.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 },
    },
  } : {}
  const mm = which('mm') || join(DIRS.bin, 'mm')
  processes['mm.cron'] = { namespace: 'mm', command: `${mm} cron`, environment: [`PATH=${servicePath()}`], log_location: join(DIRS.pc, 'cron.log'),
    availability: { restart: 'always', backoff_seconds: 5 } }   // every project's schedules (process-compose has no scheduler)
  // the sign-in gateway for every board (docs/auth-gateway.md); its state is under $MM_HOME/auth. Off until the machine
  // turns it on (`mm config set auth.enabled true`): a new listener on bind_host is an exposure change (t2, ops).
  if (getPath(loadConfig(), 'auth.enabled') === true || getPath(loadConfig(), 'auth.enabled') === 'true') processes['mm.auth'] = { namespace: 'mm', command: `${mm} auth serve`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
    log_location: join(DIRS.pc, 'auth.log'), availability: { restart: 'always', backoff_seconds: 3 },
    readiness_probe: { exec: { command: `test -S ${join(DIRS.mm, 'run', 'auth.sock')}` }, period_seconds: 3, failure_threshold: 20 } }
  // the AI gateway for every box (src/ai.ts, sy-b15.10): one socket per box, no TCP port. Off until the machine turns it
  // on (`mm config set ai.enabled true`) and the owner fills its upstream key (`mm fill ai-upstream-key`).
  const ai = getPath(loadConfig(), 'ai.enabled')
  if (ai === true || ai === 'true') processes['mm.ai'] = { namespace: 'mm', command: `${mm} ai serve`, environment: [`PATH=${servicePath()}`, `HOME=${HOME}`, `MM_HOME=${DIRS.mm}`],
    log_location: join(DIRS.pc, 'ai.log'), availability: { restart: 'always', backoff_seconds: 3 } }
  Object.assign(processes, obsProcesses())
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

export async function ensurePc(): Promise<string> {
  mkdirSync(DIRS.pc, { recursive: true })
  mkdirSync(join(HOME, '.config', 'process-compose'), { recursive: true }) // else every CLI call logs a debug line
  writeBase()
  const pc = which('process-compose')
  if (!pc) throw new Error('process-compose is not installed')
  // the launcher loads the base file and every project file, so projects come back after a reboot or restart
  const launcher = join(DIRS.bin, 'mm-pc-up')
  mkdirSync(DIRS.bin, { recursive: true })
  writeFileSync(launcher, [
    '#!/bin/sh', '# Written by mm onboard: the machine process manager with the base file and every project file.',
    `set -- -f "${BASE}"`, `for f in "${PROJECTS}"/*.yaml "${join(DIRS.pc, 'box-public')}"/*.yaml; do [ -e "$f" ] && set -- "$@" -f "$f"; done`, `rm -f "${DIRS.socket}"`,
    `exec "${pc}" up -t=false --keep-project -U -u "${DIRS.socket}" -L "${join(DIRS.pc, 'process-compose.log')}" "$@"`, '',
  ].join('\n'), { mode: 0o755 })
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
