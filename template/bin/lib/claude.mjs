// Each project's own Claude folder ($MM_HOME/claude/<project>): every agent mm starts for this project runs with
// CLAUDE_CONFIG_DIR there, so no global CLAUDE.md, settings or memory is shared between projects. The login comes from
// the environment (the Paseo daemon's token), never from these folders. A fresh folder trusts nothing, and Claude
// ignores a project's `allow` rules in an untrusted folder, so mm trusts exactly the folders it starts agents in.
//   node bin/lib/claude.mjs dir              print this project's Claude folder (made 0700)
//   node bin/lib/claude.mjs trust [--no-memory] <path>...  trust these folders in it; prints the folder. --no-memory:
//                                            a worker's or assistant's, whose memory isn't the project's (sy-0e5)
//   node bin/lib/claude.mjs forget <path>... a folder gone (wt rm): its trust and memory link go
//   node bin/lib/claude.mjs prune            memory links no lead or setup folder owns (gone, a worker's) go
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, dirs, projectName } from './svc.mjs'

export function configDir(project = projectName()) {
  const d = path.join(dirs().mm, 'claude', project)
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  // narrowed to 0700 only where this process owns the folder and it isn't one a box shares with the host (mm up makes a
  // box's Claude folder 2770, setgid, the host owner's: its box user may not change its mode, and 0700 would shut the box
  // out; sy-7870: a lead's start in a box failed with EPERM here)
  for (const p of [path.dirname(d), d]) {
    let st; try { st = fs.statSync(p) } catch { continue }
    if (st.uid === process.getuid?.() && !(st.mode & 0o2000) && (st.mode & 0o777) !== 0o700) fs.chmodSync(p, 0o700)
  }
  return d
}
const enc = (folder) => folder.replace(/[^A-Za-z0-9]/g, '-')
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return {} } }
const writeJ = (f, j) => { const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(j, null, 1), { mode: 0o600 }); fs.renameSync(t, f) }
/**
 * Trust exactly these folders (absolute) for this project's agents. `memory`: link their Claude memory to the
 * project's memory/ (leads and setup). A worker or an assistant gets `memory: false` (review, sy-0e5): it reads
 * untrusted input or talks with members, and a note it writes would land in what every lead loads. Its memory stays
 * its own folder (not linked, not committed), and a link it had is removed.
 */
export function trust(paths, project = projectName(), { memory = true } = {}) {
  const d = configDir(project), f = path.join(d, '.claude.json'), j = readJ(f)
  j.projects ||= {}
  for (const p of paths) { const a = path.resolve(p); j.projects[a] = { ...(j.projects[a] || {}), hasTrustDialogAccepted: true }; memory ? linkMemory(d, a) : unlinkMemory(d, a) }
  writeJ(f, j)
  return d
}
/** The folder's memory is no longer the project's: a link there is removed (a real folder stays; nothing is deleted). */
export function unlinkMemory(d, folder) {
  const at = path.join(d, 'projects', enc(folder), 'memory')
  try { if (fs.lstatSync(at).isSymbolicLink()) fs.unlinkSync(at) } catch {}
}
/** A folder gone (wt rm): its trust and its Claude project entry go too (sy-0e5). Only the memory link is removed from
 *  that entry, and the entry itself only when nothing else is left in it. */
export function forget(paths, project = projectName()) {
  const d = configDir(project), f = path.join(d, '.claude.json'), j = readJ(f)
  for (const p of paths) {
    const a = path.resolve(p); if (j.projects) delete j.projects[a]
    unlinkMemory(d, a)
    try { fs.rmdirSync(path.join(d, 'projects', enc(a))) } catch {} // only when empty
  }
  writeJ(f, j)
}
/** Whose folders keep the project's memory: the leads (leads/<role>, a lead's own worktree worktrees/lead-<role>) and
 *  setup. Everything else (workers, assistants) does not. */
export const sharesMemory = (folder, root = ROOT) => {
  const r = path.relative(root, path.resolve(folder))
  return r === '' || /^leads\/[^/]+$/.test(r) || r === 'setup' || /^worktrees\/lead-[^/]+$/.test(r) // '': the root, which bin/lead trusts too
}
/** Every memory link to the project's memory/ that no lead or setup folder of today owns is removed: folders that are
 *  gone (an old wt rm), and workers' and assistants' (sy-0e5). Returns what it removed (the entries' names). */
export function prune(project = projectName(), mem = path.join(ROOT, 'memory')) {
  const d = configDir(project), j = readJ(path.join(d, '.claude.json')), owners = new Map()
  for (const a of Object.keys(j.projects || {})) owners.set(enc(a), a)
  const out = []
  let names = []; try { names = fs.readdirSync(path.join(d, 'projects')) } catch {}
  for (const n of names) {
    const at = path.join(d, 'projects', n, 'memory')
    let link = null; try { if (fs.lstatSync(at).isSymbolicLink()) link = fs.readlinkSync(at) } catch {}
    if (link !== mem) continue
    const a = owners.get(n)
    if (a && fs.existsSync(a) && sharesMemory(a)) continue
    fs.unlinkSync(at); out.push(n)
    try { fs.rmdirSync(path.join(d, 'projects', n)) } catch {}
  }
  return out
}
/**
 * What an agent learns lives in the project's own memory/ (its config repo: versioned, backed up, restored with it).
 * Claude keeps a folder's memory in <config>/projects/<the folder's path, / as ->/memory: that becomes a link to it.
 * A real folder already there is moved in first (a name clash keeps both), never deleted.
 */
export function linkMemory(d, folder, mem = path.join(ROOT, 'memory')) {
  fs.mkdirSync(mem, { recursive: true })
  const at = path.join(d, 'projects', enc(folder), 'memory')
  fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 })
  let st = null; try { st = fs.lstatSync(at) } catch {}
  if (st?.isSymbolicLink()) { if (fs.readlinkSync(at) === mem) return; fs.unlinkSync(at) }
  else if (st?.isDirectory()) {
    for (const f of fs.readdirSync(at)) { let to = path.join(mem, f); if (fs.existsSync(to)) to = path.join(mem, `${path.parse(f).name}.from-${path.basename(folder)}${path.parse(f).ext}`); fs.renameSync(path.join(at, f), to) }
    fs.rmdirSync(at)
  }
  fs.symlinkSync(mem, at)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'dir') console.log(configDir())
  else if (cmd === 'trust' && rest[0] === '--no-memory' && rest.length > 1) console.log(trust(rest.slice(1), projectName(), { memory: false }))
  else if (cmd === 'trust' && rest.length) console.log(trust(rest))
  else if (cmd === 'forget' && rest.length) forget(rest)
  else if (cmd === 'prune') for (const n of prune()) console.log(`removed the memory link of ${n}`)
  else { console.error('usage: claude.mjs dir | trust [--no-memory] <path>... | forget <path>... | prune'); process.exit(2) }
}
