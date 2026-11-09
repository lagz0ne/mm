import { ago } from '@/lib/board'
import { useNow } from '@/lib/live'
import { cn } from '@/lib/utils'

/** "3m": re-renders alone on the shared clock's tick (sy-jjcx), not its card or thread. `slowMin`: past it, it turns red. */
export function Ago({ ts, className, slowMin, prefix = '', title }: { ts: string; className?: string; slowMin?: number; prefix?: string; title?: string }) {
  const now = useNow()
  const slow = slowMin !== undefined && (now - new Date(ts).getTime()) / 60000 > slowMin
  if (!className && !slow && !title) return <>{prefix}{ago(ts)}</>
  return <span className={cn(className, slow && 'font-semibold text-swiss')} title={title}>{prefix}{ago(ts)}</span>
}
