// mm doctor: check this machine against the manifest. Never changes anything (`mm doctor --fix` is src/outside.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { type Config, getPath, loadConfig, when } from './config'
import { DIRS, HOME, hasSystemdUser, isRoot, run, which } from './env'
import { needs } from './inputs'
import { boxish, engineRefusal, listProjects } from './project'
import { engineDrift } from './lifecycle'
import { manifest, type Tool } from './manifest'
import * as vault from './vault'
import { outsideChecks } from './outside'

export type Status = 'ok' | 'warn' | 'fail' | 'skip'
export interface Check { layer: string; item: string; status: Status; detail: string; fix?: string }

const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME)

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
  if (!t.version) return row('ok', path.replace(HOME, '~'))
  const r = run(t.version, { timeoutMs: 15_000 })
  const v = parseVersion(r.out + r.err)
  if (!v) return row(t.min ? 'warn' : 'ok', `${path.replace(HOME, '~')} (version unreadable)`)
  if (t.min && !atLeast(v, t.min)) return row('fail', `${v} < ${t.min}`, 'mm onboard')
  return row('ok', `${v}  ${path.replace(HOME, '~')}`)
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
  for (const [name, t] of Object.entries(m.tools)) out.push(checkTool(name, t, c))

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
    const id = basename(root) === 'system' || root === DIRS.system ? 'system' : basename(dirname(root)) + '/' + basename(root)
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
    const get = (k: string) => run([join(root, 'bin', 'bd'), 'config', 'get', k], { cwd: join(root, 'control'), timeoutMs: 15_000 }).out.trim().split('\n').pop()
    const metrics = get('metrics.disabled'), noHooks = get('no-hooks')
    const bad = [...(hooks.length ? [`bd hook(s): ${hooks.join(', ')}`] : []), ...(metrics !== 'true' ? [`metrics.disabled is ${metrics || 'unreadable'}`] : [])]
    out.push(bad.length
      ? { layer: 'board', item: `bd quiet ${id}`, status: 'fail', detail: bad.join('; '), fix: `remove the hook(s); then ${root.replace(HOME, '~')}/bin/bd-quiet` }
      : noHooks !== 'true'
        ? { layer: 'board', item: `bd quiet ${id}`, status: 'warn', detail: 'no bd hook, metrics off, but no-hooks is not set (bd could install hooks)', fix: `${root.replace(HOME, '~')}/bin/bd-quiet (or mm update)` }
        : { layer: 'board', item: `bd quiet ${id}`, status: 'ok', detail: 'no bd hook; no-hooks set; metrics off' })
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
    out.push(vault.isTmpfs(at) ? { layer: 'vault', item: 'secrets folder', status: 'ok', detail: `${at} is memory-backed` } : { layer: 'vault', item: 'secrets folder', status: 'fail', detail: `${at} is not a tmpfs: opened secrets would land on disk`, fix: 'set MM_SECRETS_DIR to a tmpfs (or use a systemd user session)' })
    const w = vault.swapRisk()
    if (w) out.push({ layer: 'vault', item: 'swap', status: 'warn', detail: w })
  }

  // the machine's process manager
  const pc = run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'state'], { timeoutMs: 10_000 })
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
    if (name === 'mm-pc' || !s.unit) continue
    if (!systemd) { out.push({ layer: 'service', item: name, status: 'skip', detail: 'no systemd user session' }); continue }
    const a = run(['systemctl', '--user', 'is-active', s.unit], { timeoutMs: 5000 }).out.trim()
    out.push({ layer: 'service', item: name, status: a === 'active' ? 'ok' : 'warn', detail: `${s.unit} ${a || 'missing'} (brain-owned)` })
  }

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
