// The owner card (sy-z5lz) at the top of an item's detail: a clear box, read first. Each key in bold, its value as
// plain text (never Markdown: the card is what the owner reads, word for word); Link as a link. An invalid card shows
// what it could read and a small "card invalid: <reason>" note; an item that needs the owner with no card says
// "card missing". The parser is the one bin/bd and the Supervisor use (lib/owner-card.mjs, an identical copy).
// The card's last line is Item: the item's own URL (this board's origin + /?item=<id>, the link that opens it), made
// here, with a copy button; it wins over an Item line a lead wrote.
import { useRef, useState } from 'react'
import { KEYS, parseCard } from '@/lib/owner-card.mjs'
import { Viewer, fileRef, fileUrl } from '@/Markdown'

export type Card = ReturnType<typeof parseCard>

/** The link that opens an item on this board (App opens ?item=<id>). */
export const itemUrl = (id: string) => `${window.location.origin}/?item=${encodeURIComponent(id)}`

/** A copy-link button (40 px+ target). Where the clipboard is not allowed (an http page, an old phone), it shows the link
 *  in a field, selected, so the person copies it by hand. */
export function CopyLink({ url, className = '' }: { url: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle')
  const field = useRef<HTMLInputElement>(null)
  async function copy() {
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard')
      await navigator.clipboard.writeText(url)
      setState('copied'); window.setTimeout(() => setState('idle'), 1600)
    } catch {
      setState('select'); window.setTimeout(() => { field.current?.focus(); field.current?.select() }, 0)
    }
  }
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-2 ${className}`}>
      <button type="button" data-copy-link onClick={copy} aria-label="Copy the link to this item"
        className="inline-flex min-h-10 min-w-10 items-center border border-foreground bg-background px-3 text-xs font-semibold hover:bg-muted">
        {state === 'copied' ? 'Copied' : 'Copy link'}
      </button>
      {state === 'select' && (
        <input ref={field} readOnly value={url} data-copy-field aria-label="The link to this item: copy it"
          onFocus={(e) => e.currentTarget.select()} className="min-h-10 w-full min-w-0 border px-2 font-mono text-xs" />
      )}
    </span>
  )
}

export function OwnerCard({ card, needsYou, id }: { card: Card; needsYou: boolean; id: string }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!card.found) {
    if (!needsYou) return null
    return (
      <p data-owner-card="missing" className="border-b border-l-4 border-l-swiss px-4 py-2 text-xs font-semibold text-swiss md:px-5">
        card missing: this item needs you, but it does not say what it asks. Its role must add the owner card.
      </p>
    )
  }
  const keys = Object.keys(KEYS).filter((k) => k !== 'Item' && card.card && k in card.card)
  const url = itemUrl(id)
  return (
    <section data-owner-card={card.ok ? 'ok' : 'invalid'} aria-label="For you" className="border-b px-4 py-3 md:px-5">
      <div className="border-2 border-foreground">
        <h3 className="bg-foreground px-3 py-1 text-[11px] font-bold tracking-[0.1em] text-background uppercase">For you</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 text-[15px] leading-snug">
          {keys.map((k) => (
            <div key={k} data-key={k} className="contents">
              <dt className="font-bold whitespace-nowrap">{k}</dt>
              <dd className={`min-w-0 [overflow-wrap:anywhere] ${k === 'You' ? 'font-semibold text-swiss' : ''}`}>
                {k === 'Link' ? <CardLink value={card.card![k]} onOpen={setOpen} /> : card.card![k]}
              </dd>
            </div>
          ))}
          <div data-key="Item" className="contents">
            <dt className="font-bold whitespace-nowrap">Item</dt>
            <dd className="min-w-0">
              <span data-item-url className="block font-mono text-xs [overflow-wrap:anywhere] select-all">{url}</span>
              <CopyLink url={url} className="mt-1.5 w-full" />
            </dd>
          </div>
        </dl>
        {!card.ok && (
          <p data-owner-card-note className="border-t px-3 py-1.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            card invalid: {card.errors.join('; ')}
          </p>
        )}
      </div>
      <Viewer path={open} onClose={() => setOpen(null)} />
    </section>
  )
}

/** A URL opens in a new tab; a path the board can show (an artifact, a doc) opens in its viewer; anything else is text. */
function CardLink({ value, onOpen }: { value: string; onOpen: (p: string) => void }) {
  const v = value.trim().replace(/^`|`$/g, '')
  if (/^https?:\/\/[^\s<>"]+$/.test(v)) return <a href={v} target="_blank" rel="noreferrer noopener" className="underline decoration-swiss decoration-2 underline-offset-2">{v}</a>
  const ref = fileRef(v)
  if (ref && /\.(md|txt|json|png|jpg|webp|svg)$/.test(ref)) return <button type="button" onClick={() => onOpen(ref)} className="text-left underline decoration-swiss decoration-2 underline-offset-2 [overflow-wrap:anywhere]">{v}</button>
  if (ref) return <a href={fileUrl(ref)} target="_blank" rel="noreferrer" className="underline decoration-swiss decoration-2 underline-offset-2">{v}</a>
  return <>{value}</>
}
