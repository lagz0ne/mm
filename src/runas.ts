// mm run-as (sy-8n4w): a lead's run done for one person, on that person's own long-term Claude token. Before this,
// nothing tied a run to a person: every lead ran on the Paseo daemon's token (the owner's). This is the smallest
// honest piece: the owner (or mm) names the person, the project and the role; mm checks the person's role there, opens
// the person's sealed token into the noswap secrets tmpfs for this run only, and hands it to `bin/lead start <role>
// --as <person>` on its stdin (the file is removed as soon as the child holds it). bin/lead gives it to the run as
// CLAUDE_CODE_OAUTH_TOKEN, in the unmodified Claude Code binary. In a box, the same goes over `docker exec -i`'s stdin:
// the token never enters the box's files. A person with no token: no run, and never the owner's token instead.
import { closeSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { egressList, execArgs } from './box'
import { getPath, loadConfig } from './config'
import { PERSON, hasToken, roleOf, tokenName } from './persontoken'
import { findRoot, readAnswers } from './project'
import * as vault from './vault'

export const MODEL_HOST = 'api.anthropic.com'
const ROLE = /^[a-z][a-z0-9-]{1,23}$/

/** What the run would be, or why it can't start. Exported for the tests; never touches a token. */
export function plan(person: string, ref: string, role: string, o: { model?: string } = {}) {
  if (!PERSON.test(person)) throw new Error(`not a person's name: ${person}`)
  if (!ROLE.test(role) && role !== 'setup') throw new Error(`not a role: ${role}`)
  if (o.model !== undefined && !/^[\w./:-]{1,80}$/.test(o.model)) throw new Error('not a model name')
  const cfg = loadConfig(), root = findRoot(ref), a = readAnswers(root)
  const domain = String(getPath(cfg, 'domain') ?? ''), authHost = String(getPath(cfg, 'auth_host') ?? (domain ? `auth.${domain}` : 'auth.localhost'))
  const r = roleOf(person, a.project), owner = r.role === 'owner'
  if (!owner) {
    if (!r.role) throw new Error(`${person} can't have a run on ${a.project}: ${r.why || 'no role there'}`)
    if (r.role === 'viewer') throw new Error(`${person} is a viewer on ${a.project}: a viewer has no runs`)
  }
  const token = hasToken(person)
  if (!token && !owner) throw new Error(`${person} has no Claude token, so the run does not start: set your Claude token on the home page (https://${authHost}/s/token). mm never uses the owner's token for another person.`)
  // in a box, the run reaches the model directly (its own token, never through mm.ai): only through the box's egress
  if (token && a.box && !egressList(root).includes(MODEL_HOST))
    throw new Error(`${a.project} is a box, and its egress list has no ${MODEL_HOST}: a run on a person's own token can't reach the model from it. The owner decides (services.yaml egress, or the project API); note that this way skips mm.ai's checks of server-side tools.`)
  const lead = [join(root, 'bin', 'lead'), 'start', role, ...(o.model ? ['--model', o.model] : []), ...(token ? ['--as', person] : [])]
  return { root, project: a.project, box: !!a.box, owner, token, cmd: a.box ? execArgs(root, lead, false) : lead }
}

/** Start the run; the child's exit code. */
export async function runAs(person: string, ref: string, role: string, o: { model?: string } = {}): Promise<number> {
  const p = plan(person, ref, role, o)
  if (!p.token) console.error(`mm run-as: ${person} is the owner and has no personal token set: the run uses the machine's own token (the owner's), as every lead does`)
  let fd: number | undefined, file = ''
  try {
    if (p.token) { file = vault.openForRun(tokenName(person)); fd = openSync(file, 'r') }
  } finally { if (file) rmSync(file, { force: true }) } // the child gets the open file, never its name
  try {
    const child = Bun.spawn(p.cmd, { stdin: fd ?? 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, MM_RUN_AS: person } })
    if (fd !== undefined) { closeSync(fd); fd = undefined }
    return await child.exited
  } finally { if (fd !== undefined) closeSync(fd) }
}
