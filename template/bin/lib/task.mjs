// The Task (sy-lusk): every item's description says, in a fixed short block, what is to be done, in which activity of
// the RACI, when it is done and how to check it. It is the first block after the owner card (bin/lib/owner-card.mjs),
// or the first block when there is none:
//   ## Task
//   - **Task:** <one instruction, at most 20 words>
//   - **Act:** <activity id from leads/raci.json>
//   - **Done when:** <the visible result>
//   - **Verify:** <the exact check> → <the expected output>     ("->" is the same as "→")
//   - **Head:** <repo>@<sha>                                     (when it exists)
//   - **Rollback:** <how to undo it>                             (sy-w5az: a t2 go ask needs it)
//   - **Safeguard:** <the lockout safeguard>, or "none, no access change"   (sy-w5az: a t2 go ask needs it)
// A Markdown list follows the heading, one line per key; a blank line (or the end) ends it.
// Rollback and Safeguard are optional here; goTaskRefusal says whether a Task has both, non-empty: owner-card.mjs
// headRefusal refuses the T2 go (and needs-you on a t2 go ask) without them; a t2 non-go ask needs neither.
// Pure; imports only its neighbour owner-card.mjs (the card it comes after, and the Head format), which imports this
// one back (headRefusal: goTaskRefusal): neither uses the other's exports before a call. Used by bin/task (bin/bd's
// gate), owner-card.mjs and the Supervisor; the board's browser code has an identical copy (site/src/lib/task.mjs;
// test/task.mjs keeps them equal).
import { HEAD, parseCard } from './owner-card.mjs'

export const KEYS = ['Task', 'Act', 'Done when', 'Verify', 'Head', 'Rollback', 'Safeguard']
export const REQUIRED = ['Task', 'Act', 'Done when', 'Verify']
/** The keys a t2 go ask's Task needs (sy-w5az): how to undo the change, and the lockout safeguard. */
export const GO_KEYS = ['Rollback', 'Safeguard']
export const MAX_TASK_WORDS = 20
const MAX_LINE = 300
/**
 * The Task block for an item a program makes (sy-n3r5: the sentinel, the Supervisor, health), so it passes parseTask:
 * `formatTask({ task, act, done, verify: [check, expected] })` + "\n\n" + the rest of the description. One line each
 * (newlines become spaces); the caller keeps Task to one instruction of at most 20 words.
 */
export function formatTask({ task, act, done, verify, head }) {
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const [check, want] = Array.isArray(verify) ? verify : [verify, 'done']
  return ['## Task', `- **Task:** ${one(task)}`, `- **Act:** ${one(act)}`, `- **Done when:** ${one(done)}`,
    `- **Verify:** ${one(check)} → ${one(want)}`, ...(head ? [`- **Head:** ${one(head)}`] : [])].join('\n')
}

export const FORMAT = 'the description starts (after the owner card, when there is one) with "## Task", then one line per key: "- **Task:** <one instruction, at most 20 words>", "- **Act:** <activity id from leads/raci.json>", "- **Done when:** <the visible result>", "- **Verify:** <the exact check> → <the expected output>", "- **Head:** <repo>@<sha>" when it exists, and on a t2 item "- **Rollback:** <how to undo it>" and "- **Safeguard:** <the lockout safeguard, or none, no access change>"; a blank line ends it (the leads\' brief, "The Task")'
const HEADING = /^##[ \t]+Task[ \t]*$/
const LINE = /^[-*][ \t]+\*\*([^*]+?):\*\*[ \t]*(.*?)[ \t]*$/
const ARROW = /^(.*\S)[ \t]*(?:→|->)[ \t]*(\S.*)$/
const len = (s) => Array.from(s).length
const clip = (s) => (len(s) > 60 ? `${Array.from(s).slice(0, 59).join('')}…` : s)

/**
 * Read and check the Task of a description.
 * @param {string} description  the item's description (Markdown)
 * @param {{ acts?: string[] }} [o]  acts: the activity ids of leads/raci.json; when given, Act must be one of them
 * @returns {{ ok: boolean, found: boolean, task: Record<string,string>|null, errors: string[] }}
 */
export function parseTask(description, o = {}) {
  const text = String(description ?? '').replace(/\r\n?/g, '\n')
  const card = parseCard(text)
  const lines = (card.found ? card.rest : text).split('\n')
  let k = 0
  while (k < lines.length && !lines[k].trim()) k++
  if (k >= lines.length || !HEADING.test(lines[k])) {
    const later = lines.some((l) => HEADING.test(l))
    return { ok: false, found: false, task: null,
      errors: [later ? `the Task is not at the top: "## Task" is the first line of the description${card.found ? ' after the owner card' : ''}` : `no Task: the description does not start with "## Task"${card.found ? ' after the owner card' : ''}`] }
  }
  k++
  while (k < lines.length && !lines[k].trim()) k++
  const task = {}, errors = []
  for (; k < lines.length && lines[k].trim(); k++) {
    const m = LINE.exec(lines[k].trim())
    if (!m) { errors.push(`line "${clip(lines[k].trim())}" is not "- **Key:** value"`); continue }
    const key = m[1].trim(), value = m[2]
    if (!KEYS.includes(key)) { errors.push(`unknown key "${clip(key)}" (the keys: ${KEYS.join(', ')})`); continue }
    if (key in task) { errors.push(`${key} is there twice`); continue }
    task[key] = value
    if (!value) { errors.push(`${key} is empty`); continue }
    if (len(value) > MAX_LINE) errors.push(`${key} is too long (${len(value)} characters; at most ${MAX_LINE})`)
  }
  for (const r of REQUIRED) if (!(r in task)) errors.push(`${r} is missing`)
  if (task.Task) {
    const words = task.Task.replace(/`[^`]*`/g, 'x').split(/\s+/).filter(Boolean).length
    if (words > MAX_TASK_WORDS) errors.push(`Task is ${words} words (at most ${MAX_TASK_WORDS}): one instruction, the verb first`)
  }
  if (task.Act) {
    const acts = Array.isArray(o.acts) ? o.acts : null
    if (acts && !acts.includes(task.Act)) errors.push(`Act "${clip(task.Act)}" is not an activity of leads/raci.json (${acts.length ? acts.join(', ') : 'it has none'})`)
  }
  if (task.Verify && !ARROW.test(task.Verify)) errors.push('Verify is not "<the exact check> → <the expected output>"')
  if (task.Head && !HEAD.test(task.Head)) errors.push('Head is not <repo>@<sha> (repo: a lowercase letter, then up to 30 of a-z, 0-9, -; sha: 7 to 40 lowercase hex)')
  return { ok: errors.length === 0, found: true, task, errors }
}

/** The keys of GO_KEYS a Task lacks or has empty (sy-w5az); all of them when there is no Task.
 * @param {Record<string,string>|null|undefined} task  parseTask(...).task */
export const goGaps = (task) => GO_KEYS.filter((k) => !String(task?.[k] ?? '').trim())
/** A Task that has both Rollback and Safeguard, non-empty (sy-w5az). */
export const hasGoKeys = (task) => goGaps(task).length === 0

/**
 * Why a t2 go ask may not get the go, or wait on the owner, for its Task (sy-w5az); null when the item's Task has a
 * non-empty Rollback and Safeguard. The one rule: owner-card.mjs headRefusal calls it (the bd gate, the board, the
 * Waiting list, the bridge). The rest of the Task is not checked here (bin/task does that).
 * @param {string} description  the item's description
 * @returns {string|null}
 */
export function goTaskRefusal(description) {
  const gaps = goGaps(parseTask(description).task)
  if (!gaps.length) return null
  return `the item's Task has no ${gaps.join(' and no ')} line: a t2 go needs both (- **Rollback:** how to undo it; - **Safeguard:** the lockout safeguard, or none, no access change)`
}
