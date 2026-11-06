// The Flow panel (sy-6h43): this board's flow per role, the numbers of `mm obs flow` from the same series (the board
// server reads them from the metrics store; site/flow-rows.mjs). Each speed number sits next to its quality pair (PAIRS).
import { useContext, useEffect, useState } from 'react'
import { ROLE_LABEL } from '@/lib/board'
import { cn } from '@/lib/utils'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'

interface FlowRow {
  project: string; role: string; window: string; done: number
  queue_p50: number | null; queue_p95: number | null; first_pass: number | null; reviewed: number
  cycle_p50: number | null; cycle_p95: number | null; paused_p50: number | null; reopened: number; escaped: number
  handoff_p50: number | null; handoff_p95: number | null
  wip: number | null; capacity: number | null; leases_expired: number; needs_you: number; needs_you_max: number | null
}
interface FlowRange { project: string; first_seq: number | null; last_seq: number | null; first: string | null; last: string | null }
interface FlowData { available: boolean; why?: string; at?: string; rows?: FlowRow[]; events?: FlowRange[]; pairs: Record<string, string[]> }

/** 3700 -> "1h01m"; null -> "-" (as `mm obs flow`). */
function dur(sec: number | null) {
  if (sec === null) return '-'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86400)}d${String(Math.floor((s % 86400) / 3600)).padStart(2, '0')}h`
}
const SPEED: Record<string, { label: string; hint: string }> = {
  queue: { label: 'Queue wait', hint: 'ready -> claimed, without the needs-you and approval waits' },
  cycle: { label: 'Cycle time', hint: 'claimed -> done, without every wait on a human or a sign-off' },
  handoff: { label: 'Handoff wait', hint: 'a handover to the role -> its first move on the item' },
}
function quality(k: string, r: FlowRow) {
  if (k === 'first_pass') return { label: 'first pass', value: r.first_pass === null ? '-' : `${Math.round(r.first_pass * 100)}% of ${r.reviewed}`, bad: r.first_pass !== null && r.first_pass < 1 }
  if (k === 'reopened') return { label: 'reopened', value: String(r.reopened), bad: r.reopened > 0 }
  if (k === 'escaped') return { label: 'escaped', value: String(r.escaped), bad: r.escaped > 0 }
  return { label: k, value: '-', bad: false }
}
const utc = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '?')

export function Flow() {
  const [d, setD] = useState<FlowData | null>(null)
  const [err, setErr] = useState('')
  const [win, setWin] = useState<'24h' | '7d'>('24h')
  const personas = useContext(PersonaContext)
  useEffect(() => {
    let stop = false
    const load = () => fetch('/api/flow').then((r) => r.json()).then((j) => { if (!stop) { setD(j); setErr('') } }).catch((e) => !stop && setErr((e as Error).message))
    load(); const t = window.setInterval(load, 60000)
    return () => { stop = true; window.clearInterval(t) }
  }, [])
  const rows = (d?.rows || []).filter((r) => r.window === win)
  const ev = d?.events?.[0]
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 md:px-6">
        <div className="flex border border-foreground text-[11px] font-semibold" role="group" aria-label="Window">
          {(['24h', '7d'] as const).map((w) => (
            <button key={w} onClick={() => setWin(w)} aria-pressed={win === w}
              className={cn('px-3 py-1', win === w ? 'bg-foreground text-background' : 'hover:bg-muted')}>{w === '24h' ? 'Last 24 h' : 'Last 7 d'}</button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">p50 / p95 per role. The same numbers as <code className="font-mono">mm obs flow</code>; each speed sits next to its quality pair.</span>
      </div>
      {!d && <p className="px-6 py-3 text-xs text-muted-foreground">{err ? `Unavailable: ${err}` : 'Loading…'}</p>}
      {d && !d.available && <p className="px-6 py-3 text-xs text-muted-foreground">Flow unavailable: {d.why}</p>}
      {d?.available && !rows.length && <p className="px-6 py-3 text-xs text-muted-foreground">No flow samples in the last 7 days. bin/flow sends them every 5 min (mm cron).</p>}
      {rows.map((r) => (
        <section key={r.role} className="grid gap-x-4 border-b px-4 py-3 md:grid-cols-[11rem_1fr] md:px-6">
          <div className="mb-2 flex items-center gap-2 md:mb-0 md:items-start">
            <Avatar actor={r.role} size="sm" />
            <span className="min-w-0 leading-tight"><span className="block truncate text-[13px] font-bold">{personaOf(personas, r.role)?.name || r.role}</span>
              <span className="block text-[11px] text-muted-foreground">{r.role === 'setup' ? 'Setup agent' : ROLE_LABEL[r.role] || r.role}</span></span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 2xl:grid-cols-6">
            {Object.entries(d!.pairs).map(([k, qs]) => (
              <div key={k} className="min-w-0 border-t border-foreground pt-1" title={SPEED[k]?.hint}>
                <dt className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{SPEED[k]?.label || k}</dt>
                <dd className="text-[15px] font-bold tabular-nums">{dur(r[`${k}_p50` as keyof FlowRow] as number | null)} <span className="font-normal text-muted-foreground">/ {dur(r[`${k}_p95` as keyof FlowRow] as number | null)}</span></dd>
                {qs.map((q) => { const x = quality(q, r); return <dd key={q} className={cn('text-[11px] tabular-nums', x.bad ? 'font-semibold text-swiss' : 'text-muted-foreground')}>{x.label} {x.value}</dd> })}
              </div>
            ))}
            <div className="min-w-0 border-t border-foreground pt-1" title="Items waiting on the human now (needs-you; the clock pauses while a t2 waits for the owner)">
              <dt className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Needs you</dt>
              <dd className={cn('text-[15px] font-bold tabular-nums', r.needs_you > 0 && 'text-swiss')}>{r.needs_you}</dd>
              <dd className="text-[11px] text-muted-foreground tabular-nums">{r.needs_you ? `oldest ${dur(r.needs_you_max)}` : 'none waiting'}</dd>
            </div>
            <div className="min-w-0 border-t border-foreground pt-1">
              <dt className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Done</dt>
              <dd className="text-[15px] font-bold tabular-nums">{r.done}</dd>
              <dd className="text-[11px] text-muted-foreground tabular-nums">paused p50 {dur(r.paused_p50)}</dd>
            </div>
            <div className="min-w-0 border-t border-foreground pt-1" title="In progress now against capacity, and the claims wake requeued in this window">
              <dt className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">WIP</dt>
              <dd className="text-[15px] font-bold tabular-nums">{r.wip ?? '-'}<span className="font-normal text-muted-foreground"> / {r.capacity ?? '-'}</span></dd>
              <dd className={cn('text-[11px] tabular-nums', r.leases_expired ? 'font-semibold text-swiss' : 'text-muted-foreground')}>leases expired {r.leases_expired}</dd>
            </div>
          </dl>
        </section>
      ))}
      {d?.available && (
        <p className="px-4 py-2 text-[11px] text-muted-foreground md:px-6">
          {ev ? <>From the board's events seq {ev.first_seq ?? '?'}..{ev.last_seq ?? '?'} ({utc(ev.first)} to {utc(ev.last)}).</> : 'No event range sent yet.'} Read {utc(d.at || null)}.
          {err && <span className="text-swiss"> Last refresh failed: {err}</span>}
        </p>
      )}
    </div>
  )
}
