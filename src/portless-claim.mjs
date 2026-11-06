// mm: before a service's portless wrapper takes over its name (`portless <name> --force`, src/project.ts serviceProcess),
// check what the name's record points at (sy-1qkv). portless --force sends TERM to the pid on record; a wrapper that
// died without cleaning up leaves its pid there, and that pid may be another process by now.
//   node portless-claim.mjs <name>          (run by the service's command, just before portless)
// The record's pid is:
//   - a portless wrapper of <name> (portless as typed, or <interpreter> <path>/portless, then the name): kept, portless
//     takes the name over (the TERM goes to the old wrapper, as before)
//   - gone (or a zombie): kept for portless, which drops a dead record itself when it registers, after stopping the dead
//     wrapper's orphaned process group (checked by its start time)
//   - anything else: only the record goes (nothing is signalled), and one WARN line says so
// The registry is portless' own: $PORTLESS_STATE_DIR/routes.json (else ~/.portless), changed under portless' lock (the
// folder routes.lock). Exit 0, also with no registry or no record; 1 only when the lock can't be had in 15 s (the
// service doesn't start this time; process-compose starts it again).
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const name = process.argv[2]
if (!name) { console.error('usage: node portless-claim.mjs <name>'); process.exit(2) }
const dir = process.env.PORTLESS_STATE_DIR || join(process.env.HOME || homedir(), '.portless')
const routesPath = join(dir, 'routes.json'), lockPath = join(dir, 'routes.lock')
// the hostnames portless registers for <name>: <name>.<tld>, for each of its TLDs (PORTLESS_TLD; else localhost)
const tlds = (process.env.PORTLESS_TLD || 'localhost').split(',').map((t) => t.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean)
const hosts = new Set(tlds.map((t) => `${name}.${t}`))

const procState = (pid) => { try { const st = readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) } catch { return '' } }
const procArgv = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch { return [] } }
const gone = (pid) => { const s = procState(pid); return !s || s === 'Z' }
const INTERPRETERS = /^(node|nodejs|bun|sh|bash)$/
const isPortless = (p) => basename(p) === 'portless' || /\/portless\/dist\/cli\.js$/.test(p)
/** A portless wrapper of this name: `portless <name> ...`, or `<interpreter> <path>/portless <name> ...` (its #! line). */
const isWrapper = (argv) => (argv.length > 1 && isPortless(argv[0]) && argv[1] === name)
  || (argv.length > 2 && INTERPRETERS.test(basename(argv[0])) && isPortless(argv[1]) && argv[2] === name)
/** The records of this name that point at another live process: the ones to drop. */
const foreign = (routes) => routes.filter((r) => r && hosts.has(r.hostname) && Number.isInteger(r.pid) && r.pid > 0
  && r.pid !== process.pid && !gone(r.pid) && !isWrapper(procArgv(r.pid)))
const load = () => { try { const v = JSON.parse(readFileSync(routesPath, 'utf8')); return Array.isArray(v) ? v : null } catch { return null } }

let routes = load()
if (!routes || !foreign(routes).length) process.exit(0) // nothing on record that portless --force could signal wrongly

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const lock = () => { // as portless does it: mkdir, a lock older than 10 s is stale
  for (const end = Date.now() + 15_000; Date.now() < end;) {
    try { mkdirSync(lockPath); return true } catch (e) {
      if (e?.code !== 'EEXIST') return false
      try { if (Date.now() - statSync(lockPath).mtimeMs > 10_000) { rmSync(lockPath, { recursive: true, force: true }); continue } } catch { continue }
      sleep(10 + Math.floor(Math.random() * 90))
    }
  }
  return false
}
if (!lock()) { console.error(`ERROR portless record for ${name}: could not lock ${lockPath} in 15 s; not starting this time`); process.exit(1) }
let drop = []
try {
  routes = load() || [] // again, under the lock
  drop = foreign(routes)
  if (drop.length) {
    const tmp = join(dir, `.routes.json.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(routes.filter((r) => !drop.includes(r)), null, 2), { mode: 0o644 })
    renameSync(tmp, routesPath)
  }
} finally { rmSync(lockPath, { recursive: true, force: true }) }
for (const r of drop) console.error(`WARN portless record for ${name} (${r.hostname}) pointed at pid ${r.pid}, which is not its wrapper: record removed, nothing signalled`)
