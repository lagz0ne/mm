// What the board says about a lead (sy-809m). Leads are on demand: wake starts one when a request waits for it and
// closes it when idle, so "offline" means nothing to a human and is never shown. A lead is:
//   working   "working on <item>"   its agent is in a turn (the item: what it touched last, else what wake handed it)
//   error     "start failed"        wake could not start it for a waiting item (bin/wake's startError), no agent up
//   waiting   "waiting for you"     an open item of its own is labelled needs-you
//   blocked   "blocked"             an open item of its own is blocked, or its last comment there is a BLOCKED line
//   ready     "ready"               everything else, with or without an agent
// Pure: the board's server feeds it (site/server.mjs), test/lead-state.mjs checks it.

import { parseSignal } from '../bin/lib/signals.mjs'
/** A comment's typed end signal kind (bin/lib/signals.mjs), or null. */
export const signalOf = (text) => parseSignal(text)?.kind || null

/**
 * @param role     the role id
 * @param agent    its Paseo agent ({ status }) or null
 * @param wake     its entry in .wake-state.json ({ items, at, startError }) or undefined
 * @param items    the board's items (any status; only this role's open ones count)
 * @param lastAct  { item, at } the role's latest board action, or undefined
 * @param last     item id -> { author, signal } of its latest comment
 */
export function leadState({ role, agent, wake, items = [], lastAct, last = {} }) {
  if (agent && agent.status === 'running') {
    const item = lastAct && (!wake?.at || lastAct.at >= wake.at) ? lastAct.item : wake?.items?.[0] || lastAct?.item || null
    return { state: 'working', label: item ? `working on ${item}` : 'working', item }
  }
  if (wake?.startError && (!agent || agent.status === 'closed')) {
    return { state: 'error', label: 'start failed', item: wake.startError.items?.[0] || null, error: wake.startError.error || '' }
  }
  const own = items.filter((i) => i && i.assignee === role && i.status !== 'closed')
  const wait = own.find((i) => (i.labels || []).includes('needs-you'))
  if (wait) return { state: 'waiting', label: 'waiting for you', item: wait.id }
  const blocked = own.find((i) => i.status === 'blocked' || (last[i.id]?.author === role && last[i.id]?.signal === 'BLOCKED'))
  if (blocked) return { state: 'blocked', label: 'blocked', item: blocked.id }
  return { state: 'ready', label: 'ready', item: null }
}
