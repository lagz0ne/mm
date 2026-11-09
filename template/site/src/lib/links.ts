// An item's links on the board (sy-x7kh): hover a card (or long-press it on a phone) and the cards it is linked to by a
// bd dependency are marked: what it waits on (its blockers), what waits on it (its dependents), and its parent, children
// and other links (quiet). The rest dims a little. No fetch per hover: every item of the board's list (open and closed)
// carries its own outgoing edges (`dependencies`: depends_on_id, type) and how many items depend on it
// (`dependent_count`), so both directions come from the list the board already has.
import { useSyncExternalStore } from 'react'

import type { Issue } from './api'

/** How a card relates to the marked one: itself, one it waits on, one that waits on it, its family or another link. */
export type Rel = 'self' | 'blocker' | 'dependent' | 'parent' | 'child' | 'related' | 'dim' | ''

// Edges that hold an item back (bd ready honours these); parent-child is family; anything else is a plain link.
const WAITS = new Set(['blocks', 'conditional-blocks', 'waits-for'])
const typeOf = (d: NonNullable<Issue['dependencies']>[number]) => d.type || d.dependency_type || ''
const targetOf = (d: NonNullable<Issue['dependencies']>[number]) => d.depends_on_id || d.id || ''

interface Graph { rel: Map<string, Map<string, Rel>>; unknown: Map<string, number> }

/** For each item: every item linked to it and how (seen from it), and how many dependents the list does not hold. */
export function linkGraph(issues: Issue[]): Graph {
  const rel = new Map<string, Map<string, Rel>>()
  const add = (a: string, b: string, r: Rel) => {
    if (!a || !b || a === b) return
    let m = rel.get(a); if (!m) rel.set(a, (m = new Map()))
    // a stronger tie wins when two items are linked twice (waiting beats family beats a plain link)
    const rank = (x?: Rel) => (x === 'blocker' || x === 'dependent' ? 3 : x === 'parent' || x === 'child' ? 2 : x ? 1 : 0)
    if (rank(r) > rank(m.get(b))) m.set(b, r)
  }
  const incoming = new Map<string, number>() // known dependents (any link but parent-child), as dependent_count counts
  for (const i of issues) {
    for (const d of i.dependencies || []) {
      const t = typeOf(d), to = targetOf(d)
      if (!to) continue
      if (WAITS.has(t)) { add(i.id, to, 'blocker'); add(to, i.id, 'dependent') }
      else if (t === 'parent-child') { add(i.id, to, 'parent'); add(to, i.id, 'child') }
      else { add(i.id, to, 'related'); add(to, i.id, 'related') }
      if (t !== 'parent-child') incoming.set(to, (incoming.get(to) || 0) + 1)
    }
    if (i.parent) { add(i.id, i.parent, 'parent'); add(i.parent, i.id, 'child') }
  }
  // dependents outside the list (an old closed item past the Done list's page): known only by their count
  const unknown = new Map<string, number>()
  for (const i of issues) {
    const n = (i.dependent_count || 0) - (incoming.get(i.id) || 0)
    if (n > 0) unknown.set(i.id, n)
  }
  return { rel, unknown }
}

// One small store: the marked item (hovered, or long-pressed on a phone) and the graph. Each card subscribes to its own
// relation only, so moving between cards re-renders just the cards whose mark changes.
let graph: Graph = { rel: new Map(), unknown: new Map() }
let marked: string | null = null
let pinned = false // a long press on a phone: stays until the next tap
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function setLinkGraph(issues: Issue[]) { graph = linkGraph(issues); if (marked) emit() }
/** The mouse is over a card (or left it: null). A pinned mark (long press) is left alone. */
export function hoverLinks(id: string | null) { if (pinned || marked === id) return; marked = id; emit() }
/** A long press on a phone: marks the card's links until the next tap. */
export function pinLinks(id: string) { marked = id; pinned = true; emit() }
export function clearLinks() { if (!marked && !pinned) return; marked = null; pinned = false; emit() }
export const linksPinned = () => pinned

export function relOf(id: string): Rel {
  if (!marked) return ''
  if (id === marked) return 'self'
  return graph.rel.get(marked)?.get(id) || 'dim'
}
export const useLinkRel = (id: string) => useSyncExternalStore(subscribe, () => relOf(id), () => '' as Rel)
/** The marked item's id, for the tags ("blocks sy-1"). */
export const useMarked = () => useSyncExternalStore(subscribe, () => marked, () => null)

/** How many of the item's links have no card in sight: on another column or page, scrolled away, filtered out, or not
 *  in the list at all (counted from dependent_count). */
export function linksNotShown(id: string): number {
  const linked = [...(graph.rel.get(id)?.keys() || [])]
  const vw = window.innerWidth, vh = window.innerHeight
  let n = graph.unknown.get(id) || 0
  for (const other of linked) {
    const el = document.querySelector(`[data-card="${CSS.escape(other)}"]`)
    if (!el) { n++; continue }
    const r = el.getBoundingClientRect(), box = el.closest('main')?.getBoundingClientRect()
    const top = Math.max(0, box?.top ?? 0), bottom = Math.min(vh, box?.bottom ?? vh)
    const left = Math.max(0, box?.left ?? 0), right = Math.min(vw, box?.right ?? vw)
    if (r.width === 0 || r.bottom <= top || r.top >= bottom || r.right <= left || r.left >= right) n++
  }
  return n
}

/** The tag a marked card shows, read with the marked item's id (so color is never the only signal). */
export const REL_TAG: Partial<Record<Rel, string>> = {
  blocker: 'blocks', dependent: 'waits on', parent: 'parent of', child: 'child of', related: 'linked to',
}
