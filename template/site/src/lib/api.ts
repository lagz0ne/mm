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
  setup?: boolean // the board has its setup agent (setup/CLAUDE.md): a message may address it (sy-0ggd)
  raci?: { activities: { id: string; title: string; raci: Record<string, string>; consult?: string[] }[] } | null
  last: Record<string, { author: string; at: string }>
  panels?: string[] // turned on by the board's env (BOARD_PANELS), e.g. the system board's machine panel
}

/** The owner's own actions on an item (POST /api/<action>, the public side; the server checks the owner, the item, and
 *  that the request is same-origin JSON). */
async function ownerAct(action: 'approve' | 'not-now' | 'reply' | 'done', item: string, more: Record<string, string> = {}) {
  const r = await fetch(`/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...more, item }) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.title || `${r.status}`)
  return d as { ok: true; title: string; approved?: boolean }
}

export const api = {
  meta: () => fetch('/api/meta').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`meta ${r.status}`))) as Promise<Meta>),
  // role: on the public side; approval: the owner's only, how the T2 go is given (the label, or a tap on Telegram)
  whoami: () => fetch('/api/whoami').then((r) => r.json() as Promise<{ actor: string; source: 'gateway' | 'self' | 'default'; role?: string; approval?: 'label' | 'telegram' }>),
  // with the ledger on: the board sends the item to the bridge, which offers it on the owner's Telegram (signs nothing here)
  // verifier actor (sy-92sg): the board adds approved as the owner, with a comment; same route, same checks
  approveOnTelegram: (item: string) => ownerAct('approve', item),
  approve: (item: string) => ownerAct('approve', item),
  // the owner's "not now" on a t2 that waits for the go: a comment, and needs-you removed
  notNow: (item: string) => ownerAct('not-now', item),
  // the owner's answer to a card that asks no go (sy-t9tg): a reply (a comment as the owner), or done (needs-you removed)
  reply: (item: string, text: string) => ownerAct('reply', item, { text }),
  done: (item: string) => ownerAct('done', item),
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
