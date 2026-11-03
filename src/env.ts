// Where things live, and how to run things. Every path is derived from $HOME; nothing machine-specific is written here.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.HOME || homedir()
export const MM = process.env.MM_HOME || join(HOME, '.mm')
export const DIRS = {
  mm: MM,
  bin: join(MM, 'bin'),
  tools: join(MM, 'tools'),
  npm: join(MM, 'npm'),
  pc: join(MM, 'pc'),
  config: join(MM, 'config.yaml'),
  socket: join(MM, 'pc.sock'),
  projects: join(HOME, 'projects'),
  brain: join(HOME, 'brain'),
}

// Architecture names as each upstream spells them.
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
export const archNames = {
  node: ARCH, // node-v<ver>-linux-x64
  goarch: ARCH === 'x64' ? 'amd64' : 'arm64',
  rustarch: ARCH === 'x64' ? 'x86_64' : 'aarch64',
}

/** PATH that also sees mm's own tools and the usual per-user bins. */
export function toolPath(): string {
  const extra = [DIRS.bin, join(DIRS.npm, 'bin'), join(HOME, '.local', 'bin'), join(HOME, '.npm-global', 'bin')]
  return [...extra, ...(process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')].filter((p, i, a) => a.indexOf(p) === i).join(':')
}

export function which(cmd: string): string | null {
  for (const dir of toolPath().split(':')) {
    const p = join(dir, cmd)
    if (existsSync(p)) return p
  }
  return null
}

export interface RunResult { ok: boolean; code: number; out: string; err: string }
/** Run argv (never a shell string) with mm's PATH. */
export function run(argv: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {}): RunResult {
  try {
    const p = Bun.spawnSync(argv, {
      cwd: opts.cwd, env: { ...process.env, PATH: toolPath(), ...opts.env },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore', timeout: opts.timeoutMs ?? 120_000,
    })
    return { ok: p.exitCode === 0, code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() }
  } catch (e) {
    return { ok: false, code: -1, out: '', err: String(e) }
  }
}

export const isRoot = () => process.getuid?.() === 0
/** Prefix for commands that need root: nothing as root, `sudo -n` otherwise (never prompts). */
export const asRoot = (argv: string[]) => (isRoot() ? argv : ['sudo', '-n', ...argv])
export const hasSystemdUser = () => run(['systemctl', '--user', 'is-system-running'], { timeoutMs: 5000 }).out.trim() !== '' &&
  !/offline|unknown/.test(run(['systemctl', '--user', 'is-system-running'], { timeoutMs: 5000 }).out)
