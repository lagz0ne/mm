// Machine config (~/.mm/config.yaml): the answers to the manifest's machine vars, plus anything set with `mm config`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DIRS } from './env'

export type Config = Record<string, unknown>

export function loadConfig(): Config {
  if (!existsSync(DIRS.config)) return {}
  return (Bun.YAML.parse(readFileSync(DIRS.config, 'utf8')) as Config) || {}
}
export function saveConfig(c: Config) {
  mkdirSync(dirname(DIRS.config), { recursive: true })
  writeFileSync(DIRS.config, `# mm machine config (written by mm onboard / mm config)\n${Bun.YAML.stringify(c, null, 2)}\n`)
}

const parts = (p: string) => p.split('.').filter(Boolean)
export function getPath(c: Config, p: string): unknown {
  return parts(p).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Config)[k] : undefined), c)
}
export function setPath(c: Config, p: string, v: unknown) {
  const ks = parts(p); let o = c
  for (const k of ks.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k] as Config }
  o[ks[ks.length - 1]] = v
}
export function unsetPath(c: Config, p: string) {
  const ks = parts(p); let o: Config | undefined = c
  for (const k of ks.slice(0, -1)) o = o?.[k] as Config | undefined
  if (o) delete o[ks[ks.length - 1]]
}

/** Evaluate a manifest `when` like `access == domain` against the config. */
export function when(expr: string | undefined, c: Config): boolean {
  if (!expr) return true
  const m = /^\s*([\w.]+)\s*(==|!=)\s*([\w.-]+)\s*$/.exec(expr)
  if (!m) return true
  const v = String(getPath(c, m[1]) ?? '')
  return m[2] === '==' ? v === m[3] : v !== m[3]
}

/** A restored box holds back everything outward-facing until the human says the old box is down (docs/restore.md):
 *  `restore.hold` in config.yaml, set by mm restore, lifted only by `mm restore --release` (never on a drill box). */
export const held = (c: Config = loadConfig()) => getPath(c, 'restore.hold') === true
