// Person runs in a box (sy-q8fv): the host's own record of the runs `mm run-as` started in each box, so the box's egress
// list has the model's host while a person's run is there, and not after. A person's run talks to the model directly,
// on that person's own token (never through mm.ai, which signs with the owner's key). mm adds the host when a run starts
// in a box, and the sweep removes it once none is left (src/runas.ts sweep: mm cron, and every mm run-as). The record is
// the host's, outside every project and box: $MM_HOME/person-runs/<project>.json (0600 in a 0700 folder). Never a token.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'

export const MODEL_HOST = 'api.anthropic.com'
/** Person runs on for this machine (`mm config set wake.person_runs true`): the host's wake starts its leads per person,
 *  and a box's wake may ask the host for them (src/boxruns.ts, over the box's mm.api socket). Off as shipped. */
export const personRunsConfigured = () => { const v = getPath(loadConfig(), 'wake.person_runs'); return v === true || ['true', 'on', 'yes'].includes(String(v)) }
/** ...or on for a test's own mm.api on a live machine (MM_PERSON_RUNS=1, test/box.sh): never the machine's process
 *  manager (that is the config only, src/pc.ts). */
export const personRunsOn = () => process.env.MM_PERSON_RUNS === '1' || personRunsConfigured()
/** A run mm started: whose, for which role, its agent (null until Paseo gave its id), and when. */
export type PersonRun = { person: string; role: string; agent: string | null; at: number }
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
