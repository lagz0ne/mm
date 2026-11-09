// Flow observability (plans/slp "Measure", sy-o9w5): the board's event journal (bd serve /v0/beads/events) folded into
// one trace per item and flow metrics per project and role. Pure: no I/O here (bin/flow reads the journal and sends).
//
// Only the journal counts (sy-d98 rules). An item's state is the `issue` snapshot of its last event; a label counts
// only through the event that added it, with that event's actor; signals are bd state changes (sy-qudz #11), never
// comment lines: a handoff is a reassign, DONE a close, BLOCKED status blocked, DEPENDENCY a dep add, REOPEN a reopen.
// The one comment text read is review's own verdict "not signed off" (in words, a text VERDICT, or an mm-message v1
// VERDICT block; the reviewer, not the measured role). No series
// carries a person: `role` is always a lead role (roles.json), and an item assigned to a person gives no sample.
//
// The metrics (each sample is per item, stamped with the time of the event that ends it, so a rebuild from the same
// events sends the same samples; quality metrics are paired with speed ones in `mm obs flow`):
//   mm_flow_queue_wait_seconds{role,item}    ready -> claimed (status in_progress). Ready = open, assigned to a role,
//                                            no open `blocks` dependency. Minus the needs-you and approval rails.
//   mm_flow_cycle_seconds{role,item}         claimed -> done (close), the role that claimed; minus every rail.
//   mm_flow_paused_seconds{role,item,rail}   the time the cycle left out: rail = all | needs-you | sign-off | approval.
//   mm_flow_handoff_wait_seconds{role,item}  a reassign from one role to another (by anyone not of the new role) -> the
//                                            first event by the new role on the item; minus the needs-you and approval rails.
//   mm_flow_review_first_pass{role,item}     1: review's first verdict of the round is `signed-off` (a label event whose
//                                            actor is review); 0: it is a "not signed off" comment by review. role = the
//                                            role that handed the item to review.
//   mm_flow_reopened_total{role,item}        n-th reopen (closed -> not closed), role = the role whose round closed it.
//   mm_flow_escaped_total{role,item}         n-th bug filed against the item after it landed (a bug's dependency on the
//                                            closed item, any kind but parent-child), role = the role that closed it.
//   mm_flow_lease_expired_total{role,item}   n-th requeue by the system (in_progress -> open by wake/watchdog). The lease
//                                            dispatcher is sy-5582: until it exists, nothing is sent.
//   now (gauges): mm_flow_wip{role} (items in progress), mm_flow_capacity{role} (roles.json `capacity`, once sy-5582
//   adds it; nothing until then), mm_flow_needs_you_age_seconds{role,item} (a state, "waiting on the owner": the time
//   with needs-you, the clock paused while a t2 waits for the owner's approval), mm_flow_journal_{first,last}_{seq,time}
//   (the event range the values come from).
// The rails (sy-d98 rule 1; railsOf, shared with stalled-work checks): needs-you (label on), sign-off (assigned to review
// after another role handed it over, review's signed-off not there yet), approval (t2, signed off by review, the
// approver's `approved` not there yet). Every speed metric leaves them out; the paused time is its own series.
// The traces: trace id = sha256(<project>/<item>); a root span `flow item` (created -> done, sent at each close) and one
// span per segment (queued, worked, review, blocked), handoff, rail (needs-you, sign-off, approval) and point (done,
// reopened), each sent when it ends. Attributes: item, role, kind, priority; never a title, a text or a person.
// An item first seen mid-life (its creation was pruned from the journal) has no start times: its open segments, rails,
// round and review verdict give nothing until it closes (rounds) or reopens (verdicts).
import { createHash } from 'node:crypto'
import { messageKeys, readBlock } from './structured.mjs'

export const RAILS = ['needs-you', 'sign-off', 'approval']
export const SYSTEM = new Set(['wake', 'watchdog', 'ui', 'smoke', 'beads', 'mm-upstream', 'brain']) // brain: ops' actor before 2026-11-05 (sy-u43j)
// a verdict that does not sign off: the words, or a VERDICT message's "Result: blocked" (sy-0gsw)
const NOT_SIGNED = /\bnot signed[ -]off\b|^Result:[ \t]*blocked\b/im
/** A comment that is a verdict not signing off: the words or a text VERDICT's Result (NOT_SIGNED), or a mm-message v1
 * block whose result reads the same (sy-wx71: messageKeys gives it the key a text VERDICT has). The block's schema is
 * not checked here: the gate checked it when it was written. */
export function notSignedOff(text) {
  const s = String(text ?? '')
  if (NOT_SIGNED.test(s)) return true
  const b = readBlock(s)
  return b?.kind === 'message' && !!b.data && messageKeys(b.data).keys.Result === 'blocked'
}
const h = (s, n) => createHash('sha256').update(s).digest('hex').slice(0, n)
export const traceIdOf = (project, id) => h(`${project}/${id}`, 32)
const rootIdOf = (project, id) => h(`${project}/${id}/root`, 16)

/** Which rails hold the item now (sy-d98 rule 1): a list of RAILS names. `it`: { st, as, labels, from, signed, approved }
 *  (from = the role that handed it to the reviewer; signed/approved = set by the label events of review/the approver). */
export function railsOf(it, reviewer = 'review') {
  if (it.st === 'closed') return []
  const out = []
  if (it.labels.includes('needs-you')) out.push('needs-you')
  if (it.as === reviewer && it.from && !it.signed) out.push('sign-off')
  if (it.labels.includes('t2') && it.signed && !it.approved) out.push('approval')
  return out
}

/**
 * A folder of journal records. opts: { project, roles: [ids], reviewer = 'review', approvers = ['bridge'] }.
 * opts.ledger (sy-1jmi, the ledger switched on): (item) => whether the signed ledger approves it; then that alone counts,
 * never the actor who added the label.
 * fold(records) -> { samples, spans }: what those records completed (send them); state() is what to keep (JSON).
 */
export function createFlow(saved, opts) {
  const P = opts.project, ROLES = new Set(opts.roles), REVIEWER = opts.reviewer || 'review', APPROVERS = new Set(opts.approvers || ['bridge'])
  const S = saved && saved.items ? saved : { seq: 0, first: null, last: null, items: {}, deps: {} }
  const roleOf = (actor) => { const a = String(actor || ''), r = a.split('/')[0]; return ROLES.has(r) && (a === r || a.startsWith(`${r}/`)) ? r : null }
  const isRole = (r) => !!r && ROLES.has(r)
  let samples = [], spans = []
  const sample = (name, labels, value, t) => samples.push({ name, labels: { project: P, ...labels }, value, t })
  const span = (it, id, kind, role, start, end, seq) => spans.push({ traceId: traceIdOf(P, id),
    spanId: kind === 'item' ? rootIdOf(P, id) : h(`${P}/${id}/${kind}/${seq}`, 16), parentSpanId: kind === 'item' ? '' : rootIdOf(P, id),
    name: `flow ${kind}`, start, end, attrs: { item: id, role: role || '', kind, priority: it.pr ?? '' } })

  // the time each rail held the item so far, and the unions the metrics subtract; advanced to `t` before any change
  function advance(it, t) {
    const dt = Math.max(0, t - it.t), on = railsOf(it, REVIEWER), c = it.cum
    if (dt && on.length) {
      for (const r of on) c[r] += dt
      c.any += dt
      if (on.includes('needs-you') || on.includes('approval')) c.soft += dt
      if (on.includes('needs-you') && !on.includes('approval')) c.ny += dt
    }
    it.t = Math.max(it.t, t)
  }
  const blockedByDeps = (it) => (it.blockers || []).some((b) => S.items[b] && S.items[b].st !== 'closed')
  function segKind(it) {
    if (it.st === 'closed') return null
    if (it.st === 'blocked' || blockedByDeps(it)) return 'blocked'
    if (it.st === 'open') return isRole(it.as) ? 'queued' : null
    if (it.st === 'in_progress') return it.as === REVIEWER && it.from ? 'review' : 'worked'
    return null
  }
  // the item's segment (queued, worked, review, blocked) and its rail spans, after a change at `t` (record `seq`)
  function settle(it, id, t, seq) {
    const kind = segKind(it), role = isRole(it.as) ? it.as : ''
    if (!it.seg || it.seg.kind !== kind || it.seg.role !== role) {
      if (it.seg && it.seg.kind && it.seg.t != null) span(it, id, it.seg.kind, it.seg.role, it.seg.t, t, it.seg.seq)
      it.seg = { kind, role, t, seq }
      if (kind === 'queued') it.ready = { t, soft: it.cum.soft, role }
      else it.ready = null
    }
    const on = new Set(railsOf(it, REVIEWER))
    for (const r of RAILS) {
      if (on.has(r) && !it.rail[r]) it.rail[r] = { t, seq, role: role || it.lastRole || '' } // the role it holds: the assignee then
      else if (!on.has(r) && it.rail[r]) { if (it.rail[r].t != null) span(it, id, r, it.rail[r].role, it.rail[r].t, t, it.rail[r].seq); delete it.rail[r] }
    }
    if (on.has('needs-you') && !it.ny) it.ny = { ny: it.cum.ny, known: true }
    if (!on.has('needs-you')) it.ny = null
  }
  function fresh(snap, t, known) {
    return { st: known ? '' : snap.status, as: known ? '' : (snap.assignee || ''), labels: known ? [] : [...(snap.labels || [])], pr: snap.priority, type: snap.issue_type || '',
      seen: t, t, known, cum: { any: 0, soft: 0, ny: 0, 'needs-you': 0, 'sign-off': 0, approval: 0 }, rail: {}, seg: null, ready: null, round: null, ho: null, ny: null,
      from: null, signed: false, approved: false, verdict: null, lastRole: '', doneRole: '', closedAt: 0, reopens: 0, escapes: 0, leases: 0, esc: [], blockers: [] }
  }

  function one(e) {
    const id = e.issue_id, t = Date.parse(e.ts) || 0, seq = e.seq
    if (!id) return
    if (e.op === 'delete') { delete S.items[id]; return }
    let it = S.items[id]
    const snap = e.issue || null
    if (!it) {
      if (!snap) return
      it = S.items[id] = fresh(snap, t, e.op === 'create')
      if (!it.known) { // first seen mid-life (its start is before the journal): what it is now, with no start times
        // its round and review's first verdict began before the journal: none until it closes (rounds) or reopens (verdicts)
        it.lastRole = isRole(it.as) ? it.as : ''; it.midlife = true; it.verdict = -1
        it.seg = { kind: segKind(it), role: isRole(it.as) ? it.as : '', t: null, seq }
        for (const r of railsOf(it, REVIEWER)) it.rail[r] = { t: null, seq, role: it.lastRole }
        if (it.labels.includes('needs-you')) it.ny = { ny: 0, known: false }
        if (e.op !== 'dep_add' && e.op !== 'dep_remove') return
      }
    }
    advance(it, t)
    const actorRole = roleOf(e.actor), system = SYSTEM.has(String(e.actor || ''))
    const was = { st: it.st, as: it.as, labels: it.labels }

    // the receiver's first event on an item handed to it ends the handoff wait
    if (it.ho && actorRole === it.ho.to) {
      if (it.ho.t != null) {
        sample('mm_flow_handoff_wait_seconds', { role: it.ho.to, item: id }, (t - it.ho.t - (it.cum.soft - it.ho.soft)) / 1000, t)
        span(it, id, 'handoff', it.ho.to, it.ho.t, t, it.ho.seq)
      }
      it.ho = null
    }
    // review's first verdict of a round: a "not signed off" comment by review
    if (e.op === 'comment' && actorRole === REVIEWER && notSignedOff(e.comment?.text) && it.verdict === null) {
      it.verdict = 0
      if (it.from) sample('mm_flow_review_first_pass', { role: it.from, item: id }, 0, t)
    }
    // dependencies: `blocks` edges hold an item out of the queue; a bug's edge to a landed item is an escape
    if ((e.op === 'dep_add' || e.op === 'dep_remove') && e.dep?.target) {
      const tg = e.dep.target, kind = e.dep.kind || ''
      if (kind === 'blocks') {
        const deps = (S.deps[tg] ||= [])
        if (e.op === 'dep_add') { if (!it.blockers.includes(tg)) it.blockers.push(tg); if (!deps.includes(id)) deps.push(id) }
        else { it.blockers = it.blockers.filter((x) => x !== tg); S.deps[tg] = deps.filter((x) => x !== id) }
      }
      const land = S.items[tg]
      if (e.op === 'dep_add' && kind !== 'parent-child' && (snap?.issue_type || it.type) === 'bug' && land && land.st === 'closed' && land.doneRole && !land.esc.includes(id)) {
        land.esc.push(id); land.escapes++
        sample('mm_flow_escaped_total', { role: land.doneRole, item: tg }, land.escapes, t)
      }
    }

    if (snap) {
      const labels = [...(snap.labels || [])]
      const added = labels.filter((l) => !was.labels.includes(l)), removed = was.labels.filter((l) => !labels.includes(l))
      it.st = snap.status || it.st; it.as = snap.assignee || ''; it.labels = labels; it.pr = snap.priority ?? it.pr; it.type = snap.issue_type || it.type
      if (isRole(it.as)) it.lastRole = it.as
      // labels through the event that set them, with its actor
      if (added.includes('signed-off') && actorRole === REVIEWER) {
        it.signed = true
        if (it.verdict === null) { it.verdict = 1; if (it.from) sample('mm_flow_review_first_pass', { role: it.from, item: id }, 1, t) }
      }
      if (removed.includes('signed-off')) it.signed = false
      if (added.includes('approved') && (opts.ledger ? opts.ledger(id) : APPROVERS.has(String(e.actor || '')))) it.approved = true
      if (removed.includes('approved')) it.approved = false

      const closedNow = it.st === 'closed', closedWas = was.st === 'closed'
      if (closedNow && !closedWas && was.st) { // done
        const r = it.round
        if (r && isRole(r.role) && r.t != null) {
          const paused = it.cum.any - r.any
          sample('mm_flow_cycle_seconds', { role: r.role, item: id }, (t - r.t - paused) / 1000, t)
          sample('mm_flow_paused_seconds', { role: r.role, item: id, rail: 'all' }, paused / 1000, t)
          for (const x of RAILS) if (it.cum[x] - r[x] > 0) sample('mm_flow_paused_seconds', { role: r.role, item: id, rail: x }, (it.cum[x] - r[x]) / 1000, t)
        }
        it.doneRole = (r && r.role) || it.lastRole; it.closedAt = t; it.round = null; it.ho = null; it.midlife = false
        span(it, id, 'done', it.doneRole, t, t, seq)
        if (it.known) span(it, id, 'item', it.doneRole, it.seen, t, seq)
      }
      if (closedWas && !closedNow) { // reopened
        it.reopens++
        if (isRole(it.doneRole)) sample('mm_flow_reopened_total', { role: it.doneRole, item: id }, it.reopens, t)
        span(it, id, 'reopened', it.doneRole, t, t, seq)
        it.verdict = null; it.from = null // a new round of work: review's next verdict is its first again
      }
      if (it.st === 'in_progress' && was.st !== 'in_progress') { // claimed
        if (it.ready && it.ready.t != null && isRole(it.as)) sample('mm_flow_queue_wait_seconds', { role: it.as, item: id }, (t - it.ready.t - (it.cum.soft - it.ready.soft)) / 1000, t)
        if (!it.round && isRole(it.as) && !it.midlife) it.round = { role: it.as, t, any: it.cum.any, ...Object.fromEntries(RAILS.map((x) => [x, it.cum[x]])) }
      }
      if (was.st === 'in_progress' && it.st === 'open' && system && isRole(was.as)) { // the system took a claim back: a lease ran out
        it.leases++
        sample('mm_flow_lease_expired_total', { role: was.as, item: id }, it.leases, t)
      }
      if (it.as !== was.as && !closedNow) { // a reassign: a handoff when someone else gives it to a role
        if (isRole(it.as) && isRole(was.as) && actorRole !== it.as) it.ho = { to: it.as, t, soft: it.cum.soft, seq }
        else it.ho = null
        if (it.as === REVIEWER && isRole(was.as) && was.as !== REVIEWER) it.from = was.as
        else if (it.as !== REVIEWER) it.from = null
      }
    }
    settle(it, id, t, seq)
    if (snap && (it.st === 'closed') !== (was.st === 'closed')) for (const d of S.deps[id] || []) { // its dependents may enter or leave the queue
      const di = S.items[d]
      if (di) { advance(di, t); settle(di, d, t, seq) }
    }
  }

  return {
    fold(records) {
      samples = []; spans = []
      for (const e of records) {
        if (!(e.seq > S.seq)) continue
        if (!S.first) S.first = { seq: e.seq, t: Date.parse(e.ts) || 0 }
        one(e)
        S.seq = e.seq; S.last = { seq: e.seq, t: Date.parse(e.ts) || 0 }
      }
      return { samples, spans }
    },
    /** The gauges at `now`: WIP and capacity per role, needs-you age per item, the event range. */
    gauges(now, capacity = {}) {
      const out = [], g = (name, labels, value) => out.push({ name, labels: { project: P, ...labels }, value, t: now })
      const wip = Object.fromEntries([...ROLES].map((r) => [r, 0]))
      for (const [id, it] of Object.entries(S.items)) {
        if (it.st === 'in_progress' && isRole(it.as)) wip[it.as]++
        if (it.st !== 'closed' && it.ny && it.ny.known) {
          const on = railsOf(it, REVIEWER), extra = on.includes('needs-you') && !on.includes('approval') ? Math.max(0, now - it.t) : 0
          g('mm_flow_needs_you_age_seconds', { role: (isRole(it.as) ? it.as : it.lastRole) || 'none', item: id }, (it.cum.ny + extra - it.ny.ny) / 1000)
        }
      }
      for (const [r, n] of Object.entries(wip)) g('mm_flow_wip', { role: r }, n)
      for (const [r, n] of Object.entries(capacity)) if (ROLES.has(r) && Number.isFinite(n)) g('mm_flow_capacity', { role: r }, n)
      if (S.first) { g('mm_flow_journal_first_seq', {}, S.first.seq); g('mm_flow_journal_first_time', {}, S.first.t / 1000) }
      if (S.last) { g('mm_flow_journal_last_seq', {}, S.last.seq); g('mm_flow_journal_last_time', {}, S.last.t / 1000) }
      return out
    },
    /** Forget closed items older than `keepMs` (their samples are sent; an escape needs the landed item for a while). */
    prune(now, keepMs = 30 * 86400e3) {
      for (const [id, it] of Object.entries(S.items)) if (it.st === 'closed' && it.closedAt && now - it.closedAt > keepMs) delete S.items[id]
      for (const [k, v] of Object.entries(S.deps)) { const l = v.filter((d) => S.items[d]); if (!S.items[k] || !l.length) delete S.deps[k]; else S.deps[k] = l }
    },
    state: () => S,
  }
}

const esc = (v) => String(v).replace(/[\\"\n]/g, '_')
/** Samples -> Prometheus text lines with their own times (ms), labels sorted. */
export function promLines(samples) {
  return samples.map((s) => `${s.name}{${Object.keys(s.labels).sort().map((k) => `${k}="${esc(s.labels[k])}"`).join(',')}} ${+s.value.toFixed(3)} ${Math.round(s.t)}`)
}
