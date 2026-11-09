import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** At most this many avatars in the header; the rest is a "+N" (sy-o817). */
const MAX_AVATARS = 3
/** The goal chip before the bar may shrink to this (or its natural width, if smaller) before the bar gives way. */
const KEEP_BEFORE = 256

const px = (v: string) => parseFloat(v) || 0
/** The room the bar may take in the header: its own width, the free space before its group, and what the shrinkable
 *  element before the group (the goal chip) has above the width it keeps. Infinity outside a header (the phone menu). */
function roomFor(bar: HTMLElement): number {
  const header = bar.closest('header')
  if (!header) return Infinity
  let group: HTMLElement = bar
  while (group.parentElement && group.parentElement !== header) group = group.parentElement
  const prev = group.previousElementSibling as HTMLElement | null
  const gap = px(getComputedStyle(header).columnGap)
  const own = bar.getBoundingClientRect().width
  if (!prev) return own + group.getBoundingClientRect().left - header.getBoundingClientRect().left - px(getComputedStyle(header).paddingLeft)
  const pr = prev.getBoundingClientRect()
  let room = own + group.getBoundingClientRect().left - pr.right - gap
  const cs = getComputedStyle(prev)
  if (px(cs.flexShrink) > 0) {
    // its natural width: its padding and border, its children at full width (a truncated title's scrollWidth), its gaps
    const kids = [...prev.children] as HTMLElement[]
    const natural = Math.min(cs.maxWidth === 'none' ? Infinity : px(cs.maxWidth),
      px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)
      + kids.reduce((s, k) => s + Math.max(k.scrollWidth, k.getBoundingClientRect().width), 0) + Math.max(0, kids.length - 1) * px(cs.columnGap))
    room += pr.width - Math.min(natural, KEEP_BEFORE)
  }
  return room
}

/** Header: everyone working right now. At most three avatars, then "+N", then "N working"; where the header is
 *  tight it shows fewer avatars, then only "N working", then only the number, never running into its neighbours. */
export function PresenceBar() {
  const busy = useContext(PresenceContext)
  const bar = useRef<HTMLSpanElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  // how many avatars fit (0..MAX_AVATARS), or -1: only the number
  const [fit, setFit] = useState(MAX_AVATARS)
  const most = Math.min(MAX_AVATARS, busy.length)

  useLayoutEffect(() => {
    const el = bar.current, pr = probe.current
    if (!el || !pr || !busy.length) return
    const header = el.closest('header')
    const measure = () => {
      // the probe holds every part at full size: the avatars, the "+N", the "N working", the bare number
      const parts = [...pr.children] as HTMLElement[]
      const w = (e: Element | undefined) => (e ? e.getBoundingClientRect().width : 0)
      const avatars = parts.filter((e) => e.dataset.part === 'avatar')
      const more = w(parts.find((e) => e.dataset.part === 'more')), text = w(parts.find((e) => e.dataset.part === 'text'))
      const bare = w(parts.find((e) => e.dataset.part === 'bare'))
      const gap = px(getComputedStyle(el).columnGap)
      const width = (k: number) => {
        if (k < 0) return bare
        const items = [...avatars.slice(0, k).map(w), ...(k > 0 && busy.length > k ? [more] : []), text]
        return items.reduce((s, x) => s + x, 0) + (items.length - 1) * gap
      }
      const room = roomFor(el)
      let k = most
      while (k >= 0 && width(k) > room + 0.5) k--
      setFit(k)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(header || el.parentElement || el)
    if (header) for (const c of header.children) ro.observe(c)
    return () => ro.disconnect()
  }, [busy, most])

  if (!busy.length) return <span data-presence-bar className="text-[11px] whitespace-nowrap text-muted-foreground">all quiet</span>
  const shown = fit < 0 ? 0 : Math.min(fit, most)
  const rest = busy.slice(shown)
  const restTitle = rest.map((b) => b.actor).join(', ')
  return (
    <span ref={bar} data-presence-bar className="relative flex shrink-0 items-center gap-1.5" aria-label={`${busy.length} working`}>
      {busy.slice(0, shown).map((b) => <PresenceAvatar key={b.id} b={b} />)}
      {shown > 0 && rest.length > 0 && <MoreChip n={rest.length} title={restTitle} />}
      {fit >= 0
        ? <span className="text-[11px] whitespace-nowrap text-muted-foreground" title={shown ? undefined : restTitle}>{busy.length} working</span>
        : <span className="text-[11px] font-semibold whitespace-nowrap text-muted-foreground tabular-nums" title={`${busy.length} working: ${restTitle}`}>{busy.length}</span>}
      {/* the probe: every part at full size, out of the layout and invisible, so the bar knows what fits */}
      <span ref={probe} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1.5">
        {busy.slice(0, most).map((b) => <PresenceAvatar key={b.id} b={b} probe />)}
        <MoreChip n={busy.length} />
        <span data-part="text" className="text-[11px] whitespace-nowrap">{busy.length} working</span>
        <span data-part="bare" className="text-[11px] font-semibold whitespace-nowrap tabular-nums">{busy.length}</span>
      </span>
    </span>
  )
}
function MoreChip({ n, title }: { n: number; title?: string }) {
  return <span data-part="more" title={title} className="bg-muted px-1 text-[11px] leading-5 font-semibold whitespace-nowrap text-muted-foreground tabular-nums">+{n}</span>
}
function PresenceAvatar({ b, probe }: { b: Busy; probe?: boolean }) {
  const { p, name } = useLabel(b)
  const label = `${name}${b.item ? ` · ${b.item}` : ''} · ${b.doing}`
  // the ring sits in the slot's own 2px padding (inset), so it never covers the next avatar or the text
  return (
    <span data-part="avatar" className={cn('inline-flex shrink-0 p-[2px]', !probe && 'presence-ring')} style={{ ['--presence' as string]: p?.color }}
      title={probe ? undefined : label} aria-label={probe ? undefined : label} role={probe ? undefined : 'img'}>
      <Avatar actor={b.actor} size="sm" className="pointer-events-none" />
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
