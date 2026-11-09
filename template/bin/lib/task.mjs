// The Task (sy-lusk): every item's description says, in a fixed short block, what is to be done, in which activity of
// the RACI, when it is done and how to check it. It is the first block after the owner card (bin/lib/owner-card.mjs),
// or the first block when there is none:
//   ## Task
//   - **Task:** <one instruction, at most 20 words>
//   - **Act:** <activity id from leads/raci.json>
//   - **Done when:** <the visible result>
//   - **Verify:** <the exact check> → <the expected output>     ("->" is the same as "→")
//   - **Head:** <repo>@<sha>                                     (when it exists)
// A Markdown list follows the heading, one line per key; a blank line (or the end) ends it.
// The structured form (sy-rfup, step 1): a ```mm-task v1 block in the same place (bin/lib/structured.mjs; bd task builds
// it), checked by its schema (bin/lib/schemas/task.v1.json) and Act against leads/raci.json; it maps to the same keys
// (Task: "<do> <on>"), and .json is its data. Both forms pass for now.
// Pure; imports only its neighbours structured.mjs and owner-card.mjs (the card it comes after, and the Head format). Used by bin/task
// (bin/bd's gate) and the Supervisor.
import { HEAD, parseCard } from './owner-card.mjs'
import { readBlock, taskKeys, validate } from './structured.mjs'

/** parseTask for a ```mm-task v1 block: the schema, then Act against leads/raci.json. */
function taskBlock(b, o) {
  const errors = [...b.errors]
  if (errors.length || !b.data) return { ok: false, found: true, task: {}, errors, rest: b.rest, json: b.data }
  errors.push(...validate('task', b.data))
  const task = taskKeys(b.data), acts = Array.isArray(o.acts) ? o.acts : null
  if (acts && task.Act && !acts.includes(task.Act)) errors.push(`act: ${clip(task.Act)} is not an activity of leads/raci.json (${acts.length ? acts.join(', ') : 'it has none'})`)
  return { ok: errors.length === 0, found: true, task, errors, rest: b.rest, json: b.data }
}

export const KEYS = ['Task', 'Act', 'Done when', 'Verify', 'Head']
export const REQUIRED = ['Task', 'Act', 'Done when', 'Verify']
export const MAX_TASK_WORDS = 20
const MAX_LINE = 300
export const FORMAT = 'the description starts (after the owner card, when there is one) with "## Task", then one line per key: "- **Task:** <one instruction, at most 20 words>", "- **Act:** <activity id from leads/raci.json>", "- **Done when:** <the visible result>", "- **Verify:** <the exact check> → <the expected output>", and "- **Head:** <repo>@<sha>" when it exists; a blank line ends it (the leads\' brief, "The Task")'
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
  const b = readBlock(card.found ? card.rest : text)
  if (b?.kind === 'task') return taskBlock(b, o)
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
