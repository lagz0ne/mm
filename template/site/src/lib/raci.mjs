// The RACI (leads/raci.json): who does, verifies, approves, is consulted on and is told about each kind of work, and
// when to involve whom (sy-lusk). An item's activity is its label act:<id>. The letters:
//   R  does it: the task; writes the HANDOFF and the DONE                                        (a gate)
//   V  verifies: a HANDOFF → V; answers with a VERDICT on the Head, by its By. Each new head     (a gate)
//   A  approves: an owner card when A is human, else a HANDOFF; only after V's VERDICT, for that head (a gate)
//   C  is asked: an ASK → C, only in the row's consult cases; no answer by By = "no input", the work goes on
//   I  is told: once, at DONE (wake wakes it when the item closes); never asked
// A cell is one or more letters, each once: R, A, V, C, I, RA, VA, CI, ... (C and I never with R, A or V). Each row has
// exactly one A and at least one R. `human` (the people) is only A or I: a person is never asked in a message.
// A row with a C lists its consult cases: "consult": ["<role>: <when it is asked>", ...]; a case that starts with
// "<participant>:" names a C of the row.
// Pure, no imports: bin/raci, config-check, wake, bin/message, the Supervisor, and, as an identical copy, the board's
// RACI view (site/src/lib/raci.mjs; test/raci.mjs keeps them equal).
export const LETTERS = ['R', 'A', 'V', 'C', 'I']
/** What each letter means, one line (bin/raci render, the board's RACI view). */
export const MEANS = {
  R: 'does it (the task; writes the HANDOFF and the DONE)',
  V: 'verifies (a HANDOFF → V; a VERDICT on that head, by its By)',
  A: 'approves (the owner card when human, else a HANDOFF; after V\'s VERDICT, for that head)',
  C: 'is asked (an ASK → C, only in the row\'s consult cases; no answer by By = no input)',
  I: 'is told (once, at DONE)',
}
/** The gate letters: R, V and A block; C and I never do. */
export const GATE = ['R', 'V', 'A']
export const ID = /^[a-z][a-z0-9-]{0,31}$/
const CELL = /^[RAVCI]{1,3}$/
const MAX_CASE = 200

/** Problems with a matrix (empty: fine). participants: the roles' ids and `human`. */
export function problems(d, participants) {
  const out = [], ids = new Set()
  for (const a of d?.activities || []) {
    if (!ID.test(a?.id || '')) out.push(`bad activity id ${a?.id}`)
    if (ids.has(a.id)) out.push(`duplicate activity ${a.id}`); ids.add(a.id)
    const cells = Object.entries(a.raci || {})
    for (const [p, l] of cells) {
      if (!participants.includes(p)) out.push(`${a.id}: unknown participant ${p}`)
      if (typeof l !== 'string' || !CELL.test(l) || new Set(l).size !== l.length) { out.push(`${a.id}: bad letters ${p}=${l}`); continue }
      if (/[CI]/.test(l) && /[RAV]/.test(l)) out.push(`${a.id}: ${p}=${l}: C and I never go with R, A or V`)
      if (p === 'human' && /[RVC]/.test(l)) out.push(`${a.id}: human=${l}: a person is only A or I (never asked in a message)`)
    }
    const A = cells.filter(([, l]) => String(l).includes('A')).length
    if (A !== 1) out.push(`${a.id}: needs exactly one Accountable (has ${A})`)
    if (!cells.some(([, l]) => String(l).includes('R'))) out.push(`${a.id}: needs at least one Responsible`)
    const cs = a.consult
    if (cs !== undefined && (!Array.isArray(cs) || cs.some((c) => typeof c !== 'string' || !c.trim() || Array.from(c).length > MAX_CASE)))
      out.push(`${a.id}: consult is a list of cases, each one line of at most ${MAX_CASE} characters`)
    else {
      const Cs = cells.filter(([, l]) => String(l).includes('C')).map(([p]) => p)
      if (Cs.length && !(cs || []).length) out.push(`${a.id}: has a C (${Cs.join(', ')}) but no consult cases: say when each is asked`)
      for (const c of cs || []) {
        const p = /^([a-z][a-z0-9_-]*):/.exec(c)?.[1]
        if (p && participants.includes(p) && !Cs.includes(p)) out.push(`${a.id}: the consult case "${c.slice(0, 40)}" names ${p}, which is not C in the row`)
      }
    }
    out.push(...routineProblems(a))
  }
  return out
}

/** The row of an activity, or null. */
export const rowOf = (activities, act) => (Array.isArray(activities) && act ? activities.find((a) => a?.id === act) || null : null)
/** The activity id of an item, from its labels (act:<id>), or null. */
export const actOf = (labels) => (Array.isArray(labels) ? labels.find((l) => typeof l === 'string' && l.startsWith('act:'))?.slice(4) || null : null)
/** A participant's letters in a row ('' when none). A worker <role>/<name> counts as its role. */
export const lettersOf = (row, who) => String(row?.raci?.[String(who || '').split('/')[0]] || '')
/** The participants with a letter in a row. */
export const withLetter = (row, letter) => Object.entries(row?.raci || {}).filter(([, l]) => String(l).includes(letter)).map(([p]) => p)
/** May a role be asked (an ASK) on an item of this row? Only C (its consult cases), V, and the gate (R, A). I and no
 * letter: no. No row: nothing to say (true). */
export const mayAsk = (row, role) => !row || /[CVRA]/.test(lettersOf(row, role))
/** Is a wait on this role non-blocking? An ASK to a role that is only C (or CI) in the row: no answer by By = no input. */
export const noInputOk = (row, role, intent) => intent === 'ASK' && !!row && /C/.test(lettersOf(row, role)) && !/[RAV]/.test(lettersOf(row, role))

// ---------- the routine (sy-mv69.2): when a row starts, its bounds, how it is verified and corrected ----------
// A row may carry, next to its letters (old rows without them stay valid):
//   "when":    [<case>, ...] the expected events that start it. A case is "<kind>:<pattern>", or an object
//              { "on": "<kind>:<pattern>", "text": "<regex every line of the finding matches>", "next": "<what R does>",
//                "bounds": {...}, "verify": {...}, "correct": "..." } (a case's own bounds, verify, correct win over the row's).
//              <kind>: sentinel (a sentinel key: alert:..., drift, cron:<p>/<job>, errors:<p>/<svc>, brain:<line>, ...),
//              supervisor (a Supervisor key or digest line key: dirty:..., suite:..., blocked:<item>, ...), brain (a
//              `[brain]` status line, without "[brain] "), board (a board event, e.g. claim-expired), label (a board label).
//              <pattern>: the whole key or line; * stands for any run of characters.
//   "bounds":  { "tier": "t0".."t3", "repos" | "paths" | "surfaces" | "actions": ["..."], "end": "<ISO time: the row ends>",
//                "within": { "of": "migration" | "boot" | "gates", "minutes": N }: the event comes at most N min after
//                          the last applied migration or the boot, or inside a gates run (N min on each side),
//                "for_min": N: it may stay present at most N min, "times": N: at most N episodes in 24 h,
//                "exclude": "<regex>": a line of the finding that matches it is outside the bounds }
//   "verify":  { "check": "<the command that proves it>", "expect": "<its expected output>" }
//   "correct": "<the fix or undo>", or "unexpected" (or "unexpected: <why>"): escalate even when it matches.
// The sentinel and the Supervisor match each finding to the cases (judge below): inside the bounds and not
// "unexpected", it is routine (no item; its next and verify are logged); no case, outside the bounds, or "unexpected":
// one item labelled `unexpected`, for ops.
export const KINDS = ['sentinel', 'supervisor', 'brain', 'board', 'label']
export const TIERS = ['t0', 't1', 't2', 't3']
export const WITHIN = ['migration', 'boot', 'gates']
export const UNEXPECTED = 'unexpected'
const ON = /^([a-z]+):(.+)$/
const BOUND_LISTS = ['repos', 'paths', 'surfaces', 'actions']
const BOUND_KEYS = ['tier', ...BOUND_LISTS, 'end', 'within', 'for_min', 'times', 'exclude']
const CASE_KEYS = ['on', 'text', 'next', 'bounds', 'verify', 'correct']
const line = (s) => typeof s === 'string' && !!s.trim() && !/\n/.test(s) && Array.from(s).length <= MAX_CASE
const regexOk = (s) => { if (!line(s)) return false; try { new RegExp(s); return true } catch { return false } }
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
const posNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0

function boundsProblems(b, where) {
  if (!isObj(b)) return [`${where}: bounds is an object`]
  const out = []
  for (const k of Object.keys(b)) if (!BOUND_KEYS.includes(k)) out.push(`${where}: unknown bound ${k} (known: ${BOUND_KEYS.join(', ')})`)
  if (b.tier !== undefined && !TIERS.includes(b.tier)) out.push(`${where}: bounds.tier is one of ${TIERS.join(', ')}`)
  for (const k of BOUND_LISTS) if (b[k] !== undefined && (!Array.isArray(b[k]) || !b[k].length || !b[k].every(line))) out.push(`${where}: bounds.${k} is a list of lines`)
  if (b.end !== undefined && (typeof b.end !== 'string' || !Date.parse(b.end))) out.push(`${where}: bounds.end is an ISO time`)
  if (b.within !== undefined && (!isObj(b.within) || !WITHIN.includes(b.within.of) || !posNum(b.within.minutes) || Object.keys(b.within).some((k) => !['of', 'minutes'].includes(k))))
    out.push(`${where}: bounds.within is { "of": ${WITHIN.join(' | ')}, "minutes": N }`)
  if (b.for_min !== undefined && !posNum(b.for_min)) out.push(`${where}: bounds.for_min is a number of minutes`)
  if (b.times !== undefined && !(Number.isInteger(b.times) && b.times > 0)) out.push(`${where}: bounds.times is a whole number, 1 or more`)
  if (b.exclude !== undefined && !regexOk(b.exclude)) out.push(`${where}: bounds.exclude is a regex on one line`)
  return out
}
function verifyProblems(v, where) {
  return isObj(v) && line(v.check) && line(v.expect) && Object.keys(v).every((k) => ['check', 'expect'].includes(k)) ? []
    : [`${where}: verify is { "check": "<command>", "expect": "<its expected output>" }`]
}
const correctProblems = (c, where) => (line(c) ? [] : [`${where}: correct is one line: the fix, or "${UNEXPECTED}"`])
function onProblems(on, where) {
  const m = typeof on === 'string' ? ON.exec(on) : null
  if (!m || !line(on)) return [`${where}: a when case is "<kind>:<pattern>" (kinds: ${KINDS.join(', ')})`]
  return KINDS.includes(m[1]) ? [] : [`${where}: unknown event kind ${m[1]} (known: ${KINDS.join(', ')})`]
}

/** Problems with a row's routine fields (when, bounds, verify, correct); empty: fine. Part of problems(). */
export function routineProblems(a) {
  const out = [], id = a?.id
  if (a?.bounds !== undefined) out.push(...boundsProblems(a.bounds, id))
  if (a?.verify !== undefined) out.push(...verifyProblems(a.verify, id))
  if (a?.correct !== undefined) out.push(...correctProblems(a.correct, id))
  if (a?.when === undefined) return out
  if (!Array.isArray(a.when) || !a.when.length) return [...out, `${id}: when is a list of cases`]
  a.when.forEach((c, n) => {
    const where = `${id}: when #${n + 1}`
    if (typeof c === 'string') { out.push(...onProblems(c, where)); return }
    if (!isObj(c)) { out.push(`${where}: a case is "<kind>:<pattern>" or { "on": ... }`); return }
    for (const k of Object.keys(c)) if (!CASE_KEYS.includes(k)) out.push(`${where}: unknown key ${k} (known: ${CASE_KEYS.join(', ')})`)
    out.push(...onProblems(c.on, where))
    if (c.text !== undefined && !regexOk(c.text)) out.push(`${where}: text is a regex on one line`)
    if (c.next !== undefined && !line(c.next)) out.push(`${where}: next is one line`)
    if (c.bounds !== undefined) out.push(...boundsProblems(c.bounds, where))
    if (c.verify !== undefined) out.push(...verifyProblems(c.verify, where))
    if (c.correct !== undefined) out.push(...correctProblems(c.correct, where))
  })
  return out
}

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
const glob = (g) => new RegExp(`^${g.split('*').map(esc).join('.*')}$`, 's')
/** Each when case of the rows, flat, the row's bounds, verify and correct filled in where the case has none. A row
 * with a problem is left out (config-check and bin/raci show it). */
export function cases(activities) {
  const out = []
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!a || !Array.isArray(a.when) || routineProblems(a).length) continue
    a.when.forEach((c, n) => {
      const x = typeof c === 'string' ? { on: c } : c
      out.push({ row: a.id, n: n + 1, on: x.on, re: glob(x.on), text: x.text ? new RegExp(x.text) : null, next: x.next || '',
        bounds: x.bounds || a.bounds || {}, verify: x.verify || a.verify || null, correct: x.correct || a.correct || '' })
    })
  }
  return out
}
/** Why a finding is outside a case's bounds, or null. ctx: { now, at (the finding's time), since (first seen), times
 * (episodes in 24 h), last: { migration, boot } (ms), gates: [[from, to], ...] (ms) }. */
export function outside(b, f, ctx = {}) {
  const now = ctx.now ?? Date.now(), at = ctx.at ?? now, lines = f.lines?.length ? f.lines : ['']
  if (b.end && Date.parse(b.end) < now) return `the row ended at ${b.end}`
  if (b.exclude) { const re = new RegExp(b.exclude), l = lines.find((x) => re.test(String(x))); if (l !== undefined) return `"${String(l).slice(0, 80)}" matches bounds.exclude` }
  if (b.within) {
    const w = b.within.minutes * 60e3
    if (b.within.of === 'gates') { if (!(ctx.gates || []).some(([a, z]) => at >= a - w && at <= z + w)) return `not inside a gates run (± ${b.within.minutes} min)` }
    else { const t = ctx.last?.[b.within.of]; if (!t || at < t || at - t > w) return `not within ${b.within.minutes} min after the last ${b.within.of}` }
  }
  if (b.for_min && ctx.since !== undefined && now - ctx.since > b.for_min * 60e3) return `present for more than ${b.for_min} min`
  if (b.times && (ctx.times || 1) > b.times) return `episode ${ctx.times} in 24 h (at most ${b.times})`
  return null
}
/** The case a finding matches: { case, outside: <why> | null }, or null (no case). finding: { events: ["<kind>:<key or
 * line>", ...], lines: [...] }. The first case inside its bounds wins; else the first that matched, with its reason. */
export function match(cs, f, ctx) {
  let first = null
  for (const c of cs) {
    if (!(f.events || []).some((e) => c.re.test(e))) continue
    if (c.text && !(f.lines?.length ? f.lines : ['']).every((l) => c.text.test(String(l)))) continue
    const why = outside(c.bounds, f, ctx)
    if (!why) return { case: c, outside: null }
    first ||= { case: c, outside: why }
  }
  return first
}
/** Does the correct of a case say "unexpected" (escalate even when it matches)? */
export const escalates = (c) => /^unexpected(?::|$)/.test(String(c?.correct || ''))
/** The verdict on a finding: { routine: true, case } (no item; log its next and verify), or { routine: false, why,
 * case? } (one `unexpected` item). */
export function judge(cs, f, ctx) {
  const m = match(cs, f, ctx)
  if (!m) return { routine: false, why: 'no row of leads/raci.json has a when case for it' }
  if (m.outside) return { routine: false, why: `outside the bounds of ${m.case.row} (when #${m.case.n}): ${m.outside}`, case: m.case }
  if (escalates(m.case)) return { routine: false, why: `${m.case.row} (when #${m.case.n}) says: ${m.case.correct}`, case: m.case }
  return { routine: true, case: m.case }
}
/** A case as one line: what R does next, the check and its expected output, the correct. */
export const caseLine = (c) => [`${c.row} (when #${c.n}: ${c.on})`, c.next && `next: ${c.next}`,
  c.verify && `verify: ${c.verify.check} → ${c.verify.expect}`, c.correct && `correct: ${c.correct}`].filter(Boolean).join('; ')
