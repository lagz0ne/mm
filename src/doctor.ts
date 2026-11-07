// mm doctor: check this machine against the manifest. Never changes anything (`mm doctor --fix` is src/outside.ts).
import { existsSync, readdirSync, readFileSync, type Stats, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { type Config, getPath, loadConfig, when } from './config'
import { canon, configuredSecretsDir, DIRS, HOME, hasSystemdUser, isRoot, run, SECRETS_KEY, secretsDir, secretsDirKey, tilde, which } from './env'
import { machineSecretPaths, needs, secretOnlyDirs } from './inputs'
import { AI_DIR } from './ai'
import { API_DIR } from './apistate'
import { boxish, engineRefusal, listProjects } from './project'
import { engineDrift } from './lifecycle'
import { manifest, type Tool } from './manifest'
import { directDeps, installedProblem, lockBin, shipped } from './npmlock'
import * as vault from './vault'
import { outsideChecks } from './outside'
import { daemonCheck as paseoDaemonCheck } from './paseo'
import { loadConf as approveConf, problems as ledgerProblems } from '../template/bin/lib/ledger.mjs'

export type Status = 'ok' | 'warn' | 'fail' | 'skip'
export interface Check { layer: string; item: string; status: Status; detail: string; fix?: string }

const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME)
/** A board's name in doctor's items (`bd quiet <id>`): system, or <client>/<name>. */
const boardId = (root: string) => basename(root) === 'system' || root === DIRS.system ? 'system' : basename(dirname(root)) + '/' + basename(root)

/** The throwaway project(s) the failing checks name, when every failing check names one (a test planted the fault on
 *  purpose, e.g. a bd hook: mm doctor's span is then marked mm_throwaway and stays out of mm obs errors, sy-ha9x);
 *  '' when nothing fails or any failure is the machine's or a real project's. Warnings never fail doctor, so they
 *  don't count. Throwaway comes from the project's answers (mm writes them; no lead or box can), as in cli.ts. */
export function throwawayOnly(checks: Check[]): string {
  const failing = checks.filter((c) => c.status === 'fail')
  if (!failing.length) return ''
  const owner = new Map<string, string>()   // item -> throwaway project, for the items doctor makes per project
  for (const p of listProjects()) {
    if (!p.throwaway || p.root === '?') continue
    owner.set(`engine ${p.project}`, p.project); owner.set(`bd quiet ${boardId(expand(p.root))}`, p.project)
  }
  const named = failing.map((c) => owner.get(c.item))
  return named.every(Boolean) ? [...new Set(named)].join(',') : ''
}

/** First x.y[.z] in a version string. */
export function parseVersion(s: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s)
  return m ? `${m[1]}.${m[2]}.${m[3] ?? 0}` : null
}
export function atLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number), b = (parseVersion(min) ?? min).split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) }
  return true
}

export function checkTool(name: string, t: Tool, c: Config): Check {
  const row = (status: Status, detail: string, fix?: string): Check => ({ layer: 'tool', item: name, status, detail, fix })
  if (!when(t.when, c)) return row('skip', `only when ${t.when}`)
  const path = which(name)
  if (!path) {
    if (t.optional || t.needed_by) return row(t.optional ? 'skip' : 'warn', `not installed${t.needed_by ? ` (needed by ${t.needed_by})` : ' (optional)'}`)
    return row(t.required ? 'fail' : 'warn', 'not installed', t.install ? 'mm onboard' : `install ${name}`)
  }
  if (t.install?.kind === 'npm-lock') {
    // installed from mm's lock (sy-nli): the lock this mm ships, its direct dependencies' versions, and run from there
    const bad = installedProblem(t.install.lock, path)
    if (bad) return row('fail', bad, 'mm onboard (installs it from the lock)')
  }
  if (!t.version) return row('ok', path.replace(HOME, '~'))
  const r = run(t.version, { timeoutMs: 15_000 })
  const v = parseVersion(r.out + r.err)
  if (!v) return row(t.min ? 'warn' : 'ok', `${path.replace(HOME, '~')} (version unreadable)`)
  if (t.min && !atLeast(v, t.min)) return row('fail', `${v} < ${t.min}`, 'mm onboard')
  return row('ok', `${v}  ${path.replace(HOME, '~')}`)
}

/** A tool now installed from mm's lock whose old `npm install -g` copy is still in ~/.mm/npm/bin (sy-nli): nothing of
 *  mm runs it any more, an older unit may. Its own row, a warn: the tool's row stays ok, so onboard doesn't reinstall. */
export function oldNpmCopy(name: string, t: Tool): Check | null {
  if (t.install?.kind !== 'npm-lock') return null
  const old = join(DIRS.npm, 'bin', name)
  if (!existsSync(old)) return null
  return { layer: 'tool', item: `${name} (old copy)`, status: 'warn', detail: `${tilde(old)} from mm's older npm install -g is still there; mm runs ${tilde(lockBin(t.install.lock, name))}`,
    fix: `once nothing runs it: npm uninstall -g --prefix ${tilde(DIRS.npm)} ${Object.keys(directDeps(shipped(t.install.lock))).join(' ')}` }
}

/**
 * Who may enter a secrets folder (sy-392): its owner only. Every folder the machine's secrets are in (machineSecretPaths:
 * the machine inputs' folders, Paseo's home, ~/.ssh), mm's own secret folders (auth, paseo, ai, api, the opened-secrets
 * folder; the vault has its own row) and each project's secrets/ folder: 0700 or narrower. Each file in a folder that
 * holds only secrets: 0600 or narrower. A box's opened-secrets folder (0750, files 0640) and a box project's own tree
 * (g+rwX) let the box's group in by design: there, only the bits for others count. Stat only: nothing is opened.
 */
export function secretModes(): Check {
  const wide: { path: string; mode: number; fix: string }[] = []
  const look = (p: string, dir: boolean, box = false) => {
    let m: number; try { const st = statSync(p); if (st.isDirectory() !== dir) return; m = st.mode & 0o777 } catch { return }
    const allowed = box ? 0o770 : dir ? 0o700 : 0o600
    if (m & ~allowed) wide.push({ path: p, mode: m, fix: box ? 'o-rwx' : dir ? '700' : '600' })
  }
  const filesIn = (d: string, box = false) => { try { for (const f of readdirSync(d)) look(join(d, f), false, box) } catch {} }
  const sp = machineSecretPaths(), only = new Set(secretOnlyDirs())
  for (const d of new Set([...sp.dirs, ...only])) { look(d, true); if (only.has(d)) filesIn(d) }
  for (const d of ['auth', 'paseo'].map((x) => join(DIRS.mm, x))) { look(d, true); filesIn(d) }
  for (const d of [AI_DIR, API_DIR]) look(d, true)
  const projects = listProjects().filter((p) => p.root !== '?'), boxes = new Set(projects.filter((p) => p.box).map((p) => p.project))
  const base = vault.secretsBase()
  look(base, true)
  // a project's opened-secrets folder that isn't the owner's (sy-duj0: Docker made it empty at boot, before mm): the box
  // runs without its secrets, and only its mm up makes the folder again
  const foreign: string[] = [], me = process.getuid?.()
  try { for (const x of readdirSync(base)) { const d = join(base, x), box = boxes.has(x); look(d, true, box); filesIn(d, box); try { if (me !== undefined && statSync(d).isDirectory() && statSync(d).uid !== me) foreign.push(x) } catch {} } } catch {}
  for (const p of projects) { const d = join(expand(p.root), 'secrets'); look(d, true, !!p.box); filesIn(d, !!p.box) }
  if (foreign.length) return { layer: 'secret', item: 'secret modes', status: 'fail',
    detail: `opened-secrets folder(s) not yours (Docker made them at boot, before mm): ${foreign.join(', ')}; ${wide.length} too wide`,
    fix: foreign.map((x) => `mm up ${x}`).join('; ') }
  if (!wide.length) return { layer: 'secret', item: 'secret modes', status: 'ok', detail: 'every secrets folder 0700, every secret file 0600 (or narrower)' }
  const shown = (p: string) => p.replace(HOME, '~')
  const fixes = new Map<string, string[]>()
  for (const w of wide) fixes.set(w.fix, [...(fixes.get(w.fix) || []), shown(w.path)])
  return { layer: 'secret', item: 'secret modes', status: 'fail',
    detail: `${wide.length} too wide: ${wide.slice(0, 5).map((w) => `${shown(w.path)} 0${w.mode.toString(8)}`).join(', ')}${wide.length > 5 ? ', …' : ''}`,
    fix: [...fixes].map(([m, ps]) => `chmod ${m} ${ps.join(' ')}`).join('; ') }
}

/**
 * Who may enter mm's own home (review sy-lud 1): $MM_HOME and its paseo/, claude/ and run/ folders 0700 (Paseo's and
 * Claude's state, the agents' activity, the runtime sockets); no socket of mm's (in $MM_HOME or run/) that the group or
 * others may connect to (a socket connects by its write bit); Paseo's logs (*.log in paseo/, they hold agent activity)
 * 0600; a box's (paseo/<box project>/, the box shares the owner's group) nothing for others. The owner's home at 0700 hides all this from other uids already; this holds when $MM_HOME is elsewhere too, and
 * when the home is opened. Stat only.
 */
export function mmHomeModes(mm = DIRS.mm, boxes: Set<string> = new Set(listProjects().filter((x) => x.box).map((x) => x.project))): Check {
  const wide: { path: string; mode: number; fix: string }[] = []
  const st = (p: string) => { try { return statSync(p) } catch { return undefined } }
  const dirs = [mm, ...['paseo', 'claude', 'run'].map((d) => join(mm, d))]
  for (const d of dirs) { const s = st(d); if (s?.isDirectory() && (s.mode & 0o077)) wide.push({ path: d, mode: s.mode & 0o777, fix: '700' }) }
  const walk = (d: string, depth: number, each: (p: string, s: Stats) => void) => {
    let names: string[] = []; try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n), s = st(p); if (!s) continue
      if (s.isDirectory()) { if (depth > 0) walk(p, depth - 1, each) } else each(p, s)
    }
  }
  const sock = (p: string, s: Stats) => { if (s.isSocket() && (s.mode & 0o022)) wide.push({ path: p, mode: s.mode & 0o777, fix: 'go-w' }) }
  walk(mm, 0, sock); walk(join(mm, 'run'), 2, sock)
  // a box's Paseo (paseo/<box project>/) shares the owner's group by design, as its secrets do: there only others' bits count
  const boxOf = (p: string) => boxes.has(p.slice(join(mm, 'paseo').length + 1).split('/')[0])
  walk(join(mm, 'paseo'), 2, (p, s) => {
    const box = boxOf(p)
    if (s.isFile() && p.endsWith('.log') && (s.mode & (box ? 0o007 : 0o077))) wide.push({ path: p, mode: s.mode & 0o777, fix: box ? 'o-rwx' : '600' })
  })
  const shown = (p: string) => p.replace(HOME, '~'), item = `mode ${shown(mm)}`
  if (!wide.length) return { layer: 'machine', item, status: 'ok', detail: 'it and paseo/, claude/, run/ 0700; no socket others can connect to; Paseo logs 0600' }
  const fixes = new Map<string, string[]>()
  for (const w of wide) fixes.set(w.fix, [...(fixes.get(w.fix) || []), shown(w.path)])
  return { layer: 'machine', item, status: 'fail',
    detail: `${wide.length} too wide: ${wide.slice(0, 5).map((w) => `${shown(w.path)} 0${w.mode.toString(8)}`).join(', ')}${wide.length > 5 ? ', …' : ''}`,
    fix: [...fixes].map(([m, ps]) => `chmod ${m} ${ps.join(' ')}`).join('; ') }
}

/**
 * sy-lt7c: every caller must open secrets in one folder, else a service, a box mount or a person's run looks in the
 * wrong place, or one caller opens them in a swappable folder. The callers: an mm call without MM_SECRETS_DIR (the
 * config key, else the default), this call (its MM_SECRETS_DIR), the process manager (MM_SECRETS_DIR in mm-pc's unit,
 * its launcher or base.yaml) and the mm-docker wrapper (its own root-owned `secrets` line; it never reads mm's config).
 * Only paths are read: from the unit's environment just MM_SECRETS_DIR, from the wrapper's config just `user` and
 * `secrets`. The wrapper's config: /etc/mm-docker.conf, or MM_DOCKER_CONF (the wrapper's own test-mode variable).
 */
export function secretsDirChecks(): Check[] {
  const out: Check[] = [], item = 'secrets folder callers'
  const key = secretsDirKey(), mine = configuredSecretsDir(), now = secretsDir()
  if (key !== undefined && mine.from === 'default')
    out.push({ layer: 'vault', item: 'secrets folder key', status: 'warn', detail: `${SECRETS_KEY} is not an absolute path: ignored (the default ${tilde(mine.path)} is used)`, fix: `mm config set ${SECRETS_KEY} <a tmpfs folder>` })
  if (process.env.MM_SECRETS_DIR && now.from !== 'env')
    out.push({ layer: 'vault', item: 'secrets folder env', status: 'warn', detail: 'MM_SECRETS_DIR is not an absolute path: ignored' })
  const callers: { who: string; path: string }[] = [{ who: mine.from === 'config' ? `mm (${SECRETS_KEY})` : 'mm (the default)', path: mine.path }]
  if (now.from === 'env') callers.push({ who: 'this call (MM_SECRETS_DIR)', path: now.path })
  const envIn = (text: string) => /(?:^|[\s"'])(?:export\s+)?MM_SECRETS_DIR=["']?([^\s"']+)/m.exec(text)?.[1]
  if (hasSystemdUser()) {
    const v = envIn(run(['systemctl', '--user', 'show', 'mm-pc.service', '-p', 'Environment', '--value'], { timeoutMs: 5000 }).out)
    if (v) callers.push({ who: 'mm-pc (MM_SECRETS_DIR in its unit)', path: v })
  }
  for (const [who, f] of [['mm-pc (its launcher, mm-pc-up)', join(DIRS.bin, 'mm-pc-up')], ['mm-pc (base.yaml)', join(DIRS.pc, 'base.yaml')]] as const) {
    let v: string | undefined; try { v = envIn(readFileSync(f, 'utf8')) } catch {}
    if (v) callers.push({ who, path: v })
  }
  const conf = process.env.MM_DOCKER_CONF || '/etc/mm-docker.conf'
  let text: string | undefined; try { text = readFileSync(conf, 'utf8') } catch {}
  if (text !== undefined) {
    const kv: Record<string, string> = {}
    for (const l of text.split('\n')) { const s = l.split('#', 1)[0], i = s.indexOf('='); if (i > 0) kv[s.slice(0, i).trim()] = s.slice(i + 1).trim() }
    if (!kv.user || kv.user === run(['id', '-un']).out.trim())
      callers.push({ who: kv.secrets ? `mm-docker (${conf} secrets)` : `mm-docker (${conf}: no secrets line, its default)`, path: kv.secrets || `/run/user/${process.getuid?.() ?? 0}/mm/secrets` })
  }
  const all = new Set(callers.map((c) => canon(c.path)))
  out.push(all.size === 1
    ? { layer: 'vault', item, status: 'ok', detail: `${callers.length} caller(s) open secrets in ${tilde(mine.path)}: ${callers.map((c) => c.who).join(', ')}` }
    : { layer: 'vault', item, status: 'warn', detail: `the callers disagree: ${callers.map((c) => `${c.who} ${tilde(c.path)}`).join('; ')}`,
      fix: `one folder for all: mm config set ${SECRETS_KEY} <folder>; MM_SECRETS_DIR in mm-pc's environment the same, or gone; the wrapper's \`secrets =\` line the same (root's file: ops)` })
  return out
}

/**
 * sy-1jmi (docs/approvals.md): with /etc/mm-approve.conf `verifier = ledger`, the approval ledger, its folder and the
 * public key belong to the signer (the key to root), and none is writable by a group or others; the signer's private
 * folder is 0700. The verifiers refuse a ledger that fails this. With `actor` (or no file): one line, nothing checked.
 * Its config: /etc's; MM_APPROVE_CONF only when that file is absent (tests).
 */
export function approvalChecks(): Check[] {
  const c = approveConf(), item = 'approval ledger'
  if (c.verifier !== 'ledger') return [{ layer: 'machine', item, status: 'skip', detail: c.path ? `verifier = actor (${c.path}): approvals are read from the board's journal` : 'no /etc/mm-approve.conf: approvals are read from the board\'s journal (verifier = actor)' }]
  const bad: string[] = [...ledgerProblems(c)]
  if (c.dir && c.uid !== null && c.uid !== undefined) {
    const priv = join(c.dir, 'private')
    try { const st = statSync(priv); if (st.uid !== c.uid || (st.mode & 0o777) !== 0o700) bad.push(`${priv}: not the signer's 0700 folder (uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)})`) }
    catch (e: any) { bad.push(`${priv}: ${e.code || e.message} (mm-approve keygen makes it)`) }
  }
  return [bad.length
    ? { layer: 'machine', item, status: 'fail', detail: `${c.path}: verifier = ledger, and no approval counts: ${[...new Set(bad)].join('; ')}`,
      fix: `as root: chown ${c.user || 'the signer'} and chmod go-w the ledger and its folder, chmod 700 the private folder, the public key root:root 0644 (docs/approvals.md; ops, t2)` }
    : { layer: 'machine', item, status: 'ok', detail: `${c.path}: verifier = ledger; ${c.ledger} and ${c.public_key}: owners and modes right` }]
}

export function doctor(): Check[] {
  const c = loadConfig()
  const m = manifest.machine
  const out: Check[] = []

  // who: projects live under $HOME; bd's server refuses a database under /root, and agents should not run as root
  if (isRoot()) out.push({ layer: 'machine', item: 'user', status: 'fail', detail: 'running as root: mm and its projects run as a normal user',
    fix: 'sudo useradd -m -s /bin/bash <name> && give it sudo, then run mm as that user' })

  // inputs: vars, secrets, accounts (`mm needs` has the full table; values never read)
  for (const n of needs([], c)) {
    if (n.status === 'n/a') continue
    const bad = n.status === 'missing' || n.status === 'bad'
    // a required one missing fails; an optional one warns; a bad one (wrong mode, in git, not a choice) always fails
    const status: Status = n.status === 'unchecked' ? 'skip' : !bad ? 'ok' : n.required || n.status === 'bad' ? 'fail' : 'warn'
    out.push({ layer: n.kind, item: n.name, status, detail: `${n.status}${n.detail ? `: ${n.detail}` : ''}`,
      fix: bad ? (n.fill || n.how || 'mm needs') : undefined })
  }

  // tools
  for (const [name, t] of Object.entries(m.tools)) { out.push(checkTool(name, t, c)); const o = oldNpmCopy(name, t); if (o) out.push(o) }

  // paths
  for (const [k, p] of Object.entries(m.paths)) {
    if (!p.dir && (!p.path || p.path.includes('<'))) continue // patterns, not single paths
    const path = p.dir ? DIRS[p.dir] : expand(p.path!), shown = path.replace(HOME, '~')
    if (k === 'backups' && !existsSync(path)) { out.push({ layer: 'path', item: k, status: 'ok', detail: `${shown} (made by the first backup)` }); continue }
    if (!existsSync(path)) { out.push({ layer: 'path', item: k, status: k === 'brain' ? 'warn' : 'fail', detail: `${shown} missing`, fix: k === 'brain' ? 'mm brain pull' : 'mm onboard' }); continue }
    if (p.git) {
      const remote = run(['git', '-C', path, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
      if (!run(['git', '-C', path, 'rev-parse', '--git-dir'], { timeoutMs: 10_000 }).ok) out.push({ layer: 'path', item: k, status: 'warn', detail: `${shown} is not a git repo` })
      else if (!remote.ok) out.push({ layer: 'path', item: k, status: 'warn', detail: `${shown}: no git remote (want ${p.git})`, fix: `git -C ${shown} remote add origin ${p.git}` })
      else out.push({ layer: 'path', item: k, status: 'ok', detail: `${shown} (origin ${remote.out.trim()})` })
    } else out.push({ layer: 'path', item: k, status: 'ok', detail: shown })
  }

  // no shared instructions down the tree: Claude reads every CLAUDE.md up from an agent's folder, and its global
  // folder reaches any agent not started with its own (mm's agents get $MM_HOME/claude/<project>)
  const stray: string[] = []
  const isProject = (d: string) => existsSync(join(d, '.mm-answers.yaml'))
  const clients = existsSync(DIRS.projects) ? readdirSync(DIRS.projects).map((c) => join(DIRS.projects, c)).filter((d) => { try { return statSync(d).isDirectory() && !isProject(d) } catch { return false } }) : []
  for (const d of [DIRS.mm, DIRS.projects, ...clients]) for (const f of ['CLAUDE.md', '.claude']) if (existsSync(join(d, f))) stray.push(join(d, f).replace(HOME, '~'))
  out.push(stray.length
    ? { layer: 'agents', item: 'shared instructions', status: 'fail', detail: `Claude instructions above the projects reach every agent below: ${stray.join(', ')}`, fix: 'move them into the project (or the brain) they belong to' }
    : { layer: 'agents', item: 'shared instructions', status: 'ok', detail: 'none above the projects' })
  const global = ['CLAUDE.md', 'settings.json'].map((f) => join(HOME, '.claude', f)).filter((f) => existsSync(f))
  if (global.length) out.push({ layer: 'agents', item: 'global Claude folder', status: 'warn', detail: `${global.map((f) => f.replace(HOME, '~')).join(', ')} reach any agent not started by mm (mm's agents use $MM_HOME/claude/<project>)` })

  // zero side effects (sy-8w1): every path of mm's outside $MM_HOME (src/env.ts outsidePaths), allowed or to move
  out.push(...outsideChecks())

  // engine drift (sy-h5se): an engine file the three-way merge kept behind the template, which no project commit changed
  for (const p of listProjects()) {
    const root = expand(p.root); if (p.box || !existsSync(join(root, '.mm-answers.yaml')) || boxish(root)) continue
    let left: string[] = []; try { left = engineDrift(root).filter((d) => d.by === 'baseline').map((d) => d.path) } catch { continue }
    out.push(left.length
      ? { layer: 'projects', item: `engine ${p.project}`, status: 'warn', detail: `kept behind the template it took, though no project commit changed ${left.length === 1 ? 'it' : 'them'}: ${left.join(', ')}`, fix: `mm update ${p.project} --reset ${left.join(' ')}` }
      : { layer: 'projects', item: `engine ${p.project}`, status: 'ok', detail: 'bin/ and site/ as the template it took, or changed by its own commits' })
  }

  // bd stays quiet (the owner, sy-8s1): no bd git hook in a board's repos (config, control, product; the hooks folder
  // git really uses, core.hooksPath included), bd's metrics off and no-hooks set on every board
  const boardRoots = [...new Set([DIRS.system, ...listProjects().map((p) => expand(p.root))])].filter((r) => existsSync(join(r, '.mm-answers.yaml')))
  for (const root of boardRoots) {
    const id = boardId(root)
    const hooks: string[] = []
    for (const repo of [root, join(root, 'control'), join(root, 'code')]) {
      if (!existsSync(join(repo, '.git'))) continue
      const hp = run(['git', '-C', repo, 'rev-parse', '--git-path', 'hooks'], { timeoutMs: 10_000 }).out.trim()
      const dir = hp.startsWith('/') ? hp : join(repo, hp)
      for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => !x.endsWith('.sample')) : []) {
        try { if (/\bbd\b[^\n]*\bhooks?\b|\bbeads\b/i.test(readFileSync(join(dir, f), 'utf8'))) hooks.push(`${join(dir, f).replace(HOME, '~')}`) } catch {}
      }
    }
    // a box project's bin/: the host runs it only if it is mm's engine (review sy-b15.6 follow-up 2)
    const no = engineRefusal(root)
    if (no) { out.push({ layer: 'board', item: `bd quiet ${id}`, status: 'fail', detail: `not checked: ${no}`, fix: 'see what changed bin/ (git -C <project> log -- bin), then mm update' }); continue }
    const bd = (...a: string[]) => run([join(root, 'bin', 'bd'), ...a], { cwd: join(root, 'control'), timeoutMs: 15_000 }).out.trim()
    const noHooks = bd('config', 'get', 'no-hooks').split('\n').pop(), autoStart = bd('config', 'get', 'dolt.auto-start').split('\n').pop()
    // metrics as bd resolves them for this board's calls (bin/bd's env first, then the user-global config; sy-nsnp)
    const metrics = /^Anonymous usage metrics: (\w+)/m.exec(bd('metrics'))?.[1]
    // dolt.auto-start on: a bd call while the board's Dolt is down starts a Dolt of bd's own, which then locks the
    // process manager's Dolt out of the database (sy-a0ac)
    const bad = [...(hooks.length ? [`bd hook(s): ${hooks.join(', ')}`] : []), ...(metrics !== 'OFF' ? [`bd metrics are ${metrics?.toLowerCase() || 'unreadable'}`] : []),
      ...(autoStart !== 'false' ? [`dolt.auto-start is ${autoStart || 'unreadable'} (bd could start a Dolt of its own)`] : [])]
    out.push(bad.length
      ? { layer: 'board', item: `bd quiet ${id}`, status: 'fail', detail: bad.join('; '), fix: [...(hooks.length ? [`remove the hook(s); then ${root.replace(HOME, '~')}/bin/bd-quiet`] : []), ...(metrics !== 'OFF' ? ['mm update (bin/bd turns metrics off)'] : []), ...(autoStart !== 'false' ? [`${root.replace(HOME, '~')}/bin/bd-quiet (or mm update), with the board's Dolt up`] : [])].join('; ') }
      : noHooks !== 'true'
        ? { layer: 'board', item: `bd quiet ${id}`, status: 'warn', detail: 'no bd hook, metrics off, no Dolt auto-start, but no-hooks is not set (bd could install hooks)', fix: `${root.replace(HOME, '~')}/bin/bd-quiet (or mm update)` }
        : { layer: 'board', item: `bd quiet ${id}`, status: 'ok', detail: 'no bd hook; no-hooks set; metrics off; no Dolt auto-start' })
  }

  // the wall the boxes' shared group relies on (review sy-b15.16): a box's uid has the host owner's group, so the owner's
  // home and runtime folder must not let a group in, and nothing of the owner's in the shared temp folders may be
  // group- or world-writable (a box, or any local user, could plant something the owner runs)
  const uid = process.getuid?.() ?? 1000
  for (const d of [HOME, `/run/user/${uid}`]) {
    if (!existsSync(d)) continue
    const m = statSync(d).mode & 0o777
    out.push((m & 0o077) === 0 ? { layer: 'machine', item: `mode ${d.replace(HOME, '~')}`, status: 'ok', detail: `0${m.toString(8)}` }
      : { layer: 'machine', item: `mode ${d.replace(HOME, '~')}`, status: 'fail', detail: `0${m.toString(8)}: wider than 0700 (the boxes share the owner's group)`, fix: `chmod 700 ${d.replace(HOME, '~')}` })
  }
  if (existsSync(DIRS.mm)) out.push(mmHomeModes())
  // a folder that neither the group nor others may enter (no g+x, no o+x: e.g. Claude's own 0700 /tmp/claude-<uid>) is a
  // wall too: what is under it is out of their reach, so it isn't listed (review sy-b15.16 #4)
  const loose = run(['find', '/tmp', '/var/tmp', '/dev/shm', '-xdev', '(', '-type', 'd', '-not', '-perm', '/011', '-prune', ')', '-o',
    '(', '-user', String(uid), '-not', '-type', 'l', '-perm', '/022', '-print', ')'], { timeoutMs: 30_000 }).out.trim().split('\n').filter(Boolean)
  out.push(loose.length
    ? { layer: 'machine', item: 'shared temp folders', status: 'warn', detail: `${loose.length} path(s) of yours are group- or world-writable: ${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', …' : ''}`, fix: 'chmod go-w them (or remove them)' }
    : { layer: 'machine', item: 'shared temp folders', status: 'ok', detail: 'nothing of yours is group- or world-writable in /tmp, /var/tmp, /dev/shm' })

  // the vault (docs/vault.md): modes and digests; where opened secrets go (a tmpfs; swap, sy-suk 5)
  for (const c of vault.check()) out.push({ layer: 'vault', item: 'vault', status: c.ok ? 'ok' : 'fail', detail: c.detail, fix: c.ok ? undefined : 'chmod 700 ~/.mm/vault, 600 the files; a digest mismatch: restore the file from mastermind' })
  if (vault.ready()) {
    let at = vault.secretsBase(); while (!existsSync(at) && at !== dirname(at)) at = dirname(at)
    out.push(vault.isTmpfs(at) ? { layer: 'vault', item: 'secrets folder', status: 'ok', detail: `${at} is memory-backed` } : { layer: 'vault', item: 'secrets folder', status: 'fail', detail: `${at} is not a tmpfs: opened secrets would land on disk`, fix: `name a tmpfs: mm config set ${SECRETS_KEY} <folder> (or use a systemd user session)` })
    const w = vault.swapRisk()
    if (w) out.push({ layer: 'vault', item: 'swap', status: 'fail', detail: `${w}; so mm refuses to open secrets there (sy-rjwg 6)`, fix: `name a noswap tmpfs: mm config set ${SECRETS_KEY} <folder> (a brain migration mounts it), or turn the swap off or encrypt it` })
  }
  out.push(...secretsDirChecks())
  out.push(...approvalChecks())

  out.push(secretModes())

  // the machine's process manager
  const pc =run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'state'], { timeoutMs: 10_000 })
  out.push(pc.ok
    ? { layer: 'service', item: 'mm-pc', status: 'ok', detail: `process-compose answering on ${DIRS.socket.replace(HOME, '~')}` }
    : { layer: 'service', item: 'mm-pc', status: 'fail', detail: 'process-compose not answering on ~/.mm/pc.sock', fix: 'mm onboard' })
  const systemd = hasSystemdUser()
  if (systemd) {
    const en = run(['systemctl', '--user', 'is-enabled', 'mm-pc.service'], { timeoutMs: 5000 }).out.trim()
    out.push({ layer: 'service', item: 'mm-pc boot', status: en === 'enabled' ? 'ok' : 'warn', detail: en === 'enabled' ? 'mm-pc.service enabled (starts at boot)' : `mm-pc.service ${en || 'not installed'}`, fix: en === 'enabled' ? undefined : 'mm onboard' })
    const linger = run(['loginctl', 'show-user', process.env.USER || '', '-p', 'Linger', '--value'], { timeoutMs: 5000 }).out.trim()
    out.push({ layer: 'service', item: 'linger', status: linger === 'yes' ? 'ok' : 'warn', detail: linger === 'yes' ? 'user services run without a login' : 'user services stop when you log out', fix: linger === 'yes' ? undefined : 'sudo loginctl enable-linger $USER' })
  } else out.push({ layer: 'service', item: 'mm-pc boot', status: 'warn', detail: 'no systemd user session here (container?): process-compose will not start at boot' })

  // brain-owned machine services (reported, not managed by mm)
  for (const [name, s] of Object.entries(m.services)) {
    if (name === 'mm-pc' || name === 'paseo' || !s.unit) continue   // paseo: its own row, below
    if (!systemd) { out.push({ layer: 'service', item: name, status: 'skip', detail: 'no systemd user session' }); continue }
    const a = run(['systemctl', '--user', 'is-active', s.unit], { timeoutMs: 5000 }).out.trim()
    out.push({ layer: 'service', item: name, status: a === 'active' ? 'ok' : 'warn', detail: `${s.unit} ${a || 'missing'} (brain-owned)` })
  }
  out.push(paseoDaemonCheck(c))   // one Paseo daemon, and mm's once paseo.managed is on (sy-11g)

  // access mode
  const access = String(getPath(c, 'access') ?? '')
  if (access === 'tailscale' && which('tailscale')) {
    const st = run(['tailscale', 'status', '--json'], { timeoutMs: 10_000 })
    out.push({ layer: 'access', item: 'tailscale', status: st.ok ? 'ok' : 'warn', detail: st.ok ? 'connected' : 'installed, not connected', fix: st.ok ? undefined : 'sudo tailscale up' })
  }
  if (access === 'domain') {
    // through mm's own way to Docker (box.docker, e.g. the mm-docker wrapper) when it is set; else plain, then sudo
    const set = String(process.env.MM_DOCKER || getPath(c, 'box.docker') || '').split(/\s+/).filter(Boolean)
    const ps = (cmd: string[]) => run([...cmd, 'ps', '--format', '{{.Names}}'], { timeoutMs: 10_000 })
    const tr = ps(set.length ? set : ['docker'])
    const names = tr.ok || set.length ? tr.out : ps(['sudo', '-n', 'docker']).out
    out.push({ layer: 'access', item: 'router', status: /traefik/.test(names) ? 'ok' : 'warn', detail: /traefik/.test(names) ? 'Traefik running (routes <name>.<domain>)' : 'no Traefik container found: public names will not route', fix: /traefik/.test(names) ? undefined : 'domain mode: set up Traefik (Dokploy) on this machine' })
  }
  return out
}
