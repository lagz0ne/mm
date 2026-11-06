// The engine's one way into Paseo (wake, the board, bin/lead, bin/assist): its SDK over one persistent connection
// instead of a `paseo` process per call (a CLI call takes ~0.6 s; a list over the connection ~15 ms).
// The SDK is loaded at runtime from the Paseo install itself (the client package the installed CLI ships, so it matches
// the daemon), never compiled into anything: it declares no licence. Order: PASEO_SDK (a path to its entry file), then
// the installed CLI's own copy. If it can't load or connect, every call falls back to the CLI, so nothing breaks.
// Address: PASEO_URL, else .run/endpoints.json "paseo", else the daemon's default. Leads never use this module (their
// Paseo use stays the CLI, under the guard and their permission rules).
// A brake on that (sy-e5i): in an agent's shell (CLAUDECODE or PASEO_AGENT_ID set), the calls that change an agent
// (send, archive) refuse, unless the process is one of the engine's own services that make them (ENGINE: wake). The
// reads stay open there: bin/lead start, run by the setup agent, takes sdkPath() through bin/lib/lead-workspace.mjs.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { endpoints } from './svc.mjs'

const E = process.env
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The engine's scripts that may change an agent: the services the process manager runs, never an agent's shell. */
const ENGINE = [path.join(HERE, '..', 'wake')]
const real = (f) => { try { return fs.realpathSync(f) } catch { return path.resolve(f) } }
/** Throws when this process is an agent's (its shell, or a script it started) and not one of the engine's services. */
function engineOnly(what) {
  if (!E.CLAUDECODE && !E.PASEO_AGENT_ID) return
  const main = process.argv[1] ? real(process.argv[1]) : ''
  if (main && ENGINE.some((f) => real(f) === main)) return
  throw new Error(`bin/lib/paseo.mjs ${what}: refused in an agent's shell (the engine's services make this call; an agent uses the paseo CLI, under its permission rules)`)
}
const BIN = E.PASEO_BIN || 'paseo'
const URL_ = E.PASEO_URL || endpoints().paseo || 'ws://127.0.0.1:6767/ws'
let client = null, connecting = null, sdkFailed = ''

function which(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null
  for (const d of (E.PATH || '').split(':')) { const f = path.join(d, cmd); try { fs.accessSync(f, fs.constants.X_OK); return f } catch {} }
  return null
}
/** The SDK's entry file: PASEO_SDK, else the client package inside the installed CLI. */
export function sdkPath() {
  if (E.PASEO_SDK) return E.PASEO_SDK
  const bin = which(BIN); if (!bin) return null
  let dir = path.dirname(fs.realpathSync(bin))
  for (let i = 0; i < 6 && dir !== '/'; i++, dir = path.dirname(dir)) {
    const f = path.join(dir, 'node_modules', '@getpaseo', 'client', 'dist', 'index.js')
    if (fs.existsSync(f)) return f
  }
  return null
}

async function sdk() {
  if (client) return client
  if (sdkFailed || E.PASEO_NO_SDK === '1') return null
  connecting ||= (async () => {
    const f = sdkPath(); if (!f) throw new Error('no Paseo SDK found')
    const { createPaseoClient } = await import(pathToFileURL(f).href)
    const c = createPaseoClient({ url: URL_, clientId: `mm-${path.basename(process.argv[1] || 'engine')}`, reconnect: { enabled: true } })
    await Promise.race([c.connect(), new Promise((_, no) => setTimeout(() => no(new Error('connect timeout')), 8000))])
    return (client = c)
  })().catch((e) => { sdkFailed = e.message; connecting = null; return null })
  return connecting
}
/** How calls go right now: 'sdk' or 'cli (why)'. */
export const via = () => (client ? 'sdk' : `cli${sdkFailed ? ` (${sdkFailed})` : ''}`)

const cli = (args, timeout = 20000) => new Promise((ok, no) => execFile(BIN, args, { timeout, maxBuffer: 16 << 20 }, (err, out, errOut) =>
  err ? no(new Error(String(errOut || err.message).trim().slice(0, 300))) : ok(out)))
const matches = (a, labels) => Object.entries(labels || {}).every(([k, v]) => a.labels?.[k] === v)

const HOME = E.HOME || ''
/** One shape whichever path brought it: {id, shortId, name, status, cwd (absolute), labels, provider, thinking, created,
 *  updated (its last activity, when Paseo gives one), archived}. */
const norm = (a) => ({ id: a.id, shortId: a.shortId || String(a.id).slice(0, 7), name: a.title ?? a.name ?? null, status: a.status,
  cwd: String(a.cwd || '').replace(/^~(?=\/|$)/, HOME), labels: a.labels || {}, provider: a.provider ?? null,
  thinking: a.thinking ?? a.thinkingOptionId ?? null, created: a.created ?? a.createdAt ?? null,
  updated: a.lastActivityAt ?? a.updatedAt ?? null, archived: !!(a.archivedAt || a.archived) })
/** Agents (not archived unless `archived`), optionally only those with all these labels. */
export async function list(labels = {}, { archived = false } = {}) {
  const c = await sdk()
  if (c) {
    const { entries } = await c.agents.list()
    return entries.map((e) => e.agent).filter((a) => a && (archived || !a.archivedAt) && matches(a, labels)).map(norm)
  }
  const args = ['ls', '-g', ...(archived ? ['-a'] : []), ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), '--json']
  // the CLI's list has no labels: an agent it returns has at least the ones it was filtered by
  return JSON.parse(await cli(args)).map((a) => norm({ ...a, labels: a.labels || { ...labels } }))
}
/** Send a message to an agent (no wait). */
export async function send(id, text) {
  engineOnly('send')
  const c = await sdk()
  if (c) return c.agents.ref(id).send(text)
  await cli(['send', id, '--no-wait', '--prompt', text])
}
/** Delete an agent for good (interrupted if running, then hard-deleted: no history left to resume). The engine's only:
 *  person runs (sy-q8fv), which must never come back on the daemon's own token, as an archived run would on a send. */
export async function remove(id) {
  engineOnly('delete')
  await cli(['delete', id])
}
/** Archive an agent (soft: its history stays in Paseo). */
export async function archive(id) {
  engineOnly('archive')
  const c = await sdk()
  if (c) return c.agents.ref(id).archive()
  await cli(['archive', '--force', id])
}
/** Agent changes as they happen (SDK only); returns an unsubscribe function, or null on the CLI path (poll instead). */
export async function onAgents(handler) {
  const c = await sdk()
  return c ? c.agents.subscribe(handler) : null
}
export async function close() { try { await client?.close() } catch {} client = null }

/** A process's start (field 22 of /proc/<pid>/stat, clock ticks since boot), or '' when it can't be read. */
export function procStart(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || '' } catch { return '' }
}
/** The daemon's worker, the process that holds the live agents, as `<pid>.<start>`; null when the daemon can't say.
 *  A person run carries the worker it was made on (its label `paseo-worker`, bin/lib/run-as.mjs): a daemon that
 *  restarted has another worker, and a run made on the old one comes back only without its token (sy-q8fv). Paseo's
 *  status call is the CLI's (`paseo daemon status`); kept for WORKER_TTL ms. */
const WORKER_TTL = Number(E.PASEO_WORKER_TTL_MS || 5000)
let workerSeen = { at: 0, v: null }
export async function worker({ fresh = false } = {}) {
  if (!fresh && Date.now() - workerSeen.at < WORKER_TTL) return workerSeen.v
  let v = null
  try {
    const pid = Number(JSON.parse(await cli(['daemon', 'status', '--json'], 15000))?.workerPid)
    if (Number.isInteger(pid) && pid > 0) v = `${pid}.${procStart(pid) || '0'}`
  } catch {}
  workerSeen = { at: Date.now(), v }
  return v
}
