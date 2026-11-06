// What the Leads page shows of the pull model (sy-6h43, from sy-5582's bin/wake): per role its queue, its work in
// progress against its capacity, each claim's lease, and the workers running. It reads the board the way wake does:
//   queue     the ready items (bd ready, in its order: what wake hands next) assigned to the role, open, not needs-you
//   claims    the items in progress of the role or of its workers (assignee `<role>` or `<role>/...`)
//   capacity  roles.json `capacity` (default 1); setup has none (wake never holds it back)
//   lease     a claim's age is the time since its last update (any comment or change renews it); wake requeues it after
//             30 min (WAKE_LEASE_MS) unless the lead is in a turn. ok under 25 min, `near` from 25, `over` from 30 (expired,
//             not yet requeued), and a requeued item (an update by wake from in_progress to open, with wake's comment
//             "Requeued ... expiry n of 3") is `requeued` in the queue until it is claimed again.
//   workers   Paseo agents of this project that are workers (server.mjs finds them), with their item
// Pure: the board's server feeds it, test/board-pull.mjs checks it.

export const LEASE_MS = 30 * 60e3
export const NEAR_MS = 25 * 60e3

export const mineOf = (role, i) => i.assignee === role || String(i.assignee || '').startsWith(`${role}/`)
export function leaseOf(ageMs) { return ageMs >= LEASE_MS ? 'over' : ageMs >= NEAR_MS ? 'near' : 'ok' }

/**
 * @param roles     role ids (leads/roles.json order), setup last
 * @param capacity  role -> roles.json `capacity` (whole numbers > 0)
 * @param items     every item on the board (any status)
 * @param ready     bd ready's list, in its order
 * @param requeues  item id -> { at, n, of } from the event journal (requeued by wake, not claimed since)
 * @param workers   [{ id, name, status, role, item }]
 * @param now       ms
 */
export function pullState({ roles, capacity = {}, items = [], ready = [], requeues = {}, workers = [], now = Date.now() }) {
  const sec = (ms) => Math.max(0, Math.round(ms / 1000))
  return roles.map((role) => {
    const queue = ready.filter((i) => i && i.assignee === role && i.status === 'open' && !(i.labels || []).includes('needs-you')).map((i) => {
      const t = Date.parse(i.updated_at || '') || now, rq = requeues[i.id]
      return { id: i.id, title: String(i.title || ''), priority: i.priority ?? null, updated_at: i.updated_at || null, wait_s: sec(now - t), ...(rq ? { requeued: rq } : {}) }
    })
    const claims = items.filter((i) => i && i.status === 'in_progress' && mineOf(role, i)).map((i) => {
      const t = Date.parse(i.updated_at || '') || now, age = now - t
      return { id: i.id, title: String(i.title || ''), priority: i.priority ?? null, assignee: i.assignee, updated_at: i.updated_at || null,
        age_s: sec(age), lease: role === 'setup' ? 'ok' : leaseOf(age), left_s: role === 'setup' ? null : sec(LEASE_MS - age) }
    }).sort((a, b) => b.age_s - a.age_s)
    const cap = role === 'setup' ? null : Number.isInteger(capacity[role]) && capacity[role] > 0 ? capacity[role] : 1
    return { role, capacity: cap, wip: claims.length, claims, queue, requeued: queue.filter((q) => q.requeued).length,
      workers: workers.filter((w) => w.role === role).map(({ id, name, status, item }) => ({ id, name: name || null, status, item: item || null })) }
  })
}

/** Folds journal records into the requeue marks: `marks` (item id -> { at, n, of }); `seen` (item id -> { st, as }, its
 *  status and assignee as of the last record) is the fold's own memory. A mark goes when the item is claimed again,
 *  closed, blocked or handed to someone else. */
export function foldRequeues(marks, seen, recs) {
  for (const e of recs) {
    const id = e.issue_id, was = seen[id], st = e.issue?.status
    if (e.op === 'comment' && e.actor === 'wake' && marks[id]) {
      const m = /^Requeued:[\s\S]*?expiry (\d+) of (\d+)/.exec(e.comment?.text || '')
      if (m) marks[id] = { ...marks[id], n: Number(m[1]), of: Number(m[2]) }
    }
    if (!st) continue
    const as = e.issue.assignee || ''
    if (e.actor === 'wake' && was?.st === 'in_progress' && st === 'open') marks[id] = { at: e.ts, n: null, of: null }
    else if (st !== 'open' || (was && as !== was.as)) delete marks[id]
    seen[id] = { st, as }
  }
}
