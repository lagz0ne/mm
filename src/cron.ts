// mm cron: the machine's one scheduler (process-compose has none). Runs every project's `schedules` from its
// .run/services.json (written by `mm up`): `every: 1m | 30s | 2h | "daily HH:MM"` (local time). One run of a job at a
// time; each run is a line in <root>/.run/logs/cron.log (shipped to VictoriaLogs) and its own trace (the job's
// engine script reports to it). State: ~/.mm/data/cron.json (last start per project/job).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, HOME, toolPath } from './env'

const STATE = join(DIRS.mm, 'data', 'cron.json')
type Job = { project: string; root: string; name: string; every: string; command: string }

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
  const out: Job[] = [], pdir = join(DIRS.pc, 'projects')
  for (const f of existsSync(pdir) ? readdirSync(pdir).filter((x) => x.endsWith('.yaml')) : []) {
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(pdir, f), 'utf8'))
    if (!m) continue
    const root = m[1].replace(/^~(?=\/)/, HOME)
    try {
      const s = JSON.parse(readFileSync(join(root, '.run', 'services.json'), 'utf8')) as { project: string; schedules?: Record<string, { every: string; command: string }> }
      for (const [name, j] of Object.entries(s.schedules || {})) if (j?.every && j?.command) out.push({ project: s.project, root, name, every: j.every, command: j.command })
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
      const t0 = Date.now(), log = join(j.root, '.run', 'logs', 'cron.log')
      const p = Bun.spawn(['sh', '-c', j.command], { cwd: j.root, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
        env: { ...process.env, PATH: toolPath(), MM_PROJECT: j.project, TRACEPARENT: '' } })
      const limit = setTimeout(() => p.kill(), j.name === 'backup' ? 30 * 60e3 : 5 * 60e3)
      Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => {
        clearTimeout(limit); running.delete(key)
        const tail = `${out}${err}`.trim().split('\n').slice(-5).join(' | ').slice(0, 1000)
        try {
          mkdirSync(join(j.root, '.run', 'logs'), { recursive: true })
          appendFileSync(log, JSON.stringify({ time: new Date().toISOString(), level: code ? 'error' : 'info', msg: `${j.name} ${code ? `failed (exit ${code})` : 'ok'}${tail ? `: ${tail}` : ''}`,
            project: j.project, service: `cron`, job: j.name, exit_code: code, duration_ms: Date.now() - t0 }) + '\n')
        } catch {}
      })
    }
    try { writeFileSync(STATE, JSON.stringify(st)) } catch {}
    await Bun.sleep(tickMs)
  }
}
