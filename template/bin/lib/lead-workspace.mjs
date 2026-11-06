#!/usr/bin/env node
// Where bin/lead puts a lead in Paseo: one Paseo project per mm project (rooted at the project root) and one workspace
// per role inside it, reused across restarts. Without this, Paseo makes a project and a workspace for every folder an
// agent starts in, so each lead folder became its own project and every restart added a workspace.
//   node bin/lib/lead-workspace.mjs <project root> <lead dir> <workspace title> [<project name>]
//       prints the role's workspace id (creating the project and the workspace the first time)
//   node bin/lib/lead-workspace.mjs --tidy <project root>
//       archives this project's workspaces that are in the wrong Paseo project (the old one-per-folder layout) or whose
//       folder is gone, and removes the empty Paseo projects under the root. A workspace with a live agent is kept.
// When Paseo's client can't be loaded or reached it prints nothing and exits 0: bin/lead then starts the lead as before
// (Paseo picks the place), so a lead always starts. Messages go to stderr.
// The client: the DaemonClient that the installed Paseo CLI ships (the one its own commands use), found the way
// paseo.mjs finds the SDK. The SDK's high-level API can list and create workspaces but cannot name or remove a project.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sdkPath } from './paseo.mjs'
import { endpoints } from './svc.mjs'

const argv = process.argv.slice(2), tidy = argv[0] === '--tidy'
const [root, dir, title, name] = tidy ? [argv[1]] : argv
if (!root || (!tidy && (!dir || !title))) {
  console.error('usage: lead-workspace.mjs <project root> <lead dir> <title> [<project name>] | --tidy <project root>'); process.exit(2)
}
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const under = (p, r) => p === r || p.startsWith(r + path.sep)
const R = real(root)

async function client() {
  const f = sdkPath(); if (!f) throw new Error('no Paseo client found')
  const { DaemonClient } = await import(pathToFileURL(path.join(path.dirname(f), 'daemon-client.js')).href)
  const url = process.env.PASEO_URL || endpoints().paseo || 'ws://127.0.0.1:6767/ws'
  const c = new DaemonClient({ url, clientId: 'mm-lead', clientType: 'cli' })
  await Promise.race([c.connect(), new Promise((_, no) => setTimeout(() => no(new Error('connect timeout')), 8000))])
  return c
}
const active = async (c) => (await c.fetchWorkspaces()).entries.filter((w) => !w.archivingAt)
const projectOf = (ws) => ws.find((w) => real(w.projectRootPath) === R)?.projectId
async function create(c, p, projectId, t) {
  const r = await c.createWorkspace({ source: { kind: 'directory', path: p, ...(projectId ? { projectId } : {}) }, title: t })
  if (!r.workspace) throw new Error(r.error || `could not create a workspace for ${p}`)
  return r.workspace
}

async function place(c) {
  const D = real(dir)
  let ws = await active(c)
  // the project: the one rooted at the project root; the first lead creates it, with the root's own workspace
  let projectId = projectOf(ws)
  if (!projectId) { projectId = (await create(c, R, null, name || path.basename(R))).projectId; ws = await active(c) }
  if (name) {
    const cur = ws.find((w) => w.projectId === projectId)
    if (cur && (cur.projectCustomName || cur.projectDisplayName) !== name) await c.renameProject(projectId, name).catch(() => {})
  }
  // the role's workspace in that project, reused. A workspace for this folder in another project (the old layout) is
  // left alone here: --tidy archives it once its agent is gone.
  const mine = ws.find((w) => w.projectId === projectId && real(w.workspaceDirectory) === D) || (await create(c, D, projectId, title))
  console.log(mine.id)
}

async function tidyUp(c) {
  const ws = await active(c), projectId = projectOf(ws)
  const busy = new Map()
  for (const { agent: a } of (await c.fetchAgents()).entries) if (a && !a.archivedAt && a.workspaceId) busy.set(a.workspaceId, a.title || a.id)
  let archived = 0, kept = 0, removed = 0
  for (const w of ws) {
    const d = real(w.workspaceDirectory)
    if (!under(d, R) && !under(real(w.projectRootPath), R)) continue
    const wrong = w.projectId !== projectId, gone = !fs.existsSync(w.workspaceDirectory)
    if (!wrong && !gone) continue
    if (busy.has(w.id)) { console.error(`kept ${w.id} (${d}): ${busy.get(w.id)} still runs there; restart that lead to move it`); kept++; continue }
    await c.archiveWorkspace(w.id); archived++
  }
  const left = new Set((await active(c)).map((w) => w.projectId))
  for (const p of (await c.listProjects()).projects || []) {
    if (p.projectId === projectId || left.has(p.projectId) || !under(real(p.projectRootPath), R)) continue
    await c.removeProject(p.projectId); removed++
  }
  console.error(`tidy ${R}: ${archived} workspace(s) archived, ${kept} kept (live agent), ${removed} empty project(s) removed`)
}

let c
try { c = await client() } catch (e) { console.error(`lead-workspace: ${e.message}; Paseo places the lead itself`); process.exit(0) }
try { await (tidy ? tidyUp(c) : place(c)) }
catch (e) { console.error(`lead-workspace: ${e.message}${tidy ? '' : '; Paseo places the lead itself'}`); if (tidy) process.exitCode = 1 }
finally { try { await c.close() } catch {} }
process.exit(process.exitCode || 0)
