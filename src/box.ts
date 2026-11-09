// Project boxes (plans/project-box.md, M1-A/B): a project with `box: true` in its answers runs in its own container.
// mm is the only one that starts, stops and wires boxes. Inside: the project's services under process-compose, as
// the box user (no sudo, no Docker socket), with a read-only root, cap-drop ALL, no-new-privileges and limits. The
// project folder is mounted at the same path (so every generated path stays right); the kernel and every file that
// decides what the box may do are mounted read-only on top (review sy-b15.6). The box's network is `internal`: the
// only way out is the project's own egress proxy, with its allowlist (the base list + the project's `egress:`).
import { type Stats, chmodSync, closeSync, constants as fsc, copyFileSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { AI_PORT, aiEnabled, aiSocket, mintKey, revokeKeys, store as aiStore } from './ai'
import { mkdtempSync, rmSync } from 'node:fs'
import { apiEnabled, apiSocketDir, boxApi, granted, noteBoxApi, saveGranted } from './apistate'
import { getPath, held, loadConfig } from './config'
import { DIRS, HOME, run, servicePath, which, within } from './env'
import { MM_LOG_CONFIG } from './obs'
import { personRunsOn } from './personruns'
import { BOX_READONLY, BOXES, boxHook, containersCfg, dependsOn, engineRefusal, gitRefusal, hashPort, hostGitEnv, leaveHost, loadAll, MM_PORTS, processes as pcProcesses, PROJECT_LOG_CONFIG, readAnswers, recordedTemplate, recordTemplate, resolve, routeUp, sealEngine, serviceProcess, serviceRoutes, startSkipped, up as projectUp, writePortlessClaim, writeRunFiles } from './project'
import boxDockerfile from '../box/Dockerfile' with { type: 'text' }
import egressDockerfile from '../box/egress.Dockerfile' with { type: 'text' }
import egressMain from '../box/egress/main.go' with { type: 'text' }
import egressTest from '../box/egress/main_test.go' with { type: 'text' }
import egressMod from '../box/egress/go.mod' with { type: 'text' }
import paseoJoinScript from '../box/paseo-join.mjs' with { type: 'text' }
import npmPackage from '../box/npm/package.json' with { type: 'text' }
import npmLock from '../box/npm/package-lock.json' with { type: 'text' }
import pkg from '../package.json'
import * as vault from './vault'
import { boxRoute } from './names'
import { nameClash, publicKeyPem } from './auth'
import { machineHome as machinePaseoHome } from './paseo'

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
/** The box's uid on this machine: 200000 + the third octet of its subnet (unique per box, never a real user's); its
 *  egress proxy's: 190000 + the same (sy-58fo: the proxy starts as its own uid, never root). */
const boxIds = (subnet: string) => ({ uid: 200000 + Number(subnet.split('.')[2]), egress: 190000 + Number(subnet.split('.')[2]) })
/** mm's uids for a project's containers, never a real account's: an egress proxy's (190010-190249), a box's
 *  (200010-200249), a Doop's (210010-210249). */
const mmUid = (u: number) => [190000, 200000, 210000].some((b) => u >= b + 10 && u <= b + 249)
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
  const home = process.env.MM_PASEO_JOIN_HOME || machinePaseoHome()
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
    mkdirSync(join(dir, 'egress')); for (const [f, t] of [['main.go', egressMain], ['main_test.go', egressTest], ['go.mod', egressMod]]) writeFileSync(join(dir, 'egress', f), t)
    const uid = String(process.getuid?.() ?? 1000)
    for (const [tag, file, args] of [[IMAGE(), 'Dockerfile', ['--build-arg', `UID=${uid}`, '--build-arg', `HOME_DIR=${HOME}`]], [EGRESS_IMAGE(), 'egress.Dockerfile', []]] as const) {
      const r = docker('build', '-q', '-t', tag, '-f', join(dir, file), ...args, dir)
      steps.push({ step: `image ${tag}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? r.out.trim().slice(0, 80) : short(r) })
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
  return steps
}

const exists = (kind: 'container' | 'network', name: string) => docker(kind, 'inspect', name).ok
/** Every docker network's subnets on this machine: the egress proxy refuses them as destinations (sy-59m8), also
 *  when docker was given address pools outside the private ranges. */
export function dockerSubnets(): string[] {
  const ids = docker('network', 'ls', '-q').out.split(/\s+/).filter(Boolean)
  if (!ids.length) return []
  const out = docker('network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', ...ids).out
  return [...new Set(out.split(/\s+/).filter((s) => /^[0-9a-f.:]+\/\d{1,3}$/i.test(s)))].sort()
}
/**
 * What mm keeps for a box outside its project folder (review sy-b15.6 2): the box can rename and replace anything it
 * can write, even around a read-only mount, and Docker follows a symlink in a mount's source on the host. So what the
 * host writes for the box, or mounts into it, lives here: its account files, cfg/ (its process-compose file, read-only
 * in the box at /run/mm/cfg), sock/ (its process manager's socket, /run/mm/sock) and backup/ (/run/mm/backup).
 */
export const hostDir = (project: string) => join(DIRS.mm, 'box', project)

// ---------- a box project's Doop (sy-wo7y) ----------
// The box can't run containers, so its Doop runs on the host, next to it: bin/doop-run (the sealed engine, read-only in
// the box) as a host process of the box's (<project>-public.doop), with DOOP_HOME. Its data, secrets and endpoints are in
// doopHome, a host folder the box never mounts: the box can plant a link anywhere in the project, and Docker follows a
// link in a mount's source; a check before the mount would race the box, a folder it never sees can't. The box reaches
// Doop only through one unix socket (doopSockDir, read-only at /run/mm/doop in that box only), to Doop's own listener;
// the board's public side reaches Doop's gated listener on the host, as for a host project.
/** A box project's Doop on the host: data/ (what data/doop/ holds for a host project), secrets/, endpoints.json. */
export const doopHome = (project: string) => join(hostDir(project), 'doop')
/** The folder of the box's way in to its Doop: doop.sock, made by doop-run (0660, the owner's group). */
export const doopSockDir = (project: string) => join(hostDir(project), 'doop-sock')
const DOOP_BOX_SOCK = '/run/mm/doop/doop.sock'
/** The box's copy of the design lead's agent key, in its read-only secrets (a path only: vault.runtimeDir narrows it). */
const doopKeyTo = (project: string) => join(vault.secretsBase(), project, 'doop-agent-key')
const isLoopback = (h: string) => /^(127\.|localhost$|::1$)/.test(h)
/** The two account secrets a Doop of this project made (designer@<domain>, its password), as files may be read from the
 *  project: what each must look like (the box could have written anything there). The auth secret is never taken: the
 *  box may have read it, and with it make anyone's session; Doop on the host makes a new one. */
const DOOP_ACCOUNT: Record<string, RegExp> = { 'doop-signup-domain': /^[a-z0-9-]{1,63}\.doop\.invalid$/, 'doop-password': /^[A-Za-z0-9_-]{16,128}$/ }
/** A small plain file of the project, never through a link (O_NOFOLLOW; the folder itself checked by realpath), or null. */
function readPlain(dir: string, name: string): string | null {
  let fd = -1
  try {
    if (realpathSync(dir) !== dir) return null
    fd = openSync(join(dir, name), fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK)
    const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > 1024) return null
    return readFileSync(fd, 'utf8').trim()
  } catch { return null } finally { if (fd >= 0) closeSync(fd) }
}
/** The host process that runs the box's Doop, or why not. Writes doopHome's endpoints.json (and its port file). */
function doopProcess(root: string): { process: Record<string, unknown> } | { refused: string } {
  const { answers: a, services } = resolve(root), s = services.doop
  if (!s) return { refused: 'doop is not on' }
  // the host runs this script: only as mm put it there (the template's render, or the engine's seal; review sy-b15.6)
  const why = engineRefusal(root); if (why) return { refused: why }
  const home = doopHome(a.project), sd = doopSockDir(a.project)
  // its data not moved (doopIn refused or failed): no Doop, rather than a new empty one the old data never reaches
  const there = (p: string) => { try { lstatSync(p); return true } catch { return false } }
  if (there(join(root, 'data', 'doop')) && !there(join(home, 'data'))) return { refused: 'its data is still in data/doop/ (see the doop data step)' }
  for (const d of [home, sd]) { mkdirSync(d, { recursive: true, mode: 0o750 }); chmodSync(d, 0o750) }
  writeDoopEndpoints(root)
  // the host's loopback port for doop-run's health check and first start: the same one each time (its file)
  let port = 0; try { port = Number(readFileSync(join(home, 'port'), 'utf8')) } catch {}
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { port = hashPort(`${a.project}/doop-host`); writeFileSync(join(home, 'port'), String(port)) }
  const env: Record<string, string> = { PATH: servicePath(), PORT: String(port), DOOP_URL: String(s.env?.DOOP_URL || s.url || ''),
    DOOP_HOME: home, DOOP_PROJECT: a.project, DOOP_BOX_SOCKET: join(sd, 'doop.sock'), DOOP_AGENT_KEY_TO: doopKeyTo(a.project),
    // the image doop-run starts (it reads it from mm's file): here too, so a new doop.image changes this process's
    // definition and the process manager's project update restarts it on the new image (sy-um8r)
    MM_DOOP_IMAGE: containersCfg().doop_image,
    ...(s.env?.DOOP_PUBLIC_PORT ? { DOOP_PUBLIC_PORT: String(s.env.DOOP_PUBLIC_PORT) } : {}) }
  return { process: { namespace: `${a.project}-public`, command: join(realpathSync(root), 'bin', 'doop-run'), working_dir: home,
    environment: Object.entries(env).map(([k, v]) => `${k}=${v}`), log_location: join(hostDir(a.project), 'doop.log'), log_configuration: MM_LOG_CONFIG,
    availability: { restart: 'always', backoff_seconds: 3 }, shutdown: { timeout_seconds: 30 } } }
}
/** What doop-run reads in DOOP_HOME (never the project's .run/, which the box can write). */
function writeDoopEndpoints(root: string) {
  const { answers: a, services } = resolve(root), home = doopHome(a.project), pub = services.doop?.public_url
  mkdirSync(home, { recursive: true, mode: 0o750 })
  writeFileSync(join(home, 'endpoints.json'), JSON.stringify({ containers: containersCfg(), ...(publicKeyPem() ? { auth: { public_key: publicKeyPem() } } : {}),
    services: { doop: pub ? { public: pub } : {} } }, null, 2), { mode: 0o644 })
}
/**
 * Once, with the box stopped (mm up, before the box starts): the Doop data the project has (data/doop/: from when it
 * ran on the host, kept there by the box go) moves to doopHome, with its account (domain and password, if they look
 * as Doop's do; a new auth secret is made). Never through a link: data/doop must be a folder of the project itself,
 * and what arrives is checked again (a link is removed, never followed). Null: nothing to move.
 */
export function doopIn(root: string): Step | null {
  const a = readAnswers(root), rootReal = realpathSync(root), src = join(rootReal, 'data', 'doop'), home = doopHome(a.project), dst = join(home, 'data')
  const step = 'doop data'
  let st: Stats; try { st = lstatSync(src) } catch { return null }
  try { lstatSync(dst); return { step, status: 'skip', detail: `data/doop/ stays in the project: Doop's data is in ${home.replace(HOME, '~')} already` } } catch {}
  if (!st.isDirectory() || realpathSync(join(rootReal, 'data')) !== join(rootReal, 'data')) return { step, status: 'fail', detail: 'refused: data/doop is not a folder of the project (a link on the way): its Doop was not moved' }
  mkdirSync(home, { recursive: true, mode: 0o750 })
  try { renameSync(src, dst) } catch (e) { return { step, status: 'fail', detail: `could not move data/doop/ to ${home.replace(HOME, '~')}: ${(e as Error).message}` } }
  try { if (!lstatSync(dst).isDirectory()) { rmSync(dst, { force: true }); return { step, status: 'fail', detail: 'refused: data/doop was swapped for a link while it moved; the link was removed' } } } catch {}
  const S = join(home, 'secrets'); mkdirSync(S, { recursive: true, mode: 0o700 }); chmodSync(S, 0o700)
  const took: string[] = []
  for (const [f, re] of Object.entries(DOOP_ACCOUNT)) {
    const v = readPlain(join(rootReal, 'secrets'), f)
    if (v && re.test(v)) { writeFileSync(join(S, f), v, { mode: 0o600 }); took.push(f) }
  }
  return { step, status: 'ok', detail: `data/doop/ moved to ${home.replace(HOME, '~')} (the box doesn't see it)${took.length === 2 ? '; its account kept' : '; no account found: Doop makes a new one'}` }
}
/**
 * The other way, with the box stopped (mm box off, mm archive, through reclaim): Doop's data back into data/doop/ and
 * its secrets into secrets/, where the host's Doop (and mm archive's pack) find them; doopHome goes. Something the box
 * left at data/doop is moved aside (data/doop.box-<time>), never mixed in; a link in secrets/ is removed, never written
 * through.
 */
export function doopOut(root: string): Step[] {
  const a = readAnswers(root), home = doopHome(a.project), from = join(home, 'data'), step = 'doop data'
  if (!existsSync(home)) return []
  // a Doop container its wrapper left (it was killed): stopped the clean way, so its database closes
  const c = `mm-doop-${a.project}`
  if (exists('container', c)) { docker('stop', '-t', '20', c); docker('rm', '-f', c) }
  if (exists('network', `mm-doop-net-${a.project}`)) docker('network', 'rm', `mm-doop-net-${a.project}`)
  const rootReal = realpathSync(root), data = join(rootReal, 'data'), to = join(data, 'doop')
  let moved = ''
  if (existsSync(from)) {
    try { if (!lstatSync(data).isDirectory()) return [{ step, status: 'fail', detail: `data/ is not a folder: Doop's data stays in ${home.replace(HOME, '~')}` }] } catch {}
    mkdirSync(data, { recursive: true })
    try { lstatSync(to); const aside = `${to}.box-${new Date().toISOString().replace(/[:.]/g, '')}`; renameSync(to, aside); moved = `; what was at data/doop is at ${aside.slice(rootReal.length + 1)}` } catch {}
    try { renameSync(from, to) } catch {
      const r = run(['cp', '-a', from, to], { timeoutMs: 900_000 })
      if (!r.ok) return [{ step, status: 'fail', detail: `could not move Doop's data back to data/doop/: ${short(r)}; it stays in ${home.replace(HOME, '~')}` }]
    }
  }
  const S = join(home, 'secrets'), PS = join(rootReal, 'secrets')
  try { if (!lstatSync(PS).isDirectory()) return [{ step, status: 'fail', detail: `secrets/ is not a folder: Doop's secrets stay in ${home.replace(HOME, '~')}` }] } catch {}
  mkdirSync(PS, { recursive: true, mode: 0o700 })
  for (const f of existsSync(S) ? readdirSync(S).filter((x) => /^doop-[a-z-]+$/.test(x)) : []) {
    rmSync(join(PS, f), { force: true }) // a link the box left is removed, not followed; then a new file (wx: never through one)
    try { writeFileSync(join(PS, f), readFileSync(join(S, f)), { mode: 0o600, flag: 'wx' }) } catch (e) { return [{ step, status: 'fail', detail: `secrets/${f}: ${(e as Error).message}; Doop's folder kept in ${home.replace(HOME, '~')}` }] }
  }
  rmSync(home, { recursive: true, force: true }); rmSync(doopSockDir(a.project), { recursive: true, force: true })
  return [{ step, status: 'ok', detail: `Doop's data back in data/doop/, its secrets in secrets/${moved}` }]
}

const running = (name: string) => docker('inspect', '-f', '{{.State.Running}}', name).out.trim() === 'true'
/** The project's box is running (its container, as docker says). */
export const boxRunning = (project: string) => running(names(project).box)

/** The box's egress list: the base list, plus what the project declares (`egress:` in services.yaml), plus the exact
 *  sites the owner granted through the project API (the host's record, src/apistate.ts). Never the model's host for a
 *  person's run: that run reaches the model through mm.ai only (sy-otxx 2, src/personruns.ts). */
export function egressList(root: string): string[] {
  let extra: string[] = []
  try { extra = ((Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { egress?: string[] }).egress || []) } catch {}
  const ok = (h: string) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)
  const project = readAnswers(root).project, api = boxApi(project).granted.egress.map((e) => e.site)
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
/**
 * sy-vsh5: the box's Claude folder trusts the project's own folders before its Paseo starts any agent: the root, each
 * leads/<role> and setup/ (real folders only, never a link). Leads add their own folder again when they start
 * (bin/lead); this is for any agent the box's Paseo starts without them (the Paseo app). Written by mm itself, never by
 * the project's bin/lib/claude.mjs: the box can write the project's files, and the host must not run them. The box can
 * write this folder too, so .claude.json is read as data only, and replaced through a new file (O_EXCL) and a rename:
 * a link planted at either name is replaced, never followed.
 */
export function seedTrust(claude: string, root: string): Step {
  const isDir = (p: string) => { try { return lstatSync(p).isDirectory() } catch { return false } }
  const leads = join(root, 'leads')
  const folders = [root, ...(isDir(leads) ? readdirSync(leads).filter((r) => !r.startsWith('.')).sort().map((r) => join(leads, r)) : []), join(root, 'setup')].filter(isDir)
  const f = join(claude, '.claude.json')
  let j: { projects?: Record<string, Record<string, unknown>> } & Record<string, unknown> = {}
  try {
    const st = lstatSync(f)
    if (st.isFile() && st.size < 8 << 20) { const v = JSON.parse(readFileSync(f, 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) j = v }
  } catch (e) {
    // the box's own file (Claude Code rewrites it 0600 as the box user once an agent ran there): left as it is, never
    // replaced by one that would drop its state; its leads trust their folders at each start (bin/lead)
    if ((e as NodeJS.ErrnoException).code === 'EACCES') return { step: 'claude trust', status: 'skip', detail: "the box's own Claude config (the host can't read it): left as it is; its leads trust their folders at start" }
  }
  const projects: Record<string, Record<string, unknown>> = j.projects && typeof j.projects === 'object' && !Array.isArray(j.projects) ? j.projects : {}
  let added = 0
  for (const p of folders) {
    const e = projects[p] && typeof projects[p] === 'object' ? projects[p] : {}
    if (e.hasTrustDialogAccepted !== true) added++
    projects[p] = { ...e, hasTrustDialogAccepted: true }
  }
  j.projects = projects
  const t = `${f}.mm-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    const fd = openSync(t, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o660)
    try { writeFileSync(fd, JSON.stringify(j, null, 1)) } finally { closeSync(fd) }
    renameSync(t, f)
  } catch (e) {
    rmSync(t, { force: true })
    return { step: 'claude trust', status: 'fail', detail: `could not write the box's Claude trust: ${(e as Error).message}` }
  }
  return { step: 'claude trust', status: 'ok', detail: `${folders.length} project folder(s) trusted for its agents${added ? ` (${added} new)` : ''}` }
}

function boxEnv(root: string): Record<string, string> {
  const { answers: a, pp } = resolve(root), px = names(a.project).proxy, out = `http://${px}:8888`, direct = `localhost,127.0.0.1,.localhost,${px}`
  return { PATH: BOX_PATH, HOME, MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0', PASEO_HOME: join(DIRS.mm, 'paseo', a.project),
    HTTPS_PROXY: out, HTTP_PROXY: out, https_proxy: out, http_proxy: out, NO_PROXY: direct, no_proxy: direct,
    // models only through mm's AI gateway (sy-b15.10): its proxy forwards this port to the box's own socket on the host;
    // the key is the box's (/run/mm/secrets/ai.key), never a provider's
    ANTHROPIC_BASE_URL: `http://${px}:${AI_PORT}` }
}
const aiOn = aiEnabled // the AI gateway on for this machine (`mm config set ai.enabled true`)
/** The check before a service's portless wrapper takes over its name (src/portless-claim.mjs, sy-1qkv), as the box
 *  sees it: writePc puts it in the cfg folder. */
const BOX_CLAIM = '/run/mm/cfg/portless-claim.mjs'
/** The box's own process-compose file: portless (the names) and the project's services, as on the host. */
function boxProcesses(root: string, proxy: string, ip = '') {
  const { answers: a, services, socket, pp } = resolve(root)
  const env = boxEnv(root)
  if (env.HTTPS_PROXY !== `http://${proxy}:8888`) throw new Error(`the box's proxy is ${proxy}, not ${env.HTTPS_PROXY}`)
  const processes: Record<string, unknown> = {
    [`${a.project}.portless`]: { namespace: a.project, command: `portless proxy start --foreground --port ${pp} --no-tls`, environment: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'portless.log'), log_configuration: PROJECT_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${pp}/` }, period_seconds: 3, failure_threshold: 20 } },
    // the box's own Paseo: runs the project's leads as the box user; only on the box network, with mm's password; no
    // relay and no web UI (only the system Paseo has the relay; review sy-b15.8)
    // its agents get the box's AI key from the file at start (never in a config file); none: no model
    // every agent it starts (a lead, or one opened from the Paseo app) gets the project's Claude folder, where mm trusts
    // the project's folders (sy-vsh5): the box's own HOME is a fresh tmpfs that trusts nothing and forgets at each start
    [`${a.project}.paseo`]: { namespace: a.project, command: `sh -c 'umask 007; [ -r /run/mm/secrets/ai.key ] && export ANTHROPIC_API_KEY="$$(cat /run/mm/secrets/ai.key)"; PASEO_PASSWORD="$$(cat /run/mm/secrets/paseo.password)" exec paseo daemon run'`,
      environment: Object.entries({ ...env, CLAUDE_CONFIG_DIR: join(DIRS.mm, 'claude', a.project), PASEO_LISTEN: `0.0.0.0:${PASEO_PORT}`, PASEO_RELAY_ENABLED: 'false', PASEO_WEB_UI_ENABLED: 'false' }).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', 'paseo.log'), log_configuration: PROJECT_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 },
      readiness_probe: { exec: { command: `curl -s -o /dev/null --max-time 2 http://127.0.0.1:${PASEO_PORT}/` }, period_seconds: 3, failure_threshold: 40 } },
  }
  for (const [n, s0] of Object.entries(services)) {
    // its Doop runs on the host (sy-wo7y): in the box only its name (portless), to the box's socket to it; no public
    // side in the box (the host's doop-run has it)
    const s = n !== 'doop' ? s0 : { ...s0, command: `exec socat TCP-LISTEN:$PORT,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${DOOP_BOX_SOCK}`,
      env: { DOOP_URL: String(s0.env?.DOOP_URL || '') }, secrets: undefined, public_port: undefined, public_bind: undefined }
    const p = serviceProcess(root, a.project, n, s, services, { env, socket, pdeath: 'setpriv --pdeathsig TERM ', secretsDir: '/run/mm/secrets', claim: BOX_CLAIM }) as Record<string, unknown>
    if (s.port === 'http') p.depends_on = { ...(p.depends_on as object || {}), [`${a.project}.portless`]: { condition: 'process_healthy' } }
    processes[`${a.project}.${n}`] = p
    // a public service (the board's gated side, the app slot) listens on the box's loopback: its port is forwarded from
    // the box's own address, where only the host reaches it (the host's forwarder from bind_host comes next; Traefik
    // never joins a box network, so a box can't reach Traefik or forge what it passes on; review sy-b15.7 2)
    if (s.public_port && ip) processes[`${a.project}.${n}-public`] = { namespace: a.project,
      command: `socat TCP-LISTEN:${s.public_port},bind=${ip},reuseaddr,fork TCP:127.0.0.1:${s.public_port}`,
      log_location: join(root, '.run', 'logs', `${n}-public.log`), log_configuration: PROJECT_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 } }
  }
  return { project: a.project, processes }
}
/** The box's process-compose file, in the host's folder the box sees read-only (/run/mm/cfg). */
function writePc(root: string, proxy: string, ip: string) {
  const bp = boxProcesses(root, proxy, ip), cfg = join(hostDir(bp.project), 'cfg')
  noteBoxApi(bp.project) // the API's store this file was written from: every later writer keeps to it (sy-jm5)
  mkdirSync(cfg, { recursive: true, mode: 0o755 })
  writePortlessClaim(cfg) // BOX_CLAIM
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
  // (a restored box on hold: its Doop waits too, as a host project's does: it is not inward)
  if (held()) { rmSync(f, { force: true }); return pub.length || services.doop ? [{ step: 'public', status: 'skip', detail: 'restore hold: no public routes, no Doop' }] : [] }
  for (const [n, s] of pub) {
    const bind = s.public_bind || '127.0.0.1'
    // Doop's public side listens on the host itself (doop-run, below): only a forwarder from a bind_host off loopback
    if (n === 'doop' && isLoopback(bind)) continue
    // named for its own namespace (<project>-public), so nothing on the host's process manager looks like the box's own.
    // Doop's is <project>-public.doop-public: <project>-public.doop is the host's Doop itself (below), which took its
    // name and so its place (sy-wo7y: the route reached nothing on bind_host)
    processes[`${a.project}-public.${n === 'doop' ? 'doop-public' : n}`] = { namespace: `${a.project}-public`, command: `socat TCP-LISTEN:${s.public_port},bind=${bind},reuseaddr,fork TCP:${n === 'doop' ? '127.0.0.1' : ip}:${s.public_port}`,
      log_location: join(hostDir(a.project), `${n}-public.log`), log_configuration: MM_LOG_CONFIG, availability: { restart: 'always', backoff_seconds: 3 } }
  }
  // its Doop (sy-wo7y), on the host next to the box
  const doop = services.doop ? doopProcess(root) : null
  if (doop && 'refused' in doop) steps.push({ step: 'doop', status: 'fail', detail: `not started on the host: ${doop.refused}` })
  else if (doop) processes[`${a.project}-public.doop`] = doop.process
  mkdirSync(BOX_PUBLIC, { recursive: true })
  if (!Object.keys(processes).length) return [...steps, ...(existsSync(f) ? publicDown(a.project) : [])]
  writeFileSync(f, `# Generated by mm for the box ${names(a.project).box}: its public services, forwarded from the host, and its Doop. Do not edit.\nversion: "0.5"\n${Bun.YAML.stringify({ processes }, null, 2)}\n`)
  const r = loadAll(); run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'start', `${a.project}-public`])
  steps.push({ step: 'public forwarders', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `${pub.length} on the host, to ${ip}${doop && 'process' in doop ? `; its Doop on the host (${doopHome(a.project).replace(HOME, '~')})` : ''}` : short(r) })
  steps.push(...serviceRoutes(a, Object.fromEntries(pub)))
  // the routes the owner granted through the project API: to the app slot, behind the sign-in unless the owner chose
  // no login (src/api.ts)
  const app = services.app
  if (app?.public_port) for (const g of boxApi(a.project).granted.routes) steps.push(routeUp(a, boxRoute(a.project, g.name), app.public_port, !g.open, `https://${g.host}`))
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
/** sy-duj0: why a box needs its mm up at boot (the process manager's mm.boxes), or null when it runs as mm made it: its
 *  opened-secrets folder is there, this user's, and holds the box's Paseo password. After a boot it is gone (a tmpfs) or
 *  Docker's (made empty as root when Docker brought the box back first). A plain restart of the process manager finds
 *  it as it was, so a running box isn't restarted for nothing. */
export function bootReason(project: string): string | null {
  const d = join(vault.secretsBase(), project)
  let st; try { st = statSync(d) } catch { return 'its secrets folder is missing' }
  if (st.uid !== process.getuid?.()) return `its secrets folder belongs to uid ${st.uid} (Docker made it)`
  if (!existsSync(join(d, 'paseo.password'))) return 'its secrets folder is empty'
  return null
}

/** A box's mm up. Under umask 022 whoever runs it (sy-vsh5's run: an agent's shell has 077, and the box's pc.yaml,
 *  passwd, group and portless claim came out 0600, unreadable by the box user, so its process manager never started).
 *  Every file the box must not read is written with its own mode and chmod (secrets 0640/0600, the Paseo password). */
export function up(root: string): Step[] {
  const was = process.umask(0o022)
  try { return upUnder022(root) } finally { process.umask(was) }
}
function upUnder022(root: string): Step[] {
  const steps: Step[] = [], a = readAnswers(root), n = names(a.project), api = boxApi(a.project)
  const fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return steps }
  if (!docker('image', 'inspect', IMAGE()).ok || !docker('image', 'inspect', EGRESS_IMAGE()).ok) return fail('image', `missing ${IMAGE()} or ${EGRESS_IMAGE()}: mm box build`)
  // a box-planted change to what the host's git sees: refused before anything is mounted (review sy-b15.6 2c)
  const why = gitRefusal(root); if (why) return fail('git', `refused: ${why}`)
  // its public hosts are its own, before it is registered (sy-b15.3: two projects never get one host)
  const clash = nameClash(root); if (clash) return fail('public names', `refused: ${clash}`)
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
  // the file made here, group-writable: the proxy (its own uid with the owner's group, no capabilities) appends to it,
  // also after mm box off has given the box's files back to the owner
  const ef = join(elog, 'egress.log')
  try { if (!existsSync(ef)) writeFileSync(ef, '', { mode: 0o660 }); if (statSync(ef).uid === process.getuid?.()) chmodSync(ef, 0o660) } catch {}
  // the proxy (mm-egress, box/egress/main.go) and the AI forwarder start as the proxy's own uid (190000 + n, never an
  // account, never root) with the owner's group, and no capabilities at all (sy-58fo); the proxy refuses any name that
  // resolves to a non-public address or to a docker network of this machine (MM_EGRESS_DENY), and connects only to the
  // address it checked
  const fwd = `while :; do socat TCP-LISTEN:${AI_PORT},bind=${pip},fork,reuseaddr UNIX-CONNECT:/run/mm/ai/ai.sock 2>/dev/null; sleep 1; done & exec /usr/local/bin/mm-egress >>/run/mm/log/egress.log 2>&1`
  const px = docker('run', '-d', '--name', n.proxy, '--label', `mm.project=${a.project}`, '--restart', 'unless-stopped', '--init', '--read-only', '--tmpfs', '/run:size=8m',
    '--user', `${boxIds(net.subnet).egress}:${process.getgid?.() ?? 1000}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '256m',
    '-e', `MM_EGRESS_DENY=${dockerSubnets().join(',')}`,
    '-v', `${join(edir, 'allow')}:/etc/mm/allow:ro`, '-v', `${aiDir}:/run/mm/ai`, '-v', `${elog}:/run/mm/log`, EGRESS_IMAGE(), 'sh', '-c', fwd)
  if (!px.ok) return fail('egress proxy', short(px))
  const cn = docker('network', 'connect', '--ip', pip, n.net, n.proxy); if (!cn.ok) return fail('egress proxy', short(cn))
  steps.push({ step: 'egress proxy', status: 'ok', detail: `${n.proxy}: ${hosts.length} name(s) (${hosts.slice(0, 4).join(', ')}${hosts.length > 4 ? ', …' : ''})` })
  // 3. the box's process-compose file, read-only to the box
  const hd = hostDir(a.project), cfg = join(hd, 'cfg'), sock = join(hd, 'sock'), stage = join(hd, 'backup')
  mkdirSync(cfg, { recursive: true, mode: 0o755 }); for (const d of [sock, stage]) { mkdirSync(d, { recursive: true }); chmodSync(d, 0o2770) } // the box writes these two (its group)
  // made by the host: the box can't add to the project's top level (release/ too while the project API is on: the box
  // prepares its builds there, release/<build>, and asks the owner to put one on its app slot)
  for (const d of ['.run/logs', '.dolt', '.dolt-root', '.config', ...(api.on ? ['release'] : [])]) mkdirSync(join(root, d), { recursive: true })
  const bp = writePc(root, n.proxy, net.ip)
  // 4. what the box may know: its Paseo password, and the vault's values its services declare, in a tmpfs folder on
  // the host that the box sees read-only (gone at the host's reboot; mm opens it again at every up)
  // the box's own user (review sy-b15.15 1): never the host's owner (who has sudo). uid 200000 + its subnet index,
  // with the host owner's group, so the host's tools still reach what the box writes (umask 002 in the box). An escape,
  // or a file the box leaves behind, is an unprivileged uid on the host.
  const id = boxIds(net.subnet), gid = process.getgid?.() ?? 1000
  // the app the host ran, carried over at box on (sy-im89): its files become the box user's, so the app may set its own
  // modes as it did on the host (an app that chmods its data folder: EPERM on the host owner's files)
  if (api.on && api.granted.release?.id === CARRIED_ID) { const g = giveBuild(root, api.granted.release.build, id.uid, gid); if (g) steps.push(g) }
  const sec = vault.runtimeDir(a.project); chmodSync(sec, 0o750) // the box reads (its group), never writes
  copyFileSync(paseoPasswordFile(a.project), join(sec, 'paseo.password')); chmodSync(join(sec, 'paseo.password'), 0o640)
  const declared = [...new Set(Object.values(resolve(root).services).flatMap((x) => x.secrets || []))]
  if (declared.length) {
    if (!vault.ready()) return fail('secrets', `the services declare ${declared.join(', ')}, and this machine has no vault (mm vault init)`)
    for (const f of Object.values(vault.openFor(a.project, declared.map((x) => vault.projectSecretName(a.project, x))))) chmodSync(f, 0o640)
  }
  // ...and the new secrets the owner granted through the project API, once the owner has filled them (sealed):
  // /run/mm/secrets/<project>.<name>, read-only
  const asked = api.granted.secrets.map((x) => vault.projectSecretName(a.project, x.name)).filter((x) => !declared.some((d) => vault.projectSecretName(a.project, d) === x))
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
  // its project API socket (src/api.ts): mm.api makes it in this folder; only this box mounts it, read-only. Person runs
  // need it too (the box's wake asks for them there, src/boxruns.ts)
  const apiDir = apiSocketDir(a.project), apiOn = api.on || personRunsOn()
  if (apiOn) { mkdirSync(apiDir, { recursive: true, mode: 0o750 }); chmodSync(apiDir, 0o750) }
  const paseoHome = join(DIRS.mm, 'paseo', a.project), claude = join(DIRS.mm, 'claude', a.project)
  mkdirSync(claude, { recursive: true, mode: 0o2770 })
  steps.push(seedTrust(claude, root))
  // sy-avky: a pid lock in the box's Paseo home that the host's owner owns (box off hands the box's files to the owner)
  // is never a live box daemon's (that one writes it as the box user); left there, the box's Paseo can't take it over
  // (EPERM on utime: only a file's owner may set its times). Removed; a link there is removed, never followed.
  try { const pf = join(paseoHome, 'paseo.pid'); if (lstatSync(pf).uid === process.getuid?.()) rmSync(pf, { force: true }) } catch {}
  // what the box writes: group-writable (setgid folders keep the group), so the box's uid and the host's owner share it
  for (const d of [root, paseoHome, claude]) {
    mkdirSync(d, { recursive: true, mode: 0o2770 })
    run(['chmod', '-R', 'g+rwX', d], { timeoutMs: 600_000 }); run(['find', d, '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+'], { timeoutMs: 600_000 })
  }
  // its repos keep group access whatever the umask of the host's git (sy-nxn1: an agent's shell or a cron job with umask
  // 077 left a 0600 index and refs, and git in the box failed until the next mm up); .git/config is the host's and
  // read-only in the box
  for (const g of [root, join(root, 'code')]) if (existsSync(join(g, '.git')))
    run(['git', '-C', g, 'config', 'core.sharedRepository', 'group'], { env: hostGitEnv(root) })
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
  // its Doop (sy-wo7y) runs on the host: its data moves out of the project once, now that no box runs; the box gets
  // only the folder of its socket to it, read-only. Off: neither, and its agent key goes from the box's secrets
  const doopOn = !!resolve(root).services.doop, dsd = doopSockDir(a.project)
  if (doopOn) {
    const moved = doopIn(root); if (moved) steps.push(moved)
    mkdirSync(dsd, { recursive: true, mode: 0o750 }); chmodSync(dsd, 0o750)
  } else rmSync(join(sec, 'doop-agent-key'), { force: true })
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
    // mm's ports out of the box's random ones (sy-gld3: a port-0 listener took the board's fixed port); the box has its
    // own network namespace, so this is the box's kernel setting, not the host's
    '--sysctl', `net.ipv4.ip_local_reserved_ports=${MM_PORTS.lo}-${MM_PORTS.hi}`,
    '--user',`${id.uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', lim('pids', '2048'), '--memory', lim('memory', '4g'), '--cpus', lim('cpus', '2'),
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=1g,mode=1777`, '--tmpfs', `${HOME}:rw,nosuid,nodev,size=512m,uid=${id.uid},gid=${gid},mode=0700`, '-e', `HOME=${HOME}`,
    '-v', `${join(acct, 'passwd')}:/etc/passwd:ro`, '-v', `${join(acct, 'group')}:/etc/group:ro`,
    '-v', `${root}:${root}`,
    // the kernel and what decides what the box may do: read-only on top (they change only through mm)
    ...roMounts, '-v', `${cfg}:/run/mm/cfg:ro`, '-v', `${sock}:/run/mm/sock`, '-v', `${stage}:/run/mm/backup`,
    '-v', `${claude}:${claude}`, '-v', `${paseoHome}:${paseoHome}`, '-v', `${sec}:/run/mm/secrets:ro`, ...(apiOn ? ['-v', `${apiDir}:/run/mm/api:ro`] : []),
    ...(doopOn ? ['-v', `${dsd}:/run/mm/doop:ro`] : []),
    '-w', root, IMAGE(), 'sh', '-c', `umask 002 && exec process-compose up -t=false --keep-project -U -u /run/mm/sock/pc.sock -L '${join(root, '.run', 'logs', 'process-compose.log')}' -f /run/mm/cfg/pc.yaml`)
  if (!r.ok) return fail('box', short(r))
  steps.push({ step: 'box', status: 'ok', detail: `${n.box} (read-only root, cap-drop ALL, no-new-privileges)` })
  // what engine scripts and the gateway read, and the box's registration (mm ls, the gateway, the sentinel find it)
  writeRunFiles(root, '/run/mm/sock/pc.sock')
  mkdirSync(BOXES, { recursive: true }); writeFileSync(join(BOXES, `${a.project}.yaml`), `# from ${root}/services.yaml\n# a project box (${n.box}): it runs in its own container, not on this process manager\n`)
  for (let i = 0; i < 60 && !existsSync(join(sock, 'pc.sock')); i++) Bun.sleepSync(500)
  const pcUp = existsSync(join(sock, 'pc.sock')), healed = pcUp ? healSkipped(root) : []
  steps.push(pcUp ? { step: 'process manager', status: 'ok', detail: `${Object.keys(bp.processes).length} processes in the box${healed.length ? `; started again what it had skipped: ${healed.join(', ')}` : ''}` } : { step: 'process manager', status: 'fail', detail: 'the box did not start its process manager (see .run/logs/process-compose.log)' })
  // the machine's Paseo gets the box as a host (a new entry each up: the password may be new)
  steps.push(paseoJoin(a.project, `${net.ip}:${PASEO_PORT}`))
  // its public services (the board's gated side): forwarded from the host's bind_host to the box, and exposed
  steps.push(...publicUp(root, net.ip))
  return steps
}

/** The box's first start (sy-5pvp): what its own process manager left Skipped (a slow Dolt restarted while bd-serve
 *  waited) started once its dependencies are up, by the host's own bounded pass (startSkipped: never for a dependency
 *  down for good, at most 90 s), on the box's socket, and only the names in mm's file for the box. */
export function healSkipped(root: string): string[] {
  const hd = hostDir(readAnswers(root).project), sk = join(hd, 'sock', 'pc.sock')
  try { if (!lstatSync(sk).isSocket()) return [] } catch { return [] } // the box made it: only a real socket
  for (let i = 0; i < 20 && !pcProcesses(undefined, sk).length; i++) Bun.sleepSync(500) // its list answers once it has loaded
  return startSkipped(dependsOn([join(hd, 'cfg', 'pc.yaml')]), undefined, sk)
}

export function down(root: string): Step[] {
  const n = names(readAnswers(root).project), steps: Step[] = [...publicDown(readAnswers(root).project)]
  for (const c of [n.box, n.proxy]) if (exists('container', c)) { const r = docker('rm', '-f', c); steps.push({ step: `stop ${c}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'removed' : short(r) }) }
  return steps.length ? steps : [{ step: 'down', status: 'skip', detail: 'not running' }]
}

/** What a box's (or Doop's) uid runs over its folders, in a container as that uid (only a file's owner may change its
 *  mode): its own files group-readable and -writable, its folders group-writable and setgid (as bin/doop-run release).
 *  find never follows a symlink. */
const REGROUP = 'find "$@" -user "$(id -u)" \\( \\( -type d -exec chmod g+rwxs {} + \\) -o \\( -type f -exec chmod g+rwX {} + \\) \\) 2>/dev/null; exit 0'
/** The uids of what the host's owner can't read, change or remove in these folders (a file without g+rw, a folder
 *  without g+rwx), not the owner's and not symlinks. */
function closedUids(dirs: string[]): number[] {
  const me = String(process.getuid?.() ?? 1000)
  const r = run(['find', ...dirs, '!', '-user', me, '!', '-type', 'l', '(', '(', '-type', 'f', '!', '-perm', '-060', ')', '-o', '(', '-type', 'd', '!', '-perm', '-070', ')', ')', '-printf', '%U\\n'], { timeoutMs: 600_000 })
  return [...new Set(r.out.split('\n').filter(Boolean).map(Number))].sort((x, y) => x - y)
}
/**
 * Give the host's owner the files the box made (some are 0600, as their programs make them), without root (sy-58fo):
 * a short container as each box uid that owns any of them (a box's or a Doop's, by number; its subnet may have changed)
 * makes its own files group-readable and -writable for the owner's group. No network, no capabilities, its folders the
 * only mounts. Then the host's owner can read, move and remove them (backup landing, mm archive); `take` makes them the
 * owner's again (mm box off). mm is the only holder of Docker access.
 */
export function giveBack(dirs: string[], image = IMAGE()): { ok: boolean; out: string; err: string; uids: number[]; other: number[] } {
  const gid = process.getgid?.() ?? 1000, done = new Set<number>(), other = new Set<number>(), errs: string[] = []
  for (let pass = 0; pass < 3; pass++) { // a folder one uid closed may hide another's files: look again after each pass
    const todo = closedUids(dirs).filter((u) => { if (!mmUid(u)) { other.add(u); return false } return true })
    if (!todo.length || todo.every((u) => done.has(u)) && pass > 0) break
    for (const u of todo) {
      done.add(u)
      const r = docker('run', '--rm', '--network', 'none', '--user', `${u}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        ...dirs.flatMap((d) => ['-v', `${d}:${d}`]), '--entrypoint', 'sh', image, '-c', REGROUP, 'sh', ...dirs)
      if (!r.ok) errs.push(`uid ${u}: ${short(r)}`)
    }
  }
  return { ok: !errs.length, out: '', err: errs.join('; '), uids: [...done], other: [...other] }
}
/**
 * After the regroup, with the box stopped (no box process left to swap a path while it is copied): what mm's uids
 * (mmUid) still own becomes the host owner's, without root and without chown. Each file is copied (a reflink where the
 * file system has them) and the copy renamed over it, mode (no setuid/setgid) and times kept; hard links stay linked;
 * each folder is made again and its entries moved into it; each symlink and named pipe is made again; a socket is
 * removed (no box process listens on it now; its server makes it again). Returns how many it took and what it couldn't.
 */
export function take(dirs: string[]): { taken: number; left: string[] } {
  const me = process.getuid?.() ?? 1000, links = new Map<string, string>(), left: string[] = []
  let taken = 0
  const tmpOf = (p: string) => join(dirname(p), `.mm-take-${randomBytes(6).toString('hex')}`)
  const own = (p: string, st: Stats): boolean => {
    const t = tmpOf(p)
    if (st.isFile()) {
      try {
        const k = `${st.dev}:${st.ino}`, first = links.get(k) // (its other names: nlink falls as each is taken)
        if (first) linkSync(first, t)
        else { copyFileSync(p, t, fsc.COPYFILE_EXCL | fsc.COPYFILE_FICLONE); chmodSync(t, Number(st.mode) & 0o777); utimesSync(t, st.atime, st.mtime) }
        renameSync(t, p); if (st.nlink > 1 && !first) links.set(k, p)
        return true
      } catch { rmSync(t, { force: true }); return false }
    }
    if (st.isSymbolicLink()) {
      try { symlinkSync(readlinkSync(p), t); renameSync(t, p); return true } catch { rmSync(t, { force: true }); return false }
    }
    if (st.isSocket()) { try { rmSync(p); return true } catch { return false } }
    if (st.isFIFO()) {
      const r = run(['mkfifo', '-m', (Number(st.mode) & 0o777).toString(8), t])
      try { if (!r.ok) throw new Error(r.err); renameSync(t, p); return true } catch { rmSync(t, { force: true }); return false }
    }
    if (!st.isDirectory()) return false
    const moved: string[] = []
    try {
      mkdirSync(t, { mode: 0o700 })
      for (const c of readdirSync(p)) { renameSync(join(p, c), join(t, c)); moved.push(c) }
      rmdirSync(p); renameSync(t, p); chmodSync(p, Number(st.mode) & 0o3777); utimesSync(p, st.atime, st.mtime)
      return true
    } catch { // as it was: its entries back in it, never lost
      try { lstatSync(p) } catch { try { renameSync(t, p) } catch {} ; return false }
      for (const c of moved) try { renameSync(join(t, c), join(p, c)) } catch {}
      try { rmdirSync(t) } catch {}
      return false
    }
  }
  const visit = (p: string) => {
    let st: Stats
    try { st = lstatSync(p) } catch { return }
    if (st.uid !== me && mmUid(st.uid)) {
      if (own(p, st)) taken++; else { left.push(p); if (!st.isDirectory()) return }
    }
    if (!st.isDirectory()) return
    let names: string[] = []
    try { names = readdirSync(p) } catch { left.push(p); return }
    for (const n of names) visit(join(p, n))
  }
  for (const d of dirs) visit(d)
  return { taken, left }
}
/** The box's files for the host's owner (mm archive, mm box off: the box is stopped). With `own` (box off), also the
 *  owner's again (take), as the project runs on the host from then on. */
export function reclaim(root: string, own = false): Step[] {
  const a = readAnswers(root)
  const dirs = [root, join(DIRS.mm, 'paseo', a.project), join(DIRS.mm, 'claude', a.project), hostDir(a.project)].filter(existsSync)
  const r = giveBack(dirs)
  // its Doop's data back in the project (sy-wo7y), after the regroup (Doop's uid made many of its files 0600)
  const doop = r.ok ? doopOut(root) : existsSync(doopHome(a.project)) ? [{ step: 'doop data', status: 'fail' as const, detail: `not moved back: the regroup failed; it stays in ${doopHome(a.project).replace(HOME, '~')}` }] : []
  const steps: Step[] = [...doop, { step: 'reclaim', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `the box's files group-writable for the host's owner (${dirs.length} folder(s), ${r.uids.length ? `as uid ${r.uids.join(', ')}` : 'nothing to change'}; no root)${r.other.length ? `; left alone: files of uid ${r.other.join(', ')} (not mm's)` : ''}` : short(r) }]
  if (own) {
    const t = take(dirs)
    steps.push({ step: 'take', status: t.left.length ? 'fail' : 'ok', detail: t.left.length ? `${t.taken} taken; not taken: ${t.left.slice(0, 3).join(', ')}${t.left.length > 3 ? ` and ${t.left.length - 3} more` : ''}` : `${t.taken} file(s) and folder(s) the host owner's again` })
  }
  return steps
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
/** What landBackup landed (sy-0z58: sync used to split the text, and Doop's ", doop" broke it): the folders it moved,
 *  where to, the newest of them (with doop.tar.gz in it when Doop is on), whether Doop's data is in it, and the names
 *  it refused. */
export type Landed = { made: string[]; dest: string; newest: string; doop: 'yes' | 'skipped' | 'none'; refused: string[]; text: string }
/** After a box's backup: its new dated folder(s) go to <backups>/<project>/ as the host owner's; the newest 14 stay.
 *  The text, for cron's log; landed() gives the same as data. */
export function landBackup(root: string): string { return landed(root).text }
export function landed(root: string): Landed {
  const stage = backupStage(root), dest = join(DIRS.backups, readAnswers(root).project)
  const named = existsSync(stage) ? readdirSync(stage).filter((d) => STAMP.test(d) && lstatSync(join(stage, d)).isDirectory()) : []
  // the box names the folder (review sy-rjwg 8): only a real date, not ahead of the host's clock, lands
  const refused = named.map((d) => [d, stampProblem(d)] as const).filter(([, why]) => why)
  const got = named.filter((d) => !stampProblem(d)), said = refused.map(([d, why]) => `refused ${d} (${why})`).join('; ')
  if (!got.length) throw new Error(`the box left no backup in ${stage}${said ? `: ${said}` : ''}`)
  // the staging folder itself is the host's: what the box made in it, group-readable and -writable for the owner (its
  // own uid's regroup, no root), so the owner moves it out and later removes it (no copy here: the box still runs)
  const r = giveBack([stage])
  if (!r.ok) throw new Error(`could not take the backup from the box: ${short(r)}`)
  mkdirSync(dest, { recursive: true })
  for (const d of got) {
    // a folder of the same minute already there (two backups within one minute: a sync after the nightly one, a retry):
    // the new one replaces it. Renamed or copied over it, it would nest in it and the old one would stay the newest (sy-dex7)
    rmSync(join(dest, d), { recursive: true, force: true })
    try { renameSync(join(stage, d), join(dest, d)) } catch {   // another file system: copy, then remove
      const c = run(['cp', '-a', join(stage, d), join(dest, d)]); if (!c.ok) throw new Error(`copy ${d}: ${short(c)}`)
      rmSync(join(stage, d), { recursive: true, force: true })
    }
  }
  // its Doop (sy-wo7y) runs on the host, and its data is out of the box's sight: the host's doop-run backs it up into the
  // newest folder (Doop's own tar while it runs, as bin/backup does for a host project). Away ~30 s: "doop skipped"
  let doop = ''
  const home = doopHome(readAnswers(root).project)
  if (existsSync(join(home, 'data'))) {
    const out = join(dest, got.sort().at(-1)!, 'doop.tar.gz'), why = engineRefusal(root)
    if (why) throw new Error(`doop not backed up: ${why}`)
    writeDoopEndpoints(root)
    const b = run([join(realpathSync(root), 'bin', 'doop-run'), 'backup', out], { cwd: home, timeoutMs: 900_000, env: { DOOP_HOME: home, DOOP_PROJECT: readAnswers(root).project } })
    if (b.code === 75) { rmSync(out, { force: true }); doop = `, doop skipped: ${b.out.trim().replace(/^skipped: /, '') || 'its container did not answer'}` }
    else if (!b.ok) throw new Error(`doop not backed up: ${short(b)}`)
    else { chmodSync(out, 0o600); doop = ', doop' }
  }
  for (const d of readdirSync(dest).filter((x) => STAMP.test(x)).sort().slice(0, -14)) rmSync(join(dest, d), { recursive: true, force: true })
  const newest = [...got].sort().at(-1)!
  return { made: got, dest, newest: join(dest, newest), doop: doop === ', doop' ? 'yes' : doop ? 'skipped' : 'none', refused: refused.map(([d, why]) => `${d} (${why})`),
    text: `${got.join(', ')} -> ${dest}${doop}${said ? `; ${said}` : ''}` }
}
/** Why a box's backup folder name (STAMP's shape, YYYY-MM-DDTHHMMZ) can't land, or '' (review sy-rjwg 8): not a real
 *  date (2026-02-30, hour 25), or more than STAMP_AHEAD_MS (5 min) ahead of the host's clock. */
const STAMP_AHEAD_MS = 5 * 60_000
export function stampProblem(d: string, now = Date.now()): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)(\d\d)Z$/.exec(d); if (!m) return 'not a dated name'
  const [y, mo, da, h, mi] = m.slice(1).map(Number), t = Date.UTC(y, mo - 1, da, h, mi)
  const back = new Date(t)
  if (h > 23 || mi > 59 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) return 'not a real date'
  if (t - now > STAMP_AHEAD_MS) return 'ahead of the host\'s clock'
  return ''
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
/** Wait until a box can take a job (sy-9r57): its container running and its Dolt ready in its process manager. A rollout
 *  (mm update / mm up) restarts a box for about a minute, and a job then fails ("container ... is not running", or "can't
 *  reach its Dolt"). Waits up to `ms` (MM_BOX_WAIT_MS overrides it). Gives what it waited for ('' = nothing) and, when
 *  it is still not ready, why. */
export function waitReady(root: string, ms = Number(process.env.MM_BOX_WAIT_MS) || 180_000): { waited: number; why: string } {
  const a = readAnswers(root), box = names(a.project).box, start = Date.now()
  const why = () => {
    if (!running(box)) return 'the box is not running'
    const ps = processes(root)
    if (!ps.length) return "the box's process manager does not answer yet"
    const d = ps.find((p) => p.name === `${a.project}.dolt` || p.name === 'dolt')
    if (d && !(d.status === 'Running' && (d.is_ready === 'Ready' || d.is_ready === '-'))) return `its Dolt is ${d.status}, ${d.is_ready || 'not ready'}`
    return ''
  }
  for (;;) {
    const w = why()
    if (!w || Date.now() - start >= ms) return { waited: Math.round((Date.now() - start) / 1000), why: w }
    Bun.sleepSync(2000)
  }
}
export function status(root: string) {
  const n = names(readAnswers(root).project)
  const ip = docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${n.net}").IPAddress}}`, n.box).out.trim()
  return { box: n.box, running: running(n.box), proxy: running(n.proxy), ip, image: docker('inspect', '-f', '{{.Config.Image}}', n.box).out.trim(),
    paseo: ip ? `tcp://${ip}:${PASEO_PORT}` : '', password_file: paseoPasswordFile(readAnswers(root).project) }
}
/** A command in the box, as the box user (mm shell). `env`: more of the command's environment (never a secret: it is on
 *  docker's command line). */
export function execArgs(root: string, cmd: string[], tty = !!process.stdin.isTTY, env: Record<string, string> = {}) {
  // umask 002, as for the box's services: what a shell writes stays reachable by the host's owner (the group); and the
  // services' environment (their PATH, names, Paseo, proxy), so a shell sees the box as its services do
  return [...dockerCmd(), 'exec', ...(tty ? ['-it'] : ['-i']), '-w', root, ...Object.entries({ ...env, ...boxEnv(root) }).flatMap(([k, v]) => ['-e', `${k}=${v}`]), names(readAnswers(root).project).box,
    'sh', '-c', 'umask 002 && exec "$@"', 'sh', ...(cmd.length ? cmd : ['bash'])]
}
export const HOME_DIR = HOME
/** `mm box on <project>`: a project on the host moves into its box (its host processes stop and unload first). */
export function on(root: string): Step[] {
  const a = readAnswers(root), steps: Step[] = []
  if (a.box) return [{ step: 'box on', status: 'skip', detail: `${a.project} is a box already` }]
  // its processes stop and leave the host's process manager, also when the portless wrappers ignore TERM (sy-pfbr)
  const l = leaveHost(root, a.project); steps.push({ step: 'host', status: l.ok ? 'ok' : 'fail', detail: l.detail })
  if (!l.ok) return steps
  // ...and its agents on the machine's Paseo (its leads as they ran on the host): archived, so none works on the
  // project's files as the host's owner, past the box (sy-pcyq). Their history stays in Paseo. In the box, its own wake
  // starts its leads on the box's own daemon.
  steps.push(archiveHostAgents(root))
  // the engine as the host has it now (the host's own files): what the host may run of it later (review sy-b15.6)
  sealEngine(root); steps.push({ step: 'engine', status: 'ok', detail: 'bin/ and site/ sealed on the host' })
  // ...and the mm-template commit (the base of every later mm update), from the host's own repo (review sy-055t)
  recordTemplate(root); steps.push({ step: 'template base', status: 'ok', detail: recordedTemplate(a.project) ? `mm-template ${recordedTemplate(a.project).slice(0, 12)} recorded on the host` : 'no mm-template branch to record (mm update refuses until it has one)' })
  // the app the host ran goes with it, as the box's build (sy-im89)
  steps.push(...carryHostApp(root), setBox(root, true), ...up(root))
  return steps
}
/** The machine Paseo's agents whose working folder is inside the project (as mm archive finds them), archived. */
export function archiveHostAgents(root: string): Step {
  const r = run(['paseo', 'ls', '-g', '--json'], { timeoutMs: 30_000 })
  if (!r.ok) return { step: 'host agents', status: 'fail', detail: `could not list the machine's Paseo agents: ${short(r)}` }
  let ids: string[] = []
  try { ids = (JSON.parse(r.out) as { id: string; cwd?: string }[]).filter((x) => within(String(x.cwd || ''), root)).map((x) => x.id) } catch {}
  let n = 0
  for (const id of ids) if (run(['paseo', 'archive', '--force', id], { timeoutMs: 30_000 }).ok) n++
  return { step: 'host agents', status: n === ids.length ? 'ok' : 'fail', detail: ids.length ? `${n}/${ids.length} of its agents on the machine's Paseo archived (their history stays)` : 'none on the machine\'s Paseo' }
}
/** `mm box off <project>`: back onto the host (the box stops, its files go back to the host's owner). */
export function off(root: string): Step[] {
  const a = readAnswers(root)
  if (!a.box) return [{ step: 'box off', status: 'skip', detail: `${a.project} is not a box` }]
  const steps = [...down(root), ...reclaim(root, true), paseoJoin(a.project, null)] // on the host, its agents are the machine Paseo's own
  rmSync(join(BOXES, `${a.project}.yaml`), { force: true })
  steps.push(...uncarryHostApp(root), setBox(root, false), ...projectUp(root))
  return steps
}

// ---------- the app the host ran, into the box and back (sy-im89) ----------
// With the project API on, a box's app slot runs only a build the owner approved (release/<build>, the host's record of
// the grant), never what is in release/ by itself. A project that ran on the host has its deployed app right in
// release/ (its services.yaml: workdir {root}/release). So at box on, while nothing of the project runs, the host moves
// that app into release/host-<time>/ and records it as the box's build: the owner approved the go, which moves the
// project into its box as it is. Every later build goes through the project API. At box off, it goes back to release/.
const CARRIED_ID = 'box-on' // the record's id: carried over at box on, not a request the owner approved through the API
export function carryHostApp(root: string): Step[] {
  const a = readAnswers(root)
  if (!apiEnabled() || granted(a.project).release) return []
  const rel = join(realpathSync(root), 'release')
  let st: Stats; try { st = lstatSync(rel) } catch { return [] }
  if (!st.isDirectory()) return [{ step: 'app', status: 'fail', detail: 'release/ is not a folder: no app carried into the box' }]
  if (!readdirSync(rel).length) return []
  // in place (sy-jif0): release/ stays what services.yaml, the project's deploy and git's worktree link expect (moving
  // it into a build folder broke the worktree, and a deploy would have made a release/ without the app's data)
  saveGranted(a.project, { ...granted(a.project), release: { build: '.', id: CARRIED_ID } })
  return [{ step: 'app', status: 'ok', detail: "the app the host ran (release/, in place) is the box's build (carried over at box on; a new build goes through the project API)" }]
}
/**
 * The carried-over build's files become the box user's (with the box stopped: up() runs this before the box starts).
 * Only a file's owner may change its mode, and the app the host ran sets its own (a data folder 0700, as one project's
 * does). Without root and without chown: the host's owner opens its own files there to the group (folders setgid),
 * then a short container as the box's uid (no network, no capabilities, release/ its only mount) copies the build (the
 * copy is its own), renames the old one aside and the copy into its place, and the host removes the old one. Nothing is
 * removed before the copy is whole. Nothing to do when the box's uid owns all of it already. box off takes it back
 * (reclaim's take), with the rest of the project.
 */
function giveBuild(root: string, build: string, uid: number, gid: number): Step | null {
  // the folder whose entries are given: release/<build>, as one entry of release/; or (build `.`, in place: sy-jif0)
  // each entry of release/ itself, so release/ stays where it is (a git worktree, the project's deploy target)
  const rel = join(realpathSync(root), 'release'), dir = build === '.' ? rel : join(rel, build), me = String(process.getuid?.() ?? 1000)
  const shown = build === '.' ? 'release/' : `release/${build}/`
  try { if (!lstatSync(dir).isDirectory()) return { step: 'app build', status: 'fail', detail: `${shown} is not a folder` } } catch { return null }
  const left = run(['find', dir, '!', '-user', String(uid), '-print', '-quit'])
  if (!left.ok || !left.out.trim()) return null
  // only the entries with something not the box user's yet (sy-wo7y: an entry the box already owned, 0700, was renamed
  // aside and the host owner could not remove it: EACCES, and mm up stopped)
  const names = (build === '.' ? readdirSync(rel).filter((f) => !/^\..+\.(box|host)$/.test(f)) : [build])
    .filter((n) => { const r = run(['find', join(rel, n), '!', '-user', String(uid), '-print', '-quit']); return !r.ok || !!r.out.trim() })
  if (!names.length) return null
  run(['find', dir, '-user', me, '(', '(', '-type', 'd', '-exec', 'chmod', 'g+rwxs', '{}', '+', ')', '-o', '(', '-type', 'f', '-exec', 'chmod', 'g+rw', '{}', '+', ')', ')'])
  try { chmodSync(rel, (lstatSync(rel).mode & 0o7777) | 0o2070) } catch {}
  // each entry: a copy the box's uid owns, the old one renamed aside, the copy into its place (nothing removed first);
  // then the old one goes, by the box's uid too (it may own some of it; the host owner's parts are open to the group).
  // Leftovers of an earlier run (.<n>.box, .<n>.host) go first, as far as the box's uid can remove them.
  const c = docker('run', '--rm', '--network', 'none', '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${rel}:${rel}`, '--entrypoint', 'sh', IMAGE(), '-c',
    'cd "$1" || exit 1; shift; for x in .*.box .*.host; do [ -e "$x" ] && rm -rf "$x" 2>/dev/null; done; set -e; for n in "$@"; do rm -rf ".$n.box"; cp -a "$n" ".$n.box"; mv "$n" ".$n.host"; mv ".$n.box" "$n"; rm -rf ".$n.host" 2>/dev/null || true; done', 'sh', rel, ...names)
  if (!c.ok) return { step: 'app build', status: 'fail', detail: `${shown} stays the host owner's (its app may not set its own modes): ${short(c)}` }
  for (const n of names) { try { rmSync(join(rel, `.${n}.host`), { recursive: true, force: true }) } catch {} } // what is left is harmless; the next run removes it
  return { step: 'app build', status: 'ok', detail: `${shown} is the box user's now (its app sets its own modes, as on the host)` }
}
export function uncarryHostApp(root: string): Step[] {
  const a = readAnswers(root)
  if (!apiEnabled()) return []
  const g = granted(a.project), b = g.release?.id === CARRIED_ID ? g.release.build : ''
  // in place (sy-jif0): the files are where the host runs them already; only the record goes
  if (b === '.') { saveGranted(a.project, { ...g, release: null }); return [{ step: 'app', status: 'ok', detail: "release/ runs on the host again (the box's record of it dropped)" }] }
  // an older box on moved it into release/host-<time>/: back to release/
  if (!/^host-\d{8}t\d{6}$/.test(b)) return []
  const rel = join(realpathSync(root), 'release'), src = join(rel, b)
  let st: Stats; try { st = lstatSync(src) } catch { saveGranted(a.project, { ...g, release: null }); return [] }
  if (!st.isDirectory()) return [{ step: 'app', status: 'fail', detail: `release/${b} is not a folder: the app stays where it is` }]
  const names = readdirSync(src), clash = names.filter((f) => existsSync(join(rel, f)))
  if (clash.length) return [{ step: 'app', status: 'fail', detail: `release/ already has ${clash.slice(0, 3).join(', ')}: the app stays in release/${b}/` }]
  try { for (const f of names) renameSync(join(src, f), join(rel, f)); rmdirSync(src) } catch (e) { return [{ step: 'app', status: 'fail', detail: `could not move release/${b}/ back: ${(e as Error).message}` }] }
  saveGranted(a.project, { ...g, release: null })
  return [{ step: 'app', status: 'ok', detail: `release/${b}/ back in release/, where the host runs it` }]
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
