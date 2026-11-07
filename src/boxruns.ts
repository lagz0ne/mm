// Person runs for a box (sy-9618, sy-otxx): a box's wake can't reach mm or the vault, so it asks the host, on the box's
// own mm.api socket (src/api.ts: the one way a box has to the host; the project is the socket the call came in on, never
// a name in the call). The host decides with the same rules as mm run-as on the host (src/runas.ts):
//   GET  /person-run   {"status": "on"|"off", "asks": {"<item>": "<person>", ...}}: wake.person_runs on for this
//        machine, and the host's own record of who asked for runs on which of this box's items (src/personasks.ts).
//        Never the owner's name as such: a person is there only for an item they asked for themselves.
//   POST /person-run   {"role": "<role>", "items": ["<id>", ...], "next": [{"id", "priority", "title"}]}
//        -> 200 {"status": "done", "agent": "<the box Paseo's agent id>", "person"}, or {"status": "refused", "why", "message"}
// The box never names the person (sy-otxx 1): a `person` in the body is refused. The person is the one the host's record
// holds for every item in `items` and `next` (all the same person, at least one item); none, or two people: no run. Never the owner
// or an admin instead. That person must still hold a role on the box's project (mm.auth's grants; a viewer has no runs)
// and have their own Claude token, and a monthly mm.ai budget for the project that the owner set (`mm ai budget
// <project> <usd> --person <name>`; none, or used up: refused, 'no-budget'). The run is mm run-as's: in a box it gets a short-lived mm.ai key of its own, bound to
// (project, person), never the person's token (src/runas.ts, src/ai.ts). `items`: the person's items (LEAD_ITEMS),
// `next`: the queue items the lead may pull (LEAD_NEXT; only that person's asks), each in a fixed format.
// Rate-limited per box (RATE an hour, refused ones count too; one start at a time); the counts are kept in a file of
// mm.api's (RATE_FILE, 0600), so a restart does not reset them. Off (refused) unless wake.person_runs is on.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'bun'
import { API_DIR } from './apistate'
import { asksOf } from './personasks'
import { personRunsBoxesOn, personRunsOn } from './personruns'
import { findRoot } from './project'
import { startRun } from './runas'

export const CALL = 'person-run'
const RATE = Number(process.env.MM_API_PERSON_RATE) || 20  // asks for a run an hour, per box
const LOOK_RATE = 600                                       // asks whether person runs are on, an hour, per box
const ROLE = /^[a-z][a-z0-9-]{1,23}$/
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ITEMS_MAX = 50, NEXT_MAX = 20
const busy = new Set<string>()
// the hour's counts per box, kept across a restart of mm.api (sy-otxx 3)
const RATE_FILE = () => join(API_DIR, 'person-run-rate.json')
type Counts = { asks: Record<string, number[]>; looks: Record<string, number[]> }
let counts: Counts | null = null
function loadCounts(): Counts {
  if (counts) return counts
  counts = { asks: {}, looks: {} }
  try {
    const j = JSON.parse(readFileSync(RATE_FILE(), 'utf8')) as Partial<Counts>
    for (const k of ['asks', 'looks'] as const) for (const [p, l] of Object.entries(j[k] || {})) if (Array.isArray(l)) counts[k][p] = l.filter((x) => typeof x === 'number')
  } catch {}
  return counts
}
function saveCounts() {
  try {
    mkdirSync(API_DIR, { recursive: true, mode: 0o700 })
    const f = RATE_FILE(); writeFileSync(`${f}.tmp`, JSON.stringify(counts), { mode: 0o600 }); chmodSync(`${f}.tmp`, 0o600); renameSync(`${f}.tmp`, f)
  } catch {}
}
/** One more call in the box's hour, or false when it had its share. */
function room(kind: 'asks' | 'looks', project: string, max: number): boolean {
  const c = loadCounts(), t = Date.now(), l = (c[kind][project] || []).filter((x) => t - x < 3600e3 && x <= t)
  for (const k of ['asks', 'looks'] as const) for (const p of Object.keys(c[k])) if (!c[k][p].some((x) => t - x < 3600e3)) delete c[k][p]
  if (l.length >= max) { c[kind][project] = l; saveCounts(); return false }
  l.push(t); c[kind][project] = l; saveCounts(); return true
}
const plain = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, n)

type Next = { id: string; line: string }
type BoxAsk = { role: string; items: string[]; next: Next[] }
/** The call's fields in their fixed formats, or null. Nothing else in the body is read (a project there is not); a
 *  person there is refused: the host decides the person. */
export function parse(body: unknown): BoxAsk | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (b.person !== undefined) return null
  const role = typeof b.role === 'string' ? b.role : ''
  if (!(ROLE.test(role) || role === 'setup')) return null
  const items = b.items === undefined ? [] : b.items
  if (!Array.isArray(items) || items.length > ITEMS_MAX || !items.every((i) => typeof i === 'string' && ITEM.test(i))) return null
  const next = b.next === undefined ? [] : b.next
  if (!Array.isArray(next) || next.length > NEXT_MAX) return null
  const lines: Next[] = []
  for (const n of next) {
    const x = n as Record<string, unknown> | null
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ITEM.test(x.id)) return null
    const p = x.priority === undefined || x.priority === null ? '?' : Number.isInteger(x.priority) && (x.priority as number) >= 0 && (x.priority as number) <= 4 ? String(x.priority) : null
    if (p === null || (x.title !== undefined && typeof x.title !== 'string')) return null
    lines.push({ id: x.id, line: `- ${x.id} (P${p}): ${plain(String(x.title ?? ''), 100)}` })
  }
  return { role, items: [...new Set(items as string[])], next: lines }
}
/** The one person the host's record holds for all of `items`, or why there is none. */
export function personOf(project: string, items: string[]): { person: string } | { why: string; message: string } {
  if (!items.length) return { why: 'no-ask', message: 'a person run is for items someone asked for on the host: none named' }
  const asks = new Map(asksOf(project).map((a) => [a.item, a.person]))
  const none = items.filter((i) => !asks.has(i))
  if (none.length) return { why: 'no-ask', message: `nobody asked for runs on ${none.slice(0, 5).join(', ')} on the host (a person asks on their home page, "Runs for you"): no person run for it` }
  const people = [...new Set(items.map((i) => asks.get(i)!))]
  if (people.length > 1) return { why: 'two-people', message: `these items were asked for by ${people.length} people: one run per person` }
  return { person: people[0] }
}

type Log = (level: string, msg: string, attrs?: Record<string, unknown>) => void
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const refused = (http: number, why: string, message: string) => json({ status: 'refused', why, message }, http)

/** A call on the box's socket for `project` (its registered root, or null when the socket's box is not registered). */
export async function handle(req: Request, project: string, root: string | null, server: Server<undefined> | undefined, log: Log): Promise<Response> {
  if (req.method === 'GET') {
    if (!room('looks', project, LOOK_RATE)) return refused(429, 'rate', 'too many looks this hour')
    return json(personRunsBoxesOn() ? { status: 'on', asks: Object.fromEntries(asksOf(project).map((a) => [a.item, a.person])) } : { status: 'off' })
  }
  if (req.method !== 'POST') return refused(404, 'unknown-call', 'GET or POST')
  const at = { box: project, call: CALL }
  if (!personRunsOn()) { log('warn', 'person run refused: person runs are off', at); return refused(403, 'off', "person runs are off on this machine (wake.person_runs): the box's leads run as before") }
  // the owner's choice (a) on sy-otxx: on the host only for now; a box's needs its own switch
  if (!personRunsBoxesOn()) { log('warn', 'person run refused: person runs are on the host only (wake.person_runs_boxes)', at); return refused(403, 'off', "person runs are on the host only (wake.person_runs_boxes is off): the box's leads run as before") }
  if (busy.has(project)) { log('warn', 'person run refused: one is starting already', at); return refused(429, 'busy', 'a run for this box is starting already: ask again soon') }
  if (!room('asks', project, RATE)) { log('warn', 'person run refused: rate limit', { ...at, limit: RATE }); return refused(429, 'rate', `more than ${RATE} asks for a run this hour: ask again later`) }
  let body: unknown = null
  try { body = await req.json() } catch {}
  const a = parse(body)
  if (!a) {
    const named = !!body && typeof body === 'object' && (body as Record<string, unknown>).person !== undefined
    log('warn', named ? 'person run refused: the box named a person' : 'person run refused: format', at)
    return refused(400, 'format', named ? 'a box does not name the person: the host decides it from who asked for the items' : 'role, items and next are not in their formats')
  }
  const whose = personOf(project, [...new Set([...a.items, ...a.next.map((n) => n.id)])])
  if (!('person' in whose)) { log('warn', `person run refused: ${whose.why}`, { ...at, role: a.role, items: a.items.slice(0, 10).join(' ') }); return refused(403, whose.why, whose.message) }
  const person = whose.person, mine = new Set(asksOf(project).filter((x) => x.person === person).map((x) => x.item))
  const next = a.next.filter((n) => mine.has(n.id)).map((n) => n.line).join('\n')
  const who = { ...at, person, role: a.role }
  if (!root) { log('error', "person run refused: the socket's box is not registered", who); return refused(403, 'no-box', 'this box is not registered on the host') }
  let same = false
  try { same = findRoot(project) === root } catch {}
  if (!same) { log('error', "person run refused: the box's project is not where the registry says", who); return refused(403, 'no-box', 'this box is not registered on the host') }
  busy.add(project)
  try {
    server?.timeout(req, 300) // a start takes a while (the box's Paseo, its egress proxy); 300 s at most
    const r = await startRun(person, project, a.role, { ownToken: true, capture: true, timeoutMs: 240_000, env: { LEAD_ITEMS: a.items.join(' '), ...(next ? { LEAD_NEXT: next } : {}) } })
    if (r.code !== 0 || !/^[\w-]{4,80}$/.test(r.agent)) {
      const why = plain(r.err.split('\n').filter((l) => l.trim()).slice(-3).join(' '), 400) || `exit ${r.code}`
      log('error', 'person run: the box did not start it', { ...who, code: r.code, detail: why })
      return refused(502, 'failed', `the run did not start in the box: ${why}`)
    }
    log('info', 'person run started', { ...who, agent: r.agent })
    return json({ status: 'done', agent: r.agent, person })
  } catch (e) {
    const m = plain((e as Error).message || String(e), 400), why = /has no Claude token/.test(m) ? 'no-token' : /viewer|can't have a run/.test(m) ? 'no-role' : /AI budget/.test(m) ? 'no-budget' : 'refused'
    log('warn', 'person run refused', { ...who, why, detail: m })
    return refused(403, why, m)
  } finally { busy.delete(project) }
}
