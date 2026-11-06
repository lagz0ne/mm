// Person runs in a box (sy-q8fv, sy-otxx 2): the host's own record of the runs `mm run-as` started in each box: whose,
// which role, its agent, and when its mm.ai key ends. A person's run in a box never holds that person's token, and the
// box's egress never gets the model's host for it: the run talks to mm.ai with a key of its own (src/ai.ts, kind
// `person`), bound to (project, person) and ending by the host's clock (`expires`); mm.ai calls the model with the
// person's own token, on the host. The sweep (mm cron, and every mm run-as) drops a run once its key has ended, by the
// host's clock, never by what the box says. The record is the host's, outside every project and box:
// $MM_HOME/person-runs/<project>.json (0600 in a 0700 folder). Never a token, never a key.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'

export const MODEL_HOST = 'api.anthropic.com'
/** Person runs on for this machine (`mm config set wake.person_runs true`): the host's wake starts its leads per person,
 *  and a box's wake may ask the host for them (src/boxruns.ts, over the box's mm.api socket). Off as shipped. */
export const personRunsConfigured = () => { const v = getPath(loadConfig(), 'wake.person_runs'); return v === true || ['true', 'on', 'yes'].includes(String(v)) }
/** The config is the only switch (sy-otxx 3): no environment turns it on. */
export const personRunsOn = personRunsConfigured
/** How long a person's run in a box keeps its mm.ai key (`wake.person_run_hours`, 1 to 24; 4 as shipped). After that
 *  the key is refused and the box's wake deletes the run (its label run-expires); a new ask starts a new one. */
export function runTtlMs(): number {
  const v = Number(getPath(loadConfig(), 'wake.person_run_hours'))
  return (Number.isFinite(v) && v >= 1 && v <= 24 ? v : 4) * 3600e3
}
/** A run mm started: whose, for which role, its agent (null until Paseo gave its id), when, and when its key ends. */
export type PersonRun = { person: string; role: string; agent: string | null; at: number; expires?: number }
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const dir = () => join(DIRS.mm, 'person-runs')
const file = (project: string) => { if (!PROJECT_ID.test(project)) throw new Error(`not a project id: ${project}`); return join(dir(), `${project}.json`) }

export function runsOf(project: string): PersonRun[] {
  try {
    const j = JSON.parse(readFileSync(file(project), 'utf8')) as { runs?: PersonRun[] }
    return Array.isArray(j.runs) ? j.runs.filter((r) => r && typeof r.person === 'string' && typeof r.at === 'number') : []
  } catch { return [] }
}
/** Written whole and renamed into place; no runs left: no file. */
export function saveRuns(project: string, runs: PersonRun[]) {
  const f = file(project)
  if (!runs.length) { rmSync(f, { force: true }); return }
  mkdirSync(dir(), { recursive: true, mode: 0o700 }); chmodSync(dir(), 0o700)
  writeFileSync(`${f}.tmp`, JSON.stringify({ runs }, null, 1) + '\n', { mode: 0o600 }); renameSync(`${f}.tmp`, f)
}
export const hasRuns = (project: string) => runsOf(project).length > 0
/** The projects with a record (the sweep's list). */
export const recorded = () => (existsSync(dir()) ? readdirSync(dir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((p) => PROJECT_ID.test(p)) : [])
