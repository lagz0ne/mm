// The owner card (sy-z5lz): a fixed short block at the top of the description of every item that needs the owner, so
// the owner sees what is asked and why without reading the agents' threads. The format is fixed:
//   ## Owner
//   - **What:** <one sentence, at most 120 characters>
//   - **Why:** <one sentence, at most 120>
//   - **You:** Tap Approve | Reply: <the question> | Check: <what, where> | Nothing
//   - **If yes:** <at most 120>                 (required with the label t2)
//   - **If no:** <at most 120>                  (required with the label t2)
//   - **Risk:** low|medium|high, <at most 80>   (required with the label t2)
//   - **Link:** <artifact path or URL>          (optional)
// `## Owner` is the first line of the description (blank lines before it are ok); a Markdown list follows, one line per
// key; a blank line (or the end) ends it. Lengths count characters (code points), after trimming.
// Pure, no imports: bin/owner-card, bin/bd (through it), the Supervisor, the board's server (waiting.mjs) and, as an
// identical copy, the board's browser code (site/src/lib/owner-card.mjs; test/owner-card.mjs keeps them equal).

export const FORMAT = 'the description starts with "## Owner", then one line per key: "- **What:** ...", "- **Why:** ...", "- **You:** Tap Approve | Reply: <question> | Check: <what, where> | Nothing", with t2 also "- **If yes:** ...", "- **If no:** ...", "- **Risk:** low|medium|high, ..."; optional "- **Link:** ..."; a blank line ends it (the leads\' brief, "Asking the owner: the owner card")'
// key -> its limit in characters; the order is the card's
export const KEYS = { What: 120, Why: 120, You: 160, 'If yes': 120, 'If no': 120, Risk: 80, Link: 300 }
export const REQUIRED = ['What', 'Why', 'You']
export const REQUIRED_T2 = ['If yes', 'If no', 'Risk']
const HEADING = /^##[ \t]+Owner[ \t]*$/
const LINE = /^[-*][ \t]+\*\*([^*]+?):\*\*[ \t]*(.*?)[ \t]*$/
const RISK = /^(low|medium|high)(?:[ \t]*[,:;–—-][ \t]*(.*))?$/i
const len = (s) => Array.from(s).length

/** What the `You` line asks: approve | reply | check | nothing; null when it starts with none of the four forms. */
export function youKind(v) {
  const s = String(v ?? '').trim()
  if (/^Tap Approve\.?$/.test(s)) return 'approve'
  if (/^Nothing\.?$/.test(s)) return 'nothing'
  const m = /^(Reply|Check):[ \t]*(.*)$/.exec(s)
  if (m && m[2].trim()) return m[1] === 'Reply' ? 'reply' : 'check'
  return null
}

/**
 * Read the owner card at the top of a description.
 * @param {string} description  the item's description (Markdown)
 * @param {string[]} [labels]   the item's labels (t2 makes If yes, If no and Risk required)
 * @returns {{ ok: boolean, found: boolean, card: Record<string,string>|null, errors: string[], rest: string }}
 *   found: a `## Owner` heading is at the top (the card's lines are then taken out of `rest`, valid or not);
 *   card: the keys read (by their names: What, Why, You, If yes, If no, Risk, Link), null when not found;
 *   rest: the description without the card (all of it when not found).
 */
export function parseCard(description, labels = []) {
  const text = String(description ?? '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  let k = 0
  while (k < lines.length && !lines[k].trim()) k++
  if (k >= lines.length || !HEADING.test(lines[k])) {
    const later = lines.some((l) => HEADING.test(l))
    return { ok: false, found: false, card: null, rest: text,
      errors: [later ? 'the owner card is not at the top: "## Owner" must be the first line of the description' : 'no owner card: the description does not start with "## Owner"'] }
  }
  k++
  while (k < lines.length && !lines[k].trim()) k++ // a blank line between the heading and the list is ok
  const card = {}, errors = []
  for (; k < lines.length && lines[k].trim(); k++) {
    const m = LINE.exec(lines[k].trim())
    if (!m) { errors.push(`line "${clip(lines[k].trim())}" is not "- **Key:** value"`); continue }
    const key = m[1].trim(), value = m[2]
    if (!(key in KEYS)) { errors.push(`unknown key "${clip(key)}" (the keys: ${Object.keys(KEYS).join(', ')})`); continue }
    if (key in card) { errors.push(`${key} is there twice`); continue }
    card[key] = value
    if (!value) { errors.push(`${key} is empty`); continue }
    if (key === 'Risk') {
      const r = RISK.exec(value)
      if (!r) errors.push('Risk does not start with low, medium or high')
      else if (r[2] && len(r[2].trim()) > KEYS.Risk) errors.push(`Risk is too long (${len(r[2].trim())} characters after the level; at most ${KEYS.Risk})`)
      continue
    }
    if (len(value) > KEYS[key]) errors.push(`${key} is too long (${len(value)} characters; at most ${KEYS[key]})`)
    if (key === 'You' && !youKind(value)) errors.push('You starts with none of "Tap Approve", "Reply: <the question>", "Check: <what, where>", "Nothing"')
  }
  const t2 = Array.isArray(labels) && labels.includes('t2')
  for (const r of [...REQUIRED, ...(t2 ? REQUIRED_T2 : [])]) if (!(r in card)) errors.push(`${r} is missing${REQUIRED_T2.includes(r) ? ' (required with t2)' : ''}`)
  return { ok: errors.length === 0, found: true, card, errors, rest: lines.slice(k).join('\n').replace(/^\n+/, '') }
}

const clip = (s) => (len(s) > 60 ? `${Array.from(s).slice(0, 59).join('')}…` : s)
