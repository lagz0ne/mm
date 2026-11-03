// The machine's one process-compose: API on ~/.mm/pc.sock, started at boot by one systemd user unit (mm-pc.service).
// Projects are added as namespaces later (`mm new` / `mm up`); it starts empty and stays up (--keep-project).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, hasSystemdUser, run, toolPath, which } from './env'
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
      environment: [`PATH=${toolPath()}`, 'PORTLESS_SYNC_HOSTS=0'],
      log_location: join(DIRS.pc, 'portless.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 },
    },
  } : {}
  Object.assign(processes, obsProcesses())
  writeFileSync(BASE, `# mm: the machine process manager. Projects join as namespaces (~/.mm/pc/projects/*.yaml).\nversion: "0.5"\n${Bun.YAML.stringify({ processes }, null, 2)}\n`)
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
    `set -- -f "${BASE}"`, `for f in "${PROJECTS}"/*.yaml; do [ -e "$f" ] && set -- "$@" -f "$f"; done`, `rm -f "${DIRS.socket}"`,
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
  } else if (!answering()) {
    // no systemd user session (e.g. a container): start it detached for now
    // setsid -f: its own session, so it outlives mm and any terminal
    run(['setsid', '-f', launcher], { timeoutMs: 10_000 })
  }
  for (let i = 0; i < 40 && !answering(); i++) await Bun.sleep(250)
  if (!answering()) throw new Error('process-compose did not come up on ~/.mm/pc.sock (see ~/.mm/pc/process-compose.log)')
  return hasSystemdUser() ? 'mm-pc.service enabled and running' : 'running detached (no systemd user session: not started at boot)'
}
