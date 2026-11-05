// mm cron: the machine's one scheduler (process-compose has none). Runs every project's `schedules` from its
// .run/services.json (written by `mm up`): `every: 1m | 30s | 2h | "daily HH:MM"` (local time). One run of a job at a
// time; each run is a line in <root>/.run/logs/cron.log (shipped to VictoriaLogs) and its own trace (the job's
// engine script reports to it). State: ~/.mm/data/cron.json (last start per project/job). A project box's jobs
// (~/.mm/pc/boxes) run in its box, as the box user; its backup then lands outside the box (box.ts landBackup).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, HOME, toolPath } from './env'
import { hostDir, jobArgs, landBackup } from './box'
import { resolve } from './project'

const STATE = join(DIRS.mm, 'data', 'cron.json')
type Job = { project: string; root: string; name: string; every: string; command: string; box: boolean }

export function parseEvery(every: string): { ms: number } | { daily: [number, number] } | null {
  const m = /^(\d+)\s*(s|m|h)$/.exec(every.trim())
  if (m) return { ms: Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3 }[m[2] as 's' | 'm' | 'h'] }
  const d = /^daily\s+(\d{1,2}):(\d{2})$/.exec(every.trim())
  return d ? { daily: [Number(d[1]), Number(d[2])] } : null
}
/** Is the job due at `now`, given when it last started? */
export function due(every: string, last: number | undefined, now = Date.now()): boolean {
  const e = parseEvery(every)
  if (!e) return false
  if ('ms' in e) return last === undefined || now - last >= e.ms - 1000
  const slot = new Date(now); slot.setHours(e.daily[0], e.daily[1], 0, 0)
  return now >= slot.getTime() && (last ?? now) < slot.getTime()
}

function jobs(): Job[] {
  const out: Job[] = []
  for (const [pdir, box] of [[join(DIRS.pc, 'projects'), false], [join(DIRS.pc, 'boxes'), true]] as const) for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith('.yaml')) : []) {
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(pdir, f), 'utf8'))
    if (!m) continue
    const root = m[1].replace(/^~(?=\/)/, HOME)
    try {
      // a box's jobs from its services.yaml (read-only in the box), never from a file the box can write
      const s = (box ? (() => { const r = resolve(root); return { project: r.answers.project, schedules: r.schedules } })()
        : JSON.parse(readFileSync(join(root, '.run', 'services.json'), 'utf8'))) as { project: string; schedules?: Record<string, { every: string; command: string }> }
      for (const [name, j] of Object.entries(s.schedules || {})) if (j?.every && j?.command) out.push({ project: s.project, root, name, every: j.every, command: j.command, box })
    } catch {}
  }
  return out
}

export async function cron(tickMs = 10_000) {
  let st: Record<string, number> = {}
  try { st = JSON.parse(readFileSync(STATE, 'utf8')) } catch {}
  mkdirSync(join(DIRS.mm, 'data'), { recursive: true })
  const running = new Set<string>()
  const first = new Set<string>()
  for (;;) {
    const now = Date.now()
    for (const j of jobs()) {
      const key = `${j.project}/${j.name}`
      // a daily job never seen before waits for its next slot instead of running at once
      if (st[key] === undefined && !first.has(key)) { first.add(key); const e = parseEvery(j.every); if (e && 'daily' in e) st[key] = now }
      if (running.has(key) || !due(j.every, st[key], now)) continue
      st[key] = now; running.add(key)
      runJob(j).then(() => running.delete(key))
    }
    try { writeFileSync(STATE, JSON.stringify(st)) } catch {}
    await Bun.sleep(tickMs)
  }
}

/** One run of a job: its line in <root>/.run/logs/cron.log. Resolves to the exit code and the output's tail. */
async function runJob(j: Job): Promise<{ code: number; tail: string }> {
  // a box's cron log is the host's (the host appends to it; in the project folder the box could make it a symlink)
  const t0 = Date.now(), log = j.box ? join(hostDir(j.project), 'cron.log') : join(j.root, '.run', 'logs', 'cron.log')
  const jenv = { MM_PROJECT: j.project, TRACEPARENT: '' }
  const p = Bun.spawn(j.box ? jobArgs(j.root, j.name, j.command, jenv) : ['sh', '-c', j.command], { cwd: j.root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    env: { ...process.env, PATH: toolPath(), ...jenv } })
  const limit = setTimeout(() => p.kill(), j.name === 'backup' ? 30 * 60e3 : 5 * 60e3)
  let [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(limit)
  if (j.box && j.name === 'backup' && code === 0) try { out += `\nlanded ${landBackup(j.root)}` } catch (e) { code = 1; err += `\n${(e as Error).message}` }
  const tail = `${out}${err}`.trim().split('\n').slice(-5).join(' | ').slice(0, 1000)
  try {
    mkdirSync(join(log, '..'), { recursive: true })
    appendFileSync(log, JSON.stringify({ time: new Date().toISOString(), level: code ? 'error' : 'info', msg: `${j.name} ${code ? `failed (exit ${code})` : 'ok'}${tail ? `: ${tail}` : ''}`,
      project: j.project, service: `cron`, job: j.name, exit_code: code, duration_ms: Date.now() - t0 }) + '\n')
  } catch {}
  return { code, tail }
}

/** `mm cron --run <project>/<job>`: run one job now, once, as the scheduler would (logged the same way). */
export async function runOnce(ref: string): Promise<number> {
  const [project, name] = ref.split('/')
  const j = jobs().find((x) => x.project === project && x.name === name)
  if (!j) { console.error(`mm cron: no job ${ref} (jobs: ${jobs().map((x) => `${x.project}/${x.name}`).join(', ') || 'none'})`); return 2 }
  const r = await runJob(j)
  console.log(`${ref} ${r.code ? `failed (exit ${r.code})` : 'ok'}${r.tail ? `: ${r.tail}` : ''}`)
  return r.code
}
