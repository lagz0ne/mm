// The board under live load (sy-jjcx): apply the event stream to the list in place (no refetch of the whole list per
// event), keep what did not change the same object (so memoized cards skip it), poll only while the tab is shown, and
// one shared clock for the "3m ago" labels (they re-render alone, not the board).
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { BeadEvent, Issue, Meta } from './api'

export interface Applied {
  issues: Issue[]
  /** the items the events touched */
  touched: Set<string>
  /** a status, a link, a new or a removed item: bd's ready list may have changed */
  readyStale: boolean
  /** items an event names that the list cannot be patched for (unknown, and the event carries no snapshot) */
  fetch: string[]
  /** the last comment per item, as the board server's /api/meta `last` counts it */
  last: Record<string, { author: string; at: string }>
}

const isSnapshot = (s: Partial<Issue> | undefined): s is Partial<Issue> & Pick<Issue, 'title' | 'status'> =>
  !!s && typeof s.title === 'string' && typeof s.status === 'string'
const READY_OPS = /^(create|created|close|closed|reopen|reopened|delete|deleted|dep|dependency)/

/** Patches the list with a batch of events. Items no event names keep their identity; an event that cannot be applied
 *  (an item the list does not hold, with no snapshot) is named in `fetch`. */
export function applyEvents(issues: Issue[], events: BeadEvent[]): Applied {
  const byId = new Map(issues.map((i) => [i.id, i]))
  const touched = new Set<string>(), fetch = new Set<string>(), added: string[] = []
  const last: Applied['last'] = {}
  let readyStale = false
  for (const ev of events) {
    const id = ev.issue_id
    if (!id) continue
    touched.add(id)
    if (READY_OPS.test(ev.op)) readyStale = true
    if (/^delete/.test(ev.op)) { byId.delete(id); fetch.delete(id); continue }
    const old = byId.get(id), snap = ev.issue
    if (ev.op === 'comment' && ev.comment) last[id] = { author: ev.comment.author, at: ev.comment.created_at || ev.ts }
    if (!old && !isSnapshot(snap)) { fetch.add(id); readyStale = true; continue }
    if (old && !snap && ev.op !== 'comment') { fetch.add(id); continue }
    const { comments: _c, ...fields } = (snap || {}) as Partial<Issue>
    const next = { ...old, ...fields, id } as Issue
    if (!fields.updated_at) next.updated_at = ev.ts || next.updated_at
    if (ev.op === 'comment') next.comment_count = Math.max(fields.comment_count ?? 0, (old?.comment_count ?? 0) + 1)
    if (!old) { added.push(id); readyStale = true }
    else if (old.status !== next.status || JSON.stringify(old.dependencies || []) !== JSON.stringify(next.dependencies || [])) readyStale = true
    byId.set(id, next)
  }
  const out: Issue[] = []
  for (const id of added) if (byId.has(id)) out.push(byId.get(id)!)
  for (const i of issues) if (byId.has(i.id)) out.push(byId.get(i.id)!)
  return { issues: out, touched, readyStale, fetch: [...fetch], last }
}

/** The new meta, sharing every part that did not change with the old one (the poll brings a new object each time). */
export function shareMeta(prev: Meta, next: Meta): Meta {
  if (JSON.stringify(prev) === JSON.stringify(next)) return prev
  const last: Meta['last'] = {}
  for (const [k, v] of Object.entries(next.last || {})) {
    const p = prev.last?.[k]
    last[k] = p && p.author === v.author && p.at === v.at ? p : v
  }
  return { ...next, last }
}

/** Runs `fn` now and every `ms` while the tab is shown; again at once when it is shown again after `ms` or more. */
export function useVisiblePoll(fn: () => void, ms: number, deps: unknown[] = []) {
  const f = useRef(fn)
  f.current = fn
  useEffect(() => {
    let t: number | undefined, lastRun = 0
    const run = () => { lastRun = Date.now(); f.current() }
    const start = () => { window.clearInterval(t); t = window.setInterval(run, ms) }
    const onVis = () => {
      if (document.hidden) { window.clearInterval(t); t = undefined; return }
      if (Date.now() - lastRun >= ms) run()
      start()
    }
    run()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps])
}

// One clock for every "ago" label: a tick every 15 s while the tab is shown; only its readers re-render.
let clock = Date.now()
const clockSubs = new Set<() => void>()
let clockTimer: number | undefined
function clockStart() {
  if (clockTimer !== undefined || typeof document === 'undefined' || document.hidden) return
  clock = Date.now()
  clockTimer = window.setInterval(() => { clock = Date.now(); clockSubs.forEach((f) => f()) }, 15000)
}
function clockStop() { window.clearInterval(clockTimer); clockTimer = undefined }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.hidden) clockStop()
  else if (clockSubs.size) { clock = Date.now(); clockSubs.forEach((f) => f()); clockStart() }
})
const clockSubscribe = (f: () => void) => {
  clockSubs.add(f); clockStart()
  return () => { clockSubs.delete(f); if (!clockSubs.size) clockStop() }
}
/** Now, as the shared clock last read it (re-renders the caller each tick). */
export const useNow = () => useSyncExternalStore(clockSubscribe, () => clock, () => clock)

/** The value as last rendered while it is equal (JSON) to the new one: memoized children see no change. */
export function useStable<T>(value: T): T {
  const key = JSON.stringify(value)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key])
}
