// Who asked for a person run on which item (sy-otxx 1): the host's own record, never the box's word. A box's ask for a
// person run names only item ids (src/boxruns.ts); the person is the one this record holds for them, or there is no
// run. Nothing here falls back to the owner or to an admin: an item nobody asked for here runs as a plain lead.
// Only the gateway writes it: a person signed in at mm.auth asks for runs on one item of a project where they hold a
// non-viewer role ("Runs for you", src/auth.ts /s/runs); the person is the session's, never a name in the form. An ask
// lasts ASK_TTL_MS by the host's clock, then the person asks again. The owner can drop any (`mm run-as drop`).
// The record: $MM_HOME/person-asks/<project>.json (0600 in a 0700 folder), outside every project and box. Never a token.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS } from './env'
import { PERSON } from './persontoken'

export const ASK_TTL_MS = 7 * 24 * 3600e3
export const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX = 200 // asks per project
export type Ask = { item: string; person: string; at: number; expires: number }
const dir = () => join(DIRS.mm, 'person-asks')
const file = (project: string) => { if (!PROJECT_ID.test(project)) throw new Error(`not a project id: ${project}`); return join(dir(), `${project}.json`) }

/** The live asks of a project (the expired ones are not listed). */
export function asksOf(project: string, t = Date.now()): Ask[] {
  try {
    const j = JSON.parse(readFileSync(file(project), 'utf8')) as { asks?: Ask[] }
    return (Array.isArray(j.asks) ? j.asks : []).filter((a) => a && typeof a.item === 'string' && ITEM.test(a.item) && typeof a.person === 'string' && PERSON.test(a.person)
      && typeof a.expires === 'number' && a.expires > t)
  } catch { return [] }
}
function save(project: string, asks: Ask[]) {
  const f = file(project)
  if (!asks.length) { rmSync(f, { force: true }); return }
  mkdirSync(dir(), { recursive: true, mode: 0o700 }); chmodSync(dir(), 0o700)
  writeFileSync(`${f}.tmp`, JSON.stringify({ asks }, null, 1) + '\n', { mode: 0o600 }); renameSync(`${f}.tmp`, f)
}
/** The person who asked for runs on this item, or null. */
export const personFor = (project: string, item: string) => asksOf(project).find((a) => a.item === item)?.person ?? null
/** The person has at least one live ask on the project (mm.ai checks it at each call of a person-run key). */
export const asksOn = (project: string, person: string) => asksOf(project).some((a) => a.person === person)
/** `person` asks for runs on `item` (the gateway, with the session's person; the caller checked the role). One person per
 *  item: another person's live ask is not replaced (throws). The same person again renews it. */
export function addAsk(project: string, item: string, person: string, ttlMs = ASK_TTL_MS): Ask {
  if (!ITEM.test(item)) throw new Error('not an item id')
  if (!PERSON.test(person)) throw new Error("not a person's name")
  const t = Date.now(), asks = asksOf(project, t), other = asks.find((a) => a.item === item && a.person !== person)
  if (other) throw new Error(`${item} on ${project} is asked for by ${other.person} already, until ${new Date(other.expires).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
  const rest = asks.filter((a) => a.item !== item)
  if (rest.length >= MAX) throw new Error(`${project} has ${MAX} asks already`)
  const a = { item, person, at: t, expires: t + ttlMs }
  save(project, [...rest, a]); return a
}
/** Drop an ask (`person`: only if it is theirs). True if one was there. */
export function dropAsk(project: string, item: string, person?: string): boolean {
  const asks = asksOf(project), keep = asks.filter((a) => !(a.item === item && (!person || a.person === person)))
  if (keep.length === asks.length) return false
  save(project, keep); return true
}
/** Every project with a record. */
export const askProjects = () => (existsSync(dir()) ? readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((p) => PROJECT_ID.test(p)) : [])
