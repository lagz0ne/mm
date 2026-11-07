#!/usr/bin/env node
// workers — a lead's workers on a board whose roles say what a worker is (roles.json `worker`; the system profile,
// sy-asaw). The rules bin/wt, bin/lead worker and config-check share, and `bin/lead worker ...` itself.
//   roles.json, per role:  "workers": true            the lead may start workers (the owner's yes, then setup sets it)
//                          "worker": { "kind": "write" | "read" | "board", "repo": "{home}/mm", "model": "..." }
//     write  a worktree of `repo` on its own branch <name>: the worker writes only there
//     read   a read-only checkout of `repo` (detached, at a ref)
//     board  no repo: it reads the machine and writes only the board, as <role>/<name>
//   Never the brain (only ops writes it, one run branch at a time), never inside this board, never a project to write.
// A worker's folder: worktrees/<role>-<name>/ (so it reads ../CLAUDE.md, the worker brief, and this board's CLAUDE.md).
// Its permissions: leads/<role>/.claude/worker.tmpl.json, rendered by config-check into <folder>/.claude/settings.local.json.
//
//   lead worker start <role> <name> --item <ID> --brief <file> [--ref <ref>] [--model provider/model]
//       claim the item first; refused past the role's capacity or the project's cap (bin/lib/places.mjs)
//   lead worker stop <role> <name>      archive it (its folder stays: wt rm <role>-<name>)
//   lead worker report <role> <name>    its final reply only (never its activity)
//   lead worker ls [<role>]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ROOT, dirs, projectName } from './svc.mjs'
import { places, projectCap, total, workersOf } from './places.mjs'

const E = process.env
const HOME = E.HOME || ''
export const KINDS = ['write', 'read', 'board']
export const NAME = /^[a-z0-9][a-z0-9.-]{0,31}$/
export const validName = (n) => NAME.test(n || '') && !n.includes('..') && !n.endsWith('.lock') && !['main', 'master', 'head'].includes(n)

export function roleDefs(P = ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(P, 'leads', 'roles.json'), 'utf8')).roles || [] } catch { return [] }
}
/** {home} {mm} {root} {brain} {projects} in a path from roles.json. */
export function fill(v, P = ROOT) {
  const D = dirs()
  return String(v).replaceAll('{home}', HOME).replaceAll('{mm}', D.mm).replaceAll('{root}', P).replaceAll('{brain}', D.brain).replaceAll('{projects}', D.projects)
}
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const within = (a, b) => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
/** The brain, in every layout this machine may have it (what mm says, and both defaults). */
export function brains() {
  return [...new Set([dirs().brain, E.MM_BRAIN, `${HOME}/.mm/brain`, `${HOME}/brain`].filter((x) => x && x.startsWith('/')).flatMap((b) => [path.resolve(b), real(b)]))]
}
/** A role's worker spec: { id, on, kind, repoRaw, repo (absolute), model } or null (the role has none). */
export function spec(P, role) {
  const r = roleDefs(P).find((x) => x.id === role)
  if (!r || !r.worker || typeof r.worker !== 'object') return null
  const raw = typeof r.worker.repo === 'string' ? r.worker.repo : ''
  return { id: role, on: r.workers === true, kind: r.worker.kind, repoRaw: raw, repo: raw ? path.resolve(fill(raw, P)) : '', model: r.worker.model || '', capacity: r.capacity }
}
/** Why a spec can't be used, or null. `exists`: also require the repo to be there (wt; config-check doesn't). */
export function specProblem(P, s, { exists = false } = {}) {
  if (!KINDS.includes(s.kind)) return `kind must be one of ${KINDS.join(', ')} (has ${JSON.stringify(s.kind)})`
  if (s.kind === 'board') return s.repoRaw ? 'a board worker has no repo' : null
  if (!s.repoRaw) return `a ${s.kind} worker needs a repo`
  if (!path.isAbsolute(fill(s.repoRaw, P))) return `repo ${s.repoRaw} is not an absolute path ({home}/..., {mm}/... or /...)`
  const r = real(s.repo)
  for (const b of brains()) if (within(r, b) || within(b, r) || within(s.repo, b) || within(b, s.repo))
    return `repo ${s.repoRaw} is the brain or holds it: never a worktree of the brain (only ops writes it, one run branch at a time)`
  if (within(r, real(P)) || within(real(P), r)) return `repo ${s.repoRaw} is this board or holds it`
  if (s.kind === 'write' && [dirs().projects, `${HOME}/projects`, `${HOME}/.mm/projects`].some((d) => within(r, real(d)))) return `repo ${s.repoRaw} is a project's: nobody here writes projects`
  if (exists) {
    let top = ''
    try { top = execFileSync('git', ['-C', s.repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
    if (!top || real(top) !== r) return `repo ${s.repoRaw} is not the top of a git repo`
  }
  return null
}
/** The worker folders under worktrees/: [{ dir, path, role, name }] (the longest role id that prefixes the name). */
export function folders(P = ROOT) {
  const roles = roleDefs(P).filter((r) => r.worker && typeof r.worker === 'object').map((r) => r.id).sort((a, b) => b.length - a.length)
  let ents = []
  try { ents = fs.readdirSync(path.join(P, 'worktrees'), { withFileTypes: true }) } catch {}
  const out = []
  for (const d of ents) {
    if (!d.isDirectory()) continue
    const role = roles.find((r) => d.name.startsWith(`${r}-`) && validName(d.name.slice(r.length + 1)))
    if (role) out.push({ dir: d.name, path: path.join(P, 'worktrees', d.name), role, name: d.name.slice(role.length + 1) })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

// ---------- bin/lead worker ... ----------
const die = (m, code = 1) => { console.error(`lead worker: ${m}`); process.exit(code) }
const PASEO = E.PASEO_BIN || 'paseo'
// the CLI only (leads' Paseo use stays the CLI, under their permission rules; bin/lib/paseo.mjs is the engine's)
const pcli = (args) => execFileSync(PASEO, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, env: agentEnv() })
function agentEnv() { const e = { ...E }; for (const k of ['PASEO_AGENT_ID', 'PASEO_AGENT_CWD', 'PASEO_WORKSPACE_ID']) delete e[k]; return e }
const cliPaseo = { list: async (labels = {}, { archived = false } = {}) => JSON.parse(pcli(['ls', '-g', ...(archived ? ['-a'] : []), ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), '--json']) || '[]')
  .map((a) => ({ ...a, name: a.title ?? a.name ?? null, labels: a.labels || { ...labels }, archived: !!(a.archivedAt || a.archived) })) }
const workerRoles = (P) => roleDefs(P).filter((r) => r.workers === true).map((r) => r.id)
function inProgress(P) {
  const out = execFileSync(path.join(P, 'bin', 'bd'), ['list', '--status', 'in_progress', '--json', '--limit', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, cwd: P })
  return JSON.parse(out || '[]')
}
function need(P, role, name) {
  const s = spec(P, role)
  if (!s) die(`${role || '(none)'}: no workers for this role here (roles.json has no worker spec for it)`, 2)
  if (name !== undefined && !validName(name)) die(`bad worker name '${name}' (a-z 0-9 . -, up to 32; not main)`, 2)
  return s
}
async function mine(P, role, name, archived = false) {
  return (await cliPaseo.list({ project: projectName(), role: `${role}-worker` }, { archived }))
    .filter((a) => (a.labels?.worker || (/ worker ([a-z0-9][a-z0-9.-]*) on /.exec(a.name || '') || [])[1]) === name)
}

async function start(P, role, name, o) {
  const s = need(P, role, name)
  if (!s.on) die(`${role}: workers are not switched on (roles.json "workers": true is setup's step, after the owner's yes)`)
  if (!o.item || !/^[a-z][a-z0-9]*-[a-z0-9]+(?:\.\d+)*$/.test(o.item)) die('--item <ID> is required (the item you claimed for it)', 2)
  if (!o.brief) die('--brief <file> is required (what the worker does, tests and reports)', 2)
  let brief = ''
  try { brief = fs.readFileSync(o.brief, 'utf8') } catch (e) { die(`cannot read the brief ${o.brief}: ${e.message}`, 2) }
  if (!brief.trim() || brief.length > 65536) die('the brief is empty or longer than 64 KB', 2)
  // the item: yours, in progress (claim it first)
  const items = inProgress(P), it = items.find((i) => i.id === o.item)
  if (!it || !(it.assignee === role || String(it.assignee || '').startsWith(`${role}/`))) die(`${o.item} is not in progress for ${role}: claim it first (bd update ${o.item} --claim)`)
  // its place: within the role's capacity and the project's cap (a P0 may go past by one, as wake hands it)
  const ws = await workersOf(cliPaseo, projectName(), workerRoles(P))
  if (ws.some((w) => w.role === role && w.name === name)) die(`a ${role} worker named ${name} is still there: stop it first (lead worker stop ${role} ${name})`)
  const p = places(role, items, ws), add = p.unworked.some((i) => i.id === o.item) ? 0 : 1, over = it.priority === 0 ? 1 : 0
  const cap = Number.isInteger(s.capacity) && s.capacity > 0 ? s.capacity : 1
  if (p.used + add > cap + over) die(`${role} holds ${p.used} of its capacity ${cap} (each worker is one place, and each item no worker works on): finish, stop or hand over one first`)
  const pcap = projectCap(dirs().mm), t = total([...roleDefs(P).map((r) => r.id), 'setup'], items, ws)
  if (pcap && t + add > pcap + over) die(`the project holds ${t} of its cap ${pcap}: no new worker now`)
  // its folder (bin/wt renders its permissions), then the agent
  const W = execFileSync(path.join(P, 'bin', 'wt'), [role, name, ...(o.ref ? [o.ref] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd: P }).trim().split('\n').pop()
  const cdir = execFileSync('node', [path.join(P, 'bin', 'lib', 'claude.mjs'), 'trust', '--no-memory', W], { encoding: 'utf8', env: { ...E, MM_PROJECT: projectName() } }).trim()
  const project = projectName(), actor = `${role}/${name}`, model = o.model || s.model || 'claude/claude-opus-5-5'
  const prompt = `You are ${actor}, a worker of the ${role} lead of ${project}, for item ${o.item}. Your folder: ${W}. ` +
    'Follow ../CLAUDE.md (the worker brief): your final reply is your report, and the lead reads only that.\n\nThe lead\'s brief:\n\n' + brief
  // every kind in auto (Paseo's Claude provider has no dontAsk, and default would ask the owner's phone): a read or
  // board worker's allow-only hook refuses what its allow list does not name, first (config-check renders it)
  const args = ['run', '--no-wait', '-q', '--title', `${project} · ${role} worker ${name} on ${o.item}`, '--provider', model, '--mode', 'auto',
    '--cwd', W, '--label', `project=${project}`, '--label', `role=${role}-worker`, '--label', `worker=${name}`, '--label', `item=${o.item}`,
    '--env', `CLAUDE_CONFIG_DIR=${cdir}`, '--env', `BEADS_ACTOR=${actor}`, '--env', `GIT_AUTHOR_NAME=${actor}`, '--env', `GIT_COMMITTER_NAME=${actor}`,
    '--env', `GIT_AUTHOR_EMAIL=${role}@${project}.local`, '--env', `GIT_COMMITTER_EMAIL=${role}@${project}.local`, '--env', `PATH=${path.join(P, 'bin')}:${E.PATH || '/usr/bin:/bin'}`, prompt]
  const id = pcli(args).trim()
  console.log(`started ${actor} on ${o.item} (${s.kind}) in ${W}${id ? `: ${id}` : ''}`)
}
async function stop(P, role, name) {
  need(P, role, name)
  const list = await mine(P, role, name)
  if (!list.length) return console.log(`no ${role} worker named ${name}`)
  for (const a of list) { pcli(['archive', '--force', a.id]); console.log(`archived ${role}/${name} (${a.shortId || a.id})`) }
  console.log(`its folder stays: wt rm ${role}-${name} when its work is integrated`)
}
async function report(P, role, name) {
  need(P, role, name)
  const a = (await mine(P, role, name, true))[0]
  if (!a) die(`no ${role} worker named ${name}`)
  process.stdout.write(`${role}/${name} (${a.shortId || a.id}, ${a.status}${a.archived ? ', archived' : ''}):\n`)
  process.stdout.write(pcli(['logs', a.id, '--filter', 'text', '--tail', '1']))
}
async function ls(P, only) {
  const roles = roleDefs(P).filter((r) => r.worker && (!only || r.id === only)).map((r) => r.id)
  const ws = await workersOf(cliPaseo, projectName(), roles)
  if (!ws.length) return console.log('no workers')
  for (const w of ws) console.log(`${w.role.padEnd(10)} ${String(w.name || '?').padEnd(20)} ${String(w.item || '-').padEnd(12)} ${String(w.status).padEnd(8)} ${w.id}`)
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const [cmd, role, name, ...rest] = process.argv.slice(2), o = {}
  for (let k = 0; k < rest.length; k++) {
    const m = /^--(item|brief|ref|model)$/.exec(rest[k])
    if (!m || k + 1 >= rest.length) die(`unknown or incomplete option ${rest[k]}`, 2)
    o[m[1]] = rest[++k]
  }
  const run = { start: () => start(P, role, name, o), stop: () => stop(P, role, name), report: () => report(P, role, name), ls: () => ls(P, role) }[cmd]
  if (!run || (cmd !== 'ls' && !name)) { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => /^\/\/   lead worker|^\/\/       /.test(l)).map((l) => l.slice(5)).join('\n')); process.exit(2) }
  run().catch((e) => die(String(e.stderr || e.message || e).trim().slice(0, 500)))
}
