// An item's thread (sy-uykv): each comment on its own, with its author and role, its time and #n; a message as its
// card (Message.tsx), any other text as Markdown with its line breaks kept and long logs and tables folded. And the
// comment box, with whom it goes to ("To"): the board's Lead by default (it routes it on), or a role the person picks;
// the pick is the comment's first line `→ <role>` (lib/to.mjs), which bin/wake reads.
import { useContext } from 'react'
import { toast } from 'sonner'
import { BOARD_LEAD, ROLES, ROLE_LABEL, ago } from '@/lib/board'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/Markdown'
import { CommentBody } from '@/Message'
import { cn } from '@/lib/utils'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'
import { splitPick, withPick } from '@/lib/to.mjs'

type C = { id: string; author: string; text: string; created_at: string }

/** Who wrote a comment: a lead (or one of its workers, `<role>/...`), the system (wake, smoke), or a human. */
export function authorKind(author: string): 'lead' | 'system' | 'human' {
  const role = author.split('/')[0]
  if ((ROLES as readonly string[]).includes(role)) return 'lead'
  if (['wake', 'watchdog', 'smoke', 'ui', 'beads', 'mm-upstream', ''].includes(author)) return 'system'
  return 'human'
}
function leadLabel(author: string) {
  const [role, sub] = author.split('/')
  return `${ROLE_LABEL[role] || role} lead${sub ? ` · ${sub}` : ''}`
}
// the public side puts the writer's role in front of a person's comment (`[owner] `, site/server.mjs rails)
const SIDE = /^\[([a-z][\w-]*)\][ \t]+/
const when = (ts: string) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** One comment: who (name and role), whom it went to (a person's pick), when, #n; then its card or its text. */
export function ThreadList({ itemId, comments, flash, onRef }: { itemId: string; comments: C[]; flash: number | null; onRef: (n: number) => void }) {
  const personas = useContext(PersonaContext)
  return (
    <ol className="grid gap-3">
      {comments.map((c, k) => {
        const n = k + 1, kind = authorKind(c.author)
        const per = kind === 'lead' ? personaOf(personas, c.author) : null
        const picked = kind === 'human' ? splitPick(c.text, ROLES) : { to: null, body: c.text }
        const side = kind === 'human' ? SIDE.exec(picked.body) : null
        const body = side ? picked.body.slice(side[0].length) : picked.body
        const role = kind === 'lead' ? leadLabel(c.author) : kind === 'human' ? (side ? side[1] : 'person') : 'system'
        return (
          <li key={c.id} id={`c-${itemId}-${n}`} data-comment={n} data-kind={kind}
            className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] scroll-mt-4 gap-1',
              kind === 'human' && 'ml-8 border-l-4 border-foreground bg-muted px-3 py-2 md:ml-16',
              kind === 'lead' && 'mr-4 border-l-2 pl-3 md:mr-16',
              kind === 'system' && 'mx-4 border-l border-dashed border-muted-foreground pl-3 text-muted-foreground md:mx-16',
              flash === n && 'bg-swiss/10')}
            style={per ? { borderLeftColor: per.color } : undefined}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs" data-head>
              {kind === 'lead' && <Avatar actor={c.author} size="sm" />}
              <b className={cn('text-[12px]', kind === 'system' && 'font-normal italic')} style={per ? { color: per.color } : undefined} data-author>
                {kind === 'lead' ? (per?.worker ? per.label : per?.name) || c.author : c.author}</b>
              <span className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase" data-role>{role}</span>
              {picked.to && <span className="text-[11px] text-muted-foreground" data-to={picked.to}>→ <b className="text-foreground">{ROLE_LABEL[picked.to] || picked.to}</b></span>}
              <span className="ml-auto flex items-center gap-2">
                <time className="text-[11px] text-muted-foreground" dateTime={c.created_at} title={c.created_at}>{when(c.created_at)} · {ago(c.created_at)} ago</time>
                <a href={`#c-${n}`} onClick={(e) => { e.preventDefault(); navigator.clipboard?.writeText(`#${n}`); toast.success(`Copied #${n}: use it to refer to this comment`) }}
                  title="Copy reference" className="font-mono text-[11px] text-muted-foreground hover:text-swiss" data-n>#{n}</a>
              </span>
            </div>
            {kind === 'system'
              ? <Markdown className="text-xs" onRef={onRef} breaks fold>{body}</Markdown>
              : <CommentBody text={body} author={c.author} onRef={onRef} />}
          </li>
        )
      })}
    </ol>
  )
}

const LEAD = '_lead'
/** Whom the comment box can send to: the board's Lead (the default; on a board with none, the assignee), the assignee,
 *  each role. */
function toChoices(assignee?: string) {
  const out: { value: string; label: string }[] = []
  const a = assignee && ROLES.includes(assignee) ? assignee : ''
  out.push({ value: LEAD, label: BOARD_LEAD ? `Lead · ${ROLE_LABEL[BOARD_LEAD] || BOARD_LEAD}` : `Assignee · ${a ? ROLE_LABEL[a] || a : 'none'}` })
  if (BOARD_LEAD && a && a !== BOARD_LEAD) out.push({ value: a, label: `Assignee · ${ROLE_LABEL[a] || a}` })
  for (const r of ROLES) if (r !== BOARD_LEAD && r !== a) out.push({ value: r, label: ROLE_LABEL[r] || r })
  return out
}

/** The comment box: the text, To, Send. `onSend` gets the text as stored (the pick line on top when a role is picked). */
export function CommentBox({ assignee, value, onChange, to, onTo, busy, onSend }: {
  assignee?: string; value: string; onChange: (v: string) => void; to: string; onTo: (v: string) => void; busy: boolean; onSend: (text: string) => void
}) {
  const choices = toChoices(assignee)
  const pick = choices.some((c) => c.value === to) ? to : LEAD
  const label = choices.find((c) => c.value === pick)!.label
  return (
    <form className="mt-3 grid gap-2" onSubmit={(e) => {
      e.preventDefault()
      const text = value.trim()
      if (text) onSend(withPick(text, pick === LEAD ? null : pick))
    }}>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3}
        placeholder={`Write to ${pick === LEAD && BOARD_LEAD ? 'the Lead' : label}. Refer to earlier comments as #3. Markdown; paths like docs/design/x.html embed. Ctrl+Enter sends.`} className="text-[13px]"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit() }} />
      <div className="flex items-center justify-end gap-2">
        <label className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title="Whom it goes to. The Lead routes it on to the role it is for.">
          To
          <select aria-label="To" value={pick} onChange={(e) => onTo(e.target.value)} disabled={busy}
            className="h-8 min-w-0 max-w-[14rem] border border-input bg-background px-1.5 text-xs text-foreground outline-none focus:border-foreground max-md:h-9">
            {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <Button size="sm" type="submit" disabled={busy || !value.trim()} className="max-md:px-6">Send</Button>
      </div>
    </form>
  )
}
