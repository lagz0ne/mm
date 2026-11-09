// The monitored placements (sy-rfup, step 1): what goes into the free field `parts` of the structured blocks (messages,
// Tasks, owner cards; bin/lib/structured.mjs), counted, so that a shape that comes back often can become a typed field
// in v2. Data only, no judgement: per kind of block and type of part, how many, their size (characters of the part's
// own content: text, markdown, mermaid, html, svg or log; a table's cells; an artifact's path), median and max, and for
// text parts the most common leading words. The Supervisor puts it in its daily section (placements:daily).
// Pure; imports only structured.mjs (readBlock).
import { PART_TYPES, readBlock } from './structured.mjs'

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
 * Count the parts of some texts (comments, descriptions). A text that is no block, or a block that cannot be read, is
 * counted as such and has no parts.
 * @param {string[]} texts
 * @returns {{ blocks: Record<string, { n: number, withParts: number }>, unread: number,
 *   rows: { kind: string, type: string, count: number, median: number, max: number, leads: { text: string, n: number }[] }[] }}
 *   rows: one per kind and type that occurs (kinds message, task, card; types in PART_TYPES order); leads: text parts only
 */
export function countPlacements(texts) {
  const blocks = {}, sizes = new Map(), leads = new Map()
  let unread = 0
  const add = (kind, p) => {
    const type = PART_TYPES.includes(p?.type) ? p.type : 'other', k = `${kind}\u0000${type}`
    ;(sizes.get(k) || sizes.set(k, []).get(k)).push(partSize(p))
    if (type === 'text') { const l = leading(p.text); if (l) { const m = leads.get(k) || leads.set(k, new Map()).get(k); m.set(l, (m.get(l) || 0) + 1) } }
  }
  for (const t of Array.isArray(texts) ? texts : []) {
    // a description: the card block, then the Task block after it
    let rest = String(t ?? ''), seen = 0
    for (let b = readBlock(rest); b && seen < 2; b = readBlock(rest), seen++) {
      if (b.errors.length || !b.data) { unread++; break }
      const s = (blocks[b.kind] ||= { n: 0, withParts: 0 })
      s.n++
      const parts = Array.isArray(b.data.parts) ? b.data.parts : []
      if (parts.length) s.withParts++
      for (const p of parts) add(b.kind, p)
      rest = b.rest
    }
  }
  const order = (k) => { const [kind, type] = k.split('\u0000'); return [['message', 'task', 'card'].indexOf(kind), [...PART_TYPES, 'other'].indexOf(type)] }
  const rows = [...sizes.keys()].sort((a, b) => { const [x1, y1] = order(a), [x2, y2] = order(b); return x1 - x2 || y1 - y2 }).map((k) => {
    const [kind, type] = k.split('\u0000'), xs = sizes.get(k)
    const top = [...(leads.get(k) || new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP).map(([text, n]) => ({ text, n }))
    return { kind, type, count: xs.length, median: median(xs), max: Math.max(...xs), leads: top }
  })
  return { blocks, unread, rows }
}

/** The counts as Markdown: one table, then the leading phrasings of the text parts. No judgement, only the numbers. */
export function formatPlacements(c, { since = '' } = {}) {
  const kinds = ['message', 'task', 'card'].filter((k) => c.blocks[k])
  const head = `Structured blocks${since ? ` since ${since}` : ''}: ${kinds.length ? kinds.map((k) => `${c.blocks[k].n} ${k}${c.blocks[k].n === 1 ? '' : 's'} (${c.blocks[k].withParts} with parts)`).join(', ') : 'none'}` +
    `${c.unread ? `; ${c.unread} block(s) that cannot be read` : ''}.`
  if (!c.rows.length) return `${head}\n\nNo parts.`
  const table = ['| block | part | count | median size | max size |', '|---|---|---:|---:|---:|', ...c.rows.map((r) => `| ${r.kind} | ${r.type} | ${r.count} | ${r.median} | ${r.max} |`)].join('\n')
  const ls = c.rows.filter((r) => r.leads.length).map((r) => `- ${r.kind}, text: ${r.leads.map((l) => `"${l.text.replace(/[|`"]/g, '')}" ${l.n}`).join(', ')}`)
  return `${head}\n\n${table}${ls.length ? `\n\nThe most common leading words of the text parts (${LEAD_WORDS} words):\n\n${ls.join('\n')}` : ''}`
}
