// Projects: stamp from the template (mm new), load into the machine's process-compose as a namespace (mm up),
// namespace operations (down/restart), listing and inspection.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS, engineDirs, HOME, run, toolPath } from './env'
import { obsEndpoints } from './obs'
import { publicKeyPem } from './auth'
import { pcRunning, writeBase } from './pc'
import { renderTo, template, templateCommit } from './template'
import pkg from '../package.json'

export interface Answers { client: string; name: string; project: string; short: string; root: string; template_version: string; created: string; profile?: string; throwaway?: boolean }
const ID = /^[a-z][a-z0-9-]{0,30}$/
export const PROJECTS_PC = join(DIRS.pc, 'projects')

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
type Step = { step: string; status: 'ok' | 'fail'; detail: string }
export type NewOpts = { short?: string; profile?: string; root?: string; project?: string; throwaway?: boolean }
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
    root, template_version: pkg.version, created: new Date().toISOString(), ...(product ? {} : { profile }), ...(o.throwaway ? { throwaway: true } : {}),
  }
  if (!/^[a-z]{1,8}$/.test(answers.short)) throw new Error('short (item id prefix) must be 1-8 letters')

  // 1. render the template
  const t = template()
  answers.template_version = t.version
  const vars: Record<string, string> = { client, name, project: answers.project, short: answers.short, root, home: HOME, brain: DIRS.brain, projects: DIRS.projects, mm: DIRS.mm, profile }
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
  const tools = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'))
  mkdirSync(join(root, 'tools'), { recursive: true })
  for (const t of ['bd', 'dolt']) {
    const spec = tools[t]['linux-x64']
    const buf = new Uint8Array(await (await fetch(spec.url, { redirect: 'follow' })).arrayBuffer())
    const got = new Bun.CryptoHasher('sha256').update(buf).digest('hex')
    if (got !== spec.sha256) throw new Error(`${t}: checksum mismatch (${got})`)
    const tmp = join(root, `.tools-${t}.tar.gz`)
    writeFileSync(tmp, buf)
    const x = run(['tar', '-xzf', tmp, '-C', join(root, 'tools'), spec.extract])
    run(['rm', '-f', tmp])
    if (!x.ok) throw new Error(`${t}: ${x.err}`)
    if (spec.extract !== t) run(['mv', join(root, 'tools', spec.extract), join(root, 'tools', t)])
    step(`tool ${t}`, `${tools[t].version} (sha256 ok)`)
  }

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
type Svc = { about?: string; command: string; workdir?: string; env?: Record<string, string>; port?: 'http' | 'internal' | 'none'
  public?: { name: string; auth: string }; depends_on?: Record<string, string>; ready?: { http?: string; socket?: string }; restart?: string; optional?: boolean }

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

export function up(root: string): Step[] {
  const { answers: a, services, schedules, socket, pp, dport } = resolve(root)
  const steps: Step[] = []
  mkdirSync(join(root, '.run', 'logs'), { recursive: true }); mkdirSync(join(root, '.dolt'), { recursive: true }); mkdirSync(PROJECTS_PC, { recursive: true })
  const obs = obsEndpoints() as { traces?: string; metrics?: string }
  const env = { PATH: toolPath(), MM_PROJECT: a.project, PORTLESS_PORT: String(pp), PORTLESS_HTTPS: '0', PORTLESS_SYNC_HOSTS: '0',
    ...(obs.traces ? { MM_OBS_TRACES: obs.traces, MM_OBS_METRICS: obs.metrics } : {}) }
  const processes: Record<string, unknown> = {}
  const pdeath = run(['sh', '-c', 'command -v setpriv']).ok ? 'setpriv --pdeathsig TERM ' : ''
  for (const [n, s] of Object.entries(services)) {
    let cmd = s.command.replaceAll('$PORT', '$$$$PORT') // keep $PORT for the service's shell (process-compose would expand it)
    // the service dies with its wrapper (portless): no orphan keeps the port after a crash or kill
    if (s.port === 'http') cmd = `portless ${n}.${a.project} ${pdeath}sh -c '${cmd.replaceAll("'", `'"'"'`)}'`
    const probe = s.ready?.http ? { exec: { command: `curl -sf -o /dev/null --max-time 3 ${s.url}${s.ready.http}` } }
      : s.ready?.socket ? { exec: { command: `test -S ${socket}` } } : undefined
    processes[`${a.project}.${n}`] = {
      namespace: a.project, command: cmd, working_dir: s.workdir || root,
      environment: Object.entries({ ...env, MM_SERVICE: n, ...s.env }).map(([k, v]) => `${k}=${v}`),
      log_location: join(root, '.run', 'logs', `${n}.log`),
      log_configuration: { add_timestamp: true, timestamp_format: '2006-01-02T15:04:05.000Z07:00', flush_each_line: true, rotation: { max_size_mb: 20, max_backups: 3 } },
      availability: { restart: s.restart === 'on_failure' ? 'on_failure' : 'always', backoff_seconds: 3 },
      ...(probe ? { readiness_probe: { ...probe, initial_delay_seconds: 1, period_seconds: 3, timeout_seconds: 4, failure_threshold: 20 } } : {}),
      // hung (running, not answering) for ~1 min: the manager restarts it (health only reports)
      ...(s.ready?.http ? { liveness_probe: { ...probe, initial_delay_seconds: 30, period_seconds: 10, timeout_seconds: 5, failure_threshold: 6 } } : {}),
      ...(s.depends_on ? { depends_on: Object.fromEntries(Object.keys(s.depends_on).filter((d) => services[d]).map((d) => [`${a.project}.${d}`, { condition: services[d].ready ? 'process_healthy' : 'process_started' }])) } : {}),
    }
  }
  // public services: a forwarder from bind_host to the service's loopback port (the web proxy runs in docker)
  for (const [n, s] of Object.entries(services)) {
    const bind = s.public_bind, port = s.public_port
    if (!port || !bind || /^(127\.|localhost$|::1$)/.test(bind)) continue
    processes[`${a.project}.${n}-public`] = {
      namespace: a.project, command: `${pdeath}socat TCP-LISTEN:${port},bind=${bind},reuseaddr,fork TCP:127.0.0.1:${port}`, working_dir: root,
      log_location: join(root, '.run', 'logs', `${n}-public.log`),
      availability: { restart: 'always', backoff_seconds: 3 },
      depends_on: { [`${a.project}.${n}`]: { condition: 'process_started' } },
    }
  }
  writeFileSync(join(PROJECTS_PC, `${a.project}.yaml`), `# Generated by mm from ${root.replace(HOME, '~')}/services.yaml. Do not edit.\nversion: "0.5"\n${Bun.YAML.stringify({ processes }, null, 2)}\n`)
  // what engine scripts read at runtime
  writeFileSync(join(root, '.run', 'services.json'), JSON.stringify({ project: a.project, dolt_port: dport, services, schedules }, null, 2))
  const ep = { manager: 'process-compose (mm)', self_healing: true, restart: `process-compose -U -u ${DIRS.socket} process restart ${a.project}.{service}`,
    logs: `tail -n {lines} ${join(root, '.run', 'logs')}/{service}.log`, observability: obsEndpoints(), dirs: engineDirs(),
    ...(publicKeyPem() ? { auth: { public_key: publicKeyPem() } } : {}), // the gateway's key: boards verify its assertions
    services: Object.fromEntries(Object.entries(services).map(([n, s]) => [n, { ...(s.url ? { url: s.url } : {}), ...(s.public_url ? { public: s.public_url } : {}) }])) }
  writeFileSync(join(root, '.run', 'endpoints.json'), JSON.stringify(ep, null, 2))
  steps.push({ step: 'services', status: 'ok', detail: `${Object.keys(processes).length} processes, namespace ${a.project}` })
  if (!pcRunning()) { steps.push({ step: 'process manager', status: 'fail', detail: 'not running and could not be started: run `mm onboard`' }); return steps }
  const r = loadAll()
  steps.push({ step: 'process manager', status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'loaded (project update)' : r.err.trim().slice(0, 200) })
  run(['process-compose', '-U', '-u', DIRS.socket, 'namespace', 'start', a.project])
  // public routes (domain mode): the machine's `expose` tool writes the router entry
  for (const [, s] of Object.entries(services)) {
    if (!s.public_port || !s.public) continue
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
  const out: { project: string; root: string; processes: string; ready: string; throwaway?: boolean }[] = []
  for (const f of existsSync(PROJECTS_PC) ? readdirSync(PROJECTS_PC).filter((x) => x.endsWith('.yaml')) : []) {
    const project = f.replace(/\.yaml$/, '')
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(PROJECTS_PC, f), 'utf8'))
    const ps = processes(project)
    let throwaway = false // a short-lived test project (mm new --throwaway): the system's sentinel raises nothing for it
    try { throwaway = !!readAnswers((m ? m[1] : '').replace(/^~(?=\/)/, HOME)).throwaway } catch {}
    out.push({ project, root: m ? m[1] : '?', processes: `${ps.filter((p) => p.status === 'Running').length}/${ps.length} running`, ready: `${ps.filter((p) => p.is_ready === 'Ready').length} ready`, ...(throwaway ? { throwaway } : {}) })
  }
  return out
}
