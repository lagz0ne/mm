import { useEffect, useState } from 'react'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { ago } from '@/lib/board'
import { Embed } from '@/Markdown'
import { cn } from '@/lib/utils'

// Designs on an item (site/designs.mjs): the project's Doop frames the item links, as images the board's server fetched
// from Doop. One panel, a view per role: design (frames, open comments, history), requirement (designs per spec), QA
// (the design next to the built screen), and the human's summary (what waits for them). Read only.

interface Version { at: string; by: string; kind: string; width: number; height: number; htmlBytes: number }
interface Thread { id: string; from: string; text: string; at: string; element: boolean; waiting: boolean; replies: { from: string; text: string; at: string }[] }
interface Frame {
  id: string; name: string; canvas: { id: string; name: string }; how: 'link' | 'canvas' | 'name'; width: number; height: number; approval: string
  updatedAt: string | null; updatedBy: string; image: string; before: { image: string; at: string } | null; open: string | null
  change?: { versions: number; previous: (Omit<Version, 'htmlBytes'>) | null; resized?: boolean; bytes?: number } | null
  history?: Version[] | null; comments?: Thread[] | null
}
interface Child { id: string; title: string; status: string; assignee: string; frames: Frame[] }
interface DesignsData { id: string; available: boolean; why?: string; refs?: number; stale?: string; me?: string; doop?: string | null; frames: Frame[]; more?: number; missing?: string[]; children?: Child[] }
export interface BuiltFile { path: string }

const VIEWS = [
  { key: 'design', label: 'Design' },
  { key: 'requirement', label: 'Requirement' },
  { key: 'qa', label: 'QA' },
  { key: 'summary', label: 'Summary' },
] as const
type View = (typeof VIEWS)[number]['key']
const APPROVAL: Record<string, string> = { draft: 'draft', needs_review: 'needs review', ready_for_dev: 'ready to build' }
const HOW: Record<Frame['how'], string> = { link: 'linked on the item', canvas: 'from a linked canvas', name: 'its name names the item' }
const BUILT = /\.(html|png|jpg|webp|svg)$/

export function Designs({ id, tick, assignee, built, onOpen }: { id: string; tick: number; assignee?: string; built: BuiltFile[]; onOpen: (id: string) => void }) {
  const [d, setD] = useState<DesignsData | null>(null)
  const [view, setView] = useState<View | null>(null)
  useEffect(() => {
    let gone = false
    const load = () => fetch(`/api/designs/${id}`).then((r) => r.json()).then((x) => !gone && setD(x)).catch(() => {})
    load()
    // a change in Doop is no board event: look again every minute while the item is open
    const t = window.setInterval(load, 60000)
    return () => { gone = true; window.clearInterval(t) }
  }, [id, tick])
  useEffect(() => { setView(null) }, [id])
  if (!d || d.id !== id) return null
  const kids = (d.children || []).filter((c) => c.frames.length)
  if (!d.available) return (d.refs ? <Panel count={d.refs}><p className="text-xs text-muted-foreground">{d.why}</p></Panel> : null)
  if (!d.frames.length && !kids.length && !d.missing?.length) return null
  const v: View = view || (['design', 'requirement', 'qa'].includes(assignee || '') ? (assignee as View) : 'summary')
  return (
    <Panel count={d.frames.length + (d.more || 0) + kids.reduce((n, c) => n + c.frames.length, 0)} action={
      <div role="tablist" className="flex border border-foreground text-[11px] max-md:w-full max-md:text-xs">
        {VIEWS.map((x) => (
          <button key={x.key} role="tab" aria-selected={v === x.key} onClick={() => setView(x.key)}
            className={cn('px-2 py-0.5 font-semibold max-md:flex-1 max-md:px-1', v === x.key ? 'bg-foreground text-background' : 'hover:bg-muted')}>{x.label}</button>
        ))}
      </div>
    }>
      {d.stale && <p className="mb-2 text-[11px] text-muted-foreground">{d.stale}</p>}
      {v === 'design' && <DesignView d={d} />}
      {v === 'requirement' && <RequirementView d={d} onOpen={onOpen} />}
      {v === 'qa' && <QaView d={d} built={built.filter((f) => BUILT.test(f.path))} />}
      {v === 'summary' && <SummaryView d={d} />}
      {(d.more || 0) > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{d.more} more frame{d.more === 1 ? '' : 's'}: open them in Doop.</p>}
      {(d.missing?.length || 0) > 0 && <p className="mt-2 text-[11px] text-muted-foreground">Not found in Doop: <span className="font-mono">{d.missing!.join(', ')}</span> (gone, or on a canvas the design lead can't see).</p>}
    </Panel>
  )
}

function Panel({ count, action, children }: { count: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b px-4 py-3 md:px-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="text-[11px] font-bold tracking-[0.1em] uppercase">Designs · {count}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Head({ f }: { f: Frame }) {
  return (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs">
      <b className="[overflow-wrap:anywhere]">{f.name || 'Untitled frame'}</b>
      <span className="text-[11px] text-muted-foreground">{f.canvas.name} · {f.width}×{f.height}</span>
      <span className={cn('border px-1 text-[10px] font-semibold tracking-[0.06em] uppercase', f.approval === 'ready_for_dev' ? 'border-foreground bg-foreground text-background' : f.approval === 'needs_review' ? 'border-swiss text-swiss' : 'border-muted-foreground text-muted-foreground')}>
        {APPROVAL[f.approval] || f.approval}
      </span>
      {f.open
        ? <a href={f.open} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-[11px] font-semibold hover:underline max-md:min-h-11 max-md:text-xs"><ArrowSquareOutIcon />Open in Doop</a>
        : <span className="ml-auto text-[11px] text-muted-foreground" title="Doop's public name comes with the project's names (the gateway signs you in there)">Doop has no public address yet</span>}
    </div>
  )
}

function Picture({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [bad, setBad] = useState(false)
  if (bad) return <div className={cn('flex h-32 items-center justify-center border border-dashed text-[11px] text-muted-foreground', className)}>Doop could not render this frame just now.</div>
  return (
    <a href={src} target="_blank" rel="noreferrer" className={cn('block min-w-0 border border-foreground bg-muted/30', className)}>
      <img src={src} alt={alt} loading="lazy" onError={() => setBad(true)} className="mx-auto block max-h-[420px] w-auto max-w-full object-contain" />
    </a>
  )
}

function changeLine(f: Frame) {
  const c = f.change
  if (!c) return null
  if (!c.previous) return 'First version.'
  const parts = [`Changed ${f.updatedAt ? `${ago(f.updatedAt)} ago` : ''} by ${f.updatedBy || 'someone'}; the version before was by ${c.previous.by || 'someone'}, ${ago(c.previous.at)} ago`]
  if (c.resized) parts.push(`size ${c.previous.width}×${c.previous.height} → ${f.width}×${f.height}`)
  if (c.bytes) parts.push(`${c.bytes > 0 ? '+' : '−'}${(Math.abs(c.bytes) / 1024).toFixed(1)} KB of HTML`)
  parts.push(`${c.versions} earlier version${c.versions === 1 ? '' : 's'}`)
  return `${parts.join(' · ')}.`
}

function DesignView({ d }: { d: DesignsData }) {
  if (!d.frames.length) return <p className="text-xs text-muted-foreground">No designs on this item itself. See the Requirement view for its parts.</p>
  return (
    <div className="grid gap-5">
      {d.frames.map((f) => <FrameCard key={f.id} f={f} />)}
    </div>
  )
}

function FrameCard({ f }: { f: Frame }) {
  const [compare, setCompare] = useState(false)
  const open = (f.comments || [])
  return (
    <article className="min-w-0">
      <Head f={f} />
      {compare && f.before ? (
        <div className="grid grid-cols-2 gap-2">
          <figure><figcaption className="mb-0.5 text-[11px] text-muted-foreground">Before (the board saw it {ago(f.before.at)} ago)</figcaption><Picture src={f.before.image} alt={`${f.name}, before`} /></figure>
          <figure><figcaption className="mb-0.5 text-[11px] text-muted-foreground">Now</figcaption><Picture src={f.image} alt={f.name} /></figure>
        </div>
      ) : <Picture src={f.image} alt={f.name} />}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {changeLine(f)} {f.before && <button type="button" onClick={() => setCompare((x) => !x)} className="font-semibold text-foreground hover:underline max-md:min-h-11">{compare ? 'Hide before' : 'Compare with before'}</button>}
        <span className="ml-1" title={HOW[f.how]}>· {HOW[f.how]}</span>
      </p>
      {open.length > 0 && (
        <div className="mt-2">
          <h4 className="text-[11px] font-semibold">Open comments in Doop · {open.length}</h4>
          <ol className="mt-1 grid gap-1.5">{open.map((t) => <ThreadRow key={t.id} t={t} />)}</ol>
        </div>
      )}
      {(f.history?.length || 0) > 0 && (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer font-semibold">History · {f.change?.versions ?? f.history!.length} earlier version{(f.change?.versions ?? 0) === 1 ? '' : 's'}</summary>
          <ol className="mt-1 grid gap-0.5 text-muted-foreground">
            {f.history!.map((h) => <li key={h.at}><span className="font-mono">{h.at.slice(0, 16).replace('T', ' ')}</span> · {h.by || '—'}{h.kind ? ` (${h.kind})` : ''} · {h.width}×{h.height}</li>)}
          </ol>
          <p className="mt-1 text-muted-foreground">Restore or compare older versions in Doop.</p>
        </details>
      )}
    </article>
  )
}

function ThreadRow({ t }: { t: Thread }) {
  const last = t.replies[t.replies.length - 1]
  return (
    <li className={cn('border-l-2 pl-2 text-xs', t.waiting ? 'border-swiss' : 'border-muted-foreground')}>
      <span className="font-semibold">{t.from}</span> <span className="text-[11px] text-muted-foreground">{ago(t.at)} ago{t.element ? ' · on an element' : ''}</span>
      {t.waiting && <span className="ml-2 text-[10px] font-bold tracking-[0.06em] text-swiss uppercase">waits for you</span>}
      <p className="whitespace-pre-wrap break-words">{t.text}</p>
      {last && <p className="mt-0.5 text-[11px] text-muted-foreground"><span className="font-semibold">{last.from}</span>{t.replies.length > 1 ? ` (and ${t.replies.length - 1} more)` : ''}: <span className="whitespace-pre-wrap break-words">{last.text}</span></p>}
    </li>
  )
}

function Thumbs({ frames }: { frames: Frame[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {frames.map((f) => (
        <figure key={f.id} className="w-40 max-md:w-[calc(50%-0.25rem)]">
          <Picture src={f.image} alt={f.name} className="[&_img]:max-h-28" />
          <figcaption className="mt-0.5 truncate text-[11px]" title={f.name}>{f.name}</figcaption>
          {f.open && <a href={f.open} target="_blank" rel="noreferrer" className="text-[11px] font-semibold hover:underline">Open in Doop</a>}
        </figure>
      ))}
    </div>
  )
}

function RequirementView({ d, onOpen }: { d: DesignsData; onOpen: (id: string) => void }) {
  const kids = d.children || []
  return (
    <div className="grid gap-3">
      <div>
        <h4 className="mb-1 text-[11px] font-semibold">This item · {d.frames.length} design{d.frames.length === 1 ? '' : 's'}</h4>
        {d.frames.length ? <Thumbs frames={d.frames} /> : <p className="text-xs text-muted-foreground">None linked here.</p>}
      </div>
      {kids.length > 0 && (
        <div className="grid gap-2">
          <h4 className="text-[11px] font-semibold">Its parts</h4>
          {kids.map((c) => (
            <div key={c.id} className="border-t pt-2">
              <button type="button" onClick={() => onOpen(c.id)} className="mb-1 flex min-w-0 flex-wrap gap-x-2 text-left text-xs hover:underline max-md:min-h-11 max-md:items-center">
                <span className="font-mono text-[11px] text-muted-foreground">{c.id}</span>
                <span className={c.status === 'closed' ? 'line-through opacity-60' : ''}>{c.title}</span>
                <span className="text-[11px] text-muted-foreground">· {c.frames.length} design{c.frames.length === 1 ? '' : 's'}</span>
              </button>
              {c.frames.length > 0 && <Thumbs frames={c.frames} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function QaView({ d, built }: { d: DesignsData; built: BuiltFile[] }) {
  if (!d.frames.length) return <p className="text-xs text-muted-foreground">No designs on this item itself.</p>
  return (
    <div className="grid gap-4">
      {!built.length && <p className="text-xs text-muted-foreground">No built screen on this item yet. Files that commits naming this item add under code/ show here next to the design.</p>}
      {d.frames.map((f) => (
        <div key={f.id} className="min-w-0">
          <Head f={f} />
          <div className={cn('grid gap-2', built.length ? 'md:grid-cols-2' : 'grid-cols-1')}>
            <figure className="min-w-0"><figcaption className="mb-0.5 text-[11px] text-muted-foreground">Design</figcaption><Picture src={f.image} alt={f.name} /></figure>
            {built.length > 0 && <figure className="min-w-0"><figcaption className="mb-0.5 text-[11px] text-muted-foreground">Built</figcaption><Embed path={built[0].path} height={420} /></figure>}
          </div>
        </div>
      ))}
    </div>
  )
}

function SummaryView({ d }: { d: DesignsData }) {
  const all = [...d.frames, ...(d.children || []).flatMap((c) => c.frames)]
  const by = (s: string) => all.filter((f) => f.approval === s).length
  const waiting = d.frames.flatMap((f) => (f.comments || []).filter((t) => t.waiting).map((t) => ({ f, t })))
  const openCount = d.frames.reduce((n, f) => n + (f.comments?.length || 0), 0)
  const last = d.frames.filter((f) => f.updatedAt).sort((a, b) => (b.updatedAt! > a.updatedAt! ? 1 : -1))[0]
  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] border border-foreground text-xs">
        {[['Designs', all.length], ['Ready to build', by('ready_for_dev')], ['Need review', by('needs_review')], ['Open comments', openCount], ['Wait for you', waiting.length]].map(([k, n]) => (
          <div key={k} className="border-l px-2 py-1.5 first:border-l-0">
            <dt className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{k}</dt>
            <dd className={cn('text-lg font-bold', k === 'Wait for you' && Number(n) > 0 && 'text-swiss')}>{n}</dd>
          </div>
        ))}
      </dl>
      {last && <p className="text-[11px] text-muted-foreground">Last change: {last.name}, {ago(last.updatedAt!)} ago by {last.updatedBy || 'someone'}.</p>}
      {!d.me && <p className="text-[11px] text-muted-foreground">Name yourself (top right) to see the comments that wait for you.</p>}
      {waiting.length > 0 && (
        <div>
          <h4 className="mb-1 text-[11px] font-semibold">Comments waiting for you</h4>
          <ol className="grid gap-1.5">
            {waiting.map(({ f, t }) => (
              <li key={t.id} className="grid gap-0.5">
                <span className="text-[11px] text-muted-foreground">on {f.name} {f.open && <a href={f.open} target="_blank" rel="noreferrer" className="font-semibold text-foreground hover:underline">answer in Doop</a>}</span>
                <ol><ThreadRow t={t} /></ol>
              </li>
            ))}
          </ol>
        </div>
      )}
      {d.frames.length > 0 && <Thumbs frames={d.frames} />}
    </div>
  )
}
