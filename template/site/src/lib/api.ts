// Thin client for the Beads HTTP API (`bd serve`), reached through the board server at /api.

export type Status = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed' | 'pinned' | 'hooked'

export interface Dep {
  issue_id?: string
  depends_on_id?: string
  id?: string
  title?: string
  status?: Status
  type?: string
  dependency_type?: string
}

export interface Comment {
  id: string
  issue_id: string
  author: string
  text: string
  created_at: string
}

export interface Issue {
  id: string
  title: string
  description?: string
  status: Status
  priority: number
  issue_type: string
  assignee?: string
  labels?: string[]
  created_at: string
  created_by?: string
  owner?: string
  updated_at: string
  closed_at?: string
  close_reason?: string
  parent?: string
  dependencies?: Dep[]
  dependency_count?: number
  dependent_count?: number
  comment_count?: number
  comments?: Comment[]
}

export interface BeadEvent {
  seq: number
  ts: string
  op: string
  issue_id: string
  actor: string
  issue?: Partial<Issue>
  comment?: Comment
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/beads${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail || data.title || `${r.status}`)
  return data as T
}

type Page<T> = { items: T[]; has_more: boolean }

export interface Lead { id: string; name: string; status: string }
/** A lead as the board shows it (site/lead-state.mjs): leads are on demand, so never "offline". */
export interface LeadState { state: 'ready' | 'working' | 'waiting' | 'blocked' | 'error'; label: string; item: string | null; error?: string }
export interface Meta {
  project: string
  leads: Record<string, Lead | null> & { _workers?: { id: string; role: string; status: string; item: string }[] }
  states?: Record<string, LeadState>
  creators: Record<string, string>
  personas?: import('@/lib/persona').Personas | null
  roles?: import('@/lib/board').RoleDef[]
  raci?: { activities: { id: string; title: string; raci: Record<string, string> }[] } | null
  last: Record<string, { author: string; at: string }>
  panels?: string[] // turned on by the board's env (BOARD_PANELS), e.g. the system board's machine panel
}

export const api = {
  meta: () => fetch('/api/meta').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`meta ${r.status}`))) as Promise<Meta>),
  whoami: () => fetch('/api/whoami').then((r) => r.json() as Promise<{ actor: string; source: 'access' | 'self' | 'default' }>),
  identify: async (name: string) => {
    const r = await fetch('/api/whoami', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.title || `${r.status}`)
    return d as { actor: string; source: 'self' }
  },
  open: () => call<Page<Issue>>('GET', '/issues?limit=500').then((p) => p.items),
  closed: () => call<Page<Issue>>('GET', '/issues?status=closed&limit=100').then((p) => p.items),
  ready: () => call<Page<Issue>>('GET', '/ready?limit=500').then((p) => p.items),
  get: (id: string) => call<Issue>('GET', `/issues/${id}?include_comments=true`),
  create: (body: Partial<Issue> & { parent_id?: string }) => call<Issue>('POST', '/issues', body),
  patch: (id: string, patch: Record<string, unknown>) => call<{ issue: Issue }>('PATCH', `/issues/${id}`, { patch }),
  close: (id: string, reason?: string) => call('POST', `/issues/${id}:close`, reason ? { reason } : {}),
  reopen: (id: string) => call('POST', `/issues/${id}:reopen`, {}),
  comment: (id: string, text: string) => call<Comment>('POST', `/issues/${id}/comments`, { text }),
  events: (since: number, limit = 40) =>
    call<{ head: number; records: BeadEvent[] }>('GET', `/events?since=${since}&limit=${limit}`),
}

/** Ids of open issues this one waits on (type "blocks"). */
export function blockers(issue: Issue, byId: Map<string, Issue>): string[] {
  return (issue.dependencies || [])
    .filter((d) => (d.type || d.dependency_type) === 'blocks')
    .map((d) => d.depends_on_id || d.id || '')
    .filter((id) => id && byId.has(id) && byId.get(id)!.status !== 'closed')
}
