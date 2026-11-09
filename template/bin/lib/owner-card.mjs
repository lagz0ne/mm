// The owner card (sy-z5lz): a fixed short block at the top of the description of every item that needs the owner, so
// the owner sees what is asked and why without reading the agents' threads. The format is fixed:
//   ## Owner
//   - **What:** <one sentence, at most 120 characters>
//   - **Why:** <one sentence, at most 120>
//   - **You:** Tap Approve | Reply: <the question> | Check: <what, where> | Nothing   (at most 160; one of the four
//              forms first, then more words may follow: where to act, e.g. "Tap Approve in Telegram, or press Approve
//              on this item")
//   - **If yes:** <at most 120>                 (required with the label t2 on a go ask)
//   - **If no:** <at most 120>                  (required with the label t2 on a go ask)
//   - **Risk:** low|medium|high, <at most 80>   (required with the label t2 on a go ask)
//   - **Head:** <repo>@<sha>                    (required with the label t2 on a go ask; sy-hzmu: the one head review signs
//                                                off, a commit or a migration: repo [a-z][a-z0-9-]{0,30}, sha 7 to 40
//                                                lowercase hex)
// A go ask (sy-t9tg) is a card whose You starts with "Tap Approve" (isGoAsk): on a t2 item it asks for the T2 go, so it
// needs If yes, If no, Risk and Head, waits on the owner only after review's sign-off, and gets the go only for the head
// review signed (headRefusal). A non-go ask (You: "Reply: …", "Check: …", "Nothing…") asks the owner something else,
// before any head may exist: on a t2 item those four keys are optional (checked when there), and it never gets the go.
//   - **Link:** <artifact path or URL>          (optional)
//   - **Item:** <the item's URL>                (optional; the board shows its own: an http(s) URL that ends in
//                                                ?item=<this item's id>)
// `## Owner` is the first line of the description (blank lines before it are ok); a Markdown list follows, one line per
// key; a blank line (or the end) ends it. Lengths count characters (code points), after trimming.
// The words follow the writing rules (sy-ko6r, writing.mjs): with o.writing, What, Why, You, If yes, If no and Risk are
// checked; the problems are .writing (warnings), and from the glossary's refuse_from on also errors.
// The structured form (sy-rfup, step 1): a description that starts with a ```mm-card v1 block (bin/lib/structured.mjs;
// bd card builds it) is checked by its schema (bin/lib/schemas/card.v1.json) and the same rules (t2, Item, the writing
// check on its text parts; a Reply's question is its first text part), and maps to the same keys; .json is its data.
// Pure; imports only writing.mjs and structured.mjs: bin/owner-card, bin/bd (through it), the Supervisor, the board's server (waiting.mjs) and, as an
// identical copy, the board's browser code (site/src/lib/owner-card.mjs; test/owner-card.mjs keeps them equal).
import { writingCheck } from './writing.mjs'
import { cardKeys, firstText, miscText, readBlock, validate } from './structured.mjs'

export const FORMAT = 'the description starts with "## Owner", then one line per key: "- **What:** ...", "- **Why:** ...", "- **You:** Tap Approve | Reply: <question> | Check: <what, where> | Nothing", with t2 and You "Tap Approve" (a go ask) also "- **If yes:** ...", "- **If no:** ...", "- **Risk:** low|medium|high, ...", "- **Head:** <repo>@<sha>"; optional "- **Link:** ...", "- **Item:** <URL ending in ?item=<id>>"; a blank line ends it (the leads\' brief, "Asking the owner: the owner card")'
// key -> its limit in characters; the order is the card's
export const KEYS = { What: 120, Why: 120, You: 160, 'If yes': 120, 'If no': 120, Risk: 80, Head: 72, Link: 300, Item: 300 }
export const REQUIRED = ['What', 'Why', 'You']
/** The keys in words (the writing check reads them; Head, Link and Item are not words). */
export const PROSE = ['What', 'Why', 'You', 'If yes', 'If no', 'Risk']
/** Required on a t2 card that is a go ask (isGoAsk; sy-t9tg); optional on a non-go ask. Head: review sy-hzmu #3. */
export const REQUIRED_T2 = ['If yes', 'If no', 'Risk', 'Head']
const HEADING = /^##[ \t]+Owner[ \t]*$/
const LINE = /^[-*][ \t]+\*\*([^*]+?):\*\*[ \t]*(.*?)[ \t]*$/
const RISK = /^(low|medium|high)(?:[ \t]*[,:;–—-][ \t]*(.*))?$/i
/** A card's Head (sy-hzmu): <repo>@<sha>. */
export const HEAD = /^[a-z][a-z0-9-]{0,30}@[0-9a-f]{7,40}$/
/** The label review adds next to signed-off when it signs off a card with a Head: signed-head:<repo>@<sha>. */
export const SIGNED_HEAD = 'signed-head:'
const len = (s) => Array.from(s).length
const ID = '[a-z]+-[a-z0-9]+(?:\\.[0-9]+)*'
const ITEM_URL = new RegExp(`^https?://[^\\s/?#<>"]+/?[^\\s?#<>"]*\\?item=(${ID})$`)

/** What the `You` line asks: approve | reply | check | nothing; null when it starts with none of the four forms. A
 * form may be followed by more words (where to act): "Tap Approve in Telegram, or press Approve on this item". */
export function youKind(v) {
  const s = String(v ?? '').trim()
  if (/^Tap Approve(?=$|[\s.,;:!])/.test(s)) return 'approve'
  if (/^Nothing(?=$|[\s.,;:!])/.test(s)) return 'nothing'
  const m = /^(Reply|Check):[ \t]*(.*)$/.exec(s)
  if (m && m[2].trim()) return m[1] === 'Reply' ? 'reply' : 'check'
  return null
}

/** A go ask (sy-t9tg): the card's You starts with "Tap Approve". The one definition for the bd gate, the board, the
 * Waiting list and the bridge. False for no card, a card with no You, or any other form (a non-go ask).
 * @param {Record<string,string>|null|undefined} card  parseCard(...).card */
export const isGoAsk = (card) => youKind(card?.You) === 'approve'
/** A non-go ask (sy-t9tg): the card's You starts with "Reply: …", "Check: …" or "Nothing". Not the negation of isGoAsk:
 * no card, or a card with no or an invalid You, is neither (a t2 one is refused at the gate and at the go). The board
 * and the Waiting list show a t2 non-go ask with its own action (Reply, Done), never Approve or Not now. */
export const isNonGoAsk = (card) => ['reply', 'check', 'nothing'].includes(youKind(card?.You))
/** The reason headRefusal gives for a t2 card that asks the owner something other than the go (sy-t9tg). */
export const NO_GO = 'this item asks for no go (its owner card\'s You is not "Tap Approve")'

/**
 * Read the owner card at the top of a description.
 * @param {string} description  the item's description (Markdown)
 * @param {string[]} [labels]   the item's labels (t2 makes If yes, If no, Risk and Head required on a go ask)
 * @param {string} [id]         the item's id, when known: an Item line must end in ?item=<id>
 * @param {{ writing?: object }} [o]  writing: the writing check's setting (writing.mjs writingCheck); none: no check
 * @returns {{ ok: boolean, found: boolean, card: Record<string,string>|null, errors: string[], rest: string,
 *   writing: { rule: string, line: number, text: string }[] }}  writing: line n is the card's nth key in words
 *   found: a `## Owner` heading is at the top (the card's lines are then taken out of `rest`, valid or not);
 *   card: the keys read (by their names: What, Why, You, If yes, If no, Risk, Head, Link, Item), null when not found;
 *   rest: the description without the card (all of it when not found).
 */
export function parseCard(description, labels = [], id = '', o = {}) {
  const text = String(description ?? '').replace(/\r\n?/g, '\n')
  const b = readBlock(text)
  if (b?.kind === 'card') return cardBlock(b, labels, id, o)
  const lines = text.split('\n')
  let k = 0
  while (k < lines.length && !lines[k].trim()) k++
  if (k >= lines.length || !HEADING.test(lines[k])) {
    const later = lines.some((l) => HEADING.test(l))
    return { ok: false, found: false, card: null, rest: text, writing: [],
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
    if (key === 'Item') {
      const u = ITEM_URL.exec(value)
      if (!u) errors.push('Item is not an http(s) URL that ends in ?item=<the item\'s id>')
      else if (id && u[1] !== id) errors.push(`Item points to ${u[1]}, not to this item (${id})`)
    }
    if (key === 'Head' && !HEAD.test(value)) errors.push('Head is not <repo>@<sha> (repo: a lowercase letter, then up to 30 of a-z, 0-9, -; sha: 7 to 40 lowercase hex)')
    if (key === 'You' && !youKind(value)) errors.push('You starts with none of "Tap Approve", "Reply: <the question>", "Check: <what, where>", "Nothing"')
  }
  const t2 = Array.isArray(labels) && labels.includes('t2')
  // a t2 card that is not a non-go ask needs the go's keys: a go ask, and (fail-closed) a card whose You is missing or
  // invalid (it is refused for that anyway)
  const go = t2 && !isNonGoAsk(card)
  for (const r of [...REQUIRED, ...(go ? REQUIRED_T2 : [])]) if (!(r in card)) errors.push(`${r} is missing${REQUIRED_T2.includes(r) ? ' (required with t2) on a go ask (You: Tap Approve)' : ''}`)
  const writing = writingCheck(PROSE.filter((x) => card[x]).map((x) => `${x}: ${card[x]}`).join('\n'), o.writing, errors)
  return { ok: errors.length === 0, found: true, card, errors, writing, rest: lines.slice(k).join('\n').replace(/^\n+/, '') }
}

/** parseCard for a ```mm-card v1 block: the schema, then the rules a schema cannot say (t2 on a go ask, Item, Reply). */
function cardBlock(b, labels, id, o) {
  const errors = [...b.errors]
  const out = { ok: false, found: true, card: {}, errors, writing: [], rest: b.rest, json: b.data, raw: b.raw }
  if (errors.length || !b.data) return out
  errors.push(...validate('card', b.data))
  const card = (out.card = cardKeys(b.data))
  if (b.data.you?.kind === 'reply' && !firstText(b.data.misc)) errors.push('you.kind reply: the question is the first text part, and there is none')
  const go = Array.isArray(labels) && labels.includes('t2') && !isNonGoAsk(card)
  const NAME = { 'If yes': 'ifYes', 'If no': 'ifNo', Risk: 'risk', Head: 'head' }
  if (go) for (const r of REQUIRED_T2) if (!(r in card)) errors.push(`${NAME[r]}: is missing (required with t2 on a go ask: you.kind approve)`)
  const u = card.Item ? ITEM_URL.exec(card.Item) : null
  if (u && id && u[1] !== id) errors.push(`item: points to ${u[1]}, not to this item (${id})`)
  out.writing = writingCheck(miscText(b.data.misc), o.writing, errors)
  out.ok = errors.length === 0
  return out
}

/**
 * May this item get the T2 go? (sy-hzmu, sy-t9tg) Only a go ask (isGoAsk) whose Head is the head review signed off.
 * One check for the bd gate, the board (its label rail, Approve, Not now, the Waiting list) and the bridge.
 * @param {string} description  the item's description
 * @param {Iterable<string>} labels  the item's labels (as they are, or as they will be after the call)
 * @returns {string|null} null: no objection (not t2, already approved, or a go ask whose Head is the head review
 *   signed); else the reason: a non-go ask (NO_GO), a card with no Head (review sy-hzmu #3, no fail-open; no card too),
 *   a Head review did not sign, or a card whose You is no go ask.
 */
export function headRefusal(description, labels) {
  const ls = [...(labels ?? [])].map(String)
  if (!ls.includes('t2') || ls.includes('approved')) return null
  const card = parseCard(description, ls).card
  if (isNonGoAsk(card)) return NO_GO
  const head = card?.Head
  if (head === undefined) return `the card names no head (required with t2: - **Head:** <repo>@<sha>)`
  if (!HEAD.test(head)) return `the card's Head is not <repo>@<sha> (card: ${clip(head)})`
  const signed = ls.filter((l) => l.startsWith(SIGNED_HEAD)).map((l) => l.slice(SIGNED_HEAD.length))
  if (signed.includes(head)) return isGoAsk(card) ? null : 'the card asks for no go: its You does not start with "Tap Approve"'
  if (!signed.length) return `review's sign-off names no head (card: ${head})`
  return `the head changed since review's sign-off (card: ${head}, signed: ${signed.map(clip).join(', ')})`
}

const clip = (s) => (len(s) > 60 ? `${Array.from(s).slice(0, 59).join('')}…` : s)
