import { createContext, useContext, useEffect, useState } from 'react'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'
import { cn } from '@/lib/utils'

export interface Busy { actor: string; kind: 'lead' | 'worker'; id: string; item: string | null; doing: string }
export const PresenceContext = createContext<Busy[]>([])

/** Poll who is working right now (every 3 s). */
export function usePresenceFeed() {
  const [agents, setAgents] = useState<Busy[]>([])
  useEffect(() => {
    let gone = false
    const load = () => fetch('/api/presence').then((r) => r.json()).then((d) => !gone && setAgents(d.agents || [])).catch(() => {})
    load()
    const t = window.setInterval(load, 3000)
    return () => { gone = true; window.clearInterval(t) }
  }, [])
  return agents
}
export const useBusyOn = (item: string) => useContext(PresenceContext).filter((b) => b.item === item)

/** Three dots that bounce like a chat "typing…" indicator, in the agent's color. */
export function TypingDots({ color, className }: { color?: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-end gap-[3px]', className)} aria-hidden>
      {[0, 1, 2].map((i) => <span key={i} className="typing-dot size-[5px] rounded-full" style={{ background: color || 'currentColor', animationDelay: `${i * 0.16}s` }} />)}
    </span>
  )
}

function useLabel(b: Busy) {
  const p = personaOf(useContext(PersonaContext), b.actor)
  return { p, name: b.kind === 'worker' ? `${p?.name ?? 'A'}'s worker` : p?.name ?? b.actor }
}

/** Header: everyone working right now. */
export function PresenceBar() {
  const busy = useContext(PresenceContext)
  if (!busy.length) return <span className="text-[11px] text-muted-foreground">all quiet</span>
  return (
    <span className="flex items-center gap-2">
      <span className="flex -space-x-1.5">
        {busy.slice(0, 6).map((b) => <PresenceAvatar key={b.id} b={b} />)}
      </span>
      <span className="text-[11px] text-muted-foreground">{busy.length} working</span>
    </span>
  )
}
function PresenceAvatar({ b }: { b: Busy }) {
  const { p, name } = useLabel(b)
  return (
    <span className="presence-ring relative inline-flex ring-2 ring-background" style={{ ['--ring' as string]: p?.color }}
      title={`${name}${b.item ? ` · ${b.item}` : ''} · ${b.doing}`}>
      <Avatar actor={b.actor} size="sm" />
    </span>
  )
}

/** On a card: who is on this item right now. */
export function CardPresence({ item }: { item: string }) {
  const busy = useBusyOn(item)
  if (!busy.length) return null
  return <div className="grid min-w-0 gap-0.5">{busy.map((b) => <CardLine key={b.id} b={b} />)}</div>
}
function CardLine({ b }: { b: Busy }) {
  const { p, name } = useLabel(b)
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: p?.color }}>
      <Avatar actor={b.actor} size="xs" />
      <b className="min-w-0 shrink truncate">{name}</b>
      <TypingDots color={p?.color} />
      <span className="truncate text-muted-foreground">{b.doing}</span>
    </span>
  )
}

/** In the thread: a typing bubble above the reply box. */
export function ThreadPresence({ item }: { item: string }) {
  const busy = useBusyOn(item)
  if (!busy.length) return null
  return (
    <div className="mt-3 grid gap-2">
      {busy.map((b) => <Bubble key={b.id} b={b} />)}
    </div>
  )
}
function Bubble({ b }: { b: Busy }) {
  const { p, name } = useLabel(b)
  return (
    <div className="typing-in mr-16 flex items-center gap-2 border-l-2 py-1 pl-3" style={{ borderLeftColor: p?.color }}>
      <Avatar actor={b.actor} size="sm" />
      <span className="text-xs"><b style={{ color: p?.color }}>{name}</b> <span className="text-muted-foreground">is working on this</span></span>
      <span className="flex items-center gap-1.5 bg-muted px-2 py-1">
        <TypingDots color={p?.color} />
        <span className="text-[11px] text-muted-foreground">{b.doing}</span>
      </span>
    </div>
  )
}

/** Row header: which item the lead is on. */
export function RowPresence({ role }: { role: string }) {
  const b = useContext(PresenceContext).find((x) => x.actor === role)
  const p = personaOf(useContext(PersonaContext), role)
  if (!b) return null
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px]" style={{ color: p?.color }} title={`${b.item ? `${b.item} · ` : ''}${b.doing}`}>
      <TypingDots color={p?.color} className="shrink-0" />
      <span className={cn('truncate', b.item && 'font-mono')}>{b.item || b.doing}</span>
    </span>
  )
}

/** Top of the activity feed: everyone working right now, live. */
export function NowStrip({ onOpen }: { onOpen: (id: string) => void }) {
  const busy = useContext(PresenceContext)
  if (!busy.length) return null
  return (
    <div className="border-b border-foreground bg-muted/40">
      <div className="px-4 pt-2 text-[11px] font-bold tracking-[0.1em] uppercase">Now</div>
      <ul className="grid">{busy.map((b) => <NowLine key={b.id} b={b} onOpen={onOpen} />)}</ul>
    </div>
  )
}
function NowLine({ b, onOpen }: { b: Busy; onOpen: (id: string) => void }) {
  const { p, name } = useLabel(b)
  return (
    <li>
      <button onClick={() => b.item && onOpen(b.item)} className="typing-in grid w-full grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2 px-4 py-1.5 text-left text-xs hover:bg-muted max-md:py-2.5">
        <span className="flex size-5"><Avatar actor={b.actor} size="sm" /></span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5"><b style={{ color: p?.color }}>{name}</b><TypingDots color={p?.color} />
            {b.item && <span className="font-mono text-[11px] text-muted-foreground">{b.item}</span>}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{b.doing}</span>
        </span>
      </button>
    </li>
  )
}
