// A lead's comment as a message (sy-0gsw; the format: lib/message.mjs, the one bin/bd's gate and the Supervisor use):
// its intent as a tag, whom it is for, what it answers (re #n, a link), its Head, and its keys as a short list; a
// comment that is not a valid message shows as text. And "Waits on": the item's ASKs and HANDOFFs with no answer yet.
import { Markdown } from '@/Markdown'
import { cn } from '@/lib/utils'
import { MESSAGE_ROLES } from '@/lib/board'
import { openWaits, parseMessage, type Message } from '@/lib/message.mjs'
import { Original, Parts } from '@/Structured'

const TAG: Record<string, string> = {
  ASK: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
  HANDOFF: 'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100',
  VERDICT: 'bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-100',
  ANSWER: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
  DONE: 'bg-foreground text-background',
  NOTE: 'bg-muted text-muted-foreground',
}
// the order the keys show in (sy-uykv): who acts and by when (Expect, By), then how it is checked (Done when, Verify),
// then the intent's own keys as written; each group a block of its own
const GROUPS = [['Expect', 'By'], ['Done when', 'Verify']]
const FIRST = GROUPS.flat()

export function IntentTag({ intent, className }: { intent: string; className?: string }) {
  return <span data-intent={intent} className={cn('inline-flex h-5 items-center px-1.5 font-mono text-[10px] font-semibold tracking-[0.08em]', TAG[intent] || TAG.NOTE, className)}>{intent}</span>
}

/** One comment: a valid message as its parts; anything else (a person's words, the system's, an older comment) as text. */
export function CommentBody({ text, author, onRef, className }: { text: string; author: string; onRef: (n: number) => void; className?: string }) {
  // a VERDICT not written by review shows as text (review sy-0gsw #8: only review writes one)
  const m: Message = parseMessage(text, { roles: MESSAGE_ROLES, author })
  if (!m.ok) return <Markdown className={className} onRef={onRef} breaks fold>{text}</Markdown>
  const rest = m.intent === 'NOTE' ? m.text.split('\n').slice(1).join('\n').trim() : ''
  const keys = Object.keys(m.keys).filter((k) => k !== 'Head')
  const groups = [...GROUPS.map((g) => g.filter((k) => keys.includes(k))), keys.filter((k) => !FIRST.includes(k))]
  const rowsOf = ['act', 'check', 'own']
  return (
    <div className={cn('grid min-w-0 gap-1.5 border bg-background px-3 py-2', className)} data-message={m.intent}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <IntentTag intent={m.intent!} />
        <span className="text-muted-foreground">→ <b className="text-foreground">{m.to}</b></span>
        {m.re !== null && <a href={`#ref-${m.re}`} onClick={(e) => { e.preventDefault(); onRef(m.re!) }} className="font-mono text-[11px] text-muted-foreground underline hover:text-swiss">re #{m.re}</a>}
        {m.keys.Head && <code className="font-mono text-[11px] text-muted-foreground">{m.keys.Head}</code>}
      </div>
      {rest && <Markdown onRef={onRef} breaks fold>{rest}</Markdown>}
      {groups.map((g, gi) => g.length > 0 && (
        <dl key={rowsOf[gi]} data-rows={rowsOf[gi]}
          className={cn('grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[13px] max-md:grid-cols-1', gi > 0 && groups.slice(0, gi).some((x) => x.length) && 'border-t pt-1.5')}>
          {g.map((k) => (
            <div key={k} className="contents">
              <dt className={cn('text-[11px] text-muted-foreground uppercase tracking-[0.06em] max-md:mt-1', k === 'Expect' && 'font-semibold text-foreground')}>{k}</dt>
              <dd className={cn('min-w-0 break-words', k === 'Verify' && 'font-mono text-[12px]', k === 'Expect' && 'font-medium')}>
                {k === 'Result' && m.intent === 'VERDICT'
                  ? <b className={/^blocked/.test(m.keys[k]) ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-300'}>{m.keys[k]}</b>
                  : <Markdown embeds={k === 'Tests' || k === 'Artifacts'} onRef={onRef} breaks fold>{m.keys[k]}</Markdown>}
              </dd>
            </div>
          ))}
        </dl>
      ))}
      {m.json && <><Parts parts={m.json.parts} onRef={onRef} /><Original raw={m.text} /></>}
    </div>
  )
}

/** "Waits on": each ASK or HANDOFF on the item that no later message answers (re #n), whom it waits on, by when. */
export function WaitsOn({ comments, onRef }: { comments: { author: string; text: string; created_at: string }[]; onRef: (n: number) => void }) {
  const waits = openWaits(comments, { roles: MESSAGE_ROLES })
  if (!waits.length) return null
  return (
    <ul className="mb-3 grid gap-1 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/30" aria-label="Waits on" data-waits={waits.length}>
      <li className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Waits on</li>
      {waits.map((w) => (
        <li key={w.n} className="flex min-w-0 flex-wrap items-center gap-x-2" data-wait={w.n}>
          <a href={`#ref-${w.n}`} onClick={(e) => { e.preventDefault(); onRef(w.n) }} className="font-mono text-[11px] text-muted-foreground underline hover:text-swiss">#{w.n}</a>
          <IntentTag intent={w.intent} />
          <b>{w.role}</b>
          <span className="min-w-0 flex-1 truncate" title={w.action}>{w.action}</span>
          {w.by && <span className={cn('text-[11px]', w.late ? 'font-semibold text-destructive' : 'text-muted-foreground')}>{w.late ? 'late · ' : ''}by {w.by}</span>}
        </li>
      ))}
    </ul>
  )
}
