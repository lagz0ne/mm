import { useContext, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type Issue } from '@/lib/api'
import { PRIORITIES, ROLES, ROLE_LABEL, ago } from '@/lib/board'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { AnnotateContext, Embed, Markdown, Viewer, fileUrl } from '@/Markdown'
import { ArrowSquareOutIcon, ArrowsInIcon, ArrowsOutIcon, FileTextIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'
import { ThreadPresence } from '@/Presence'
import { Designs } from '@/Designs'
import { usePhone } from '@/lib/phone'
import { headRefusal, isNonGoAsk, parseCard, youKind } from '@/lib/owner-card.mjs'
import { OwnerCard } from '@/OwnerCard'
import { CommentBody, WaitsOn } from '@/Message'

const STATUSES = ['open', 'in_progress', 'blocked', 'deferred'] as const
const NONE = '_none'

export function Detail({ id, tick, byId, creator, onClose, onOpen, onChanged }: {
  id: string | null; tick: number; byId: Map<string, Issue>; creator?: string
  onClose: () => void; onOpen: (id: string) => void; onChanged: () => void
}) {
  const phone = usePhone()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [flash, setFlash] = useState<number | null>(null)
  const personas = useContext(PersonaContext)
  // "#5" in any comment jumps to comment 5 of this item.
  const jump = (n: number) => {
    document.getElementById(`c-${id}-${n}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(n); window.setTimeout(() => setFlash(null), 1600)
  }
  const [wide, setWide] = useState(() => localStorage.getItem('detail-wide') === '1')
  const toggleWide = () => setWide((w) => { localStorage.setItem('detail-wide', w ? '0' : '1'); return !w })
  const [content, setContent] = useState<ContentFile[]>([])
  // how the owner gives the T2 go here (the public side only): the label, or a tap on Telegram (the ledger on)
  const [approval, setApproval] = useState<'label' | 'telegram' | undefined>()
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => { api.whoami().then((w) => setApproval(w.approval)).catch(() => {}) }, [])
  useEffect(() => setSent(null), [id])

  // Live updates reload the item; unsaved edits in the title or description are kept.
  const loaded = useRef<Issue | null>(null)
  const draft = useRef({ title, desc })
  draft.current = { title, desc }
  useEffect(() => {
    if (!id) { setIssue(null); loaded.current = null; return }
    let gone = false
    api.get(id).then((i) => {
      if (gone) return
      const prev = loaded.current
      const same = prev?.id === i.id
      if (!same || draft.current.title === prev.title) setTitle(i.title)
      if (!same || draft.current.desc === (prev.description || '')) setDesc(i.description || '')
      if (!same) { setComment(''); setEditing(false) }
      loaded.current = i
      setIssue(i)
    }).catch((e) => toast.error(`${id}: ${(e as Error).message}`))
    return () => { gone = true }
  }, [id, tick])

  useEffect(() => {
    if (!id) { setContent([]); return }
    let gone = false
    fetch(`/api/content/${id}`).then((r) => r.json()).then((d) => !gone && setContent(d.files || [])).catch(() => {})
    return () => { gone = true }
  }, [id, tick])

  async function run(what: () => Promise<unknown>) {
    setBusy(true)
    try { await what(); onChanged() } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }

  const i = issue && issue.id === id ? issue : null
  const waitsOn = (i?.dependencies || []).filter((d) => d.dependency_type === 'blocks')
  const parent = (i?.dependencies || []).find((d) => d.dependency_type === 'parent-child')
  const unblocks = i ? [...byId.values()].filter((x) =>
    (x.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === i.id)) : []
  const children = i ? [...byId.values()].filter((x) => x.parent === i.id) : []
  const closed = i?.status === 'closed'
  // the T2 go, for the owner on the public side: a signed-off t2 without approved
  // the owner card (sy-z5lz): read first, in its own box; the description below it without the card
  const card = parseCard(i?.description, i?.labels || [], i?.id)
  // sy-t9tg: a non-go ask (You: Reply:/Check:/Nothing) never gets Approve or Not now, only its own action (Reply, Done)
  const t2go = !!i && !!approval && !!i.labels?.includes('t2') && !!i.labels?.includes('signed-off') && !i.labels?.includes('approved') && !isNonGoAsk(card.card)
  // sy-hzmu: the card names a head review did not sign off (the server refuses the go anyway): the reason, no Approve
  const headWhy = t2go ? headRefusal(i!.description, i!.labels || []) : null
  const approvable = t2go && !headWhy
  // the owner's answer the card asks for (sy-t9tg), on the public side: a Reply box or Done
  const answer = youKind(card.card?.You ?? '')

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className={cn('gap-0 overflow-x-hidden overflow-y-auto p-0 data-[side=right]:sm:max-w-none',
        wide ? 'data-[side=right]:w-screen' : 'data-[side=right]:w-[min(1200px,94vw)]', 'max-md:data-[side=right]:w-screen max-md:data-[side=right]:border-l-0')}>
        {!i ? <div className="p-6 text-xs text-muted-foreground">Loading…</div> : (
          <AnnotateContext.Provider value={{ itemId: i.id, comments: i.comments || [],
            post: async (text) => { await api.comment(i.id, text); onChanged() },
            revOf: (p) => content.find((f) => f.path === p)?.commits[0]?.short }}>
            <div className="relative border-t-4 border-b border-foreground px-4 pt-3 pr-14 pb-3 md:px-5 md:pt-4 md:pr-24">
              <button type="button" onClick={toggleWide} title={wide ? 'Narrower' : 'Full width'}
                className="absolute top-3 right-11 flex size-7 items-center justify-center hover:bg-muted max-md:hidden">
                {wide ? <ArrowsInIcon /> : <ArrowsOutIcon />}
              </button>
              <SheetDescription className="flex flex-wrap gap-x-3 font-mono text-[11px]">
                <span>{i.id}</span><span>{i.issue_type}</span><span>by {i.created_by || i.owner || creator || '—'}</span><span>{ago(i.updated_at)} ago</span>
              </SheetDescription>
              <SheetTitle className="sr-only">{i.title}</SheetTitle>
              {phone ? (
                // a phone: the whole title, wrapped (a one-line input cuts it); Enter still saves, no new line
                <Textarea data-big value={title} onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))} rows={1}
                  onBlur={() => title.trim() && title !== i.title && run(() => api.patch(i.id, { title: title.trim() }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                  aria-label="Title" className="mt-1 min-h-0 resize-none border-0 px-0 py-1 text-xl leading-snug font-bold tracking-tight shadow-none [field-sizing:content] focus-visible:ring-0 dark:bg-transparent" />
              ) : (
              <Input data-big value={title} onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() && title !== i.title && run(() => api.patch(i.id, { title: title.trim() }))}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                aria-label="Title" className="mt-1 h-auto border-0 px-0 text-xl md:text-xl font-bold tracking-tight shadow-none focus-visible:ring-0 dark:bg-transparent" />)}
            </div>

            <OwnerCard card={card} needsYou={!closed && !!i.labels?.includes('needs-you')} id={i.id} />
            {/* the owner's answer to a card that asks no go (sy-t9tg): Reply or Done, as on the Waiting list */}
            {!!approval && !closed && card.ok && !!i.labels?.includes('needs-you') && (answer === 'reply' || answer === 'check') && (
              <OwnerAnswer id={i.id} kind={answer} onDone={onChanged} />
            )}

            <div className="grid border-b md:grid-cols-3">
              <Field label="Status">
                {closed ? <span className="text-xs font-semibold">closed</span> : (
                  <Select value={i.status} onValueChange={(v) => run(() => api.patch(i.id, { status: v }))} disabled={busy}>
                    <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace('_', ' ')}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="Role">
                <Select value={ROLES.includes(i.assignee as never) ? i.assignee : NONE} disabled={busy}
                  onValueChange={(v) => run(() => api.patch(i.id, { assignee: v === NONE ? '' : v }))}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Priority">
                <Select value={String(i.priority)} disabled={busy} onValueChange={(v) => run(() => api.patch(i.id, { priority: Number(v) }))}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={String(p)}>P{p}{p === 0 ? ' · urgent' : ''}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>

            <div className="flex flex-wrap gap-2 border-b px-4 py-3 md:px-5">
              {closed ? (
                <>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.reopen(i.id))}>Reopen</Button>
                </>
              ) : (
                <>
                  {i.status !== 'in_progress' && <Button size="sm" disabled={busy} onClick={() => run(() => api.patch(i.id, { status: 'in_progress' }))}>Start</Button>}
                  {i.status !== 'blocked' && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.patch(i.id, { status: 'blocked' }))}>Block</Button>}
                  {i.status !== 'open' && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.patch(i.id, { status: 'open' }))}>Back to open</Button>}
                  {approvable && approval === 'telegram' && <Button size="sm" disabled={busy} title="With the ledger on, only your tap on Telegram signs the T2 go: this sends the item there"
                    onClick={() => run(async () => { setSent(null); const d = await api.approveOnTelegram(i.id); setSent(d.title); toast.success(d.title) })}>Approve on Telegram</Button>}
                  {approvable && approval === 'label' && <Button size="sm" disabled={busy} title="The T2 go: the board adds approved as you, and says so on the item"
                    onClick={() => run(async () => { setSent(null); const d = await api.approve(i.id); setSent('Approved on the board.'); toast.success(d.title) })}>Approve: this is your go</Button>}
                  {approvable && <Button size="sm" variant="outline" disabled={busy} title="Not now: a comment on the item, and it no longer waits for you"
                    onClick={() => run(async () => { const d = await api.notNow(i.id); toast.success(d.title) })}>Not now</Button>}
                  <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => run(() => api.close(i.id, 'Closed from board'))}>Close</Button>
                </>
              )}
            </div>
            {headWhy && (
              <p className="border-b border-l-4 border-l-swiss px-5 py-2 text-[11px] font-semibold text-swiss [overflow-wrap:anywhere]" data-head-refused="">
                No go yet: {headWhy}. Review signs off the head the card names.
              </p>
            )}
            {approvable && approval === 'telegram' && (
              <p className="border-b px-5 py-2 text-[11px] text-muted-foreground">
                {sent || 'The approval is signed on Telegram: Approve sends this item to your Telegram, and your tap there is the T2 go. Nothing is approved here.'}
              </p>
            )}
            {approval === 'label' && (approvable || sent) && (
              <p className="border-b px-5 py-2 text-[11px] text-muted-foreground" data-approved={sent ? '' : undefined}>
                {sent || 'Review signed this off. Approve is your T2 go: the board adds approved as you, and says so on the item. Telegram\'s Approve does the same; whichever comes first counts.'}
              </p>
            )}

            <Section label="Description" action={!editing && <button className="text-[11px] font-semibold hover:underline" onClick={() => setEditing(true)}>Edit</button>}>
              {editing ? (
                <>
                  <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={8} autoFocus
                    placeholder="What and why. Acceptance criteria. Markdown." className="min-h-24 font-mono text-xs" />
                  <div className="mt-2 flex gap-2">
                    <Button size="xs" disabled={busy || desc === (i.description || '')}
                      onClick={() => run(async () => { await api.patch(i.id, { description: desc }); setEditing(false) })}>Save</Button>
                    <Button size="xs" variant="ghost" onClick={() => { setDesc(i.description || ''); setEditing(false) }}>Cancel</Button>
                  </div>
                </>
              ) : card.found ? (card.rest.trim() ? <Markdown>{card.rest}</Markdown> : null)
                : i.description ? <Markdown>{i.description}</Markdown>
                : <button className="text-xs text-muted-foreground hover:underline" onClick={() => setEditing(true)}>Add a description</button>}
              {i.close_reason && <p className="mt-2 text-xs text-muted-foreground">Closed: {i.close_reason}</p>}
            </Section>

            <Workers id={i.id} tick={tick} />

            <Designs id={i.id} tick={tick} assignee={i.assignee} built={content} onOpen={onOpen} />

            <Artifacts id={i.id} tick={tick} />

            {content.length > 0 && (
              <Section label={`Content · ${content.length}`}>
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                  {[...content].sort(byKind).map((f) => (
                    <div key={f.path} className="min-w-0">
                      <div className="mb-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                        {f.commits.slice(0, 3).map((c) => <span key={c.sha} className="font-mono" title={`${c.subject} · ${c.date}`}>{c.short} {c.status === 'A' ? 'added' : 'changed'}</span>)}
                        {f.commits.length > 3 && <span>+{f.commits.length - 3} more</span>}
                      </div>
                      {/\.(html|md|svg|png|jpg|webp)$/.test(f.path)
                        ? <Embed path={f.path} />
                        : <span className="font-mono text-xs">{f.path}</span>}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {(parent || waitsOn.length > 0 || unblocks.length > 0 || children.length > 0) && (
              <Section label="Links">
                <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1 text-xs max-md:gap-y-2 max-md:text-[13px]">
                  {parent && <Links label="Part of" items={[{ id: parent.id!, title: parent.title, status: parent.status }]} onOpen={onOpen} />}
                  {waitsOn.length > 0 && <Links label="Waits on" items={waitsOn.map((d) => ({ id: d.id!, title: d.title, status: d.status }))} onOpen={onOpen} />}
                  {unblocks.length > 0 && <Links label="Unblocks" items={unblocks} onOpen={onOpen} />}
                  {children.length > 0 && <Links label="Children" items={children} onOpen={onOpen} />}
                </dl>
              </Section>
            )}

            <Section label={`Thread · ${i.comments?.length || 0}`}>
              <WaitsOn comments={i.comments || []} onRef={jump} />
              <ol className="grid gap-3">
                {groupComments(i.comments || []).map((g) => {
                  const kind = authorKind(g.author)
                  const per = kind === 'lead' ? personaOf(personas, g.author) : null
                  const first = g.items[0].n, last = g.items[g.items.length - 1].n
                  return (
                    <li key={g.items[0].c.id} className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2',
                      kind === 'human' && 'ml-8 border-l-4 border-foreground bg-muted px-3 py-2 md:ml-16',
                      kind === 'lead' && 'mr-4 border-l-2 pl-3 md:mr-16',
                      kind === 'system' && 'mx-4 border-l border-dashed border-muted-foreground pl-3 text-muted-foreground md:mx-16')}
                      style={per ? { borderLeftColor: per.color } : undefined}>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                        {kind === 'lead'
                          ? <><Avatar actor={g.author} size="sm" /><b className="text-[12px]" style={{ color: per?.color }}>{per?.worker ? per.label : per?.name}</b>
                              <span className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{leadLabel(g.author)}</span></>
                          : kind === 'human' ? <b>{g.author}</b> : <span className="text-[11px] italic">{g.author}</span>}
                        <span className="font-mono text-[11px] text-muted-foreground">{first === last ? `#${first}` : `#${first}–${last}`}</span>
                      </span>
                      <span className="text-[11px] text-muted-foreground" title={g.items[0].c.created_at}>{ago(g.items[0].c.created_at)} ago</span>
                      <div className="col-span-2 mt-0.5 grid gap-1.5">
                        {g.items.map(({ c, n }) => (
                          <div key={c.id} id={`c-${i.id}-${n}`} className={cn('grid grid-cols-[2rem_minmax(0,1fr)] scroll-mt-4', flash === n && 'bg-swiss/10')}>
                            <a href={`#c-${n}`} onClick={(e) => { e.preventDefault(); navigator.clipboard?.writeText(`#${n}`); toast.success(`Copied #${n}: use it to refer to this comment`) }}
                              title="Copy reference" className="pt-0.5 font-mono text-[11px] text-muted-foreground hover:text-swiss">#{n}</a>
                            {kind === 'lead'
                              ? <CommentBody text={c.text} author={c.author} onRef={jump} />
                              : <Markdown className={cn(kind === 'system' && 'text-xs')} onRef={jump}>{c.text}</Markdown>}
                          </div>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ol>
              <ThreadPresence item={i.id} />
              <form className="mt-3 grid gap-2" onSubmit={(e) => {
                e.preventDefault()
                const text = comment.trim()
                if (text) run(async () => { await api.comment(i.id, text); setComment('') })
              }}>
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3}
                  placeholder="Write to the lead. Refer to earlier comments as #3. Markdown; paths like docs/design/x.html embed. Ctrl+Enter sends." className="text-[13px]"
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit() }} />
                <Button size="sm" type="submit" disabled={busy || !comment.trim()} className="justify-self-end max-md:px-6">Send</Button>
              </form>
            </Section>
          </AnnotateContext.Provider>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-1 border-t px-4 py-1.5 first:border-t-0 max-md:grid-cols-[6rem_minmax(0,1fr)] md:items-stretch md:border-t-0 md:border-l md:px-3 md:py-2.5 md:first:border-l-0 md:first:pl-5">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  )
}

interface ContentFile { path: string; commits: { sha: string; short: string; subject: string; date: string; status: string }[] }
const KIND = (p: string) => (p.endsWith('.html') ? 0 : p.endsWith('.md') ? 1 : 2)
const byKind = (a: ContentFile, b: ContentFile) => KIND(a.path) - KIND(b.path) || a.path.localeCompare(b.path)

function Section({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b px-4 py-3 md:px-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[11px] font-bold tracking-[0.1em] uppercase">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Links({ label, items, onOpen }: { label: string; items: { id: string; title?: string; status?: string }[]; onOpen: (id: string) => void }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="grid gap-0.5">
        {items.map((x) => (
          <button key={x.id} onClick={() => onOpen(x.id)} className="flex min-w-0 gap-2 text-left hover:underline max-md:min-h-9 max-md:items-baseline">
            <span className="font-mono text-[11px] text-muted-foreground">{x.id}</span>
            <span className={cn('min-w-0 [overflow-wrap:anywhere]', x.status === 'closed' && 'line-through opacity-60')}>{x.title}</span>
          </button>
        ))}
      </dd>
    </>
  )
}

/** Who wrote a comment: a lead (or one of its workers, `<role>/...`), the system (wake, smoke), or a human. */
function authorKind(author: string): 'lead' | 'system' | 'human' {
  const role = author.split('/')[0]
  if ((ROLES as readonly string[]).includes(role)) return 'lead'
  if (['wake', 'watchdog', 'smoke', 'ui', 'beads', ''].includes(author)) return 'system'
  return 'human'
}
function leadLabel(author: string) {
  const [role, sub] = author.split('/')
  return `${ROLE_LABEL[role] || role} lead${sub ? ` · ${sub}` : ''}`
}

/** Consecutive comments from the same author within a few minutes form one group; each keeps its #number. */
const GROUP_GAP_MS = 5 * 60 * 1000
function groupComments(list: { id: string; author: string; text: string; created_at: string }[]) {
  const groups: { author: string; items: { c: (typeof list)[number]; n: number }[] }[] = []
  list.forEach((c, k) => {
    const g = groups[groups.length - 1]
    const prev = g?.items[g.items.length - 1]?.c
    if (g && g.author === c.author && new Date(c.created_at).getTime() - new Date(prev!.created_at).getTime() < GROUP_GAP_MS) g.items.push({ c, n: k + 1 })
    else groups.push({ author: c.author, items: [{ c, n: k + 1 }] })
  })
  return groups
}

interface ArtifactFile { name: string; path: string; type: string; size: number; mtime: string }
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/** The item's artifacts (bin/artifact: artifacts/<id>/<name> in the project root): images as a strip of thumbnails
 *  (a tap: full size), the rest as chips (.md and .svg: the dialog; .html and others: a new tab). */
function Artifacts({ id, tick }: { id: string; tick: number }) {
  const [files, setFiles] = useState<ArtifactFile[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    fetch(`/api/artifacts/${id}`).then((r) => r.json()).then((d) => !gone && setFiles(d.files || [])).catch(() => !gone && setFiles([]))
    return () => { gone = true }
  }, [id, tick])
  if (!files.length) return null
  const isImg = (f: ArtifactFile) => /\.(png|jpg|webp)$/.test(f.name)
  const images = files.filter(isImg), others = files.filter((f) => !isImg(f))
  const chip = 'flex min-h-10 max-w-full min-w-0 items-center gap-1.5 border border-foreground px-2.5 text-xs hover:bg-muted'
  return (
    <Section label={`Artifacts · ${files.length}`}>
      {images.length > 0 && (
        <ul data-artifact-thumbs className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2">
          {images.map((f) => (
            <li key={f.name} className="min-w-0">
              <button type="button" onClick={() => setOpen(f.path)} title={`${f.name} · ${bytes(f.size)}`} data-artifact={f.name}
                className="block w-full min-w-0 border border-foreground text-left hover:outline-2 hover:outline-swiss">
                <img src={fileUrl(f.path)} alt={f.name} loading="lazy" className="aspect-[4/3] w-full bg-muted object-cover object-top" />
                <span className="block truncate border-t border-foreground px-1.5 py-1 font-mono text-[11px]">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className={cn('flex flex-wrap gap-2', images.length > 0 && 'mt-2')}>
          {others.map((f) => (
            <li key={f.name} className="max-w-full min-w-0">
              {/\.(md|svg)$/.test(f.name)
                ? <button type="button" onClick={() => setOpen(f.path)} className={chip} data-artifact={f.name} title={bytes(f.size)}>
                    <FileTextIcon className="shrink-0" /><span className="truncate font-mono">{f.name}</span></button>
                : <a href={fileUrl(f.path)} target="_blank" rel="noreferrer" className={chip} data-artifact={f.name} title={bytes(f.size)}>
                    <ArrowSquareOutIcon className="shrink-0" /><span className="truncate font-mono">{f.name}</span></a>}
            </li>
          ))}
        </ul>
      )}
      <Viewer path={open} onClose={() => setOpen(null)} />
    </Section>
  )
}

interface WorkerInfo { id: string; status: string; created: string; activity: string[] }
interface WorkInfo { branch: string | null; landed: boolean; commits: { sha: string; author: string; date: string; subject: string }[]; stat: string; workers: WorkerInfo[] }

/** What the code lead's workers did on this item: status, unlanded commits, and their activity (humans only). */
function Workers({ id, tick }: { id: string; tick: number }) {
  const [w, setW] = useState<WorkInfo | null>(null)
  const running = !!w?.workers.some((x) => x.status === 'running')
  useEffect(() => {
    let gone = false
    const load = () => fetch(`/api/workers/${id}`).then((r) => r.json()).then((d) => !gone && setW(d)).catch(() => {})
    load()
    const t = running ? window.setInterval(load, 5000) : undefined
    return () => { gone = true; window.clearInterval(t) }
  }, [id, tick, running])
  if (!w || w.workers.length === 0) return null
  return (
    <section className="min-w-0 border-b px-4 py-3 md:px-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-[11px] font-bold tracking-[0.1em] uppercase">Work · {w.workers.length} worker{w.workers.length > 1 ? 's' : ''}</h3>
        <span className="text-[11px] text-muted-foreground">
          {w.branch ? <>branch <span className="font-mono">{w.branch}</span> · {w.commits.length} commit{w.commits.length === 1 ? '' : 's'} not yet on main</> : 'landed on main'}
        </span>
        {running && <span className="flex items-center gap-1 text-[11px] font-semibold text-swiss"><span className="size-1.5 animate-pulse bg-swiss" />working</span>}
      </div>
      {w.commits.length > 0 && (
        <ol className="mb-2 grid gap-0.5 text-xs">
          {w.commits.map((c) => <li key={c.sha}><span className="font-mono text-muted-foreground">{c.sha}</span> {c.subject} <span className="text-[11px] text-muted-foreground">· {c.author}</span></li>)}
        </ol>
      )}
      {w.stat && <pre className="mb-2 overflow-x-auto bg-muted/40 px-3 py-2 font-mono text-[11px] leading-snug">{w.stat}</pre>}
      {w.workers.map((x) => (
        <details key={x.id} open={x.status === 'running'} className="border-t">
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 py-1.5 text-xs hover:bg-muted max-md:min-h-11">
            <span className={cn('size-2', x.status === 'running' ? 'animate-pulse bg-swiss' : 'bg-foreground')} />
            <span className="font-mono">{x.id}</span><span className="text-muted-foreground">{x.status} · started {x.created}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">activity (latest {x.activity.length} lines)</span>
          </summary>
          <pre ref={(el) => { if (el && x.status === 'running') el.scrollTop = el.scrollHeight }}
            className="max-h-80 overflow-auto bg-foreground px-3 py-2 font-mono text-[11px] leading-snug text-background">{x.activity.join('\n')}</pre>
        </details>
      ))}
      <p className="mt-1 text-[11px] text-muted-foreground">The code lead never sees this; it reads only the worker's final report.</p>
    </section>
  )
}

/** The owner's answer to a card that asks no go (sy-t9tg), the same routes as the Waiting list: "Reply: …" a reply box
 *  (a comment as the owner), "Check: …" Done (needs-you removed). The server checks the owner and the item again. */
function OwnerAnswer({ id, kind, onDone }: { id: string; kind: 'reply' | 'check'; onDone: () => void }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false)
  const go = async (what: () => Promise<{ title: string }>) => {
    setBusy(true)
    try { const d = await what(); toast.success(d.title); setText(''); onDone() } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div data-owner-answer={kind} className="flex flex-wrap items-end gap-2 border-b px-4 py-3 md:px-5">
      {kind === 'reply' ? (
        <>
          <label htmlFor={`owner-reply-${id}`} className="w-full text-[11px] font-semibold">Your reply</label>
          <Textarea id={`owner-reply-${id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} className="min-h-16 flex-1" />
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => go(() => api.reply(id, text))}>Send</Button>
        </>
      ) : (
        <Button size="sm" disabled={busy} title="Done: a comment on the item, and it no longer waits for you" onClick={() => go(() => api.done(id))}>Done</Button>
      )}
    </div>
  )
}
