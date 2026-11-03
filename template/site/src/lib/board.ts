import type { Issue } from './api'

import { setPersonaRoles } from './persona'

export interface RoleDef { id: string; title: string; initial: string; color: string; workers?: boolean; summary?: string }
// Roles come from the project (leads/roles.json via /api/meta). Kept as one mutable list so every view follows changes.
export const ROLES: string[] = []
export const ROLE_LABEL: Record<string, string> = { '': 'Unassigned' }
export let ROLE_DEFS: RoleDef[] = []
export function setRoleDefs(defs: RoleDef[] | undefined) {
  if (!defs?.length) return
  ROLE_DEFS = defs
  ROLES.splice(0, ROLES.length, ...defs.map((d) => d.id))
  for (const k of Object.keys(ROLE_LABEL)) if (k) delete ROLE_LABEL[k]
  for (const d of defs) ROLE_LABEL[d.id] = d.title
  setPersonaRoles(defs)
}

export const COLUMNS = [
  { key: 'ready', label: 'Ready', hint: 'Open, nothing blocking' },
  { key: 'waiting', label: 'Waiting', hint: 'Blocked or waiting on another item' },
  { key: 'progress', label: 'In progress', hint: 'A lead is on it' },
  { key: 'done', label: 'Done', hint: 'Closed' },
] as const
export type ColumnKey = (typeof COLUMNS)[number]['key']

export const TYPES = ['task', 'feature', 'bug', 'chore', 'decision', 'epic'] as const
export const PRIORITIES = [0, 1, 2, 3, 4] as const

export function columnOf(i: Issue, ready: Set<string>): ColumnKey {
  if (i.status === 'closed') return 'done'
  if (i.status === 'in_progress' || i.status === 'hooked') return 'progress'
  if (i.status === 'open' && ready.has(i.id)) return 'ready'
  return 'waiting'
}

export function roleOf(i: Issue): string {
  return i.assignee && ROLES.includes(i.assignee) ? i.assignee : ''
}

export function byPriority(a: Issue, b: Issue) {
  return a.priority - b.priority || b.updated_at.localeCompare(a.updated_at)
}

export function ago(ts: string) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
