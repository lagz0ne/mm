import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRightIcon, CaretLeftIcon, CaretRightIcon, ChatCircleIcon, LinkSimpleIcon, PlusIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { api, blockers, type BeadEvent, type Issue, type Meta, type WaitingEntry } from '@/lib/api'
import { COLUMNS, LEAD_DOT, LEAD_READY, ROLES, ROLE_LABEL, ago, byPriority, columnOf, roleOf, setRoleDefs, shipsWith, type ColumnKey } from '@/lib/board'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Toaster } from '@/components/ui/sonner'
import { useDesk, usePhone } from '@/lib/phone'
import { REL_TAG, clearLinks, hoverLinks, linksNotShown, linksPinned, pinLinks, setLinkGraph, useLinkRel, useMarked } from '@/lib/links'
import { Goals } from '@/Goals'
import { PhoneBar } from '@/PhoneBar'
import { HumanBar, type HumanView } from '@/HumanBar'
import { ForYou } from '@/ForYou'
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
const Glossary = lazy(() => import('@/Glossary').then((m) => ({ default: m.Glossary })))
const viewOf = (h: string) => (h === '#leads' ? 'leads' : h === '#machine' ? 'machine' : h === '#glossary' ? 'glossary' : 'board') as 'board' | 'leads' | 'machine' | 'glossary'
// a person signed in through the gateway starts on For you (sy-c7mh); the board is behind #board
const humanViewOf = (h: string): HumanView => (h === '#board' ? 'board' : h === '#leads' ? 'leads' : h === '#machine' ? 'machine' : h === '#glossary' ? 'glossary' : 'foryou')
if (typeof window !== 'undefined') window.addEventListener('load', () => setTimeout(() => { loadDetail(); loadLeads() }, 1500))
const EMPTY_META: Meta = { project: '', leads: {}, creators: {}, last: {} }
const SLOW_MIN = 15 // a ready item nobody picked up for this long turns red
const LONG_PRESS_MS = 450 // a press this long on a phone marks the card's links instead of opening it

export default function App() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [ready, setReady] = useState<Set<string>>(new Set())
  const [events, setEvents] = useState<BeadEvent[]>([])
  const [live, setLive] = useState(false)
  const [actor, setActor] = useState('')
  const [idSource, setIdSource] = useState('')
  const [me, setMe] = useState<{ approval?: 'label' | 'telegram'; home?: string; role?: string }>({})
  const [waiting, setWaiting] = useState<WaitingEntry[] | null>(null)
  const [identifying, setIdentifying] = useState(false)
  const [links, setLinks] = useState<{ name: string; label: string; url: string }[]>([])
  const [role, setRole] = useState('all')
  const [q, setQ] = useState('')
  // ?item=<id> opens that item (the gateway's "Waiting for you" list links here, sy-vdi8); only an id of the board's pattern
  const itemOfUrl = () => {
    const id = new URLSearchParams(window.location.search).get('item') || ''
    return /^[a-z]+-[a-z0-9]+(\.[0-9]+)*$/.test(id) ? id : null
  }
  const [openId, setOpenRaw] = useState<string | null>(itemOfUrl)
  // the open item is in the address (sy-uxo3, the owner: "the link should be on the url"): opening one from the board adds
  // a history entry (?item=<id>; Back closes it, Forward opens it again); opening another from inside an item replaces
  // that entry; closing goes back when we added it, else drops ?item= in place (a link opened the board on an item)
  const urlFor = (id: string | null) => {
    const s = new URLSearchParams(window.location.search)
    if (id) s.set('item', id); else s.delete('item')
    const qs = s.toString()
    return window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
  }
  const setOpenId = (id: string | null) => {
    const cur = itemOfUrl()
    if (id === cur) { setOpenRaw(id); return }
    if (id && cur) window.history.replaceState({ mmItem: true }, '', urlFor(id))
    else if (id) window.history.pushState({ mmItem: true }, '', urlFor(id))
    else if (window.history.state?.mmItem) { window.history.back(); return } // popstate sets it
    else window.history.replaceState(null, '', urlFor(null))
    setOpenRaw(id)
  }
  useEffect(() => {
    const onPop = () => setOpenRaw(itemOfUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const [creating, setCreating] = useState(false)
  const [meta, setMeta] = useState<Meta>(EMPTY_META)
  const presence = usePresenceFeed()
  const [hash, setHash] = useState(() => window.location.hash)
  // the human's views (For you first) only when the gateway says who this is; the leads' local side as before
  const human = idSource === 'gateway'
  const hview = humanViewOf(hash)
  const view = human ? (hview === 'foryou' ? 'board' : hview) : viewOf(hash)
  const [, setNow] = useState(0) // re-render each poll so "waiting 3m" ages
  const [tick, setTick] = useState(0) // bumps when anything changes, so an open detail reloads
  const search = useRef<HTMLInputElement>(null)
  // Phones (sy-81dm): one column at a time, its tabs on top; Now and Activity cover the board behind one tap.
  const phone = usePhone()
  const [col, setCol] = useState<ColumnKey>('ready')
  // The phone's bar lies over the list and slides away on scroll down, back on scroll up (sy-hrsm): a transform, so the
  // list never moves under the thumb.
  const [barHidden, setBarHidden] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const lastY = useRef(0)
  const onMainScroll = (e: React.UIEvent<HTMLElement>) => {
    const y = e.currentTarget.scrollTop, d = y - lastY.current
    lastY.current = y
    if (y < 48) setBarHidden(false)
    else if (d > 4) setBarHidden(true)
    else if (d < -4) setBarHidden(false)
  }
  // Now and Activity are closed by default at every width; the toolbar's toggle opens them (sy-p88g). On a desktop (xl)
  // they dock beside the board and the choice is remembered in this browser; below xl they open as a drawer over the
  // columns, below the toolbar so the toggle stays in reach (sy-l6t1), and close on Escape or a tap outside.
  const desk = useDesk()
  const [docked, setDocked] = useState(() => localStorage.getItem('board-side') === '1')
  const [drawer, setDrawer] = useState(false)
  const side = desk ? docked : drawer
  const [folded, setFolded] = useState(() => localStorage.getItem('board-roles-folded') === '1')
  const toggleFolded = () => setFolded((f) => { localStorage.setItem('board-roles-folded', f ? '0' : '1'); return !f })
  const sideBtn = useRef<HTMLButtonElement>(null)
  const sidePanel = useRef<HTMLElement>(null)
  const setSide = useCallback((open: boolean) => {
    if (desk) { localStorage.setItem('board-side', open ? '1' : '0'); setDocked(open) } else setDrawer(open)
  }, [desk])
  const closeSide = useCallback((refocus = true) => { setSide(false); if (refocus) sideBtn.current?.focus() }, [setSide])
  useEffect(() => { if (drawer && !desk) sidePanel.current?.focus() }, [drawer, desk])
  useEffect(() => {
    if (desk || !side || openId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeSide() } }
    // a tap outside (the toolbar, the epics) closes it too; the scrim over the columns closes it on its own click
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!sidePanel.current?.contains(t) && !sideBtn.current?.contains(t) && !(t as HTMLElement).closest?.('[data-side-scrim]')) closeSide(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
  }, [desk, side, openId, closeSide])
  const openFromSide = (id: string) => { if (!desk) closeSide(false); setOpenId(id) }

  const load = useCallback(async () => {
    try {
      // items first: never hold the board back for agents/personas (meta fills in when it arrives)
      api.meta().then((m) => { setRoleDefs(m.roles, !!m.setup, m.lead); setMeta(m) }).catch(() => {})
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
    api.whoami().then((w) => { setActor(w.actor); setIdSource(w.source); setMe({ approval: w.approval, home: w.home, role: w.role }); if (w.source === 'default') setIdentifying(true) }).catch(() => {})
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
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => { if (meta.project) document.title = `${meta.project} · work board` }, [meta.project])

  // what waits on the signed-in person (For you's count and its Needs you), again on every change of the board
  useEffect(() => {
    if (!human) return
    let gone = false
    api.waiting().then((d) => !gone && setWaiting(d.items)).catch(() => !gone && setWaiting((w) => w ?? []))
    return () => { gone = true }
  }, [human, tick])

  // Lead status changes in Paseo, not in Beads, so poll it.
  useEffect(() => {
    const t = window.setInterval(() => { api.meta().then((m) => { setRoleDefs(m.roles, !!m.setup, m.lead); setMeta(m) }).catch(() => {}); setNow(Date.now()) }, 5000)
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
  // the links a hovered (or long-pressed) card marks come from this list: no fetch per hover (sy-x7kh)
  useEffect(() => setLinkGraph(issues), [issues])
  // a long press marks until the next tap anywhere, Escape, or another view
  useEffect(() => {
    const off = (e: Event) => { if (linksPinned() && !(e.target as HTMLElement).closest?.('[data-card]')) clearLinks() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') clearLinks() }
    document.addEventListener('pointerdown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', esc) }
  }, [])
  useEffect(() => clearLinks(), [view, col, openId])
  const epics = useMemo(() => issues.filter((i) => i.issue_type === 'epic' && i.status !== 'closed'), [issues])
  const work = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return issues.filter((i) => i.issue_type !== 'epic' && i.assignee !== 'setup' && !(i.labels || []).includes('governance') && (!needle ||
      i.id.toLowerCase().includes(needle) || i.title.toLowerCase().includes(needle)))
  }, [issues, q])

  // Waiting counts only the real waits: an item that waits only for its rollout ships with it (sy-7n3c), counted apart
  const [counts, shipping] = useMemo(() => {
    const c: Record<ColumnKey, number> = { ready: 0, waiting: 0, progress: 0, done: 0 }
    let s = 0
    work.filter((i) => role === 'all' || roleOf(i) === role).forEach((i) => {
      const k = columnOf(i, ready)
      if (k === 'waiting' && shipsWith(i, byId)) s++
      else c[k]++
    })
    return [c, s] as const
  }, [work, ready, role, byId])

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
    <div className="relative flex h-svh flex-col overflow-hidden border-t-4 border-foreground bg-background text-foreground">
      {/* One line (sy-p88g): the project, its views, the goal chip; the column counts only on wide screens (the
          column heads and the phone's tabs show them anyway), who is working, live, and who you are. */}
      {human ? (
        <HumanBar project={meta.project} view={hview} needs={waiting?.length ?? 0} panels={meta.panels || []} links={links}
          role={role} onRole={setRole} q={q} onQ={setQ} search={search} epics={epics} issues={issues} onOpenItem={setOpenId}
          live={live} actor={actor} home={me.home} onNew={() => setCreating(true)} nowCount={presence.length} onNow={() => setSide(true)} />
      ) : phone ? (
        <PhoneBar project={meta.project} view={view} panels={meta.panels || []} links={links} col={col} counts={counts} onCol={(c) => { setCol(c); setBarHidden(false); mainRef.current?.scrollTo(0, 0) }}
          role={role} onRole={setRole} q={q} onQ={setQ} search={search} epics={epics} issues={issues} onOpenItem={setOpenId}
          live={live} actor={actor} idSource={idSource} onIdentify={() => setIdentifying(true)} onNew={() => setCreating(true)}
          nowCount={presence.length} onNow={() => setSide(true)} hidden={barHidden} />
      ) : (
      <header className="flex h-11 shrink-0 items-center gap-x-4 border-b border-foreground px-6">
        <h1 className="flex min-w-0 shrink-0 items-center text-xl leading-none font-bold tracking-tight [overflow-wrap:anywhere]">
          {meta.project || '…'}
        </h1>
        <nav className="flex shrink-0 flex-wrap gap-x-4 text-[13px] font-semibold">
          {(['board', 'leads', ...(meta.panels?.includes('machine') ? ['machine' as const] : []), 'glossary'] as const).map((v) => (
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
        {view === 'board' && <Goals epics={epics} issues={issues} onOpen={setOpenId} />}
        <div className="ml-auto flex shrink-0 items-center gap-4">
          {view === 'board' && (
            <dl className="hidden gap-x-4 text-xs 2xl:flex">
              {COLUMNS.map((c) => (
                <div key={c.key} title={c.hint} className="flex items-baseline gap-1.5">
                  <dt className="text-muted-foreground">{c.label}</dt>
                  <dd className="font-bold tabular-nums">{counts[c.key]}</dd>
                  {c.key === 'waiting' && shipping > 0 && <dd className="text-muted-foreground tabular-nums" title="Landed, waits only for its rollout">+{shipping} ship</dd>}
                </div>
              ))}
            </dl>
          )}
          <PresenceBar />
          <span className={cn('size-2.5 shrink-0', live ? 'bg-swiss' : 'border border-muted-foreground')} title={live ? 'Live updates on' : 'Live updates off'} />
          <button type="button" className="text-xs hover:underline" disabled={idSource === 'gateway'}
            title={idSource === 'gateway' ? 'Your name comes from your sign-in' : 'Change who you are'}
            onClick={() => setIdentifying(true)}>
            <b>{actor || '…'}</b>{idSource === 'default' && <span className="text-swiss"> · who are you?</span>}
          </button>
        </div>
      </header>
      )}

      {human && hview === 'foryou' ? (
        <main className="min-h-0 flex-1 overflow-auto">
          <ForYou waiting={waiting} owner={me.role === 'owner'} approval={me.approval} storeKey={`${meta.project || 'board'}:${actor}`} tick={tick}
            onOpen={setOpenId} onChanged={load} />
        </main>
      ) : view === 'glossary' ? <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading…</div>}><Glossary /></Suspense> : view === 'machine' ? <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading…</div>}><Machine /></Suspense> : view === 'leads' ? <Suspense fallback={<div className="p-6 text-xs text-muted-foreground">Loading…</div>}><Leads onOpen={setOpenId} raci={meta.raci ?? null} items={issues.filter((i) => i.assignee === 'setup' || (i.labels || []).includes('governance'))} /></Suspense> : (<>
      {/* The toolbar from md up; on a phone the bar's menu holds the same controls (sy-hrsm). */}
      {/* the human's board (sy-c7mh): no toolbar (the menu holds it); a filter in force says so, with Clear; on a phone
          the column tabs sit on top of the list */}
      {human && (role !== 'all' || q.trim()) && (
        <p data-filter-line className="flex shrink-0 items-center gap-2 border-b px-4 py-1 text-[13px] md:px-6">
          <span className="min-w-0 truncate">Showing {[role !== 'all' && ROLE_LABEL[role], q.trim() && `“${q.trim()}”`].filter(Boolean).join(' · ')}</span>
          <button type="button" onClick={() => { setRole('all'); setQ('') }} className="min-h-10 px-2 font-semibold hover:underline">Clear</button>
        </p>
      )}
      {human && phone && (
        <div role="tablist" aria-label="Columns" className="grid shrink-0 grid-cols-4 border-b">
          {COLUMNS.map((c) => (
            <button key={c.key} role="tab" aria-selected={col === c.key} onClick={() => { setCol(c.key); mainRef.current?.scrollTo(0, 0) }}
              className={cn('min-h-11 border-b-2 text-[13px] font-semibold', col === c.key ? 'border-foreground' : 'border-transparent text-muted-foreground')}>{c.label}</button>
          ))}
        </div>
      )}
      {!phone && !human && <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-6 py-1.5">
        <ToggleGroup type="single" value={role} onValueChange={(v) => v && setRole(v)} variant="outline" size="sm" spacing={0}>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          {ROLES.map((r) => <ToggleGroupItem key={r} value={r}>{ROLE_LABEL[r]}</ToggleGroupItem>)}
        </ToggleGroup>
        <Input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
          className="h-7 w-48" />
        <button type="button" ref={sideBtn} aria-expanded={side} aria-controls="board-side" onClick={() => (side ? closeSide() : setSide(true))}
          title={side ? 'Hide now and recent activity' : 'Show now and recent activity'}
          className={cn('ml-auto inline-flex h-7 items-center gap-1.5 border px-2.5 text-xs font-semibold', side ? 'border-foreground bg-foreground text-background' : 'border-input hover:border-foreground')}>
          Now <span className={cn('min-w-4 px-1 text-center tabular-nums', presence.length ? 'bg-swiss text-white' : 'bg-muted text-muted-foreground', side && !presence.length && 'bg-background/20 text-background')}>{presence.length}</span>
          <span aria-hidden className={side ? 'opacity-60' : 'text-muted-foreground'}>·</span> Activity
        </button>
        <Button size="sm" title="New item (N)" onClick={() => setCreating(true)}><PlusIcon weight="bold" />New</Button>
      </div>}

      <div className={cn('relative grid min-h-0 flex-1 grid-rows-1', side && 'xl:grid-cols-[minmax(0,1fr)_20rem]')}>
        <main ref={mainRef} onScroll={phone && !human ? onMainScroll : undefined} className="min-h-0 min-w-0 overflow-auto">
          {phone ? <PhoneBoard top={!human} rows={rows} work={work} ready={ready} byId={byId} meta={meta} col={col} onOpen={setOpenId} /> : (
          <div className={cn('grid min-w-[760px]', folded ? 'grid-cols-[3rem_repeat(4,minmax(0,1fr))]' : 'grid-cols-[8.5rem_repeat(4,minmax(0,1fr))]')}>
            <div className="sticky top-0 z-10 flex items-stretch border-b border-foreground bg-background">
              <button type="button" onClick={toggleFolded} aria-pressed={folded}
                aria-label={folded ? 'Unfold the role column' : 'Fold the role column'} title={folded ? 'Show the roles' : 'Fold the roles to their avatars'}
                className="flex flex-1 items-center gap-1 px-3 text-[11px] font-bold tracking-[0.1em] text-muted-foreground uppercase hover:text-foreground">
                {folded ? <CaretRightIcon weight="bold" className="size-3" /> : <><CaretLeftIcon weight="bold" className="size-3" />Roles</>}
              </button>
            </div>
            {COLUMNS.map((c) => (
              <div key={c.key} className="sticky top-0 z-10 flex items-baseline justify-between border-b border-l border-b-foreground bg-background px-3 py-2">
                <span className="text-[11px] font-bold tracking-[0.1em] uppercase">{c.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums" data-count={c.key}>
                  {counts[c.key]}{c.key === 'waiting' && shipping > 0 && <span data-ships-count={shipping} title="Landed, waits only for its rollout"> · {shipping} ship next</span>}
                </span>
              </div>
            ))}
            {rows.map((r) => (
              <Row key={r || 'none'} role={r} folded={folded} items={work.filter((i) => roleOf(i) === r)} ready={ready} byId={byId}
                meta={meta} onOpen={setOpenId} onMove={move} />
            ))}
          </div>)}
        </main>

        {side && !desk && <div aria-hidden data-side-scrim onClick={() => closeSide()} className="absolute inset-0 z-40 hidden bg-foreground/25 md:block" />}
        <aside id="board-side" ref={sidePanel} tabIndex={-1} aria-label="Now and activity"
          className={cn('min-h-0 flex-col border-t outline-none',
            'max-md:absolute max-md:inset-0 max-md:z-50 max-md:border-t-0 max-md:bg-background',
            'md:absolute md:inset-y-0 md:right-0 md:z-50 md:w-80 md:max-w-[85vw] md:border-t-0 md:border-l md:border-foreground md:bg-background md:shadow-2xl',
            side ? 'flex' : 'hidden',
            'xl:static xl:z-auto xl:w-auto xl:max-w-none xl:border-border xl:shadow-none')}>
          <div className="flex shrink-0 items-center justify-between border-b px-4 md:hidden">
            <span className="text-[11px] font-bold tracking-[0.1em] uppercase">Now and activity</span>
            <button type="button" onClick={() => closeSide()} className="-mr-2 min-h-11 px-3 text-sm font-semibold hover:underline">Close</button>
          </div>
          <NowStrip onOpen={openFromSide} />
          <h2 className="shrink-0 border-b border-foreground px-4 py-2 text-[11px] font-bold tracking-[0.1em] uppercase">Activity</h2>
          <ol className="min-h-0 flex-1 overflow-y-auto">
            {events.length === 0 && <li className="px-4 py-3 text-xs text-muted-foreground">No events yet.</li>}
            {events.map((ev) => (
              <li key={ev.seq}>
                <button onClick={() => openFromSide(ev.issue_id)} className="grid w-full grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 border-b px-4 py-2 text-left hover:bg-muted max-md:py-3">
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

      {openId && <Suspense fallback={null}><Detail id={openId} tick={tick} byId={byId} creator={meta.creators[openId]} onClose={() => setOpenId(null)} onOpen={setOpenId} onChanged={load} /></Suspense>}
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
// in a column, the real waits before what only waits for its rollout (sy-7n3c); each by priority
const waitsFirst = (byId: Map<string, Issue>) => (a: Issue, b: Issue) => Number(!!shipsWith(a, byId)) - Number(!!shipsWith(b, byId)) || byPriority(a, b)

/** The board on a phone: one column at a time (the bar's picker chooses it, sy-hrsm), as a list grouped by role (each
 *  with its lead's state). It starts under the bar (48px), which lies over it. */
function PhoneBoard({ top, rows, work, ready, byId, meta, col, onOpen }: {
  top: boolean; rows: string[]; work: Issue[]; ready: Set<string>; byId: Map<string, Issue>; meta: Meta; col: ColumnKey; onOpen: (id: string) => void
}) {
  const inCol = work.filter((i) => columnOf(i, ready) === col)
  const groups = rows.map((r) => {
    const items = inCol.filter((i) => roleOf(i) === r)
    return { role: r, items: col === 'done' ? items.sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || '')).slice(0, 8) : items.sort(waitsFirst(byId)) }
  }).filter((g) => g.items.length)
  return (
    <div className={cn('min-w-0', top && 'pt-12')}>
      {groups.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">Nothing here.</p>}
      {groups.map((g) => {
        const st = (g.role && meta.states?.[g.role]) || LEAD_READY
        const p = g.role ? personaOf(meta.personas ?? null, g.role) : null
        return (
          <section key={g.role || 'none'} className="border-b">
            <h2 className="flex min-h-10 items-center gap-2 bg-muted/40 px-4 py-1.5 text-[13px]">
              {g.role && <Avatar actor={g.role} size="sm" />}
              <b className="min-w-0 truncate" style={{ color: p?.color }}>{p?.name || ROLE_LABEL[g.role]}</b>
              {g.role && p?.name && p.name !== `${p.roleTitle} lead` && <span className="min-w-0 shrink-[2] truncate text-[11px] text-muted-foreground">{ROLE_LABEL[g.role]}</span>}
              {g.role && (
                <span className={cn('ml-auto flex min-w-0 shrink-[2] items-center gap-1.5 text-[11px] text-muted-foreground', ['waiting', 'blocked', 'error'].includes(st.state) && 'font-semibold text-swiss')}>
                  <span className={cn('size-2 shrink-0', LEAD_DOT[st.state])} /><span className="truncate">{st.label}</span>
                </span>
              )}
            </h2>
            <div className="grid gap-2 p-2">
              {g.items.map((i) => <Card key={i.id} issue={i} col={col} waitsOn={blockers(i, byId)} ships={shipsWith(i, byId)} last={meta.last[i.id]} onOpen={onOpen}
                worker={meta.leads._workers?.find((w) => w.item === i.id)} />)}
            </div>
          </section>
        )
      })}
    </div>
  )
}


function Row({ role, folded, items, ready, byId, meta, onOpen, onMove }: {
  role: string; folded: boolean; items: Issue[]; ready: Set<string>; byId: Map<string, Issue>; meta: Meta
  onOpen: (id: string) => void; onMove: MoveFn
}) {
  const lead = role ? meta.leads[role] : null
  const st = (role && meta.states?.[role]) || LEAD_READY
  const cells = COLUMNS.map((c) => {
    let cell = items.filter((i) => columnOf(i, ready) === c.key)
    cell = c.key === 'done'
      ? cell.sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || '')).slice(0, 8)
      : cell.sort(waitsFirst(byId))
    return <Cell key={c.key} col={c.key} role={role} items={cell} byId={byId} meta={meta} onOpen={onOpen} onMove={onMove} />
  })
  // Folded (sy-p88g): the avatar and the lead's state dot; the name and the state in its tooltip.
  if (folded) {
    const p = role ? personaOf(meta.personas ?? null, role) : null
    return (
      <>
        <div className="flex flex-col items-center gap-1.5 border-b py-2.5" title={role ? `${p?.name ? `${p.name} · ` : ''}${ROLE_LABEL[role]} · ${st.label}` : ROLE_LABEL[role]}>
          {role ? <Avatar actor={role} size="md" /> : <span className="text-[11px] font-bold text-muted-foreground">—</span>}
          {role && (st.item
            ? <button aria-label={st.label} onClick={() => onOpen(st.item!)} className={cn('size-2 shrink-0', LEAD_DOT[st.state])} />
            : <span className={cn('size-2 shrink-0', LEAD_DOT[st.state])} />)}
        </div>
        {cells}
      </>
    )
  }
  return (
    <>
      <div className="min-w-0 border-b px-3 py-2.5">
        {role ? (() => { const p = personaOf(meta.personas ?? null, role); return (
          <div className="flex items-center gap-2">
            <Avatar actor={role} size="md" />
            <div className="min-w-0 leading-tight">
              <div className="text-[13px] font-bold [overflow-wrap:anywhere]" style={{ color: p?.color }}>{p?.name}</div>
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
      {cells}
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
      {items.map((i) => <Card key={i.id} issue={i} col={col} waitsOn={blockers(i, byId)} ships={shipsWith(i, byId)} last={meta.last[i.id]} onOpen={onOpen}
        worker={meta.leads._workers?.find((w) => w.item === i.id)} />)}
    </div>
  )
}

function Card({ issue: i, col, waitsOn, ships = null, last, onOpen, worker }: {
  issue: Issue; col: ColumnKey; waitsOn: string[]; ships?: string[] | null; last?: Meta['last'][string]; onOpen: (id: string) => void
  worker?: { id: string; status: string }
}) {
  const closed = i.status === 'closed'
  const role = roleOf(i)
  const fromLead = !!last && (ROLES as readonly string[]).includes(last.author)
  // Who owes the next move on the thread.
  const awaitingLead = !closed && !!role && !!last && !fromLead
  // waiting only for its rollout (ships) is not a block: it shows "Ships with <id>", never "blocked" (sy-7n3c)
  const blocked = i.status === 'blocked' && !ships
  const needsYou = !closed && fromLead && (blocked || (i.labels || []).includes('needs-you'))
  const waitedMin = (Date.now() - new Date(i.updated_at).getTime()) / 60000
  // its links (sy-x7kh): the mouse over it, or a long press on a phone (a tap still opens it)
  const phone = usePhone()
  const rel = useLinkRel(i.id), marked = useMarked()
  const [notShown, setNotShown] = useState(0)
  useEffect(() => { if (rel === 'self') setNotShown(linksNotShown(i.id)) }, [rel, i.id])
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null)
  const endPress = () => { if (press.current) window.clearTimeout(press.current.timer) }
  return (
    <button
      data-card={i.id}
      data-link={rel || undefined}
      draggable={!phone}
      onDragStart={(e) => { clearLinks(); e.dataTransfer.setData('text/plain', i.id) }}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverLinks(i.id) }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverLinks(null) }}
      onTouchStart={(e) => {
        endPress()
        const t = e.touches[0]
        const p = { x: t.clientX, y: t.clientY, fired: false, timer: 0 }
        p.timer = window.setTimeout(() => { p.fired = true; pinLinks(i.id); navigator.vibrate?.(10) }, LONG_PRESS_MS)
        press.current = p
      }}
      onTouchMove={(e) => { const p = press.current, t = e.touches[0]; if (p && Math.hypot(t.clientX - p.x, t.clientY - p.y) > 10) endPress() }}
      onTouchEnd={(e) => { endPress(); if (press.current?.fired) e.preventDefault() }}
      onTouchCancel={endPress}
      onContextMenu={(e) => { if (press.current?.fired || phone) e.preventDefault() }}
      onClick={() => {
        if (press.current?.fired) { press.current = null; return } // the long press's own click: the marks stay
        clearLinks(); onOpen(i.id)
      }}
      className={cn('relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 border border-border bg-card px-2 py-1.5 text-left hover:border-foreground max-md:px-3 max-md:py-2.5 max-md:select-none max-md:[-webkit-touch-callout:none]',
        i.priority === 0 && !closed && 'border-l-4 border-l-swiss', closed && 'opacity-55')}
    >
      {/* the tags lie over the card: marking never moves a card, so the mouse never slips off the one it marks */}
      {marked && REL_TAG[rel] && <span data-link-tag={rel} className="link-tag pointer-events-none absolute top-0 right-0 z-[1] px-1.5 py-0.5 text-[11px] leading-none font-semibold">{REL_TAG[rel]} {marked}</span>}
      {rel === 'self' && notShown > 0 && <span data-links-hidden={notShown} className="pointer-events-none absolute right-0 bottom-0 z-[1] border border-foreground bg-background px-1.5 py-0.5 text-[11px] leading-none font-semibold">+{notShown} linked, not shown</span>}
      <span className="flex items-center gap-2 text-[11px]">
        {roleOf(i) && <Avatar actor={roleOf(i)} size="xs" />}
        <span className="font-mono text-muted-foreground">{i.id}</span>
        <span className={cn('font-bold tabular-nums', i.priority === 0 && 'text-swiss')}>P{i.priority}</span>
        <span className="text-muted-foreground">{i.issue_type}</span>
        {worker && <span className="ml-auto flex items-center gap-1 font-semibold text-swiss" title={`Worker ${worker.id}: ${worker.status}`}>
          <span className={cn('size-1.5 bg-swiss', worker.status === 'running' && 'animate-pulse')} />worker</span>}
        {blocked && <span className={cn('font-semibold uppercase', !worker && 'ml-auto')}>blocked</span>}
        {i.status === 'deferred' && <span className="ml-auto font-semibold uppercase">deferred</span>}
      </span>
      <span className={cn('text-[13px] leading-snug font-medium [overflow-wrap:anywhere] max-md:text-[15px]', closed && 'line-through')}>{i.title}</span>
      {ships && (
        <span data-ships={ships.join(' ')} title="Landed: waits only for its rollout"
          className="justify-self-start border border-foreground/40 px-1.5 py-0.5 text-[11px] leading-none font-semibold [overflow-wrap:anywhere]">
          Ships with <span className="font-mono">{ships.join(', ')}</span>
        </span>
      )}
      {((waitsOn.length > 0 && !ships) || !!i.comment_count || col === 'ready') && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {col === 'ready' && (
            <span className={cn(waitedMin > SLOW_MIN && 'font-semibold text-swiss')} title="Waiting for pickup">
              waiting {ago(i.updated_at)}
            </span>
          )}
          {waitsOn.length > 0 && !ships && <span className="flex items-center gap-1"><LinkSimpleIcon />waits on {waitsOn.join(', ')}</span>}
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
