// mm run-as (sy-8n4w): a lead's run done for one person, on that person's own long-term Claude token. Before this,
// nothing tied a run to a person: every lead ran on the Paseo daemon's token (the owner's). This is the smallest
// honest piece: the owner (or mm) names the person, the project and the role; mm checks the person's role there, opens
// the person's sealed token into the noswap secrets tmpfs for this run only, and hands it to `bin/lead start <role>
// --as <person>` on its stdin (the file is removed as soon as the child holds it). bin/lead gives it to the run as
// CLAUDE_CODE_OAUTH_TOKEN, in the unmodified Claude Code binary. In a box, the same goes over `docker exec -i`'s stdin:
// the token never enters the box's files. A person with no token: no run, and never the owner's token instead.
// A run in a box reaches the model directly (its own token, never through mm.ai): mm puts the model's host on the box's
// egress list when the run starts there, and the sweep takes it off once no person run is left (sy-q8fv; the host's
// record, src/personruns.ts). bin/wake starts its runs through here (item work as the item's requester, upkeep as the
// project's sponsor), on the host.
import { closeSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { boxRunning, egressList, egressReload, execArgs } from './box'
import { getPath, loadConfig } from './config'
import { run } from './env'
import { PERSON, hasToken, roleOf, tokenName } from './persontoken'
import { MODEL_HOST, type PersonRun, recorded, runsOf, saveRuns } from './personruns'
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
  const env = { ...(o.env || {}), MM_RUN_AS: person }
  return { root, project: a.project, box: !!a.box, owner, token, env, cmd: a.box ? execArgs(root, lead, false, env) : lead }
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
  // a box: the model's host on its egress list for this run (the record first, so the list has it), before any token opens
  const entry: PersonRun | null = p.box && p.token ? { person, role, agent: null, at: Date.now() } : null
  if (entry) boxRunStarts(p.root, p.project, entry)
  let fd: number | undefined, file = '', code = 1, agent = '', err = ''
  try {
    try {
      if (p.token) { file = vault.openForRun(tokenName(person)); fd = openSync(file, 'r') }
    } finally { if (file) rmSync(file, { force: true }) } // the child gets the open file, never its name
    try {
      const child = Bun.spawn(p.cmd, { stdin: fd ?? 'ignore', stdout: 'pipe', stderr: o.capture ? 'pipe' : 'inherit', env: { ...process.env, ...p.env } })
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
  } finally { if (entry) boxRunEnded(p.root, p.project, entry, code === 0 && /^[\w-]{4,80}$/.test(agent) ? agent : null) }
}

const say = (m: string) => console.error(`mm run-as: ${m}`)
/** A person's run starts in a box: the runs that are gone are dropped first, this one is recorded, and the box's egress
 *  gets the model's host if it had none (its proxy restarts to read it). Throws (and records nothing) when it can't. */
function boxRunStarts(root: string, project: string, entry: PersonRun) {
  sweep(root)
  const had = egressList(root).includes(MODEL_HOST)
  saveRuns(project, [...runsOf(project), entry])
  if (had) return
  const r = egressReload(root)
  if (r.status === 'fail') {
    saveRuns(project, runsOf(project).filter((x) => x.at !== entry.at || x.person !== entry.person))
    egressReload(root)
    throw new Error(`${project}'s egress could not take ${MODEL_HOST}, so the run does not start: ${r.detail}`)
  }
  say(`${project}'s egress now has ${MODEL_HOST}, while a person's run is there (a person's run talks to the model directly, not through mm.ai)`)
}
/** The run started (its agent id) or did not (null: it is dropped, and the model's host with it when none is left). */
function boxRunEnded(root: string, project: string, entry: PersonRun, agent: string | null) {
  const same = (x: PersonRun) => x.at === entry.at && x.person === entry.person && x.role === entry.role
  const runs = runsOf(project)
  if (agent) { saveRuns(project, runs.map((x) => (same(x) ? { ...x, agent } : x))); return }
  saveRuns(project, runs.filter((x) => !same(x)))
  if (!egressList(root).includes(MODEL_HOST)) { egressReload(root); say(`the run did not start: ${MODEL_HOST} is off ${project}'s egress again`) }
}

const PENDING_MS = 10 * 60_000 // a run recorded with no agent id yet (mm run-as is still starting it)
/** The ids of the box's agents (not archived), as its Paseo lists them; an empty set when the box is not running; null
 *  when it can't be read (then nothing is dropped). The box answers this: a box that lies can only keep the model's
 *  host longer, and only after a person's run was really there. */
function boxAgents(root: string, project: string): Set<string> | null {
  if (!boxRunning(project)) return new Set()
  const r = run(execArgs(root, ['paseo', 'ls', '-g', '--label', `project=${project}`, '--json'], false), { timeoutMs: 30_000 })
  if (!r.ok) return null
  try { return new Set((JSON.parse(r.out) as { id?: string }[]).map((x) => String(x?.id || '')).filter(Boolean)) } catch { return null }
}
/** The box's person runs that are gone (archived, the box down) are dropped from the record; when none is left, the
 *  model's host leaves its egress list (unless the project lists it itself, or the owner granted it). */
export function sweep(root: string): { project: string; dropped: number; left: number; egress?: string } {
  const project = readAnswers(root).project, runs = runsOf(project)
  if (!runs.length) return { project, dropped: 0, left: 0 }
  const live = boxAgents(root, project)
  const keep = runs.filter((r) => (r.agent ? live === null || live.has(r.agent) : Date.now() - r.at < PENDING_MS))
  if (keep.length === runs.length) return { project, dropped: 0, left: runs.length }
  saveRuns(project, keep)
  if (keep.length || egressList(root).includes(MODEL_HOST)) return { project, dropped: runs.length - keep.length, left: keep.length }
  const r = egressReload(root)
  return { project, dropped: runs.length - keep.length, left: 0, egress: `${MODEL_HOST} off: ${r.detail}` }
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
