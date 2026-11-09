// The message (sy-0gsw): every comment a lead writes on an item is one message with a fixed header, so who must do
// what, on which head, by when, is in the same place every time (the leads' brief, "Messages between roles"). Format:
//   <INTENT> → <to> · re #<n>                   (re: only when it answers a message; "->" is the same as "→")
//   Head: <repo>@<sha>                           (when code or a migration is in play; required on a VERDICT)
//   Expect: <role>: <one instruction, at most 20 words>   | Expect: none
//   Done when: <the visible result, one sentence>
//   Verify: <the exact check> → <the expected output>
//   By: <next wake | today | hh:mm UTC | YYYY-MM-DD [hh:mm UTC]> · Else: <what happens when it is not done>
//   <the intent's own keys, one line each; a line that starts with "1." or "-" goes on the key above it>
// The intents and their keys (INTENTS): ASK (Why; Options), HANDOFF (Ready, Surfaces; Tests, Open), VERDICT (Result: signed off
// | blocked; Must change, Notes), ANSWER (Answer; re required), DONE (Result; Follow-ups, Artifacts; Expect: none),
// NOTE (free text, no Expect block). An Expect that names a role needs Done when, Verify and By; Expect: none needs
// Verify (the evidence) on an ANSWER and a DONE. The whole message is at most MAX characters: tables, logs and test
// output go in an artifact, linked. A HANDOFF's Surfaces lists every place outside the repo the change reaches (or
// "none"), so the receiver knows what to restart, rebuild or check.
// The words follow the writing rules (sy-ko6r, writing.mjs): with o.writing, the lines after the header are checked;
// the problems are out.writing (warnings), and from the glossary's refuse_from on also errors.
// Pure; imports only its neighbours owner-card.mjs (the Head format) and writing.mjs. Used by bin/message (bin/bd's gate), the
// Supervisor (openWaits), and, as an identical copy, the board's browser code (site/src/lib/message.mjs;
// test/message.mjs keeps them equal).
import { HEAD } from './owner-card.mjs'
import { writingCheck } from './writing.mjs'

export const MAX = 600
/** The role that writes a VERDICT (review sy-0gsw #8): as only it signs off (bin/owner-card signoff). */
export const REVIEWER = 'review'
/** The board's setup agent (sy-0ggd): its actor, and the brief bin/lead starts it from. A board has it when the brief is
 * there. It is no lead (not in leads/roles.json, no RACI column): its own comments are not held to this format. */
export const SETUP = 'setup'
export const SETUP_BRIEF = 'setup/CLAUDE.md'
/**
 * Whom a message may address (the "→" of an ASK, HANDOFF or VERDICT, an Expect's role): the board's role ids
 * (leads/roles.json), and setup when the board has its setup agent. bin/message, wake and the board's browser code pass
 * this as parseMessage's and openWaits' roles.
 * @param {string[]} roleIds  leads/roles.json's ids
 * @param {boolean} hasSetup  the board has SETUP_BRIEF
 */
export const messageRoles = (roleIds, hasSetup) => [...new Set([...(Array.isArray(roleIds) ? roleIds : []).filter((x) => x !== SETUP), ...(hasSetup ? [SETUP] : [])])]
export const MAX_EXPECT_WORDS = 20
const COMMON = ['Head', 'Expect', 'Done when', 'Verify', 'By']
/** intent -> { req: its own required keys, opt: its own optional keys, expect: 'role' | 'none' | 'any' | 'no' } */
export const INTENTS = {
  ASK: { says: 'I need something from you', req: ['Why'], opt: ['Options'], expect: 'role' },
  HANDOFF: { says: 'the work is yours now', req: ['Ready', 'Surfaces'], opt: ['Tests', 'Open'], expect: 'role' },
  VERDICT: { says: "review's result", req: ['Result', 'Head'], opt: ['Must change', 'Notes'], expect: 'role' },
  ANSWER: { says: 'a reply to an ASK', req: ['Answer'], opt: [], expect: 'any' },
  DONE: { says: 'the unit is finished', req: ['Result'], opt: ['Follow-ups', 'Artifacts'], expect: 'none' },
  NOTE: { says: 'for the record', req: [], opt: [], expect: 'no' },
}
/** The intents that wait for an answer (re #n): the Supervisor flags them after their By. */
export const WAITING = ['ASK', 'HANDOFF']
export const FORMAT = 'the first line is "<INTENT> → <role>" (+ " · re #<n>" when it answers), INTENT one of ASK, HANDOFF, VERDICT, ANSWER, DONE, NOTE; then one "Key: value" line each: "Head: <repo>@<sha>" (code in play), "Expect: <role>: <one instruction>" or "Expect: none", "Done when: <visible result>", "Verify: <check> → <expected output>", "By: next wake|today|hh:mm UTC · Else: <what then>", and the intent\'s own keys (ASK: Why; HANDOFF: Ready, Surfaces <where the change runs> or none, Tests, Open; VERDICT: Result signed off|blocked, Head; ANSWER: Answer, re #n; DONE: Result, Expect: none); a NOTE is the header and free text; at most ' + MAX + ' characters, the rest in an artifact (the leads\' brief, "Messages between roles")'

const HEADER = /^(ASK|HANDOFF|VERDICT|ANSWER|DONE|NOTE)[ \t]*(?:→|->)[ \t]*([a-z][a-z0-9_-]*(?:\/[a-z0-9_-]+)?)(?:[ \t]*·[ \t]*re[ \t]+#([0-9]+))?[ \t]*$/
const LOOSE_HEADER = /^\**`?(ASK|HANDOFF|VERDICT|ANSWER|DONE|NOTE)\b/
const KEYLINE = /^([A-Z][A-Za-z-]*(?: [a-z][a-z-]*)?):[ \t]*(.*?)[ \t]*$/
const CONT = /^[ \t]*(?:[0-9]+[.)]|[-*])[ \t]+\S/
const BY = /^(next wake|today|([0-2][0-9]):([0-5][0-9]) UTC|([0-9]{4}-[0-9]{2}-[0-9]{2})(?: ([0-2][0-9]):([0-5][0-9]) UTC)?)[ \t]*·[ \t]*Else:[ \t]*(\S.*)$/
const EXPECT = /^([a-z][a-z0-9_-]*):[ \t]*(\S.*)$/
const ARROW = /^(.*\S)[ \t]*(?:→|->)[ \t]*(\S.*)$/
const len = (s) => Array.from(s).length
/** The article before an intent's name: an ASK, an ANSWER; a HANDOFF, a VERDICT, a DONE, a NOTE. */
const an = (intent) => (/^A/.test(intent) ? `an ${intent}` : `a ${intent}`)
const clip = (s) => (len(s) > 60 ? `${Array.from(s).slice(0, 59).join('')}…` : s)

/** Does the text start like a message (its first line names an intent)? For "not a message at all" vs "a bad one". */
export const looksLikeMessage = (text) => LOOSE_HEADER.test(String(text ?? '').replace(/^\s+/, ''))

/**
 * Read and check one message.
 * @param {string} text  the comment's text
 * @param {{ roles?: string[], author?: string, reviewer?: string }} [o]  roles: whom a message may address
 *   (messageRoles: the role ids of leads/roles.json, and setup when the board has it); when given, the "→" of an ASK, HANDOFF or VERDICT and the role of an Expect must be one of them. author: who
 *   wrote it (bd's actor, a comment's author); when given, a VERDICT is valid only from the reviewer role (reviewer,
 *   default REVIEWER) or its worker <reviewer>/<name>. writing: the writing check's setting ({ terms, words, roles,
 *   refuseFrom, today }: writing.mjs writingCheck); none: no check
 * @returns {{ ok: boolean, found: boolean, intent: string|null, to: string|null, re: number|null,
 *   keys: Record<string,string>, expect: { role: string, action: string }|null, by: string|null, text: string,
 *   errors: string[], writing: { rule: string, line: number, text: string }[] }}  writing: its lines count from the
 *   header (line 1)  found: the first line is a valid header; keys: the body's keys (continuation lines joined
 *   with "\n"); by: the By value without its Else.
 */
export function parseMessage(text, o = {}) {
  const roles = Array.isArray(o.roles) && o.roles.length ? o.roles : null
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  const lines = t.split('\n')
  const errors = []
  const out = { ok: false, found: false, intent: null, to: null, re: null, keys: {}, expect: null, by: null, text: t, errors, writing: [] }
  const h = HEADER.exec(lines[0].trim())
  if (!h) {
    errors.push(looksLikeMessage(t)
      ? `the first line "${clip(lines[0].trim())}" is not "<INTENT> → <role>" or "<INTENT> → <role> · re #<n>"`
      : 'no message header: the first line must be "<INTENT> → <role>" (INTENT: ASK, HANDOFF, VERDICT, ANSWER, DONE or NOTE)')
    return out
  }
  out.found = true
  const intent = (out.intent = h[1]), spec = INTENTS[intent]
  out.to = h[2]
  out.re = h[3] ? Number(h[3]) : null
  if (out.re !== null && out.re < 1) errors.push('re #0: comments count from #1')
  const reviewer = o.reviewer || REVIEWER
  if (intent === 'VERDICT' && o.author !== undefined && String(o.author).split('/')[0] !== reviewer)
    errors.push(`only ${reviewer} writes a VERDICT (as only ${reviewer} signs off); ${o.author || 'nobody'} writes an ANSWER, a NOTE or a HANDOFF`)
  if (roles && ['ASK', 'HANDOFF', 'VERDICT'].includes(intent) && !roles.includes(out.to.split('/')[0]))
    errors.push(`${intent} → ${out.to}: ${an(intent)} goes to a role (${roles.join(', ')}); ask a person with an owner card, never in a message`)
  out.writing = writingCheck(`\n${lines.slice(1).join('\n')}`, o.writing && { roles: roles || [], ...o.writing }, errors)
  if (len(t) > MAX) errors.push(`the message is too long (${len(t)} characters; at most ${MAX}): put tables, logs and test output in an artifact (artifact <id> <file>) and link it`)

  const body = lines.slice(1)
  if (intent === 'NOTE') {
    if (!body.some((l) => l.trim())) errors.push('a NOTE needs one line of text after its header')
    for (const l of body) {
      const m = KEYLINE.exec(l.trim())
      if (m && ['Expect', 'Done when', 'Verify', 'By'].includes(m[1])) { errors.push(`a NOTE has no ${m[1]}: to ask for something, write an ASK or a HANDOFF`); break }
    }
    out.ok = errors.length === 0
    return out
  }
  const allowed = [...COMMON, ...spec.req, ...spec.opt]
  let last = null
  for (const raw of body) {
    const l = raw.trim()
    if (!l) { last = null; continue }
    const m = KEYLINE.exec(l)
    if (m && allowed.includes(m[1])) {
      if (m[1] in out.keys) { errors.push(`${m[1]} is there twice`); last = null; continue }
      out.keys[m[1]] = m[2]; last = m[1]
      if (!m[2]) errors.push(`${m[1]} is empty`)
      continue
    }
    if (last && CONT.test(raw)) { out.keys[last] += `\n${l}`; continue }
    if (m) errors.push(`${intent} has no key "${clip(m[1])}" (its keys: ${allowed.join(', ')})`)
    else errors.push(`line "${clip(l)}" is not "Key: value" (a list line "1. …" or "- …" goes under a key)`)
  }
  const k = out.keys
  for (const r of spec.req) if (!(r in k)) errors.push(`${r} is missing (required on ${an(intent)})`)
  if (intent === 'ANSWER' && out.re === null) errors.push('an ANSWER says what it answers: "ANSWER → <role> · re #<n>"')
  if (k.Head && !HEAD.test(k.Head)) errors.push('Head is not <repo>@<sha> (repo: a lowercase letter, then up to 30 of a-z, 0-9, -; sha: 7 to 40 lowercase hex)')
  if (intent === 'VERDICT' && k.Result && !/^(signed off|blocked)\b/.test(k.Result)) errors.push('Result on a VERDICT is "signed off" or "blocked"')

  // the expectation: one role, one instruction, a visible result, a check, a time and what happens else
  if (!('Expect' in k)) errors.push(`Expect is missing (${spec.expect === 'none' ? '"Expect: none"' : spec.expect === 'any' ? '"Expect: none" or "Expect: <role>: <one instruction>"' : '"Expect: <role>: <one instruction>"'})`)
  else if (k.Expect) {
    const none = /^none\.?$/i.test(k.Expect), e = EXPECT.exec(k.Expect)
    if (none) {
      if (spec.expect === 'role') errors.push(`Expect on ${an(intent)} names a role and one instruction ("Expect: <role>: <instruction>"), never none`)
    } else if (spec.expect === 'none') errors.push(`Expect on a DONE is "none": a follow-up is a new item (Follow-ups) or a new ASK`)
    else if (!e) errors.push('Expect is not "<role>: <one instruction>" (or "none")')
    else {
      out.expect = { role: e[1], action: e[2] }
      if (roles && !roles.includes(e[1])) errors.push(`Expect names "${clip(e[1])}", not a role (${roles.join(', ')}); ask a person with an owner card, never in a message`)
      const words = e[2].replace(/`[^`]*`/g, 'x').split(/\s+/).filter(Boolean).length
      if (words > MAX_EXPECT_WORDS) errors.push(`Expect is ${words} words (at most ${MAX_EXPECT_WORDS}): one instruction, the verb first`)
    }
  }
  if (out.expect) for (const r of ['Done when', 'Verify', 'By']) if (!(r in k)) errors.push(`${r} is missing (required with "Expect: <role>: …")`)
  if (!out.expect && (intent === 'ANSWER' || intent === 'DONE') && !('Verify' in k)) errors.push(`Verify is missing: on ${intent === 'ANSWER' ? 'an ANSWER' : 'a DONE'} it points to the evidence ("<check> → <what it shows>")`)
  if (k.Verify && !ARROW.test(k.Verify)) errors.push('Verify is not "<the exact check> → <the expected output>"')
  if (k.By) {
    const b = BY.exec(k.By)
    if (!b) errors.push('By is not "next wake|today|hh:mm UTC|YYYY-MM-DD [hh:mm UTC] · Else: <what happens>"')
    else {
      out.by = b[1]
      if ((b[2] && Number(b[2]) > 23) || (b[5] && Number(b[5]) > 23)) errors.push('By: the hour is 00 to 23')
    }
  }
  out.ok = errors.length === 0
  return out
}

/**
 * When a message's By falls due (ms since epoch), from the time it was written. null: no By, or one not read.
 * @param {string|null} by  parseMessage(...).by
 * @param {string|number|Date} at  when the comment was written
 * @param {number} [nextWakeMin]  how long "next wake" may take (minutes; default 60)
 */
export function dueAt(by, at, nextWakeMin = 60) {
  const t = new Date(at).getTime()
  if (!by || !Number.isFinite(t)) return null
  if (by === 'next wake') return t + nextWakeMin * 60000
  const d = new Date(t)
  const day = (y, mo, da, hh = 0, mm = 0) => Date.UTC(y, mo, da, hh, mm)
  if (by === 'today') return day(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  let m = /^([0-9]{2}):([0-9]{2}) UTC$/.exec(by)
  if (m) {
    let due = day(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), +m[1], +m[2])
    if (due <= t) due += 86400000 // a time already past that day means the next day's
    return due
  }
  m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?: ([0-9]{2}):([0-9]{2}) UTC)?$/.exec(by)
  if (m) return m[4] ? day(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : day(+m[1], +m[2] - 1, +m[3] + 1)
  return null
}

/**
 * What waits on whom on one item: each valid ASK or HANDOFF that no later message answers ("re #<n>").
 * @param {{ author?: string, text?: string, created_at?: string }[]} comments  the item's comments, in thread order
 * @param {{ roles?: string[], reviewer?: string, nextWakeMin?: number, now?: number }} [o]  each comment is read with its
 *   author: a VERDICT not by the reviewer neither waits nor answers
 * @returns {{ n: number, intent: string, from: string, to: string, role: string, action: string, by: string|null,
 *   due: number|null, late: boolean }[]}  role: who must act (the Expect's role); late: its By has passed (now)
 */
export function openWaits(comments, o = {}) {
  const list = Array.isArray(comments) ? comments : []
  const msgs = list.map((c, k) => ({ c, n: k + 1, m: parseMessage(c?.text, { roles: o.roles, reviewer: o.reviewer, author: String(c?.author ?? '') }) }))
  const answered = new Set(msgs.filter((x) => x.m.ok && x.m.re !== null).map((x) => `${x.m.re}<${x.n}`))
  const now = o.now ?? Date.now()
  const out = []
  for (const { c, n, m } of msgs) {
    if (!m.ok || !WAITING.includes(m.intent) || !m.expect) continue
    let done = false
    for (let j = n + 1; j <= msgs.length && !done; j++) done = answered.has(`${n}<${j}`)
    if (done) continue
    const due = dueAt(m.by, c.created_at, o.nextWakeMin)
    out.push({ n, intent: m.intent, from: String(c.author ?? ''), to: m.to, role: m.expect.role, action: m.expect.action, by: m.by, due, late: due !== null && now > due })
  }
  return out
}
