// Structured content on the board (sy-rfup, step 1; the format: lib/structured.mjs, the schemas bin/lib/schemas/): a
// block shows as today's readable message, Task or card (its typed fields as the same keys), then its parts, each by
// its type: text as text, markdown as now, a mermaid diagram drawn, html in a sandboxed frame (no scripts, no same
// origin), svg and images as images (an <img> never runs a script), a table as a table, a log as a scrolled block; a
// part that points to an artifact shows that file. "Original" shows the block as it was written (its JSON).
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Embed, Markdown, Mermaid, Viewer, fileRef, fileUrl } from '@/Markdown'
import { cardKeys, messageKeys, readBlock, taskKeys, validate, type Part } from '@/lib/structured.mjs'

const linkOf = (p: string) => fileRef(p) || p

/** One part, by its type. */
export function PartView({ part, onRef }: { part: Part; onRef?: (n: number) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const a = part.artifact ? linkOf(part.artifact) : null
  let body: ReactNode
  switch (part.type) {
    case 'text': body = <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{part.text}</p>; break
    case 'markdown': body = <Markdown onRef={onRef}>{part.markdown || ''}</Markdown>; break
    case 'mermaid': body = <Mermaid source={part.mermaid || ''} />; break
    case 'html':
      body = a ? <Embed path={a} />
        : <iframe title={part.title || 'HTML part'} sandbox="" referrerPolicy="no-referrer" srcDoc={part.html} className="h-72 w-full border border-foreground bg-white" data-part-frame />
      break
    case 'svg':
      body = <img alt={part.title || 'SVG part'} className="block max-h-80 w-auto max-w-full object-contain object-left" src={a ? fileUrl(a) : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(part.svg || '')}`} />
      break
    case 'image': body = <img alt={part.alt || ''} className="block max-h-[28rem] w-auto max-w-full border object-contain object-left" src={fileUrl(a || '')} />; break
    case 'table':
      body = (
        <div className="max-w-full overflow-x-auto">
          <table className="w-max min-w-full border-collapse text-[12px]">
            <thead><tr>{(part.columns || []).map((c, k) => <th key={k} className="border-b border-foreground px-2 py-1 text-left font-semibold">{c}</th>)}</tr></thead>
            <tbody>{(part.rows || []).map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className={cn('border-b px-2 py-0.5 align-top', typeof c === 'number' && 'text-right tabular-nums')}>{c === null ? '' : String(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
      break
    case 'log':
      body = a ? <button type="button" className="md-link font-mono text-[12px]" onClick={() => setOpen(a)}>{part.artifact}</button>
        : <pre className="max-h-64 overflow-auto bg-muted px-2 py-1 font-mono text-[11px] leading-snug">{part.log}</pre>
      break
    default: body = <code className="text-[11px] text-muted-foreground">{JSON.stringify(part)}</code>
  }
  return (
    <figure data-part={part.type} className="m-0 min-w-0">
      {part.title && <figcaption className="mb-0.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{part.title}</figcaption>}
      {body}
      {open && <Viewer path={open} onClose={() => setOpen(null)} />}
    </figure>
  )
}

/** The parts of a block, in order. */
export function Parts({ parts, onRef, className }: { parts: unknown; onRef?: (n: number) => void; className?: string }) {
  const ps = Array.isArray(parts) ? (parts as Part[]).filter((p) => p && typeof p === 'object') : []
  if (!ps.length) return null
  return <div className={cn('grid min-w-0 gap-2 text-[13px]', className)} data-parts={ps.length}>{ps.map((p, k) => <PartView key={k} part={p} onRef={onRef} />)}</div>
}

/** "Original": the block as it was written. */
export function Original({ raw, className }: { raw: string; className?: string }) {
  const [shown, setShown] = useState(false)
  return (
    <div className={cn('min-w-0', className)}>
      <button type="button" aria-expanded={shown} onClick={() => setShown(!shown)} data-original-toggle
        className="text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:underline">{shown ? 'Hide original' : 'Original'}</button>
      {shown && <pre data-original className="mt-1 max-h-80 overflow-auto bg-muted px-2 py-1 font-mono text-[11px] leading-snug">{raw}</pre>}
    </div>
  )
}

const NAME: Record<string, string> = { message: 'Message', task: 'Task', card: 'Owner card' }
/** A block inside Markdown (a description, a person's comment): its keys as a list, its parts, Original. One that
 * cannot be read shows as its code, with the reason. */
export function StructuredBlock({ kind, code, onRef }: { kind: string; code: string; onRef?: (n: number) => void }) {
  const raw = `\`\`\`mm-${kind} v1\n${code.replace(/\n$/, '')}\n\`\`\``
  const b = readBlock(raw)
  if (!b || b.errors.length || !b.data || !(kind in NAME)) return <pre><code>{code}</code></pre>
  const keys = kind === 'task' ? taskKeys(b.data) : kind === 'card' ? cardKeys(b.data) : messageKeys(b.data).keys
  const errors = validate(kind as 'message' | 'task' | 'card', b.data)
  return (
    <section data-structured={kind} className="my-2 grid min-w-0 gap-1.5 border-l-2 border-foreground pl-3">
      <h4 className="text-[11px] font-bold tracking-[0.1em] uppercase">{NAME[kind]}{kind === 'message' && b.data.intent ? ` · ${b.data.intent} → ${b.data.to ?? ''}` : ''}</h4>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[13px] max-md:grid-cols-1">
        {Object.entries(keys).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase max-md:mt-1">{k}</dt>
            <dd className={cn('min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]', k === 'Verify' && 'font-mono text-[12px]')}>{v}</dd>
          </div>
        ))}
      </dl>
      <Parts parts={b.data.parts} onRef={onRef} />
      {errors.length > 0 && <p data-structured-invalid className="text-[11px] text-swiss [overflow-wrap:anywhere]">invalid: {errors.slice(0, 3).join('; ')}{errors.length > 3 ? ` (+${errors.length - 3})` : ''}</p>}
      <Original raw={raw} />
    </section>
  )
}
