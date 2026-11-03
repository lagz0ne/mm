// mm onboard: make this machine match the manifest. Idempotent: only fixes what doctor finds missing.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkTool, doctor, type Check } from './doctor'
import { type Config, getPath, loadConfig, saveConfig, setPath, when } from './config'
import { DIRS, HOME, run } from './env'
import { install, installSystem, packageManager } from './install'
import { manifest } from './manifest'
import { ensurePc } from './pc'

export interface OnboardOpts { access?: string; domain?: string; host?: string; yes?: boolean }
type Step = { step: string; status: 'ok' | 'fixed' | 'fail' | 'skip'; detail: string }

function ask(question: string, def?: string, choices?: string[]): string | undefined {
  if (!process.stdin.isTTY) return def
  const hint = choices ? ` (${choices.join('/')})` : ''
  const a = prompt(`${question}${hint}${def ? ` [${def}]` : ''}:`)?.trim()
  return a || def
}

function vars(c: Config, o: OnboardOpts, steps: Step[]) {
  const given: Record<string, string | undefined> = { access: o.access, domain: o.domain, host: o.host }
  for (const [k, v] of Object.entries(manifest.machine.vars)) {
    if (!when(v.when, c)) continue
    if (given[k]) { setPath(c, k, given[k]); continue }
    if (getPath(c, k) !== undefined) continue
    const def = v.default === '$(hostname -s)' ? run(['hostname', '-s']).out.trim() : v.default === '$HOME' ? HOME : v.default
    const val = o.yes ? def : ask(v.ask || k, def, v.choices)
    if (val === undefined) { if (v.ask) steps.push({ step: `var ${k}`, status: 'fail', detail: `needed: pass --${k}` }); continue }
    if (v.choices && !v.choices.includes(val)) { steps.push({ step: `var ${k}`, status: 'fail', detail: `${val} is not one of ${v.choices.join(', ')}` }); continue }
    setPath(c, k, val)
    steps.push({ step: `var ${k}`, status: 'fixed', detail: val })
  }
  saveConfig(c)
}

function pathLine(steps: Step[]) {
  const line = 'export PATH="$HOME/.mm/bin:$PATH"  # mm'
  for (const f of ['.profile', '.bashrc']) {
    const p = join(HOME, f)
    if (existsSync(p) && readFileSync(p, 'utf8').includes('.mm/bin')) continue
    appendFileSync(p, `\n${line}\n`)
    steps.push({ step: `PATH in ~/${f}`, status: 'fixed', detail: '~/.mm/bin first' })
  }
}

export async function onboard(o: OnboardOpts): Promise<{ steps: Step[]; checks: Check[] }> {
  const steps: Step[] = []
  const c = loadConfig()
  vars(c, o, steps)
  for (const d of [DIRS.mm, DIRS.bin, DIRS.tools, DIRS.pc, DIRS.projects]) if (!existsSync(d)) { mkdirSync(d, { recursive: true }); steps.push({ step: `dir ${d.replace(HOME, '~')}`, status: 'fixed', detail: 'created' }) }
  pathLine(steps)

  // tools: system packages in one go, then node, then the rest (npm needs node)
  const tools = Object.entries(manifest.machine.tools).filter(([, t]) => t.install && when(t.when, c))
  const missing = tools.filter(([n, t]) => checkTool(n, t, c).status === 'fail' || (checkTool(n, t, c).status === 'warn' && !t.optional))
  const pm = packageManager()
  const sys = missing.filter(([, t]) => t.install!.kind === 'system')
  if (sys.length) {
    try { steps.push({ step: 'system packages', status: 'fixed', detail: installSystem(sys.map(([, t]) => (t.install as { packages: Record<string, string> }).packages[pm ?? 'dnf'])) }) }
    catch (e) { steps.push({ step: 'system packages', status: 'fail', detail: String((e as Error).message) }) }
  }
  const order = (k: string) => (k === 'node-dist' ? 0 : k === 'npm' ? 2 : 1)
  for (const [name, t] of missing.filter(([, t]) => t.install!.kind !== 'system').sort((a, b) => order(a[1].install!.kind) - order(b[1].install!.kind))) {
    try { steps.push({ step: `tool ${name}`, status: 'fixed', detail: await install(name, t.install!) }) }
    catch (e) { steps.push({ step: `tool ${name}`, status: 'fail', detail: String((e as Error).message).slice(0, 200) }) }
  }

  try { steps.push({ step: 'process manager', status: 'ok', detail: await ensurePc() }) }
  catch (e) { steps.push({ step: 'process manager', status: 'fail', detail: String((e as Error).message) }) }

  return { steps, checks: doctor() }
}
