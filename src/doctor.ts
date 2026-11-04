// mm doctor: check this machine against the manifest. Never changes anything.
import { existsSync, statSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { type Config, getPath, loadConfig, when } from './config'
import { DIRS, HOME, hasSystemdUser, isRoot, run, which } from './env'
import { manifest, type Tool } from './manifest'

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

function checkSecret(p: string, usedBy: string): Check {
  const path = expand(p)
  const row = (status: Status, detail: string, fix?: string): Check => ({ layer: 'secret', item: p, status, detail, fix })
  if (!existsSync(path)) return row('warn', `missing (${usedBy})`, 'copy it by hand (names only in the manifest)')
  const mode = (statSync(path).mode & 0o777).toString(8)
  if (mode !== '600') return row('fail', `mode ${mode}, want 600`, `chmod 600 ${p}`)
  const g = run(['git', '-C', dirname(path), 'ls-files', '--error-unmatch', basename(path)], { timeoutMs: 10_000 })
  if (g.ok) return row('fail', 'tracked by git', `git rm --cached ${p}, and ignore it`)
  return row('ok', `600, not in git (${usedBy})`)
}

export function doctor(): Check[] {
  const c = loadConfig()
  const m = manifest.machine
  const out: Check[] = []

  // who: projects live under $HOME; bd's server refuses a database under /root, and agents should not run as root
  if (isRoot()) out.push({ layer: 'machine', item: 'user', status: 'fail', detail: 'running as root: mm and its projects run as a normal user',
    fix: 'sudo useradd -m -s /bin/bash <name> && give it sudo, then run mm as that user' })

  // vars
  for (const [k, v] of Object.entries(m.vars)) {
    if (!when(v.when, c)) continue
    const val = getPath(c, k)
    if (val === undefined || val === '') out.push({ layer: 'var', item: k, status: v.ask ? 'fail' : 'warn', detail: 'not set', fix: 'mm onboard' })
    else if (v.choices && !v.choices.includes(String(val))) out.push({ layer: 'var', item: k, status: 'fail', detail: `${val}: not one of ${v.choices.join(', ')}`, fix: `mm config set ${k} <${v.choices.join('|')}>` })
    else out.push({ layer: 'var', item: k, status: 'ok', detail: String(val) })
  }

  // tools
  for (const [name, t] of Object.entries(m.tools)) out.push(checkTool(name, t, c))

  // paths
  for (const [k, p] of Object.entries(m.paths)) {
    if (p.path.includes('<')) continue // patterns, not single paths
    const path = expand(p.path)
    if (!existsSync(path)) { out.push({ layer: 'path', item: k, status: k === 'brain' ? 'warn' : 'fail', detail: `${p.path} missing`, fix: k === 'brain' ? 'mm brain pull' : 'mm onboard' }); continue }
    if (p.git) {
      const remote = run(['git', '-C', path, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
      if (!run(['git', '-C', path, 'rev-parse', '--git-dir'], { timeoutMs: 10_000 }).ok) out.push({ layer: 'path', item: k, status: 'warn', detail: `${p.path} is not a git repo` })
      else if (!remote.ok) out.push({ layer: 'path', item: k, status: 'warn', detail: `${p.path}: no git remote (want ${p.git})`, fix: `git -C ${p.path} remote add origin ${p.git}` })
      else out.push({ layer: 'path', item: k, status: 'ok', detail: `${p.path} (origin ${remote.out.trim()})` })
    } else out.push({ layer: 'path', item: k, status: 'ok', detail: p.path })
  }

  // secrets (names only: existence, mode, git status; never read)
  for (const s of m.secrets) out.push(checkSecret(s.path, s.used_by || `managed by ${s.managed_by}`))

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
    const tr = run(['docker', 'ps', '--format', '{{.Names}}'], { timeoutMs: 10_000 })
    const trs = run(['sudo', '-n', 'docker', 'ps', '--format', '{{.Names}}'], { timeoutMs: 10_000 })
    const names = (tr.ok ? tr.out : trs.out)
    out.push({ layer: 'access', item: 'router', status: /traefik/.test(names) ? 'ok' : 'warn', detail: /traefik/.test(names) ? 'Traefik running (routes <name>.<domain>)' : 'no Traefik container found: public names will not route', fix: /traefik/.test(names) ? undefined : 'domain mode: set up Traefik (Dokploy) on this machine' })
  }
  return out
}
