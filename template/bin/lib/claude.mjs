// Each project's own Claude folder ($MM_HOME/claude/<project>): every agent mm starts for this project runs with
// CLAUDE_CONFIG_DIR there, so no global CLAUDE.md, settings or memory is shared between projects. The login comes from
// the environment (the Paseo daemon's token), never from these folders. A fresh folder trusts nothing, and Claude
// ignores a project's `allow` rules in an untrusted folder, so mm trusts exactly the folders it starts agents in.
//   node bin/lib/claude.mjs dir              print this project's Claude folder (made 0700)
//   node bin/lib/claude.mjs trust <path>...  trust these folders in it; prints the folder
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirs, projectName } from './svc.mjs'

export function configDir(project = projectName()) {
  const d = path.join(dirs().mm, 'claude', project)
  fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(d), 0o700); fs.chmodSync(d, 0o700)
  return d
}
/** Trust exactly these folders (absolute) for this project's agents. */
export function trust(paths, project = projectName()) {
  const d = configDir(project), f = path.join(d, '.claude.json')
  let j = {}
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  j.projects ||= {}
  for (const p of paths) { const a = path.resolve(p); j.projects[a] = { ...(j.projects[a] || {}), hasTrustDialogAccepted: true } }
  const t = `${f}.tmp-${process.pid}`
  fs.writeFileSync(t, JSON.stringify(j, null, 1), { mode: 0o600 }); fs.renameSync(t, f)
  return d
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'dir') console.log(configDir())
  else if (cmd === 'trust' && rest.length) console.log(trust(rest))
  else { console.error('usage: claude.mjs dir | trust <path>...'); process.exit(2) }
}
