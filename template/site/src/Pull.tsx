// The pull model on the Leads page (sy-6h43): per role its queue, its work in progress against its capacity, each claim's
// lease and its workers, from the board server's /api/pull (site/pull-state.mjs). Read-only: viewers see all of it.
import { useContext, useEffect, useState } from 'react'
import { ROLE_LABEL } from '@/lib/board'
import { cn } from '@/lib/utils'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'

export interface QueueItem { id: string; title: string; priority: number | null; updated_at: string | null; wait_s: number; requeued?: { at: string; n: number | null; of: number | null } }
export interface Claim { id: string; title: string; priority: number | null; assignee: string; updated_at: string | null; age_s: number; lease: 'ok' | 'near' | 'over'; left_s: number | null }
export interface Worker { id: string; name: string | null; status: string; item: string | null }
export interface RolePull { role: string; capacity: number | null; wip: number; claims: Claim[]; queue: QueueItem[]; requeued: number; workers: Worker[] }
export interface PullData { at: string; roles: RolePull[] }

/** The board's pull state, polled every 10 s (the server keeps it 3 s). */
export function usePull() {
  const [d, setD] = useState<PullData | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let stop = false
    const load = () => fetch('/api/pull').then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.title || `${r.status}`); if (!stop) { setD(j); setErr('') } })
      .catch((e) => !stop && setErr((e as Error).message))
    load(); const t = window.setInterval(load, 10000)
    return () => { stop = true; window.clearInterval(t) }
  }, [])
  return { d, err }
}

/** 95 -> "1m", 3720 -> "1h02m": a short age. */
export function age(s: number) {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86400)}d${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`
}

const LEASE_NOTE = 'A claim lasts 30 min from its last update (any comment or change renews it). Then wake puts it back in the queue, unless the lead is in a turn.'
function Lease({ c }: { c: Claim }) {
  if (c.left_s === null) return <span className="text-muted-foreground">no lease</span>
  if (c.lease === 'over') return <span className="border border-amber-600 px-1 font-semibold text-amber-800 dark:text-amber-300" title={LEASE_NOTE}>lease over · requeues when the lead is idle</span>
  if (c.lease === 'near') return <span className="bg-amber-400 px-1 font-semibold text-black" title={LEASE_NOTE}>lease {age(c.left_s)} left</span>
  return <span className="text-muted-foreground" title={LEASE_NOTE}>lease {age(c.left_s)} left</span>
}
function Requeued({ q }: { q: QueueItem }) {
  if (!q.requeued) return null
  const r = q.requeued
  return <span className="bg-swiss px-1 font-semibold text-white" title={`wake requeued it at ${r.at.slice(11, 16)} UTC: in progress with no update for 30 min. The 3rd time it goes to the human.`}>
    requeued{r.n ? ` · expiry ${r.n} of ${r.of ?? 3}` : ''}</span>
}
const Prio = ({ p }: { p: number | null }) => <span className={cn('font-bold tabular-nums', p === 0 && 'text-swiss')}>P{p ?? '?'}</span>

/** "2 / 3": in progress against capacity; past it (a P0 may go one over) in red. */
export function Wip({ r, big }: { r: RolePull; big?: boolean }) {
  const over = r.capacity !== null && r.wip > r.capacity
  return (
    <span className={cn('font-bold tabular-nums', big ? 'text-2xl leading-none' : 'text-[13px]', over && 'text-swiss')}
      title={r.capacity === null ? 'In progress (setup has no capacity)' : `In progress: ${r.wip} of its capacity ${r.capacity} (roles.json)${over ? '; a P0 may go past it by one' : ''}`}>
      {r.wip}{r.capacity !== null && <span className="font-normal text-muted-foreground"> / {r.capacity}</span>}
    </span>
  )
}

function ClaimRow({ c, onOpen }: { c: Claim; onOpen: (id: string) => void }) {
  return (
    <li>
      <button onClick={() => onOpen(c.id)} className={cn('grid w-full grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-l-2 px-2 py-1 text-left text-xs hover:bg-muted',
        c.lease === 'ok' ? 'border-l-foreground' : 'border-l-amber-500')}>
        <span className="flex items-center gap-1.5 text-[11px]"><span className="font-mono text-muted-foreground">{c.id}</span><Prio p={c.priority} /></span>
        <span className="truncate">{c.title}</span>
        <span className="col-span-2 flex flex-wrap gap-x-3 text-[11px]">
          <span className="text-muted-foreground" title="Time since the item's last update">{c.updated_at ? `last update ${age(c.age_s)} ago` : 'no update time'}</span>
          {c.assignee.includes('/') && <span className="text-muted-foreground">by {c.assignee}</span>}
          <Lease c={c} />
        </span>
      </button>
    </li>
  )
}
function QueueRow({ q, i, onOpen }: { q: QueueItem; i: number; onOpen: (id: string) => void }) {
  return (
    <li>
      <button onClick={() => onOpen(q.id)} className={cn('grid w-full grid-cols-[1.25rem_auto_1fr] items-baseline gap-x-2 px-2 py-1 text-left text-xs hover:bg-muted', q.requeued && 'border-l-2 border-l-swiss')}>
        <span className="text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
        <span className="flex items-center gap-1.5 text-[11px]"><span className="font-mono text-muted-foreground">{q.id}</span><Prio p={q.priority} /></span>
        <span className="truncate">{q.title}</span>
        <span className="col-start-3 flex flex-wrap gap-x-3 text-[11px]">
          <span className="text-muted-foreground" title="Waiting since its last update">waits {age(q.wait_s)}</span>
          <Requeued q={q} />
        </span>
      </button>
    </li>
  )
}
function WorkerRow({ w, onOpen }: { w: Worker; onOpen: (id: string) => void }) {
  return (
    <li className="flex items-center gap-1.5 px-2 py-0.5 text-[11px]" title={`${w.name || 'worker'} (${w.id}): ${w.status}`}>
      <span className={cn('size-1.5 shrink-0', w.status === 'running' ? 'animate-pulse bg-swiss' : 'bg-foreground')} />
      <span className="font-mono">{w.id}</span>
      <span className="text-muted-foreground">{w.status}</span>
      {w.item ? <button className="font-mono hover:underline" onClick={() => onOpen(w.item!)}>on {w.item}</button> : <span className="text-muted-foreground">no item</span>}
    </li>
  )
}

const H = ({ children, n }: { children: React.ReactNode; n?: React.ReactNode }) => (
  <h4 className="flex items-baseline gap-2 border-b px-2 pt-2 pb-1 text-[11px] font-bold tracking-[0.08em] uppercase">{children}{n !== undefined && <span className="font-normal tracking-normal text-muted-foreground normal-case tabular-nums">{n}</span>}</h4>
)

/** One role's pull: its queue (all of it), its claims and its workers. */
export function RolePullView({ r, onOpen, limit }: { r: RolePull; onOpen: (id: string) => void; limit?: number }) {
  const q = limit ? r.queue.slice(0, limit) : r.queue
  return (
    <div className="grid gap-x-6 md:grid-cols-3">
      <div className="min-w-0">
        <H n={<>{r.queue.length} ready{r.requeued ? <span className="font-semibold text-swiss"> · {r.requeued} requeued</span> : null}</>}>Queue</H>
        <ol>{q.map((x, i) => <QueueRow key={x.id} q={x} i={i} onOpen={onOpen} />)}</ol>
        {r.queue.length > q.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">and {r.queue.length - q.length} more</p>}
        {!r.queue.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">Empty.</p>}
      </div>
      <div className="min-w-0">
        <H n={<Wip r={r} />}>In progress</H>
        <ol className="grid gap-1 pt-1">{r.claims.map((c) => <ClaimRow key={c.id} c={c} onOpen={onOpen} />)}</ol>
        {!r.claims.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">Nothing claimed.</p>}
      </div>
      <div className="min-w-0">
        <H n={r.workers.length}>Workers</H>
        <ul className="pt-1">{r.workers.map((w) => <WorkerRow key={w.id} w={w} onOpen={onOpen} />)}</ul>
        {!r.workers.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">None running.</p>}
      </div>
    </div>
  )
}

/** Every role at once: who it is, its WIP against capacity, then its queue head, claims and workers. */
export function PullOverview({ pull, err, onOpen }: { pull: PullData | null; err: string; onOpen: (id: string) => void }) {
  const personas = useContext(PersonaContext)
  if (!pull) return <p className="px-6 py-3 text-xs text-muted-foreground">{err ? `Unavailable: ${err}` : 'Loading…'}</p>
  return (
    <div>
      {pull.roles.map((r) => (
        <section key={r.role} className="grid gap-x-4 border-b px-4 py-3 md:grid-cols-[11rem_1fr] md:px-6">
          <div className="mb-2 flex items-center gap-2 md:mb-0 md:block">
            <div className="flex items-center gap-2">
              <Avatar actor={r.role} size="sm" />
              <span className="min-w-0 leading-tight"><span className="block truncate text-[13px] font-bold">{personaOf(personas, r.role)?.name || r.role}</span>
                <span className="block text-[11px] text-muted-foreground">{r.role === 'setup' ? 'Setup agent' : ROLE_LABEL[r.role] || r.role}</span></span>
            </div>
            <div className="ml-auto md:mt-2 md:ml-0"><Wip r={r} big /></div>
          </div>
          <RolePullView r={r} onOpen={onOpen} limit={3} />
        </section>
      ))}
      {err && <p className="px-6 py-2 text-[11px] text-swiss">Last refresh failed: {err}</p>}
    </div>
  )
}
