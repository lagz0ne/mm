#!/usr/bin/env bun
// mm: set up the stack on a machine, and stamp projects from the template.
import { Command, Option } from 'commander'
import { getPath, loadConfig, saveConfig, setPath, unsetPath } from './config'
import { doctor } from './doctor'
import { DIRS } from './env'
import { manifest } from './manifest'
import { onboard } from './onboard'
import { listProjects, namespaceOp, newProject, parseRef, processes, resolve, rootOf, up } from './project'
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
  .addOption(new Option('--access <mode>', 'access mode').choices(manifest.machine.vars.access?.choices ?? ['tailscale', 'domain']))
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

program.command('status').description('short machine status').action(() => {
  const o = fmt(), checks = doctor(), s = summary(checks)
  const c = loadConfig()
  print([{ host: String(getPath(c, 'host') ?? '?'), access: String(getPath(c, 'access') ?? '?'), mm: DIRS.mm, fail: s.fail, warn: s.warn, ok: s.ok }], o, 'host')
})

program.command('new <project>').description('stamp a project from the template: <client>/<name>')
  .option('--short <prefix>', 'item id prefix (default: first 2 letters of the name)')
  .action(async (ref: string, opts) => {
    const o = fmt()
    try {
      const { answers, steps } = await newProject(ref, opts.short)
      if (o.format !== 'table') return console.log(o.format === 'json' ? JSON.stringify({ answers, steps }, null, 2) : Bun.YAML.stringify({ answers, steps }, null, 2))
      print(steps, o)
      const { services } = resolve(answers.root)
      console.log(`\n${answers.project} ready at ${answers.root.replace(DIRS.projects, '~/projects')}`)
      for (const [n, s] of Object.entries(services)) if ((s as { url?: string }).url) console.log(`  ${n.padEnd(9)} ${(s as { url?: string }).url}`)
      process.exit(steps.some((s) => s.status === 'fail') ? 1 : 0)
    } catch (e) { console.error(`mm new: ${(e as Error).message}`); process.exit(1) }
  })
program.command('ls').description('list projects').action(() => { const o = fmt(); print(listProjects(), o, 'project') })
program.command('inspect <project>').description('a project: answers, services, URLs').action((ref: string) => {
  const o = fmt(), { client, name } = parseRef(ref), root = rootOf(client, name)
  const { answers, services } = resolve(root), ps = processes(answers.project)
  const rows = Object.entries(services).map(([n, s]) => { const p = ps.find((x) => x.name === `${answers.project}.${n}`)
    return { service: n, status: p?.status ?? 'not loaded', ready: p?.is_ready ?? '', restarts: p?.restarts ?? '', url: (s as { url?: string }).url ?? '' } })
  if (o.format !== 'table') return print([{ ...answers, services: rows }] as unknown as Record<string, unknown>[], o)
  console.log(`${answers.project}  ${root.replace(DIRS.projects, '~/projects')}  (template ${answers.template_version})`)
  print(rows, o, 'service')
})
program.command('up <project>').description('load (or reload) a project into the process manager and start it').action((ref: string) => {
  const o = fmt(), { client, name } = parseRef(ref); const steps = up(rootOf(client, name)); print(steps, o); process.exit(steps.some((s) => s.status === 'fail') ? 1 : 0)
})
for (const [cmd, op] of [['down', 'stop'], ['restart', 'restart']] as const) {
  program.command(`${cmd} <project>`).description(`${op} a project's processes (namespace)`).action((ref: string) => {
    const r = namespaceOp(ref, op); console.log((r.out || r.err).trim()); process.exit(r.ok ? 0 : 1)
  })
}

for (const [name, desc] of [['update [project]', 'update a project from the template'], ['archive <project>', 'archive a project'],
  ['brain <action>', 'brain status|pull|push'], ['client <action>', 'client ls|add']] as const) {
  program.command(name).description(`${desc} (not yet: step 3)`).action(() => { console.error(`mm ${name.split(' ')[0]}: not built yet (step 3 of the plan)`); process.exit(2) })
}

// No arguments: onboard on first run, status afterwards.
if (process.argv.length <= 2) process.argv.push(Object.keys(loadConfig()).length ? 'status' : 'onboard')
await program.parseAsync()
