// Person runs for a box (sy-9618): a box's wake can't reach mm or the vault, so it asks the host, on the box's own
// mm.api socket (src/api.ts: the one way a box has to the host; the project is the socket the call came in on, never a
// name in the call). The host decides with the same rules as mm run-as on the host (src/runas.ts):
//   GET  /person-run   {"status": "on"|"off", "sponsor": "<the owner's name>"}: wake.person_runs on for this machine
//   POST /person-run   {"role": "<role>", "person": "<name>", "items": ["<id>", ...], "next": [{"id", "priority", "title"}]}
//        -> 200 {"status": "done", "agent": "<the box Paseo's agent id>"}, or {"status": "refused", "why", "message"}
// The person must hold a role on the box's project (mm.auth's grants; a viewer has no runs) and have their own Claude
// token: none is no run and the same words mm run-as says (bin/wake puts them on the item), for the owner too. A run a
// box asks for is never on the machine's own token (the owner's): no owner fallback, ever. The run is mm run-as's:
// the token goes in over `docker exec -i`'s stdin only (never into the box's files, never in the answer), bin/lead in
// the box labels it with the box Paseo's worker (the box's wake deletes it after that Paseo restarts), and the box's
// egress has the model's host only while a person's run is there (the host's record, src/personruns.ts). `items`: the
// person's items in progress (LEAD_ITEMS), `next`: the queue items the lead may pull (LEAD_NEXT), each in a fixed format.
// Rate-limited per box (RATE an hour, refused ones count too; one start at a time). Off (refused) unless
// wake.person_runs is on for the machine.
import type { Server } from 'bun'
import { PERSON } from './persontoken'
import { personRunsOn } from './personruns'
import { findRoot } from './project'
import { getPath, loadConfig } from './config'
import { startRun } from './runas'

export const CALL = 'person-run'
const RATE = Number(process.env.MM_API_PERSON_RATE) || 20  // asks for a run an hour, per box
const LOOK_RATE = 600                                       // asks whether person runs are on, an hour, per box
const ROLE = /^[a-z][a-z0-9-]{1,23}$/
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ITEMS_MAX = 50, NEXT_MAX = 20
const asks = new Map<string, number[]>(), looks = new Map<string, number[]>(), busy = new Set<string>()
/** One more call in the box's hour, or false when it had its share. */
function room(m: Map<string, number[]>, project: string, max: number): boolean {
  const t = Date.now(), l = (m.get(project) || []).filter((x) => t - x < 3600e3)
  if (l.length >= max) { m.set(project, l); return false }
  l.push(t); m.set(project, l); return true
}
const plain = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, n)
const sponsor = () => { const v = String(getPath(loadConfig(), 'owner_name') ?? ''); return PERSON.test(v) ? v : '' }

type Ask = { role: string; person: string; items: string[]; next: string }
/** The call's fields in their fixed formats, or null. Nothing else in the body is read (a project there is not). */
export function parse(body: unknown): Ask | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const role = typeof b.role === 'string' ? b.role : '', person = typeof b.person === 'string' ? b.person : ''
  if (!(ROLE.test(role) || role === 'setup') || !PERSON.test(person)) return null
  const items = b.items === undefined ? [] : b.items
  if (!Array.isArray(items) || items.length > ITEMS_MAX || !items.every((i) => typeof i === 'string' && ITEM.test(i))) return null
  const next = b.next === undefined ? [] : b.next
  if (!Array.isArray(next) || next.length > NEXT_MAX) return null
  const lines: string[] = []
  for (const n of next) {
    const x = n as Record<string, unknown> | null
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ITEM.test(x.id)) return null
    const p = x.priority === undefined || x.priority === null ? '?' : Number.isInteger(x.priority) && (x.priority as number) >= 0 && (x.priority as number) <= 4 ? String(x.priority) : null
    if (p === null || (x.title !== undefined && typeof x.title !== 'string')) return null
    lines.push(`- ${x.id} (P${p}): ${plain(String(x.title ?? ''), 100)}`)
  }
  return { role, person, items: [...new Set(items as string[])], next: lines.join('\n') }
}

type Log = (level: string, msg: string, attrs?: Record<string, unknown>) => void
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const refused = (http: number, why: string, message: string) => json({ status: 'refused', why, message }, http)

/** A call on the box's socket for `project` (its registered root, or null when the socket's box is not registered). */
export async function handle(req: Request, project: string, root: string | null, server: Server<undefined> | undefined, log: Log): Promise<Response> {
  if (req.method === 'GET') {
    if (!room(looks, project, LOOK_RATE)) return refused(429, 'rate', 'too many looks this hour')
    return json(personRunsOn() ? { status: 'on', sponsor: sponsor() } : { status: 'off' })
  }
  if (req.method !== 'POST') return refused(404, 'unknown-call', 'GET or POST')
  const at = { box: project, call: CALL }
  if (!personRunsOn()) { log('warn', 'person run refused: person runs are off', at); return refused(403, 'off', "person runs are off on this machine (wake.person_runs): the box's leads run as before") }
  if (busy.has(project)) { log('warn', 'person run refused: one is starting already', at); return refused(429, 'busy', 'a run for this box is starting already: ask again soon') }
  if (!room(asks, project, RATE)) { log('warn', 'person run refused: rate limit', { ...at, limit: RATE }); return refused(429, 'rate', `more than ${RATE} asks for a run this hour: ask again later`) }
  let body: unknown = null
  try { body = await req.json() } catch {}
  const a = parse(body)
  if (!a) { log('warn', 'person run refused: format', at); return refused(400, 'format', 'role, person, items and next are not in their formats') }
  const who = { ...at, person: a.person, role: a.role }
  if (!root) { log('error', "person run refused: the socket's box is not registered", who); return refused(403, 'no-box', 'this box is not registered on the host') }
  let same = false
  try { same = findRoot(project) === root } catch {}
  if (!same) { log('error', "person run refused: the box's project is not where the registry says", who); return refused(403, 'no-box', 'this box is not registered on the host') }
  busy.add(project)
  try {
    server?.timeout(req, 300) // a start takes a while (the box's Paseo, its egress proxy); 300 s at most
    const r = await startRun(a.person, project, a.role, { ownToken: true, capture: true, timeoutMs: 240_000, env: { LEAD_ITEMS: a.items.join(' '), ...(a.next ? { LEAD_NEXT: a.next } : {}) } })
    if (r.code !== 0 || !/^[\w-]{4,80}$/.test(r.agent)) {
      const why = plain(r.err.split('\n').filter((l) => l.trim()).slice(-3).join(' '), 400) || `exit ${r.code}`
      log('error', 'person run: the box did not start it', { ...who, code: r.code, detail: why })
      return refused(502, 'failed', `the run did not start in the box: ${why}`)
    }
    log('info', 'person run started', { ...who, agent: r.agent })
    return json({ status: 'done', agent: r.agent })
  } catch (e) {
    const m = plain((e as Error).message || String(e), 400), why = /has no Claude token/.test(m) ? 'no-token' : /viewer|can't have a run/.test(m) ? 'no-role' : 'refused'
    log('warn', 'person run refused', { ...who, why, detail: m })
    return refused(403, why, m)
  } finally { busy.delete(project) }
}
