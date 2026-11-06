// Project boxes (plans/project-box.md, M1-A/B): a project with `box: true` in its answers runs in its own container.
// mm is the only one that starts, stops and wires boxes. Inside: the project's services under process-compose, as
// the box user (no sudo, no Docker socket), with a read-only root, cap-drop ALL, no-new-privileges and limits. The
// project folder is mounted at the same path (so every generated path stays right); the kernel and every file that
// decides what the box may do are mounted read-only on top (review sy-b15.6). The box's network is `internal`: the
// only way out is the project's own egress proxy, with its allowlist (the base list + the project's `egress:`).
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { AI_PORT, aiEnabled, aiSocket, mintKey, revokeKeys, store as aiStore } from './ai'
import { mkdtempSync, rmSync } from 'node:fs'
import { apiEnabled, apiSocketDir, granted } from './apistate'
import { getPath, held, loadConfig } from './config'
import { DIRS, HOME, run, which } from './env'
import { BOX_READONLY, BOXES, boxHook, gitRefusal, hostGitEnv, loadAll, PROJECTS_PC, readAnswers, recordedTemplate, recordTemplate, resolve, routeUp, sealEngine, serviceProcess, up as projectUp, writeRunFiles } from './project'
import boxDockerfile from '../box/Dockerfile' with { type: 'text' }
import egressDockerfile from '../box/egress.Dockerfile' with { type: 'text' }
import paseoJoinScript from '../box/paseo-join.mjs' with { type: 'text' }
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
/** The box's uid on this machine: 200000 + the third octet of its subnet (unique per box, never a real user's). */
const boxIds = (subnet: string) => ({ uid: 200000 + Number(subnet.split('.')[2]) })
/** The box's Paseo password: made by mm once, kept on the host (0600); the box sees it only in its tmpfs mount. */
export function paseoPasswordFile(project: string) {
  const d = join(DIRS.mm, 'paseo'); mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700)
  const f = join(d, `${project}.password`)
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('base64url'), { mode: 0o600 })
  return f
}

/**
 * The box's Paseo joins the machine's Paseo as a host (sy-9q1), so the app and the bridge see the box's agents; or
 * leaves it. Through Paseo's client library (box/paseo-join.mjs): the password is read from its file there, never put
 * on a command line. Off with `box.join_paseo: false`. MM_PASEO_JOIN_HOME points tests at a throwaway daemon.
 */
export function paseoJoin(project: string, address: string | null): Step {
  const v = getPath(loadConfig(), 'box.join_paseo')
  if (v === false || v === 'false') return { step: 'machine paseo', status: 'skip', detail: 'box.join_paseo is off' }
  const bin = which('paseo'); if (!bin) return { step: 'machine paseo', status: 'skip', detail: 'no paseo on this machine' }
  let cli = realpathSync(bin)
  while (cli !== dirname(cli) && !(existsSync(join(cli, 'package.json')) && /"@getpaseo\/cli"/.test(readFileSync(join(cli, 'package.json'), 'utf8')))) cli = dirname(cli)
  if (cli === dirname(cli)) return { step: 'machine paseo', status: 'fail', detail: `can't find Paseo's package from ${bin}` }
  const home = process.env.MM_PASEO_JOIN_HOME || String(getPath(loadConfig(), 'paseo.home') || join(HOME, '.paseo'))
  const dir = mkdtempSync(join(tmpdir(), 'mm-paseo-join-')), script = join(dir, 'join.mjs')
  try {
    writeFileSync(script, paseoJoinScript, { mode: 0o600 })
    const args = address ? ['add', project, address, paseoPasswordFile(project)] : ['rm', project]
    const r = run(['node', script, cli, home, ...args], { timeoutMs: 60_000 })
    if (!r.ok) return { step: 'machine paseo', status: 'fail', detail: short(r) }
    const o = JSON.parse(r.out.trim().split('\n').pop() || '{}') as { removed?: number; status?: string }
    return { step: 'machine paseo', status: 'ok', detail: address ? `${project} joined as a host (${o.status || 'added'})` : `${project} left (${o.removed ?? 0} entr${o.removed === 1 ? 'y' : 'ies'})` }
  } catch (e) { return { step: 'machine paseo', status: 'fail', detail: (e as Error).message } }
  finally { rmSync(dir, { recursive: true, force: true }) }
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
/**
 * What mm keeps for a box outside its project folder (review sy-b15.6 2): the box can rename and replace anything it
 * can write, even around a read-only mount, and Docker follows a symlink in a mount's source on the host. So what the
 * host writes for the box, or mounts into it, lives here: its account files, cfg/ (its process-compose file, read-only
 * in the box at /run/mm/cfg), sock/ (its process manager's socket, /run/mm/sock) and backup/ (/run/mm/backup).
 */
export const hostDir = (project: string) => join(DIRS.mm, 'box', project)

const running = (name: string) => docker('inspect', '-f', '{{.State.Running}}', name).out.trim() === 'true'

/** The box's egress list: the base list, plus what the project declares (`egress:` in services.yaml), plus the exact
 *  sites the owner granted through the project API (the host's record, src/apistate.ts). */
export function egressList(root: string): string[] {
  let extra: string[] = []
  try { extra = ((Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { egress?: string[] }).egress || []) } catch {}
  const ok = (h: string) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)
  const api = granted(readAnswers(root).project).egress.map((e) => e.site)
  return [...new Set([...BASE_EGRESS, ...extra.map((x) => String(x).toLowerCase()).filter(ok), ...api])].sort()
}
const allowPatterns = (hosts: string[]) => hosts.map((h) => `^${h.startsWith('*.') ? '(.+\\.)?' + h.slice(2).replace(/\./g, '\\.') : h.replace(/\./g, '\\.')}(:443)?$`).join('\n') + '\n'
const writeAllow = (root: string) => {
  const edir = join(DIRS.mm, 'egress', readAnswers(root).project); mkdirSync(edir, { recursive: true, mode: 0o700 })
  const hosts = egressList(root); writeFileSync(join(edir, 'allow'), allowPatterns(hosts), { mode: 0o644 })
  return { edir, hosts }
}
/** The project API granted (or undid) a site: the list again, and the proxy restarted to read it (its networks, its
 *  address and its AI forwarder stay; the box's connections out break for a moment). */
export function egressReload(root: string): Step {
  const { hosts } = writeAllow(root), px = names(readAnswers(root).project).proxy
  if (!exists('container', px)) return { step: 'egress proxy', status: 'skip', detail: `${px} is not running: the list is used at the next mm up` }
  const r = docker('restart', '-t', '2', px)
  return { step: 'egress proxy', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `${px}: ${hosts.length} name(s), restarted` : short(r) }
}

/** What every program in the box gets (its services, and the jobs mm cron runs there): its names, its Paseo, its proxy. */
function boxEnv(root: string): Record<string, string> {
  const { answers: a, pp } = resolve(root), px = names(a.project).proxy, out = `http://${px}:8888`, direct = `localhost,127.0.0.1,.localhost,${px}`
  return { PATH: BOX_PATH, HOME, MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0', PASEO_HOME: join(DIRS.mm, 'paseo', a.project),
    HTTPS_PROXY: out, HTTP_PROXY: out, https_proxy: out, http_proxy: out, NO_PROXY: direct, no_proxy: direct,
    // models only through mm's AI gateway (sy-b15.10): its proxy forwards this port to the box's own socket on the host;
    // the key is the box's (/run/mm/secrets/ai.key), never a provider's
    ANTHROPIC_BASE_URL: `http://${px}:${AI_PORT}` }
}
const aiOn = aiEnabled // the AI gateway on for this machine (`mm config set ai.enabled true`)
/** The box's own process-compose file: portless (the names) and the project's services, as on the host. */
function boxProcesses(root: string, proxy: string, ip = '') {
  const { answers: a, services, socket, pp } = resolve(root)
  const env = boxEnv(root)
  if (env.HTTPS_PROXY !== `http://${proxy}:8888`) throw new Error(`the box's proxy is ${proxy}, not ${env.HTTPS_PROXY}`)
  const processes: Record<string, unknown> = {
    [`${a.project}.portless`]: { namespace: a.project, command: `portless proxy start --foreground --port ${pp} --no-tls`, environment: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'portless.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 } },
    // the box's own Paseo: runs the project's leads as the box user; only on the box network, with mm's password; no
    // relay and no web UI (only the system Paseo has the relay; review sy-b15.8)
    // its agents get the box's AI key from the file at start (never in a config file); none: no model
    [`${a.project}.paseo`]: { namespace: a.project, command: `sh -c '[ -r /run/mm/secrets/ai.key ] && export ANTHROPIC_API_KEY="$$(cat /run/mm/secrets/ai.key)"; PASEO_PASSWORD="$$(cat /run/mm/secrets/paseo.password)" exec paseo daemon run'`,
      environment: Object.entries({ ...env, PASEO_LISTEN: `0.0.0.0:${PASEO_PORT}`, PASEO_RELAY_ENABLED: 'false', PASEO_WEB_UI_ENABLED: 'false' }).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'paseo.log'), availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${PASEO_PORT}/` }, period_seconds: 3, failure_threshold: 40 } },
  }
  for (const [n, s] of Object.entries(services)) {
    const p = serviceProcess(root, a.project, n, s, services, { env, socket, pdeath: 'setpriv --pdeathsig TERM ', secretsDir: '/run/mm/secrets' }) as Record<string, unknown>
    if (s.port === 'http') p.depends_on = { ...(p.depends_on as object || {}), [`${a.project}.portless`]: { condition: 'process_healthy' } }
    processes[`${a.project}.${n}`] = p
    // a public service (the board's gated side, the app slot) listens on the box's loopback: its port is forwarded from
    // the box's own address, where only the host reaches it (the host's forwarder from bind_host comes next; Traefik
    // never joins a box network, so a box can't reach Traefik or forge what it passes on; review sy-b15.7 2)
    if (s.public_port && ip) processes[`${a.project}.${n}-public`] = { namespace: a.project,
      command: `socat TCP-LISTEN:${s.public_port},bind=${ip},reuseaddr,fork TCP:127.0.0.1:${s.public_port}`,
      log_location: join(root, '.run', 'logs', `${n}-public.log`), availability: { restart: 'always', backoff_seconds: 3 } }
  }
  return { project: a.project, processes }
}
/** The box's process-compose file, in the host's folder the box sees read-only (/run/mm/cfg). */
function writePc(root: string, proxy: string, ip: string) {
  const bp = boxProcesses(root, proxy, ip), cfg = join(hostDir(bp.project), 'cfg')
  mkdirSync(cfg, { recursive: true, mode: 0o755 })
  writeFileSync(join(cfg, 'pc.yaml'), `# Generated by mm for the box ${names(bp.project).box}. Do not edit.\nversion: "0.5"\n${Bun.YAML.stringify({ processes: bp.processes }, null, 2)}\n`)
  return bp
}
const boxIp = (project: string) => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${names(project).net}").IPAddress}}`, names(project).box).out.trim()
/**
 * The project API put a build on the box's app slot (or took it off): the box's process file again, which its own
 * process manager loads from inside the box (the build runs there, never on the host), then the host's side of its
 * public services. The box keeps running: its agents are not restarted.
 */
export function appReload(root: string): Step[] {
  const a = readAnswers(root), n = names(a.project)
  if (!running(n.box)) return [{ step: 'app slot', status: 'skip', detail: `${n.box} is not running: the build starts at the next mm up` }]
  const ip = boxIp(a.project); if (!ip) return [{ step: 'app slot', status: 'fail', detail: `no address for ${n.box}` }]
  writePc(root, n.proxy, ip); writeRunFiles(root, '/run/mm/sock/pc.sock')
  const r = docker('exec', n.box, 'process-compose', '-U', '-u', '/run/mm/sock/pc.sock', 'project', 'update', '-f', '/run/mm/cfg/pc.yaml')
  const ok = r.ok || /No processes were updated/i.test(r.out + r.err)
  return [{ step: 'app slot', status: ok ? 'ok' : 'fail', detail: ok ? 'the box\'s process manager has the new file' : short(r) }, ...publicUp(root, ip)]
}
/** The host's side of a box's public services: a forwarder from bind_host to the box's address, in its own process
 *  file (pc/box-public/, not pc/projects: mm ls and the gateway read those), and the router entry (`expose`). */
export const BOX_PUBLIC = join(DIRS.pc, 'box-public')
function publicUp(root: string, ip: string): Step[] {
  const { answers: a, services } = resolve(root), steps: Step[] = [], processes: Record<string, unknown> = {}
  const pub = Object.entries(services).filter(([, s]) => s.public_port && s.public)
  const f = join(BOX_PUBLIC, `${a.project}.yaml`)
  if (held()) { rmSync(f, { force: true }); return pub.length ? [{ step: 'public', status: 'skip', detail: 'restore hold: no public routes' }] : [] }
  for (const [n, s] of pub) {
    const bind = s.public_bind || '127.0.0.1'
    // named for its own namespace (<project>-public), so nothing on the host's process manager looks like the box's own
    processes[`${a.project}-public.${n}`] = { namespace: `${a.project}-public`, command: `socat TCP-LISTEN:${s.public_port},bind=${bind},reuseaddr,fork TCP:${ip}:${s.public_port}`,
      log_location: join(hostDir(a.project), `${n}-public.log`), availability: { restart: 'always', backoff_seconds: 3 } }
  }
  mkdirSync(BOX_PUBLIC, { recursive: true })
  if (!pub.length) { rmSync(f, { force: true }); return [] }
  writeFileSync(f, `# Generated by mm for the box ${names(a.project).box}: its public services, forwarded from the host. Do not edit.\nversion: "0.5"\n${Bun.YAML.stringify({ processes }, null, 2)}\n`)
  const r = loadAll(); run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'start', `${a.project}-public`])
  steps.push({ step: 'public forwarders', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `${pub.length} on the host, to ${ip}` : short(r) })
  for (const [, s] of pub) steps.push(routeUp(a, s.public!.name, s.public_port!, s.public!.auth === 'required', `${s.public_url}`))
  // the routes the owner granted through the project API: to the app slot, behind the sign-in unless the owner chose
  // no login (src/api.ts)
  const app = services.app
  if (app?.public_port) for (const g of granted(a.project).routes) steps.push(routeUp(a, `${g.name}.${a.project}`, app.public_port, !g.open, `https://${g.host}`))
  return steps
}
function publicDown(project: string): Step[] {
  const f = join(BOX_PUBLIC, `${project}.yaml`)
  if (!existsSync(f)) return []
  run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'stop', `${project}-public`], { timeoutMs: 60_000 })
  rmSync(f, { force: true }); const r = loadAll()
  return [{ step: 'public forwarders', status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'removed from the host' : short(r) }]
}

/** `mm up` for a box project: network, egress proxy, the box. Idempotent: a running box is restarted with new config. */
export function up(root: string): Step[] {
  const steps: Step[] = [], a = readAnswers(root), n = names(a.project)
  const fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return steps }
  if (!docker('image', 'inspect', IMAGE()).ok || !docker('image', 'inspect', EGRESS_IMAGE()).ok) return fail('image', `missing ${IMAGE()} or ${EGRESS_IMAGE()}: mm box build`)
  // a box-planted change to what the host's git sees: refused before anything is mounted (review sy-b15.6 2c)
  const why = gitRefusal(root); if (why) return fail('git', `refused: ${why}`)
  // 1. the network: internal, no route out
  const net = netOf(a.project, n.net); if (!net) return fail('network', `could not make ${n.net}`)
  steps.push({ step: 'network', status: 'ok', detail: `${n.net} (internal, ${net.subnet}; the box at ${net.ip})` })
  // 2. the egress proxy: on the bridge (out) and on the box's network; its list is read-only to it
  const { edir, hosts } = writeAllow(root)
  if (exists('container', n.proxy)) docker('rm', '-f', n.proxy)
  // ...and the way to mm's AI gateway: its port AI_PORT, on the box's network only (a fixed address, .2), forwards to
  // this box's own socket of mm.ai (the folder mounted here, nowhere else). The socket names the project to the gateway.
  // (0750 and its socket 0660: the proxy gets the owner's group to reach it; review sy-b15.18)
  const pip = net.ip.replace(/\.10$/, '.2'), aiDir = dirname(aiSocket(a.project)); mkdirSync(aiDir, { recursive: true, mode: 0o750 }); chmodSync(aiDir, 0o750)
  // its connection log (every allowed and refused site) into a host folder the shipper reads, stamped with the project
  // by mm, never by the line (sy-b15.1: each connection logged per project)
  const elog = join(hostDir(a.project), 'egress'); mkdirSync(elog, { recursive: true, mode: 0o770 }); chmodSync(elog, 0o770)
  // the file made here, group-writable: the proxy (root with no capabilities, plus the owner's group) appends to it,
  // also after mm box off has given the box's files back to the owner
  const ef = join(elog, 'egress.log')
  try { if (!existsSync(ef)) writeFileSync(ef, '', { mode: 0o660 }); if (statSync(ef).uid === process.getuid?.()) chmodSync(ef, 0o660) } catch {}
  const fwd = `while :; do socat TCP-LISTEN:${AI_PORT},bind=${pip},fork,reuseaddr UNIX-CONNECT:/run/mm/ai/ai.sock 2>/dev/null; sleep 1; done & exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf >>/run/mm/log/egress.log 2>&1`
  const px = docker('run', '-d', '--name', n.proxy, '--label', `mm.project=${a.project}`, '--restart', 'unless-stopped', '--init', '--read-only', '--tmpfs', '/run:size=8m', '--tmpfs', '/var/log/tinyproxy:size=8m',
    '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '256m',
    '--group-add', String(process.getgid?.() ?? 1000), '-v', `${join(edir, 'allow')}:/etc/mm/allow:ro`, '-v', `${aiDir}:/run/mm/ai`, '-v', `${elog}:/run/mm/log`, EGRESS_IMAGE(), 'sh', '-c', fwd)
  if (!px.ok) return fail('egress proxy', short(px))
  const cn = docker('network', 'connect', '--ip', pip, n.net, n.proxy); if (!cn.ok) return fail('egress proxy', short(cn))
  steps.push({ step: 'egress proxy', status: 'ok', detail: `${n.proxy}: ${hosts.length} name(s) (${hosts.slice(0, 4).join(', ')}${hosts.length > 4 ? ', …' : ''})` })
  // 3. the box's process-compose file, read-only to the box
  const hd = hostDir(a.project), cfg = join(hd, 'cfg'), sock = join(hd, 'sock'), stage = join(hd, 'backup')
  mkdirSync(cfg, { recursive: true, mode: 0o755 }); for (const d of [sock, stage]) { mkdirSync(d, { recursive: true }); chmodSync(d, 0o2770) } // the box writes these two (its group)
  // made by the host: the box can't add to the project's top level (release/ too while the project API is on: the box
  // prepares its builds there, release/<build>, and asks the owner to put one on its app slot)
  for (const d of ['.run/logs', '.dolt', '.dolt-root', '.config', ...(apiEnabled() ? ['release'] : [])]) mkdirSync(join(root, d), { recursive: true })
  const bp = writePc(root, n.proxy, net.ip)
  // 4. what the box may know: its Paseo password, and the vault's values its services declare, in a tmpfs folder on
  // the host that the box sees read-only (gone at the host's reboot; mm opens it again at every up)
  // the box's own user (review sy-b15.15 1): never the host's owner (rocky, who has sudo). uid 200000 + its subnet index,
  // with the host owner's group, so the host's tools still reach what the box writes (umask 002 in the box). An escape,
  // or a file the box leaves behind, is an unprivileged uid on the host.
  const id = boxIds(net.subnet), gid = process.getgid?.() ?? 1000
  const sec = vault.runtimeDir(a.project); chmodSync(sec, 0o750) // the box reads (its group), never writes
  copyFileSync(paseoPasswordFile(a.project), join(sec, 'paseo.password')); chmodSync(join(sec, 'paseo.password'), 0o640)
  const declared = [...new Set(Object.values(resolve(root).services).flatMap((x) => x.secrets || []))]
  if (declared.length) {
    if (!vault.ready()) return fail('secrets', `the services declare ${declared.join(', ')}, and this machine has no vault (mm vault init)`)
    for (const f of Object.values(vault.openFor(a.project, declared.map((x) => vault.projectSecretName(a.project, x))))) chmodSync(f, 0o640)
  }
  // ...and the new secrets the owner granted through the project API, once the owner has filled them (sealed):
  // /run/mm/secrets/<project>.<name>, read-only
  const asked = granted(a.project).secrets.map((x) => vault.projectSecretName(a.project, x.name)).filter((x) => !declared.some((d) => vault.projectSecretName(a.project, d) === x))
  const filled = vault.ready() ? asked.filter((x) => vault.sealed(x)) : []
  for (const f of Object.values(filled.length ? vault.openFor(a.project, filled) : {})) chmodSync(f, 0o640)
  // a value the box may no longer have (an undone grant, a secret no service declares now) goes from its folder
  const keep = new Set([...declared.map((d) => vault.projectSecretName(a.project, d)), ...filled])
  for (const f of readdirSync(sec)) if (f.startsWith(`${a.project}.`) && !keep.has(f)) rmSync(join(sec, f), { force: true })
  if (asked.length > filled.length) steps.push({ step: 'secrets asked', status: 'skip', detail: `${asked.length - filled.length} granted secret(s) not filled yet (mm needs -p ${a.project})` })
  // its AI key: a new one at every up (the old ones for the project's own work end), for mm.ai only (sy-b15.10)
  let aiKey = ''
  if (aiOn()) {
    const d = aiStore()
    try { revokeKeys(d, a.project, 'project'); const k = mintKey(d, a.project, { kind: 'project', ttlMs: 31 * 24 * 3600e3 }); writeFileSync(join(sec, 'ai.key'), k.key, { mode: 0o640 }); chmodSync(join(sec, 'ai.key'), 0o640); aiKey = ` + its AI key (until ${k.expires.slice(0, 10)})` }
    finally { d.close() }
  } else rmSync(join(sec, 'ai.key'), { force: true })
  steps.push({ step: 'secrets', status: 'ok', detail: `${declared.length + filled.length} value(s) + the Paseo password${aiKey}, read-only in the box (tmpfs)` })
  // its project API socket (src/api.ts): mm.api makes it in this folder; only this box mounts it, read-only
  const apiDir = apiSocketDir(a.project), apiOn = apiEnabled()
  if (apiOn) { mkdirSync(apiDir, { recursive: true, mode: 0o750 }); chmodSync(apiDir, 0o750) }
  const paseoHome = join(DIRS.mm, 'paseo', a.project), claude = join(DIRS.mm, 'claude', a.project)
  // what the box writes: group-writable (setgid folders keep the group), so the box's uid and the host's owner share it
  for (const d of [root, paseoHome, claude]) {
    mkdirSync(d, { recursive: true, mode: 0o2770 })
    run(['chmod', '-R', 'g+rwX', d], { timeoutMs: 600_000 }); run(['find', d, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+'], { timeoutMs: 600_000 })
  }
  // ...but not the project's top level (review sy-b15.6 2): there the box could rename .git or a mount's parent away, or
  // plant a symlink where a read-only file is missing, for the next mm up to mount
  chmodSync(root, 0o2755)
  // its account: a passwd and group file of its own (read-only), so tools that look the user up (bd's home check,
  // Node's os.userInfo) see the box user with the host's home path
  const acct = join(DIRS.mm, 'box', a.project); mkdirSync(acct, { recursive: true, mode: 0o755 })
  writeFileSync(join(acct, 'passwd'), `root:x:0:0:root:/root:/usr/sbin/nologin\nbox:x:${id.uid}:${gid}:mm box ${a.project}:${HOME}:/bin/bash\n`, { mode: 0o644 })
  writeFileSync(join(acct, 'group'), `root:x:0:\nbox:x:${gid}:\n`, { mode: 0o644 })
  // 5. the box
  if (exists('container', n.box)) docker('rm', '-f', n.box)
  // each one only if it is really there, inside the project: no symlink on the way (Docker would follow it on the host)
  // (.git/info and .git/objects/info too: grafts, alternates and the like would choose what the host's git sees; review
  // sy-b15.6 2a)
  // (site/ too: the host builds the board there, with npm; review sy-b15.6 follow-up 2)
  const rootReal = realpathSync(root), roRel = BOX_READONLY
  const there = roRel.filter((r) => { try { lstatSync(join(rootReal, r)); return true } catch { return false } })
  const linked = there.filter((r) => { try { return realpathSync(join(rootReal, r)) !== join(rootReal, r) } catch { return true } })
  if (linked.length) return fail('box', `refused: ${linked.join(', ')} goes through a symlink (the box may not choose what mm mounts)`)
  const roMounts = there.flatMap((r) => ['-v', `${join(rootReal, r)}:${join(root, r)}:ro`])
  const lim = (k: string, d: string) => String(getPath(loadConfig(), `box.${k}`) || d)
  const r = docker('run', '-d', '--name', n.box, '--hostname', a.project, '--label', `mm.project=${a.project}`, '--network', n.net, '--ip', net.ip, '--restart', 'unless-stopped',
    // no DNS out (review sy-b15.7: lookups are a way out): Docker's own resolver still answers the names on the box's
    // network (its proxy), and forwards everything else to 127.0.0.1, where nothing answers
    '--dns', '127.0.0.1',
    '--user', `${id.uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', lim('pids', '2048'), '--memory', lim('memory', '4g'), '--cpus', lim('cpus', '2'),
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=1g,mode=1777`, '--tmpfs', `${HOME}:rw,nosuid,nodev,size=512m,uid=${id.uid},gid=${gid},mode=0700`, '-e', `HOME=${HOME}`,
    '-v', `${join(acct, 'passwd')}:/etc/passwd:ro`, '-v', `${join(acct, 'group')}:/etc/group:ro`,
    '-v', `${root}:${root}`,
    // the kernel and what decides what the box may do: read-only on top (they change only through mm)
    ...roMounts, '-v', `${cfg}:/run/mm/cfg:ro`, '-v', `${sock}:/run/mm/sock`, '-v', `${stage}:/run/mm/backup`,
    '-v', `${claude}:${claude}`, '-v', `${paseoHome}:${paseoHome}`, '-v', `${sec}:/run/mm/secrets:ro`, ...(apiOn ? ['-v', `${apiDir}:/run/mm/api:ro`] : []),
    '-w', root, IMAGE(), 'sh', '-c', `umask 002 && exec process-compose up -t=false --keep-project -U -u /run/mm/sock/pc.sock -L '${join(root, '.run', 'logs', 'process-compose.log')}' -f /run/mm/cfg/pc.yaml`)
  if (!r.ok) return fail('box', short(r))
  steps.push({ step: 'box', status: 'ok', detail: `${n.box} (read-only root, cap-drop ALL, no-new-privileges)` })
  // what engine scripts and the gateway read, and the box's registration (mm ls, the gateway, the sentinel find it)
  writeRunFiles(root, '/run/mm/sock/pc.sock')
  mkdirSync(BOXES, { recursive: true }); writeFileSync(join(BOXES, `${a.project}.yaml`), `# from ${root}/services.yaml\n# a project box (${n.box}): it runs in its own container, not on this process manager\n`)
  for (let i = 0; i < 60 && !existsSync(join(sock, 'pc.sock')); i++) Bun.sleepSync(500)
  steps.push(existsSync(join(sock, 'pc.sock')) ? { step: 'process manager', status: 'ok', detail: `${Object.keys(bp.processes).length} processes in the box` } : { step: 'process manager', status: 'fail', detail: 'the box did not start its process manager (see .run/logs/process-compose.log)' })
  // the machine's Paseo gets the box as a host (a new entry each up: the password may be new)
  steps.push(paseoJoin(a.project, `${net.ip}:${PASEO_PORT}`))
  // its public services (the board's gated side): forwarded from the host's bind_host to the box, and exposed
  steps.push(...publicUp(root, net.ip))
  return steps
}

export function down(root: string): Step[] {
  const n = names(readAnswers(root).project), steps: Step[] = [...publicDown(readAnswers(root).project)]
  for (const c of [n.box, n.proxy]) if (exists('container', c)) { const r = docker('rm', '-f', c); steps.push({ step: `stop ${c}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'removed' : short(r) }) }
  return steps.length ? steps : [{ step: 'down', status: 'skip', detail: 'not running' }]
}

/** Give the host's owner the files the box made (some are 0600, as their programs make them): before the host packs
 *  or moves the project (mm archive). mm is the only holder of Docker access, so a short-lived root helper does it,
 *  with the project as its only mount. Run only with the box stopped. */
/** chown -R (no symlinks followed) to the host's owner, by a one-shot root helper with no network. */
function giveBack(dirs: string[]) {
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000
  return docker('run', '--rm', '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
    ...dirs.flatMap((d) => ['-v', `${d}:${d}`]), '--entrypoint', 'chown', IMAGE(), '-R', '--no-dereference', `${uid}:${gid}`, ...dirs)
}
export function reclaim(root: string): Step[] {
  const a = readAnswers(root)
  const dirs = [root, join(DIRS.mm, 'paseo', a.project), join(DIRS.mm, 'claude', a.project), hostDir(a.project)].filter(existsSync)
  const r = giveBack(dirs)
  return [{ step: 'reclaim', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `the box's files back to the host's owner (${dirs.length} folder(s))` : short(r) }]
}

/**
 * A box project's schedules (health, backup, ...): the host's `mm cron` runs them in the box, as the box user. The box
 * can't see the machine's backups folder, so `backup` writes to a staging folder in the project (it empties it first),
 * and landBackup then moves what it made out of the box's reach (sy-8gv).
 */
export const backupStage = (root: string) => join(hostDir(readAnswers(root).project), 'backup')
export function jobArgs(root: string, name: string, command: string, env: Record<string, string>) {
  // the box can't write the project's top level (sy-b15.6 2): its health state goes under .run
  const stage = '/run/mm/backup', e = { ...boxEnv(root), HEALTH_STATE: join(root, '.run', 'health.json'), ...env, ...(name === 'backup' ? { BACKUP_DIR: stage } : {}) }
  const script = name === 'backup' ? `umask 002 && mkdir -p '${stage}' && find '${stage}' -mindepth 1 -delete && ${command}` : `umask 002 && ${command}`
  return [...dockerCmd(), 'exec', '-w', root, ...Object.entries(e).flatMap(([k, v]) => ['-e', `${k}=${v}`]), names(readAnswers(root).project).box, 'sh', '-c', script]
}
const STAMP = /^20\d\d-\d\d-\d\dT\d{4}Z$/
/** After a box's backup: its new dated folder(s) go to <backups>/<project>/ as the host owner's; the newest 14 stay. */
export function landBackup(root: string): string {
  const stage = backupStage(root), dest = join(DIRS.backups, readAnswers(root).project)
  const got = existsSync(stage) ? readdirSync(stage).filter((d) => STAMP.test(d) && lstatSync(join(stage, d)).isDirectory()) : []
  if (!got.length) throw new Error(`the box left no backup in ${stage}`)
  const r = giveBack([stage]) // the staging folder itself: the host's, so a symlink in it resolves only inside the helper
  if (!r.ok) throw new Error(`could not take the backup from the box: ${short(r)}`)
  mkdirSync(dest, { recursive: true })
  for (const d of got) {
    try { renameSync(join(stage, d), join(dest, d)) } catch {   // another file system: copy, then remove
      const c = run(['cp', '-a', join(stage, d), join(dest, d)]); if (!c.ok) throw new Error(`copy ${d}: ${short(c)}`)
      rmSync(join(stage, d), { recursive: true, force: true })
    }
  }
  for (const d of readdirSync(dest).filter((x) => STAMP.test(x)).sort().slice(0, -14)) rmSync(join(dest, d), { recursive: true, force: true })
  return `${got.join(', ')} -> ${dest}`
}
boxHook.reclaim = reclaim
/** mm archive, after down and reclaim: the box's network goes too (its subnet is free again). */
export function forget(root: string): Step[] {
  const p = readAnswers(root).project, n = names(p), left = paseoJoin(p, null) // ...and it leaves the machine's Paseo
  if (!exists('network', n.net)) return [left, { step: 'network', status: 'skip', detail: `${n.net}: none` }]
  const r = docker('network', 'rm', n.net)
  return [left, { step: 'network', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `${n.net} removed` : short(r) }]
}
boxHook.forget = forget

/** The box's processes, through its process-compose socket in the project folder. */
export function processes(root: string) {
  const sk = join(hostDir(readAnswers(root).project), 'sock', 'pc.sock')
  try { if (!lstatSync(sk).isSocket()) return [] } catch { return [] } // the box made it: only a real socket
  const r = run(['process-compose', '-U', '-u', sk, 'process', 'list', '-o', 'json'], { timeoutMs: 15_000 })
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
  // umask 002, as for the box's services: what a shell writes stays reachable by the host's owner (the group); and the
  // services' environment (their PATH, names, Paseo, proxy), so a shell sees the box as its services do
  return [...dockerCmd(), 'exec', ...(process.stdin.isTTY ? ['-it'] : ['-i']), '-w', root, ...Object.entries(boxEnv(root)).flatMap(([k, v]) => ['-e', `${k}=${v}`]), names(readAnswers(root).project).box,
    'sh', '-c', 'umask 002 && exec "$@"', 'sh', ...(cmd.length ? cmd : ['bash'])]
}
export const HOME_DIR = HOME
/** `mm box on <project>`: a project on the host moves into its box (its host processes stop and unload first). */
export function on(root: string): Step[] {
  const a = readAnswers(root), steps: Step[] = []
  if (a.box) return [{ step: 'box on', status: 'skip', detail: `${a.project} is a box already` }]
  run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'stop', a.project], { timeoutMs: 120_000 })
  rmSync(join(PROJECTS_PC, `${a.project}.yaml`), { force: true })
  const l = loadAll(); steps.push({ step: 'host', status: l.ok ? 'ok' : 'fail', detail: l.ok ? `${a.project} unloaded from the host's process manager` : short(l) })
  if (!l.ok) return steps
  // the engine as the host has it now (the host's own files): what the host may run of it later (review sy-b15.6)
  sealEngine(root); steps.push({ step: 'engine', status: 'ok', detail: 'bin/ and site/ sealed on the host' })
  // ...and the mm-template commit (the base of every later mm update), from the host's own repo (review sy-055t)
  recordTemplate(root); steps.push({ step: 'template base', status: 'ok', detail: recordedTemplate(a.project) ? `mm-template ${recordedTemplate(a.project).slice(0, 12)} recorded on the host` : 'no mm-template branch to record (mm update refuses until it has one)' })
  steps.push(setBox(root, true), ...up(root))
  return steps
}
/** `mm box off <project>`: back onto the host (the box stops, its files go back to the host's owner). */
export function off(root: string): Step[] {
  const a = readAnswers(root)
  if (!a.box) return [{ step: 'box off', status: 'skip', detail: `${a.project} is not a box` }]
  const steps = [...down(root), ...reclaim(root), paseoJoin(a.project, null)] // on the host, its agents are the machine Paseo's own
  rmSync(join(BOXES, `${a.project}.yaml`), { force: true })
  steps.push(setBox(root, false), ...projectUp(root))
  return steps
}
/** The answers' `box:` line, committed in the project's config repo (as mm update commits its answers). */
function setBox(root: string, on: boolean): Step {
  const why = gitRefusal(root); if (why) return { step: 'answers', status: 'fail', detail: `refused: ${why}` }
  // hardened as it is now, before the answers change (box off commits over the box's files; review sy-b15.6 2b)
  const genv = hostGitEnv(root)
  const f = join(root, '.mm-answers.yaml'), t = readFileSync(f, 'utf8').replace(/^box:.*\n?/m, '')
  writeFileSync(f, on ? `${t.trimEnd()}\nbox: true\n` : t)
  const c = run(['git', '-C', root, 'commit', '-q', '-m', `mm box ${on ? 'on' : 'off'}: the project runs ${on ? 'in its own box' : 'on the host'}`, '.mm-answers.yaml'], { env: { SETUP_HUMAN: '1', ...genv } })
  return { step: 'answers', status: c.ok ? 'ok' : 'fail', detail: c.ok ? `box: ${on}` : short(c) }
}
boxHook.processes = processes
boxHook.up = up
boxHook.down = down
