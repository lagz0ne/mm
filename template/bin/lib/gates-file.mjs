// gates-file: review signs off a head only with the fixed tests' result for that exact head (sy-n4f5). An agent's
// reading is a signal; the gates are the gate. Adding signed-head:<repo>@<sha> for a repo of the board's list
// (gates.json {"repos": [...]}, default ["mm"]) needs artifacts/<item>/gates-<sha's first 7>.txt (or
// gates-<full sha>.txt), written by mm's test/gates <base>..<head> --item <item>, whose head is that sha and whose
// result is passed with no failed suite. A live group skipped (--no-live) is not passed for a t2 item; for any other
// item it passes (only a t2 change reaches the machine through the owner's go, and only ops runs the live group).
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_REPOS = ['mm']
const HEAD = /^signed-head:([a-z][a-z0-9-]{0,30})@([0-9a-f]{7,40})$/

/** The repos whose sign-off needs a gates file: the board's gates.json, else mm. A broken file is mm too. */
export function gatesRepos(root) {
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(root, 'gates.json'), 'utf8')) } catch { return DEFAULT_REPOS }
  return Array.isArray(j?.repos) && j.repos.every((r) => typeof r === 'string') ? j.repos : DEFAULT_REPOS
}

/** signed-head:<repo>@<sha> -> { repo, sha }, else null. */
export function parseSignedHead(label) {
  const m = HEAD.exec(String(label))
  return m ? { repo: m[1], sha: m[2] } : null
}

/** Read a gates result file's text: { head, result, suites: [{ suite, group, status }] }. */
export function parseGates(text) {
  const lines = String(text).split('\n')
  const head = /^head: ([0-9a-f]{7,40})\b/.exec(lines.find((l) => l.startsWith('head: ')) || '')?.[1] ?? null
  const result = (lines.find((l) => l.startsWith('result: ')) || '').slice('result: '.length) || null
  const blank = lines.indexOf('')
  const suites = (blank < 0 ? [] : lines.slice(blank + 1)).filter((l) => l.trim()).map((l) => {
    const [suite, group, status = ''] = l.split(/\s{2,}/)
    return { suite, group, status }
  })
  return { head, result, suites }
}

/** The text's verdict for sha: null when it lets the sign-off on, else the reason. */
export function gatesVerdict(text, sha, { t2 = false, file = 'the gates file' } = {}) {
  const g = parseGates(text)
  if (!g.head) return `${file} names no head (no "head: <sha>" line): not a test/gates result`
  if (!g.head.startsWith(sha) && !sha.startsWith(g.head)) return `${file} is for another head (${g.head.slice(0, 12)}), not ${sha}`
  if (!g.result) return `${file} has no "result:" line`
  const failed = g.suites.filter((s) => s.status.startsWith('failed')).map((s) => s.suite)
  if (failed.length || !g.result.startsWith('passed')) return `the gates failed for ${sha}${failed.length ? `: ${failed.join(', ')}` : ` (${g.result})`}`
  if (!g.suites.length) return `${file} names no suite: no test ran`
  const skipped = g.suites.filter((s) => s.status.startsWith('skipped')).map((s) => s.suite)
  if (t2 && (skipped.length || g.result.startsWith('passed ('))) return `a t2 head needs every group, live too; ${file} skipped ${skipped.join(', ') || 'the live group'} (--no-live): run test/gates without --no-live`
  return null
}

/** The reason review may not add `label` to item `id` (root: the board), or null. Labels other than a signed-head of a
 *  listed repo: null. A file that is a symlink or not a regular file counts as missing. */
export function signedHeadRefusal(root, id, label, { t2 = false } = {}) {
  if (!String(label).startsWith('signed-head:')) return null
  const h = parseSignedHead(label)
  if (!h) return `${label} is not signed-head:<repo>@<sha> (repo a-z 0-9 -, sha 7 to 40 lowercase hex)`
  if (!gatesRepos(root).includes(h.repo)) return null
  const g = gatesFor(root, id, h.sha, { t2 })
  if (!g) return null
  if (g.why === null) return `${label} needs the gates result for that head: no ${g.want}. Run test/gates <base>..${h.sha} --item ${id} (it puts the file there), then sign off`
  return `${label}: ${g.why}`
}

/** Item `id`'s gates file for head `sha` (root: the board): null when one lets it on, else { want: the file to make,
 *  why: the first file's reason, or null when there is none }. A symlink or a file that is not regular counts as none. */
export function gatesFor(root, id, sha, { t2 = false } = {}) {
  const want = `artifacts/${id}/gates-${sha.slice(0, 7)}.txt`
  // gates-<first 7>.txt first, then any gates-<sha>.txt whose sha and the head's agree (one is the other's start)
  let listed = []
  try { listed = fs.readdirSync(path.join(root, 'artifacts', id)) } catch {}
  const agree = (n) => { const m = /^gates-([0-9a-f]{7,40})\.txt$/.exec(n); return m && (m[1].startsWith(sha) || sha.startsWith(m[1])) }
  const names = [...new Set([`gates-${sha.slice(0, 7)}.txt`, ...listed.filter(agree).sort((a, b) => b.length - a.length)])]
  // the first file that lets it on wins; else the first file's reason
  let first = null
  for (const n of names) {
    const f = path.join(root, 'artifacts', id, n)
    let st; try { st = fs.lstatSync(f) } catch { continue }
    if (!st.isFile()) continue
    const why = gatesVerdict(fs.readFileSync(f, 'utf8'), sha, { t2, file: `artifacts/${id}/${n}` })
    if (!why) return null
    first ??= why
  }
  return { want, why: first }
}

/** sy-6avk: the reason a HANDOFF to the reviewer (to: its "→"; head: its Head, <repo>@<sha>) on item `id` may not be
 *  written, or null. The same rule as the sign-off it asks for (signedHeadRefusal): a head of a gates.json repo needs
 *  its passing gates file first. Another receiver, no Head, or a repo not listed: null. */
export function handoffRefusal(root, id, to, head, { t2 = false, reviewer = 'review' } = {}) {
  if (String(to ?? '').split('/')[0] !== reviewer) return null
  const m = /^([a-z][a-z0-9-]{0,30})@([0-9a-f]{7,40})$/.exec(String(head ?? '').trim())
  if (!m || !gatesRepos(root).includes(m[1])) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(String(id))) return `HANDOFF → ${reviewer} on "${id}": not an item id, so its gates file cannot be found`
  const g = gatesFor(root, id, m[2], { t2 })
  if (!g) return null
  const run = `Run test/gates <base>..${m[2]} --item ${id}${t2 ? ' (without --no-live: the item is t2)' : ''} first`
  if (g.why === null) return `HANDOFF → ${reviewer} needs the gates result for ${m[1]}@${m[2]}: no ${g.want}. ${run}`
  return `HANDOFF → ${reviewer} needs a passing gates result for ${m[1]}@${m[2]}: ${g.why}. ${run}`
}
