import { blockers, type Issue, type LeadState } from './api'

import { messageRoles } from './message.mjs'
import { setPersonaRoles } from './persona'

export interface RoleDef { id: string; title: string; initial: string; color: string; workers?: boolean; summary?: string }
// Roles come from the project (leads/roles.json via /api/meta). Kept as one mutable list so every view follows changes.
export const ROLES: string[] = []
export const ROLE_LABEL: Record<string, string> = { '': 'Unassigned' }
export let ROLE_DEFS: RoleDef[] = []
// Whom a message may address (message.mjs messageRoles): the roles, and setup when the board has it (/api/meta `setup`).
export const MESSAGE_ROLES: string[] = []
// The board's Lead (roles.json `lead`, /api/meta `lead`): a person's comment goes to it unless they pick a role (sy-uykv).
export let BOARD_LEAD: string | null = null
export function setRoleDefs(defs: RoleDef[] | undefined, hasSetup = false, lead: string | null = null) {
  if (!defs?.length) return
  BOARD_LEAD = lead && defs.some((d) => d.id === lead) ? lead : null
  MESSAGE_ROLES.splice(0, MESSAGE_ROLES.length, ...messageRoles(defs.map((d) => d.id), hasSetup))
  ROLE_DEFS = defs
  ROLES.splice(0, ROLES.length, ...defs.map((d) => d.id))
  for (const k of Object.keys(ROLE_LABEL)) if (k) delete ROLE_LABEL[k]
  for (const d of defs) ROLE_LABEL[d.id] = d.title
  setPersonaRoles(defs)
}

// Leads are on demand (wake starts one when a request waits, and closes an idle one), so a lead is never "offline":
// ready unless a request is on it (site/lead-state.mjs gives the state).
export const LEAD_DOT: Record<LeadState['state'], string> = {
  ready: 'bg-foreground',
  working: 'bg-swiss animate-pulse',
  waiting: 'bg-swiss',
  blocked: 'border-2 border-swiss',
  error: 'bg-swiss',
}
export const LEAD_READY: LeadState = { state: 'ready', label: 'ready', item: null }

export const COLUMNS = [
  { key: 'ready', label: 'Ready', hint: 'Open, nothing blocking' },
  { key: 'waiting', label: 'Waiting', hint: 'Blocked or waiting on another item (the count leaves out what only waits for its rollout)' },
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

// A rollout item (its act's label): work that waits only on one is done and ships with it, not blocked (sy-7n3c).
export const ROLLOUT_LABELS = ['act:project-rollout', 'act:project-rollout-t2']
/** The rollout items an open item waits on when every open blocker it has is one (it ships with them); else null (no
 *  blocker, or one that is not a rollout: a real wait). The labels come with the board's list (byId), no fetch. */
export function shipsWith(i: Issue, byId: Map<string, Issue>): string[] | null {
  if (i.status === 'closed' || i.status === 'deferred') return null
  const ids = blockers(i, byId)
  return ids.length && ids.every((id) => (byId.get(id)!.labels || []).some((l) => ROLLOUT_LABELS.includes(l))) ? ids : null
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
