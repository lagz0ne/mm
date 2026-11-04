#!/usr/bin/env bun
// mm: set up the stack on a machine, and stamp projects from the template.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Command, Option } from 'commander'
import { getPath, loadConfig, saveConfig, setPath, unsetPath } from './config'
import { doctor } from './doctor'
import { DIRS, HOME, run, tilde } from './env'
import { expand as expandHome, fill, needs, unmet } from './inputs'
import { manifest } from './manifest'
import { onboard } from './onboard'
import { archive, restore, update } from './lifecycle'
import { cron } from './cron'
import * as vaultMod from './vault'
import * as syncMod from './sync'
import { restoreMachine } from './restore'
import { AUTH_SOCK, callApi, serve as authServe } from './auth'
import { health, logsql, mmSpan, obsEndpoints, ship, tracesql } from './obs'
import { findRoot, listProjects, namespaceOp, newProject, processes, resolve, up } from './project'
import { type Format, print } from './out'
import pkg from '../package.json'

const program = new Command('mm')
  .description('Set up the stack on a machine, and stamp projects from the template.')
  .version(pkg.version)
  .addOption(new Option('-o, --output <format>', 'output format').choices(['table', 'json', 'yaml']).default('table'))
  .option('--json', 'same as -o json')
  .option('-q, --quiet', 'only the essentials')
  .option('--host <machine>', 'run against another machine (not yet)')

const fmt = () => {
  const g = program.opts()
  if (g.host) { console.error('mm: --host is not supported yet'); process.exit(2) }
  return { format: (g.json ? 'json' : g.output) as Format, quiet: !!g.quiet }
}
const summary = (checks: { status: string }[]) => {
  const n = (s: string) => checks.filter((c) => c.status === s).length
  return { fail: n('fail'), warn: n('warn'), ok: n('ok') }
}

program.command('doctor').description('check this machine against the manifest (changes nothing)').action(() => {
  const o = fmt(), checks = doctor(), s = summary(checks)
  print(checks as unknown as Record<string, unknown>[], o, 'item')
  if (o.format === 'table' && !o.quiet) console.log(`\n${s.fail ? `${s.fail} failing, ` : ''}${s.warn} warning(s), ${s.ok} ok${s.fail ? ': run `mm onboard`' : ''}`)
  process.exit(s.fail ? 1 : 0)
})

program.command('onboard').description('install and configure what this machine is missing, then run doctor')
  .addOption(new Option('--access <mode>', 'access mode').choices(manifest.machine.inputs.access?.choices ?? ['tailscale', 'domain']))
  .option('--domain <domain>', 'domain (access = domain)')
  .option('--name <name>', 'machine name (default: hostname -s)')
  .option('-y, --yes', 'accept defaults, never prompt')
  .action(async (opts) => {
    const o = fmt()
    const { steps, checks } = await onboard({ ...opts, host: opts.name })
    const s = summary(checks)
    if (o.format !== 'table') return console.log(o.format === 'json' ? JSON.stringify({ steps, checks }, null, 2) : Bun.YAML.stringify({ steps, checks }, null, 2))
    if (steps.length) { print(steps, o); console.log('') }
    print(checks.filter((c) => c.status !== 'ok' && c.status !== 'skip') as unknown as Record<string, unknown>[], o)
    console.log(`\ndoctor: ${s.fail} failing, ${s.warn} warning(s), ${s.ok} ok${s.fail ? '' : ': ready'}`)
    process.exit(s.fail ? 1 : 0)
  })

const config = program.command('config').description('machine config (~/.mm/config.yaml)')
config.command('get [path]').action((p?: string) => {
  const c = loadConfig(), v = p ? getPath(c, p) : c
  if (v === undefined) process.exit(1)
  console.log(typeof v === 'object' ? Bun.YAML.stringify(v, null, 2) : String(v))
})
config.command('set <path> <value>').action((p: string, v: string) => { const c = loadConfig(); setPath(c, p, v); saveConfig(c) })
config.command('unset <path>').action((p: string) => { const c = loadConfig(); unsetPath(c, p); saveConfig(c) })

const projectRoots = () => listProjects().map((p) => ({ project: p.project, root: expandHome(p.root) }))
program.command('needs').description('every input this machine and its projects need (vars, secrets, accounts): status and how to fill it; exit 1 while a required one is missing')
  .option('-p, --project <project>', 'one project\'s inputs only').option('--machine', 'machine inputs only').option('--all', 'also those that do not apply here (when ...)')
  .action((opts) => {
    const o = fmt()
    const ps = opts.machine ? [] : projectRoots().filter((p) => !opts.project || p.project === opts.project)
    let rows = needs(ps)
    if (opts.project) rows = rows.filter((r) => r.scope !== 'machine')
    if (!opts.all) rows = rows.filter((r) => r.status !== 'n/a')
    const bad = unmet(rows)
    if (o.format !== 'table') console.log(o.format === 'json' ? JSON.stringify(rows, null, 2) : Bun.YAML.stringify(rows, null, 2))
    else {
      print(rows.map((r) => ({ scope: r.scope, name: r.name, kind: r.kind, need: r.required ? 'required' : 'optional', status: r.status, detail: r.detail || '', fill: r.fill || (r.status === 'missing' ? r.how : '') })), o)
      if (!o.quiet) {
        const how = rows.filter((r) => r.how && (r.status === 'missing' || r.status === 'bad'))
        if (how.length) { console.log('\nhow to get them:'); for (const r of how) console.log(`  ${r.scope === 'machine' ? '' : `${r.scope}:`}${r.name}: ${r.how} (for ${r.for})`) }
        console.log(`\n${bad.length ? `${bad.length} required input(s) missing` : 'every required input is there'}`)
      }
    }
    process.exit(bad.length ? 1 : 0)
  })
program.command('fill <name> [value]').description('fill one input (mm needs): a var takes the value; a secret (machine, or <project>:<NAME>) is read from --from <file>, a pipe, or the terminal without echo, never from the command line')
  .option('--from <file>', 'read the secret from this file (kept byte for byte)').option('--replace', 'overwrite one that is already filled')
  .action(async (name: string, value: string | undefined, opts) => {
    try { console.log(await fill(name, value, opts, (p) => projectRoots().find((x) => x.project === p)?.root)) }
    catch (e) { console.error(`mm fill: ${(e as Error).message}`); process.exit(1) }
  })

program.command('status').description('short machine status').action(() => {
  const o = fmt(), checks = doctor(), s = summary(checks)
  const c = loadConfig()
  print([{ host: String(getPath(c, 'host') ?? '?'), access: String(getPath(c, 'access') ?? '?'), mm: DIRS.mm, fail: s.fail, warn: s.warn, ok: s.ok }], o, 'host')
})

program.command('new <project>').description('stamp a project from the template: <client>/<name>')
  .option('--short <prefix>', 'item id prefix (default: first 2 letters of the name)')
  .option('--throwaway', 'a short-lived test project (QA): marked in its answers; the system board raises no incidents for it')
  .action(async (ref: string, opts) => {
    const o = fmt()
    try {
      const { answers, steps } = await newProject(ref, { short: opts.short, throwaway: !!opts.throwaway })
      if (o.format !== 'table') return console.log(o.format === 'json' ? JSON.stringify({ answers, steps }, null, 2) : Bun.YAML.stringify({ answers, steps }, null, 2))
      print(steps, o)
      const { services } = resolve(answers.root)
      console.log(`\n${answers.project} ready at ${tilde(answers.root)}`)
      for (const [n, s] of Object.entries(services)) if ((s as { url?: string }).url) console.log(`  ${n.padEnd(9)} ${(s as { url?: string }).url}`)
      process.exit(steps.some((s) => s.status === 'fail') ? 1 : 0)
    } catch (e) { console.error(`mm new: ${(e as Error).message}`); process.exit(1) }
  })
program.command('ls').description('list projects').action(() => { const o = fmt(); print(listProjects(), o, 'project') })
program.command('inspect <project>').description('a project: answers, services, URLs').action((ref: string) => {
  const o = fmt(), root = findRoot(ref)
  const { answers, services } = resolve(root), ps = processes(answers.project)
  const rows = Object.entries(services).map(([n, s]) => { const p = ps.find((x) => x.name === `${answers.project}.${n}`)
    return { service: n, status: p?.status ?? 'not loaded', ready: p?.is_ready ?? '', restarts: p?.restarts ?? '', url: (s as { url?: string }).url ?? '' } })
  if (o.format !== 'table') return print([{ ...answers, services: rows }] as unknown as Record<string, unknown>[], o)
  console.log(`${answers.project}  ${tilde(root)}  (template ${answers.template_version})`)
  print(rows, o, 'service')
})
program.command('up <project>').description('load (or reload) a project into the process manager and start it').action((ref: string) => {
  const o = fmt(); const steps = up(findRoot(ref)); print(steps, o); process.exit(steps.some((s) => s.status === 'fail') ? 1 : 0)
})
for (const [cmd, op] of [['down', 'stop'], ['restart', 'restart']] as const) {
  program.command(`${cmd} <project>`).description(`${op} a project's processes (namespace)`).action((ref: string) => {
    const r = namespaceOp(ref, op); console.log((r.out || r.err).trim()); process.exit(r.ok ? 0 : 1)
  })
}

program.command('update [project]').description('bring a project (default: every project) up to the current template; three-way merge, project edits kept')
  .option('-n, --dry-run', 'show what would change and what would conflict; change nothing')
  .option('--continue', 'finish an update after resolving its conflicts')
  .option('--abort', 'undo an update that stopped on conflicts')
  .option('--adopt', 'once, for a project made before mm update: record the template (MM_TEMPLATE_DIR) as its baseline')
  .action((ref: string | undefined, opts) => {
    const o = fmt()
    const roots = ref ? [findRoot(ref)] : listProjects().map((p) => p.root.replace(/^~(?=\/)/, HOME)).filter((r) => r !== '?')
    let bad = 0
    for (const root of roots) {
      const r = update(root, opts)
      if (!r.ok) bad++
      if (o.format !== 'table') { console.log(JSON.stringify({ root, ...r }, null, 2)); continue }
      console.log(`${tilde(root)}  ${r.from} -> ${r.to}`)
      print(r.steps, o)
      if (opts.dryRun && r.changed.length) console.log(r.changed.map((f) => `  ${r.conflicts.includes(f) ? 'C' : 'M'} ${f}`).join('\n'))
    }
    process.exit(bad ? 1 : 0)
  })
program.command('archive <project>').description('clean removal: stop + unload, drop public routes, archive agents, pack to a tarball, delete')
  .option('-n, --dry-run', 'show the plan; change nothing')
  .action((ref: string, opts) => {
    const o = fmt(), r = archive(findRoot(ref), opts)
    print(r.steps, o); if (!opts.dryRun && r.ok) console.log(`\narchived: ${r.tarball}\nbring back: mm restore ${r.tarball}`)
    process.exit(r.ok ? 0 : 1)
  })
program.command('restore <source>').description('an archived project (<tarball>.tar.gz), or a whole machine from mastermind onto a blank box (<repo>; docs/restore.md)')
  .option('--identity <file>', 'mastermind: your recovery identity, a file you name (read by age only, never copied)')
  .option('--accept <hash>', 'mastermind: restore HEAD although no signed tag covers it (type the hash restore showed you)')
  .option('--allowed-signers <file>', 'mastermind: ssh allowed_signers with your tag-signing key')
  .option('--drill', 'mastermind: a throwaway box; nothing outward-facing starts')
  .action((src: string, opts) => {
    const o = fmt()
    if (/\.tar\.gz$/.test(src) && existsSync(src)) { const r = restore(src); print(r.steps, o); process.exit(r.ok ? 0 : 1) }
    const r = restoreMachine(src, { identity: opts.identity, accept: opts.accept, allowedSigners: opts.allowedSigners, drill: opts.drill })
    print(r.steps, o); process.exit(r.ok ? 0 : 1)
})
const sys = program.command('system').description('the system project: the machine\'s own board and leads (ops, review, platform, setup), in the brain\'s system folder (~/brain/system, or $MM_HOME/system on a one-root box)')
sys.command('init').description('make the system project (profile system) next to the brain')
  .option('--name <host>', 'machine name (default: hostname -s)')
  .action(async (opts) => {
    const o = fmt()
    if (!existsSync(DIRS.brain)) { console.error(`mm system init: ${DIRS.brain.replace(HOME, '~')} missing (the brain repo comes first)`); process.exit(1) }
    const host = (opts.name || run(['hostname', '-s']).out.trim() || 'box').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '') || 'box'
    const root = DIRS.system
    if (root.startsWith(`${DIRS.brain}/`) && run(['git', '-C', DIRS.brain, 'rev-parse', '--git-dir']).ok && !run(['git', '-C', DIRS.brain, 'check-ignore', '-q', 'system/']).ok)
      console.error(`mm system init: note: add "/system/" to ${DIRS.brain.replace(HOME, '~')}/.gitignore (the system project is its own repo)`)
    try {
      const { answers, steps } = await newProject(`system/${host}`, { profile: 'system', root, project: 'system', short: 'sy' })
      print(steps, o)
      console.log(`\nsystem project at ${answers.root.replace(HOME, '~')}; start its leads: cd ${answers.root.replace(HOME, '~')} && for r in ops review platform setup; do bin/lead start $r; done`)
      process.exit(steps.some((x) => x.status === 'fail') ? 1 : 0)
    } catch (e) { console.error(`mm system init: ${(e as Error).message}`); process.exit(1) }
  })
for (const [name, desc] of [['client <action>', 'client ls|add']] as const) {
  program.command(name).description(`${desc} (not yet)`).action(() => { console.error(`mm ${name.split(' ')[0]}: not built yet`); process.exit(2) })
}

const auth = program.command('auth').description('sign-in for every board: a code on the screen, approved here or over the chat bot (docs/auth-gateway.md)')
auth.command('serve').description('(run by mm-pc as mm.auth) the sign-in gateway').action(() => { authServe() })
const authOut = (r: { status: number; data: unknown }) => { const o = fmt(); if (o.format !== 'table') console.log(JSON.stringify(r.data, null, 2)); else if (Array.isArray(r.data)) print(r.data as Record<string, unknown>[], o); else console.log(JSON.stringify(r.data)); process.exit(r.status < 300 ? 0 : 1) }
const authCall = async (path: string, body?: Record<string, unknown>) => { try { authOut(await callApi(path, body)) } catch (e) { console.error(`mm auth: the gateway does not answer on ${tilde(AUTH_SOCK)} (${(e as Error).message})`); process.exit(1) } }
auth.command('approve <code>').description("approve a code someone shows you: --as <name> grants them on the spot (the owner's step)")
  .option('--as <name>', 'their name on the boards').option('--for <scope>', 'project id(s), comma-separated, or all', '').option('--role <role>', 'member or viewer', 'member').option('--days <n>', 'how long the grant lasts', '7')
  .action((code: string, o) => authCall('/approve', { code, ...(o.as ? { as: o.as, scope: o.for, role: o.role, days: Number(o.days) } : {}), by: 'cli' }))
auth.command('pending <code>').description('what is asking with this code (board, browser, address, age), before approving').action((code: string) => authCall(`/pending?code=${encodeURIComponent(code)}`))
auth.command('grant <name>').description('give someone focus: --for <scope> [--role member|viewer] [--telegram <id>] [--days n]')
  .option('--for <scope>', 'project id(s), comma-separated, or all', '').option('--role <role>', 'member or viewer', 'member').option('--telegram <id>', 'their Telegram user id (they then approve their own codes)').option('--days <n>', '0 = no end', '0')
  .action((name: string, o) => authCall('/grant', { name, scope: o.for, role: o.role, telegram_id: o.telegram, days: Number(o.days), by: 'cli' }))
auth.command('revoke <name> [scope]').description('end a grant (or one scope of it) and its sessions at once; "all" ends every session').action((name: string, scope?: string) => authCall('/revoke', { name, scope, by: 'cli' }))
auth.command('grants').description('who may see and steer which boards').action(() => authCall('/grants'))
auth.command('sessions').description('who is signed in where').action(() => authCall('/sessions'))

program.command('sync').description('seal what can\'t be rebuilt into the mastermind repo and push it (docs/restore.md)')
  .option('--init <repo>', 'first time: clone the mastermind repo into ~/.mm/state/mastermind and remember it')
  .option('-n, --dry-run', 'list what would go in; seal and commit nothing')
  .option('--no-push', 'commit in the checkout only')
  .option('--fresh', 'one-time fresh start: replace mastermind\'s whole history with one commit (t2; needs --force)')
  .option('--force', 'with --fresh: really rewrite it')
  .action((opts) => {
    const o = fmt()
    try {
      if (opts.init) { print(syncMod.init(opts.init), o); return }
      const r = syncMod.sync({ dryRun: opts.dryRun, push: opts.push, fresh: opts.fresh, force: opts.force })
      print(r.steps, o); process.exit(r.ok ? 0 : 1)
    } catch (e) { console.error(`mm sync: ${(e as Error).message}`); process.exit(1) }
  })

program.command('cron').description('(run by mm-pc) run every project\'s schedules (health, backup, ...)').action(async () => { await cron() })
program.command('ship').description('(run by mm-pc) ship service log files to VictoriaLogs').action(async () => { await ship() })

const vaultCmd = program.command('vault').description('sealed secrets (age): two keys, opened only into memory-backed files at start (docs/vault.md)')
vaultCmd.command('init').description("make this machine's vault key and record the human's recovery PUBLIC key (age1…)")
  .requiredOption('--recovery <age1…>', "the recovery key's public half (keep its secret half offline)")
  .action((o) => { try { const r = vaultMod.init(o.recovery); console.log(`vault ready: sealed to this machine (${r.machine.slice(0, 16)}…) and the recovery key (${r.recovery.slice(0, 16)}…). Keep the recovery key's secret half offline.`) } catch (e) { console.error(`mm vault: ${(e as Error).message}`); process.exit(1) } })
vaultCmd.command('ls').description('what is sealed (names, sizes, digests; never a value)').action(() => { const o = fmt(); print(vaultMod.list() as unknown as Record<string, unknown>[], o) })
vaultCmd.command('check').description('modes and digests (doctor runs it too)').action(() => { const r = vaultMod.check(); for (const x of r) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.detail}`); process.exit(r.every((x) => x.ok) ? 0 : 1) })
vaultCmd.command('run <project> <names> [cmd...]').description('(used by mm up) open the named secrets for <project>, then run cmd with <NAME>_FILE set')
  .action(async (project: string, names: string, cmd: string[]) => {
    try {
      const list = names.split(',').filter(Boolean)
      const files = vaultMod.openFor(project, list.map((n) => vaultMod.projectSecretName(project, n)))
      const env: Record<string, string> = { ...process.env as Record<string, string> }
      list.forEach((n) => { env[`${n.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FILE`] = files[vaultMod.projectSecretName(project, n)] })
      const p = Bun.spawn(cmd, { env, stdio: ['inherit', 'inherit', 'inherit'] })
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => p.kill(sig))
      process.exit(await p.exited)
    } catch (e) { console.error(`mm vault run: ${(e as Error).message}`); process.exit(1) }
  })

const obs = program.command('obs').description('observability: the Victoria stack (metrics, logs, traces) and what it saw')
obs.command('status').description('are the stores up; what came in during the last hour').action(async () => {
  const o = fmt(), rows = await health(), down = rows.some((r) => r.status !== 'ok')
  const logs = down ? [] : await logsql('_time:1h | stats by (project) count() as logs, count() if (level:error) as errors | sort by (project)', 100).catch(() => [])
  const spans = down ? [] : await tracesql('_time:1h name:* | stats by ("resource_attr:service.namespace") count() as spans, count() if (status_code:2) as failed', 100).catch(() => [])
  const sp = Object.fromEntries(spans.map((r) => [r['resource_attr:service.namespace'] || 'mm', r]))
  const projects = logs.map((r) => ({ project: r.project, logs: r.logs, errors: r.errors, spans: sp[r.project]?.spans ?? 0, failed_spans: sp[r.project]?.failed ?? 0 }))
  if (o.format !== 'table') { console.log(o.format === 'json' ? JSON.stringify({ stores: rows, projects }, null, 2) : Bun.YAML.stringify({ stores: rows, projects }, null, 2)); process.exit(down ? 1 : 0) }
  print(rows, o, 'store')
  if (down) process.exit(1)
  console.log('')
  print(projects, o, 'project')
})
obs.command('errors').description('errors and failed operations, grouped (what the brain reads)')
  .option('--since <dur>', 'window, e.g. 15m 1h 1d', '1h').option('-p, --project <project>', 'one project (client-name)')
  .option('--by <group>', 'message (default) or service: one row per project/service with a few sample messages', 'message')
  .action(async (opts) => {
    const o = fmt(), f = opts.project ? ` project:${JSON.stringify(opts.project)}` : ''
    if (opts.by === 'service') {
      // one row per service, whatever its messages say (ids and counters in messages make every line its own group)
      const logs = await logsql(`_time:${opts.since} level:error${f} | stats by (project, service) count() as n, max(_time) as last, uniq_values(_msg) limit 3 as sample | sort by (n desc) | limit 200`)
      const spans = await tracesql(`_time:${opts.since} status_code:2${opts.project ? ` "resource_attr:service.namespace":${JSON.stringify(opts.project)}` : ''} | stats by ("resource_attr:service.name") count() as n, max(_time) as last, uniq_values(name) limit 3 as sample | sort by (n desc) | limit 200`)
      const list = (v: unknown) => { try { return JSON.parse(String(v)) as string[] } catch { return [] } }
      const rows = [...logs.map((r) => ({ kind: 'log', project: r.project, service: r.service, n: Number(r.n), last: r.last, sample: list(r.sample) })),
        ...spans.map((r) => { const s = String(r['resource_attr:service.name'] || ''), i = s.indexOf('/')
          return { kind: 'span', project: i > 0 ? s.slice(0, i) : s, service: i > 0 ? s.slice(i + 1) : s, n: Number(r.n), last: r.last, sample: list(r.sample) } })]
      if (o.format !== 'table') return console.log(JSON.stringify(rows, null, 2))
      return print(rows.map((r) => ({ kind: r.kind, project: r.project, service: r.service, n: r.n, last: r.last, sample: String(r.sample[0] || '').slice(0, 80) })), o)
    }
    const logs = await logsql(`_time:${opts.since} level:error${f} | stats by (project, service, _msg) count() as n, max(_time) as last | sort by (n desc) | limit 30`)
    const spans = await tracesql(`_time:${opts.since} status_code:2${opts.project ? ` "resource_attr:service.namespace":${JSON.stringify(opts.project)}` : ''} | stats by ("resource_attr:service.name", name, status_message) count() as n, max(_time) as last | sort by (n desc) | limit 30`)
    if (o.format !== 'table') return console.log(JSON.stringify({ logs, spans }, null, 2))
    console.log(`error logs (${opts.since})`); print(logs.map((r) => ({ project: r.project, service: r.service, n: r.n, last: r.last, msg: String(r._msg).slice(0, 90) })), o)
    console.log(`\nfailed operations (${opts.since})`); print(spans.map((r) => ({ service: r['resource_attr:service.name'], op: r.name, n: r.n, last: r.last, why: String(r.status_message || '').slice(0, 70) })), o)
  })
obs.command('slow').description('slowest operations (p95 by span name)').option('--since <dur>', 'window', '1h').option('-p, --project <project>', 'one project')
  .action(async (opts) => {
    const o = fmt(), f = opts.project ? ` "resource_attr:service.namespace":${JSON.stringify(opts.project)}` : ''
    const rows = await tracesql(`_time:${opts.since}${f} name:* | stats by ("resource_attr:service.name", name) count() as n, quantile(0.95, duration) as p95_ns, max(duration) as max_ns | sort by (p95_ns desc) | limit 25`)
    print(rows.map((r) => ({ service: r['resource_attr:service.name'], op: r.name, n: r.n, p95_ms: Math.round(Number(r.p95_ns) / 1e6), max_ms: Math.round(Number(r.max_ns) / 1e6) })), o)
  })
obs.command('logs').description('recent log lines (LogsQL filter optional)').argument('[query]', 'LogsQL, e.g. \'project:"acme-shop" service:board\'')
  .option('--since <dur>', 'window', '15m').option('-n, --lines <n>', 'lines', '50')
  .action(async (q: string | undefined, opts) => {
    const rows = await logsql(`_time:${opts.since}${q ? ` ${q}` : ''} | sort by (_time desc) | limit ${Number(opts.lines)}`)
    for (const r of rows.reverse()) console.log(`${r._time}  ${String(r.level || '').padEnd(5)} ${r.project}/${r.service}  ${r._msg}`)
  })
obs.command('ui').description('where the UIs are (loopback: open them through an SSH tunnel)').action(() => {
  const e = obsEndpoints() as { ui?: Record<string, string> }
  if (!e.ui) { console.error('mm obs: the stack is not installed (mm onboard)'); process.exit(1) }
  const ports = Object.values(e.ui).map((u) => new URL(u).port)
  for (const [k, u] of Object.entries(e.ui)) console.log(`${k.padEnd(8)} ${u}`)
  console.log(`\ntunnel: ssh ${ports.map((p) => `-L ${p}:127.0.0.1:${p}`).join(' ')} <this machine>`)
})

// Every mm command is one trace (children such as bin/init and npm join it); the long-running shipper is not.
program.hook('preAction', (_p, cmd) => {
  const name = [cmd.parent?.name() !== 'mm' ? cmd.parent?.name() : '', cmd.name()].filter(Boolean).join(' ')
  if (name === 'ship' || name === 'cron' || name.startsWith('obs')) return
  // fill: the name only, never what follows it (a secret typed on the command line by mistake must not reach a trace)
  const done = mmSpan(`mm ${name}`, { args: name === 'fill' ? String(cmd.args[0] ?? '') : cmd.args.join(' ') })
  process.on('exit', (code) => done(code === 0, { exit_code: code }))
})

// No arguments: onboard on first run, status afterwards.
if (process.argv.length <= 2) process.argv.push(Object.keys(loadConfig()).length ? 'status' : 'onboard')
await program.parseAsync()
