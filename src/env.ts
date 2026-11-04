// Where things live, and how to run things. Every path is derived from $HOME / $MM_HOME; nothing machine-specific is
// written here, and nothing else in mm (or the template, through .run/endpoints.json "dirs") assumes a folder.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const HOME = process.env.HOME || homedir()
export const MM = process.env.MM_HOME || join(HOME, '.mm')
/**
 * The layout. `one-root`: everything mm manages lives under $MM_HOME (config.yaml, vault/, brain/, system/,
 * projects/<client>/<name>/, backups/, archive/; bin/ tools/ npm/ pc/ data/ are disposable). `legacy`: the older
 * spread-out one (~/projects, ~/brain, ~/brain/system, ~/.local/share/{backups,mm/archive}). Chosen once by onboard
 * (config.yaml `layout:`; one-root on a box without the older folders) or MM_LAYOUT; a box keeps its layout until moved.
 */
export const LAYOUT: 'one-root' | 'legacy' = (() => {
  const cfg = join(MM, 'config.yaml')
  const v = process.env.MM_LAYOUT || (() => { try { return /^layout:\s*["']?([\w-]+)/m.exec(readFileSync(cfg, 'utf8'))?.[1] } catch { return undefined } })()
  if (v) return v === 'one-root' ? 'one-root' : 'legacy'
  // not chosen yet: a fresh box (no config, none of the older folders) gets one-root; onboard then writes it down
  return !existsSync(cfg) && !existsSync(join(HOME, 'projects')) && !existsSync(join(HOME, 'brain')) ? 'one-root' : 'legacy'
})()
const one = LAYOUT === 'one-root'
export const DIRS = {
  mm: MM,
  bin: join(MM, 'bin'),
  tools: join(MM, 'tools'),
  npm: join(MM, 'npm'),
  pc: join(MM, 'pc'),
  data: join(MM, 'data'),
  config: join(MM, 'config.yaml'),
  socket: join(MM, 'pc.sock'),
  vault: join(MM, 'vault'),
  projects: one ? join(MM, 'projects') : join(HOME, 'projects'),
  brain: one ? join(MM, 'brain') : join(HOME, 'brain'),
  system: one ? join(MM, 'system') : join(HOME, 'brain', 'system'),
  backups: one ? join(MM, 'backups') : join(HOME, '.local', 'share', 'backups'),
  archive: one ? join(MM, 'archive') : join(HOME, '.local', 'share', 'mm', 'archive'),
}
/** The folders a project's engine scripts need (written to .run/endpoints.json as "dirs"; never derived there). */
export const engineDirs = () => ({ mm: DIRS.mm, brain: DIRS.brain, system: DIRS.system, projects: DIRS.projects, backups: DIRS.backups, vault: DIRS.vault, layout: LAYOUT })
// what mm runs (bin/init, config-check, cron jobs, ...) learns the layout from here; services read endpoints.json
for (const [k, v] of [['MM_HOME', DIRS.mm], ['MM_BRAIN', DIRS.brain], ['MM_SYSTEM', DIRS.system], ['MM_PROJECTS', DIRS.projects], ['MM_BACKUPS', DIRS.backups]] as const)
  process.env[k] ||= v
/** A path for people: ~ for the home folder. */
export const tilde = (p: string) => (p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p)

/**
 * A path as the kernel sees it: ~ expanded, symlinks resolved, a /proc " (deleted)" suffix dropped. A path that no
 * longer exists resolves through its nearest existing ancestor. Compare and key paths only in this form: the same
 * folder can be spelled through a symlink (e.g. ~/projects -> ~/.mm/projects) and /proc always shows the real one.
 */
export function canon(p: string): string {
  let q = p.replace(/ \(deleted\)$/, '').replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, '') || '/'
  const tail: string[] = []
  for (;;) {
    try { return join(realpathSync(q), ...tail.reverse()) } catch {}
    const up = dirname(q); if (up === q) return join(q, ...tail.reverse())
    tail.push(basename(q)); q = up
  }
}
/** Is `p` the folder `root` or inside it, however either is spelled? Only absolute (or ~) paths can be inside. */
export function within(p: string, root: string): boolean {
  if (!p || !(p.startsWith('/') || p.startsWith('~'))) return false
  const a = canon(p), r = canon(root)
  return a === r || a.startsWith(r === '/' ? '/' : `${r}/`)
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
