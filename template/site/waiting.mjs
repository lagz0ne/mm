// The "Waiting for you" list on the gateway's home page (sy-vdi8, review's rules in sy-6h43 #5): the items that wait on
// the person the gateway asks for, never anyone else's. The gateway fetches it per board with that person's own
// assertion, checks every field again, writes the one-line ask itself from the labels and builds the link itself.
//   the owner             the items labelled needs-you, and the t2 items review signed off that wait for approved
//   designer/member/viewer only the open items assigned to them (needs-you means the owner, not every human)
// Each entry: id, title (plain text, at most 200 characters, no control or bidi characters), age_min (whole minutes
// since its last update), only the labels the ask needs (needs-you; t2 and signed-off for an approval), and `you`: the
// `You` line of the item's owner card (sy-z5lz; bin/lib/owner-card.mjs), plain text as the title, at most 160
// characters. For the owner `you` is always there, null when the item has no card (or no You line): the gateway shows
// "card missing". For anyone else it is there only when the card has one. Oldest first. No link: the gateway shows
// each item's address itself, from the board's host in its registry and the checked id (review sy-6h43).
// With `cards` (?card=1, a gateway that knows it; sy-92sg) the owner's entries also carry `card`, so the Waiting list is
// the owner's place to act: the owner card's fields { what, why, you, if_yes, if_no, risk }, only those the card has,
// each plain text as the title and cut to the card's own limit (CARD_FIELDS); null when the item has no card. Never for
// anyone else, and never without ?card=1 (an older gateway drops an entry with a key it does not know).
// The answer stays under 32 KB (MAX_BYTES): what doesn't fit is counted in `more`, never cut in the middle.
// Pure: the board's server feeds it, test/board-pull.mjs checks it.
import { parseCard } from '../bin/lib/owner-card.mjs'

export const MAX_BYTES = 32 * 1024
export const TITLE_MAX = 200
export const YOU_MAX = 160
// the card's fields as the list sends them: name -> [the card's key, the most characters] (owner-card.mjs KEYS; Risk
// is its level and up to 80 more)
export const CARD_FIELDS = { what: ['What', 120], why: ['Why', 120], you: ['You', 160], if_yes: ['If yes', 120], if_no: ['If no', 120], risk: ['Risk', 100] }
export const ID_RE = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/
// C0, DEL, C1, and the bidi controls (they can make a title read as something else)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** A title as plain text the gateway accepts: control characters to spaces, spaces folded, at most 200 characters. */
export const plainTitle = (t) => plain(t, TITLE_MAX) || '(no title)'
/** The `You` line of an item's owner card as plain text (as a title, at most 160 characters), or null: no card, no You. */
export function youLine(description, labels) {
  const v = parseCard(description, labels).card?.You
  return (v && plain(v, YOU_MAX)) || null
}
/** The owner card's fields as plain text (CARD_FIELDS), or null: no card at the top of the description. */
export function cardFields(description, labels) {
  const c = parseCard(description, labels).card
  if (!c) return null
  const out = {}
  for (const [k, [key, max]] of Object.entries(CARD_FIELDS)) { const v = c[key] && plain(c[key], max); if (v) out[k] = v }
  return out
}
function plain(t, max) {
  const s = String(t ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const cps = Array.from(s)
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : s
}

/**
 * @param items  every item on the board (bd serve's list)
 * @param me     the asking person's name (the gateway's assertion)
 * @param owner  true when the assertion says owner
 * @param now    ms
 * @param cards  the owner's entries carry `card` (?card=1)
 * @returns { items: [{ id, title, age_min, labels, you?, card? }], more }
 */
export function waitingFor({ items, me, owner, now = Date.now(), max = MAX_BYTES, cards = false }) {
  const has = (i, l) => Array.isArray(i.labels) && i.labels.includes(l)
  const out = []
  for (const i of items) {
    if (!i || i.status === 'closed' || typeof i.id !== 'string' || !ID_RE.test(i.id)) continue
    let labels
    if (owner) {
      const approval = has(i, 't2') && has(i, 'signed-off') && !has(i, 'approved')
      labels = [...(has(i, 'needs-you') ? ['needs-you'] : []), ...(approval ? ['t2', 'signed-off'] : [])]
      if (!labels.length) continue
    } else {
      if (!me || i.assignee !== me) continue
      labels = []
    }
    const t = Date.parse(i.updated_at), you = youLine(i.description, i.labels)
    out.push({ id: i.id, title: plainTitle(i.title), age_min: Math.max(0, Math.floor((now - (Number.isNaN(t) ? now : t)) / 60000)), labels,
      ...(owner || you ? { you } : {}), ...(owner && cards ? { card: cardFields(i.description, i.labels) } : {}) })
  }
  out.sort((a, b) => b.age_min - a.age_min || a.id.localeCompare(b.id))
  // keep under the cap, with room for the envelope and `more`
  const keep = []
  let bytes = Buffer.byteLength('{"items":[],"more":1000000}')
  for (const e of out) {
    const n = Buffer.byteLength(JSON.stringify(e)) + 1
    if (bytes + n > max) break
    keep.push(e); bytes += n
  }
  return { items: keep, more: out.length - keep.length }
}
