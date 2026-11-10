// Egress mode "open" for one box project (sy-cpyo): `egress.open.<project>` in mm's own config (never the project's
// services.yaml) holds an end date, YYYY-MM-DD (UTC), at most 30 days ahead. Until that day starts (00:00 UTC) the box's
// egress proxy may reach any public host on :443 (src/box.ts writeAllow: one any-host pattern instead of the list); from
// then on, or with false or no value, the list as before. The proxy's own checks (box/egress/main.go: CONNECT to 443
// only, the resolved address never the host, a private, link-local or docker net) hold either way.
// On only through the owner: mm.api's egress-open request (review signs off, then the owner's tap with its one-time
// code; its record and undo), or the owner's own terminal (`mm config set egress.open.<project> <date>`, refused in an
// agent's shell; the template's guard denies a lead any value but false). Off: anyone (false, or unset).
// A small module with no heavy imports: box.ts, api.ts, cli.ts and project.ts (mm ls) read it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, getPath, loadConfig } from './config'
import { DIRS } from './env'

export const OPEN_MAX_DAYS = 30
/** The allow file's one pattern with the mode on: any name (no path), on 443 (the proxy takes 443 only anyway). */
export const ANY_HOST = '^[^/]+(:443)?$'
export const UNTIL = /^\d{4}-\d{2}-\d{2}$/
const DAY = 86400e3
const dayStart = (t: number) => Math.floor(t / DAY) * DAY
/** A YYYY-MM-DD that is a real date: its start (00:00 UTC) in ms, else NaN. */
const startOf = (v: string) => { const t = Date.parse(`${v}T00:00:00Z`); return UNTIL.test(v) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v ? t : NaN }

/** Why this end date can't be set now (null: it can): a real YYYY-MM-DD, after today, at most 30 days ahead (UTC). */
export function untilRefusal(v: string, now = Date.now()): string | null {
  const t = startOf(v)
  if (Number.isNaN(t)) return `${JSON.stringify(v)} is not a date (YYYY-MM-DD, UTC)`
  if (t <= dayStart(now)) return `${v} is not after today (UTC): the mode would be off at once`
  if (t > dayStart(now) + OPEN_MAX_DAYS * DAY) return `${v} is more than ${OPEN_MAX_DAYS} days ahead: the mode holds at most ${OPEN_MAX_DAYS} days`
  return null
}

export type EgressOpen = { on: boolean; until: string | null; ended: boolean; bad?: string }
/** The project's mode now. `until` the end date set (on, or ended); a value that is no date, or more than 30 days
 *  ahead (written by hand), is off, with why in `bad`. */
export function egressOpen(project: string, c: Config = loadConfig(), now = Date.now()): EgressOpen {
  const o = getPath(c, 'egress.open'), raw = o && typeof o === 'object' ? (o as Record<string, unknown>)[project] : undefined
  if (raw === undefined || raw === null || raw === false || raw === 'false' || raw === '') return { on: false, until: null, ended: false }
  const v = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw), t = startOf(v)
  if (Number.isNaN(t)) return { on: false, until: null, ended: false, bad: `egress.open.${project} is ${JSON.stringify(v).slice(0, 40)}, not an end date (YYYY-MM-DD): off` }
  if (t > dayStart(now) + OPEN_MAX_DAYS * DAY) return { on: false, until: v, ended: false, bad: `egress.open.${project} ends ${v}, more than ${OPEN_MAX_DAYS} days ahead: off` }
  return now < t ? { on: true, until: v, ended: false } : { on: false, until: v, ended: true }
}

/** Every project named under egress.open, with its mode now (on, ended, or bad). */
export function egressOpenAll(c: Config = loadConfig(), now = Date.now()): ({ project: string } & EgressOpen)[] {
  const o = getPath(c, 'egress.open')
  if (!o || typeof o !== 'object') return []
  return Object.keys(o as object).sort().map((project) => ({ project, ...egressOpen(project, c, now) })).filter((x) => x.on || x.ended || x.bad)
}

/** What mm ls and mm doctor say of it: "open until <date> 00:00 UTC", "list (open ended <date>)", or "list". */
export function egressShown(m: EgressOpen): string {
  if (m.on) return `open until ${m.until} 00:00 UTC`
  if (m.ended) return `list (open ended ${m.until})`
  return m.bad ? `list (${m.bad})` : 'list'
}

/** The allow file mm wrote for the box is the any-host pattern now (what its proxy reads). */
export const allowOpen = (project: string) => { try { return readFileSync(join(DIRS.mm, 'egress', project, 'allow'), 'utf8').split('\n').includes(ANY_HOST) } catch { return false } }
