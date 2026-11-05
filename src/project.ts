// Projects: stamp from the template (mm new), load into the machine's process-compose as a namespace (mm up),
// namespace operations (down/restart), listing and inspection.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getPath, held, loadConfig } from './config'
import { DIRS, engineDirs, HOME, run, toolPath, which } from './env'
import { obsEndpoints } from './obs'
import { publicKeyPem } from './auth'
import { pcRunning, writeBase } from './pc'
import { renderTo, template, templateCommit } from './template'
import pkg from '../package.json'

export interface Answers { client: string; name: string; project: string; short: string; root: string; template_version: string; created: string; profile?: string; throwaway?: boolean; box?: boolean }
const ID = /^[a-z][a-z0-9-]{0,30}$/
export const PROJECTS_PC = join(DIRS.pc, 'projects')
/** Project boxes: one file each (`# from <root>/services.yaml`), so mm, the gateway and the sentinel find them; never
 *  loaded into the host's process manager (a box runs its own). */
export const BOXES = join(DIRS.pc, 'boxes')

export function parseRef(ref: string): { client: string; name: string } {
  const m = /^([a-z][a-z0-9-]{0,30})\/([a-z][a-z0-9-]{0,30})$/.exec(ref || '')
  if (!m) throw new Error(`project must be <client>/<name> (a-z 0-9 -), got "${ref}"`)
  return { client: m[1], name: m[2] }
}
export const rootOf = (client: string, name: string) => join(DIRS.projects, client, name)
/** A project's folder from `client/name` or its project id: the usual place, else any folder one or two levels under
 *  ~/projects whose .mm-answers.yaml says so (projects that predate mm keep their folder, e.g. ~/projects/playground). */
export function findRoot(ref: string): string {
  const m = /^([a-z][a-z0-9-]{0,30})\/([a-z][a-z0-9-]{0,30})$/.exec(ref || '')
  if (m && existsSync(join(rootOf(m[1], m[2]), '.mm-answers.yaml'))) return rootOf(m[1], m[2])
  const dirs: string[] = [DIRS.system]
  for (const a of existsSync(DIRS.projects) ? readdirSync(DIRS.projects) : []) {
    dirs.push(join(DIRS.projects, a))
    try { for (const b of readdirSync(join(DIRS.projects, a))) dirs.push(join(DIRS.projects, a, b)) } catch {}
  }
  for (const d of dirs) {
    if (!existsSync(join(d, '.mm-answers.yaml'))) continue
    try { const a = readAnswers(d); if (`${a.client}/${a.name}` === ref || a.project === ref) return d } catch {}
  }
  throw new Error(`no project "${ref}" (want <client>/<name> or a project id; see mm ls)`)
}
export function readAnswers(root: string): Answers {
  return Bun.YAML.parse(readFileSync(join(root, '.mm-answers.yaml'), 'utf8')) as Answers
}
const portlessPort = () => Number(getPath(loadConfig(), 'portless_port') ?? 1355)
/** A stable port for <key>: hash in 38100-38999, stepping past ports already in use (Dolt's TCP, public services). */
function hashPort(key: string): number {
  let p = 38100 + (parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) % 900)
  const used = run(['ss', '-Hltn']).out
  while (new RegExp(`:${p}\\b`).test(used)) p = p === 38999 ? 38100 : p + 1
  return p
}

// ---------- mm new ----------
type Step = { step: string; status: 'ok' | 'fail' | 'skip'; detail: string }
export type NewOpts = { short?: string; profile?: string; root?: string; project?: string; throwaway?: boolean; box?: boolean }
/** The project-local tools (bd, dolt) from tools.json, checksums verified. Used by mm new and mm restore. */
export async function installTools(root: string): Promise<Step[]> {
  const steps: Step[] = []
  const tools = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'))
  mkdirSync(join(root, 'tools'), { recursive: true })
  for (const t of ['bd', 'dolt']) {
    const spec = tools[t]['linux-x64']
    // GitHub's release downloads fail now and then (502/504, a cut-off body): try again, up to 4 times; the checksum
    // still decides (a body that never matches fails)
    // ...and a copy is kept by its checksum (~/.mm/cache/tools/<sha256>), so a new project doesn't need GitHub at all
    // once this machine has it; the copy is used only if it still has that checksum
    const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
    const cached = join(DIRS.mm, 'cache', 'tools', String(spec.sha256).replace(/[^0-9a-f]/g, ''))
    let buf = new Uint8Array(), got = '', why = ''
    try { buf = new Uint8Array(readFileSync(cached)); got = sha(buf) } catch {}
    for (let i = 0; i < 4 && got !== spec.sha256; i++) {
      if (i) await Bun.sleep(3000 * i)
      try {
        const r = await fetch(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
        buf = new Uint8Array(await r.arrayBuffer()); got = sha(buf)
        if (r.ok && got === spec.sha256) { try { mkdirSync(dirname(cached), { recursive: true }); writeFileSync(cached, buf) } catch {} break }
        why = r.ok ? `checksum mismatch (${got})` : `download failed (HTTP ${r.status})`
      } catch (e) { why = `download failed (${(e as Error).message})` }
    }
    if (got !== spec.sha256) throw new Error(`${t}: ${why}`)
    const tmp = join(root, `.tools-${t}.tar.gz`)
    writeFileSync(tmp, buf)
    const x = run(['tar', '-xzf', tmp, '-C', join(root, 'tools'), spec.extract])
    run(['rm', '-f', tmp])
    if (!x.ok) throw new Error(`${t}: ${x.err}`)
    if (spec.extract !== t) run(['mv', join(root, 'tools', spec.extract), join(root, 'tools', t)])
    steps.push({ step: `tool ${t}`, status: 'ok', detail: `${tools[t].version} (sha256 ok)` })
  }
  return steps
}

export async function newProject(ref: string, o: NewOpts = {}): Promise<{ answers: Answers; steps: Step[] }> {
  const { client, name } = parseRef(ref)
  const profile = o.profile || 'project', product = profile === 'project'
  const root = o.root || rootOf(client, name)
  if (existsSync(join(root, '.mm-answers.yaml')) || (existsSync(root) && readdirSync(root).length)) throw new Error(`${root.replace(HOME, '~')} already exists`)
  const short = o.short
  const steps: Step[] = []
  const step = (s: string, detail: string) => steps.push({ step: s, status: 'ok', detail })
  const must = (s: string, r: { ok: boolean; out: string; err: string }) => { if (!r.ok) throw new Error(`${s}: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`); step(s, (r.out.trim().split('\n').pop() || 'done').slice(0, 100)) }
  const answers: Answers = {
    client, name, project: o.project || `${client}-${name}`, short: short || name.replace(/[^a-z]/g, '').slice(0, 2) || 'pj',
    root, template_version: pkg.version, created: new Date().toISOString(), ...(product ? {} : { profile }), ...(o.throwaway ? { throwaway: true } : {}), ...(o.box ? { box: true } : {}),
  }
  if (!/^[a-z]{1,8}$/.test(answers.short)) throw new Error('short (item id prefix) must be 1-8 letters')

  // 1. render the template
  const t = template()
  answers.template_version = t.version
  const vars: Record<string, string> = { client, name, project: answers.project, short: answers.short, root, home: HOME, brain: DIRS.brain, projects: DIRS.projects, mm: DIRS.mm, claude_dir: join(DIRS.mm, 'claude', answers.project), profile }
  renderTo(root, vars, t)
  writeFileSync(join(root, '.mm-answers.yaml'), `# Answers mm new used for this project (mm update renders the template again with these).\n${Bun.YAML.stringify(answers, null, 2)}\n`)
  step('template', `${t.files.length} files, version ${answers.template_version}`)

  // 2. repos: config (the project root) and product (code/)
  const git = (args: string[], cwd = root) => run(['git', ...args], { cwd })
  must('config repo', git(['init', '-q', '-b', 'main']))
  git(['config', 'user.name', 'mm']); git(['config', 'user.email', `mm@${answers.project}.local`])
  // the pure render is main's first commit and the mm-template branch: the base for every later `mm update`
  const base = templateCommit(root, vars, `template ${t.version}`, undefined, t)
  must('template baseline', git(['reset', '-q', base])); git(['branch', 'mm-template', base])
  if (product) { // the product repo (code/); the system profile has none: its leads work on the machine's own repos
    mkdirSync(join(root, 'code'), { recursive: true })
    const code = join(root, 'code')
    git(['init', '-q', '-b', 'main'], code); git(['config', 'user.name', 'mm'], code); git(['config', 'user.email', `mm@${answers.project}.local`], code)
    writeFileSync(join(code, '.gitignore'), 'node_modules/\ndata/\n.claude/settings.local.json\n')
    writeFileSync(join(code, 'README.md'), `# ${name}\n\nProduct repo of ${answers.project}. Leads land work here; see ../CLAUDE.md.\n`)
    git(['add', '-A'], code)
    must('product repo', git(['commit', '-q', '-m', 'init'], code))
  }

  // 3. project-local tools (bd, dolt), verified against tools.json
  steps.push(...await installTools(root))

  // 4. board database, data, board build
  must('control (bin/init)', run([join(root, 'bin', 'init'), answers.short], { cwd: root, timeoutMs: 300_000 }))
  const themes = ['birds', 'scientists', 'mythology', 'cities', 'gems', 'stars']
  must('personas', run(['node', join(root, 'bin', 'persona'), 'theme', themes[Math.floor(Math.random() * themes.length)]], { cwd: root }))
  must('board build', run(['sh', '-c', 'npm ci --no-audit --no-fund --silent && npm run build --silent'], { cwd: join(root, 'site'), timeoutMs: 900_000 }))
  must('governance check', run([join(root, 'bin', 'config-check'), '--render'], { cwd: root }))
  git(['add', '-A'])
  must('config commit', run(['git', 'commit', '-q', '-m', `mm new ${client}/${name}${product ? '' : ` (profile ${profile})`} (template ${answers.template_version})`], { cwd: root, env: { SETUP_HUMAN: '1' } }))
  git(['config', 'core.hooksPath', 'ops/githooks'])

  // 5. lead worktrees (roles without workers)
  if (product) {
    const roles = JSON.parse(readFileSync(join(root, 'leads', 'roles.json'), 'utf8')).roles as { id: string; workers?: boolean }[]
    for (const r of roles.filter((x) => !x.workers)) run([join(root, 'bin', 'wt'), `lead-${r.id}`], { cwd: root })
    step('worktrees', roles.filter((x) => !x.workers).map((x) => `lead-${x.id}`).join(' '))
  }

  // 6. services into the machine's process manager
  steps.push(...up(root))
  return { answers, steps }
}

// ---------- services.yaml -> process-compose project file + .run/ ----------
type Svc = { about?: string; command: string; secrets?: string[]; workdir?: string; env?: Record<string, string>; port?: 'http' | 'internal' | 'none'
  public?: { name: string; auth: string }; depends_on?: Record<string, string>; ready?: { http?: string; socket?: string }; restart?: string; optional?: boolean; outward?: boolean }

/** Does this board's server have the gateway-checked public side (BOARD_PUBLIC_PORT)? Older templates don't. */
function boardHasPublicSide(root: string) {
  try { return readFileSync(join(root, 'site', 'server.mjs'), 'utf8').includes('BOARD_PUBLIC_PORT') } catch { return false }
}
export function resolve(root: string) {
  const a = readAnswers(root)
  const spec = Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { services: Record<string, Svc>; schedules?: Record<string, { every: string; command: string }> }
  // ports already given out stay put across reloads (the old process may still hold them while we decide)
  let prev: { services?: Record<string, { public_port?: number }>; dolt_port?: number } = {}
  try { prev = JSON.parse(readFileSync(join(root, '.run', 'services.json'), 'utf8')) } catch {}
  const pp = portlessPort(), socket = join(root, '.dolt', 'mysql.sock'), dport = prev.dolt_port ?? hashPort(`${a.project}/dolt`)
  const url = (s: string) => `http://${s}.${a.project}.localhost:${pp}`
  const fill = (v: string) => v.replaceAll('{root}', root).replaceAll('{home}', HOME).replaceAll('{project}', a.project)
    .replaceAll('{socket}', socket).replaceAll('{dolt_port}', String(dport)).replaceAll('{portless_port}', String(pp)).replace(/\{url:([\w-]+)\}/g, (_m, s) => url(s))
  const c = loadConfig(), access = String(getPath(c, 'access') ?? ''), domain = String(getPath(c, 'domain') ?? '')
  const bindHost = String(getPath(c, 'bind_host') ?? '127.0.0.1')
  const services: Record<string, Svc & { url?: string; public_url?: string; public_port?: number; public_bind?: string }> = {}
  for (const [n, s] of Object.entries(spec.services)) {
    if (s.optional && n === 'app' && !existsSync(join(root, 'release'))) continue // app starts once something is deployed
    const env = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, fill(String(v))]))
    // domain mode: a public service gets a stable port. The service itself stays on loopback (portless and the health
    // checks reach it there); the web proxy reaches it through mm's forwarder on bind_host (up(): <service>-public),
    // so nothing listens on every interface. bind_host on loopback (a proxy on the host itself): no forwarder needed.
    let pub: { public_url?: string; public_port?: number; public_bind?: string } = {}
    if (s.public && access === 'domain' && domain) {
      const port = prev.services?.[n]?.public_port ?? hashPort(`${a.project}/${n}`)
      // a service behind the gateway (auth: required, the boards) gets its own public listener on that port, if its
      // server has one (a board still on an older template doesn't: it keeps serving the public port itself until
      // `mm update` brings the listener, so its route never goes dark); an open one (the app slot) serves it itself
      const gated = s.public.auth === 'required' && boardHasPublicSide(root)
      Object.assign(env, gated ? { BOARD_PUBLIC_PORT: String(port) } : { PORTLESS_APP_PORT: String(port) })
      pub = { public_url: `https://${fill(s.public.name)}.${domain}`, public_port: port, public_bind: bindHost }
    }
    services[n] = { ...s, command: fill(s.command), workdir: s.workdir && fill(s.workdir), env, ...(s.port === 'http' ? { url: url(n) } : {}), ...pub,
      ...(s.public ? { public: { ...s.public, name: fill(s.public.name) } } : {}) }
  }
  const schedules = Object.fromEntries(Object.entries(spec.schedules || {}).map(([k, v]) => [k, { ...v, command: fill(v.command) }]))
  return { answers: a, services, schedules, socket, url, pp, dport }
}

type SvcResolved = ReturnType<typeof resolve>['services'][string]
/** One service as a process-compose process, on the host or in a project box. Host: secrets through `mm vault run`.
 *  Box (secretsDir): mm isn't in the box, so the service gets <NAME>_FILE paths in the read-only secrets mount. */
export function serviceProcess(root: string, project: string, n: string, s: SvcResolved, services: Record<string, SvcResolved>,
  o: { env: Record<string, string | undefined>; socket: string; pdeath: string; secretsDir?: string }): Record<string, unknown> {
  let cmd = s.command.replaceAll('$PORT', '$$$$PORT') // keep $PORT for the service's shell (process-compose would expand it)
  const files: Record<string, string> = {}
  // secrets the service declares: opened at every start (the runtime folder is memory-backed: gone after a reboot)
  if (s.secrets?.length && o.secretsDir) for (const x of s.secrets) files[`${x.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FILE`] = join(o.secretsDir, `${project}.${x.toLowerCase()}`)
  else if (s.secrets?.length) cmd = `${which('mm') || join(DIRS.bin, 'mm')} vault run ${project} ${s.secrets.join(',')} -- sh -c '${cmd.replaceAll("'", `'"'"'`)}'`
  // the service dies with its wrapper (portless): no orphan keeps the port after a crash or kill
  if (s.port === 'http') cmd = `portless ${n}.${project} ${o.pdeath}sh -c '${cmd.replaceAll("'", `'"'"'`)}'`
  const probe = s.ready?.http ? { exec: { command: `curl -sf -o /dev/null --max-time 3 ${s.url}${s.ready.http}` } }
    : s.ready?.socket ? { exec: { command: `test -S ${o.socket}` } } : undefined
  return {
    namespace: project, command: cmd, working_dir: s.workdir || root,
    environment: Object.entries({ ...o.env, MM_SERVICE: n, ...files, ...s.env }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
    log_location: join(root, '.run', 'logs', `${n}.log`),
    log_configuration: { add_timestamp: true, timestamp_format: '2006-01-02T15:04:05.000Z07:00', flush_each_line: true, rotation: { max_size_mb: 20, max_backups: 3 } },
    availability: { restart: s.restart === 'on_failure' ? 'on_failure' : 'always', backoff_seconds: 3 },
    ...(probe ? { readiness_probe: { ...probe, initial_delay_seconds: 1, period_seconds: 3, timeout_seconds: 4, failure_threshold: 20 } } : {}),
    // hung (running, not answering) for ~1 min: the manager restarts it (health only reports)
    ...(s.ready?.http ? { liveness_probe: { ...probe, initial_delay_seconds: 30, period_seconds: 10, timeout_seconds: 5, failure_threshold: 6 } } : {}),
    ...(s.depends_on ? { depends_on: Object.fromEntries(Object.keys(s.depends_on).filter((d) => services[d]).map((d) => [`${project}.${d}`, { condition: services[d].ready ? 'process_healthy' : 'process_started' }])) } : {}),
  }
}

/** A project with `box: true` runs in its own container (src/box.ts registers this when it loads): every caller of up()
 *  (mm up, new, update, restore) gets the box without a second code path. */
export const boxHook: { up: ((root: string) => Step[]) | null; down: ((root: string) => Step[]) | null; reclaim: ((root: string) => Step[]) | null; forget: ((root: string) => Step[]) | null
  processes: ((root: string) => { name: string; status: string; is_ready: string; restarts: number }[]) | null } = { up: null, down: null, reclaim: null, forget: null, processes: null }

/** What engine scripts read at runtime (.run/services.json, .run/endpoints.json), on the host or in a box (whose
 *  process manager has its own socket); the gateway reads services.json for each board's public name. */
/**
 * Write a file in a folder a box may write (review sy-b15.6 2): never through a symlink. The folder must be where it
 * says (no symlink on the way from the project root); the file goes to a fresh temp name ('wx': not an existing name or
 * link) and is renamed over the old name, which replaces a planted link instead of following it.
 */
export function writeInProject(root: string, rel: string, data: string) {
  const dir = dirname(join(root, rel)), want = join(realpathSync(root), dirname(rel))
  mkdirSync(dir, { recursive: true })
  if (realpathSync(dir) !== want) throw new Error(`${dirname(rel)} in ${root} goes through a symlink: not writing ${rel}`)
  const tmp = join(want, `.${rel.split('/').pop()}.${randomBytes(6).toString('hex')}.tmp`)
  try { writeFileSync(tmp, data, { flag: 'wx' }); renameSync(tmp, join(want, rel.split('/').pop()!)) } catch (e) { rmSync(tmp, { force: true }); throw e }
}
export function writeRunFiles(root: string, pcSocket: string) {
  const { answers: a, services, schedules, dport } = resolve(root)
  writeInProject(root, '.run/services.json', JSON.stringify({ project: a.project, dolt_port: dport, services, schedules }, null, 2))
  const ep = { manager: 'process-compose (mm)', self_healing: true, restart: `process-compose -U -u ${pcSocket} process restart ${a.project}.{service}`,
    logs: `tail -n {lines} ${join(root, '.run', 'logs')}/{service}.log`, observability: obsEndpoints(), dirs: engineDirs(),
    ...(publicKeyPem() ? { auth: { public_key: publicKeyPem() } } : {}), // the gateway's key: boards verify its assertions
    services: Object.fromEntries(Object.entries(services).map(([n, s]) => [n, { ...(s.url ? { url: s.url } : {}), ...(s.public_url ? { public: s.public_url } : {}) }])) }
  writeInProject(root, '.run/endpoints.json', JSON.stringify(ep, null, 2))
}

export function up(root: string): Step[] {
  if (boxHook.up && readAnswers(root).box) return boxHook.up(root)
  const { answers: a, services, schedules, socket, pp, dport } = resolve(root)
  const steps: Step[] = []
  mkdirSync(join(root, '.run', 'logs'), { recursive: true }); mkdirSync(join(root, '.dolt'), { recursive: true }); mkdirSync(PROJECTS_PC, { recursive: true })
  const obs = obsEndpoints() as { traces?: string; metrics?: string }
  const env = { PATH: toolPath(), MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0',
    ...(obs.traces ? { MM_OBS_TRACES: obs.traces, MM_OBS_METRICS: obs.metrics } : {}) }
  const processes: Record<string, unknown> = {}
  const pdeath = run(['sh', '-c', 'command -v setpriv']).ok ? 'setpriv --pdeathsig TERM ' : ''
  // a restored box on hold (until the human says the old box is down): only what stays inside the box starts.
  // `outward: false` declares it; mm's own board engine counts as inward; anything else (wake starts leads, the app
  // slot, public routes) is held back, so an unknown service is never let out by default
  const hold = held(), held_back: string[] = []
  const inward = (n: string, s: Svc) => s.outward === false || (s.outward === undefined && ['dolt', 'bd-serve', 'board'].includes(n))
  for (const [n, s] of Object.entries(services)) {
    if (hold && !inward(n, s)) { held_back.push(n); continue }
    processes[`${a.project}.${n}`] = serviceProcess(root, a.project, n, s, services, { env, socket, pdeath })
  }
  // public services: a forwarder from bind_host to the service's loopback port (the web proxy runs in docker)
  for (const [n, s] of Object.entries(services)) {
    const bind = s.public_bind, port = s.public_port
    if (!port || !bind || /^(127\.|localhost$|::1$)/.test(bind)) continue
    if (hold) { held_back.push(`${n}-public`); continue }
    processes[`${a.project}.${n}-public`] = {
      namespace: a.project, command: `${pdeath}socat TCP-LISTEN:${port},bind=${bind},reuseaddr,fork TCP:127.0.0.1:${port}`, working_dir: root,
      log_location: join(root, '.run', 'logs', `${n}-public.log`),
      // no depends_on: loaded into a running process manager, a dependent can wait for a 'started' event that has
      // already passed (it stays Pending); the forwarder needs nothing up to listen, connections just fail until then
      availability: { restart: 'always', backoff_seconds: 3 },
    }
  }
  writeFileSync(join(PROJECTS_PC, `${a.project}.yaml`), `# Generated by mm from ${root.replace(HOME, '~')}/services.yaml. Do not edit.\nversion: "0.5"\n${Bun.YAML.stringify({ processes }, null, 2)}\n`)
  writeRunFiles(root, DIRS.socket)
  steps.push({ step: 'services', status: 'ok', detail: `${Object.keys(processes).length} processes, namespace ${a.project}` })
  if (hold) steps.push({ step: 'held', status: 'skip', detail: `restore hold: not started: ${held_back.join(', ') || 'nothing'}; no public routes (mm restore --release)` })
  if (!pcRunning()) { steps.push({ step: 'process manager', status: 'fail', detail: 'not running and could not be started: run `mm onboard`' }); return steps }
  const r = loadAll()
  steps.push({ step: 'process manager', status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'loaded (project update)' : r.err.trim().slice(0, 200) })
  run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'start', a.project])
  // public routes (domain mode): the machine's `expose` tool writes the router entry
  for (const [, s] of Object.entries(services)) {
    if (!s.public_port || !s.public || hold) continue
    if (!run(['sh', '-c', 'command -v expose']).ok) { steps.push({ step: `public ${s.public.name}`, status: 'fail', detail: 'no `expose` tool on this machine' }); continue }
    const r = run(['expose', s.public.name, String(s.public_port), ...(s.public.auth === 'required' ? ['--auth'] : [])], { timeoutMs: 30_000 })
    steps.push({ step: `public ${s.public.name}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? `${s.public_url}${s.public.auth === 'required' ? ' (password)' : ''}` : (r.err || r.out).trim().slice(0, 160) })
  }
  return steps
}

/** Load the base file plus every project file into the running process-compose. */
export function loadAll() {
  writeBase()
  const files = [join(DIRS.pc, 'base.yaml'), ...(existsSync(PROJECTS_PC) ? readdirSync(PROJECTS_PC).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(PROJECTS_PC, f)) : [])]
  const r = run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'update', ...files.flatMap((f) => ['-f', f])], { timeoutMs: 60_000 })
  // nothing to change (e.g. the last project was just removed) is not a failure
  return /No processes were updated/i.test(r.out + r.err) ? { ...r, ok: true } : r
}

export function namespaceOp(ref: string, op: 'start' | 'stop' | 'restart') {
  return run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', op, readAnswers(findRoot(ref)).project], { timeoutMs: 120_000 })
}

export function processes(project?: string) {
  const r = run(['process-compose', '-U', '-u', DIRS.socket, 'process', 'list', '-o', 'json'], { timeoutMs: 15_000 })
  if (!r.ok) return []
  const all = JSON.parse(r.out) as { name: string; namespace: string | string[]; status: string; is_ready: string; restarts: number }[]
  const ns = (p: { namespace: string | string[] }) => (Array.isArray(p.namespace) ? p.namespace : [p.namespace])
  return project ? all.filter((p) => ns(p as never).includes(project)) : all
}

export function listProjects() {
  const out: { project: string; root: string; processes: string; ready: string; throwaway?: boolean; box?: boolean }[] = []
  // projects on the host's process manager, and project boxes (registered by mm: they run in their own container)
  for (const [dir, box] of [[PROJECTS_PC, false], [BOXES, true]] as const) for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.yaml')) : []) {
    const project = f.replace(/\.yaml$/, '')
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(dir, f), 'utf8'))
    const root = (m ? m[1] : '').replace(/^~(?=\/)/, HOME)
    const ps = box ? (boxHook.processes ? boxHook.processes(root) : []) : processes(project)
    let throwaway = false // a short-lived test project (mm new --throwaway): the system's sentinel raises nothing for it
    try { throwaway = !!readAnswers(root).throwaway } catch {}
    out.push({ project, root: m ? m[1] : '?', processes: `${ps.filter((p) => p.status === 'Running').length}/${ps.length} running`, ready: `${ps.filter((p) => p.is_ready === 'Ready').length} ready`, ...(throwaway ? { throwaway } : {}), ...(box ? { box } : {}) })
  }
  return out
}
