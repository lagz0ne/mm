// For you (sy-c7mh): the start page of a person signed in through the gateway, phone first. Two parts, nothing else:
//   Needs you  what waits on this person (the board's /api/waiting, the same list as the gateway's home): each card
//              leads with the action: its You line as the headline, then the one action it asks, large: Approve and
//              Not now (a T2 go; its head refused: why, in Approve's place), a Reply box (Reply:) or Done (Check:);
//              then What and Why (a go: If yes, If no, Risk) in smaller text; the link to the item last. A t2 non-go
//              ask gets its Reply or Done, never Approve. The server checks the owner and the item again.
//   To review  the items closed or handed over since this person's start mark (/api/to-review: with an artifact or a
//              card), newest first, with their artifacts' thumbnails; a tap opens the item, Seen clears it.
// "Seen" and the start mark live in this browser (localStorage, per board and person): the start mark is the first
// visit minus a day, and never more than 7 days back (the server's limit). An item changed again after Seen comes back.
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, type CardFields, type ReviewEntry, type WaitingEntry } from '@/lib/api'
import { ROLE_LABEL, ago } from '@/lib/board'
import { isNonGoAsk, youKind } from '@/lib/owner-card.mjs'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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

/** The Needs you list on screen: it is the first part of For you, so its scroll box goes to the top (scrollIntoView
 *  would also move the board's fixed frame, and the bar with it). */
export const showNeedsYou = () => document.getElementById('needs-you')?.closest('main')?.scrollTo({ top: 0 })

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
  // the bar's Needs you button (#needs-you): this list at the top, also on a first load with that address
  useEffect(() => { if (window.location.hash === '#needs-you') showNeedsYou() }, [])
  const toReview = useMemo(() => (review || []).filter((r) => !(seen[r.id] >= Date.parse(r.at))), [review, seen])

  return (
    <div data-for-you className="mx-auto w-full max-w-3xl pb-10 md:px-6">
      <section id="needs-you" aria-labelledby="fy-needs">
        <h2 id="fy-needs" className={head}>Needs you{waiting && waiting.length > 0 && <span className="ml-1.5 bg-swiss px-1.5 text-white tabular-nums">{waiting.length}</span>}</h2>
        {waiting === null ? <p className="px-4 text-sm text-muted-foreground md:px-0">Loading…</p>
          : waiting.length === 0 ? <p data-empty="needs-you" className="px-4 text-[15px] md:px-0">Nothing needs you.</p>
          : <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-2 md:px-0">{waiting.map((w) => <NeedsCard key={w.id} w={w} owner={owner} approval={approval} onOpen={onOpen} onChanged={onChanged} />)}</div>}
      </section>
      <section aria-labelledby="fy-review" className="mt-4">
        <h2 id="fy-review" className={head}>To review</h2>
        {review === null ? <p className="px-4 text-sm text-muted-foreground md:px-0">Loading…</p>
          : toReview.length === 0 ? <p data-empty="to-review" className="px-4 text-[15px] md:px-0">Nothing new.</p>
          : <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-2 md:px-0">{toReview.map((r) => <ReviewCard key={r.id} r={r} onOpen={onOpen} onSeen={() => markSeen(r.id)} />)}</div>}
        {more > 0 && <p className="px-4 pt-2 text-xs text-muted-foreground md:px-0">{more} more on the board.</p>}
      </section>
    </div>
  )
}

/** The card's other fields, below the action and smaller (What, Why, and a go's If yes, If no, Risk): each key in bold. */
function Details({ card }: { card: CardFields }) {
  const shown = DETAIL_KEYS.filter(([k]) => card[k])
  if (!shown.length) return null
  return (
    <dl data-part="details" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t px-4 py-3 text-[13px] leading-snug text-muted-foreground">
      {shown.map(([k, label]) => (
        <div key={k} data-key={label} className="contents">
          <dt className="font-bold whitespace-nowrap text-foreground">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{card[k]}</dd>
        </div>
      ))}
    </dl>
  )
}
const DETAIL_KEYS: [keyof CardFields, string][] = [['what', 'What'], ['why', 'Why'], ['if_yes', 'If yes'], ['if_no', 'If no'], ['risk', 'Risk']]
const age = (m: number) => (m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`)

/** One Needs you card, the action first (the owner, 2026-11-09: "more appealing on what should be done"): the You line
 *  as the headline, its one button large under it (Approve; a refused go: why, in its place; a Reply box; Done), then
 *  What and Why (and a go's If yes, If no, Risk) in smaller text, the link to the item last. Same order at every width. */
function NeedsCard({ w, owner, approval, onOpen, onChanged }: {
  w: WaitingEntry; owner: boolean; approval?: 'label' | 'telegram'; onOpen: (id: string) => void; onChanged: () => void
}) {
  const [busy, setBusy] = useState(false), [text, setText] = useState(''), [sent, setSent] = useState<string | null>(null)
  const you = (w.card?.you ?? w.you ?? '').trim()
  const kind = youKind(you)
  // a T2 go: t2 and signed-off, and not a non-go ask (sy-t9tg: You Reply:/Check:/Nothing gets its own answer, never
  // Approve; a t2 card without its keys still counts as a go ask, and the server refuses it with its reason)
  const go = w.labels.includes('t2') && w.labels.includes('signed-off') && !isNonGoAsk({ You: you })
  const missing = owner && !w.card
  async function run(what: () => Promise<{ title: string }>, after?: string) {
    setBusy(true)
    try { const d = await what(); toast.success(d.title); setText(''); if (after) setSent(after); onChanged() } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  const big = 'h-12 w-full px-6 text-[17px] font-bold sm:w-auto'
  return (
    <article data-needs-you={w.id} className="min-w-0 border-2 border-foreground bg-background">
      <div data-part="you" className="px-4 pt-3 pb-1">
        <p className="text-[11px] font-bold tracking-[0.1em] text-swiss uppercase">
          {go ? 'Your go' : kind === 'reply' ? 'Your answer' : kind === 'check' ? 'Your check' : 'For you'}
          <span className="font-normal text-muted-foreground"> · waiting {age(w.age_min)}</span>
        </p>
        <p data-you className="pt-1 text-xl leading-tight font-bold [overflow-wrap:anywhere] md:text-2xl">
          {you || (missing ? 'This item does not say what it asks.' : w.title)}
        </p>
      </div>
      {owner && (go || kind === 'reply' || kind === 'check' || missing) && (
        <div data-part="act" className="flex flex-wrap items-center gap-2 px-4 pt-2 pb-4">
          {go ? (w.refused ? (
            <p data-head-refused className="w-full border-l-4 border-swiss bg-muted px-3 py-2.5 text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]">
              No go yet: {w.refused}. Review signs off the head the card names.</p>
          ) : sent ? <p data-approved className="text-[15px] font-semibold">{sent}</p> : (<>
            <Button data-act="approve" className={big} disabled={busy || !approval}
              onClick={() => run(() => approval === 'telegram' ? api.approveOnTelegram(w.id) : api.approve(w.id), approval === 'telegram' ? 'Sent to your Telegram: your tap there is the go.' : 'Approved.')}>
              {approval === 'telegram' ? 'Approve on Telegram' : 'Approve'}</Button>
            <Button data-act="not-now" variant="outline" className="min-h-11 px-4 text-[15px]" disabled={busy} onClick={() => run(() => api.notNow(w.id))}>Not now</Button>
          </>)) : kind === 'reply' ? (<>
            <label htmlFor={`fy-reply-${w.id}`} className="sr-only">Your reply</label>
            <Textarea id={`fy-reply-${w.id}`} data-act="reply-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000}
              placeholder="Your reply" className="min-h-20 w-full text-base" />
            <Button data-act="reply" className={big} disabled={busy || !text.trim()} onClick={() => run(() => api.reply(w.id, text))}>Send reply</Button>
          </>) : kind === 'check' ? (
            <Button data-act="done" className={big} disabled={busy} title="Done: a comment on the item, and it no longer waits for you" onClick={() => run(() => api.done(w.id))}>Done</Button>
          ) : (
            <p data-card-missing className="text-[13px] font-semibold text-swiss">Card missing: open the item to read the thread.</p>
          )}
        </div>
      )}
      {w.card && <Details card={w.card} />}
      <button type="button" data-part="link" onClick={() => onOpen(w.id)}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 border-t px-4 py-2 text-left text-[13px] hover:bg-muted">
        <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">Open the item: </span><b>{w.title}</b></span>
        <ArrowRightIcon aria-hidden weight="bold" className="size-4 shrink-0" />
      </button>
    </article>
  )
}

function ReviewCard({ r, onOpen, onSeen }: { r: ReviewEntry; onOpen: (id: string) => void; onSeen: () => void }) {
  const who = (n?: string) => (n ? ROLE_LABEL[n] || n : '')
  const imgs = r.artifacts.filter((a) => a.type.startsWith('image/')), rest = r.files - imgs.length
  return (
    <article data-to-review={r.id} className="min-w-0 border border-foreground bg-background">
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
