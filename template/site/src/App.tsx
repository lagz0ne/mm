import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRightIcon, ChatCircleIcon, LinkSimpleIcon, PlusIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { api, blockers, type BeadEvent, type Issue, type Meta } from '@/lib/api'
import { COLUMNS, LEAD_DOT, LEAD_READY, ROLES, ROLE_LABEL, ago, byPriority, columnOf, roleOf, setRoleDefs, type ColumnKey } from '@/lib/board'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { NewItem } from '@/NewItem'
import { Identify } from '@/Identify'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'
import { CardPresence, NowStrip, PresenceBar, PresenceContext, RowPresence, usePresenceFeed } from '@/Presence'

// Heavy parts load on demand (markdown, diffs, RACI, settings), and are prefetched once the board is idle.
const loadDetail = () => import('@/Detail'), loadLeads = () => import('@/Leads')
const Detail = lazy(() => loadDetail().then((m) => ({ default: m.Detail })))
const Leads = lazy(() => loadLeads().then((m) => ({ default: m.Leads })))
const Machine = lazy(() => import('@/Machine').then((m) => ({ default: m.Machine })))
const viewOf = (h: string) => (h === '#leads' ? 'leads' : h === '#machine' ? 'machine' : 'board')
if (typeof window !== 'undefined') window.addEventListener('load', () => setTimeout(() => { loadDetail(); loadLeads() }, 1500))
const EMPTY_META: Meta = { project: '', leads: {}, creators: {}, last: {} }
const SLOW_MIN = 15 // a ready item nobody picked up for this long turns red

export default function App() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [ready, setReady] = useState<Set<string>>(new Set())
  const [events, setEvents] = useState<BeadEvent[]>([])
  const [live, setLive] = useState(false)
  const [actor, setActor] = useState('')
  const [idSource, setIdSource] = useState('')
  const [identifying, setIdentifying] = useState(false)
  const [links, setLinks] = useState<{ name: string; label: string; url: string }[]>([])
  const [role, setRole] = useState('all')
  const [q, setQ] = useState('')
  // ?item=<id> opens that item (the gateway's "Waiting for you" list links here, sy-vdi8); only an id of the board's pattern
  const [openId, setOpenId] = useState<string | null>(() => {
    const id = new URLSearchParams(window.location.search).get('item') || ''
    return /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/.test(id) ? id : null
  })
  const [creating, setCreating] = useState(false)
  const [meta, setMeta] = useState<Meta>(EMPTY_META)
  const presence = usePresenceFeed()
  const [view, setView] = useState(() => viewOf(window.location.hash))
  const [, setNow] = useState(0) // re-render each poll so "waiting 3m" ages
  const [tick, setTick] = useState(0) // bumps when anything changes, so an open detail reloads
  const search = useRef<HTMLInputElement>(null)
  // Tablet widths (md to xl, the breakpoints the header and grid already use): Now and Activity fold into a drawer
  // the toolbar's toggle opens over the columns, below the toolbar so the toggle stays in reach (sy-l6t1). Phone keeps
  // them below the board, desktop beside it.
  const [side, setSide] = useState(false)
  const sideBtn = useRef<HTMLButtonElement>(null)
  const sidePanel = useRef<HTMLElement>(null)
  const closeSide = useCallback((refocus = true) => { setSide(false); if (refocus) sideBtn.current?.focus() }, [])
  useEffect(() => { if (side) sidePanel.current?.focus() }, [side])
  useEffect(() => {
    if (!side || openId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeSide() } }
    // a tap outside (the toolbar, the epics) closes it too; the scrim over the columns closes it on its own click
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!sidePanel.current?.contains(t) && !sideBtn.current?.contains(t) && !(t as HTMLElement).closest?.('[data-side-scrim]')) closeSide(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [side, openId, closeSide])
  const openFromSide = (id: string) => { closeSide(false); setOpenId(id) }

  const load = useCallback(async () => {
    try {
      // items first: never hold the board back for agents/personas (meta fills in when it arrives)
      api.meta().then((m) => { setRoleDefs(m.roles); setMeta(m) }).catch(() => {})
      const [open, closed, rdy] = await Promise.all([api.open(), api.closed(), api.ready()])
      setIssues([...open, ...closed])
      setReady(new Set(rdy.map((i) => i.id)))
      setTick((t) => t + 1)
    } catch (e) {
      toast.error(`Load failed: ${(e as Error).message}`)
    }
  }, [])

  // Initial load, recent activity, then the live event stream.
  useEffect(() => {
    load()
    fetch('/api/links').then((r) => r.json()).then((d) => setLinks(d.links || [])).catch(() => {})
    api.whoami().then((w) => { setActor(w.actor); setIdSource(w.source); if (w.source === 'default') setIdentifying(true) }).catch(() => {})
    let es: EventSource | undefined
    let timer: number | undefined
    let stopped = false
    const seen = new Set<number>()
    api.events(0, 1).then(async ({ head }) => {
      const recent = await api.events(Math.max(0, head - 40), 40)
      if (stopped) return
      recent.records.forEach((r) => seen.add(r.seq))
      setEvents([...recent.records].reverse())
      es = new EventSource(`/api/v0/beads/events:watch?since=${head}`)
      es.onopen = () => setLive(true)
      es.onerror = () => setLive(false)
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as BeadEvent
        if (seen.has(ev.seq)) return
        seen.add(ev.seq)
        setEvents((list) => [ev, ...list].slice(0, 60))
        window.clearTimeout(timer)
        timer = window.setTimeout(load, 150)
      }
    }).catch((e) => toast.error(`Events: ${(e as Error).message}`))
    return () => { stopped = true; es?.close(); window.clearTimeout(timer) }
  }, [load])

  useEffect(() => {
    const onHash = () => setView(viewOf(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => { if (meta.project) document.title = `${meta.project} · work board` }, [meta.project])

  // Lead status changes in Paseo, not in Beads, so poll it.
  useEffect(() => {
    const t = window.setInterval(() => { api.meta().then((m) => { setRoleDefs(m.roles); setMeta(m) }).catch(() => {}); setNow(Date.now()) }, 5000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,[role=dialog]') || e.metaKey || e.ctrlKey) return
      if (e.key === 'n') { e.preventDefault(); setCreating(true) }
      if (e.key === '/') { e.preventDefault(); search.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const epics = useMemo(() => issues.filter((i) => i.issue_type === 'epic' && i.status !== 'closed'), [issues])
  const work = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return issues.filter((i) => i.issue_type !== 'epic' && i.assignee !== 'setup' && !(i.labels || []).includes('governance') && (!needle ||
      i.id.toLowerCase().includes(needle) || i.title.toLowerCase().includes(needle)))
  }, [issues, q])

  const counts = useMemo(() => {
    const c: Record<ColumnKey, number> = { ready: 0, waiting: 0, progress: 0, done: 0 }
    work.filter((i) => role === 'all' || roleOf(i) === role).forEach((i) => c[columnOf(i, ready)]++)
    return c
  }, [work, ready, role])

  const rows = role === 'all' ? [...ROLES, ''] : [role]

  async function move(id: string, toRole: string, toCol: ColumnKey) {
    const i = byId.get(id)
    if (!i) return
    if (columnOf(i, ready) === toCol && roleOf(i) === toRole) return
    try {
      if (i.status === 'closed' && toCol !== 'done') await api.reopen(id)
      const patch: Record<string, unknown> = {}
      if (roleOf(i) !== toRole) patch.assignee = toRole
      if (toCol === 'ready' && i.status !== 'open') patch.status = 'open'
      if (toCol === 'waiting' && i.status !== 'blocked') patch.status = 'blocked'
      if (toCol === 'progress' && i.status !== 'in_progress') patch.status = 'in_progress'
      if (Object.keys(patch).length) await api.patch(id, patch)
      if (toCol === 'done' && i.status !== 'closed') await api.close(id, 'Closed from board')
      load()
    } catch (e) {
      toast.error(`${id}: ${(e as Error).message}`)
    }
  }

  return (
    <PersonaContext.Provider value={meta.personas ?? null}>
    <PresenceContext.Provider value={presence}>
    <div className="flex h-svh flex-col overflow-hidden border-t-4 border-foreground bg-background text-foreground">
      <header className="grid shrink-0 grid-cols-12 items-end gap-x-6 border-b border-foreground px-6 pt-4 pb-3">
        <div className="col-span-12 flex items-end gap-6 md:col-span-5">
          <h1 className="text-4xl leading-none font-bold tracking-tight">{meta.project || '…'}</h1>
          <nav className="flex gap-4 pb-0.5 text-[13px] font-semibold">
            {(['board', 'leads', ...(meta.panels?.includes('machine') ? ['machine' as const] : [])] as const).map((v) => (
              <a key={v} href={v === 'board' ? '#' : `#${v}`}
                className={cn('border-b-2 pb-0.5 capitalize', view === v ? 'border-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>{v}</a>
            ))}
            {links.map((l) => (
              <a key={l.name} href={l.url} target="_blank" rel="noreferrer" title={l.url}
                className="flex items-center gap-0.5 border-b-2 border-transparent pb-0.5 text-swiss hover:border-swiss">
                {l.label}<ArrowUpRightIcon weight="bold" className="size-3" />
              </a>
            ))}
          </nav>
        </div>
        <dl className={cn('col-span-12 mt-3 grid grid-cols-5 gap-x-6 md:col-span-7 md:mt-0', view !== 'board' && 'invisible')}>
          {COLUMNS.map((c) => (
            <div key={c.key} title={c.hint}>
              <dt className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{c.label}</dt>
              <dd className="text-3xl leading-none font-bold tabular-nums">{counts[c.key]}</dd>
            </div>
          ))}
          <div className="flex items-end justify-end gap-3" title={live ? 'Live updates on' : 'Live updates off'}>
            <PresenceBar />
            <span className={cn('size-2.5', live ? 'bg-swiss' : 'border border-muted-foreground')} />
          </div>
        </dl>
      </header>

      {view === 'machine' ? <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading…</div>}><Machine /></Suspense> : view === 'leads' ? <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading…</div>}><Leads onOpen={setOpenId} raci={meta.raci ?? null} items={issues.filter((i) => i.assignee === 'setup' || (i.labels || []).includes('governance'))} /></Suspense> : (<>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-6 py-2.5">
        <ToggleGroup type="single" value={role} onValueChange={(v) => v && setRole(v)} variant="outline" size="sm" spacing={0}>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          {ROLES.map((r) => <ToggleGroupItem key={r} value={r}>{ROLE_LABEL[r]}</ToggleGroupItem>)}
        </ToggleGroup>
        <Input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
          className="h-7 w-56" />
        <button type="button" ref={sideBtn} aria-expanded={side} aria-controls="board-side" onClick={() => (side ? closeSide() : setSide(true))}
          title="Now and recent activity"
          className={cn('ml-auto hidden h-7 items-center gap-1.5 border px-2.5 text-xs font-semibold md:inline-flex xl:hidden', side ? 'border-foreground bg-foreground text-background' : 'border-input hover:border-foreground')}>
          Now <span className={cn('min-w-4 px-1 text-center tabular-nums', presence.length ? 'bg-swiss text-white' : 'bg-muted text-muted-foreground', side && !presence.length && 'bg-background/20 text-background')}>{presence.length}</span>
          <span aria-hidden className={side ? 'opacity-60' : 'text-muted-foreground'}>·</span> Activity
        </button>
        <button type="button" className="ml-auto text-xs hover:underline md:ml-0 xl:ml-auto" disabled={idSource === 'gateway'}
          title={idSource === 'gateway' ? 'Your name comes from your sign-in' : 'Change who you are'}
          onClick={() => setIdentifying(true)}>
          <b>{actor || '…'}</b>{idSource === 'default' && <span className="text-swiss"> · who are you?</span>}
        </button>
        <Button size="sm" title="New item (N)" onClick={() => setCreating(true)}><PlusIcon weight="bold" />New</Button>
      </div>

      {epics.length > 0 && (
        <section className="grid shrink-0 border-b md:grid-cols-2 xl:grid-cols-3">
          {epics.map((e) => {
            const kids = issues.filter((i) => i.parent === e.id)
            const done = kids.filter((i) => i.status === 'closed').length
            return (
              <button key={e.id} onClick={() => setOpenId(e.id)}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 border-r px-6 py-2 text-left hover:bg-muted">
                <span className="font-mono text-[11px] text-muted-foreground">{e.id}</span>
                <span className="truncate text-[13px] font-semibold">{e.title}</span>
                <span className="text-xs tabular-nums">{done}/{kids.length}</span>
                <span className="col-span-3 mt-1.5 h-1 bg-muted">
                  <span className="block h-full bg-foreground" style={{ width: `${kids.length ? (done / kids.length) * 100 : 0}%` }} />
                </span>
              </button>
            )
          })}
        </section>
      )}

      <div className="relative grid min-h-0 flex-1 grid-rows-[1fr_14rem] md:grid-rows-1 xl:grid-cols-[1fr_20rem]">
        <main className="min-h-0 overflow-auto">
          <div className="grid min-w-[880px] grid-cols-[9.5rem_repeat(4,minmax(0,1fr))]">
            <div className="sticky top-0 z-10 border-b border-foreground bg-background" />
            {COLUMNS.map((c) => (
              <div key={c.key} className="sticky top-0 z-10 flex items-baseline justify-between border-b border-l border-b-foreground bg-background px-3 py-2">
                <span className="text-[11px] font-bold tracking-[0.1em] uppercase">{c.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{counts[c.key]}</span>
              </div>
            ))}
            {rows.map((r) => (
              <Row key={r || 'none'} role={r} items={work.filter((i) => roleOf(i) === r)} ready={ready} byId={byId}
                meta={meta} onOpen={setOpenId} onMove={move} />
            ))}
          </div>
        </main>

        {side && <div aria-hidden data-side-scrim onClick={() => closeSide()} className="absolute inset-0 z-40 hidden bg-foreground/25 md:block xl:hidden" />}
        <aside id="board-side" ref={sidePanel} tabIndex={-1} aria-label="Now and activity"
          className={cn('flex min-h-0 flex-col border-t outline-none',
            'md:absolute md:inset-y-0 md:right-0 md:z-50 md:w-80 md:max-w-[85vw] md:border-t-0 md:border-l md:border-foreground md:bg-background md:shadow-2xl',
            side ? 'md:flex' : 'md:hidden',
            'xl:static xl:z-auto xl:flex xl:w-auto xl:max-w-none xl:border-border xl:shadow-none')}>
          <NowStrip onOpen={openFromSide} />
          <h2 className="shrink-0 border-b border-foreground px-4 py-2 text-[11px] font-bold tracking-[0.1em] uppercase">Activity</h2>
          <ol className="min-h-0 flex-1 overflow-y-auto">
            {events.length === 0 && <li className="px-4 py-3 text-xs text-muted-foreground">No events yet.</li>}
            {events.map((ev) => (
              <li key={ev.seq}>
                <button onClick={() => openFromSide(ev.issue_id)} className="grid w-full grid-cols-[2.5rem_1fr] gap-x-2 border-b px-4 py-2 text-left hover:bg-muted">
                  <span className="text-[11px] text-muted-foreground tabular-nums">{ago(ev.ts)}</span>
                  <span className="min-w-0 text-xs leading-snug">
                    <ActorName actor={ev.actor || 'beads'} personas={meta.personas ?? null} /> {verb(ev)} <span className="font-mono text-[11px]">{ev.issue_id}</span>
                    <span className="block truncate text-muted-foreground">{ev.comment ? `“${ev.comment.text}”` : ev.issue?.title}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      </>)}

      {openId && <Suspense fallback={null}><Detail id={openId} tick={tick} byId={byId} creator={meta.creators[openId]} onClose={() => { setOpenId(null); if (window.location.search) window.history.replaceState(null, '', window.location.pathname + window.location.hash) }} onOpen={setOpenId} onChanged={load} /></Suspense>}
      <NewItem open={creating} onOpenChange={setCreating} epics={epics} defaultRole={role === 'all' ? '' : role}
        onCreated={(i) => { load(); toast.success(`Created ${i.id}`) }} />
      <Identify open={identifying} current={idSource === 'self' ? actor : ''} onOpenChange={setIdentifying}
        onDone={(n) => { setActor(n); setIdSource('self'); toast.success(`You are ${n}`) }} />
      <Toaster position="bottom-left" />
    </div>
    </PresenceContext.Provider>
    </PersonaContext.Provider>
  )
}

function verb(ev: BeadEvent) {
  switch (ev.op) {
    case 'comment': return 'commented on'
    case 'create': return 'created'
    case 'close': return 'closed'
    case 'reopen': return 'reopened'
    case 'delete': return 'deleted'
    case 'update': return ev.issue?.status ? `updated (${ev.issue.status.replace('_', ' ')})` : 'updated'
    default: return ev.op
  }
}

type MoveFn = (id: string, role: string, col: ColumnKey) => void


function Row({ role, items, ready, byId, meta, onOpen, onMove }: {
  role: string; items: Issue[]; ready: Set<string>; byId: Map<string, Issue>; meta: Meta
  onOpen: (id: string) => void; onMove: MoveFn
}) {
  const lead = role ? meta.leads[role] : null
  const st = (role && meta.states?.[role]) || LEAD_READY
  return (
    <>
      <div className="border-b px-3 py-2.5">
        {role ? (() => { const p = personaOf(meta.personas ?? null, role); return (
          <div className="flex items-center gap-2">
            <Avatar actor={role} size="md" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[13px] font-bold" style={{ color: p?.color }}>{p?.name}</div>
              <div className="text-[11px] text-muted-foreground">{ROLE_LABEL[role]}</div>
              <RowPresence role={role} />
            </div>
          </div>) })() : <div className="text-[13px] font-bold">{ROLE_LABEL[role]}</div>}
        {role && (
          <div className={cn('mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground', ['waiting', 'blocked', 'error'].includes(st.state) && 'font-semibold text-swiss')}
            title={st.state === 'error' ? `Start failed: ${st.error}` : lead ? `Lead: Paseo agent ${lead.id}` : 'Starts on the next request'}>
            <span className={cn('size-2 shrink-0', LEAD_DOT[st.state])} />
            {st.item ? <button className="hover:underline" onClick={() => onOpen(st.item!)}>{st.label}</button> : st.label}
          </div>
        )}
        {role && (meta.leads._workers || []).some((w) => w.role === role) && (
          <div className="mt-1 grid gap-0.5 text-[11px]">
            {meta.leads._workers!.filter((w) => w.role === role).map((w) => (
              <span key={w.id} className="flex items-center gap-1.5" title={`Worker ${w.id}: ${w.status}`}>
                <span className={cn('size-1.5 shrink-0', w.status === 'running' ? 'bg-swiss animate-pulse' : 'bg-foreground')} />
                <span className="font-mono">{w.item}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {COLUMNS.map((c) => {
        let cell = items.filter((i) => columnOf(i, ready) === c.key)
        cell = c.key === 'done'
          ? cell.sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || '')).slice(0, 8)
          : cell.sort(byPriority)
        return <Cell key={c.key} col={c.key} role={role} items={cell} byId={byId} meta={meta} onOpen={onOpen} onMove={onMove} />
      })}
    </>
  )
}

function Cell({ col, role, items, byId, meta, onOpen, onMove }: {
  col: ColumnKey; role: string; items: Issue[]; byId: Map<string, Issue>; meta: Meta; onOpen: (id: string) => void; onMove: MoveFn
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onMove(e.dataTransfer.getData('text/plain'), role, col) }}
      className={cn('flex min-h-16 flex-col gap-1.5 border-b border-l p-1.5', over && 'bg-muted outline-2 -outline-offset-2 outline-foreground')}
    >
      {items.map((i) => <Card key={i.id} issue={i} col={col} waitsOn={blockers(i, byId)} last={meta.last[i.id]} onOpen={onOpen}
        worker={meta.leads._workers?.find((w) => w.item === i.id)} />)}
    </div>
  )
}

function Card({ issue: i, col, waitsOn, last, onOpen, worker }: {
  issue: Issue; col: ColumnKey; waitsOn: string[]; last?: Meta['last'][string]; onOpen: (id: string) => void
  worker?: { id: string; status: string }
}) {
  const closed = i.status === 'closed'
  const role = roleOf(i)
  const fromLead = !!last && (ROLES as readonly string[]).includes(last.author)
  // Who owes the next move on the thread.
  const awaitingLead = !closed && !!role && !!last && !fromLead
  const needsYou = !closed && fromLead && (i.status === 'blocked' || (i.labels || []).includes('needs-you'))
  const waitedMin = (Date.now() - new Date(i.updated_at).getTime()) / 60000
  return (
    <button
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', i.id)}
      onClick={() => onOpen(i.id)}
      className={cn('grid gap-1 border border-border bg-card px-2 py-1.5 text-left hover:border-foreground',
        i.priority === 0 && !closed && 'border-l-4 border-l-swiss', closed && 'opacity-55')}
    >
      <span className="flex items-center gap-2 text-[11px]">
        {roleOf(i) && <Avatar actor={roleOf(i)} size="xs" />}
        <span className="font-mono text-muted-foreground">{i.id}</span>
        <span className={cn('font-bold tabular-nums', i.priority === 0 && 'text-swiss')}>P{i.priority}</span>
        <span className="text-muted-foreground">{i.issue_type}</span>
        {worker && <span className="ml-auto flex items-center gap-1 font-semibold text-swiss" title={`Worker ${worker.id}: ${worker.status}`}>
          <span className={cn('size-1.5 bg-swiss', worker.status === 'running' && 'animate-pulse')} />worker</span>}
        {i.status === 'blocked' && <span className={cn('font-semibold uppercase', !worker && 'ml-auto')}>blocked</span>}
        {i.status === 'deferred' && <span className="ml-auto font-semibold uppercase">deferred</span>}
      </span>
      <span className={cn('text-[13px] leading-snug font-medium', closed && 'line-through')}>{i.title}</span>
      {(waitsOn.length > 0 || !!i.comment_count || col === 'ready') && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {col === 'ready' && (
            <span className={cn(waitedMin > SLOW_MIN && 'font-semibold text-swiss')} title="Waiting for pickup">
              waiting {ago(i.updated_at)}
            </span>
          )}
          {waitsOn.length > 0 && <span className="flex items-center gap-1"><LinkSimpleIcon />waits on {waitsOn.join(', ')}</span>}
          {!!i.comment_count && <span className="flex items-center gap-1"><ChatCircleIcon />{i.comment_count}</span>}
        </span>
      )}
      <CardPresence item={i.id} />
      {awaitingLead && (
        <span className="border-l-2 border-swiss pl-1.5 text-[11px] font-semibold">
          reply due · {ago(last!.at)}
        </span>
      )}
      {needsYou && (
        <span className="bg-swiss px-1.5 py-0.5 text-[11px] font-semibold text-white">Needs you · {ago(last!.at)}</span>
      )}
    </button>
  )
}

function ActorName({ actor, personas }: { actor: string; personas: import('@/lib/persona').Personas | null }) {
  const p = personaOf(personas, actor)
  if (!p) return <b>{actor}</b>
  return <span className="inline-flex items-baseline gap-1"><Avatar actor={actor} size="xs" className="self-center" /><b style={{ color: p.color }}>{p.worker ? p.label : p.name}</b></span>
}
