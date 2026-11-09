// The glossary (sy-ko6r): the board's technical names and technical verbs, one meaning each, governed like the rest of
// the config (the leads' brief, "Glossary"). Two files at the board's root:
//   glossary.yaml        the template's (mm update brings its changes); its top level also holds refuse_from: the
//                        day the writing check starts to refuse (empty: it only warns)
//   glossary.local.yaml  the board's own (not in the template, so mm update never writes it): it adds terms only;
//                        a term that is also in glossary.yaml, or a refuse_from, is a config-check error
// The format, a small YAML subset (no dependency):
//   refuse_from: 2026-12-01
//   terms:
//     - term: owner card
//       kind: technical name          # technical name | technical verb | approved word
//       means: The short block at the top of an item that asks the owner one thing.
//       not: card, summary            # words to use instead, or not to confuse it with
//       owner: setup                  # the role that keeps the term
//       since: 2026-11-08 sy-ko6r     # the date it came in, and the item
// The approved word list (bin/lib/words.txt) is read here too; the check itself is writing.mjs.
// Pure, no imports: readGlossary takes a reader. Used by bin/message, bin/owner-card, config-check, the board's server
// and, as an identical copy, the board's browser code (site/src/lib/glossary.mjs; test/glossary.mjs keeps them equal).

export const KINDS = ['technical name', 'technical verb', 'approved word']
export const FIELDS = ['term', 'kind', 'means', 'not', 'owner', 'since']
export const REQUIRED = ['term', 'kind', 'means', 'owner', 'since']
export const FILE = 'glossary.yaml', LOCAL = 'glossary.local.yaml', WORDS = 'bin/lib/words.txt'
const SINCE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?: [a-z]+-[a-z0-9]+(?:\.[0-9]+)*)?$/
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

const unquote = (v) => {
  const s = v.trim()
  if (/^"(.*)"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  if (/^'(.*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'")
  return s.replace(/\s+#.*$/, '').trim()
}

/**
 * Read one glossary file.
 * @param {string} text
 * @param {string} [file]  its name, for the errors
 * @returns {{ refuseFrom: string|null, hasRefuseFrom: boolean, entries: Record<string,string>[], errors: string[] }}
 */
export function parseGlossary(text, file = FILE) {
  const errors = [], entries = []
  let refuseFrom = null, hasRefuseFrom = false, inTerms = false, cur = null
  String(text ?? '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, k) => {
    const n = k + 1, l = raw.replace(/\s+$/, '')
    if (!l.trim() || /^\s*#/.test(l)) return
    let m
    if ((m = /^([a-z_]+):(?:\s+(.*))?$/.exec(l))) {
      inTerms = false; cur = null
      if (m[1] === 'refuse_from') { hasRefuseFrom = true; refuseFrom = unquote(m[2] ?? '') || null; if (refuseFrom && !DATE.test(refuseFrom)) errors.push(`${file}:${n}: refuse_from is a date (YYYY-MM-DD) or empty`) }
      else if (m[1] === 'terms') { inTerms = true; if (m[2] && unquote(m[2]) !== '[]') errors.push(`${file}:${n}: terms is a list ("terms:", then "  - term: ...")`) }
      else errors.push(`${file}:${n}: unknown key "${m[1]}" (the keys: refuse_from, terms)`)
      return
    }
    if (!inTerms) { errors.push(`${file}:${n}: not "key: value" (a term goes under "terms:")`); return }
    if ((m = /^\s+-\s+([a-z_]+):(?:\s+(.*))?$/.exec(l))) { cur = { _line: n }; entries.push(cur) }
    else if (!(m = /^\s+([a-z_]+):(?:\s+(.*))?$/.exec(l)) || !cur) { errors.push(`${file}:${n}: not "  - term: ..." or "    key: value"`); return }
    if (!FIELDS.includes(m[1])) errors.push(`${file}:${n}: unknown field "${m[1]}" (the fields: ${FIELDS.join(', ')})`)
    else if (m[1] in cur) errors.push(`${file}:${n}: ${m[1]} is there twice`)
    else cur[m[1]] = unquote(m[2] ?? '')
  })
  for (const e of entries) {
    const at = `${file}:${e._line}`
    for (const r of REQUIRED) if (!e[r]) errors.push(`${at}: ${e.term || 'a term'} has no ${r}`)
    if (e.kind && !KINDS.includes(e.kind)) errors.push(`${at}: ${e.term}: kind is one of ${KINDS.join(', ')}`)
    if (e.means && (!/[.]$/.test(e.means) || /[.!?]\s+\S/.test(e.means.replace(/\b(e\.g|i\.e)\./g, '')))) errors.push(`${at}: ${e.term}: means is one plain sentence, with a full stop`)
    if (e.since && !SINCE.test(e.since)) errors.push(`${at}: ${e.term}: since is "YYYY-MM-DD <item id>"`)
  }
  const seen = new Map()
  for (const e of entries) {
    const key = String(e.term || '').toLowerCase()
    if (!key) continue
    if (seen.has(key)) errors.push(`${file}:${e._line}: the term "${e.term}" is there twice (also line ${seen.get(key)}): one term, one meaning`)
    else seen.set(key, e._line)
  }
  return { refuseFrom, hasRefuseFrom, entries, errors }
}

/**
 * The template's glossary and the board's own, merged: the local file adds terms only.
 * @param {ReturnType<typeof parseGlossary>} base
 * @param {ReturnType<typeof parseGlossary>|null} local
 * @returns {{ refuseFrom: string|null, entries: (Record<string,string> & {source: string})[], errors: string[] }}
 */
export function mergeGlossary(base, local) {
  const errors = [...base.errors]
  const entries = base.entries.map((e) => ({ ...e, source: FILE }))
  if (local) {
    errors.push(...local.errors)
    if (local.hasRefuseFrom) errors.push(`${LOCAL}: no refuse_from here (the template's ${FILE} sets it)`)
    const have = new Set(entries.map((e) => String(e.term).toLowerCase()))
    for (const e of local.entries) {
      if (have.has(String(e.term).toLowerCase())) { errors.push(`${LOCAL}:${e._line}: "${e.term}" is a term of ${FILE}: the local file adds terms, it never changes one`); continue }
      entries.push({ ...e, source: LOCAL })
    }
  }
  return { refuseFrom: base.refuseFrom, entries, errors }
}

/**
 * Read a board's glossary and word list.
 * @param {(rel: string) => string|null} read  the text of a file under the board's root, null when it is missing
 * @returns {{ refuseFrom: string|null, entries: object[], terms: object[], words: string, errors: string[] }}
 *   terms: the entries (term, kind) for writing.mjs; words: the word list's text (writing.mjs parses it)
 */
export function readGlossary(read) {
  const b = read(FILE), l = read(LOCAL)
  const base = b === null ? { refuseFrom: null, hasRefuseFrom: false, entries: [], errors: [] } : parseGlossary(b, FILE)
  const g = mergeGlossary(base, l === null ? null : parseGlossary(l, LOCAL))
  const words = read(WORDS) ?? ''
  return { ...g, terms: g.entries.map((e) => ({ term: e.term, kind: e.kind })), words }
}

/**
 * Check the word list's format: "word [pos[:base]]", lowercase, each word once, a known part of speech.
 * @param {string} text
 * @returns {string[]} the errors
 */
export function checkWords(text) {
  const POS = ['', 'n', 'v', 'adj', 'adv', 'prep', 'conj', 'pron', 'det', 'num', 'int']
  const errors = [], seen = new Map()
  String(text ?? '').split('\n').forEach((raw, k) => {
    const l = raw.replace(/#.*$/, '').trim()
    if (!l) return
    const at = `${WORDS}:${k + 1}`
    const [w, p = '', more] = l.split(/\s+/)
    if (more !== undefined) errors.push(`${at}: one word per line, then its part of speech ("${l}")`)
    if (!/^[a-z][a-z'-]*$/.test(w)) errors.push(`${at}: "${w}" is not a lowercase word`)
    if (/ing$/.test(w) && w.length > 5 && !p) errors.push(`${at}: "${w}": an -ing form is no approved word (give a part of speech if it is a noun of its own, e.g. "thing n")`)
    const [pos, base] = p.split(':')
    if (!POS.includes(pos)) errors.push(`${at}: "${w}": part of speech is one of ${POS.filter(Boolean).join(', ')}`)
    if (base !== undefined && !/^[a-z]+$/.test(base)) errors.push(`${at}: "${w}": the base after ":" is a word`)
    if (seen.has(w)) errors.push(`${at}: "${w}" is there twice (also line ${seen.get(w)}): one word, one meaning`)
    else seen.set(w, k + 1)
  })
  return errors
}
