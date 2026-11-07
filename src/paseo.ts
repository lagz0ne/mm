// The machine's Paseo (sy-11g): the agent daemon every host lead runs on. Until the machine turns it on
// (`mm config set paseo.managed true`) it stays where an older install put it (a systemd user unit, home ~/.paseo) and mm
// only reports it. Turned on, it is mm.paseo (src/pc.ts writeBase), with its home in $MM_HOME/paseo/system;
// `mm paseo migrate` copies the old home there first (never moves it: ~/.paseo stays as the rollback).
// Keys: paseo.managed (off), paseo.listen (127.0.0.1:6767, Paseo's own default), paseo.relay and paseo.web_ui (unset:
// the home's own config.json decides, as for the old unit, and the app can still change them; true/false: fixed).
// Nothing here opens a file of Paseo's home but its pid lock (paseo.pid: a pid and an address); a key is never read.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getPath, loadConfig, type Config } from './config'
import { DIRS, HOME, hasSystemdUser, run, tilde } from './env'
import type { Check } from './doctor'

export const OLD_UNIT = 'paseo.service'
export const DEFAULT_LISTEN = '127.0.0.1:6767'
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
export const listen = (c: Config = loadConfig()) => String(getPath(c, 'paseo.listen') || DEFAULT_LISTEN)
/** A tri-state key: undefined (the home's own config.json decides), else 'true' / 'false'. */
const tri = (c: Config, k: string): 'true' | 'false' | undefined => { const v = getPath(c, k); return v === undefined || v === null || v === '' ? undefined : on(v) ? 'true' : 'false' }

/** mm.paseo's environment besides PATH/HOME/MM_HOME (pc.ts). Only what the old unit's defaults would give. */
export function daemonEnv(c: Config = loadConfig()): Record<string, string> {
  const e: Record<string, string> = { PASEO_HOME: systemHome(), PASEO_LISTEN: listen(c) }
  const relay = tri(c, 'paseo.relay'), web = tri(c, 'paseo.web_ui')
  if (relay) e.PASEO_RELAY_ENABLED = relay
  if (web) e.PASEO_WEB_UI_ENABLED = web
  return e
}

