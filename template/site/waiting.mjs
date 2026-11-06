// The "Waiting for you" list on the gateway's home page (sy-vdi8, review's rules in sy-6h43 #5): the items that wait on
// the person the gateway asks for, never anyone else's. The gateway fetches it per board with that person's own
// assertion, checks every field again, writes the one-line ask itself from the labels and builds the link itself.
//   the owner             the items labelled needs-you, and the t2 items review signed off that wait for approved
//   designer/member/viewer only the open items assigned to them (needs-you means the owner, not every human)
// Each entry: id, title (plain text, at most 200 characters, no control or bidi characters), age_min (whole minutes
// since its last update) and only the labels the ask needs (needs-you; t2 and signed-off for an approval). Oldest first.
// The answer stays under 32 KB (MAX_BYTES): what doesn't fit is counted in `more`, never cut in the middle.
// Pure: the board's server feeds it, test/board-pull.mjs checks it.

export const MAX_BYTES = 32 * 1024
export const TITLE_MAX = 200
export const ID_RE = /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/
// C0, DEL, C1, and the bidi controls (they can make a title read as something else)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** A title as plain text the gateway accepts: control characters to spaces, spaces folded, at most 200 characters. */
export function plainTitle(t) {
  const s = String(t ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const cps = Array.from(s)
  return (cps.length > TITLE_MAX ? `${cps.slice(0, TITLE_MAX - 1).join('').trimEnd()}…` : s) || '(no title)'
}

/**
 * @param items  every item on the board (bd serve's list)
 * @param me     the asking person's name (the gateway's assertion)
 * @param owner  true when the assertion says owner
 * @param now    ms
 * @returns { items: [{ id, title, age_min, labels }], more }
 */
export function waitingFor({ items, me, owner, now = Date.now(), max = MAX_BYTES }) {
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
    const t = Date.parse(i.updated_at)
    out.push({ id: i.id, title: plainTitle(i.title), age_min: Math.max(0, Math.floor((now - (Number.isNaN(t) ? now : t)) / 60000)), labels })
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
