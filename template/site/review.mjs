// "To review" on the human's For you page (sy-c7mh): the items closed or handed over since a time, that carry an artifact
// or an owner card, newest first. Built from the board's event log (bd serve's events: each carries the item's snapshot)
// and the items as they are now.
//   closed   a close event, and the item is still closed
//   handed   an update whose snapshot names an assignee other than the one before it (the log's earlier snapshots say
//            who that was; an item with no earlier snapshot in the log is not counted: nobody knows it changed)
// Each entry: id, title (plain text, as the Waiting list), at (the event's time), kind, by (the event's actor), to (the
// new assignee, handed only), card (the owner card's fields, cardFields; null with no card), artifacts (the item's files,
// images first, at most ARTIFACTS_MAX). One entry per item: its latest such event. At most MAX entries; the rest counted.
// Pure: the board's server feeds it, test/board-for-you.mjs checks it.
import { cardFields, ID_RE, plainTitle } from './waiting.mjs'
import { parseCard } from '../bin/lib/owner-card.mjs'

export const MAX = 30
export const ARTIFACTS_MAX = 4
const IMG = /\.(png|jpg|webp)$/

/**
 * @param events     bd serve's event records, oldest first (seq, ts, op, issue_id, actor, issue: the snapshot)
 * @param items      the items as they are now (bd serve's list; closed ones may be missing)
 * @param artifacts  id -> [{ name, path, type }]
 * @param since      ms: only events after it
 * @returns { items: [...], more }
 */
export function toReview({ events, items = [], artifacts = {}, since }) {
  const now = new Map(items.filter((i) => i && typeof i.id === 'string').map((i) => [i.id, i]))
  const owner = new Map(), latest = new Map(), hit = new Map()
  for (const ev of events) {
    const id = ev?.issue_id, s = ev?.issue
    if (typeof id !== 'string' || !ID_RE.test(id)) continue
    if (s && typeof s === 'object' && typeof s.title === 'string') latest.set(id, s)
    const t = Date.parse(ev.ts)
    const was = owner.get(id), to = s && typeof s.assignee === 'string' ? s.assignee : undefined
    if (to !== undefined) owner.set(id, to)
    if (!(t > since)) continue
    if (ev.op === 'close') hit.set(id, { at: t, kind: 'closed', by: ev.actor || '' })
    else if (ev.op === 'update' && to && was !== undefined && was !== to) hit.set(id, { at: t, kind: 'handed', by: ev.actor || '', to })
    else if (ev.op === 'reopen' && hit.get(id)?.kind === 'closed') hit.delete(id)
  }
  const out = []
  for (const [id, h] of hit) {
    const i = now.get(id) || latest.get(id)
    if (!i || i.issue_type === 'epic') continue
    if (h.kind === 'closed' && i.status !== 'closed') continue
    const card = parseCard(i.description, Array.isArray(i.labels) ? i.labels : []).found ? cardFields(i.description, i.labels) : null
    const files = Array.isArray(artifacts[id]) ? artifacts[id] : []
    if (!card && !files.length) continue
    const sorted = [...files.filter((f) => IMG.test(f.name)), ...files.filter((f) => !IMG.test(f.name))]
    out.push({ id, title: plainTitle(i.title), at: new Date(h.at).toISOString(), kind: h.kind, by: h.by, ...(h.to ? { to: h.to } : {}),
      card, artifacts: sorted.slice(0, ARTIFACTS_MAX).map(({ name, path, type }) => ({ name, path, type })), files: files.length })
  }
  out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return { items: out.slice(0, MAX), more: Math.max(0, out.length - MAX) }
}
