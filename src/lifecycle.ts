// Project lifecycle after `mm new`: update from the template (three-way merge), restart, archive (clean removal).
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { canon, DIRS, HOME, run, within } from './env'
import { loadAll, PROJECTS_PC, readAnswers, resolve, up } from './project'
import { template, templateCommit } from './template'

type Step = { step: string; status: 'ok' | 'fail' | 'skip'; detail: string }
const pc = (...a: string[]) => run(['process-compose', '-U', '-u', DIRS.socket, ...a], { timeoutMs: 120_000 })
const gitIn = (root: string) => (args: string[], env?: Record<string, string>) => run(['git', '-C', root, ...args], { env, timeoutMs: 120_000 })
const short = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 200)

function varsOf(root: string) {
  const a = readAnswers(root)
  return { a, vars: { client: a.client, name: a.name, project: a.project, short: a.short, root, home: HOME, brain: DIRS.brain, projects: DIRS.projects, mm: DIRS.mm, claude_dir: join(DIRS.mm, 'claude', a.project), profile: a.profile || 'project' } as Record<string, string> }
}

// ---------- mm update ----------
export type UpdateOpts = { dryRun?: boolean; adopt?: boolean; continue?: boolean; abort?: boolean }
export type UpdateResult = { steps: Step[]; from: string; to: string; changed: string[]; conflicts: string[]; ok: boolean }

/**
 * Bring a project up to the current template. The `mm-template` branch holds pure renders of each template version
 * the project has taken; the new render is committed on top and merged into main, so the project's own edits are
 * kept and only real overlaps conflict. Nothing is committed unless the merge is clean, the board builds and the
 * governance check passes; otherwise the merge is left for resolving (`--continue`) or undone (`--abort`).
 */
export function update(root: string, o: UpdateOpts = {}): UpdateResult {
  const git = gitIn(root), { a, vars } = varsOf(root), t = template()
  const steps: Step[] = [], res: UpdateResult = { steps, from: a.template_version, to: t.version, changed: [], conflicts: [], ok: false }
  const fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return res }
  const merging = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok

  if (o.abort) {
    if (!merging) return fail('abort', 'no update in progress')
    const r = git(['merge', '--abort'])
    if (!r.ok) return fail('abort', short(r))
    steps.push({ step: 'abort', status: 'ok', detail: 'merge undone; project is as before' })
    rebuildIfBroken(root, steps)
    res.ok = true; return res
  }
  if (o.continue) {
    if (!merging) return fail('continue', 'no update in progress')
    return finish(root, res)
  }
  if (merging) return fail('update', 'an update is already in progress: resolve and `mm update --continue`, or `--abort`')
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).out.trim()
  if (dirty) return fail('clean tree', `commit or discard local changes first:\n${dirty}`)

  const old = git(['rev-parse', '-q', '--verify', 'refs/heads/mm-template']).out.trim()
  if (!old && !o.adopt) return fail('baseline', 'no mm-template branch (project predates mm update). Adopt once with the template it was made from: MM_TEMPLATE_DIR=<old template> mm update <project> --adopt')
  const next = templateCommit(root, vars, `template ${t.version}`, old || undefined, t)
  if (old && git(['rev-parse', `${old}^{tree}`]).out === git(['rev-parse', `${next}^{tree}`]).out) {
    steps.push({ step: 'template', status: 'ok', detail: `already at ${a.template_version === t.version ? t.version : 'the current template'}` })
    res.ok = true; return res
  }

  if (o.adopt) {
    if (old) return fail('adopt', 'already has an mm-template branch; run a plain update')
    if (o.dryRun) { steps.push({ step: 'adopt', status: 'ok', detail: `would record template ${t.version} as baseline` }); res.ok = true; return res }
    git(['branch', 'mm-template', next])
    const r = git(['merge', '-q', '-s', 'ours', '--allow-unrelated-histories', '-m', `mm: adopt template ${t.version} as the update baseline`, 'mm-template'], { SETUP_HUMAN: '1' })
    if (!r.ok) { git(['branch', '-D', 'mm-template']); return fail('adopt', short(r)) }
    writeAnswers(root, { ...a, template_version: t.version })
    git(['commit', '-q', '-m', `mm: template_version ${t.version}`, '.mm-answers.yaml'], { SETUP_HUMAN: '1' })
    steps.push({ step: 'adopt', status: 'ok', detail: `baseline = template ${t.version}; files unchanged` })
    res.ok = true; return res
  }

  // preview: the merge result without touching anything
  const mt = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', next])
  const [tree, ...rest] = mt.out.trim().split('\n')
  res.conflicts = mt.ok ? [] : rest.filter(Boolean)
  res.changed = git(['diff', '--name-only', 'HEAD', tree]).out.trim().split('\n').filter(Boolean)
  steps.push({ step: 'plan', status: res.conflicts.length ? 'fail' : 'ok', detail: `${a.template_version} -> ${t.version}: ${res.changed.length} file(s) change${res.conflicts.length ? `, ${res.conflicts.length} conflict(s)` : ''}` })
  if (o.dryRun) { res.ok = !res.conflicts.length; return res }

  const m = git(['merge', '--no-ff', '--no-commit', next], { SETUP_HUMAN: '1' })
  if (!m.ok) {
    res.conflicts = git(['diff', '--name-only', '--diff-filter=U']).out.trim().split('\n').filter(Boolean)
    if (res.conflicts.length) return fail('merge', `conflicts in ${res.conflicts.join(', ')}: fix them, \`git add\`, then \`mm update --continue\` (or \`--abort\`)`)
    return fail('merge', short(m))
  }
  steps.push({ step: 'merge', status: 'ok', detail: `${res.changed.length} file(s)` })
  return finish(root, res)
}

/** After a clean (or resolved) merge: build, check, commit, then apply to the running services. */
function finish(root: string, res: UpdateResult): UpdateResult {
  const git = gitIn(root), { steps } = res, { a } = varsOf(root)
  const fail = (step: string, r: { out: string; err: string }) => { steps.push({ step, status: 'fail', detail: `${short(r)} — merge left in place: fix and \`mm update --continue\`, or \`--abort\`` }); return res }
  const unmerged = git(['diff', '--name-only', '--diff-filter=U']).out.trim()
  if (unmerged) { steps.push({ step: 'merge', status: 'fail', detail: `still conflicted: ${unmerged.split('\n').join(', ')}` }); return res }
  const markers = git(['grep', '-lE', '^(<{7}|>{7})( |$)', '--cached']).out.trim()
  if (markers) { steps.push({ step: 'merge', status: 'fail', detail: `conflict markers left in: ${markers.split('\n').join(', ')}` }); return res }
  const changed = git(['diff', '--name-only', '--cached', 'HEAD']).out.trim().split('\n').filter(Boolean)
  res.changed = changed
  const next = git(['rev-parse', 'MERGE_HEAD']).out.trim()
  const to = /^template (\S+)/.exec(git(['log', '-1', '--format=%s', next]).out)?.[1] ?? res.to
  res.to = to

  const site = changed.some((f) => f.startsWith('site/'))
  if (site) {
    const deps = changed.some((f) => /^site\/package(-lock)?\.json$/.test(f)) || !existsSync(join(root, 'site', 'node_modules'))
    const b = run(['sh', '-c', `${deps ? 'npm ci --no-audit --no-fund --silent && ' : ''}npm run build --silent`], { cwd: join(root, 'site'), timeoutMs: 900_000 })
    if (!b.ok) return fail('board build', b)
    steps.push({ step: 'board build', status: 'ok', detail: deps ? 'deps + build' : 'build' })
  }
  const cc = run([join(root, 'bin', 'config-check'), '--render'], { cwd: root })
  if (!cc.ok) return fail('governance check', cc)
  steps.push({ step: 'governance check', status: 'ok', detail: cc.out.trim().split('\n').pop() || 'ok' })

  writeAnswers(root, { ...a, template_version: to })
  git(['add', '.mm-answers.yaml'])
  const c = git(['commit', '-q', '-m', `mm update: template ${a.template_version} -> ${to}\n\n${changed.length} file(s): ${changed.slice(0, 30).join(', ')}${changed.length > 30 ? ', …' : ''}`], { SETUP_HUMAN: '1' })
  if (!c.ok) return fail('commit', c)
  git(['branch', '-f', 'mm-template', next])
  steps.push({ step: 'commit', status: 'ok', detail: git(['log', '-1', '--format=%h %s']).out.trim() })

  // apply: reload the service definitions, then restart what runs changed code (services.yaml changes restart via reload)
  steps.push(...up(root))
  const engine = changed.some((f) => f.startsWith('site/') || f.startsWith('bin/'))
  if (engine) {
    const { services } = resolve(root)
    const which = Object.keys(services).filter((n) => n !== 'dolt' && n !== 'bd-serve' && n !== 'app')
    for (const n of which) {
      const r = pc('process', 'restart', `${a.project}.${n}`)
      steps.push({ step: `restart ${n}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'restarted' : short(r) })
    }
  }
  if (changed.some((f) => f.startsWith('leads/'))) steps.push({ step: 'leads', status: 'skip', detail: 'role files changed: running leads pick them up on their next start (`bin/lead <role>`)' })
  res.ok = !steps.some((s) => s.status === 'fail')
  return res
}

function rebuildIfBroken(root: string, steps: Step[]) {
  if (existsSync(join(root, 'site', 'dist', 'index.html'))) return
  const b = run(['sh', '-c', 'npm run build --silent'], { cwd: join(root, 'site'), timeoutMs: 900_000 })
  steps.push({ step: 'board build', status: b.ok ? 'ok' : 'fail', detail: b.ok ? 'rebuilt after abort' : short(b) })
}

function writeAnswers(root: string, a: object) {
  writeFileSync(join(root, '.mm-answers.yaml'), `# Answers mm new used for this project (mm update renders the template again with these).\n${Bun.YAML.stringify(a, null, 2)}\n`)
}

// ---------- mm archive ----------
export const ARCHIVE_DIR = DIRS.archive

/**
 * Clean removal: stop and unload the namespace, drop public routes, archive the project's agents, pack the whole
 * project directory (repos, board database, logs) into one tarball, then delete it. `mm restore` brings it back.
 */
export function archive(root: string, o: { dryRun?: boolean } = {}): { steps: Step[]; tarball: string; ok: boolean } {
  const { a } = varsOf(root), steps: Step[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const tarball = join(ARCHIVE_DIR, `${a.project}-${stamp}.tar.gz`)
  let services: ReturnType<typeof resolve>['services'] = {}
  try { services = resolve(root).services } catch {}
  const agents = projectAgents(root)
  const plan = [`stop + unload namespace ${a.project}`, ...Object.values(services).filter((s) => s.public_port && s.public).map((s) => `unexpose ${s.public!.name}`),
    `archive ${agents.length} agent(s)`, `pack ${root.replace(HOME, '~')} -> ${tarball.replace(HOME, '~')}`, `delete ${root.replace(HOME, '~')}`]
  if (o.dryRun) return { steps: plan.map((p) => ({ step: 'plan', status: 'ok', detail: p })), tarball, ok: true }

  // 1. processes: stop, then reload process-compose without the project file (removes its processes)
  const s = pc('namespace', 'stop', a.project)
  steps.push({ step: 'stop', status: s.ok || /not found|no process/i.test(short(s)) ? 'ok' : 'fail', detail: s.ok ? `namespace ${a.project}` : short(s) })
  const pf = join(PROJECTS_PC, `${a.project}.yaml`)
  if (existsSync(pf)) rmSync(pf)
  // the reload can race processes that are still stopping: try again briefly
  let l = loadAll()
  for (let i = 0; i < 5 && !l.ok; i++) { Bun.sleepSync(2000); l = loadAll() }
  const left = pc('process', 'list', '-o', 'json')
  const still = left.ok ? (JSON.parse(left.out) as { name: string }[]).filter((p) => p.name.startsWith(`${a.project}.`)).map((p) => p.name) : []
  for (const n of still) pc('process', 'stop', n)
  steps.push({ step: 'unload', status: l.ok ? 'ok' : 'fail', detail: l.ok ? (still.length ? `reloaded; ${still.length} process(es) process-compose keeps were stopped` : 'reloaded without the project') : (short(l) || `process-compose exit ${l.code}`) })

  // 2. public routes
  for (const sv of Object.values(services)) {
    if (!sv.public_port || !sv.public) continue
    const r = run(['expose', 'rm', sv.public.name], { timeoutMs: 30_000 })
    steps.push({ step: `unexpose ${sv.public.name}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? 'route removed' : short(r) })
  }
  // 3. agents (soft-delete in Paseo; their history stays recoverable there)
  let n = 0
  for (const id of agents) if (run(['paseo', 'archive', '--force', id], { timeoutMs: 30_000 }).ok) n++
  steps.push({ step: 'agents', status: n === agents.length ? 'ok' : 'fail', detail: `${n}/${agents.length} archived` })
  // 4. anything still running from the project (orphans of a crashed wrapper, bd's db proxy, agent tools)
  const swept = sweep(root)
  steps.push({ step: 'sweep', status: 'ok', detail: swept.length ? `stopped ${swept.length} leftover process(es): ${swept.join(', ').slice(0, 160)}` : 'nothing left running' })

  // 5. pack, verify, delete
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const base = canon(DIRS.projects), rel = relative(base, canon(root))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) { steps.push({ step: 'pack', status: 'fail', detail: `${root.replace(HOME, '~')} is not under ${DIRS.projects.replace(HOME, '~')}; project directory kept` }); return { steps, tarball, ok: false } }
  const p = run(['tar', '-czf', tarball, '--exclude=site/node_modules', '-C', base, rel], { timeoutMs: 900_000 })
  const v = p.ok && run(['tar', '-tzf', tarball], { timeoutMs: 300_000 })
  if (!p.ok || !v || !v.ok || !v.out.includes(`${rel}/.mm-answers.yaml`)) {
    steps.push({ step: 'pack', status: 'fail', detail: `${p.ok ? 'tarball did not verify' : short(p)}; project directory kept` })
    return { steps, tarball, ok: false }
  }
  steps.push({ step: 'pack', status: 'ok', detail: `${tarball.replace(HOME, '~')} (${(Bun.file(tarball).size / 1e6).toFixed(1)} MB)` })
  rmSync(root, { recursive: true, force: true })
  // its agents' own Claude folder (sessions only: what they learn lives in the project's memory/, in the tarball)
  if (/^[a-z][a-z0-9-]{0,62}$/.test(a.project)) {
    const cdir = join(DIRS.mm, 'claude', a.project)
    if (existsSync(cdir)) { rmSync(cdir, { recursive: true, force: true }); steps.push({ step: 'claude folder', status: 'ok', detail: `${cdir.replace(HOME, '~')} removed` }) }
  }
  const clientDir = join(DIRS.projects, a.client)
  if (existsSync(clientDir) && !readdirSync(clientDir).length) rmSync(clientDir, { recursive: true })
  steps.push({ step: 'delete', status: 'ok', detail: root.replace(HOME, '~') })
  return { steps, tarball, ok: !steps.some((x) => x.status === 'fail') }
}

/** Unpack an archived project and bring it back up. */
export function restore(tarball: string): { steps: Step[]; root: string; ok: boolean } {
  const steps: Step[] = []
  const list = run(['tar', '-tzf', tarball], { timeoutMs: 300_000 })
  const ans = list.out.split('\n').find((l) => /^([a-z][a-z0-9-]*\/){1,2}\.mm-answers\.yaml$/.test(l))
  if (!list.ok || !ans) return { steps: [{ step: 'tarball', status: 'fail', detail: 'not an mm project archive' }], root: '', ok: false }
  const root = join(DIRS.projects, ans.replace(/\/\.mm-answers\.yaml$/, ''))
  if (existsSync(root)) return { steps: [{ step: 'restore', status: 'fail', detail: `${root.replace(HOME, '~')} exists` }], root, ok: false }
  mkdirSync(DIRS.projects, { recursive: true })
  const x = run(['tar', '-xzf', tarball, '-C', DIRS.projects], { timeoutMs: 900_000 })
  if (!x.ok) return { steps: [{ step: 'unpack', status: 'fail', detail: short(x) }], root, ok: false }
  steps.push({ step: 'unpack', status: 'ok', detail: root.replace(HOME, '~') })
  rmSync(join(root, '.dolt', 'mysql.sock'), { force: true })
  if (!existsSync(join(root, 'site', 'node_modules'))) {
    const b = run(['sh', '-c', 'npm ci --no-audit --no-fund --silent'], { cwd: join(root, 'site'), timeoutMs: 900_000 })
    steps.push({ step: 'board deps', status: b.ok ? 'ok' : 'fail', detail: b.ok ? 'installed' : short(b) })
  }
  steps.push(...up(root))
  return { steps, root, ok: !steps.some((s) => s.status === 'fail') }
}

/**
 * Processes still running from the project after its namespace stopped: started from a file under the root, or
 * working inside it (orphans of a crashed wrapper, bd's db proxy). TERM, then KILL after 3s. Returns "pid name".
 */
export function sweep(root: string): string[] {
  const mine = new Set<number>(); for (let p = process.pid; p > 1;) { mine.add(p); const st = readProc(p, 'stat'); p = st ? Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) : 0 }
  const real = canon(root), inRoot = (f: string) => within(f, real) // /proc shows real paths; argv may use any spelling
  const hits: { pid: number; name: string }[] = []
  for (const d of readdirSync('/proc')) {
    const pid = Number(d); if (!pid || mine.has(pid)) continue
    const argv = (readProc(pid, 'cmdline') || '').split('\0').filter(Boolean); if (!argv.length) continue
    let cwd = ''; try { cwd = readlinkSync(`/proc/${pid}/cwd`) } catch {}
    if (inRoot(cwd) || inRoot(argv[0]) || (argv[1] && inRoot(argv[1]))) hits.push({ pid, name: (argv[1] && inRoot(argv[1]) ? argv[1] : argv[0]).split('/').pop() || '?' })
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  for (const h of hits) try { process.kill(h.pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 30 && hits.some((h) => alive(h.pid)); i++) Bun.sleepSync(100)
  for (const h of hits) if (alive(h.pid)) try { process.kill(h.pid, 'SIGKILL') } catch {}
  return hits.map((h) => `${h.pid} ${h.name}`)
}
function readProc(pid: number, f: string) { try { return readFileSync(`/proc/${pid}/${f}`, 'utf8') } catch { return '' } }

/** Paseo agents whose working directory is inside the project. */
function projectAgents(root: string): string[] {
  const r = run(['paseo', 'ls', '-g', '--json'], { timeoutMs: 30_000 })
  if (!r.ok) return []
  try {
    return (JSON.parse(r.out) as { id: string; cwd?: string }[])
      .filter((x) => within(String(x.cwd || ''), root)).map((x) => x.id) // agents keep the spelling they started with
  } catch { return [] }
}
