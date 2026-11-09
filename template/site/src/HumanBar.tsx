// The top bar for a person signed in through the gateway (sy-c7mh), at every width: one row, five controls. The
// project's name (text), For you, Board, Needs you (N: what waits on this person; it opens that list), and one menu (⋯)
// that holds the rest:
// search and the role filter (they apply to the board, so they open it), the goals, who is at work and Now/Activity,
// Leads, Machine and the links, New item, the live state, the name and sign out (on the gateway's home page). No column
// counts, no second row. The leads' local side keeps its own bars (App's header, PhoneBar).
import { useEffect, useState, type MouseEvent, type Ref } from 'react'
import { ArrowUpRightIcon, DotsThreeIcon, PlusIcon } from '@phosphor-icons/react'
import type { Issue } from '@/lib/api'
import { ROLES, ROLE_LABEL } from '@/lib/board'
import { Avatar } from '@/lib/persona'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { goalsOf } from '@/Goals'
import { showNeedsYou } from '@/ForYou'
import { PresenceBar } from '@/Presence'
import { cn } from '@/lib/utils'

export type HumanView = 'foryou' | 'board' | 'leads' | 'machine' | 'glossary' | 'files'

export function HumanBar({ project, view, needs, panels, links, role, onRole, q, onQ, search, epics, issues, onOpenItem,
  live, actor, home, onNew, nowCount, onNow }: {
  project: string; view: HumanView; needs: number; panels: string[]; links: { name: string; label: string; url: string }[]
  role: string; onRole: (r: string) => void; q: string; onQ: (q: string) => void; search: Ref<HTMLInputElement>
  epics: Issue[]; issues: Issue[]; onOpenItem: (id: string) => void
  live: boolean; actor: string; home?: string; onNew: () => void; nowCount: number; onNow: () => void
}) {
  const [open, setOpen] = useState(false)
  // "/" opens the menu at its search field, as it focuses the search on the leads' board
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== '/' || t.closest('input,textarea,[role=dialog]') || e.metaKey || e.ctrlKey) return
      e.preventDefault(); setOpen(true)
      window.setTimeout(() => (document.querySelector('[data-menu-search]') as HTMLInputElement | null)?.focus(), 50)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // an entry acts after the sheet is closed, so a dialog it opens (New item) gets the focus
  const then = (f: () => void) => () => { setOpen(false); window.setTimeout(f, 0) }
  // the address says #needs-you (Back returns); no jump of the browser's own: it would move the board's fixed frame
  const toNeedsYou = (e: MouseEvent) => {
    e.preventDefault()
    if (window.location.hash !== '#needs-you') { history.pushState(null, '', '#needs-you'); window.dispatchEvent(new HashChangeEvent('hashchange')) }
    window.setTimeout(showNeedsYou, 60)
  }
  const toBoard = () => { if (view !== 'board') window.location.hash = '#board' }
  const filtered = role !== 'all' || !!q.trim()
  const goals = goalsOf(epics, issues)
  const sectionHead = 'px-4 pt-4 pb-1.5 text-[11px] font-bold tracking-[0.1em] text-muted-foreground uppercase'
  const entry = 'flex min-h-11 w-full items-center gap-2.5 px-4 py-1.5 text-left text-[15px] hover:bg-muted'
  const tab = (on: boolean) => cn('flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-2 text-[15px] font-semibold md:px-3',
    on ? 'border-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')

  return (
    <header data-human-bar className="z-30 flex h-12 shrink-0 items-center gap-1 border-b border-foreground bg-background pl-3 md:gap-3 md:px-6">
      <h1 className="min-w-0 flex-1 truncate text-[17px] leading-none font-bold tracking-tight md:flex-none md:text-xl" title={project}>{project || '…'}</h1>
      <nav aria-label="Views" className="flex shrink-0 items-center md:mr-auto">
        <a data-bar="for-you" href="#for-you" aria-current={view === 'foryou' ? 'page' : undefined} className={tab(view === 'foryou')}
          >For you</a>
        <a data-bar="board" href="#board" aria-current={view === 'board' ? 'page' : undefined} className={tab(view === 'board')}>Board</a>
      </nav>
      {/* Needs you (the owner, 2026-11-09): always here, at every width; it opens the Needs you list (For you, at its top).
          The count is what waits on this person; none: "Needs you" with no number, still here. */}
      <a data-bar="needs-you" href="#needs-you" onClick={toNeedsYou}
        aria-label={needs ? `Needs you: ${needs}` : 'Needs you: nothing'}
        className={cn('ml-1 flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-[14px] font-bold whitespace-nowrap md:px-3 md:text-[15px]',
          needs ? 'bg-swiss text-white hover:opacity-90' : 'border border-foreground hover:bg-muted')}>
        Needs you{needs > 0 && <span aria-hidden className="min-w-5 bg-white px-1 text-center text-xs text-swiss tabular-nums">{needs}</span>}
      </a>
      <button type="button" data-bar="menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(true)}
        className="relative flex size-12 shrink-0 items-center justify-center md:-mr-3">
        <DotsThreeIcon weight="bold" className="size-6" />
        {/* a filter on, someone at work, or the stream down: a dot on the menu */}
        {(filtered || !live || nowCount > 0) && <span className={cn('absolute top-2.5 right-2 size-2', live ? 'bg-swiss' : 'border border-muted-foreground bg-background')} />}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-[min(22rem,88vw)] gap-0 text-sm" aria-describedby={undefined}>
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-foreground pl-4">
            <SheetTitle className="text-[11px] font-bold tracking-[0.1em] uppercase">Menu</SheetTitle>
            <SheetClose className="min-h-11 px-4 text-sm font-semibold hover:underline">Close</SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
            <div className="px-4 pt-4">
              <input ref={search} data-menu-search value={q} onChange={(e) => { onQ(e.target.value); toBoard() }} placeholder="Search the board" aria-label="Search the board" type="search"
                className="h-11 w-full border border-input bg-background px-3 text-base outline-none focus:border-foreground" />
            </div>
            <h2 className={sectionHead}>Role</h2>
            {['all', ...ROLES, ''].map((r) => (
              <button key={r || 'none'} type="button" aria-pressed={role === r} onClick={then(() => { onRole(r); if (r !== 'all') toBoard() })}
                className={cn(entry, role === r && 'font-bold')}>
                <span className={cn('size-2 shrink-0', role === r ? 'bg-foreground' : 'bg-transparent')} />
                {r && r !== 'all' && <Avatar actor={r} size="xs" />}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r === 'all' ? 'All roles' : ROLE_LABEL[r]}</span>
              </button>
            ))}
            {goals.length > 0 && <h2 className={sectionHead}>Goals</h2>}
            {goals.map(({ e, done, total }) => (
              <button key={e.id} type="button" onClick={then(() => onOpenItem(e.id))} className={cn(entry, 'grid grid-cols-[minmax(0,1fr)_auto] gap-y-1 py-2')}>
                <span className="leading-snug font-semibold [overflow-wrap:anywhere]">{e.title}</span>
                <span className="text-xs tabular-nums">{done}/{total}</span>
                <span className="col-span-2 h-1 bg-muted"><span className="block h-full bg-foreground" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
              </button>
            ))}
            <h2 className={sectionHead}>At work</h2>
            <div className="px-4 pb-1"><PresenceBar /></div>
            <button type="button" onClick={then(() => { toBoard(); window.setTimeout(onNow, 0) })} className={cn(entry, 'font-semibold')}>
              Now <span className={cn('min-w-5 px-1 text-center text-xs tabular-nums', nowCount ? 'bg-swiss text-white' : 'bg-muted text-muted-foreground')}>{nowCount}</span>
              <span aria-hidden className="text-muted-foreground">·</span> Activity
            </button>
            <h2 className={sectionHead}>Go to</h2>
            <a href="#leads" onClick={() => setOpen(false)} aria-current={view === 'leads' ? 'page' : undefined} className={cn(entry, view === 'leads' && 'font-bold')}>Leads</a>
            {panels.includes('machine') && <a href="#machine" onClick={() => setOpen(false)} aria-current={view === 'machine' ? 'page' : undefined} className={cn(entry, view === 'machine' && 'font-bold')}>Machine</a>}
            <a href="#files" onClick={() => setOpen(false)} aria-current={view === 'files' ? 'page' : undefined} className={cn(entry, view === 'files' && 'font-bold')}>Files</a>
            <a href="#glossary" onClick={() => setOpen(false)} aria-current={view === 'glossary' ? 'page' : undefined} className={cn(entry, view === 'glossary' && 'font-bold')}>Glossary</a>
            {links.map((l) => (
              <a key={l.name} href={l.url} target="_blank" rel="noreferrer" className={cn(entry, 'text-swiss')}>
                {l.label}<ArrowUpRightIcon weight="bold" className="size-3.5" />
              </a>
            ))}
            <div className="mt-4 grid gap-2 border-t px-4 pt-4">
              <button type="button" onClick={then(onNew)} className="flex min-h-11 items-center justify-center gap-1.5 bg-foreground px-4 text-[15px] font-semibold text-background">
                <PlusIcon weight="bold" />New item
              </button>
              <p className="flex min-h-11 min-w-0 items-center gap-2 text-[15px]" title="Your name comes from your sign-in">
                <span className={cn('size-2.5 shrink-0', live ? 'bg-swiss' : 'border border-muted-foreground')} />
                <span className="min-w-0 truncate"><b>{actor || '…'}</b> <span className="text-xs text-muted-foreground">· {live ? 'live' : 'not live: reload'}</span></span>
              </p>
              {home && <a data-sign-out href={home} className="flex min-h-11 items-center text-[15px] font-semibold underline-offset-2 hover:underline">Sign out (on your boards page)</a>}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}
