// Structured content (sy-rfup, step 1): a message, a Task or an owner card as JSON, checked by a JSON Schema
// (bin/lib/schemas/<kind>.v1.json, the one source; bin/lib/schema.mjs validates it). Stored on the board as one fenced
// block, the first thing in the comment or (after the card, for a Task) in the description:
//   ```mm-message v1        ```mm-task v1        ```mm-card v1
//   { ...JSON... }          { ...JSON... }       { ...JSON... }
//   ```                     ```                  ```
// Every field is typed (enums, patterns, objects, arrays, ids, numbers); the one free field is `misc`, an array of typed
// parts (text, markdown, mermaid, html, svg, image, table, log). The writing check runs on the text parts.
// The parsers of today (message.mjs, task.mjs, owner-card.mjs) read either form: a block maps to the same keys as the
// key/value text (messageKeys, taskKeys, cardKeys), so the gates, the Supervisor, wake, the bridge and the board read
// both. bin/structured builds the blocks (bd msg, bd task, bd card).
// Pure; imports only schema.mjs and schemas.mjs. An identical copy is the board's browser code (site/src/lib/structured.mjs;
// test/schema.mjs keeps them equal).
import { validator } from './schema.mjs'
import { SCHEMAS } from './schemas.mjs'

export const VERSION = 1
export const KINDS = ['message', 'task', 'card']
export const SCHEMA_ID = { message: 'urn:mm:schema:message:v1', task: 'urn:mm:schema:task:v1', card: 'urn:mm:schema:card:v1' }
/** A block is at most this many characters (the inline html, svg and log parts have their own caps in the schema). */
export const MAX_BLOCK = 24000
export const PART_TYPES = ['text', 'markdown', 'mermaid', 'html', 'svg', 'image', 'table', 'log']
const V = validator(SCHEMAS)
const FENCE = /^```mm-([a-z]+) v([0-9]+)[ \t]*\n([\s\S]*?)\n?```[ \t]*(?:\n|$)/
const len = (s) => Array.from(s).length
const clip = (s, n = 60) => (len(s) > n ? `${Array.from(s).slice(0, n - 1).join('')}…` : s)
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Does the text start with a structured block (any kind, valid or not)? */
export const looksStructured = (text) => /^```mm-[a-z]+ v[0-9]+/.test(String(text ?? '').replace(/^\s+/, ''))

/**
 * Read the block at the top of a text (blank lines before it are ok).
 * @param {string} text
 * @returns {null | { kind: string, v: number, data: any, errors: string[], raw: string, rest: string }}  null: the text
 *   does not start with one. errors: the block cannot be read (an unknown kind or version, no JSON, not an object);
 *   validate() gives the schema's. raw: the block as written; rest: the text after it.
 */
export function readBlock(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s+/, '')
  if (!looksStructured(t)) return null
  const m = FENCE.exec(t)
  if (!m) return { kind: '', v: 0, data: null, errors: ['the block has no end: a line ``` closes it'], raw: t, rest: '' }
  const out = { kind: m[1], v: Number(m[2]), data: null, errors: [], raw: m[0].replace(/\n$/, ''), rest: t.slice(m[0].length).replace(/^\n+/, '') }
  if (!KINDS.includes(out.kind)) out.errors.push(`mm-${out.kind} is no kind of block (${KINDS.map((k) => `mm-${k}`).join(', ')})`)
  else if (out.v !== VERSION) out.errors.push(`mm-${out.kind} v${out.v}: this board reads v${VERSION}`)
  if (len(out.raw) > MAX_BLOCK) out.errors.push(`the block is too long (${len(out.raw)} characters; at most ${MAX_BLOCK}): put a long log, table or page in an artifact and point a part to it`)
  try { out.data = JSON.parse(m[3]) } catch (e) { out.errors.push(`the block is not JSON (${clip(String(e.message), 80)})`); return out }
  if (!out.data || typeof out.data !== 'object' || Array.isArray(out.data)) { out.errors.push('the block is not one JSON object'); out.data = null }
  return out
}

/** The block for some data: ```mm-<kind> v1, the JSON (a ` written as \u0060, so no part can end the fence), ```. */
export const formatBlock = (kind, data) => `\`\`\`mm-${kind} v${VERSION}\n${JSON.stringify(data, null, 2).replace(/`/g, '\\u0060')}\n\`\`\``

/**
 * The errors of some data against its kind's schema, and the checks a schema cannot say (a table row as wide as its
 * columns). The run-time checks against the board (roles, activities, the writing rules) are the parsers'.
 * @param {'message'|'task'|'card'} kind
 * @returns {string[]}
 */
export function validate(kind, data) {
  if (!SCHEMA_ID[kind]) return [`no schema for ${kind}`]
  const errors = V.validate(SCHEMA_ID[kind], data)
  const parts = Array.isArray(data?.misc) ? data.misc : []
  parts.forEach((p, k) => {
    if (p?.type === 'table' && Array.isArray(p.columns) && Array.isArray(p.rows))
      p.rows.forEach((r, j) => { if (Array.isArray(r) && r.length !== p.columns.length) errors.push(`misc[${k}].rows[${j}]: has ${r.length} cells (the columns: ${p.columns.length})`) })
  })
  return errors
}

/** The text parts, for the writing check: one paragraph each (the other parts are not words). */
export const miscText = (parts) => (Array.isArray(parts) ? parts : []).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text.trim()).join('\n\n')
/** The first text part on one line (the question of a card's Reply), or ''. */
export const firstText = (parts) => one((Array.isArray(parts) ? parts : []).find((p) => p?.type === 'text' && typeof p.text === 'string')?.text)

// ---- the typed fields in words: the same values the key/value form has ----
const str = (x) => (typeof x === 'string' ? x : x === undefined || x === null ? '' : JSON.stringify(x))
/** By in the text form: next-wake -> "next wake", hh:mm -> "hh:mm UTC". */
export const byText = (b) => { const s = str(b); return s === 'next-wake' ? 'next wake' : /([0-9]{2}:[0-9]{2})$/.test(s) ? `${s} UTC` : s }
export const verifyText = (x) => (x && typeof x === 'object' ? `${str(x.check)} → ${str(x.expect)}` : str(x))
export const stepText = (x) => (x && typeof x === 'object' ? [x.role && `${str(x.role)}:`, str(x.do), x.on && str(x.on), x.by && `by ${byText(x.by)}`].filter(Boolean).join(' ') : str(x))
export const doneText = (x) => (x && typeof x === 'object' ? ('is' in x ? `${x.item ? str(x.item) : 'this item'} is ${str(x.is)}` : verifyText(x)) : str(x))
const elseText = (x) => (x && typeof x === 'object' ? [str(x.do), x.to && str(x.to)].filter(Boolean).join(' ') : str(x))
const list = (xs, f = str) => (Array.isArray(xs) ? xs.map((x) => `- ${f(x)}`).join('\n') : str(xs))
const RESULT = { 'signed-off': 'signed off' }

/**
 * A message's fields as parseMessage's keys (Head, Expect, Done when, Verify, By, and the intent's own).
 * @returns {{ intent: string|null, to: string|null, re: number|null, keys: Record<string,string>,
 *   expect: { role: string, action: string }|null, by: string|null }}
 */
export function messageKeys(d) {
  const x = d && typeof d === 'object' ? d : {}
  const k = {}
  if (x.head !== undefined) k.Head = str(x.head)
  let expect = null
  if (x.expect === 'none') k.Expect = 'none'
  else if (x.expect && typeof x.expect === 'object') {
    expect = { role: str(x.expect.role), action: [str(x.expect.do), x.expect.on && str(x.expect.on)].filter(Boolean).join(' ') }
    k.Expect = `${expect.role}: ${expect.action}`
  } else if (x.expect !== undefined) k.Expect = str(x.expect)
  if (x.done !== undefined) k['Done when'] = doneText(x.done)
  if (x.verify !== undefined) k.Verify = verifyText(x.verify)
  const by = x.by === undefined ? null : byText(x.by)
  if (by !== null) k.By = `${by} · Else: ${elseText(x.else) || '?'}`
  if (x.need !== undefined) k.Why = str(x.need)
  if (x.options !== undefined) k.Options = list(x.options)
  if (x.ready !== undefined) k.Ready = list(x.ready)
  if (x.surfaces !== undefined) k.Surfaces = Array.isArray(x.surfaces) ? x.surfaces.map(str).join(', ') : str(x.surfaces)
  if (x.tests !== undefined) k.Tests = x.tests && typeof x.tests === 'object' ? `${str(x.tests.artifact)}: ${str(x.tests.passed)} passed, ${str(x.tests.failed)} failed` : str(x.tests)
  if (x.open !== undefined) k.Open = list(x.open)
  if (x.result !== undefined) k.Result = RESULT[x.result] || str(x.result)
  if (x.mustChange !== undefined) k['Must change'] = list(x.mustChange, (m) => (m && typeof m === 'object' ? `${str(m.path)}${m.line ? `:${m.line}` : ''}${m.rule ? ` (${str(m.rule)})` : ''}` : str(m)))
  if (x.answer !== undefined) k.Answer = str(x.answer)
  if (x.followUps !== undefined) k['Follow-ups'] = list(x.followUps)
  if (x.artifacts !== undefined) k.Artifacts = list(x.artifacts)
  return { intent: typeof x.intent === 'string' ? x.intent : null, to: typeof x.to === 'string' ? x.to : null,
    re: Number.isInteger(x.re) ? x.re : null, keys: k, expect, by }
}

/** A Task's fields as parseTask's keys (Task, Act, Done when, Verify, Head, Rollback, Safeguard). */
export function taskKeys(d) {
  const x = d && typeof d === 'object' ? d : {}, k = {}
  if (x.do !== undefined) k.Task = [str(x.do), x.on && str(x.on)].filter(Boolean).join(' ')
  if (x.act !== undefined) k.Act = str(x.act)
  if (x.done !== undefined) k['Done when'] = doneText(x.done)
  if (x.verify !== undefined) k.Verify = verifyText(x.verify)
  if (x.head !== undefined) k.Head = str(x.head)
  if (x.rollback !== undefined) k.Rollback = x.rollback && typeof x.rollback === 'object' ? [x.rollback.run && `run ${str(x.rollback.run)}`, x.rollback.migration && `migration ${str(x.rollback.migration)}`].filter(Boolean).join('; ') : str(x.rollback)
  if (x.safeguard !== undefined) k.Safeguard = verifyText(x.safeguard)
  return k
}

const YOU = { approve: 'Tap Approve', nothing: 'Nothing' }
/** A card's fields as parseCard's keys (What, Why, You, If yes, If no, Risk, Head, Link, Item). You: "Reply: <the first
 * text part>" (the question), "Check: <at>". */
export function cardKeys(d) {
  const x = d && typeof d === 'object' ? d : {}, k = {}
  if (x.what !== undefined) k.What = stepText(x.what)
  if (x.why !== undefined) k.Why = str(x.why)
  if (x.you !== undefined) {
    const kind = x.you && typeof x.you === 'object' ? x.you.kind : x.you
    k.You = YOU[kind] || (kind === 'reply' ? `Reply: ${clip(firstText(x.misc) || 'see the card', 150)}` : kind === 'check' ? `Check: ${str(x.you.at) || 'see the card'}` : str(kind))
  }
  if (x.ifYes !== undefined) k['If yes'] = stepText(x.ifYes)
  if (x.ifNo !== undefined) k['If no'] = stepText(x.ifNo)
  if (x.risk !== undefined) k.Risk = x.risk && typeof x.risk === 'object' ? [str(x.risk.level), ...(Array.isArray(x.risk.of) ? x.risk.of.map(str) : [])].filter(Boolean).join(', ') : str(x.risk)
  if (x.head !== undefined) k.Head = str(x.head)
  if (x.link !== undefined) k.Link = str(x.link)
  if (x.item !== undefined) k.Item = str(x.item)
  return k
}
