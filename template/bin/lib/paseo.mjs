// The engine's one way into Paseo (wake, the board, bin/lead, bin/assist): its SDK over one persistent connection
// instead of a `paseo` process per call (a CLI call takes ~0.6 s; a list over the connection ~15 ms).
// The SDK is loaded at runtime from the Paseo install itself (the client package the installed CLI ships, so it matches
// the daemon), never compiled into anything: it declares no licence. Order: PASEO_SDK (a path to its entry file), then
// the installed CLI's own copy. If it can't load or connect, every call falls back to the CLI, so nothing breaks.
// Address: PASEO_URL, else .run/endpoints.json "paseo", else the daemon's default. Leads never use this module (their
// Paseo use stays the CLI, under the guard and their permission rules).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { endpoints } from './svc.mjs'

const E = process.env
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
/** One shape whichever path brought it: {id, shortId, name, status, cwd (absolute), labels, provider, thinking, created, archived}. */
const norm = (a) => ({ id: a.id, shortId: a.shortId || String(a.id).slice(0, 7), name: a.title ?? a.name ?? null, status: a.status,
  cwd: String(a.cwd || '').replace(/^~(?=\/|$)/, HOME), labels: a.labels || {}, provider: a.provider ?? null,
  thinking: a.thinking ?? a.thinkingOptionId ?? null, created: a.created ?? a.createdAt ?? null, archived: !!(a.archivedAt || a.archived) })
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
  const c = await sdk()
  if (c) return c.agents.ref(id).send(text)
  await cli(['send', id, '--no-wait', '--prompt', text])
}
/** Archive an agent (soft: its history stays in Paseo). */
export async function archive(id) {
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
