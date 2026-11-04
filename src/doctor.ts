// mm doctor: check this machine against the manifest. Never changes anything.
import { existsSync, statSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { type Config, getPath, loadConfig, when } from './config'
import { DIRS, HOME, hasSystemdUser, isRoot, run, which } from './env'
import { needs } from './inputs'
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
