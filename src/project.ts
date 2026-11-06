// Projects: stamp from the template (mm new), load into the machine's process-compose as a namespace (mm up),
// namespace operations (down/restart), listing and inspection.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { boxApi } from './apistate'
import { getPath, held, loadConfig } from './config'
import { DIRS, engineDirs, HOME, run, servicePath, toolPath, which, within } from './env'
import { obsEndpoints } from './obs'
import { writeSecretPaths } from './inputs'
import { nameClash, publicKeyPem } from './auth'
import { type NamesMode, namesMode, routeName } from './names'
import { pcRunning, writeBase } from './pc'
import { rendered, renderTo, template, templateCommit } from './template'
import pkg from '../package.json'

export interface Answers { client: string; name: string; project: string; short: string; root: string; template_version: string; created: string; profile?: string; throwaway?: boolean; box?: boolean
  services_on?: string[] } // optional services this project runs (services.yaml optional: true), e.g. doop
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
/** The project-local tools (bd, dolt), checksums verified. Used by mm new and mm restore. The pins (URL and sha256)
 *  come from mm's own template, never from the project's tools.json: a box can write its project, so after a restore
 *  it would choose the binaries the host then runs as the owner (review sy-b15.17 6). */
export async function installTools(root: string): Promise<Step[]> {
  const steps: Step[] = []
  const pin = template().files.find((f) => f.p === 'tools.json')
  if (!pin) throw new Error("mm's template has no tools.json")
  const tools = JSON.parse(Buffer.from(pin.c, 'base64').toString('utf8'))
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
  const existed = existsSync(root)
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
  // its public hosts are free (sy-b15.3): else nothing of it stays (the folder was empty or not there)
  let clash: string | null = null
  try { clash = nameClash(root) } catch (e) { clash = (e as Error).message }
  if (clash) { rmSync(root, { recursive: true, force: true }); if (existed) mkdirSync(root); throw new Error(`refused: ${clash}`) }

  // 2. repos: config (the project root) and product (code/)
  const git = (args: string[], cwd = root) => run(['git', ...args], { cwd })
  must('config repo', git(['init', '-q', '-b', 'main']))
  git(['config', 'user.name', 'mm']); git(['config', 'user.email', `mm@${answers.project}.local`])
  // the pure render is main's first commit and the mm-template branch: the base for every later `mm update`
  const base = templateCommit(root, vars, `template ${t.version}`, undefined, t)
  must('template baseline', git(['reset', '-q', base])); git(['branch', 'mm-template', base])
  if (answers.box) recordTemplate(root, base) // the update's merge base, on the host (review sy-055t)
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
  // the run files first, and mm's list of the machine's secret paths: config-check renders the denies from them (sy-5ag); up() writes them again
  writeRunFiles(root, answers.box ? '/run/mm/sock/pc.sock' : DIRS.socket)
  must('governance check', run([join(root, 'bin', 'config-check'), '--render'], { cwd: root }))
  git(['add', '-A'])
  must('config commit', run(['git', 'commit', '-q', '-m', `mm new ${client}/${name}${product ? '' : ` (profile ${profile})`} (template ${answers.template_version})`], { cwd: root, env: { SETUP_HUMAN: '1' } }))
  git(['config', 'core.hooksPath', 'ops/githooks'])
  if (answers.box) sealEngine(root) // the engine as mm put it there: what the host may run of it later (review sy-b15.6)

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
  public?: { name: string; auth: string }; depends_on?: Record<string, string>; ready?: { http?: string; socket?: string; exec?: string }; restart?: string; optional?: boolean; outward?: boolean
  stop_seconds?: number } // how long the manager waits after TERM before it kills (process-compose's default: 10)

/** Does this board's server have the gateway-checked public side (BOARD_PUBLIC_PORT)? Older templates don't. */
function boardHasPublicSide(root: string) {
  try { return readFileSync(join(root, 'site', 'server.mjs'), 'utf8').includes('BOARD_PUBLIC_PORT') } catch { return false }
}
/** A project's services as mm runs them. `o.names`: the naming rule to use instead of the machine's (mm names shows
 *  both; nothing else passes it). */
export function resolve(root: string, o: { names?: NamesMode } = {}) {
  const a = readAnswers(root)
  const spec = Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { services: Record<string, Svc>; schedules?: Record<string, { every: string; command: string }> }
  // ports already given out stay put across reloads (the old process may still hold them while we decide)
  // for a box, from the host's copy (a box can write its .run/: review sy-b15.17 4); and only a port number is taken
  let prev: { services?: Record<string, { public_port?: number }>; dolt_port?: number } = {}
  try { prev = JSON.parse(readFileSync(prevPortsFile(root, a), 'utf8')) } catch {}
  const okPort = (p: unknown) => Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535 ? p as number : undefined
  const pp = portlessPort(), socket = join(root, '.dolt', 'mysql.sock'), dport = okPort(prev.dolt_port) ?? hashPort(`${a.project}/dolt`)
  const url = (s: string) => `http://${s}.${a.project}.localhost:${pp}`
  const fill = (v: string) => v.replaceAll('{root}', root).replaceAll('{home}', HOME).replaceAll('{project}', a.project)
    .replaceAll('{socket}', socket).replaceAll('{dolt_port}', String(dport)).replaceAll('{portless_port}', String(pp)).replace(/\{url:([\w-]+)\}/g, (_m, s) => url(s))
  const c = loadConfig(), access = String(getPath(c, 'access') ?? ''), domain = String(getPath(c, 'domain') ?? '')
  const bindHost = String(getPath(c, 'bind_host') ?? '127.0.0.1'), mode = o.names ?? namesMode(c)
  const services: Record<string, Svc & { url?: string; public_url?: string; public_port?: number; public_bind?: string }> = {}
  // a box with the project API on (src/api.ts): its app slot runs only the build the owner approved (release/<build>),
  // from the host's record of the grant, never from what the box put in release/ by itself; the same whoever writes
  // the box's file (boxApi: an mm without a test's API env still sees the store that governs the box, sy-jm5)
  const api = a.box ? boxApi(a.project) : null
  const boxRelease = api?.on ? api.granted.release : undefined
  for (const [n, s0] of Object.entries(spec.services)) {
    let s = s0
    if (n === 'app' && boxRelease !== undefined) { if (!boxRelease) continue; s = { ...s0, workdir: `{root}/release/${boxRelease.build}` } }
    else if (s.optional && n === 'app' && !existsSync(join(root, 'release'))) continue // app starts once something is deployed
    // any other optional service (e.g. doop) runs only when the project's answers turn it on: `mm doop on <project>`
    if (s.optional && n !== 'app' && !(a.services_on || []).includes(n)) continue
    const env = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, fill(String(v))]))
    // its public name: the machine's rule (src/names.ts), the one place a service's host is made
    const pname = s.public ? (access === 'domain' && domain ? routeName(a, n, fill(s.public.name), mode) : fill(s.public.name)) : ''
    // domain mode: a public service gets a stable port. The service itself stays on loopback (portless and the health
    // checks reach it there); the web proxy reaches it through mm's forwarder on bind_host (up(): <service>-public),
    // so nothing listens on every interface. bind_host on loopback (a proxy on the host itself): no forwarder needed.
    let pub: { public_url?: string; public_port?: number; public_bind?: string } = {}
    if (s.public && access === 'domain' && domain) {
      const port = okPort(prev.services?.[n]?.public_port) ?? hashPort(`${a.project}/${n}`)
      // a service behind the gateway (auth: required, the boards) gets its own public listener on that port, if its
      // server has one (a board still on an older template doesn't: it keeps serving the public port itself until
      // `mm update` brings the listener, so its route never goes dark); an open one (the app slot) serves it itself
      const gated = s.public.auth === 'required' && boardHasPublicSide(root)
      Object.assign(env, gated ? { BOARD_PUBLIC_PORT: String(port) } : { PORTLESS_APP_PORT: String(port) })
      pub = { public_url: `https://${pname}.${domain}`, public_port: port, public_bind: bindHost }
    }
    services[n] = { ...s, command: fill(s.command), workdir: s.workdir && fill(s.workdir), env, ...(s.ready?.exec ? { ready: { ...s.ready, exec: fill(s.ready.exec) } } : {}), ...(s.port === 'http' ? { url: url(n) } : {}), ...pub,
      ...(s.public ? { public: { ...s.public, name: pname } } : {}) }
  }
  const schedules = Object.fromEntries(Object.entries(spec.schedules || {}).map(([k, v]) => [k, { ...v, command: fill(v.command) }]))
  return { answers: a, services, schedules, socket, url, pp, dport }
}

type SvcResolved = ReturnType<typeof resolve>['services'][string]
/** How process-compose writes a project process's log file: each line at once, appended (rotation), so the shipper
 *  sees it (sy-7e99: without it, the file is buffered and truncated at each start). */
export const PROJECT_LOG_CONFIG = { add_timestamp: true, timestamp_format: '2006-01-02T15:04:05.000Z07:00', flush_each_line: true, rotation: { max_size_mb: 20, max_backups: 3 } }
/** One service as a process-compose process, on the host or in a project box. Host: secrets through `mm vault run`.
 *  Box (secretsDir): mm isn't in the box, so the service gets <NAME>_FILE paths in the read-only secrets mount. */
export function serviceProcess(root: string, project: string, n: string, s: SvcResolved, services: Record<string, SvcResolved>,
  o: { env: Record<string, string | undefined>; socket: string; pdeath: string; secretsDir?: string }): Record<string, unknown> {
  let cmd = s.command.replaceAll('$PORT', '$$$$PORT') // keep $PORT for the service's shell (process-compose would expand it)
  const files: Record<string, string> = {}
  // secrets the service declares: opened at every start (the runtime folder is memory-backed: gone after a reboot)
  if (s.secrets?.length && o.secretsDir) for (const x of s.secrets) files[`${x.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FILE`] = join(o.secretsDir, `${project}.${x.toLowerCase()}`)
  else if (s.secrets?.length) cmd = `${which('mm') || join(DIRS.bin, 'mm')} vault run ${project} ${s.secrets.join(',')} -- sh -c '${cmd.replaceAll("'", `'"'"'`)}'`
  // the service dies with its wrapper (portless): no orphan keeps the port after a crash or kill. --force: a restart
  // takes over its own name from the previous wrapper, which process-compose may still be stopping (sy-5ku 2); the
  // name is this project's service, so nothing else holds it
  if (s.port === 'http') cmd = `portless ${n}.${project} --force ${o.pdeath}sh -c '${cmd.replaceAll("'", `'"'"'`)}'`
  // ready.exec: a command that says the service answers (dolt: bin/dolt-ready runs a query, sy-5ku 1), not that its
  // socket file exists; a dependent with `ready` waits for it
  const probe = s.ready?.http ? { exec: { command: `curl -sf -o /dev/null --max-time 3 ${s.url}${s.ready.http}` } }
    : s.ready?.exec ? { exec: { command: s.ready.exec } }
    : s.ready?.socket ? { exec: { command: `test -S ${o.socket}` } } : undefined
  return {
    namespace: project, command: cmd, working_dir: s.workdir || root,
    environment: Object.entries({ ...o.env, MM_SERVICE: n, ...files, ...s.env }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
    log_location: join(root, '.run', 'logs', `${n}.log`),
    log_configuration: PROJECT_LOG_CONFIG,
    availability: { restart: s.restart === 'on_failure' ? 'on_failure' : 'always', backoff_seconds: 3 },
    ...(Number(s.stop_seconds) > 0 ? { shutdown: { timeout_seconds: Math.min(120, Math.round(Number(s.stop_seconds))) } } : {}),
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
export function writeInProject(root: string, rel: string, data: string | Uint8Array) {
  const dir = dirname(join(root, rel)), want = join(realpathSync(root), dirname(rel))
  mkdirSync(dir, { recursive: true })
  if (realpathSync(dir) !== want) throw new Error(`${dirname(rel)} in ${root} goes through a symlink: not writing ${rel}`)
  const tmp = join(want, `.${rel.split('/').pop()}.${randomBytes(6).toString('hex')}.tmp`)
  try { writeFileSync(tmp, data, { flag: 'wx' }); renameSync(tmp, join(want, rel.split('/').pop()!)) } catch (e) { rmSync(tmp, { force: true }); throw e }
}
/** Where resolve() finds the ports given out before: a box's .run/ is the box's to write, so its copy is on the host;
 *  a project that was a box once (mm box off) keeps using that copy, never what the box left in .run/. */
function prevPortsFile(root: string, a: Answers) {
  const copy = join(DIRS.mm, 'box', a.project, 'ports.json')
  return a.box || existsSync(copy) ? copy : join(root, '.run', 'services.json')
}
export function writeRunFiles(root: string, pcSocket: string) {
  const { answers: a, services, schedules, dport } = resolve(root)
  writeInProject(root, '.run/services.json', JSON.stringify({ project: a.project, dolt_port: dport, services, schedules }, null, 2))
  const f = prevPortsFile(root, a)
  if (f !== join(root, '.run', 'services.json')) { // the host's copy of the ports (review sy-b15.17 4), in a folder the box never sees
    mkdirSync(dirname(f), { recursive: true, mode: 0o755 })
    writeFileSync(f, JSON.stringify({ dolt_port: dport, services: Object.fromEntries(Object.entries(services).flatMap(([n, s]) => s.public_port ? [[n, { public_port: s.public_port }]] : [])) }, null, 2))
  }
  const owner = String(getPath(loadConfig(), 'owner_name') ?? '').trim()
  const ep = { manager: 'process-compose (mm)', self_healing: true, restart: `process-compose -U -u ${pcSocket} process restart ${a.project}.{service}`,
    logs: `tail -n {lines} ${join(root, '.run', 'logs')}/{service}.log`, observability: obsEndpoints(), dirs: engineDirs(),
    ...(publicKeyPem() ? { auth: { public_key: publicKeyPem() } } : {}), // the gateway's key: boards verify its assertions
    // the owner's name (mm's config owner_name; absent when unset): with the bridge, the only actor whose `approved`
    // counts (bin/supervisor, bin/flow), and a name the guard keeps agents from writing as (sy-h2yt)
    ...(owner ? { owner_name: owner } : {}),
    // how this machine runs a container, and the pinned images of optional services (bin/doop-run; plans/doop.md): Doop's
    // by digest only (bin/doop-run refuses a tag: sy-7452)
    containers: { docker: String(process.env.MM_DOCKER || getPath(loadConfig(), 'box.docker') || 'docker'),
      doop_image: String(process.env.MM_DOOP_IMAGE || getPath(loadConfig(), 'doop.image') || 'mm-doop:0.12.0') },
    services: Object.fromEntries(Object.entries(services).map(([n, s]) => [n, { ...(s.url ? { url: s.url } : {}), ...(s.public_url ? { public: s.public_url } : {}) }])) }
  writeInProject(root, '.run/endpoints.json', JSON.stringify(ep, null, 2))
  // where the machine's secrets are (paths only), for config-check to deny to every role (sy-5ag): in mm's folder, never
  // in the project's run files, which the project (a box too) can write (review sy-v92 2)
  writeSecretPaths()
}

/**
 * Host git on a project a box can write (review sy-b15.6 2): what the box wrote never steers what the host's git sees
 * or runs. Replace objects off for every project (a replace ref can also sit in packed-refs, and a project that was a
 * box keeps what the box wrote; review sy-b15.6 follow-up 1). For a box project also: no system or global config, no
 * hooks, and safe.directory exactly this repo (the box owns its files). A host project keeps its own hooks (e.g. the
 * config repo's pre-commit).
 */
export function hostGitEnv(root: string): Record<string, string> {
  let box = false; try { box = !!readAnswers(root).box } catch {}
  if (!box) return { GIT_NO_REPLACE_OBJECTS: '1' }
  return { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: root,
    GIT_CONFIG_KEY_2: 'safe.directory', GIT_CONFIG_VALUE_2: join(root, 'code') }
}
/** Why mm won't run git on this project, or null: a box-planted way to change what git sees (review sy-b15.6 2c). */
export function gitRefusal(root: string): string | null {
  for (const g of [join(root, '.git'), join(root, 'code', '.git')]) {
    if (!existsSync(g)) continue
    const rep = join(g, 'refs', 'replace')
    if (existsSync(rep) && readdirSync(rep).length) return `${g}/refs/replace/ has entries (replace objects)`
    // ...or packed (review sy-b15.6 follow-up 1): a line "<sha> refs/replace/<sha>" in packed-refs
    try { if (/^[0-9a-f]+ refs\/replace\//m.test(readFileSync(join(g, 'packed-refs'), 'utf8'))) return `${g}/packed-refs has refs/replace/ (replace objects)` } catch {}
    if (existsSync(join(g, 'info', 'grafts'))) return `${g}/info/grafts exists`
    for (const f of ['alternates', 'http-alternates']) {
      const p = join(g, 'objects', 'info', f)
      if (existsSync(p) && readFileSync(p, 'utf8').trim()) return `${g}/objects/info/${f} names another object store`
    }
  }
  return null
}

// ---------- what a box can't make the host run (review sy-b15.6, follow-up 2) ----------
/** Read-only in a box (src/box.ts mounts each over the project): the kernel, the engine the host runs (bin/, site/),
 *  and every file that decides what the box may do. They change only through mm on the host. */
export const BOX_READONLY = ['bin', 'site', 'ops', 'setup', 'tools', '.git/hooks', '.git/config', '.git/info', '.git/objects/info',
  'code/.git/hooks', 'code/.git/config', 'code/.git/info', 'code/.git/objects/info', 'services.yaml', '.mm-answers.yaml', 'secrets.json', 'governance.json',
  'tools.json'] // the tools' pins: mm takes its own (installTools), and the box can't change this copy either (review sy-b15.17 6)
/** The variables the template is rendered with for this project (mm new, mm update). */
export function templateVars(root: string): Record<string, string> {
  const a = readAnswers(root)
  return { client: a.client, name: a.name, project: a.project, short: a.short, root, home: HOME, brain: DIRS.brain, projects: DIRS.projects, mm: DIRS.mm, claude_dir: join(DIRS.mm, 'claude', a.project), profile: a.profile || 'project' }
}
// the engine: what the host runs from a project (bin/: config-check, bd-quiet, init, wt, backup, bd; site/: npm ci and
// the board's build), without the build's output; and the kernel the host may run (ops/: the git hooks; setup/: the
// setup agent's brief and settings, which runs on the host until it runs in the box; review sy-atqr)
const ENGINE_DIRS = ['bin', 'site', 'ops', 'setup']
/** What mm itself writes there: the build's output, and settings config-check renders from the checked templates. */
const ENGINE_SKIP = ['site/node_modules', 'site/dist']
export const ENGINE_GENERATED = ['setup/.claude/settings.json']
const skipped = (p: string) => [...ENGINE_SKIP, ...ENGINE_GENERATED].some((s) => p === s || p.startsWith(`${s}/`))
const isEngine = (p: string) => /^(bin|site|ops|setup)\//.test(p) && !skipped(p)
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
export const sealFile = (project: string) => join(DIRS.mm, 'box', project, 'engine.json')
/** The engine's files on disk and their sha256. A link or any other odd file is named so, never followed or read. */
function engineOnDisk(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    if (skipped(rel)) return
    let st; try { st = lstatSync(join(root, rel)) } catch { return }
    if (st.isDirectory()) { for (const n of readdirSync(join(root, rel)).sort()) walk(`${rel}/${n}`); return }
    out[rel] = st.isFile() ? sha256(readFileSync(join(root, rel))) : 'not a plain file'
  }
  for (const d of ENGINE_DIRS) walk(d)
  return out
}
/** A box project now, or one that was (mm keeps its seal after mm box off: the history it wrote stays). */
export function boxish(root: string): boolean {
  try { const a = readAnswers(root); return !!a.box || existsSync(sealFile(a.project)) } catch { return false }
}
/**
 * Why the host must not run a box project's bin/ or site/, or null. A box can write its config repo's history (objects,
 * refs, the index), so a host git step that writes the working tree (a merge, an abort, a restore from its bundle) could
 * bring files the box chose into bin/ or site/, and the host then runs them as the owner. So before mm runs anything
 * there, each file must be as mm's template renders it for this project, or as mm sealed it on the host the last time
 * it put them there (mm new, mm box on, a checked mm update). Nothing else, and no extra file. A host project: null.
 */
export function engineRefusal(root: string): string | null {
  if (!boxish(root)) return null
  const disk = engineOnDisk(root), want: Record<string, string> = {}
  for (const f of rendered(templateVars(root))) if (isEngine(f.p)) want[f.p] = sha256(f.data)
  let seal: Record<string, string> = {}
  try { seal = JSON.parse(readFileSync(sealFile(readAnswers(root).project), 'utf8')).files || {} } catch {}
  const off = Object.keys(disk).filter((p) => disk[p] !== want[p] && disk[p] !== seal[p]).sort()
  if (!off.length) return null
  return `${off.slice(0, 3).join(', ')}${off.length > 3 ? ` and ${off.length - 3} more` : ''}: not as mm's template (${template().version}) or its seal (${sealFile(readAnswers(root).project).replace(HOME, '~')}) has ${off.length === 1 ? 'it' : 'them'}, and mm won't run a box project's bin/, site/, ops/ or setup/ on the host (review sy-b15.6, sy-atqr)`
}
/**
 * A box project's kernel (ops/, setup/) back as mm has it (whole-machine restore; review sy-atqr). The box can't write
 * these, but it can commit other content for them, and a restore checks its history out. Each file must be as mm's
 * template renders it, or as the seal (from the host's record) has it: any other file is written over with mm's render,
 * or removed if mm has none; a file the seal names (or the render, with no seal) that is missing is written. A link is
 * removed, never followed. What config-check renders (ENGINE_GENERATED) is removed: config-check writes it again.
 * Returns what changed ("path: what"), for the restore's report.
 */
export function repairKernel(root: string, seal: Record<string, string> | null): string[] {
  const want = new Map(rendered(templateVars(root)).filter((f) => /^(ops|setup)\//.test(f.p) && !skipped(f.p)).map((f) => [f.p, f]))
  const changed: string[] = [], gone = (p: string) => { rmSync(join(root, p), { recursive: true, force: true }) }
  for (const d of ['ops', 'setup']) { // the folder itself a link or a file: removed (writeInProject refuses to write through it)
    let st; try { st = lstatSync(join(root, d)) } catch { continue }
    if (!st.isDirectory()) { gone(d); changed.push(`${d}: not a folder, removed`) }
  }
  for (const p of ENGINE_GENERATED) { try { lstatSync(join(root, p)); gone(p); changed.push(`${p}: removed (config-check renders it)`) } catch {} }
  const disk = Object.fromEntries(Object.entries(engineOnDisk(root)).filter(([p]) => /^(ops|setup)\//.test(p)))
  const write = (p: string, why: string) => { const f = want.get(p)!; try { if (lstatSync(join(root, p)).isDirectory()) gone(p) } catch {}; writeInProject(root, p, f.data); chmodSync(join(root, p), f.m); changed.push(`${p}: ${why}`) }
  const odd = Object.keys(disk).filter((p) => { const h = disk[p], w = want.get(p); return h === 'not a plain file' || (h !== (w && sha256(w.data)) && h !== seal?.[p]) }).sort()
  for (const p of odd) if (!want.has(p)) { gone(p); changed.push(`${p}: removed (not mm's)`) } // removals first: a link may sit where a file goes
  for (const p of odd) if (want.has(p)) write(p, "mm's render")
  for (const p of [...want.keys()].sort()) if (!(p in disk) && (!seal || p in seal)) write(p, "mm's render (it was missing)")
  return changed
}
/** After mm itself put the engine there (mm new --box, mm box on, a checked mm update): its files, sealed on the host
 *  (a folder the box never sees). */
export function sealEngine(root: string) {
  const a = readAnswers(root), f = sealFile(a.project)
  mkdirSync(dirname(f), { recursive: true, mode: 0o755 })
  writeFileSync(f, JSON.stringify({ sealed: new Date().toISOString(), template: a.template_version, files: engineOnDisk(root) }, null, 2))
}
/** Where mm keeps the mm-template commit it last put in a box project's config repo (review sy-055t): next to the
 *  engine's seal, in a folder the box never sees. The box can write the branch; mm update merges from this commit. */
export const templateRecFile = (project: string) => join(DIRS.mm, 'box', project, 'template.json')
export function recordedTemplate(project: string): string {
  try { const c = String(JSON.parse(readFileSync(templateRecFile(project), 'utf8')).commit || ''); return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c) ? c : '' } catch { return '' }
}
/** Each time mm itself moves mm-template on a box project (mm new --box, mm box on, a checked update): that commit, on
 *  the host. With no commit given, the branch as it is now (mm box on: the host's own repo until then). */
export function recordTemplate(root: string, commit?: string) {
  const a = readAnswers(root)
  const c = commit ?? run(['git', '-C', root, 'rev-parse', '-q', '--verify', 'refs/heads/mm-template^{commit}'], { env: hostGitEnv(root) }).out.trim()
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c)) return
  const f = templateRecFile(a.project)
  mkdirSync(dirname(f), { recursive: true, mode: 0o755 })
  writeFileSync(f, JSON.stringify({ commit: c, recorded: new Date().toISOString() }, null, 2))
}
/** The privilege files a box project's host record carries (sy-b15.19): read-only in the box, so the host's copies. */
export const BOX_RECORD_FILES = ['.mm-answers.yaml', 'services.yaml', 'secrets.json', 'governance.json', 'tools.json']
export type BoxRecord = { box: boolean; project: string; files: Record<string, string>; engine: unknown; template: { commit?: string } | null }
/**
 * A box project's record for mastermind (mm sync; sy-b15.19), made by the host from the host's disk, never from the
 * box's backup: whether it is a box, the host's copies of its privilege files (base64), the engine's seal and the
 * mm-template record. A file that is not a plain file is not followed: the record is refused.
 */
export function boxRecord(root: string): BoxRecord {
  const a = readAnswers(root), files: Record<string, string> = {}
  for (const f of BOX_RECORD_FILES) {
    let st; try { st = lstatSync(join(root, f)) } catch { continue }
    if (!st.isFile()) throw new Error(`${a.project}: ${f} is not a plain file; not following it into the box's record`)
    files[f] = readFileSync(join(root, f)).toString('base64')
  }
  const host = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
  return { box: !!a.box, project: a.project, files, engine: host(sealFile(a.project)), template: host(templateRecFile(a.project)) }
}
/**
 * A box project's history against its read-only files: HEAD must hold exactly what is on disk there. The box can't
 * change those files, but it can commit other content for them (and an index that hides it from `git status`); a host
 * step that then resets toward HEAD would bring that content in. Compared by mm itself (blob ids of the files on disk
 * against HEAD's tree), never through the box-writable index. A host project: null.
 */
export function headDrift(root: string): string | null {
  if (!boxish(root)) return null
  const paths = BOX_READONLY.filter((p) => !p.includes('.git') && p !== 'tools')
  const r = run(['git', '-C', root, 'ls-tree', '-r', '-z', 'HEAD', '--', ...paths], { env: hostGitEnv(root) })
  if (!r.ok) return `git ls-tree HEAD: ${(r.err || r.out).trim().slice(0, 120)}`
  for (const e of r.out.split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(e); if (!m) return `odd ls-tree line: ${e.slice(0, 80)}`
    const [, mode, type, id, p] = m
    if (type !== 'blob') return `${p} in HEAD is a ${type}, not a file`
    let data: Buffer
    try { const st = lstatSync(join(root, p)); data = mode === '120000' ? (st.isSymbolicLink() ? Buffer.from(readlinkSync(join(root, p))) : Buffer.from([0])) : st.isFile() ? readFileSync(join(root, p)) : Buffer.from([0]) }
    catch { return `${p} is in HEAD but not on disk` }
    const blob = new Bun.CryptoHasher(id.length === 64 ? 'sha256' : 'sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
    if (blob !== id) return `${p} in HEAD is not what is on disk (the box can commit to this repo, not change the file)`
  }
  return null
}

/**
 * Turn an optional service (services.yaml `optional: true`, e.g. doop) on or off for a project: the answers record it
 * (committed), mm up starts or drops it, and config-check renders again (a role's MCP that needs the service, e.g. the
 * design lead's Doop, appears or goes with it).
 */
export function setOptional(root: string, service: string, on: boolean): Step[] {
  const spec = Bun.YAML.parse(readFileSync(join(root, 'services.yaml'), 'utf8')) as { services: Record<string, Svc> }
  const s = spec.services?.[service]
  if (!s || !s.optional || service === 'app') return [{ step: service, status: 'fail', detail: `${service} is not an optional service of this project's template (mm update first?)` }]
  const f = join(root, '.mm-answers.yaml'), text = readFileSync(f, 'utf8'), a = readAnswers(root)
  const list = new Set(a.services_on || []); if (on) list.add(service); else list.delete(service)
  const body = text.replace(/^services_on:.*\n?/m, '').trimEnd() + (list.size ? `\nservices_on: [${[...list].sort().join(', ')}]\n` : '\n')
  const steps: Step[] = []
  if (body !== text) {
    writeFileSync(f, body)
    const why = gitRefusal(root); if (why) return [{ step: 'git', status: 'fail', detail: `refused: ${why}` }]
    const c = run(['git', '-C', root, 'commit', '-q', '-m', `mm ${service} ${on ? 'on' : 'off'}`, '.mm-answers.yaml'], { env: { SETUP_HUMAN: '1', ...hostGitEnv(root) } })
    steps.push({ step: 'answers', status: c.ok ? 'ok' : 'fail', detail: c.ok ? `services_on: [${[...list].join(', ')}]` : (c.err || c.out).trim().slice(0, 160) })
  } else steps.push({ step: 'answers', status: 'skip', detail: `${service} already ${on ? 'on' : 'off'}` })
  steps.push(...up(root))
  const no = engineRefusal(root); if (no) return [...steps, { step: 'governance check', status: 'fail', detail: `refused: ${no}` }]
  const cc = run([join(root, 'bin', 'config-check'), '--render'], { cwd: root })
  steps.push({ step: 'governance check', status: cc.ok ? 'ok' : 'fail', detail: (cc.out || cc.err).trim().split('\n').pop() || '' })
  return steps
}

export function up(root: string): Step[] {
  if (boxHook.up && readAnswers(root).box) return boxHook.up(root)
  const { answers: a, services, schedules, socket, pp, dport } = resolve(root)
  // its public hosts are its own, before it is registered (sy-b15.3: two projects never get one host)
  const clash = nameClash(root); if (clash) return [{ step: 'public names', status: 'fail', detail: `refused: ${clash}` }]
  const steps: Step[] = []
  mkdirSync(join(root, '.run', 'logs'), { recursive: true }); mkdirSync(join(root, '.dolt'), { recursive: true }); mkdirSync(PROJECTS_PC, { recursive: true })
  const obs = obsEndpoints() as { traces?: string; metrics?: string }
  const env = { PATH: servicePath(), MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0',
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
      log_location: join(root, '.run', 'logs', `${n}-public.log`), log_configuration: PROJECT_LOG_CONFIG,
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
  steps.push({ step: 'process manager', status: r.ok ? 'ok' : 'fail', detail: r.ok ? `loaded (project update)${r.started.length ? `; started again what process-compose had skipped: ${r.started.join(', ')}` : ''}` : r.err.trim().slice(0, 200) })
  run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'start', a.project])
  // public routes (domain mode): the machine's `expose` tool writes the router entry
  if (!hold) steps.push(...serviceRoutes(a, services))
  return steps
}
/** The routes of a project's public services, by the names resolve() gave them (src/names.ts): mm up writes them,
 *  for the host's projects and a box's (src/box.ts). */
export function serviceRoutes(a: Answers, services: Record<string, SvcResolved>): Step[] {
  return Object.values(services).filter((s) => s.public_port && s.public).map((s) => routeUp(a, s.public!.name, s.public_port!, s.public!.auth === 'required', `${s.public_url}`))
}

// ---------- public routes (review sy-uzh) ----------
/** The tool that writes the web proxy's routes: the machine's `expose`, or MM_EXPOSE (a test's own, which keeps its
 *  routes in a folder of the test's). A throwaway project (what tests make) never gets a live route: with no MM_EXPOSE,
 *  its routes are skipped. */
export function routeTool(a: Answers): string | null {
  if (process.env.MM_EXPOSE) return process.env.MM_EXPOSE
  return a.throwaway ? null : 'expose'
}
/** One public route, written only when it is missing or differs from what the tool lists (same port, same login):
 *  `mm up` and `mm update` re-write nothing that is right already. */
/** How a route with `public.auth: required` is gated (sy-lyeo): through the sign-in gateway (`expose --sso`) once the
 *  machine has turned it on (`auth.enabled`), else the shared password (`--auth`). Turning the gateway off writes the
 *  password back at the next `mm up` (the rollback). */
export function routeGate(): { flag: '--sso' | '--auth'; mark: '[sso]' | '[auth]'; note: string } {
  const on = getPath(loadConfig(), 'auth.enabled')
  return on === true || on === 'true' ? { flag: '--sso', mark: '[sso]', note: ' (sign-in)' } : { flag: '--auth', mark: '[auth]', note: ' (password)' }
}
export function routeUp(a: Answers, name: string, port: number, auth: boolean, url: string): Step {
  const step = `public ${name}`, tool = routeTool(a), gate = auth ? routeGate() : null
  if (!tool) return { step, status: 'skip', detail: 'a throwaway project gets no live route (a test sets MM_EXPOSE)' }
  if (!run(['sh', '-c', 'command -v "$1"', 'sh', tool]).ok) return { step, status: 'fail', detail: `no \`${tool}\` tool on this machine` }
  const ls = run([tool, 'ls'], { timeoutMs: 30_000 })
  const line = ls.ok ? ls.out.split('\n').find((l) => l.startsWith(`https://${name}.`)) : undefined
  // right already: the same port, and exactly this gate (an [auth] route is rewritten to [sso] once the gateway is on)
  const marks = line ? (['[auth]', '[sso]'] as const).filter((m) => line.includes(m)) : []
  const same = gate ? marks.length === 1 && marks[0] === gate.mark : marks.length === 0
  if (line && new RegExp(`:${port}(\\s|$)`).test(line) && same) return { step, status: 'ok', detail: `${url}${gate?.note ?? ''} (already there)` }
  const r = run([tool, name, String(port), ...(gate ? [gate.flag] : [])], { timeoutMs: 30_000 })
  return { step, status: r.ok ? 'ok' : 'fail', detail: r.ok ? `${url}${gate?.note ?? ''}` : (r.err || r.out).trim().slice(0, 160) }
}
/** Remove one public route (mm archive); a throwaway project's are only the test tool's. */
export function routeRm(a: Answers, name: string): Step {
  const step = `unexpose ${name}`, tool = routeTool(a)
  if (!tool) return { step, status: 'skip', detail: 'a throwaway project has no live route' }
  const r = run([tool, 'rm', name], { timeoutMs: 30_000 })
  return { step, status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'route removed' : (r.err || r.out).trim().slice(0, 160) }
}

/** Load the base file plus every project file into the running process-compose. */
export function loadAll() {
  writeBase()
  // the projects, and the host's side of the boxes' public services (pc/box-public: kept apart, so nothing takes them
  // for projects)
  const dirFiles = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(d, f)) : [])
  const files = [join(DIRS.pc, 'base.yaml'), ...dirFiles(PROJECTS_PC), ...dirFiles(join(DIRS.pc, 'box-public'))]
  const ms = Number(process.env.MM_PC_UPDATE_MS || 60_000), t0 = Date.now()
  const r = run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'update', ...files.flatMap((f) => ['-f', f])], { timeoutMs: ms })
  // nothing to change (e.g. the last project was just removed) is not a failure
  if (/No processes were updated/i.test(r.out + r.err)) return { ...r, ok: true, started: [] as string[], hung: false }
  // no answer in time (the update waits for processes that don't stop): say so, never an empty failure (sy-pfbr 2)
  const hung = !r.ok && Date.now() - t0 >= ms - 250
  if (hung) return { ...r, err: `process-compose's project update gave no answer in ${Math.round(ms / 1000)} s`, hung, started: [] as string[] }
  return { ...r, hung, started: startSkipped(dependsOn(files)) }
}

/** Each process in these process files, with its dependencies: name -> dependency -> condition ({} for none). */
export function dependsOn(files: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const f of files) {
    let y: { processes?: Record<string, { depends_on?: Record<string, { condition?: string }> }> } = {}
    try { y = Bun.YAML.parse(readFileSync(f, 'utf8')) as typeof y } catch { continue }
    for (const [n, p] of Object.entries(y?.processes || {})) out[n] = Object.fromEntries(Object.entries(p?.depends_on || {}).map(([d, c]) => [d, c?.condition || 'process_started']))
  }
  return out
}

const COMING = ['Running', 'Pending', 'Restarting', 'Launching', 'Launched']
const DEAD_GRACE_MS = 5000 // a restart shows its process as stopped for its backoff: down for good only after this
/**
 * After a load: start what process-compose left Skipped, once its dependencies are up (sy-5ku 3, sy-heeh). A process
 * that waits for a dependency holds that dependency's instance; when the instance goes away before it is ready (a
 * restart or an update of the dependency, or the instance left over from the same project loaded before), the waiter
 * is Skipped for good and never retried. So: poll until nothing is Skipped or Pending that can still come up (its
 * dependencies are running, on their way, or Skipped themselves with dependencies that can), at most `ms`. Returns
 * what it started. `socket`: the host's process manager, or a box's own (sy-5pvp, src/box.ts).
 */
export function startSkipped(deps: Record<string, Record<string, string>>, ms = Number(process.env.MM_START_SKIPPED_MS || 90_000), socket = DIRS.socket): string[] {
  const end = Date.now() + ms, started: string[] = [], downSince = new Map<string, number>()
  for (;;) {
    const ps = processes(undefined, socket), by = new Map(ps.map((p) => [p.name, p])), now = Date.now()
    for (const p of ps) if (COMING.includes(p.status)) downSince.delete(p.name); else if (!downSince.has(p.name)) downSince.set(p.name, now)
    const met = (d: string, cond: string) => {
      const x = by.get(d)
      if (!x) return false
      if (cond === 'process_started') return x.status === 'Running'
      if (cond.startsWith('process_completed')) return x.status === 'Completed'
      return x.is_ready === 'Ready' // process_healthy, process_log_ready
    }
    const canCome = (n: string, seen: Set<string> = new Set()): boolean => {
      const x = by.get(n)
      if (!x || seen.has(n)) return false
      if (COMING.includes(x.status) || now - (downSince.get(n) ?? now) < DEAD_GRACE_MS) return true
      seen.add(n)
      return x.status === 'Skipped' && Object.keys(deps[n] || {}).every((d) => canCome(d, seen))
    }
    let waiting = false
    for (const p of ps) {
      // only what these files define (a box's process manager may list anything: it starts only mm's own names)
      if ((p.status !== 'Skipped' && p.status !== 'Pending') || !Object.hasOwn(deps, p.name)) continue
      const d = deps[p.name]
      if (!Object.keys(d).every((x) => canCome(x))) continue // a dependency that is down for good: nothing to wait for
      waiting = true
      if (p.status === 'Skipped' && Object.entries(d).every(([x, c]) => met(x, c))) {
        if (run(['process-compose', '-U', '-u', socket, 'process', 'start', p.name], { timeoutMs: 15_000 }).ok) started.push(p.name)
      }
    }
    if (!waiting || Date.now() >= end) return started
    Bun.sleepSync(1000)
  }
}

export function namespaceOp(ref: string, op: 'start' | 'stop' | 'restart') {
  return run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', op, readAnswers(findRoot(ref)).project], { timeoutMs: 120_000 })
}

export function processes(project?: string, socket = DIRS.socket) {
  const r = run(['process-compose', '-U', '-u', socket, 'process', 'list', '-o', 'json'], { timeoutMs: 15_000 })
  if (!r.ok) return []
  type P = { name: string; namespace: string | string[]; status: string; is_ready: string; restarts: number; pid?: number }
  let all: P[] = []
  try { const j = JSON.parse(r.out); all = Array.isArray(j) ? (j as P[]).filter((p) => p && typeof p.name === 'string') : [] } catch { return [] }
  const ns = (p: { namespace: string | string[] }) => (Array.isArray(p.namespace) ? p.namespace : [p.namespace])
  return project ? all.filter((p) => ns(p as never).includes(project)) : all
}

// ---------- leaving the host's process manager (mm box on; sy-pfbr) ----------
/**
 * The words a command becomes when process-compose's shell (`bash -c`) runs it as one simple command (bash then execs
 * it: they are the process's argv). `$$` is process-compose's own `$`; leading NAME=value words and `exec` go. null
 * when the shell would do more (operators, expansions, globs) or process-compose fills a $VAR: then only the shell
 * itself, `bash -c <command>`, is that process.
 */
export function commandWords(cmd: string): string[] | null {
  const raw = cmd.replaceAll('$$', '\0'); if (raw.includes('$')) return null
  const s = raw.replaceAll('\0', '$'), words: { t: string; x: boolean; set: boolean; q: boolean }[] = []
  let w: (typeof words)[number] | null = null
  for (let i = 0; i < s.length;) {
    const c = s[i]
    if (c === ' ' || c === '\t') { if (w) words.push(w); w = null; i++; continue }
    if ('\n;&|<>()`'.includes(c) || (c === '#' && !w)) return null
    w ??= { t: '', x: false, set: false, q: false }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return null; w.t += s.slice(i + 1, j); w.q = true; i = j + 1; continue }
    if (c === '"') {
      w.q = true
      for (i++; ; i++) {
        if (i >= s.length) return null
        const d = s[i]
        if (d === '"') { i++; break }
        if (d === '\\' && '$`"\\'.includes(s[i + 1] ?? '\0')) { w.t += s[++i]; continue }
        if (d === '$' || d === '`') w.x = true
        w.t += d
      }
      continue
    }
    if (c === '\\') { if (i + 1 >= s.length) return null; w.t += s[i + 1]; w.q = true; i += 2; continue }
    if (c === '$' || '*?[{'.includes(c) || (c === '~' && !w.t)) w.x = true
    if (c === '=' && !w.q && !w.set && /^[A-Za-z_]\w*$/.test(w.t)) w.set = true
    w.t += c; i++
  }
  if (w) words.push(w)
  while (words.length && words[0].set) words.shift()
  if (words[0] && !words[0].q && words[0].t === 'exec') words.shift()
  if (!words.length || words.some((x) => x.x) || words[0].t.startsWith('-')) return null
  return words.map((x) => x.t)
}
/** Is this argv (from /proc) the process process-compose started for `cmd`, exactly? Its shell running the command,
 *  or the command's own words: the program as typed, or a script (found on PATH) run by its #! interpreter. */
export function sameCommand(argv: string[], cmd: string): boolean {
  if (argv.length === 3 && /^(\/.*\/)?(ba)?sh$/.test(argv[0]) && argv[1] === '-c' && argv[2] === cmd.replaceAll('$$', '$')) return true
  const w = commandWords(cmd); if (!w) return false
  const i = argv.length - w.length // the program's place: after at most an interpreter and its one argument
  if (i < 0 || i > 2 || w.slice(1).some((x, k) => argv[i + 1 + k] !== x)) return false
  const prog = argv[i]
  return i === 0 ? prog === w[0] : prog.includes('/') && (w[0].includes('/') ? prog === w[0] : basename(prog) === w[0])
}
const procArgv = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch { return [] } }
const procCwd = (pid: number) => { try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return '' } }
/** Running (a zombie has ended: its parent just hasn't reaped it yet). */
const procAlive = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) !== 'Z' } catch { return false } }
/**
 * `mm box on` (sy-pfbr): the project's processes stop and leave the host's process manager. A process that ignores
 * TERM (a portless wrapper in a container) stays Terminating, and process-compose's next project update waits for it
 * past its timeout. So, after the stop, a wrapper that still runs is stopped by mm: TERM, then KILL (its service gets
 * TERM through its pdeathsig). Only process-compose's own pid for it, and only when that pid's command line is exactly
 * the one mm gave it and it runs in the project's root: never a loose match (a person's shell, an agent working there).
 * Then the reload, tried again as mm archive does. The detail says what mm stopped, or what still hangs.
 */
export function leaveHost(root: string, project: string, waitMs = 10_000): { ok: boolean; detail: string } {
  const pf = join(PROJECTS_PC, `${project}.yaml`)
  let defs: Record<string, { command?: unknown }> = {}
  try { defs = (Bun.YAML.parse(readFileSync(pf, 'utf8')) as { processes?: typeof defs })?.processes || {} } catch {}
  const was = processes(project).filter((p) => Object.hasOwn(defs, p.name) && Number(p.pid) > 0).map((p) => ({ name: p.name, pid: Number(p.pid) }))
  run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'stop', project], { timeoutMs: 120_000 })
  rmSync(pf, { force: true })
  const left = () => was.filter((p) => procAlive(p.pid)), stopped: string[] = []
  const wrapper = (p: { name: string; pid: number }) => {
    const cmd = String(defs[p.name]?.command ?? '')
    return cmd.startsWith('portless ') && sameCommand(procArgv(p.pid), cmd) && within(procCwd(p.pid), root)
  }
  const stopWrappers = (ms: number) => {
    for (const end = Date.now() + ms; left().length && Date.now() < end;) Bun.sleepSync(250)
    const hit = left().filter(wrapper)
    for (const p of hit) try { process.kill(p.pid, 'SIGTERM') } catch {}
    for (let i = 0; i < 30 && hit.some((p) => procAlive(p.pid)); i++) Bun.sleepSync(100)
    for (const p of hit) {
      const kill = procAlive(p.pid); if (kill) try { process.kill(p.pid, 'SIGKILL') } catch {}
      stopped.push(`${p.name} (pid ${p.pid}${kill ? ', KILL' : ''})`)
    }
    return hit.length
  }
  stopWrappers(waitMs)
  let l = loadAll(), n = left().length
  for (let i = 0; i < 5 && !l.ok; i++) {
    // a reload that got no answer waits on a process: again only once something has stopped since
    const more = stopWrappers(2000), now = left().length
    if (l.hung && !more && now >= n) break
    if (!now) Bun.sleepSync(2000) // ...else it races processes still stopping
    n = now; l = loadAll()
  }
  const killed = stopped.length ? `; stopped ${stopped.length} wrapper(s) left running after the stop: ${stopped.join(', ').slice(0, 200)}` : ''
  const still = left().map((p) => `${p.name} (pid ${p.pid}${wrapper(p) ? '' : ', not a wrapper with mm\'s exact command line: left alone'})`)
  if (l.ok && !still.length) return { ok: true, detail: `${project} unloaded from the host's process manager${killed}` }
  // (after an update that got no answer, process-compose lets go of what it waited for: the next one is "ok", and the
  // process runs on outside it; so a process of the project that still runs is a failure too)
  const why = l.ok ? `${project} unloaded, but not all of it stopped` : (l.err || l.out).trim().split('\n').slice(-3).join(' ').slice(0, 200) || `process-compose exit ${l.code}`
  return { ok: false, detail: `${why}${still.length ? `; still running: ${still.join(', ').slice(0, 300)}: stop it, then mm box on again` : ''}${killed}` }
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
