// Where things live, and how to run things. Every path is derived from $HOME / $MM_HOME; nothing machine-specific is
// written here, and nothing else in mm (or the template, through .run/endpoints.json "dirs") assumes a folder.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
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
  portless: join(MM, 'portless'),          // the names proxy's state (PORTLESS_STATE_DIR; portless' own default: ~/.portless)
  pcConfig: join(MM, 'pc', 'config'),      // process-compose's settings folder (PROC_COMP_CONFIG; its default: ~/.config/process-compose)
}
/**
 * portless' state folder for what mm starts: $MM_HOME/portless; but the old ~/.portless while it is still a real folder
 * (not moved yet, or its move was refused). The proxy and every project's wrappers must share one folder, else the names
 * stop resolving; a link mm left there is the new folder.
 */
export function portlessDir(): string {
  const old = join(HOME, '.portless')
  try { if (lstatSync(old).isDirectory()) return old } catch {}
  return DIRS.portless
}
/**
 * The opened-secrets folder (sy-lt7c): where the vault opens secrets while they are used (a memory-backed folder). One
 * rule for every mm call, from a shell, an agent or the process manager: $MM_SECRETS_DIR (an override, for one call or
 * a test), else config.yaml `vault.secrets_dir` (the machine's choice, e.g. a `noswap` tmpfs the brain mounts), else
 * the user's runtime folder ($XDG_RUNTIME_DIR/mm/secrets: systemd's tmpfs). Only an absolute path (or ~/...) counts; any
 * other value is ignored here, and mm doctor names it. The mm-docker wrapper keeps its own root-owned `secrets` line
 * (it never reads this config); mm doctor checks that the two agree.
 */
export const SECRETS_KEY = 'vault.secrets_dir'
export const defaultSecretsDir = () => join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'mm', 'secrets')
const absPath = (v: unknown) => { const s = typeof v === 'string' ? v.trim().replace(/^~(?=\/)/, HOME) : ''; return s.startsWith('/') ? s.replace(/(.)\/+$/, '$1') : undefined }
/** config.yaml's `vault.secrets_dir` as written (undefined when unset), read on every call. */
export function secretsDirKey(): unknown {
  try { return ((Bun.YAML.parse(readFileSync(DIRS.config, 'utf8')) as { vault?: { secrets_dir?: unknown } } | null)?.vault?.secrets_dir) ?? undefined } catch { return undefined }
}
/** What a call without MM_SECRETS_DIR uses: the key, else the default. */
export function configuredSecretsDir(): { path: string; from: 'config' | 'default' } {
  const k = absPath(secretsDirKey())
  return k ? { path: k, from: 'config' } : { path: defaultSecretsDir(), from: 'default' }
}
export function secretsDir(): { path: string; from: 'env' | 'config' | 'default' } {
  const e = absPath(process.env.MM_SECRETS_DIR)
  return e ? { path: e, from: 'env' } : configuredSecretsDir()
}

/**
 * The environment that keeps the tools mm runs inside $MM_HOME: each one's own default is a folder in the home folder (or
 * /tmp). Set for mm's own calls (below), for every process the process manager runs (the launcher exports it; the
 * definitions carry the portless one), and npm's for mm's installs (src/install.ts).
 */
export const toolEnv = (): Record<string, string> => ({
  PORTLESS_STATE_DIR: portlessDir(),
  PROC_COMP_CONFIG: DIRS.pcConfig,
  PC_CLIENT_LOG_FILE: join(DIRS.pc, 'client.log'), // a client call's log; else /tmp/process-compose-<user>-client.log
  npm_config_cache: join(DIRS.npm, '.cache'),      // npm's cache and logs (a board's npm ci, mm's installs); else ~/.npm
  npm_config_update_notifier: 'false',             // else ~/.npm/_update-notifier-last-checked
  // the machine's Paseo once mm runs it (paseo.managed, src/paseo.ts): a `paseo` client finds its daemon by the pid lock
  // in PASEO_HOME (default ~/.paseo), so mm's own calls, every process under the process manager (wake, the board) and
  // the agents the daemon starts (they inherit its environment) look in mm's home. A box's services set their own.
  ...(paseoManagedRaw() ? { PASEO_HOME: join(MM, 'paseo', 'system') } : {}),
})
/** config.yaml's paseo.managed, read here without config.ts (it imports this file); src/paseo.ts has the real one. */
function paseoManagedRaw(): boolean {
  try { const v = (Bun.YAML.parse(readFileSync(join(MM, 'config.yaml'), 'utf8')) as { paseo?: { managed?: unknown } } | null)?.paseo?.managed; return v === true || v === 'true' } catch { return false }
}
for (const [k, v] of Object.entries(toolEnv())) process.env[k] ||= v

/**
 * Every path mm itself uses, or used, outside $MM_HOME: the one list `mm doctor` checks ("outside $MM_HOME") and
 * `mm onboard` / `mm doctor --fix` move from (never `mm up`). `allowed`: outside by design. `move`: mm moves it to `to`, once, by rename and
 * only into an empty place; `link`: a link is left at the old path while the process manager runs (its processes may
 * still use the old path until it restarts). `old`: mm no longer uses it, but doesn't move it (something not mm's may
 * still run from it): removed by hand. `later`: still used; its move is another item's. `theirs`: not mm's.
 */
export interface Outside {
  id: string; path: string; what: string
  use: 'allowed' | 'move' | 'old' | 'later' | 'theirs'
  to?: string; link?: boolean; note?: string
}
export function outsidePaths(): Outside[] {
  const h = (...p: string[]) => join(HOME, ...p)
  const legacy = one ? [] : (['projects', 'brain', 'system', 'backups', 'archive'] as const).map((k): Outside => ({
    id: `layout ${k}`, path: DIRS[k], what: `the ${k} folder (legacy layout)`, use: 'later', to: join(MM, k), note: 'the one-root move (the whole layout at once, by ops)' }))
  const runtime = secretsDir().path
  return [
    { id: 'boot unit', path: h('.config', 'systemd', 'user', 'mm-pc.service'), what: 'the systemd user unit that starts the process manager at boot', use: 'allowed' },
    { id: 'PATH line', path: h('.profile'), what: 'one PATH line (~/.mm/bin first)', use: 'allowed' },
    { id: 'PATH line', path: h('.bashrc'), what: 'one PATH line (~/.mm/bin first)', use: 'allowed' },
    { id: 'opened secrets', path: runtime, what: "secrets opened from the vault for services (memory only, gone at reboot)", use: 'allowed' },
    { id: 'portless state', path: h('.portless'), what: "the names proxy's routes and state", use: 'move', to: DIRS.portless, link: true },
    { id: 'process-compose config', path: h('.config', 'process-compose'), what: "process-compose's settings folder", use: 'move', to: DIRS.pcConfig },
    { id: 'npm tools (old prefix)', path: h('.npm-global'), what: 'paseo and portless from an older install', use: 'old', to: DIRS.npm,
      note: `mm runs its own from ${tilde(DIRS.npm)} (mm onboard installs them); remove it once nothing runs from it (the brain's paseo.service may)` },
    ...['node', 'process-compose', 'merman-cli', 'victoria-metrics', 'victoria-logs', 'victoria-traces'].map((t): Outside => ({
      id: `tool store ${t}`, path: h('.local', 'share', t), what: `${t} from an older install`, use: 'old', to: join(DIRS.tools, t),
      note: `mm runs its own from ${tilde(DIRS.tools)} (mm onboard installs it); remove it once nothing runs from it` })),
    { id: 'Paseo home', path: h('.paseo'), what: "the Paseo daemon's home (the brain's paseo.service today)", use: 'later', to: join(MM, 'paseo'), note: 'moves with mm.paseo (sy-nli)' },
    { id: 'Claude folder', path: h('.claude'), what: "the human's own Claude folder", use: 'theirs', note: `mm's agents use ${tilde(join(MM, 'claude'))}/<project>` },
    { id: 'claude (old install)', path: h('.local', 'bin', 'claude'), what: "the claude the install script put there (the human's own)", use: 'theirs', note: `mm runs its own from ${tilde(join(DIRS.tools, 'claude'))}` },
    ...legacy,
  ]
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

/**
 * The PATH of everything mm runs under the process manager (its own services, and each project's): mm's folders, then
 * the system's. Never the caller's PATH: an mm up from another shell (a lead's, a test's) would change every process's
 * definition, and process-compose restarts what changed, mm's own log shipper and names proxy among them (sy-heeh).
 */
export function servicePath(): string {
  return [DIRS.bin, join(DIRS.npm, 'bin'), join(HOME, '.local', 'bin'), join(HOME, '.npm-global', 'bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'].join(':')
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
