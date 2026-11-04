// Where this project's services are, at runtime. Engine code never hard-codes hosts or ports: it asks here.
// Order: env SVC_URL_<NAME> (e.g. SVC_URL_BD_SERVE) → {root}/.run/endpoints.json (written by the process manager).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** The project's id (e.g. client-name): MM_PROJECT, else `project:` in .mm-answers.yaml, else the folder name. */
export function projectName() {
  if (process.env.MM_PROJECT) return process.env.MM_PROJECT
  try { const m = /^project:\s*["']?([\w.-]+)/m.exec(fs.readFileSync(path.join(ROOT, '.mm-answers.yaml'), 'utf8')); if (m) return m[1] } catch {}
  return path.basename(ROOT)
}
/** The project's services, resolved by the process manager (.run/services.json), else the declared services.json. */
export function servicesDef() {
  for (const f of ['.run/services.json', 'services.json']) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).services || {} } catch {} }
  return {}
}
export function endpoints() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.run', 'endpoints.json'), 'utf8')) } catch { return { services: {} } }
}
const envKey = (name) => `SVC_URL_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
/** Base URL of a service (no trailing slash), or null. */
export function svcUrl(name) {
  const v = process.env[envKey(name)] || endpoints().services?.[name]?.url
  return v ? v.replace(/\/$/, '') : null
}
/**
 * Where the machine's folders are (mm writes them: .run/endpoints.json "dirs", else MM_* env from the mm that runs this,
 * else the older layout). Engine code never builds ~/brain or ~/projects itself.
 */
export function dirs() {
  const d = endpoints().dirs || {}, E = process.env, H = E.HOME || ''
  return { mm: d.mm || E.MM_HOME || `${H}/.mm`, brain: d.brain || E.MM_BRAIN || `${H}/brain`, system: d.system || E.MM_SYSTEM || `${H}/brain/system`,
    projects: d.projects || E.MM_PROJECTS || `${H}/projects`, backups: d.backups || E.MM_BACKUPS || `${H}/.local/share/backups`, vault: d.vault || `${d.mm || E.MM_HOME || `${H}/.mm`}/vault` }
}
export function svcPublic(name) { return endpoints().services?.[name]?.public || null }
/** Restart one service through whatever manages them (template from endpoints.json, e.g. "process-compose process restart {project}/{service}"). */
export function restartService(name) {
  const t = endpoints().restart
  if (!t) throw new Error('no restart command in .run/endpoints.json')
  execSync(t.replaceAll('{service}', name).replaceAll('{project}', projectName()), { stdio: 'inherit', timeout: 60000 })
}
/** Recent log lines of one service, through the process manager (template `logs` in endpoints.json). */
export function serviceLogs(name, lines = 100) {
  const t = endpoints().logs
  if (!t) throw new Error('no logs command in .run/endpoints.json')
  return execSync(t.replaceAll('{service}', name).replaceAll('{project}', projectName()).replaceAll('{lines}', String(lines)), { encoding: 'utf8', timeout: 30000 })
}
export function requireUrl(name) {
  const u = svcUrl(name)
  if (!u) { console.error(`${name}: unknown address; set ${envKey(name)} or start it through the process manager (.run/endpoints.json)`); process.exit(2) }
  return u
}
