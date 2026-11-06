// mm run-as (sy-8n4w): a lead's run done for one person, on that person's own long-term Claude token. Before this,
// nothing tied a run to a person: every lead ran on the Paseo daemon's token (the owner's). This is the smallest
// honest piece: the owner (or mm) names the person, the project and the role; mm checks the person's role there, opens
// the person's sealed token into the noswap secrets tmpfs for this run only, and hands it to `bin/lead start <role>
// --as <person>` on its stdin (the file is removed as soon as the child holds it). bin/lead gives it to the run as
// CLAUDE_CODE_OAUTH_TOKEN, in the unmodified Claude Code binary. A person with no token: no run, and never the owner's
// token instead. In a box (sy-otxx 2) the person's token never goes in: mm mints the run an mm.ai key of its own
// (src/ai.ts, kind `person`: bound to the project and the person, ending by the host's clock after runTtlMs()), and
// hands that over `docker exec -i`'s stdin. The run reaches the model through mm.ai, which calls it with the person's
// own token on the host; the box's egress never gets the model's host. The host's record (src/personruns.ts) keeps each
// run until its key ends. bin/wake starts its runs through here on the host (item work as the item's requester,
// upkeep as the project's sponsor), and src/boxruns.ts for a box (the person the host's record of asks holds).
import { closeSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { aiEnabled, mintKey, revokeKey, store as aiStore } from './ai'
import { egressList, egressReload, execArgs } from './box'
import { getPath, loadConfig } from './config'
import { run } from './env'
import { PERSON, hasToken, roleOf, tokenName } from './persontoken'
import { MODEL_HOST, type PersonRun, recorded, runsOf, runTtlMs, saveRuns } from './personruns'
import { findRoot, readAnswers } from './project'
import * as vault from './vault'

export { MODEL_HOST }
const ROLE = /^[a-z][a-z0-9-]{1,23}$/

/** The words a person with no token gets (mm run-as, and a box's wake on its item: bin/wake matches "has no Claude
 *  token" and the page's URL). */
export function noTokenText(person: string, why: string) {
  const cfg = loadConfig(), domain = String(getPath(cfg, 'domain') ?? ''), authHost = String(getPath(cfg, 'auth_host') ?? (domain ? `auth.${domain}` : 'auth.localhost'))
  return `${person} has no Claude token, so the run does not start: set your Claude token on the home page (https://${authHost}/s/token). ${why}`
}

/** What the run would be, or why it can't start. Exported for the tests; never touches a token. `env`: what the lead's
 *  first prompt takes (LEAD_NEXT, LEAD_ITEMS), into the box too (on docker's command line: never a secret). */
export function plan(person: string, ref: string, role: string, o: { model?: string; env?: Record<string, string> } = {}) {
  if (!PERSON.test(person)) throw new Error(`not a person's name: ${person}`)
  if (!ROLE.test(role) && role !== 'setup') throw new Error(`not a role: ${role}`)
  if (o.model !== undefined && !/^[\w./:-]{1,80}$/.test(o.model)) throw new Error('not a model name')
  const root = findRoot(ref), a = readAnswers(root)
  const r = roleOf(person, a.project), owner = r.role === 'owner'
  if (!owner) {
    if (!r.role) throw new Error(`${person} can't have a run on ${a.project}: ${r.why || 'no role there'}`)
    if (r.role === 'viewer') throw new Error(`${person} is a viewer on ${a.project}: a viewer has no runs`)
  }
  const token = hasToken(person)
  if (!token && !owner) throw new Error(noTokenText(person, 'mm never uses the owner\'s token for another person.'))
  const lead = [join(root, 'bin', 'lead'), 'start', role, ...(o.model ? ['--model', o.model] : []), ...(token ? ['--as', person] : [])]
  // a box: when the run's mm.ai key ends (the host's clock), for the run's label (the box's wake deletes it then)
  const expires = a.box && token ? Date.now() + runTtlMs() : 0
  const env: Record<string, string> = { ...(o.env || {}), MM_RUN_AS: person, ...(expires ? { MM_RUN_EXPIRES: String(Math.floor(expires / 1000)) } : {}) }
  return { root, project: a.project, box: !!a.box, owner, token, expires, env, cmd: a.box ? execArgs(root, lead, false, env) : lead }
}

/** Start the run (mm run-as); the child's exit code. Its output goes on to ours; its last line is the run's agent id. */
export async function runAs(person: string, ref: string, role: string, o: { model?: string } = {}): Promise<number> {
  const env = Object.fromEntries(['LEAD_NEXT', 'LEAD_ITEMS'].filter((k) => process.env[k] !== undefined).map((k) => [k, String(process.env[k])]))
  return (await startRun(person, ref, role, { ...o, env })).code
}
export type Started = { code: number; agent: string; err: string }
/** Start the run: its exit code, its agent id (exit 0 only) and, with `capture`, its stderr (else it goes on to ours,
 *  and its stdout too). `ownToken`: on the person's own token only, the owner's as well (a run a box asked for,
 *  src/boxruns.ts: never the machine's token); `timeoutMs`: the child is killed after that. */
export async function startRun(person: string, ref: string, role: string, o: { model?: string; env?: Record<string, string>; ownToken?: boolean; capture?: boolean; timeoutMs?: number } = {}): Promise<Started> {
  const p = plan(person, ref, role, o)
  if (!p.token && o.ownToken) throw new Error(noTokenText(person, 'A run a box asks for is only ever on that person\'s own token, never the machine\'s (the owner\'s).'))
  if (!p.token) console.error(`mm run-as: ${person} is the owner and has no personal token set: the run uses the machine's own token (the owner's), as every lead does`)
  // a box: the run gets an mm.ai key of its own, never the token (sy-otxx 2); mm.ai must be on to carry it
  if (p.box && p.token && !aiEnabled()) throw new Error(`a person's run in a box reaches the model through mm.ai only, and mm.ai is off on this machine (ai.enabled): no run`)
  const entry: PersonRun | null = p.box && p.token ? { person, role, agent: null, at: Date.now(), expires: p.expires } : null
  let keyHash = ''
  if (entry) { sweep(p.root); saveRuns(p.project, [...runsOf(p.project), entry]) }
  let fd: number | undefined, file = '', code = 1, agent = '', err = ''
  try {
    let stdin: number | Blob | 'ignore' = 'ignore'
    if (entry) {
      const d = aiStore()
      try { const k = mintKey(d, p.project, { person, kind: 'person', ttlMs: p.expires - Date.now() }); keyHash = k.hash; stdin = new Blob([`${k.key}\n`]) } finally { d.close() }
    } else if (p.token) {
      try { file = vault.openForRun(tokenName(person)); fd = openSync(file, 'r'); stdin = fd } finally { if (file) rmSync(file, { force: true }) } // the child gets the open file, never its name
    }
    try {
      const child = Bun.spawn(p.cmd, { stdin, stdout: 'pipe', stderr: o.capture ? 'pipe' : 'inherit', env: { ...process.env, ...p.env } })
      if (fd !== undefined) { closeSync(fd); fd = undefined }
      const timer = o.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), o.timeoutMs) : undefined
      child.exited.finally(() => clearTimeout(timer))
      const errRead = o.capture ? new Response(child.stderr as ReadableStream<Uint8Array>).text().then((t) => { err = t }) : Promise.resolve()
      let out = ''
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) { const t = new TextDecoder().decode(chunk); out += t; if (!o.capture) process.stdout.write(t) }
      code = await child.exited; await errRead
      agent = out.trim().split('\n').pop()?.trim() || ''
      return { code, agent: code === 0 ? agent : '', err }
    } finally { if (fd !== undefined) closeSync(fd) }
  } finally { if (entry) boxRunEnded(p.project, entry, code === 0 && /^[\w-]{4,80}$/.test(agent) ? agent : null, keyHash) }
}

/** The run started (its agent id: recorded) or did not (null: dropped, and its key revoked at once). */
function boxRunEnded(project: string, entry: PersonRun, agent: string | null, keyHash: string) {
  const same = (x: PersonRun) => x.at === entry.at && x.person === entry.person && x.role === entry.role
  const runs = runsOf(project)
  if (agent) { saveRuns(project, runs.map((x) => (same(x) ? { ...x, agent } : x))); return }
  saveRuns(project, runs.filter((x) => !same(x)))
  if (keyHash) { const d = aiStore(); try { revokeKey(d, keyHash) } finally { d.close() } }
}

const PENDING_MS = 10 * 60_000 // a record from before sy-otxx (no expiry): it goes this long after it started
/** The box's person runs whose key has ended are dropped from the record, by the host's clock only (never what the box
 *  says). A record from before (the model's host was on the box's egress then) also reloads the egress, so the host's
 *  list (which no longer has it) is what the proxy holds. */
export function sweep(root: string): { project: string; dropped: number; left: number; egress?: string } {
  const project = readAnswers(root).project, runs = runsOf(project), t = Date.now()
  if (!runs.length) return { project, dropped: 0, left: 0 }
  const keep = runs.filter((r) => (r.expires ?? r.at + PENDING_MS) > t)
  if (keep.length === runs.length) return { project, dropped: 0, left: runs.length }
  saveRuns(project, keep)
  const old = runs.some((r) => r.expires === undefined)
  if (!old || egressList(root).includes(MODEL_HOST)) return { project, dropped: runs.length - keep.length, left: keep.length }
  const r = egressReload(root)
  return { project, dropped: runs.length - keep.length, left: keep.length, egress: `${MODEL_HOST} off: ${r.detail}` }
}
/** Every recorded box (mm cron, once a minute): a project that is gone, or no longer a box, loses its record. */
export function sweepAll() {
  const out: ReturnType<typeof sweep>[] = []
  for (const project of recorded()) {
    let root = ''
    try { root = findRoot(project) } catch { saveRuns(project, []); continue }
    if (!readAnswers(root).box) { saveRuns(project, []); continue }
    try { out.push(sweep(root)) } catch {}
  }
  return out
}
