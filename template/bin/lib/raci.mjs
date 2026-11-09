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
