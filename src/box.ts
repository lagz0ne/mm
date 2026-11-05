// Project boxes (plans/project-box.md, M1-A/B): a project with `box: true` in its answers runs in its own container.
// mm is the only one that starts, stops and wires boxes. Inside: the project's services under process-compose, as
// the box user (no sudo, no Docker socket), with a read-only root, cap-drop ALL, no-new-privileges and limits. The
// project folder is mounted at the same path (so every generated path stays right); the kernel and every file that
// decides what the box may do are mounted read-only on top (review sy-b15.6). The box's network is `internal`: the
// only way out is the project's own egress proxy, with its allowlist (the base list + the project's `egress:`).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, run } from './env'
import { boxHook, readAnswers, resolve, serviceProcess } from './project'
import boxDockerfile from '../box/Dockerfile' with { type: 'text' }
import egressDockerfile from '../box/egress.Dockerfile' with { type: 'text' }
import npmPackage from '../box/npm/package.json' with { type: 'text' }
import npmLock from '../box/npm/package-lock.json' with { type: 'text' }
import pkg from '../package.json'
import * as vault from './vault'

type Step = { step: string; status: 'ok' | 'fail' | 'skip'; detail: string }
const short = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 240)
/** How mm reaches Docker (config `box.docker`, e.g. "sudo -n docker"): mm is the only holder of Docker access. */
const dockerCmd = () => String(process.env.MM_DOCKER || getPath(loadConfig(), 'box.docker') || 'docker').split(/\s+/)
const docker = (...a: string[]) => run([...dockerCmd(), ...a], { timeoutMs: 900_000 })
export const IMAGE = () => String(getPath(loadConfig(), 'box.image') || `mm-box:${pkg.version}`)
export const EGRESS_IMAGE = () => String(getPath(loadConfig(), 'box.egress_image') || `mm-egress:${pkg.version}`)
/** Sites every box may reach (through its proxy). Models are not on it: they come through mm's AI gateway (sy-b15.10). */
const BASE_EGRESS = ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'registry.npmjs.org']
const names = (project: string) => ({ box: `mm-box-${project}`, net: `mm-net-${project}`, proxy: `mm-egress-${project}` })
const BOX_PATH = '/usr/local/bin:/usr/bin:/bin'
const PASEO_PORT = 6767
/** A fixed subnet for the project's network (10.231.<n>.0/24) and a fixed address for its box (.10), so the system
 *  Paseo's entry for the box stays right when the box is made again. A taken subnet moves to the next n. */
function netOf(project: string, net: string): { subnet: string; ip: string } | null {
  const have = docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}}', net).out.trim()
  if (have) return { subnet: have, ip: have.replace(/\.0\/24$/, '.10') }
  const start = createHash('sha256').update(project).digest()[0] % 240
  for (let i = 0; i < 240; i++) {
    const nn = 10 + ((start + i) % 240), subnet = `10.231.${nn}.0/24`
    const r = docker('network', 'create', '--internal', '--subnet', subnet, '--gateway', `10.231.${nn}.1`, '--label', `mm.project=${project}`, net)
    if (r.ok) return { subnet, ip: `10.231.${nn}.10` }
    if (!/overlap|in use/i.test(r.err)) return null
  }
  return null
}
/** The box's Paseo password: made by mm once, kept on the host (0600); the box sees it only in its tmpfs mount. */
export function paseoPasswordFile(project: string) {
  const d = join(DIRS.mm, 'paseo'); mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700)
  const f = join(d, `${project}.password`)
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('base64url'), { mode: 0o600 })
  return f
}

/** Build both images from the Dockerfiles inside this mm binary. */
export function build(): Step[] {
  const steps: Step[] = [], dir = mkdtempSync(join(tmpdir(), 'mm-box-build-'))
  try {
    writeFileSync(join(dir, 'Dockerfile'), boxDockerfile); writeFileSync(join(dir, 'egress.Dockerfile'), egressDockerfile)
    mkdirSync(join(dir, 'npm')); writeFileSync(join(dir, 'npm', 'package.json'), String(npmPackage as unknown)); writeFileSync(join(dir, 'npm', 'package-lock.json'), String(npmLock as unknown))
    const uid = String(process.getuid?.() ?? 1000)
    for (const [tag, file, args] of [[IMAGE(), 'Dockerfile', ['--build-arg', `UID=${uid}`, '--build-arg', `HOME_DIR=${HOME}`]], [EGRESS_IMAGE(), 'egress.Dockerfile', []]] as const) {
      const r = docker('build', '-q', '-t', tag, '-f', join(dir, file), ...args, dir)
      steps.push({ step: `image ${tag}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? r.out.trim().slice(0, 80) : short(r) })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
  return steps
}

const exists = (kind: 'container' | 'network', name: string) => docker(kind, 'inspect', name).ok
const running = (name: string) => docker('inspect', '-f', '{{.State.Running}}', name).out.trim() === 'true'

/** The box's egress list: the base list, plus what the project declares (`egress:` in services.yaml). */
export function egressList(root: string): string[] {
  let extra: string[] = []
  try { extra = ((Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { egress?: string[] }).egress || []) } catch {}
  const ok = (h: string) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)
  return [...new Set([...BASE_EGRESS, ...extra.map((x) => String(x).toLowerCase()).filter(ok)])].sort()
}
const allowPatterns = (hosts: string[]) => hosts.map((h) => `^${h.startsWith('*.') ? '(.+\\.)?' + h.slice(2).replace(/\./g, '\\.') : h.replace(/\./g, '\\.')}(:443)?$`).join('\n') + '\n'

/** The box's own process-compose file: portless (the names) and the project's services, as on the host. */
function boxProcesses(root: string, proxy: string) {
  const { answers: a, services, socket, pp } = resolve(root)
  const out = `http://${proxy}:8888`
  const paseoHome = join(DIRS.mm, 'paseo', a.project)
  const env = { PATH: BOX_PATH, HOME, MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0', PASEO_HOME: paseoHome,
    HTTPS_PROXY: out, HTTP_PROXY: out, https_proxy: out, http_proxy: out, NO_PROXY: 'localhost,127.0.0.1,.localhost', no_proxy: 'localhost,127.0.0.1,.localhost' }
  const processes: Record<string, unknown> = {
    [`${a.project}.portless`]: { namespace: a.project, command: `portless proxy start --foreground --port ${pp} --no-tls`, environment: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'portless.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 } },
    // the box's own Paseo: runs the project's leads as the box user; only on the box network, with mm's password; no
    // relay and no web UI (only the system Paseo has the relay; review sy-b15.8)
    [`${a.project}.paseo`]: { namespace: a.project, command: `sh -c 'PASEO_PASSWORD="$$(cat /run/mm/secrets/paseo.password)" exec paseo daemon run'`,
      environment: Object.entries({ ...env, PASEO_LISTEN: `0.0.0.0:${PASEO_PORT}`, PASEO_RELAY_ENABLED: 'false', PASEO_WEB_UI_ENABLED: 'false' }).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'paseo.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${PASEO_PORT}/` }, period_seconds: 3, failure_threshold: 40 } },
  }
  for (const [n, s] of Object.entries(services)) {
    const p = serviceProcess(root, a.project, n, s, services, { env, socket, pdeath: 'setpriv --pdeathsig TERM ', secretsDir: '/run/mm/secrets' }) as Record<string, unknown>
    if (s.port === 'http') p.depends_on = { ...(p.depends_on as object || {}), [`${a.project}.portless`]: { condition: 'process_healthy' } }
    processes[`${a.project}.${n}`] = p
  }
  return { project: a.project, processes }
}

/** `mm up` for a box project: network, egress proxy, the box. Idempotent: a running box is restarted with new config. */
export function up(root: string): Step[] {
  const steps: Step[] = [], a = readAnswers(root), n = names(a.project)
  const fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return steps }
  if (!docker('image', 'inspect', IMAGE()).ok || !docker('image', 'inspect', EGRESS_IMAGE()).ok) return fail('image', `missing ${IMAGE()} or ${EGRESS_IMAGE()}: mm box build`)
  // 1. the network: internal, no route out
  const net = netOf(a.project, n.net); if (!net) return fail('network', `could not make ${n.net}`)
  steps.push({ step: 'network', status: 'ok', detail: `${n.net} (internal, ${net.subnet}; the box at ${net.ip})` })
  // 2. the egress proxy: on the bridge (out) and on the box's network; its list is read-only to it
  const edir = join(DIRS.mm, 'egress', a.project); mkdirSync(edir, { recursive: true, mode: 0o700 })
  const hosts = egressList(root); writeFileSync(join(edir, 'allow'), allowPatterns(hosts), { mode: 0o644 })
  if (exists('container', n.proxy)) docker('rm', '-f', n.proxy)
  const px = docker('run', '-d', '--name', n.proxy, '--label', `mm.project=${a.project}`, '--restart', 'unless-stopped', '--read-only', '--tmpfs', '/run:size=8m', '--tmpfs', '/var/log/tinyproxy:size=8m',
    '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '256m',
    '-v', `${join(edir, 'allow')}:/etc/mm/allow:ro`, EGRESS_IMAGE())
  if (!px.ok) return fail('egress proxy', short(px))
  const cn = docker('network', 'connect', n.net, n.proxy); if (!cn.ok) return fail('egress proxy', short(cn))
  steps.push({ step: 'egress proxy', status: 'ok', detail: `${n.proxy}: ${hosts.length} name(s) (${hosts.slice(0, 4).join(', ')}${hosts.length > 4 ? ', …' : ''})` })
  // 3. the box's process-compose file, read-only to the box
  const cfg = join(root, '.run', 'box', 'cfg'), sock = join(root, '.run', 'box', 'sock')
  mkdirSync(cfg, { recursive: true }); mkdirSync(sock, { recursive: true }); mkdirSync(join(root, '.run', 'logs'), { recursive: true }); mkdirSync(join(root, '.dolt'), { recursive: true })
  const bp = boxProcesses(root, n.proxy)
  writeFileSync(join(cfg, 'pc.yaml'), `# Generated by mm for the box ${n.box}. Do not edit.\nversion: "0.5"\n${Bun.YAML.stringify({ processes: bp.processes }, null, 2)}\n`)
  // 4. what the box may know: its Paseo password, and the vault's values its services declare, in a tmpfs folder on
  // the host that the box sees read-only (gone at the host's reboot; mm opens it again at every up)
  const sec = vault.runtimeDir(a.project)
  copyFileSync(paseoPasswordFile(a.project), join(sec, 'paseo.password')); chmodSync(join(sec, 'paseo.password'), 0o600)
  const declared = [...new Set(Object.values(resolve(root).services).flatMap((x) => x.secrets || []))]
  if (declared.length) {
    if (!vault.ready()) return fail('secrets', `the services declare ${declared.join(', ')}, and this machine has no vault (mm vault init)`)
    vault.openFor(a.project, declared.map((x) => vault.projectSecretName(a.project, x)))
  }
  steps.push({ step: 'secrets', status: 'ok', detail: `${declared.length} value(s) + the Paseo password, read-only in the box (tmpfs)` })
  const paseoHome = join(DIRS.mm, 'paseo', a.project); mkdirSync(paseoHome, { recursive: true, mode: 0o700 })
  // 5. the box
  if (exists('container', n.box)) docker('rm', '-f', n.box)
  const ro = (p: string) => (existsSync(p) ? ['-v', `${p}:${p}:ro`] : [])
  const claude = join(DIRS.mm, 'claude', a.project); mkdirSync(claude, { recursive: true, mode: 0o700 })
  const lim = (k: string, d: string) => String(getPath(loadConfig(), `box.${k}`) || d)
  const r = docker('run', '-d', '--name', n.box, '--hostname', a.project, '--label', `mm.project=${a.project}`, '--network', n.net, '--ip', net.ip, '--restart', 'unless-stopped',
    // no DNS out (review sy-b15.7: lookups are a way out): Docker's own resolver still answers the names on the box's
    // network (its proxy), and forwards everything else to 127.0.0.1, where nothing answers
    '--dns', '127.0.0.1',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', lim('pids', '2048'), '--memory', lim('memory', '4g'), '--cpus', lim('cpus', '2'),
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=1g,mode=1777`, '--tmpfs', `${HOME}:rw,nosuid,nodev,size=512m,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000},mode=0700`, '-e', `HOME=${HOME}`,
    '-v', `${root}:${root}`,
    // the kernel and what decides what the box may do: read-only on top (they change only through mm)
    ...['bin', 'ops', 'setup', 'tools', '.git/hooks', '.git/config', 'code/.git/hooks', 'code/.git/config', 'services.yaml', '.mm-answers.yaml', 'secrets.json', 'governance.json', '.run/box/cfg']
      .flatMap((p) => ro(join(root, p))),
    '-v', `${claude}:${claude}`, '-v', `${paseoHome}:${paseoHome}`, '-v', `${sec}:/run/mm/secrets:ro`,
    '-w', root, IMAGE(), 'process-compose', 'up', '-t=false', '--keep-project', '-U', '-u', join(sock, 'pc.sock'), '-L', join(root, '.run', 'box', 'pc.log'), '-f', join(cfg, 'pc.yaml'))
  if (!r.ok) return fail('box', short(r))
  steps.push({ step: 'box', status: 'ok', detail: `${n.box} (read-only root, cap-drop ALL, no-new-privileges)` })
  for (let i = 0; i < 60 && !existsSync(join(sock, 'pc.sock')); i++) Bun.sleepSync(500)
  steps.push(existsSync(join(sock, 'pc.sock')) ? { step: 'process manager', status: 'ok', detail: `${Object.keys(bp.processes).length} processes in the box` } : { step: 'process manager', status: 'fail', detail: 'the box did not start its process manager (mm box logs)' })
  return steps
}

export function down(root: string): Step[] {
  const n = names(readAnswers(root).project), steps: Step[] = []
  for (const c of [n.box, n.proxy]) if (exists('container', c)) { const r = docker('rm', '-f', c); steps.push({ step: `stop ${c}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'removed' : short(r) }) }
  return steps.length ? steps : [{ step: 'down', status: 'skip', detail: 'not running' }]
}

/** The box's processes, through its process-compose socket in the project folder. */
export function processes(root: string) {
  const r = run(['process-compose', '-U', '-u', join(root, '.run', 'box', 'sock', 'pc.sock'), 'process', 'list', '-o', 'json'], { timeoutMs: 15_000 })
  try { return r.ok ? JSON.parse(r.out) as { name: string; status: string; is_ready: string; restarts: number }[] : [] } catch { return [] }
}
export function status(root: string) {
  const n = names(readAnswers(root).project)
  const ip = docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${n.net}").IPAddress}}`, n.box).out.trim()
  return { box: n.box, running: running(n.box), proxy: running(n.proxy), ip, image: docker('inspect', '-f', '{{.Config.Image}}', n.box).out.trim(),
    paseo: ip ? `tcp://${ip}:${PASEO_PORT}` : '', password_file: paseoPasswordFile(readAnswers(root).project) }
}
/** A command in the box, as the box user (mm shell). */
export function execArgs(root: string, cmd: string[]) {
  return [...dockerCmd(), 'exec', ...(process.stdin.isTTY ? ['-it'] : ['-i']), '-w', root, names(readAnswers(root).project).box, ...(cmd.length ? cmd : ['bash'])]
}
export const HOME_DIR = HOME
boxHook.up = up
boxHook.down = down
