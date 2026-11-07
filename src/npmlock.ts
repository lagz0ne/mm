// The npm tools mm installs from a lockfile it ships (install kind `npm-lock`, sy-nli): deps/<lock>/package.json and
// its package-lock.json, compiled into the binary. Installed with `npm ci` into $MM_HOME/npm/<lock>/, so every
// transitive package is the one recorded with its integrity hash, not whatever npm resolves that day.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { DIRS, tilde } from './env'
import paseoPackage from '../deps/paseo/package.json' with { type: 'text' }
import paseoLock from '../deps/paseo/package-lock.json' with { type: 'text' }

export interface Lock { pkg: string; lock: string }
/** The locks mm ships, by name (the manifest's `install: { kind: npm-lock, lock: <name> }`). */
export const LOCKS: Record<string, Lock> = {
  paseo: { pkg: String(paseoPackage as unknown), lock: String(paseoLock as unknown) },
}

export function shipped(name: string): Lock {
  const l = LOCKS[name]
  if (!l) throw new Error(`mm ships no npm lock named ${name}`)
  return l
}

/** Where a lock's tree is installed, and the bin a direct dependency puts in its node_modules/.bin. */
export const lockDir = (name: string) => join(DIRS.npm, name)
export const lockBin = (name: string, bin: string) => join(lockDir(name), 'node_modules', '.bin', bin)

type Pkg = { dependencies?: Record<string, string> }
type LockFile = { lockfileVersion?: number; packages?: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean; dependencies?: Record<string, string> }> }

/** The direct dependencies, with their exact versions (package.json's). */
export const directDeps = (l: Lock): Record<string, string> => (JSON.parse(l.pkg) as Pkg).dependencies ?? {}

/** What makes a lock unfit to install from (none: []): lockfileVersion 3, the direct dependencies exact and the
 *  lock's, and every package with its resolved URL and integrity hash. */
export function lockProblems(l: Lock): string[] {
  let pkg: Pkg, lock: LockFile
  try { pkg = JSON.parse(l.pkg); lock = JSON.parse(l.lock) } catch (e) { return [`unreadable: ${(e as Error).message}`] }
  const out: string[] = []
  if (lock.lockfileVersion !== 3) out.push(`lockfileVersion ${lock.lockfileVersion}, not 3`)
  const packages = lock.packages ?? {}
  const deps = pkg.dependencies ?? {}
  if (!Object.keys(deps).length) out.push('package.json has no dependencies')
  for (const [d, v] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) out.push(`${d}@${v}: not an exact version`)
    const e = packages[`node_modules/${d}`]
    if (!e) out.push(`${d}: not in the lock`)
    else if (e.version !== v) out.push(`${d}: the lock has ${e.version}, package.json ${v}`)
    if (packages['']?.dependencies?.[d] !== v) out.push(`${d}: the lock's root does not depend on ${v}`)
  }
  for (const [k, e] of Object.entries(packages)) {
    if (!k || e.link) continue
    if (!e.integrity || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(e.integrity)) out.push(`${k}: no integrity`)
    else if (!e.resolved) out.push(`${k}: no resolved URL`)
  }
  return out
}

/** How many packages a lock pins (its root not counted). */
export const pinned = (l: Lock) => Object.keys((JSON.parse(l.lock) as LockFile).packages ?? {}).filter(Boolean).length

const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep)

/** doctor: why the installed tree is not the shipped lock's (null: it is). `bin`: the tool's binary as found on PATH. */
export function installedProblem(name: string, bin: string | null): string | null {
  const l = shipped(name), dir = lockDir(name)
  if (!existsSync(join(dir, 'package-lock.json'))) return `not installed from mm's lock (no ${tilde(join(dir, 'package-lock.json'))})`
  if (readFileSync(join(dir, 'package-lock.json'), 'utf8') !== l.lock) return `${tilde(dir)} has another lock than this mm's`
  for (const [d, v] of Object.entries(directDeps(l))) {
    const got = readJson(join(dir, 'node_modules', d, 'package.json'))?.version
    if (got !== v) return `${d} ${got ?? 'missing'} in ${tilde(dir)}, the lock's is ${v}`
  }
  if (bin) {
    let real = bin
    try { real = realpathSync(bin) } catch {}
    let root = dir
    try { root = realpathSync(dir) } catch {}
    if (!inside(real, root)) return `${tilde(bin)} runs ${tilde(real)}, not the one in ${tilde(dir)}`
  }
  return null
}
