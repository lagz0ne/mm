import { useState, type Ref } from 'react'
import { DropdownMenu } from 'radix-ui'
import { ArrowUpRightIcon, CaretDownIcon, ListIcon, PlusIcon, XIcon } from '@phosphor-icons/react'
import type { Issue } from '@/lib/api'
import { COLUMNS, ROLES, ROLE_LABEL, type ColumnKey } from '@/lib/board'
import { Avatar } from '@/lib/persona'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { goalsOf } from '@/Goals'
import { PresenceBar } from '@/Presence'
import { cn } from '@/lib/utils'

type View = 'board' | 'leads' | 'machine' | 'glossary' | 'files'
const VIEW_LABEL: Record<View, string> = { board: 'Board', leads: 'Leads', machine: 'Machine', glossary: 'Glossary', files: 'Files' }

/** The board's controls on a phone (sy-hrsm): one row, 48px. The project, the active filter as a chip (only when one
 *  is set), the column as one picker, and one menu that holds everything else: search, the role filter, the goals,
 *  who is at work and Now/Activity, the views and links, New item, who you are. On the board it lies over the list and
 *  slides away on scroll down (`hidden`), so the items keep the screen. */
export function PhoneBar({ project, view, panels, links, col, counts, onCol, role, onRole, q, onQ, search, epics, issues, onOpenItem,
  live, actor, idSource, onIdentify, onNew, nowCount, onNow, hidden }: {
  project: string; view: View; panels: string[]; links: { name: string; label: string; url: string }[]
  col: ColumnKey; counts: Record<ColumnKey, number>; onCol: (c: ColumnKey) => void
  role: string; onRole: (r: string) => void; q: string; onQ: (q: string) => void; search: Ref<HTMLInputElement>
  epics: Issue[]; issues: Issue[]; onOpenItem: (id: string) => void
  live: boolean; actor: string; idSource: string; onIdentify: () => void; onNew: () => void
  nowCount: number; onNow: () => void; hidden: boolean
}) {
  const [open, setOpen] = useState(false)
  // A menu entry acts after the sheet is closed, so a dialog it opens (New item, Identify) gets the focus.
  const then = (f: () => void) => () => { setOpen(false); window.setTimeout(f, 0) }
  const board = view === 'board'
  const filter = board ? [role !== 'all' && ROLE_LABEL[role], q.trim() && `“${q.trim()}”`].filter(Boolean).join(' · ') : ''
  const c = COLUMNS.find((x) => x.key === col)!
  const goals = goalsOf(epics, issues)
  const views: View[] = ['board', 'leads', ...(panels.includes('machine') ? ['machine' as const] : []), 'files', 'glossary']
  const sectionHead = 'px-4 pt-4 pb-1.5 text-[11px] font-bold tracking-[0.1em] text-muted-foreground uppercase'
  const entry = 'flex min-h-11 w-full items-center gap-2.5 px-4 py-1.5 text-left text-[15px] hover:bg-muted'

  return (
    <header className={cn('z-30 flex h-12 shrink-0 items-center gap-1.5 border-b border-foreground bg-background pl-3',
      board && 'absolute inset-x-0 top-0 transition-transform duration-200 will-change-transform', board && hidden && !open && '-translate-y-[calc(100%+4px)]')}>
      <h1 className="min-w-0 flex-1 truncate text-[17px] leading-none font-bold tracking-tight" title={project}>{project || '…'}</h1>
      {filter && (
        <span data-filter-chip className="flex h-11 max-w-[34%] min-w-0 shrink items-center bg-foreground pl-2.5 text-[13px] font-semibold text-background">
          <span className="min-w-0 truncate" title={filter}>{filter}</span>
          <button type="button" aria-label={`Clear the filter (${filter})`} onClick={() => { onRole('all'); onQ('') }}
            className="flex h-11 w-9 shrink-0 items-center justify-center">
            <XIcon weight="bold" className="size-3.5" />
          </button>
        </span>
      )}
      {board ? (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger aria-label={`Column: ${c.label}, ${counts[col]} items`}
            className="flex h-11 shrink-0 items-center gap-1.5 border border-input px-2.5 text-sm font-semibold data-[state=open]:border-foreground">
            <span aria-hidden>{c.label}</span>
            <span aria-hidden className="bg-muted px-1 text-xs tabular-nums">{counts[col]}</span>
            <CaretDownIcon weight="bold" className="size-3 text-muted-foreground" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={2} collisionPadding={8} aria-label="Columns"
              className="z-50 grid min-w-52 border border-foreground bg-background shadow-xl">
              <DropdownMenu.RadioGroup value={col} onValueChange={(v) => onCol(v as ColumnKey)}>
                {COLUMNS.map((x) => (
                  <DropdownMenu.RadioItem key={x.key} value={x.key}
                    className="flex min-h-12 cursor-default items-center gap-3 border-b px-4 text-[15px] outline-none last:border-b-0 data-[highlighted]:bg-muted data-[state=checked]:font-bold">
                    <span className={cn('size-2 shrink-0', col === x.key ? 'bg-foreground' : 'bg-transparent')} />
                    <span className="flex-1">{x.label}</span>
                    <span className="text-sm tabular-nums">{counts[x.key]}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : (
        <span className="shrink-0 px-1 text-sm font-semibold">{VIEW_LABEL[view]}</span>
      )}
      <button type="button" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(true)}
        className="relative flex size-12 shrink-0 items-center justify-center">
        <ListIcon weight="bold" className="size-5" />
        {/* someone at work, or the stream is down: a dot on the menu */}
        {(!live || nowCount > 0) && <span className={cn('absolute top-2.5 right-2.5 size-2', live ? 'bg-swiss' : 'border border-muted-foreground bg-background')} />}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-[min(22rem,88vw)] gap-0 text-sm" aria-describedby={undefined}>
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-foreground pl-4">
            <SheetTitle className="text-[11px] font-bold tracking-[0.1em] uppercase">Menu</SheetTitle>
            <SheetClose className="min-h-11 px-4 text-sm font-semibold hover:underline">Close</SheetClose>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          {board && (
            <>
              <div className="px-4 pt-4">
                <input ref={search} value={q} onChange={(e) => onQ(e.target.value)} placeholder="Search" aria-label="Search" type="search"
                  className="h-11 w-full border border-input bg-background px-3 text-base outline-none focus:border-foreground" />
              </div>
              <h2 className={sectionHead}>Role</h2>
              {['all', ...ROLES, ''].map((r) => (
                <button key={r || 'none'} type="button" aria-pressed={role === r} onClick={then(() => onRole(r))}
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
              <button type="button" onClick={then(onNow)} className={cn(entry, 'font-semibold')}>
                Now <span className={cn('min-w-5 px-1 text-center text-xs tabular-nums', nowCount ? 'bg-swiss text-white' : 'bg-muted text-muted-foreground')}>{nowCount}</span>
                <span aria-hidden className="text-muted-foreground">·</span> Activity
              </button>
            </>
          )}
          <h2 className={sectionHead}>Go to</h2>
          {views.map((v) => (
            <a key={v} href={v === 'board' ? '#' : `#${v}`} onClick={() => setOpen(false)} aria-current={view === v ? 'page' : undefined}
              className={cn(entry, view === v && 'font-bold')}>{VIEW_LABEL[v]}</a>
          ))}
          {links.map((l) => (
            <a key={l.name} href={l.url} target="_blank" rel="noreferrer" className={cn(entry, 'text-swiss')}>
              {l.label}<ArrowUpRightIcon weight="bold" className="size-3.5" />
            </a>
          ))}
          <div className="mt-4 grid gap-2 border-t px-4 pt-4">
            <button type="button" onClick={then(onNew)} className="flex min-h-11 items-center justify-center gap-1.5 bg-foreground px-4 text-[15px] font-semibold text-background">
              <PlusIcon weight="bold" />New item
            </button>
            <button type="button" disabled={idSource === 'gateway'} onClick={then(onIdentify)}
              title={idSource === 'gateway' ? 'Your name comes from your sign-in' : 'Change who you are'}
              className="flex min-h-11 min-w-0 items-center gap-2 text-left text-[15px] disabled:opacity-100">
              <span className={cn('size-2.5 shrink-0', live ? 'bg-swiss' : 'border border-muted-foreground')} title={live ? 'Live updates on' : 'Live updates off'} />
              <span className="min-w-0 truncate"><b>{actor || '…'}</b>{idSource === 'default' && <span className="text-swiss"> · who are you?</span>}</span>
            </button>
          </div>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}
