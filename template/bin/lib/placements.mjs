// The monitored placements (sy-rfup, step 1): what goes into the free field `misc` of the structured blocks (messages,
// Tasks, owner cards; bin/lib/structured.mjs), counted, so that a shape that comes back often can become a typed field
// in v2. Data only, no judgement: per kind of block and type of part, how many, their size (characters of the part's
// own content: text, markdown, mermaid, html, svg or log; a table's cells; an artifact's path), median and max, and for
// text parts the most common leading words. The Supervisor puts it in its daily section (placements:daily).
// misc is the last resort, for content no typed field can hold. So the report also flags the misc text parts that look
// like the content of a typed field the block has (FLAGS: one simple pattern per field; a field counts only where its
// block's schema allows it, e.g. followUps on a DONE, not on a NOTE), per field: how many, on which items. Data only: it
// never changes a message.
// Pure; imports only structured.mjs (readBlock) and schemas.mjs (to know which fields a block allows).
import { PART_TYPES, SCHEMA_ID, readBlock } from './structured.mjs'
import { SCHEMAS } from './schemas.mjs'

// An item id: a known id of the board (o.ids), or an id shape with a digit in it (sy-ab1c).
const ID = /(?<![\w@/.-])[a-z]{2,8}-[a-z0-9]{3,12}(?:\.[0-9]+)*(?![\w@/-])/g

// The misc flags: a typed field, and what a misc text part looks like that it could hold. In this order in the report.
// `id: true`: the pattern is an item id (see ID).
export const FLAGS = [
  { field: 'head', is: '<repo>@<sha> (7 to 40 hex)', re: /(?<![\w.-])[a-z][a-z0-9-]{0,30}@[0-9a-f]{7,40}\b/ },
  { field: 're', is: 're #<n>', re: /\bre #[0-9]+\b/i },
  { field: 'result', is: 'signed off, sign-off given, blocked, partial, dropped', re: /\b(?:signed[- ]off|sign-off given|blocked|partial|dropped)\b/i },
  { field: 'verify', is: 'a check -> expect pair: `cmd`, or check/run ..., then ->, => or →', re: /(?:`[^`\n]+`|\b(?:check|run)\b[^\n]{1,80}?)\s*(?:->|=>|→)\s*\S/i },
  { field: 'by', is: 'by next-wake, today, tomorrow, hh:mm or YYYY-MM-DD', re: /\bby (?:next[- ]wake|today|tomorrow|(?:[01][0-9]|2[0-3]):[0-5][0-9]|[0-9]{4}-[0-9]{2}-[0-9]{2})\b/i },
  { field: 'tests', is: '<n>/<m> passed, <n> passed, <n> failed', re: /\b[0-9]+\s*\/\s*[0-9]+\s+(?:passed|pass|ok)\b|\b[0-9]+ (?:passed|failed)\b/i },
  { field: 'followUps', is: 'an item id', id: true },
  { field: 'open', is: 'an item id', id: true },
  { field: 'artifacts', is: 'a path with a / and a file type (.md, .html, .png, .jpg, .svg, .json, .log, .txt, .csv, .pdf)',
    re: /(?<![\w/.:-])[A-Za-z0-9_][\w.-]*\/[\w./-]*\.(?:md|html?|png|jpe?g|svg|json|log|txt|csv|pdf)\b/ },
  { field: 'rollback', is: 'rollback, roll back, revert', re: /\b(?:roll ?back|revert)\b/i },
  { field: 'risk', is: 'lockout, data loss, downtime, exposure', re: /\b(?:lockout|data[- ]loss|downtime|exposure)\b/i },
  { field: 'link', is: 'an http(s) URL', re: /\bhttps?:\/\/[^\s<>"]+/ },
]

const SCHEMA = Object.fromEntries(Object.entries(SCHEMA_ID).map(([k, id]) => [k, SCHEMAS.find((s) => s.$id === id)]))

// Whether a block of this kind, with this data, may hold the field: the field is in its schema's properties, and no
// then-branch that applies (an if on consts, e.g. intent NOTE) sets it to false.
export function allows(kind, data, field) {
  const s = SCHEMA[kind]
  if (!s?.properties?.[field]) return false
  for (const a of s.allOf || []) {
    const conds = Object.entries(a.if?.properties || {})
    if (!conds.length || !conds.every(([k, v]) => v && 'const' in v && data?.[k] === v.const)) continue
    if (a.then?.properties?.[field] === false) return false
  }
  return true
}

// The fields of FLAGS a misc text could go in, for a block of this kind and data. ids: the board's item ids (a Set).
export function flagsOf(kind, data, text, ids) {
  const t = String(text ?? '')
  const hasId = () => [...t.matchAll(ID)].some((m) => ids?.has(m[0]) || /[0-9]/.test(m[0].slice(m[0].indexOf('-') + 1)))
  return FLAGS.filter((f) => allows(kind, data, f.field) && (f.id ? hasId() : f.re.test(t))).map((f) => f.field)
}

/** How many words of a text part make its "leading phrasing". */
export const LEAD_WORDS = 3
/** How many of the most common leading phrasings are listed. */
export const TOP = 5

/** The size of a part: its content's characters (a table: its cells' characters; an artifact: its path's). */
export function partSize(p) {
  if (!p || typeof p !== 'object') return 0
  for (const k of ['text', 'markdown', 'mermaid', 'html', 'svg', 'log']) if (typeof p[k] === 'string') return Array.from(p[k]).length
  if (p.type === 'table') return [...(Array.isArray(p.columns) ? p.columns : []), ...(Array.isArray(p.rows) ? p.rows.flat() : [])].reduce((n, c) => n + Array.from(String(c ?? '')).length, 0)
  return typeof p.artifact === 'string' ? Array.from(p.artifact).length : 0
}

/** The leading phrasing of a text: its first LEAD_WORDS words, lowercase, with no punctuation at their ends. */
export const leading = (s, n = LEAD_WORDS) => String(s ?? '').toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean).slice(0, n).join(' ')

const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2) }

/**
 * Count the misc parts of some texts (comments, descriptions). A text that is no block, or a block that cannot be read,
 * is counted as such and has no misc. A text is a string, or { id, text } (its item's id, for the flags' item list).
 * @param {(string | { id?: string, text: string })[]} texts
 * @param {{ ids?: Set<string> }} [o] ids: the board's item ids (one in a misc text counts for followUps and open)
 * @returns {{ blocks: Record<string, { n: number, withMisc: number }>, unread: number,
 *   rows: { kind: string, type: string, count: number, median: number, max: number, leads: { text: string, n: number }[] }[],
 *   flags: { field: string, count: number, ids: string[] }[] }}
 *   rows: one per kind and type that occurs (kinds message, task, card; types in PART_TYPES order); leads: text parts only;
 *   flags: one per field of FLAGS with at least one misc text part, in FLAGS order; ids: its items, sorted, once each
 */
export function countPlacements(texts, { ids } = {}) {
  const blocks = {}, sizes = new Map(), leads = new Map(), flags = new Map()
  let unread = 0
  const add = (kind, p) => {
    const type = PART_TYPES.includes(p?.type) ? p.type : 'other', k = `${kind}\u0000${type}`
    ;(sizes.get(k) || sizes.set(k, []).get(k)).push(partSize(p))
    if (type === 'text') { const l = leading(p.text); if (l) { const m = leads.get(k) || leads.set(k, new Map()).get(k); m.set(l, (m.get(l) || 0) + 1) } }
  }
  for (const t of Array.isArray(texts) ? texts : []) {
    const id = t && typeof t === 'object' ? String(t.id ?? '') : ''
    // a description: the card block, then the Task block after it
    let rest = String((t && typeof t === 'object' ? t.text : t) ?? ''), seen = 0
    for (let b = readBlock(rest); b && seen < 2; b = readBlock(rest), seen++) {
      if (b.errors.length || !b.data) { unread++; break }
      const s = (blocks[b.kind] ||= { n: 0, withMisc: 0 })
      s.n++
      const parts = Array.isArray(b.data.misc) ? b.data.misc : []
      if (parts.length) s.withMisc++
      for (const p of parts) {
        add(b.kind, p)
        if (p?.type !== 'text' || typeof p.text !== 'string') continue
        for (const field of flagsOf(b.kind, b.data, p.text, ids)) {
          const f = flags.get(field) || flags.set(field, { count: 0, ids: new Set() }).get(field)
          f.count++
          if (id) f.ids.add(id)
        }
      }
      rest = b.rest
    }
  }
  const order = (k) => { const [kind, type] = k.split('\u0000'); return [['message', 'task', 'card'].indexOf(kind), [...PART_TYPES, 'other'].indexOf(type)] }
  const rows = [...sizes.keys()].sort((a, b) => { const [x1, y1] = order(a), [x2, y2] = order(b); return x1 - x2 || y1 - y2 }).map((k) => {
    const [kind, type] = k.split('\u0000'), xs = sizes.get(k)
    const top = [...(leads.get(k) || new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP).map(([text, n]) => ({ text, n }))
    return { kind, type, count: xs.length, median: median(xs), max: Math.max(...xs), leads: top }
  })
  const fl = FLAGS.filter((f) => flags.has(f.field)).map((f) => ({ field: f.field, count: flags.get(f.field).count, ids: [...flags.get(f.field).ids].sort() }))
  return { blocks, unread, rows, flags: fl }
}

/** The counts as Markdown: one table, then the leading phrasings of the text parts. No judgement, only the numbers. */
export function formatPlacements(c, { since = '' } = {}) {
  const kinds = ['message', 'task', 'card'].filter((k) => c.blocks[k])
  const head = `Structured blocks${since ? ` since ${since}` : ''}: ${kinds.length ? kinds.map((k) => `${c.blocks[k].n} ${k}${c.blocks[k].n === 1 ? '' : 's'} (${c.blocks[k].withMisc} with misc)`).join(', ') : 'none'}` +
    `${c.unread ? `; ${c.unread} block(s) that cannot be read` : ''}.`
  if (!c.rows.length) return `${head}\n\nNo misc.`
  const table = ['| block | part | count | median size | max size |', '|---|---|---:|---:|---:|', ...c.rows.map((r) => `| ${r.kind} | ${r.type} | ${r.count} | ${r.median} | ${r.max} |`)].join('\n')
  const ls = c.rows.filter((r) => r.leads.length).map((r) => `- ${r.kind}, text: ${r.leads.map((l) => `"${l.text.replace(/[|`"]/g, '')}" ${l.n}`).join(', ')}`)
  const fl = (c.flags || []).map((f) => `| ${f.field} | ${(FLAGS.find((x) => x.field === f.field)?.is || '').replace(/[|`]/g, '')} | ${f.count} | ${f.ids.join(', ')} |`)
  return `${head}\n\n${table}${ls.length ? `\n\nThe most common leading words of the text parts (${LEAD_WORDS} words):\n\n${ls.join('\n')}` : ''}` +
    (fl.length ? '\n\nMisc text a typed field could hold (one pattern per field, bin/lib/placements.mjs FLAGS; only where the block allows the field):\n\n' +
      `| field | looks like | text parts | items |\n|---|---|---:|---|\n${fl.join('\n')}` : '')
}
