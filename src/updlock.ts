// One mm update of a project at a time (sy-qpqd): a lock file in mm's host folder for the project, made with an exclusive open,
// that holds the holder's pid and the time its process started (so a pid the kernel gave out again is not the holder).
// A lock whose holder is gone (killed, crashed) is taken over: moved aside first, so of two runs that both find it
// stale only one takes it.
// The lock lives in $MM_HOME/update/ (0700), never in the project's repo: a box can write its repo's .git/, and a lock
// it planted there naming a live host pid would block every mm update (review sy-rjwg 3). One host folder for every
// project, box or not (the answers file that says "box" is the box's to write, so it can't pick the place). A lock an
// older mm left in .git/ is ignored, and removed when its holder is gone.
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS } from './env'

const PROJECT_ID = /^[a-z][a-z0-9-]{0,62}$/
export const updLockDir = () => join(DIRS.mm, 'update')
export const updLockFile = (project: string) => join(updLockDir(), `${project}.lock`)
/** Where an older mm kept the lock: in the repo (a box can write it). Only ever removed, when stale. */
export const oldUpdLockFile = (root: string) => join(root, '.git', 'mm-update.lock')
const FRESH_MS = 10_000 // a lock still empty this long after it was made: its maker died between open and write

/** A process's state and when it started (Linux: fields 3 and 22 of /proc/<pid>/stat); '' where not known. */
function proc(pid: number): { state: string; start: string } {
  let fd = -1
  try {
    fd = openSync(`/proc/${pid}/stat`, 'r'); const b = Buffer.alloc(1024), n = readSync(fd, b, 0, b.length, 0), s = b.toString('utf8', 0, n)
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return { state: f[0] || '', start: f[19] || '' }
  } catch { return { state: '', start: '' } } finally { if (fd >= 0) closeSync(fd) }
}
function alive(pid: number, start: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false }
  const now = proc(pid)
  return now.state !== 'Z' && (!start || !now.start || now.start === start) // a zombie has exited
}
/** The holder named in a lock file: null if there is none; `busy` if it still runs. Not a regular file: stale. */
function holder(f: string): { pid: number; busy: boolean; text: string } | null {
  let fd = -1
  try {
    if (!lstatSync(f).isFile()) return { pid: 0, busy: false, text: '' }
    fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW)
    const b = Buffer.alloc(128), n = readSync(fd, b, 0, b.length, 0), text = b.toString('utf8', 0, n)
    if (!text.trim()) return { pid: 0, busy: Date.now() - fstatSync(fd).mtimeMs < FRESH_MS, text }
    const [pid, start = ''] = text.trim().split(/\s+/)
    return { pid: Number(pid), busy: alive(Number(pid), start), text }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : { pid: 0, busy: false, text: '' }
  } finally { if (fd >= 0) closeSync(fd) }
}

/**
 * Take the update lock of the project at `root`. Returns the function that gives it back, or why it can't be taken
 * ("an update of <project> is running (pid N); try again").
 */
export function lockUpdate(root: string, project: string): (() => void) | string {
  if (!PROJECT_ID.test(project)) return `can't take the update lock: not a project id: ${JSON.stringify(project).slice(0, 80)}`
  try { mkdirSync(updLockDir(), { recursive: true, mode: 0o700 }); chmodSync(updLockDir(), 0o700) } catch (e) { return `can't make ${updLockDir()}: ${(e as Error).message}` }
  // an older mm's lock: ignored; removed when its holder is gone (a regular file only, in a real .git/ folder, not a link
  // the box made to somewhere else on the host)
  try {
    const old = oldUpdLockFile(root)
    if (lstatSync(join(root, '.git')).isDirectory() && lstatSync(old).isFile() && !holder(old)?.busy) rmSync(old, { force: true })
  } catch {}
  const f = updLockFile(project), me = `${process.pid} ${proc(process.pid).start}\n`
  const running = (pid: number) => `an update of ${project} is running (pid ${pid || '?'}); try again`
  for (let i = 0; i < 5; i++) {
    try {
      const fd = openSync(f, 'wx', 0o644)
      try { writeSync(fd, me) } finally { closeSync(fd) }
      return () => { if (holder(f)?.text === me) rmSync(f, { force: true }) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return `can't take the update lock ${f}: ${(e as Error).message}`
    }
    const h = holder(f)
    if (!h) continue // given back meanwhile
    if (h.busy) return running(h.pid)
    // stale: move it aside (one rename wins), then look at what was moved: a lock another run took meanwhile goes back
    const aside = `${f}.stale-${process.pid}`
    try { renameSync(f, aside) } catch { continue }
    const g = holder(aside)
    if (g?.busy) { try { linkSync(aside, f) } catch { /* a third run has it now */ } rmSync(aside, { force: true }); return running(g.pid) }
    rmSync(aside, { force: true })
  }
  return `can't take the update lock ${f}: it keeps changing`
}

/** Run `fn` holding the project's update lock; `{ refused }` (and `fn` not run) if another run holds it. */
export function withUpdateLock<T>(root: string, project: string, fn: () => T): T | { refused: string } {
  const release = lockUpdate(root, project)
  if (typeof release === 'string') return { refused: release }
  try { return fn() } finally { release() }
}
