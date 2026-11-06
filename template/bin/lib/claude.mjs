// Each project's own Claude folder ($MM_HOME/claude/<project>): every agent mm starts for this project runs with
// CLAUDE_CONFIG_DIR there, so no global CLAUDE.md, settings or memory is shared between projects. The login comes from
// the environment (the Paseo daemon's token), never from these folders. A fresh folder trusts nothing, and Claude
// ignores a project's `allow` rules in an untrusted folder, so mm trusts exactly the folders it starts agents in.
//   node bin/lib/claude.mjs dir              print this project's Claude folder (made 0700)
//   node bin/lib/claude.mjs trust <path>...  trust these folders in it; prints the folder
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
/** Trust exactly these folders (absolute) for this project's agents. */
export function trust(paths, project = projectName()) {
  const d = configDir(project), f = path.join(d, '.claude.json')
  let j = {}
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  j.projects ||= {}
  for (const p of paths) { const a = path.resolve(p); j.projects[a] = { ...(j.projects[a] || {}), hasTrustDialogAccepted: true }; linkMemory(d, a) }
  const t = `${f}.tmp-${process.pid}`
  fs.writeFileSync(t, JSON.stringify(j, null, 1), { mode: 0o600 }); fs.renameSync(t, f)
  return d
}
/**
 * What an agent learns lives in the project's own memory/ (its config repo: versioned, backed up, restored with it).
 * Claude keeps a folder's memory in <config>/projects/<the folder's path, / as ->/memory: that becomes a link to it.
 * A real folder already there is moved in first (a name clash keeps both), never deleted.
 */
export function linkMemory(d, folder, mem = path.join(ROOT, 'memory')) {
  fs.mkdirSync(mem, { recursive: true })
  const at = path.join(d, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
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
  else if (cmd === 'trust' && rest.length) console.log(trust(rest))
  else { console.error('usage: claude.mjs dir | trust <path>...'); process.exit(2) }
}
