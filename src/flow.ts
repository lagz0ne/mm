// mm obs flow / mm obs item: the boards' flow, read back from what each board's bin/flow sent (sy-o9w5). The numbers are
// computed here from the raw samples (VictoriaMetrics' export), so a value is exact and a sample sent twice counts once.
// The stores are a cache of the boards' event journals: the output names the event range each project's values come from.
import { obsPorts, tracesql } from './obs'

export const WINDOWS: Record<string, number> = { '24h': 24 * 3600e3, '7d': 7 * 86400e3 }
const NOW_WINDOW = 15 * 60e3 // a gauge (WIP, capacity, needs-you age) counts when it was sent this recently
/** Each speed metric and the quality metrics shown next to it (sy-d98 rule 2; a test checks the table has them all). */
export const PAIRS: Record<string, string[]> = { queue: ['first_pass'], cycle: ['reopened', 'escaped'], handoff: ['first_pass'] }

type Sample = { labels: Record<string, string>; key: string; v: number; t: number }
export type Samples = Map<string, Sample[]> // by metric name
export type FlowRow = {
  project: string; role: string; window: string; done: number
  queue_p50: number | null; queue_p95: number | null; first_pass: number | null; reviewed: number
  cycle_p50: number | null; cycle_p95: number | null; paused_p50: number | null; reopened: number; escaped: number
  handoff_p50: number | null; handoff_p95: number | null
  wip: number | null; capacity: number | null; leases_expired: number; needs_you: number; needs_you_max: number | null
}
export type FlowRange = { project: string; first_seq: number | null; last_seq: number | null; first: string | null; last: string | null }

/** Nearest rank: the smallest value with at least q of all the values at or below it. */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]
}

/** Export JSON lines -> samples by metric name, one per series and timestamp (a sample sent twice is one). */
export function parseExport(text: string): Samples {
  const seen = new Set<string>(), out: Samples = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let s: { metric: Record<string, string>; values: number[]; timestamps: number[] }
    try { s = JSON.parse(line) } catch { continue }
    const { __name__: name, ...labels } = s.metric
    const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
    s.timestamps.forEach((t, i) => {
      const id = `${name}${key}@${t}`
      if (seen.has(id)) return
      seen.add(id)
      if (!out.has(name)) out.set(name, [])
      out.get(name)!.push({ labels, key, v: Number(s.values[i]), t: Number(t) })
    })
  }
  return out
}

/** The table: one row per project, role and window, from the samples, at `now`. */
export function flowRows(S: Samples, now: number): { rows: FlowRow[]; ranges: FlowRange[] } {
  const get = (name: string) => S.get(name) || []
  const inWin = (s: Sample, w: number) => s.t > now - w && s.t <= now
  /** the latest sample per series in the window, for one project and role (and more labels) */
  const latest = (name: string, w: number, project: string, role: string, more: Record<string, string> = {}) => {
    const m = new Map<string, Sample>()
    for (const s of get(name)) {
      if (s.labels.project !== project || s.labels.role !== role || !inWin(s, w) || Object.entries(more).some(([k, v]) => s.labels[k] !== v)) continue
      const o = m.get(s.key)
      if (!o || s.t > o.t) m.set(s.key, s)
    }
    return [...m.values()].map((s) => s.v)
  }
  const count = (name: string, w: number, project: string, role: string) => get(name).filter((s) => s.labels.project === project && s.labels.role === role && inWin(s, w)).length
  const pairs = new Map<string, [string, string]>()
  for (const list of S.values()) for (const s of list) if (s.labels.project && s.labels.role) pairs.set(`${s.labels.project}\0${s.labels.role}`, [s.labels.project, s.labels.role])
  const rows: FlowRow[] = []
  for (const [project, role] of [...pairs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))) {
    for (const [window, w] of Object.entries(WINDOWS)) {
      const queue = latest('mm_flow_queue_wait_seconds', w, project, role), cycle = latest('mm_flow_cycle_seconds', w, project, role)
      const handoff = latest('mm_flow_handoff_wait_seconds', w, project, role), pass = latest('mm_flow_review_first_pass', w, project, role)
      const paused = latest('mm_flow_paused_seconds', w, project, role, { rail: 'all' })
      const wip = latest('mm_flow_wip', NOW_WINDOW, project, role), cap = latest('mm_flow_capacity', NOW_WINDOW, project, role)
      const ny = latest('mm_flow_needs_you_age_seconds', NOW_WINDOW, project, role)
      rows.push({ project, role, window, done: cycle.length,
        queue_p50: quantile(queue, 0.5), queue_p95: quantile(queue, 0.95), first_pass: pass.length ? pass.reduce((a, b) => a + b, 0) / pass.length : null, reviewed: pass.length,
        cycle_p50: quantile(cycle, 0.5), cycle_p95: quantile(cycle, 0.95), paused_p50: quantile(paused, 0.5),
        reopened: count('mm_flow_reopened_total', w, project, role), escaped: count('mm_flow_escaped_total', w, project, role),
        handoff_p50: quantile(handoff, 0.5), handoff_p95: quantile(handoff, 0.95),
        wip: wip.length ? wip[0] : null, capacity: cap.length ? cap[0] : null, leases_expired: count('mm_flow_lease_expired_total', w, project, role),
        needs_you: ny.length, needs_you_max: ny.length ? Math.max(...ny) : null })
    }
  }
  const ranges: FlowRange[] = []
  const projects = new Set([...pairs.values()].map(([p]) => p))
  for (const s of get('mm_flow_journal_last_seq')) projects.add(s.labels.project)
  for (const project of [...projects].sort()) {
    const last = (name: string) => { let b: Sample | null = null; for (const s of get(name)) if (s.labels.project === project && s.t <= now && (!b || s.t > b.t)) b = s; return b ? b.v : null }
    const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z'))
    ranges.push({ project, first_seq: last('mm_flow_journal_first_seq'), last_seq: last('mm_flow_journal_last_seq'), first: iso(last('mm_flow_journal_first_time')), last: iso(last('mm_flow_journal_last_time')) })
  }
  return { rows, ranges }
}

/** 3700 -> "1h01m"; null -> "-". */
export function dur(sec: number | null): string {
  if (sec === null) return '-'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86400)}d${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`
}
/** A row for people: speed next to its quality pair (PAIRS), durations short. */
export function tableRow(r: FlowRow): Record<string, string | number> {
  const pct = r.first_pass === null ? '-' : `${Math.round(r.first_pass * 100)}% of ${r.reviewed}`
  return { project: r.project, role: r.role, window: r.window, done: r.done,
    queue_p50: dur(r.queue_p50), queue_p95: dur(r.queue_p95), first_pass: pct,
    cycle_p50: dur(r.cycle_p50), cycle_p95: dur(r.cycle_p95), reopened: r.reopened, escaped: r.escaped, paused_p50: dur(r.paused_p50),
    handoff_p50: dur(r.handoff_p50), handoff_p95: dur(r.handoff_p95),
    wip: r.wip ?? '-', capacity: r.capacity ?? '-', leases_expired: r.leases_expired, needs_you: r.needs_you ? `${r.needs_you} (oldest ${dur(r.needs_you_max)})` : 0 }
}

/** The raw flow samples of the last 7 days (and the gauges), for one project or all. */
export async function exportFlow(project: string | undefined, now: number): Promise<Samples> {
  const { metrics } = obsPorts()
  const sel = `{__name__=~"mm_flow_.+"${project ? `,project=${JSON.stringify(project)}` : ''}}`
  const q = new URLSearchParams({ 'match[]': sel, start: String(Math.floor((now - WINDOWS['7d'] - 3600e3) / 1000)), end: String(Math.ceil(now / 1000)) })
  const r = await fetch(`http://127.0.0.1:${metrics}/api/v1/export?${q}`, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`VictoriaMetrics: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return parseExport(await r.text())
}

export type ItemSpan = { kind: string; role: string; from: string; to: string; seconds: number; priority: string; project: string; span_id: string }
/** One item's path: its spans (sent again by a rebuild: one per span id, the longest), in time order, the item first. */
export async function itemPath(id: string, project?: string): Promise<ItemSpan[]> {
  const q = `_time:15d "span_attr:item":=${JSON.stringify(id)} "span_attr:kind":*${project ? ` "resource_attr:service.namespace":=${JSON.stringify(project)}` : ''}`
  const rows = await tracesql(q, 2000)
  return pathOf(rows)
}
export function pathOf(rows: Record<string, string>[]): ItemSpan[] {
  const by = new Map<string, ItemSpan & { s: number; e: number }>()
  const iso = (ns: string) => new Date(Number(BigInt(ns || '0') / 1000000n)).toISOString().replace(/\.\d+Z$/, 'Z')
  for (const r of rows) {
    const s = Number(BigInt(r.start_time_unix_nano || '0') / 1000000n), e = Number(BigInt(r.end_time_unix_nano || '0') / 1000000n)
    const x = { kind: r['span_attr:kind'] || String(r.name || '').replace(/^flow /, ''), role: r['span_attr:role'] || '', from: iso(r.start_time_unix_nano), to: iso(r.end_time_unix_nano),
      seconds: Math.round((e - s) / 1000), priority: r['span_attr:priority'] ?? '', project: r['resource_attr:service.namespace'] || '', span_id: r.span_id || `${r.name}@${s}`, s, e }
    const o = by.get(x.span_id)
    if (!o || x.e - x.s > o.e - o.s) by.set(x.span_id, x)
  }
  return [...by.values()].sort((a, b) => (a.kind === 'item' ? -1 : 0) - (b.kind === 'item' ? -1 : 0) || a.s - b.s || a.e - b.e || a.kind.localeCompare(b.kind)).map(({ s: _s, e: _e, ...x }) => x)
}
