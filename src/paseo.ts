// The machine's Paseo (sy-11g): the agent daemon every host lead runs on. Until the machine turns it on
// (`mm config set paseo.managed true`) it stays where an older install put it (a systemd user unit, home ~/.paseo) and mm
// only reports it. Turned on, it is mm.paseo (src/pc.ts writeBase), with its home in $MM_HOME/paseo/system;
// `mm paseo migrate` copies the old home there first (never moves it: ~/.paseo stays as the rollback).
// Keys: paseo.managed (off), paseo.listen (unset: mm's socket $MM_HOME/run/paseo.sock once managed, sy-nli; a set value
// is kept as it is; unmanaged, Paseo's own 127.0.0.1:6767), paseo.relay and paseo.web_ui (unset:
// the home's own config.json decides, as for the old unit, and the app can still change them; true/false: fixed).
// Nothing here opens a file of Paseo's home but its pid lock (paseo.pid: a pid and an address); a key is never read.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getPath, loadConfig, type Config } from './config'
import { DIRS, HOME, hasSystemdUser, run, tilde } from './env'
import type { Check } from './doctor'
import { MACHINE_SCOPE, sealed } from './vault'

export const OLD_UNIT = 'paseo.service'
/** Paseo's own default (the old unit's): where an unmanaged daemon listens. */
export const PASEO_DEFAULT_LISTEN = '127.0.0.1:6767'
/** mm.paseo's address when paseo.listen is unset (sy-nli): a socket in mm's run/ folder (0700), no TCP port at all. */
export const socketListen = () => `unix://${join(DIRS.mm, 'run', 'paseo.sock')}`
const on = (v: unknown) => v === true || v === 'true'
export const paseoManaged = (c: Config = loadConfig()) => on(getPath(c, 'paseo.managed'))
/** mm's home for the machine's Paseo. */
export const systemHome = () => join(DIRS.mm, 'paseo', 'system')
/** Where an older install keeps it (the unit's; Paseo's own default). */
export const oldHome = () => join(HOME, '.paseo')
/** The machine Paseo's home now: paseo.home when set, else mm's once managed, else the old one. */
export function machineHome(c: Config = loadConfig()): string {
  const h = getPath(c, 'paseo.home')
  if (typeof h === 'string' && h.trim()) return h.trim().replace(/^~(?=\/|$)/, HOME)
  return paseoManaged(c) ? systemHome() : oldHome()
}
/** The home mm.paseo runs on: paseo.home when set (an existing home already under mm, used as is: no copy, no second
 *  keypair; sy-11g #14), else mm's paseo/system. */
export function managedHome(c: Config = loadConfig()): string {
  const h = getPath(c, 'paseo.home')
  return typeof h === 'string' && h.trim() ? h.trim().replace(/^~(?=\/|$)/, HOME) : systemHome()
}
/** Both paths name the same folder (after links), and it exists. */
export function sameDir(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}
/** Why mm.paseo must not run on `home`, or null: an absolute path inside mm's paseo/ folder, a real folder (not a link)
 *  when it exists. Anything else would put the daemon's keypair and sessions outside the folder mm keeps at 0700. */
export function homeRefusal(home: string): string | null {
  const base = join(DIRS.mm, 'paseo')
  if (!home.startsWith('/') || relative(base, home).startsWith('..') || relative(base, home) === '' || /(^|\/)\.\.(\/|$)/.test(home))
    return `paseo.home ${JSON.stringify(home)} is not a folder inside ${tilde(base)}`
  try { if (!lstatSync(home).isDirectory()) return `paseo.home ${tilde(home)} is not a real folder (a link or a file)` } catch {}
  return null
}
/** The machine Paseo's listen address: paseo.listen when set (kept as it is), else mm's socket once managed, else
 *  Paseo's own default (an unmanaged daemon). */
export const listen = (c: Config = loadConfig()) => String(getPath(c, 'paseo.listen') || (paseoManaged(c) ? socketListen() : PASEO_DEFAULT_LISTEN))
/** The socket file of a socket listen address (an absolute path or unix:///path), or null for a host:port one. */
export const socketPath = (l: string) => (l.startsWith('/') || l.startsWith('unix://') ? l.replace(/^unix:\/\//, '') : null)
/** How a client reaches a listen address (sy-nli; .run/endpoints.json "paseo"): unix:///path for a socket, else
 *  ws://host:port/ws. */
export function clientAddress(l: string): string {
  const s = socketPath(l)
  return s ? `unix://${s}` : `ws://${l}/ws`
}
/**
 * Review sy-11g #12, fix 1: the daemon that drives every agent of this user listens on loopback or a socket only. Why
 * `l` is refused, or null: 127.0.0.1:<port>, [::1]:<port>, an absolute socket path or unix://<absolute path>; anything
 * else (0.0.0.0, ::, a LAN address, a name) would put it on the network.
 */
export function listenRefusal(l: string): string | null {
  const port = (p: string) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535
  if (/^unix:\/\/\//.test(l) || l.startsWith('/'))
    return /[\s'"$`\\;&|<>()]/.test(l) ? `paseo.listen ${JSON.stringify(l)}: a socket path with spaces or shell characters` : null
  const m = /^127\.0\.0\.1:(\d+)$/.exec(l) || /^\[::1\]:(\d+)$/.exec(l)
  if (m) return port(m[1]) ? null : `paseo.listen ${JSON.stringify(l)}: the port is not 1-65535`
  return `paseo.listen ${JSON.stringify(l)} is not loopback: only 127.0.0.1:<port>, [::1]:<port> or a socket path (the daemon drives every agent; never on the network)`
}
/** A tri-state key: undefined (the home's own config.json decides), else 'true' / 'false'. */
const tri = (c: Config, k: string): 'true' | 'false' | undefined => { const v = getPath(c, k); return v === undefined || v === null || v === '' ? undefined : on(v) ? 'true' : 'false' }

/** mm.paseo's environment besides PATH/HOME/MM_HOME (pc.ts). Only what the old unit's defaults would give. */
export function daemonEnv(c: Config = loadConfig()): Record<string, string> {
  const e: Record<string, string> = { PASEO_HOME: managedHome(c), PASEO_LISTEN: listen(c) }
  const relay = tri(c, 'paseo.relay'), web = tri(c, 'paseo.web_ui')
  if (relay) e.PASEO_RELAY_ENABLED = relay
  if (web) e.PASEO_WEB_UI_ENABLED = web
  return e
}

const bootId = () => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return '' } }
/** The daemon running on this home, by its pid lock (paseo.pid: pid, listen, bootId): its pid, or null. */
export function daemonIn(home: string): { pid: number; listen: string | null } | null {
  let lock: { pid?: unknown; listen?: unknown; bootId?: unknown }
  try { lock = JSON.parse(readFileSync(join(home, 'paseo.pid'), 'utf8')) } catch { return null }
  const pid = Number(lock.pid); if (!Number.isInteger(pid) || pid <= 0) return null
  const b = bootId(); if (typeof lock.bootId === 'string' && b && lock.bootId !== b) return null   // a lock from before this boot
  if (!existsSync(`/proc/${pid}`)) return null
  try { if (/^\d+ \([^)]*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return null } catch {}
  return { pid, listen: typeof lock.listen === 'string' ? lock.listen : null }
}
/** Something answers HTTP on a host:port address (a Paseo daemon, or anything else holding it). */
export function answers(addr: string): boolean {
  const p = socketPath(addr); if (p) { try { return statSync(p).isSocket() } catch { return false } }
  return run(['curl', '-s', '-o', '/dev/null', '--max-time', '2', `http://${addr}/`], { timeoutMs: 5000 }).ok
}

// ---------- mm paseo migrate ----------
/** Runtime state of a daemon, not copied: its pid lock (a stopped daemon's), sockets and fifos. */
const SKIP_NAMES = new Set(['paseo.pid'])
interface Entry { rel: string; kind: 'dir' | 'file' | 'link' | 'skip'; mode: number; size: number }
function walk(root: string): Entry[] {
  const out: Entry[] = []
  const go = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), s = lstatSync(p), rel = relative(root, p)
      if (s.isSymbolicLink()) out.push({ rel, kind: 'link', mode: 0, size: 0 })
      else if (s.isDirectory()) { out.push({ rel, kind: 'dir', mode: s.mode & 0o7777, size: 0 }); go(p) }
      else if (s.isFile() && !(d === root && SKIP_NAMES.has(n))) out.push({ rel, kind: 'file', mode: s.mode & 0o7777, size: s.size })
      else out.push({ rel, kind: 'skip', mode: 0, size: 0 })
    }
  }
  go(root)
  return out
}
export interface MigrateResult { ok: boolean; lines: string[] }
/**
 * Copy the old home into mm's (keys, agents, sessions, hosts), never move it. Refuses while a Paseo daemon runs on
 * either home (its pid lock) or answers on the listen address, and when the target is not empty (unless force). Modes
 * are kept (the target folder and $MM_HOME/paseo are 0700 whatever the source's). Prints paths and counts only.
 */
export function migrate(o: { dryRun?: boolean; force?: boolean; from?: string; to?: string } = {}): MigrateResult {
  const from = o.from || oldHome(), to = o.to || managedHome(), lines: string[] = []
  const no = (why: string): MigrateResult => ({ ok: false, lines: [...lines, `refused: ${why}`] })
  // the old home is already mm's (a link to it, or paseo.home names it): nothing to copy (sy-11g #14)
  if (!o.from && !o.to && sameDir(from, to)) return { ok: true, lines: [`nothing to copy: ${tilde(from)} is ${tilde(to)}, the home mm.paseo runs on (paseo.home)`] }
  let src: ReturnType<typeof lstatSync>
  try { src = lstatSync(from) } catch { return no(`no Paseo home at ${tilde(from)}`) }
  if (!src.isDirectory()) return no(`${tilde(from)} is not a folder`)
  for (const h of [from, to]) { const d = daemonIn(h); if (d) return no(`a Paseo daemon runs on ${tilde(h)} (pid ${d.pid}): stop it first`) }
  const addr = listen()
  if (answers(addr)) return no(`something answers on ${addr} (a Paseo daemon?): stop it first`)
  let targetEntries: string[] = []; try { targetEntries = readdirSync(to) } catch {}
  if (targetEntries.length && !o.force) return no(`${tilde(to)} is not empty (${targetEntries.length} entr${targetEntries.length === 1 ? 'y' : 'ies'}); --force copies over it`)
  const all = walk(from)
  const files = all.filter((e) => e.kind === 'file'), dirs = all.filter((e) => e.kind === 'dir'), links = all.filter((e) => e.kind === 'link'), skipped = all.filter((e) => e.kind === 'skip')
  const bytes = files.reduce((n, e) => n + e.size, 0)
  lines.push(`from ${tilde(from)} to ${tilde(to)}: ${files.length} file(s), ${dirs.length} folder(s), ${links.length} link(s), ${bytes} bytes; ${skipped.length} left out (pid lock, sockets)`)
  if (o.dryRun) {
    for (const e of all) lines.push(`  ${e.kind === 'skip' ? 'skip' : e.kind.padEnd(4)} ${e.rel}${e.kind === 'file' ? `  ${e.size} B  0${e.mode.toString(8)}` : e.kind === 'dir' ? `/  0${e.mode.toString(8)}` : ''}`)
    lines.push('dry run: nothing copied')
    return { ok: true, lines }
  }
  const parent = join(to, '..')
  mkdirSync(parent, { recursive: true, mode: 0o700 }); if (parent === join(DIRS.mm, 'paseo')) chmodSync(parent, 0o700)
  mkdirSync(to, { recursive: true, mode: 0o700 }); chmodSync(to, 0o700)
  for (const e of dirs) { const p = join(to, e.rel); mkdirSync(p, { recursive: true, mode: 0o700 }) }
  for (const e of files) { const p = join(to, e.rel); try { unlinkSync(p) } catch {} copyFileSync(join(from, e.rel), p); chmodSync(p, e.mode) }
  for (const e of links) { const p = join(to, e.rel); try { unlinkSync(p) } catch {} symlinkSync(readlinkSync(join(from, e.rel)), p) }
  for (const e of dirs.reverse()) chmodSync(join(to, e.rel), e.mode)   // last: a read-only folder still takes its files first
  // the check: every file there with its size and mode, the keypair present
  const bad = files.filter((e) => { try { const s = lstatSync(join(to, e.rel)); return !s.isFile() || s.size !== e.size || (s.mode & 0o7777) !== e.mode } catch { return true } })
  const copied = walk(to).filter((e) => e.kind === 'file').length
  const key = existsSync(join(to, 'daemon-keypair.json'))
  lines.push(`copied: ${files.length - bad.length}/${files.length} file(s) with their sizes and modes; ${copied} file(s) in ${tilde(to)}`)
  for (const e of bad.slice(0, 10)) lines.push(`  differs: ${e.rel}`)
  lines.push(key ? 'keypair: daemon-keypair.json present' : 'keypair: daemon-keypair.json MISSING')
  lines.push(`${tilde(from)} left as it was (the rollback)`)
  return { ok: !bad.length && key && (o.force || copied === files.length), lines }
}

// ---------- mm doctor ----------
/** mm.paseo in the machine's process manager (not project.ts processes(): pc.ts imports this file). */
function mmPaseo(): { status: string; restarts: number } | undefined {
  const r = run(['process-compose', '-U', '-u', DIRS.socket, 'process', 'list', '-o', 'json'], { timeoutMs: 15_000 })
  if (!r.ok) return undefined
  try { const j = JSON.parse(r.out); return Array.isArray(j) ? j.find((x) => x && x.name === 'mm.paseo') : undefined } catch { return undefined }
}
/** One Paseo daemon on the machine, and mm's once paseo.managed is on (sy-11g). */
export function daemonCheck(c: Config = loadConfig()): Check {
  const row = (status: Check['status'], detail: string, fix?: string): Check => ({ layer: 'service', item: 'paseo', status, detail, fix })
  const sd = hasSystemdUser()
  const unit = (verb: string) => (sd ? run(['systemctl', '--user', verb, OLD_UNIT], { timeoutMs: 5000 }).out.trim() : '')
  const load = sd ? run(['systemctl', '--user', 'show', OLD_UNIT, '-p', 'LoadState', '--value'], { timeoutMs: 5000 }).out.trim() : ''
  const exists = load !== '' && load !== 'not-found'
  const enabled = exists ? unit('is-enabled') : '', active = exists ? unit('is-active') : ''
  const home = managedHome(c), badHome = homeRefusal(home)
  if (badHome) return row('fail', `${badHome}: mm.paseo does not start`, 'mm config set paseo.home <a folder in ~/.mm/paseo>, or unset it')
  // ~/.paseo a link to mm's home (the one-root move): one home, so one daemon there is mm's, not a second one
  const same = sameDir(oldHome(), home)
  const oldD = same ? null : daemonIn(oldHome()), sysD = daemonIn(home)
  if (!paseoManaged(c)) {
    if (exists) return row('warn', `${OLD_UNIT} (${active || 'unknown'}, ${enabled || 'unknown'}) runs the machine's Paseo from ${tilde(oldHome())}: not under mm yet: sy-11g`)
    return row('skip', `paseo.managed is off and there is no ${OLD_UNIT}`)
  }
  const bad = listenRefusal(listen(c))
  if (bad) return row('fail', `${bad}: mm.paseo does not start`, `mm config unset paseo.listen (mm's socket, ${tilde(socketPath(socketListen())!)}), or set it to 127.0.0.1:<port>`)
  const fix = `systemctl --user disable --now ${OLD_UNIT}`
  if (enabled === 'enabled' || active === 'active' || active === 'activating')
    return row('fail', `paseo.managed is on but ${OLD_UNIT} is still ${[active === 'active' || active === 'activating' ? active : '', enabled === 'enabled' ? 'enabled' : ''].filter(Boolean).join(' and ')}`, fix)
  if (oldD && sysD && oldD.pid !== sysD.pid) return row('fail', `two Paseo daemons: pid ${oldD.pid} on ${tilde(oldHome())}, pid ${sysD.pid} on ${tilde(home)}`, `stop the one on ${tilde(oldHome())} (kill ${oldD.pid})`)
  if (oldD) return row('fail', `a Paseo daemon (pid ${oldD.pid}) still runs on ${tilde(oldHome())}`, `kill ${oldD.pid}`)
  const p = mmPaseo()
  if (!p) return row('fail', 'paseo.managed is on but the process manager has no mm.paseo', 'the next mm up of any project reloads the base file (or mm onboard)')
  if (p.status !== 'Running') return row('fail', `mm.paseo is ${p.status} (${p.restarts} restart(s); see ${tilde(join(DIRS.pc, 'paseo.log'))})`)
  return row('ok', `mm.paseo runs (home ${tilde(home)}, ${listen(c)}); no other Paseo daemon`)
}

// ---------- the agents' Claude token (sy-nli) ----------
// mm.paseo gives its agents the machine's Claude token (machine input claude-oauth-token): from the vault once it is
// sealed there (`mm vault run _machine`: a memory-backed file, removed as soon as the daemon's shell has read it), else
// from the input's file, as the old unit did. Never on a command line, in the base file or in a log; doctor says which.
export const TOKEN_INPUT = 'claude-oauth-token'
export type TokenSource = 'vault' | 'file'
/** Where the next mm.paseo (the next writeBase) reads the token from. */
export const tokenSource = (): TokenSource => (sealed(TOKEN_INPUT) ? 'vault' : 'file')
/** Where the mm.paseo in the process manager's base file reads it from (its command names the way, never the value);
 *  null when there is none there, or one that refuses to start. */
export function baseTokenSource(): TokenSource | null {
  try {
    const y = Bun.YAML.parse(readFileSync(join(DIRS.pc, 'base.yaml'), 'utf8')) as { processes?: Record<string, { command?: string }> } | null
    const cmd = String(y?.processes?.['mm.paseo']?.command || '')
    return cmd.includes(` vault run ${MACHINE_SCOPE} ${TOKEN_INPUT} `) ? 'vault' : cmd.includes('MM_PASEO_TOKEN_FILE') ? 'file' : null
  } catch { return null }
}
