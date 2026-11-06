// The board's Flow panel (sy-6h43): the same table as `mm obs flow`, from the same series. This is src/flow.ts's
// parseExport() and flowRows() in plain JS (the board has no TypeScript at run time); test/board-pull.mjs feeds both the
// same VictoriaMetrics export and checks the rows are equal, value for value. Change one, change the other.
// Pure: the board's server reads the export (server-side only) and calls these.

export const WINDOWS = { '24h': 24 * 3600e3, '7d': 7 * 86400e3 }
const NOW_WINDOW = 15 * 60e3 // a gauge (WIP, capacity, needs-you age) counts when it was sent this recently
/** Each speed metric and the quality metrics shown next to it (as src/flow.ts PAIRS). */
export const PAIRS = { queue: ['first_pass'], cycle: ['reopened', 'escaped'], handoff: ['first_pass'] }

/** Nearest rank: the smallest value with at least q of all the values at or below it. */
export function quantile(xs, q) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(q * s.length) - 1)]
}

/** Export JSON lines -> samples by metric name, one per series and timestamp (a sample sent twice is one). */
export function parseExport(text) {
  const seen = new Set(), out = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let s
    try { s = JSON.parse(line) } catch { continue }
    const { __name__: name, ...labels } = s.metric
    const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
    s.timestamps.forEach((t, i) => {
      const id = `${name}${key}@${t}`
      if (seen.has(id)) return
      seen.add(id)
      if (!out.has(name)) out.set(name, [])
      out.get(name).push({ labels, key, v: Number(s.values[i]), t: Number(t) })
    })
  }
  return out
}

/** The table: one row per project, role and window, from the samples, at `now`. */
export function flowRows(S, now) {
  const get = (name) => S.get(name) || []
  const inWin = (s, w) => s.t > now - w && s.t <= now
  const latest = (name, w, project, role, more = {}) => {
    const m = new Map()
    for (const s of get(name)) {
      if (s.labels.project !== project || s.labels.role !== role || !inWin(s, w) || Object.entries(more).some(([k, v]) => s.labels[k] !== v)) continue
      const o = m.get(s.key)
      if (!o || s.t > o.t) m.set(s.key, s)
    }
    return [...m.values()].map((s) => s.v)
  }
  const count = (name, w, project, role) => get(name).filter((s) => s.labels.project === project && s.labels.role === role && inWin(s, w)).length
  const pairs = new Map()
  for (const list of S.values()) for (const s of list) if (s.labels.project && s.labels.role) pairs.set(`${s.labels.project}\0${s.labels.role}`, [s.labels.project, s.labels.role])
  const rows = []
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
  const ranges = []
  const projects = new Set([...pairs.values()].map(([p]) => p))
  for (const s of get('mm_flow_journal_last_seq')) projects.add(s.labels.project)
  for (const project of [...projects].sort()) {
    const last = (name) => { let b = null; for (const s of get(name)) if (s.labels.project === project && s.t <= now && (!b || s.t > b.t)) b = s; return b ? b.v : null }
    const iso = (sec) => (sec === null ? null : new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z'))
    ranges.push({ project, first_seq: last('mm_flow_journal_first_seq'), last_seq: last('mm_flow_journal_last_seq'), first: iso(last('mm_flow_journal_first_time')), last: iso(last('mm_flow_journal_last_time')) })
  }
  return { rows, ranges }
}

/** The export's time range and selector for one project's flow series (as src/flow.ts exportFlow). */
export function exportQuery(project, now) {
  const sel = `{__name__=~"mm_flow_.+",project=${JSON.stringify(project)}}`
  return new URLSearchParams({ 'match[]': sel, start: String(Math.floor((now - WINDOWS['7d'] - 3600e3) / 1000)), end: String(Math.ceil(now / 1000)) })
}
