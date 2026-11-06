// What the owner granted a box through mm's project API (src/api.ts, sy-b15.8): the host's own record, in a folder no
// box mounts. mm.api writes it when it applies an approved request (and on undo); mm up (the box's egress list, its
// app slot, its secrets), mm fill / mm needs and the sign-in gateway's host map read it. A small module with no heavy
// imports, so each of them can read it.
//   $MM_HOME/api/ (0700): api.db (the requests), approve.sock (the owner's socket), granted/<project>.json (0600)
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'

// MM_API_DIR is for tests (a throwaway store; the machine's is untouched)
export const API_DIR = process.env.MM_API_DIR || join(DIRS.mm, 'api')
/** The project API on for this machine (`mm config set api.enabled true`; t2: it changes the approval path). While it
 *  is off, nothing changes for a box: no socket, and its app slot runs from release/ as before. While it is on, a box's
 *  app slot runs only a build the owner approved. MM_API_ENABLED=1 is for tests on a live machine (test/box.sh: a
 *  throwaway mm.api, MM_API_DIR); it never puts mm.api on the machine's process manager (that is the config only). */
export const apiConfigured = () => { const v = getPath(loadConfig(), 'api.enabled'); return v === true || v === 'true' }
export const apiEnabled = () => process.env.MM_API_ENABLED === '1' || apiConfigured()
export const APPROVE_SOCK = join(API_DIR, 'approve.sock')
/** The box's own socket on the host; only that box mounts its folder (read-only), at /run/mm/api. */
export const apiSocketDir = (project: string) => join(DIRS.mm, 'box', project, 'api')
export const apiSocket = (project: string) => join(apiSocketDir(project), 'api.sock')

// ---------- the fixed formats (checked when a box asks, and again when mm applies) ----------
export const PROJECT_ID = /^[a-z][a-z0-9-]{0,62}$/
/** A route name: one DNS label under the project's own names (<name>.<project>.<domain>). */
export const ROUTE_NAME = /^(?=.{1,30}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
/** A site: an exact host name (no wildcard, no address, no port), a letter top-level label. */
export const SITE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
/** A build: one folder name under release/ (no dots first, so never `.` or `..`). */
export const BUILD = /^[a-z0-9][a-z0-9_.-]{0,63}$/
/** A secret: a NEW name in this project's vault namespace (<project>.<name>); no dot, so never another namespace. */
export const SECRET_NAME = /^[a-z0-9-]{1,40}$/
export const CALLS = ['route', 'egress', 'release', 'secret'] as const
export type Call = typeof CALLS[number]
/** The one field each call takes, and its format. */
export const FIELD: Record<Call, { key: string; re: RegExp }> = {
  route: { key: 'name', re: ROUTE_NAME }, egress: { key: 'site', re: SITE }, release: { key: 'build', re: BUILD }, secret: { key: 'name', re: SECRET_NAME },
}
export const formatOk = (call: string, value: string) => (CALLS as readonly string[]).includes(call) && FIELD[call as Call].re.test(value) && !value.includes('..')

export type Granted = {
  routes: { name: string; host: string; open: boolean; id: string }[]
  egress: { site: string; id: string }[]
  release: { build: string; id: string } | null
  secrets: { name: string; id: string }[]
}
const empty = (): Granted => ({ routes: [], egress: [], release: null, secrets: [] })
const file = (project: string) => join(API_DIR, 'granted', `${project}.json`)

/** The project's grants, each checked against its format again (a value that doesn't pass is dropped). */
export function granted(project: string): Granted {
  if (!PROJECT_ID.test(project)) return empty()
  let j: Partial<Granted> = {}
  try { j = JSON.parse(readFileSync(file(project), 'utf8')) } catch { return empty() }
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const arr = <T>(v: unknown) => (Array.isArray(v) ? v as T[] : [])
  return {
    routes: arr<Granted['routes'][number]>(j.routes).filter((r) => ROUTE_NAME.test(s(r?.name)) && s(r?.host).startsWith(`${r.name}.${project}.`)).map((r) => ({ name: r.name, host: r.host, open: r.open === true, id: s(r.id) })),
    egress: arr<Granted['egress'][number]>(j.egress).filter((e) => SITE.test(s(e?.site))).map((e) => ({ site: e.site, id: s(e.id) })),
    release: j.release && BUILD.test(s(j.release.build)) && !j.release.build.includes('..') ? { build: j.release.build, id: s(j.release.id) } : null,
    secrets: arr<Granted['secrets'][number]>(j.secrets).filter((x) => SECRET_NAME.test(s(x?.name))).map((x) => ({ name: x.name, id: s(x.id) })),
  }
}
export function saveGranted(project: string, g: Granted) {
  if (!PROJECT_ID.test(project)) throw new Error(`not a project id: ${project}`)
  const d = join(API_DIR, 'granted')
  mkdirSync(API_DIR, { recursive: true, mode: 0o700 }); chmodSync(API_DIR, 0o700); mkdirSync(d, { recursive: true, mode: 0o700 })
  const f = file(project), t = `${f}.tmp-${process.pid}`
  writeFileSync(t, JSON.stringify(g, null, 2) + '\n', { mode: 0o600 }); renameSync(t, f)
}
/** mm archive: the project's grants go (its requests stay in api.db, for the audit). */
export function forgetGranted(project: string) { if (PROJECT_ID.test(project) && existsSync(file(project))) rmSync(file(project), { force: true }) }
/** Every project with grants (the gateway's host map reads their routes). */
export function grantedProjects(): string[] {
  const d = join(API_DIR, 'granted')
  try { return readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((p) => PROJECT_ID.test(p)) } catch { return [] }
}
