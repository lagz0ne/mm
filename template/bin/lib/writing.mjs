// The writing check (sy-ko6r): words between roles and to the owner follow ASD-STE100's rules, with our own word list
// (ASD's dictionary is ASD's: it is not copied here). The rules:
//   word       only an approved word (bin/lib/words.txt: common English, one meaning and one part of speech each) or a
//              glossary term (glossary.yaml, glossary.local.yaml: technical names and technical verbs)
//   sentence   a procedural sentence (an instruction: it starts with a verb) has at most 20 words; a descriptive one 25
//   paragraph  at most 6 sentences
//   passive    active voice ("review signs off the head", not "the head is signed off")      (a warning only)
//   ing        no -ing form ("the check of the head", not "the checking of the head")         (a warning only)
// Not words, so never checked (but counted in a sentence's length): numbers, ids (sy-ko6r), heads (mm@abc1234), paths,
// commands and flags, URLs, anything in `code marks` or a ``` block, a message's keys (Expect:, Head: ...) and an
// owner card's (**What:** ...), role names, #n, acronyms (UTC) and names (a capital inside a sentence).
// passive and ing are heuristics (no parser): they warn, and never refuse. The others refuse from the glossary's
// refuse_from date on (refusing); before it, or with no date, they are warnings.
// Pure, no imports: bin/message and bin/owner-card (through message.mjs and owner-card.mjs, one call each), config-check,
// and, as an identical copy, the board's browser code (site/src/lib/writing.mjs; test/writing.mjs keeps them equal).

export const MAX_PROCEDURAL = 20
export const MAX_DESCRIPTIVE = 25
export const MAX_PARAGRAPH = 6
/** The rules that only warn (heuristics), whatever the date. */
export const SOFT = ['passive', 'ing']
/** At most this many writing problems go into a refusal's reasons (the rest are counted). */
export const MAX_REASONS = 8

/**
 * Read the approved word list: one word per line, then optionally its part of speech (n, v, adj, adv, prep, conj,
 * pron, det, num, int), and for a form of another word ":<base>" (e.g. "wrote v:write"). "#" starts a comment.
 * @param {string} text
 * @returns {Map<string, { pos: string, base: string }>}  key: the word, lowercase
 */
export function parseWords(text) {
  const m = new Map()
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.replace(/#.*$/, '').trim()
    if (!l) continue
    const [w, p = ''] = l.split(/\s+/)
    const [pos, base = ''] = p.split(':')
    m.set(w.toLowerCase(), { pos, base: base.toLowerCase() })
  }
  return m
}

/** Is the writing check refusing on this day? From refuse_from (YYYY-MM-DD, UTC) on; never with no date. */
export function refusing(refuseFrom, today = new Date()) {
  if (!refuseFrom || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(refuseFrom))) return false
  const d = today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10)
  return d >= String(refuseFrom)
}

const BE = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'am'])
const BETWEEN = new Set(['not', 'now', 'only', 'also', 'already', 'always', 'never', 'then', 'still', 'all', 'often', 'just', 'again'])
const PARTICIPLE = new Set(['done', 'made', 'written', 'given', 'taken', 'seen', 'known', 'shown', 'sent', 'built', 'kept', 'put',
  'held', 'found', 'left', 'lost', 'told', 'gotten', 'broken', 'chosen', 'driven', 'drawn', 'forgotten', 'hidden', 'spoken', 'thrown',
  'run', 'set', 'read', 'begun', 'brought', 'bought', 'caught', 'taught', 'thought', 'meant', 'paid', 'said', 'sold', 'won', 'stuck'])
const LEADERS = new Set(['never', 'always', 'only', 'first', 'then', 'also', 'please', 'just', 'now', 'next', 'do', 'don\'t'])
const SEP = new Set(['·', '→', '->', '|', '—', '–', '-', '/', '=', '+', '&', '…', '...', '*', '>', '<'])
const ABBR = /\b(e\.g|i\.e|etc|vs|approx)\./gi
const PH = '\u0001' // a placeholder: code, a term, a link's address; counted as a word, never checked
const ID = /^[a-z]{1,8}-[a-z0-9]{2,8}(?:\.[0-9]+)*$/
const cache = new WeakMap()

/** The glossary's terms as one pattern (longest first), and the single-word ones as a set. Technical verbs take the
 * forms -s, -es, -ed, -d on their first word ("signs off", "claimed"). */
function termsOf(terms) {
  const key = Array.isArray(terms) ? terms : []
  if (cache.has(key)) return cache.get(key)
  const list = key.map((t) => (typeof t === 'string' ? { term: t, kind: '' } : t)).filter((t) => t && typeof t.term === 'string' && t.term.trim())
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const parts = list.map((t) => t.term.trim()).sort((a, b) => b.length - a.length).map((t) => {
    const [first, ...rest] = t.split(/\s+/)
    return esc(first) + '(?:s|es|ed|d|\'s)?' + rest.map((r) => '\\s+' + esc(r)).join('') + (rest.length ? '(?:s|es|\'s)?' : '')
  })
  const verbs = new Set(list.filter((t) => t.kind === 'technical verb').map((t) => t.term.trim().split(/\s+/)[0].toLowerCase()))
  const v = { re: parts.length ? new RegExp(`(?<![\\w-])(?:${parts.join('|')})(?![\\w-])`, 'gi') : null, verbs }
  cache.set(key, v)
  return v
}

/** Is `w` (lowercase, no -ing) a known word: in the list, or a regular form of one (its part of speech allows it)? */
function known(w, words) {
  if (words.has(w)) return true
  const has = (s, ...pos) => { const e = words.get(s); return !!e && (!e.pos || pos.includes(e.pos)) }
  const dbl = (s) => s.length > 2 && s.at(-1) === s.at(-2) ? s.slice(0, -1) : null
  if (w.endsWith('\'s') && known(w.slice(0, -2), words)) return true
  if (w.endsWith('s') && has(w.slice(0, -1), 'n', 'v', 'num', 'pron')) return true
  if (w.endsWith('es') && has(w.slice(0, -2), 'n', 'v')) return true
  if (w.endsWith('ies') && has(`${w.slice(0, -3)}y`, 'n', 'v')) return true
  if (w.endsWith('ed')) {
    const s = w.slice(0, -2)
    if (has(s, 'v') || has(`${s}e`, 'v') || has(w.slice(0, -1), 'v') || (dbl(s) && has(dbl(s), 'v'))) return true
    if (w.endsWith('ied') && has(`${w.slice(0, -3)}y`, 'v')) return true
  }
  if (w.endsWith('er') || w.endsWith('est')) {
    const s = w.endsWith('er') ? w.slice(0, -2) : w.slice(0, -3)
    if (has(s, 'adj') || has(`${s}e`, 'adj') || (dbl(s) && has(dbl(s), 'adj')) || (s.endsWith('i') && has(`${s.slice(0, -1)}y`, 'adj'))) return true
  }
  if (w.endsWith('ly')) {
    const s = w.slice(0, -2)
    if (has(s, 'adj') || (s.endsWith('i') && has(`${s.slice(0, -1)}y`, 'adj'))) return true
  }
  return false
}
/** The verb an -ing form comes from, when it is known ("checking" -> "check"); null otherwise. */
function ingStem(w, words) {
  const s = w.slice(0, -3)
  for (const c of [s, `${s}e`, s.length > 2 && s.at(-1) === s.at(-2) ? s.slice(0, -1) : null]) if (c && known(c, words)) return c
  return null
}

/**
 * Check a text against the writing rules.
 * @param {string} text
 * @param {{ terms?: ({term: string, kind?: string}|string)[], words?: Map<string,{pos:string,base:string}>|string,
 *   roles?: string[] }} [o]  terms: the glossary's entries; words: parseWords(...) or the list's text; roles: the
 *   board's role ids (never checked as words)
 * @returns {{ rule: string, line: number, text: string }[]}  line: 1-based, in `text`; each unknown word once
 */
export function checkWriting(text, o = {}) {
  const words = o.words instanceof Map ? o.words : parseWords(o.words || '')
  const T = termsOf(o.terms)
  const roles = new Set((o.roles || []).map((r) => String(r).toLowerCase()))
  const out = [], seen = new Set()
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  /** paragraphs: [{ line, sentences: [{ line, toks: [{ w, line, check }] }] }] */
  const paras = []
  let para = null, sent = null, fence = false
  const endSentence = () => { if (sent && sent.toks.length) para.sentences.push(sent); sent = null }
  const endPara = () => { if (para) { endSentence(); if (para.sentences.length) paras.push(para) } para = null }
  lines.forEach((raw, k) => {
    const n = k + 1
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; endPara(); return }
    if (fence) return
    let l = raw.trim()
    if (!l) { endPara(); return }
    // a new paragraph: a heading, a list item, a quote, a table row, a "Key: value" line
    const start = /^(#{1,6}\s|[-*+]\s|[0-9]+[.)]\s|>|\|)/.test(l) || /^\**[A-Z][A-Za-z-]*(?: [a-z][a-z-]*)?:\**\s/.test(l)
    if (start || !para) { endPara(); para = { line: n, sentences: [] } }
    if (/^#{1,6}\s/.test(l)) { endPara(); return } // a heading is a name, not a sentence
    if (/^\|/.test(l)) { endPara(); return } // a table row
    l = l.replace(/^(?:[-*+]|[0-9]+[.)]|>)\s+/, '').replace(/^\*\*([^*]+?):\*\*\s*/, '')
    for (let i = 0; i < 3; i++) l = l.replace(/^(?:[A-Z][A-Za-z-]*(?: [a-z][a-z-]*)?|[a-z][a-z0-9_/-]*):\s+/, '')
    l = l.replace(/`[^`]*`/g, ` ${PH} `).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<?https?:\/\/[^\s>)]+>?/g, PH)
      .replace(/\*\*|__/g, '').replace(ABBR, PH)
    if (T.re) l = l.replace(T.re, (m) => `${PH}${T.verbs.has(m.split(/\s+/)[0].toLowerCase().replace(/(?:es|ed|s|d|'s)$/, '')) || T.verbs.has(m.split(/\s+/)[0].toLowerCase()) ? 'V' : ''}`)
    for (const chunk of l.split(/\s+/).filter(Boolean)) {
      if (chunk === '·') { endSentence(); continue }
      if (SEP.has(chunk)) continue
      let w = chunk.replace(/^["'“‘(\[{*_]+/, '')
      const tail = /["'”’)\]}*_.,;:!?]+$/.exec(w)?.[0] ?? ''
      w = w.slice(0, w.length - tail.length)
      if (!sent) sent = { line: n, toks: [] }
      if (w) sent.toks.push({ w, line: n, first: sent.toks.length === 0 })
      if (/[.!?]/.test(tail)) endSentence()
    }
  })
  endPara()

  const add = (rule, line, t) => out.push({ rule, line, text: t })
  for (const p of paras) {
    if (p.sentences.length > MAX_PARAGRAPH) add('paragraph', p.line, `a paragraph of ${p.sentences.length} sentences (at most ${MAX_PARAGRAPH}): make two`)
    for (const s of p.sentences) {
      // procedural: it starts with a verb (an approved base verb, a technical verb), after "never", "then", ...
      const lead = s.toks.map((t) => t.w.toLowerCase()).filter((x) => !LEADERS.has(x) && x !== 'not')[0] ?? ''
      const proc = lead === `${PH}v` || words.get(lead)?.pos === 'v' && !words.get(lead)?.base
      const max = proc ? MAX_PROCEDURAL : MAX_DESCRIPTIVE
      if (s.toks.length > max) add('sentence', s.line, `${proc ? 'an instruction' : 'a sentence'} of ${s.toks.length} words (at most ${max}): make it shorter, or make two`)
      let prev = '', prev2 = ''
      for (const t of s.toks) {
        const w = t.w
        const low = w.toLowerCase()
        const check = !w.startsWith(PH) && !/[0-9@/\\=_<>~$#`*{}[\]()"“”:,;|]/.test(w) && !/^[-+]/.test(w) && !/\w\.\w/.test(w)
          && !/^#?[0-9]/.test(w) && !(w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) && !(!t.first && /^[A-Z]/.test(w) && low !== 'i')
          && !roles.has(low) && /[a-z]/i.test(w)
        if (check) {
          if (BE.has(prev) || (BETWEEN.has(prev) && BE.has(prev2))) {
            const e = words.get(low)
            if ((low.endsWith('ed') || PARTICIPLE.has(low)) && e?.pos !== 'adj') add('passive', t.line, `"${prev2 && BETWEEN.has(prev) ? `${prev2} ${prev}` : prev} ${w}": write it in the active voice (who does what)`)
          }
          const parts = low.includes('-') ? low.split('-').filter(Boolean) : [low]
          const isId = low.includes('-') && ID.test(low) && !parts.every((x) => known(x, words))
          if (!isId) for (const x of parts) {
            if (known(x, words)) continue
            if (x.endsWith('ing') && x.length > 4 && ingStem(x, words)) {
              if (!seen.has(`ing:${x}`)) { seen.add(`ing:${x}`); add('ing', t.line, `"${x}": no -ing form; write the verb ("${ingStem(x, words)}") or a noun`) }
            } else if (!seen.has(`word:${x}`)) { seen.add(`word:${x}`); add('word', t.line, `"${x}" is not an approved word or a glossary term`) }
          }
        }
        prev2 = prev; prev = low
      }
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/**
 * The hook (message.mjs, owner-card.mjs: one call each): check `text` when a writing setting with a word list is given
 * (a board with no bin/lib/words.txt is not checked); on and after
 * its refuseFrom the hard problems also go into `errors` (at most MAX_REASONS lines, then a count).
 * @param {string} text
 * @param {{ terms?: any[], words?: any, roles?: string[], refuseFrom?: string, today?: Date|string }|undefined} w
 * @param {string[]} errors  the caller's list of errors (appended to)
 * @returns {{ rule: string, line: number, text: string }[]}  every problem (the warnings)
 */
export function writingCheck(text, w, errors) {
  if (!w || !(w.words instanceof Map ? w.words.size : String(w.words || '').trim())) return [] // no word list: no check
  const ps = checkWriting(text, w)
  if (refusing(w.refuseFrom, w.today)) {
    const hard = ps.filter((p) => !SOFT.includes(p.rule))
    for (const p of hard.slice(0, MAX_REASONS)) errors.push(`writing (ASD-STE100), line ${p.line}: ${p.text}`)
    if (hard.length > MAX_REASONS) errors.push(`writing (ASD-STE100): ${hard.length - MAX_REASONS} more`)
  }
  return ps
}

/** One line per problem, for stderr: "  - <rule>, line <n>: <text>". */
export const sayWriting = (ps) => ps.map((p) => `  - ${p.rule}, line ${p.line}: ${p.text}`).join('\n')
