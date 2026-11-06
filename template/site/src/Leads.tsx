import { useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowClockwiseIcon, ClockCounterClockwiseIcon, PencilSimpleIcon, SparkleIcon, TrashIcon } from '@phosphor-icons/react'
import { LEAD_DOT, LEAD_READY, ROLE_LABEL } from '@/lib/board'
import type { LeadState } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/Markdown'
import { DiffView } from '@/Diff'
import { AddRole, Raci, requestRemoveRole } from '@/Raci'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'
import { PullOverview, RolePullView, usePull, Wip } from '@/Pull'
import { Flow } from '@/Flow'

interface Layer { path: string; content: string | null }
interface Skill { name: string; dir: string; description: string; path: string; raw: string | null; body: string; source: { id: string; hash: string; installedAt: string; by: string } | null }
interface RoleSettings {
  role: string
  cwd: string
  agent: { id: string; status: string; provider?: string; thinking?: string } | null
  state?: LeadState
  layers: Layer[]
  start: string
  startTemplate: string
  skills: Skill[]
  settingsPath: string
  settingsRaw: string | null
}

const LAYER_NOTE: Record<string, string> = {
  'CLAUDE.md': 'Project brief: every lead',
  'leads/CLAUDE.md': 'Board rules: every lead',
  'worktrees/CLAUDE.md': 'Worker brief: every code worker',
}

async function ask(body: Record<string, unknown>) {
  const d = await jsonFetch<{ id: string; title: string }>('/api/config/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  toast.success(`Sent to the setup agent: ${d.id} ${d.title}`)
  return d
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.title || `${r.status}`)
  return d as T
}

interface SetupInfo { agent: RoleSettings['agent']; state?: LeadState; layers: Layer[]; start: string; settingsRaw: string | null }
interface GovItem { id: string; title: string; status: string; updated_at: string; created_by?: string; owner?: string }

export function Leads({ onOpen, items, raci }: { onOpen: (id: string) => void; items: GovItem[]; raci: { activities: { id: string; title: string; raci: Record<string, string> }[] } | null }) {
  const [roles, setRoles] = useState<RoleSettings[]>([])
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [themes, setThemes] = useState<{ name: string; sample: string }[]>([])
  const personas = useContext(PersonaContext)
  const [sel, setSel] = useState('overview')
  const { d: pull, err: pullErr } = usePull()
  const pullOf = (role: string) => pull?.roles.find((x) => x.role === role)
  const [err, setErr] = useState('')
  const load = () => jsonFetch<{ roles: RoleSettings[]; setup: SetupInfo; themes: { name: string; sample: string }[] }>('/api/settings')
    .then((d) => { setRoles(d.roles); setSetup(d.setup); setThemes(d.themes || []); setErr('') }).catch((e) => setErr(String(e)))
  useEffect(() => { load(); const t = window.setInterval(load, 15000); return () => window.clearInterval(t) }, [])

  const r = roles.find((x) => x.role === sel)
  // phone width: the list is a strip that scrolls sideways above the page; from md on, a column on the left
  const item = 'flex shrink-0 items-center gap-2 border-r px-4 py-3 text-left text-[13px] font-semibold hover:bg-muted md:w-full md:border-r-0 md:border-b'
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] md:grid-cols-[12rem_1fr] md:grid-rows-1">
      <nav className="flex overflow-x-auto border-b md:block md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0">
        <button onClick={() => setSel('overview')} className={cn(item, sel === 'overview' && 'bg-foreground text-background hover:bg-foreground')}>
          Pull &amp; flow
          <span className="ml-auto text-[11px] font-normal opacity-70 tabular-nums">{pull ? `${pull.roles.reduce((n, x) => n + x.queue.length, 0)} queued` : ''}</span>
        </button>
        {roles.map((x) => (
          <button key={x.role} onClick={() => setSel(x.role)}
            className={cn(item, sel === x.role && 'bg-foreground text-background hover:bg-foreground')}>
            <Avatar actor={x.role} size="sm" />
            <span className="min-w-0 leading-tight"><span className="block truncate">{personaOf(personas, x.role)?.name}</span>
              <span className="block text-[11px] font-normal opacity-70">{ROLE_LABEL[x.role]}</span></span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {pullOf(x.role) && <span className="text-[11px] font-normal tabular-nums opacity-80" title="In progress / capacity">{pullOf(x.role)!.wip}/{pullOf(x.role)!.capacity ?? '-'}</span>}
              <span className={cn('size-2 shrink-0', LEAD_DOT[(x.state || LEAD_READY).state])} title={(x.state || LEAD_READY).label} />
            </span>
          </button>
        ))}
        <button onClick={() => setSel('setup')}
          className={cn(item, 'md:border-t-4 md:border-t-foreground',
            sel === 'setup' && 'bg-foreground text-background hover:bg-foreground')}>
          <Avatar actor="setup" size="sm" />
          <span className="min-w-0 leading-tight"><span className="block truncate">{personaOf(personas, 'setup')?.name}</span>
            <span className="block text-[11px] font-normal opacity-70">Setup agent</span></span>
          <span className={cn('ml-auto size-2 shrink-0', LEAD_DOT[(setup?.state || LEAD_READY).state])} title={(setup?.state || LEAD_READY).label} />
        </button>
        <button onClick={() => setSel('raci')}
          className={cn(item, sel === 'raci' && 'bg-foreground text-background hover:bg-foreground')}>
          RACI
          <span className="ml-auto text-[11px] font-normal opacity-70">{raci?.activities.length ?? 0} activities</span>
        </button>
        <button onClick={() => setSel('add-role')}
          className={cn(item, sel === 'add-role' && 'bg-foreground text-background hover:bg-foreground')}>
          + Add role
        </button>
        <button onClick={() => setSel('look')}
          className={cn(item, sel === 'look' && 'bg-foreground text-background hover:bg-foreground')}>
          Names &amp; look
          <span className="ml-auto text-[11px] font-normal opacity-70">{personas?.theme || 'default'}</span>
        </button>
        {err && <p className="p-4 text-xs text-swiss">{err}</p>}
      </nav>

      {sel === 'overview' && (
        <div className="min-h-0 overflow-y-auto">
          <Block title="Pull" note="The board is the queue: each role pulls its ready items in order, up to its capacity. A claim's lease runs 30 min from its last update; then wake puts it back in the queue.">
            <PullOverview pull={pull} err={pullErr} onOpen={onOpen} />
          </Block>
          <Block title="Flow" note="How work moved on this board, from its events (bin/flow, every 5 min).">
            <Flow />
          </Block>
        </div>
      )}

      {sel === 'setup' && setup && (
        <div className="min-h-0 overflow-y-auto">
          <Governance setup={setup} items={items} onOpen={onOpen} />
          {pullOf('setup') && (
            <Block title="Pull" note="Governance requests in its queue and in progress. Setup has no capacity: wake never holds it back.">
              <div className="px-2 py-3 md:px-4"><RolePullView r={pullOf('setup')!} onOpen={onOpen} /></div>
            </Block>
          )}
          <Block title="Setup agent's own brief" note="Read-only here. Only a human changes setup/ (over SSH), so the agent can't widen its own powers.">
            {setup.layers.map((l) => (
              <details key={l.path} open={l.path === 'setup/CLAUDE.md'} className="border-b last:border-b-0">
                <summary className="cursor-pointer px-6 py-2 font-mono text-[11px] hover:bg-muted">{l.path}</summary>
                <div className="bg-muted/30 px-6 py-3"><Markdown embeds={false}>{l.content ?? ''}</Markdown></div>
              </details>
            ))}
          </Block>
          <Block title="Setup agent's permissions" note="setup/.claude/settings.tmpl.json (read-only; {root} = the project folder)">
            <pre className="overflow-x-auto bg-muted/30 px-6 py-3 font-mono text-xs">{setup.settingsRaw}</pre>
          </Block>
        </div>
      )}

      {sel === 'look' && (
        <div className="min-h-0 overflow-y-auto">
          {setup && <Governance setup={setup} items={items} onOpen={onOpen} compact />}
          <Looks themes={themes} roles={[...roles.map((x) => x.role), 'setup']} />
        </div>
      )}

      {sel === 'raci' && <Raci raci={raci} />}
      {sel === 'add-role' && <AddRole />}

      {r && !['setup', 'look', 'raci', 'add-role'].includes(sel) && (
        <div key={r.role} className="min-h-0 overflow-y-auto">
          {setup && <Governance setup={setup} items={items} onOpen={onOpen} compact />}
          <section className="flex flex-wrap items-end gap-x-8 gap-y-3 border-b px-6 py-4 text-xs">
            <Fact label="State" value={(r.state || LEAD_READY).label} />
            <Fact label="Agent" value={r.agent ? r.agent.id : 'starts on the next request'} mono={!!r.agent} />
            <Fact label="Model" value={r.agent?.provider || '—'} />
            <Fact label="Folder" value={`${r.cwd}/`} mono />
            <div className="ml-auto flex items-center gap-3">
              <span className="max-w-xs text-[11px] text-muted-foreground">Changes go through the setup agent and apply when the lead restarts.</span>
              <RestartButton role={r.role} onDone={load} />
              <Button size="sm" variant="ghost" onClick={() => requestRemoveRole(r.role)}><TrashIcon />Remove role</Button>
            </div>
          </section>

          {pullOf(r.role) && (
            <Block title="Pull" note="Its queue in the order wake hands it, what it holds in progress against its capacity, each claim's lease, and its workers.">
              <div className="flex items-baseline gap-3 px-4 pt-3 md:px-6"><Wip r={pullOf(r.role)!} big /><span className="text-[11px] text-muted-foreground">in progress / capacity</span></div>
              <div className="px-2 pb-3 md:px-4"><RolePullView r={pullOf(r.role)!} onOpen={onOpen} /></div>
            </Block>
          )}

          <Block title="System prompt" note="Every CLAUDE.md from the lead's folder up to the project root. Reloaded after compaction.">
            {r.layers.map((l) => (
              <FileEditor key={l.path} path={l.path} content={l.content ?? ''} note={LAYER_NOTE[l.path] || 'Role brief: this lead only'}
                defaultOpen={l.path === `${r.cwd}/CLAUDE.md`} onSaved={load} />
            ))}
          </Block>

          <Block title="Start message" note="leads/START.md, shared by every lead; {role} and {project} are filled in. Sent once at start.">
            <FileEditor path="leads/START.md" content={r.startTemplate} note="Template" onSaved={load} />
          </Block>

          <Block title={`Skills · ${r.skills.length}`} note={`This lead only (${r.cwd}/.claude/skills/). Your user-level skills are also available to every lead.`}>
            {r.skills.map((s) => <SkillRow key={s.dir} role={r.role} skill={s} onChanged={load} />)}
            <SkillFinder role={r.role} installed={r.skills.map((s) => s.dir)} onInstalled={load} />
          </Block>

          <Block title="Permissions" note="Without a rule here, Claude Code's auto mode decides. Safety denies (no push, no edits to code/, control/, leads/) are always re-added on save.">
            <FileEditor path={r.settingsPath} content={r.settingsRaw ?? '{}'} kind="json" note="{root} = the project folder, {home} = your home; Claude Code gets an absolute copy (settings.json, generated)" defaultOpen onSaved={load} />
          </Block>
        </div>
      )}
    </div>
  )
}

function RestartButton({ role, onDone }: { role: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
      if (!window.confirm(`Ask the setup agent to restart the ${role} lead? It starts fresh from the current files.`)) return
      setBusy(true)
      try { await ask({ kind: 'restart', role }); onDone() }
      catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
    }}><ArrowClockwiseIcon />Request restart</Button>
  )
}

/** One editable file: view (rendered), edit, review with Claude, history. Saves commit to the config repo. */
function FileEditor({ path, content, note, kind = 'md', defaultOpen, onSaved }: {
  path: string; content: string; note: string; kind?: 'md' | 'json'; defaultOpen?: boolean; onSaved: () => void
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  const [mode, setMode] = useState<'view' | 'edit' | 'review' | 'history'>('view')
  const [draft, setDraft] = useState(content)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<{ status: string; elapsed?: number; error?: string; result?: { summary: string; changes: string[]; revised: string } } | null>(null)
  const [focus, setFocus] = useState('')
  useEffect(() => { if (mode === 'view') setDraft(content) }, [content, mode])

  async function save() {
    setBusy(true)
    try {
      const note = window.prompt('Why this change? (goes to the setup agent with the new text)') ?? ''
      await ask({ kind: 'edit', path, content: draft, note })
      setMode('view'); onSaved()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  async function startReview() {
    setMode('review'); setReview({ status: 'running', elapsed: 0 })
    try {
      const { job } = await jsonFetch<{ job: string }>('/api/config/review', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content: draft, focus }) })
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000))
        const s = await jsonFetch<NonNullable<typeof review>>(`/api/config/review/${job}`)
        setReview(s)
        if (s.status !== 'running') break
      }
    } catch (e) { setReview({ status: 'error', error: (e as Error).message }) }
  }

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="border-b last:border-b-0">
      <summary className="flex cursor-pointer items-baseline gap-3 px-6 py-2 hover:bg-muted">
        <span className="font-mono text-[11px]">{path}</span>
        <span className="text-[11px] text-muted-foreground">{note}</span>
      </summary>
      <div className="flex flex-wrap items-center gap-2 border-t px-6 py-1.5">
        {mode !== 'edit' && <Button size="xs" variant="outline" onClick={() => setMode('edit')}><PencilSimpleIcon />Edit</Button>}
        {mode === 'edit' && <>
          <Button size="xs" disabled={busy || draft === content} onClick={save}>Send to setup agent</Button>
          <Button size="xs" variant="ghost" onClick={() => { setDraft(content); setMode('view') }}>Cancel</Button>
        </>}
        <Button size="xs" variant="outline" onClick={startReview} disabled={review?.status === 'running'}><SparkleIcon />Review with Claude</Button>
        <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Focus for the review (optional)" className="h-6 w-64 text-[11px]" />
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setMode(mode === 'history' ? 'view' : 'history')}><ClockCounterClockwiseIcon />History</Button>
      </div>
      {mode === 'edit' && (
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
          className="min-h-96 rounded-none border-0 border-t px-6 py-3 font-mono text-xs leading-relaxed focus-visible:ring-0" />
      )}
      {mode === 'view' && (kind === 'md'
        ? <div className="bg-muted/30 px-6 py-3"><Markdown embeds={false}>{content}</Markdown></div>
        : <pre className="overflow-x-auto bg-muted/30 px-6 py-3 font-mono text-xs leading-relaxed">{content}</pre>)}
      {mode === 'review' && review && (
        <div className="border-t px-6 py-3">
          {review.status === 'running' && <p className="text-xs text-muted-foreground">Claude is reviewing {path}… {review.elapsed ?? 0}s</p>}
          {review.status === 'error' && <p className="text-xs text-swiss">Review failed: {review.error}</p>}
          {review.status === 'done' && review.result && (
            <div className="grid gap-3">
              <p className="text-[13px]">{review.result.summary}</p>
              <ul className="list-disc pl-5 text-xs">{review.result.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>{draft.split('\n').length} → {review.result.revised.split('\n').length} lines</span>
                <span>{draft.length} → {review.result.revised.length} characters</span>
              </div>
              <DiffView before={draft} after={review.result.revised} />
              <div className="flex gap-2">
                <Button size="xs" onClick={() => { setDraft(review.result!.revised); setMode('edit') }}>Use this (then send)</Button>
                <Button size="xs" variant="ghost" onClick={() => { setReview(null); setMode('view') }}>Discard</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {mode === 'history' && <History path={path} />}
    </details>
  )
}

function History({ path }: { path: string }) {
  const [commits, setCommits] = useState<{ sha: string; author: string; date: string; subject: string }[]>([])
  const [shown, setShown] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  useEffect(() => { jsonFetch<{ commits: typeof commits }>(`/api/config/history?path=${encodeURIComponent(path)}`).then((d) => setCommits(d.commits)).catch(() => {}) }, [path])
  return (
    <div className="border-t px-6 py-3">
      <ol className="grid gap-0.5 text-xs">
        {commits.map((c) => (
          <li key={c.sha}>
            <button className={cn('grid w-full grid-cols-[4rem_6rem_9rem_1fr] gap-2 text-left hover:bg-muted', shown === c.sha && 'bg-muted')}
              onClick={async () => { setShown(c.sha); const d = await jsonFetch<{ diff: string }>(`/api/config/diff?path=${encodeURIComponent(path)}&rev=${c.sha}`); setDiff(d.diff) }}>
              <span className="font-mono">{c.sha}</span><b>{c.author}</b><span className="text-muted-foreground">{c.date.slice(0, 16).replace('T', ' ')}</span><span className="truncate">{c.subject}</span>
            </button>
          </li>
        ))}
        {commits.length === 0 && <li className="text-muted-foreground">No history yet.</li>}
      </ol>
      {shown && <pre className="mt-2 max-h-96 overflow-auto bg-muted/40 p-3 font-mono text-[11px] leading-snug">{diff.split('\n').map((l, i) => (
        <span key={i} className={cn('block', l.startsWith('+') && !l.startsWith('+++') && 'bg-[#e6f4ea]', l.startsWith('-') && !l.startsWith('---') && 'bg-[#fde8e8]')}>{l || ' '}</span>))}</pre>}
    </div>
  )
}

function SkillRow({ role, skill: s, onChanged }: { role: string; skill: Skill; onChanged: () => void }) {
  return (
    <div className="border-b">
      <div className="grid grid-cols-[12rem_1fr_auto] items-baseline gap-3 px-6 py-2">
        <span className="text-[13px] font-semibold">{s.name}</span>
        <span className="text-xs text-muted-foreground">{s.description}
          {s.source && <span className="ml-2 font-mono text-[11px] text-foreground">skills.sh: {s.source.id} · by {s.source.by}</span>}</span>
        <Button size="xs" variant="ghost" onClick={async () => {
          if (!window.confirm(`Ask the setup agent to remove skill ${s.name} from the ${role} lead?`)) return
          try { await ask({ kind: 'skill-remove', role, name: s.dir }); onChanged() }
          catch (e) { toast.error((e as Error).message) }
        }}><TrashIcon />Request removal</Button>
      </div>
      <FileEditor path={s.path} content={s.raw ?? ''} note="SKILL.md" onSaved={onChanged} />
    </div>
  )
}

/** Search skills.sh, preview a skill's files, install it for this lead. */
function SkillFinder({ role, installed, onInstalled }: { role: string; installed: string[]; onInstalled: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: string; name: string; source: string; installs: number }[]>([])
  const [preview, setPreview] = useState<{ id: string; files: { path: string; size: number; script: boolean; contents?: string }[]; hash: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = window.setTimeout(() => jsonFetch<{ skills: typeof results }>(`/api/skills/search?q=${encodeURIComponent(q)}`).then((d) => setResults(d.skills)).catch((e) => toast.error(e.message)), 300)
    return () => window.clearTimeout(t)
  }, [q])
  const skillMd = preview?.files.find((f) => f.path.toLowerCase() === 'skill.md')
  return (
    <div className="bg-muted/30 px-6 py-3">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-[11px] font-bold tracking-[0.1em] uppercase">Add from skills.sh</span>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills (e.g. tdd, react, playwright)" className="h-7 w-80 bg-background" />
      </div>
      {results.length > 0 && (
        <ol className="grid max-h-64 gap-px overflow-y-auto border bg-border">
          {results.map((s) => (
            <li key={s.id}>
              <button className={cn('grid w-full grid-cols-[1fr_auto] gap-3 bg-background px-3 py-1.5 text-left text-xs hover:bg-muted', preview?.id === s.id && 'bg-muted')}
                onClick={async () => {
                  setPreview(null)
                  try { const d = await jsonFetch<{ files: NonNullable<typeof preview>['files']; hash: string }>(`/api/skills/preview?id=${encodeURIComponent(s.id)}`); setPreview({ id: s.id, ...d }) }
                  catch (e) { toast.error((e as Error).message) }
                }}>
                <span><b>{s.name}</b> <span className="font-mono text-[11px] text-muted-foreground">{s.source}</span>
                  {installed.includes(s.name) && <span className="ml-2 text-[11px] text-swiss">installed</span>}</span>
                <span className="tabular-nums text-muted-foreground">{s.installs.toLocaleString()} installs</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {preview && (
        <div className="mt-3 border border-foreground bg-background">
          <div className="flex flex-wrap items-center gap-3 border-b border-foreground px-3 py-2 text-xs">
            <b className="font-mono">{preview.id}</b>
            <span className="text-muted-foreground">{preview.files.length} files · hash {preview.hash?.slice(0, 12)}</span>
            {preview.files.some((f) => f.script) && <span className="font-semibold text-swiss">contains scripts: read them before installing</span>}
            <Button size="xs" className="ml-auto" disabled={busy} onClick={async () => {
              setBusy(true)
              try { await ask({ kind: 'skill-install', role, skill: preview.id }); setPreview(null); setQ(''); onInstalled() }
              catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
            }}>Request install for {role}</Button>
          </div>
          <ul className="flex flex-wrap gap-x-4 border-b px-3 py-1.5 font-mono text-[11px]">
            {preview.files.map((f) => <li key={f.path} className={cn(f.script && 'text-swiss')}>{f.path} <span className="text-muted-foreground">{f.size}b</span></li>)}
          </ul>
          {skillMd?.contents && <div className="max-h-96 overflow-y-auto px-3 py-2"><Markdown embeds={false}>{skillMd.contents}</Markdown></div>}
        </div>
      )}
    </div>
  )
}

/** The setup agent's channel: its status, open requests, and a free-form ask. */
function Governance({ setup, items, onOpen, compact }: { setup: SetupInfo; items: GovItem[]; onOpen: (id: string) => void; compact?: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const open = items.filter((i) => i.status !== 'closed')
  const done = items.filter((i) => i.status === 'closed').sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, compact ? 0 : 10)
  return (
    <section className="border-b border-foreground bg-muted/40">
      <div className="flex flex-wrap items-center gap-3 px-6 py-2 text-xs">
        <b className="text-[11px] tracking-[0.1em] uppercase">Governance</b>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className={cn('size-2', LEAD_DOT[(setup.state || LEAD_READY).state])} />
          setup agent {(setup.state || LEAD_READY).label}
        </span>
        <span className="text-muted-foreground">Only the setup agent changes briefs, skills and permissions. Your edits here become requests to it.</span>
      </div>
      {(open.length > 0 || done.length > 0) && (
        <ol className="grid gap-px border-t bg-border">
          {[...open, ...done].map((i) => (
            <li key={i.id}>
              <button onClick={() => onOpen(i.id)} className="grid w-full grid-cols-[6rem_1fr_6rem_5rem] gap-3 bg-background px-6 py-1.5 text-left text-xs hover:bg-muted">
                <span className="font-mono text-[11px] text-muted-foreground">{i.id}</span>
                <span className={cn('truncate', i.status === 'closed' && 'text-muted-foreground line-through')}>{i.title}</span>
                <span className={cn('text-[11px]', i.status === 'blocked' ? 'font-semibold text-swiss' : 'text-muted-foreground')}>{i.status.replace('_', ' ')}</span>
                <span className="text-[11px] text-muted-foreground">{i.owner || i.created_by || ''}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {!compact && (
        <form className="flex gap-2 border-t px-6 py-2" onSubmit={async (e) => {
          e.preventDefault(); if (!text.trim()) return
          setBusy(true); try { const d = await ask({ kind: 'ask', note: text.trim() }); setText(''); onOpen(d.id) } catch (x) { toast.error((x as Error).message) } finally { setBusy(false) }
        }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the setup agent (e.g. give QA a Playwright skill; shorten the design brief)" className="h-7 bg-background text-xs" />
          <Button size="sm" type="submit" disabled={busy || !text.trim()}>Send</Button>
        </form>
      )}
    </section>
  )
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{label}</div>
      <div className={cn('truncate text-[13px] font-medium', mono && 'font-mono text-xs')} title={value}>{value}</div>
    </div>
  )
}

function Block({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="border-b">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-foreground px-4 pt-4 pb-2 md:px-6">
        <h2 className="text-[11px] font-bold tracking-[0.1em] uppercase">{title}</h2>
        <p className="text-[11px] text-muted-foreground">{note}</p>
      </header>
      {children}
    </section>
  )
}

/** Names, colors and avatars of the agents (leads/personas.json). Changes go to the setup agent as exact commands. */
function Looks({ themes, roles }: { themes: { name: string; sample: string }[]; roles: string[] }) {
  const personas = useContext(PersonaContext)
  const [theme, setTheme] = useState(personas?.theme || 'birds')
  const [edits, setEdits] = useState<Record<string, { name?: string; color?: string; avatar?: string }>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (personas?.theme) setTheme(personas.theme) }, [personas?.theme])
  const send = async (note: string) => { setBusy(true); try { await ask({ kind: 'ask', note }); setEdits({}) } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) } }
  const changed = Object.entries(edits).filter(([, v]) => Object.values(v).some(Boolean))
  return (
    <>
      <Block title="Theme" note="All agents draw random names from one theme. Each name starts with its role's initial: Requirement R, Design D, Code C, QA Q, Setup S.">
        <div className="grid gap-px bg-border md:grid-cols-2">
          {themes.map((t) => (
            <label key={t.name} className={cn('flex cursor-pointer gap-3 bg-background px-6 py-2 text-xs hover:bg-muted', theme === t.name && 'bg-muted')}>
              <input type="radio" name="theme" checked={theme === t.name} onChange={() => setTheme(t.name)} className="mt-0.5 accent-foreground" />
              <span><b className="capitalize">{t.name}</b>{personas?.theme === t.name && <span className="ml-2 text-[11px] text-swiss">current</span>}
                <span className="block text-[11px] text-muted-foreground">{t.sample}</span></span>
            </label>
          ))}
        </div>
        <div className="flex gap-2 px-6 py-3">
          <Button size="sm" disabled={busy} onClick={() => send(`Personas: run \`persona theme ${theme}\` (new random names and the theme's avatars, keep colors), then config-check, commit, and restart the leads that are idle so they learn their names. Never restart code while workers run.`)}>
            {personas?.theme === theme ? 'Re-roll all names' : `Switch to ${theme}`}</Button>
          <span className="self-center text-[11px] text-muted-foreground">Goes to the setup agent; names appear here once it commits.</span>
        </div>
      </Block>
      <Block title="Agents" note="Edit any field, then send. Names must keep the role's initial; colors are #rrggbb; an avatar is an emoji or 1–2 letters.">
        {roles.map((role) => {
          const p = personaOf(personas, role)!
          const e = edits[role] || {}
          const set = (k: 'name' | 'color' | 'avatar', v: string) => setEdits({ ...edits, [role]: { ...e, [k]: v } })
          return (
            <div key={role} className="grid grid-cols-[3rem_9rem_1fr_9rem_6rem_auto] items-center gap-3 border-b px-6 py-2 text-xs">
              <Avatar actor={role} size="lg" />
              <span><b style={{ color: p.color }}>{p.name}</b><span className="block text-[11px] text-muted-foreground">{p.roleTitle}{role === 'setup' ? ' agent' : ' lead'}</span></span>
              <Input value={e.name ?? ''} onChange={(x) => set('name', x.target.value)} placeholder={`Name (starts with ${p.roleTitle[0]})`} className="h-7" />
              <span className="flex items-center gap-2">
                <input type="color" value={e.color || p.color} onChange={(x) => set('color', x.target.value)} className="h-7 w-9 cursor-pointer border" />
                <span className="font-mono text-[11px]">{e.color || p.color}</span>
              </span>
              <Input value={e.avatar ?? ''} onChange={(x) => set('avatar', x.target.value)} placeholder={p.avatar} className="h-7" />
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => send(`Personas: run \`persona reroll ${role}\`, then config-check and commit.`)}>Re-roll</Button>
            </div>
          )
        })}
        <div className="flex items-center gap-3 px-6 py-3">
          <Button size="sm" disabled={busy || changed.length === 0} onClick={() => send('Personas: apply these, then config-check, commit, and restart the changed leads when idle (never code while workers run):\n' +
            changed.map(([role, v]) => '- `persona set ' + role + Object.entries(v).filter(([, x]) => x).map(([k, x]) => ` ${k}=${JSON.stringify(x)}`).join('') + '`').join('\n'))}>
            Send {changed.length || ''} change{changed.length === 1 ? '' : 's'} to setup agent</Button>
        </div>
      </Block>
    </>
  )
}
