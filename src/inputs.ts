// Inputs: everything a machine (and each project) needs from a human, declared in the manifest (machine.inputs) and in
// each project's secrets.json. Kinds: var = an answer (config.yaml); secret = a file (mode 600, never in git); account =
// held elsewhere (checked when it can be, never stored). `managed_by` = a tool makes it; mm only checks it.
// `mm needs` lists them with their status; `mm fill` fills one. No value is ever printed, logged or traced.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { granted } from './apistate'
import { type Config, getPath, loadConfig, saveConfig, setPath, when } from './config'
import { DIRS, HOME, run } from './env'
import { manifest } from './manifest'
import * as vault from './vault'

export interface Input {
  kind: 'var' | 'secret' | 'account'
  for?: string; how?: string; when?: string; required?: boolean
  ask?: string; default?: string; choices?: string[]; config?: string // var
  path?: string; managed_by?: string; vault?: boolean                   // secret (vault: sealed once the vault exists)
  check?: string[]                                                     // account: exit 0 = there
}
export type Status = 'missing' | 'filled' | 'sealed' | 'managed' | 'unchecked' | 'bad' | 'n/a'
export interface Need { scope: string; name: string; kind: Input['kind']; status: Status; required: boolean; for: string; how: string; fill: string; detail?: string }

/** A manifest path on this machine: `~` is the home folder; `{brain}` the brain's folder in this layout (DIRS.brain). */
export const expand = (p: string) => p.replace(/^\{brain\}(?=\/|$)/, DIRS.brain).replace(/^~(?=\/|$)/, HOME)
// the brain's folder in either layout: the denies name both, so a machine whose layout was guessed wrong (or a folder
// left over from a move) is still covered
const BRAINS = [join(DIRS.mm, 'brain'), join(HOME, 'brain')]
const tilde = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
export const machineInputs = () => manifest.machine.inputs as Record<string, Input>
/**
 * Where this machine keeps its secrets (review sy-5ag): every secret input's file in the manifest, and the folder it is in
 * (never $HOME itself, never Claude's own folder), plus Paseo's home and Claude's own login. mm writes the list to
 * <mm>/secret-paths.json (writeSecretPaths); the template's config-check denies all of it to every role, so a new input is
 * covered without a template change. Paths only, never a value.
 */
export function machineSecretPaths(): { files: string[]; dirs: string[] } {
  const files = new Set<string>([join(HOME, '.claude', '.credentials.json')]), dirs = new Set<string>([join(HOME, '.paseo')])
  for (const i of Object.values(machineInputs())) {
    if (i.kind !== 'secret' || !i.path) continue
    const all = /^\{brain\}(\/|$)/.test(i.path) ? BRAINS.map((b) => i.path!.replace(/^\{brain\}/, b)) : [expand(i.path)]
    for (const f of all) {
      const d = dirname(f)
      files.add(f)
      if (d !== HOME && d !== join(HOME, '.claude') && d.startsWith(`${HOME}/`)) dirs.add(d)
    }
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() }
}
/** Where config-check reads machineSecretPaths() from: mm's own folder, outside every project, so neither a box nor a
 *  project's run files choose it (review sy-v92 2). config-check denies every role a change to it. */
export const secretPathsFile = () => join(DIRS.mm, 'secret-paths.json')
/** Write the list (paths only), whole or not at all: a temp file renamed over the old one. */
export function writeSecretPaths() {
  const f = secretPathsFile(), tmp = `${f}.${process.pid}.tmp`
  mkdirSync(DIRS.mm, { recursive: true })
  writeFileSync(tmp, JSON.stringify({ ...machineSecretPaths(), about: 'the machine\'s secret paths (no values), from mm\'s manifest; config-check denies them to every role' }, null, 2) + '\n', { mode: 0o644 })
  renameSync(tmp, f)
}
export const configKey = (name: string, i: Input) => i.config || name
/** A var's default, resolved ($(hostname -s), $HOME). */
export function varDefault(i: Input): string | undefined {
  return i.default === '$(hostname -s)' ? run(['hostname', '-s']).out.trim() : i.default === '$HOME' ? HOME : i.default
}

/** A secret file: there, mode 600, not tracked by git. Never opened. */
export function secretFile(p: string): { status: Status; detail: string } {
  const path = expand(p)
  if (!existsSync(path)) return { status: 'missing', detail: tilde(path) }
  const mode = (statSync(path).mode & 0o777).toString(8)
  if (mode !== '600') return { status: 'bad', detail: `${tilde(path)}: mode ${mode}, want 600 (chmod 600 ${tilde(path)})` }
  if (run(['git', '-C', dirname(path), 'ls-files', '--error-unmatch', basename(path)], { timeoutMs: 10_000 }).ok)
    return { status: 'bad', detail: `${tilde(path)}: tracked by git (git rm --cached, and ignore it)` }
  return { status: 'filled', detail: tilde(path) }
}

function machineNeed(name: string, i: Input, c: Config): Need {
  const base = { scope: 'machine', name, kind: i.kind, required: !!i.required, for: i.for || '', how: i.how || '' }
  if (!when(i.when, c)) return { ...base, status: 'n/a', fill: '', detail: `only when ${i.when}` }
  if (i.kind === 'var') {
    const v = getPath(c, configKey(name, i))
    if (v === undefined || v === '') return { ...base, status: 'missing', fill: `mm fill ${name} <value>`, detail: i.default ? `default ${i.default}` : undefined }
    if (i.choices && !i.choices.includes(String(v))) return { ...base, status: 'bad', fill: `mm fill ${name} <${i.choices.join('|')}>`, detail: `${v}: not one of ${i.choices.join(', ')}` }
    return { ...base, status: 'filled', fill: '', detail: String(v) } // vars are answers, not secrets: shown
  }
  if (i.kind === 'account') {
    if (!i.check) return { ...base, status: 'unchecked', fill: '', detail: 'check by hand' }
    const r = run(i.check, { timeoutMs: 15_000 })
    return { ...base, status: r.ok ? 'filled' : 'missing', fill: '', detail: r.ok ? `${i.check.join(' ')}: ok` : `${i.check.join(' ')} failed` }
  }
  const f = secretFile(i.path!)
  if (i.managed_by) return { ...base, status: f.status === 'filled' ? 'managed' : f.status, fill: '', detail: `${f.detail} (made by ${i.managed_by})` }
  return { ...base, status: f.status, fill: f.status === 'filled' ? '' : `mm fill ${name}`, detail: f.detail }
}

interface ProjectSecret { name: string; secret?: boolean; for?: string; about?: string; how?: string }
/** A project's inputs: its secrets.json (names only); values in {root}/secrets/<NAME>. */
export function projectNeeds(project: string, root: string): Need[] {
  let s: { required?: ProjectSecret[]; optional?: ProjectSecret[] } = {}
  const asked = granted(project).secrets // new secrets the owner granted a box through the project API (src/api.ts)
  try { s = JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8')) } catch { if (!asked.length) return [] }
  const known = new Set([...(s.required || []), ...(s.optional || [])].map((x) => x.name.toLowerCase()))
  s = { ...s, optional: [...(s.optional || []), ...asked.filter((x) => !known.has(x.name)).map((x) => ({ name: x.name, for: `the box asked for it (mm.api ${x.id}); it gets it at its next start` }))] }
  const out: Need[] = []
  for (const [list, required] of [[s.required || [], true], [s.optional || [], false]] as const)
    for (const x of list) {
      const vn = vault.projectSecretName(project, x.name), inVault = x.secret !== false && vault.sealed(vn)
      const f = inVault ? { status: 'sealed' as Status, detail: `vault/${vn}.age` } : secretFile(join(root, 'secrets', x.name))
      out.push({ scope: project, name: x.name, kind: x.secret === false ? 'var' : 'secret', status: f.status, required, for: [x.for, x.about].filter(Boolean).join(': '),
        how: x.how || '', fill: f.status === 'filled' || f.status === 'sealed' ? '' : `mm fill ${project}:${x.name}`, detail: f.detail })
    }
  return out
}

export function needs(projects: { project: string; root: string }[] = [], c = loadConfig()): Need[] {
  return [...Object.entries(machineInputs()).map(([n, i]) => machineNeed(n, i, c)), ...projects.flatMap((p) => projectNeeds(p.project, p.root))]
}
/** Required and missing (or bad): what doctor fails on. */
export const unmet = (n: Need[]) => n.filter((x) => x.required && (x.status === 'missing' || x.status === 'bad'))

// ---------- fill ----------
/** Read a line from the terminal without echo. */
async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt)
  const stdin = process.stdin
  stdin.setRawMode(true); stdin.resume()
  let val = ''
  try {
    for await (const chunk of stdin) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return val
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130) } // Ctrl-C
        if (ch === '\u0004') return val                                        // Ctrl-D
        if (ch === '\u007f' || ch === '\b') val = val.slice(0, -1)
        else val += ch
      }
    }
    return val
  } finally { stdin.setRawMode(false); stdin.pause(); process.stderr.write('\n') }
}
async function readAll(): Promise<string> { return await new Response(Bun.stdin.stream()).text() }

/** Write a secret file atomically, mode 600, its folder 700 when mm makes it. */
export function writeSecret(path: string, value: string) {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.mm-fill-${process.pid}`
  writeFileSync(tmp, value, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, path)
}

export interface FillOpts { from?: string; replace?: boolean }
/**
 * Fill one input. `name` is a machine input or <project>:<NAME>. Secrets come from --from <file>, a pipe, or the terminal
 * (no echo); never from the command line (shell history). Vars take the value as an argument. Returns a message
 * without the value.
 */
export async function fill(name: string, value: string | undefined, o: FillOpts, projectRoot: (p: string) => string | undefined): Promise<string> {
  const c = loadConfig()
  let target: { kind: Input['kind']; path?: string; input?: Input; label: string }
  const m = /^([\w.-]+):([\w.-]+)$/.exec(name)
  if (m) {
    const root = projectRoot(m[1]); if (!root) throw new Error(`no project ${m[1]} (mm ls)`)
    const n = projectNeeds(m[1], root).find((x) => x.name === m[2])
    if (!n) throw new Error(`${m[1]} does not declare ${m[2]} (its secrets.json)`)
    target = { kind: 'secret', path: join(root, 'secrets', m[2]), label: `${m[1]}:${m[2]}` } // project values are all files
    if (n.kind === 'var' && value !== undefined) { // not a secret (secrets.json "secret": false): the value may be an argument
      if (existsSync(target.path!) && !o.replace) throw new Error(`${target.label} is already filled; pass --replace to overwrite it`)
      writeSecret(target.path!, value)
      return `${target.label} = ${value} (${tilde(target.path!)})`
    }
  } else {
    const i = machineInputs()[name]
    if (!i) throw new Error(`no input ${name} (mm needs)`)
    if (i.kind === 'account') throw new Error(`${name} is an account, not stored by mm: ${i.how || i.for || 'see mm needs'}`)
    if (i.managed_by) throw new Error(`${name} is made by ${i.managed_by}, not filled by hand`)
    target = { kind: i.kind, path: i.path ? expand(i.path) : undefined, input: i, label: name }
  }

  if (target.kind === 'var') {
    const i = target.input!
    if (value === undefined) throw new Error(`usage: mm fill ${name} <value>${i.choices ? ` (one of ${i.choices.join(', ')})` : ''}`)
    if (i.choices && !i.choices.includes(value)) throw new Error(`${value} is not one of ${i.choices.join(', ')}`)
    setPath(c, configKey(name, i), value); saveConfig(c)
    return `${name} = ${value} (config.yaml)`
  }

  if (value !== undefined) throw new Error(`a secret is never given on the command line (it would stay in your shell history): use --from <file>, a pipe, or run it in a terminal`)
  const path = target.path!
  const vn = m ? vault.projectSecretName(m[1], m[2]) : target.input?.vault ? name : null
  const toVault = !!vn && vault.ready()
  // a secret a box asked for (the project API) goes only into the vault: a file in the project is the box's to read
  if (m && !toVault && granted(m[1]).secrets.some((x) => x.name === m[2].toLowerCase())) throw new Error(`${target.label} was asked for by the box: it goes only into the vault, and this machine has none yet (mm vault init)`)
  if (!toVault && existsSync(path) && !o.replace) throw new Error(`${target.label} is already filled (${tilde(path)}); pass --replace to overwrite it`)
  if (toVault && vault.sealed(vn!) && !o.replace) throw new Error(`${target.label} is already sealed; pass --replace to reseal it`)
  let v: string
  if (o.from) v = readFileSync(expand(o.from), 'utf8')
  else if (process.stdin.isTTY) v = await readHidden(`${target.label} (input hidden): `)
  else v = await readAll()
  if (!o.from) v = v.replace(/\r?\n$/, '') // a typed or piped line; a file is kept byte for byte (keys)
  if (!v.trim()) throw new Error('empty value: nothing written')
  if (toVault) { vault.seal(vn!, Buffer.from(v)); return `${target.label} sealed (vault/${vn}.age, to the machine key and the recovery key). Services that declare it get it at their next start.` }
  writeSecret(path, v)
  const used = target.input?.for ? `; used by ${target.input.for}` : ''
  return `${target.label} filled (${tilde(path)}, mode 600)${used}. Restart what uses it to pick it up.`
}
