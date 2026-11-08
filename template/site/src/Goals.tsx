import { Popover } from 'radix-ui'
import { CaretDownIcon } from '@phosphor-icons/react'
import type { Issue } from '@/lib/api'
import { byPriority } from '@/lib/board'
import { cn } from '@/lib/utils'

/** The goals (open epics) as one chip in the header: the first goal and its progress, the full list on click (sy-p88g).
 *  Nothing when there is no goal. */
export function Goals({ epics, issues, onOpen, className }: { epics: Issue[]; issues: Issue[]; onOpen: (id: string) => void; className?: string }) {
  if (!epics.length) return null
  const goals = [...epics].sort(byPriority).map((e) => {
    const kids = issues.filter((i) => i.parent === e.id)
    return { e, done: kids.filter((i) => i.status === 'closed').length, total: kids.length }
  })
  const [first] = goals
  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn('flex h-7 max-w-md min-w-0 shrink items-center gap-1.5 border border-input px-2 text-xs hover:border-foreground data-[state=open]:border-foreground max-md:min-h-11 max-md:max-w-none', className)}>
        <span className="shrink-0 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">Goal</span>
        <span className="min-w-0 truncate font-semibold">{first.e.title}</span>
        <span className="shrink-0 tabular-nums">{first.done}/{first.total}</span>
        {goals.length > 1 && <span className="shrink-0 bg-muted px-1 text-muted-foreground tabular-nums">+{goals.length - 1}</span>}
        <CaretDownIcon weight="bold" className="size-3 shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label="Goals" align="start" sideOffset={4} collisionPadding={8}
          className="z-50 grid max-h-[70vh] w-[min(28rem,calc(100vw-1rem))] overflow-y-auto border border-foreground bg-background shadow-xl">
          <h2 className="border-b px-3 py-2 text-[11px] font-bold tracking-[0.1em] uppercase">Goals</h2>
          {goals.map(({ e, done, total }) => (
            <Popover.Close key={e.id} onClick={() => onOpen(e.id)}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted max-md:min-h-11">
              <span className="font-mono text-[11px] text-muted-foreground">{e.id}</span>
              <span className="text-[13px] leading-snug font-semibold [overflow-wrap:anywhere]">{e.title}</span>
              <span className="text-xs tabular-nums">{done}/{total}</span>
              <span className="col-span-3 mt-1.5 h-1 bg-muted">
                <span className="block h-full bg-foreground" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
              </span>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
