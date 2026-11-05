// Project boxes (plans/project-box.md, M1-A/B): a project with `box: true` in its answers runs in its own container.
// mm is the only one that starts, stops and wires boxes. Inside: the project's services under process-compose, as
// the box user (no sudo, no Docker socket), with a read-only root, cap-drop ALL, no-new-privileges and limits. The
// project folder is mounted at the same path (so every generated path stays right); the kernel and every file that
// decides what the box may do are mounted read-only on top (review sy-b15.6). The box's network is `internal`: the
// only way out is the project's own egress proxy, with its allowlist (the base list + the project's `egress:`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { getPath, loadConfig } from './config'
import { DIRS, HOME, run } from './env'
import { boxHook, readAnswers, resolve, serviceProcess } from './project'
import boxDockerfile from '../box/Dockerfile' with { type: 'text' }
import egressDockerfile from '../box/egress.Dockerfile' with { type: 'text' }
import pkg from '../package.json'

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

/** Build both images from the Dockerfiles inside this mm binary. */
export function build(): Step[] {
  const steps: Step[] = [], dir = mkdtempSync(join(tmpdir(), 'mm-box-build-'))
  try {
    writeFileSync(join(dir, 'Dockerfile'), boxDockerfile); writeFileSync(join(dir, 'egress.Dockerfile'), egressDockerfile)
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
  const env = { PATH: BOX_PATH, HOME, MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0',
    HTTPS_PROXY: out, HTTP_PROXY: out, https_proxy: out, http_proxy: out, NO_PROXY: 'localhost,127.0.0.1,.localhost', no_proxy: 'localhost,127.0.0.1,.localhost' }
  const processes: Record<string, unknown> = {
    [`${a.project}.portless`]: { namespace: a.project, command: `portless proxy start --foreground --port ${pp} --no-tls`, environment: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'portless.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 } },
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
  if (!exists('network', n.net)) { const r = docker('network', 'create', '--internal', '--label', `mm.project=${a.project}`, n.net); if (!r.ok) return fail('network', short(r)) }
  steps.push({ step: 'network', status: 'ok', detail: `${n.net} (internal)` })
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
  // 4. the box
  if (exists('container', n.box)) docker('rm', '-f', n.box)
  const ro = (p: string) => (existsSync(p) ? ['-v', `${p}:${p}:ro`] : [])
  const claude = join(DIRS.mm, 'claude', a.project); mkdirSync(claude, { recursive: true, mode: 0o700 })
  const lim = (k: string, d: string) => String(getPath(loadConfig(), `box.${k}`) || d)
  const r = docker('run', '-d', '--name', n.box, '--hostname', a.project, '--label', `mm.project=${a.project}`, '--network', n.net, '--restart', 'unless-stopped',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', lim('pids', '2048'), '--memory', lim('memory', '4g'), '--cpus', lim('cpus', '2'),
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=1g,mode=1777`, '--tmpfs', `${HOME}:rw,nosuid,nodev,size=512m,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000},mode=0700`, '-e', `HOME=${HOME}`,
    '-v', `${root}:${root}`,
    // the kernel and what decides what the box may do: read-only on top (they change only through mm)
    ...['bin', 'ops', 'setup', 'tools', '.git/hooks', '.git/config', 'code/.git/hooks', 'code/.git/config', 'services.yaml', '.mm-answers.yaml', 'secrets.json', 'governance.json', '.run/box/cfg']
      .flatMap((p) => ro(join(root, p))),
    '-v', `${claude}:${claude}`,
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
  return { box: n.box, running: running(n.box), proxy: running(n.proxy), ip, image: docker('inspect', '-f', '{{.Config.Image}}', n.box).out.trim() }
}
/** A command in the box, as the box user (mm shell). */
export function execArgs(root: string, cmd: string[]) {
  return [...dockerCmd(), 'exec', ...(process.stdin.isTTY ? ['-it'] : ['-i']), '-w', root, names(readAnswers(root).project).box, ...(cmd.length ? cmd : ['bash'])]
}
export const HOME_DIR = HOME
boxHook.up = up
boxHook.down = down
