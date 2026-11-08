// For you (sy-c7mh): the start page of a person signed in through the gateway, phone first. Two parts, nothing else:
//   Needs you  what waits on this person (the board's /api/waiting, the same list as the gateway's home): each as its
//              owner card, with the one action its You line asks: Approve and Not now (a T2 go; its head refused: why,
//              no Approve), a Reply box (Reply:) or Done (Check:). The server checks the owner and the item again.
//   To review  the items closed or handed over since this person's start mark (/api/to-review: with an artifact or a
//              card), newest first, with their artifacts' thumbnails; a tap opens the item, Seen clears it.
// "Seen" and the start mark live in this browser (localStorage, per board and person): the start mark is the first
// visit minus a day, and never more than 7 days back (the server's limit). An item changed again after Seen comes back.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, type CardFields, type ReviewEntry, type WaitingEntry } from '@/lib/api'
import { ROLE_LABEL, ago } from '@/lib/board'
import { youKind } from '@/lib/owner-card.mjs'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const DAY = 86400e3
// the URL of a file the board shows (Markdown.tsx fileUrl; not imported: Markdown is a heavy part, loaded on demand)
const fileUrl = (p: string) => `/files/${p.split('/').map(encodeURIComponent).join('/')}`
const head = 'px-4 pt-5 pb-2 text-[11px] font-bold tracking-[0.1em] uppercase md:px-0'

/** The browser's marks for one board and person: the start of To review, and the items marked seen (id -> ms). */
function useMarks(key: string) {
  const sinceKey = `for-you:${key}:since`, seenKey = `for-you:${key}:seen`
  const [since] = useState(() => {
    const v = Number(localStorage.getItem(sinceKey))
    if (v > 0) return Math.max(v, Date.now() - 7 * DAY)
    const first = Date.now() - DAY
    localStorage.setItem(sinceKey, String(first))
    return first
  })
  const [seen, setSeen] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(seenKey) || '{}') || {} } catch { return {} } })
  const markSeen = (id: string) => setSeen((s) => {
    // keep the last 7 days of marks only: older items are out of the list anyway
    const keep = Object.fromEntries(Object.entries({ ...s, [id]: Date.now() }).filter(([, t]) => t > Date.now() - 8 * DAY))
    localStorage.setItem(seenKey, JSON.stringify(keep))
    return keep
  })
  return { since, seen, markSeen }
}

export function ForYou({ waiting, owner, approval, storeKey, tick, onOpen, onChanged }: {
  waiting: WaitingEntry[] | null; owner: boolean; approval?: 'label' | 'telegram'; storeKey: string; tick: number
  onOpen: (id: string) => void; onChanged: () => void
}) {
  const { since, seen, markSeen } = useMarks(storeKey)
  const [review, setReview] = useState<ReviewEntry[] | null>(null)
  const [more, setMore] = useState(0)
  useEffect(() => {
    let gone = false
    api.toReview(since).then((d) => { if (!gone) { setReview(d.items); setMore(d.more) } }).catch(() => !gone && setReview((r) => r ?? []))
    return () => { gone = true }
  }, [since, tick])
  const toReview = useMemo(() => (review || []).filter((r) => !(seen[r.id] >= Date.parse(r.at))), [review, seen])

  return (
    <div data-for-you className="mx-auto w-full max-w-3xl pb-10 md:px-6">
      <section aria-labelledby="fy-needs">
        <h2 id="fy-needs" className={head}>Needs you{waiting && waiting.length > 0 && <span className="ml-1.5 bg-swiss px-1.5 text-white tabular-nums">{waiting.length}</span>}</h2>
        {waiting === null ? <p className="px-4 text-sm text-muted-foreground md:px-0">Loading…</p>
          : waiting.length === 0 ? <p data-empty="needs-you" className="px-4 text-[15px] md:px-0">Nothing needs you.</p>
          : <div className="grid gap-3 px-2 md:px-0">{waiting.map((w) => <NeedsCard key={w.id} w={w} owner={owner} approval={approval} onOpen={onOpen} onChanged={onChanged} />)}</div>}
      </section>
      <section aria-labelledby="fy-review" className="mt-4">
        <h2 id="fy-review" className={head}>To review</h2>
        {review === null ? <p className="px-4 text-sm text-muted-foreground md:px-0">Loading…</p>
          : toReview.length === 0 ? <p data-empty="to-review" className="px-4 text-[15px] md:px-0">Nothing new.</p>
          : <div className="grid gap-3 px-2 md:px-0">{toReview.map((r) => <ReviewCard key={r.id} r={r} onOpen={onOpen} onSeen={() => markSeen(r.id)} />)}</div>}
        {more > 0 && <p className="px-4 pt-2 text-xs text-muted-foreground md:px-0">{more} more on the board.</p>}
      </section>
    </div>
  )
}

/** The card's fields as the owner card shows them (OwnerCard.tsx): each key in bold, the value as plain text. */
function Fields({ card, keys }: { card: CardFields; keys: [keyof CardFields, string][] }) {
  const shown = keys.filter(([k]) => card[k])
  if (!shown.length) return null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2.5 text-[15px] leading-snug">
      {shown.map(([k, label]) => (
        <div key={k} data-key={label} className="contents">
          <dt className="font-bold whitespace-nowrap">{label}</dt>
          <dd className={cn('min-w-0 [overflow-wrap:anywhere]', k === 'you' && 'font-semibold text-swiss')}>{card[k]}</dd>
        </div>
      ))}
    </dl>
  )
}
const NEED_KEYS: [keyof CardFields, string][] = [['what', 'What'], ['why', 'Why'], ['you', 'You'], ['if_yes', 'If yes'], ['if_no', 'If no'], ['risk', 'Risk']]

function NeedsCard({ w, owner, approval, onOpen, onChanged }: {
  w: WaitingEntry; owner: boolean; approval?: 'label' | 'telegram'; onOpen: (id: string) => void; onChanged: () => void
}) {
  const [busy, setBusy] = useState(false), [text, setText] = useState(''), [sent, setSent] = useState<string | null>(null)
  const go = w.labels.includes('t2') && w.labels.includes('signed-off')
  const kind = youKind(w.card?.you ?? w.you ?? '')
  async function run(what: () => Promise<{ title: string }>, after?: string) {
    setBusy(true)
    try { const d = await what(); toast.success(d.title); setText(''); if (after) setSent(after); onChanged() } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <article data-needs-you={w.id} className="border-2 border-foreground bg-background">
      <button type="button" onClick={() => onOpen(w.id)} className="flex w-full min-w-0 items-baseline gap-2 bg-foreground px-3 py-2 text-left text-background">
        <span className="min-w-0 flex-1 text-[15px] leading-snug font-bold [overflow-wrap:anywhere]">{w.title}</span>
        <span className="shrink-0 text-[11px] tabular-nums opacity-70">{w.age_min < 60 ? `${w.age_min}m` : w.age_min < 1440 ? `${Math.floor(w.age_min / 60)}h` : `${Math.floor(w.age_min / 1440)}d`}</span>
      </button>
      {w.card ? <Fields card={w.card} keys={NEED_KEYS} />
        : owner && <p data-card-missing className="px-3 py-2.5 text-xs font-semibold text-swiss">card missing: this item does not say what it asks. Open it to read the thread.</p>}
      {owner && (
        <div className="flex flex-wrap items-end gap-2 border-t px-3 py-2.5">
          {go ? (w.refused ? (
            <p data-head-refused className="text-xs font-semibold text-swiss [overflow-wrap:anywhere]">No go yet: {w.refused}. Review signs off the head the card names.</p>
          ) : sent ? <p data-approved className="text-xs">{sent}</p> : (<>
            <Button data-act="approve" className="min-h-11 px-5 text-[15px]" disabled={busy || !approval}
              onClick={() => run(() => approval === 'telegram' ? api.approveOnTelegram(w.id) : api.approve(w.id), approval === 'telegram' ? 'Sent to your Telegram: your tap there is the go.' : 'Approved.')}>
              {approval === 'telegram' ? 'Approve on Telegram' : 'Approve'}</Button>
            <Button data-act="not-now" variant="outline" className="min-h-11 px-4 text-[15px]" disabled={busy} onClick={() => run(() => api.notNow(w.id))}>Not now</Button>
          </>)) : kind === 'reply' ? (<>
            <label htmlFor={`fy-reply-${w.id}`} className="w-full text-[11px] font-semibold">Your reply</label>
            <Textarea id={`fy-reply-${w.id}`} data-act="reply-text" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} className="min-h-14 flex-1 text-base" />
            <Button data-act="reply" className="min-h-11 px-4 text-[15px]" disabled={busy || !text.trim()} onClick={() => run(() => api.reply(w.id, text))}>Send</Button>
          </>) : kind === 'check' ? (
            <Button data-act="done" className="min-h-11 px-5 text-[15px]" disabled={busy} title="Done: a comment on the item, and it no longer waits for you" onClick={() => run(() => api.done(w.id))}>Done</Button>
          ) : (
            <Button data-act="open" variant="outline" className="min-h-11 px-4 text-[15px]" onClick={() => onOpen(w.id)}>Open</Button>
          )}
        </div>
      )}
    </article>
  )
}

function ReviewCard({ r, onOpen, onSeen }: { r: ReviewEntry; onOpen: (id: string) => void; onSeen: () => void }) {
  const who = (n?: string) => (n ? ROLE_LABEL[n] || n : '')
  const imgs = r.artifacts.filter((a) => a.type.startsWith('image/')), rest = r.files - imgs.length
  return (
    <article data-to-review={r.id} className="border border-foreground bg-background">
      <button type="button" onClick={() => onOpen(r.id)} className="grid w-full min-w-0 gap-1.5 px-3 pt-2.5 pb-2 text-left hover:bg-muted/50">
        <span className="text-[11px] text-muted-foreground">
          {r.kind === 'closed' ? <>Done{r.by && <> by <b className="text-foreground">{who(r.by)}</b></>}</> : <>Handed to <b className="text-foreground">{who(r.to)}</b></>} · {ago(r.at)} ago
        </span>
        <span className="text-[15px] leading-snug font-bold [overflow-wrap:anywhere]">{r.title}</span>
        {r.card?.what && <span className="text-[15px] leading-snug [overflow-wrap:anywhere]">{r.card.what}</span>}
        {imgs.length > 0 && (
          <span data-thumbs className="grid grid-cols-3 gap-1.5 pt-0.5">
            {imgs.slice(0, 3).map((a) => <img key={a.name} src={fileUrl(a.path)} alt={a.name} loading="lazy" className="aspect-[4/3] w-full border bg-muted object-cover object-top" />)}
          </span>
        )}
        {rest > 0 && <span className="text-[11px] text-muted-foreground">{imgs.length ? `+${rest} more file${rest > 1 ? 's' : ''}` : `${rest} file${rest > 1 ? 's' : ''}`}</span>}
      </button>
      <div className="flex justify-end border-t px-2 py-1">
        <button type="button" data-act="seen" onClick={onSeen} className="min-h-11 px-3 text-sm font-semibold hover:underline">Seen</button>
      </div>
    </article>
  )
}
