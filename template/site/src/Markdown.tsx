import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowsOutIcon, ArrowSquareOutIcon, ChatTeardropTextIcon, XIcon } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// Files the board can show: things the leads write under code/ (spec, design docs, mockups).
// A reference is a path like `code/docs/design/x.html` / `docs/design/x.md`, or a preview.<domain>/<project>-design link.
const PREVIEW = /^https?:\/\/preview\.[\w.-]+\/[\w-]+-design\/([\w.-]+\.html)$/
const PATH = /^(?:code\/)?((?:docs|public|test|src)\/[\w./-]+\.(?:html|md|svg|png|jpg|webp))$/

/** Project-relative path under code/ for a link or inline-code text, if the board can show it. */
export function fileRef(s: string): string | null {
  const t = s.trim().replace(/^\.\//, '')
  const p = PREVIEW.exec(t)
  if (p) return `docs/design/${p[1]}`
  const m = PATH.exec(t)
  return m ? m[1] : null
}
export const fileUrl = (p: string, rev?: string) => `/files/${p.split('/').map(encodeURIComponent).join('/')}${rev ? `?rev=${rev}` : ''}`

function refsIn(md: string): string[] {
  const found = new Set<string>()
  for (const m of md.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)|(https?:\/\/preview\.[\w.-]+\/\S+?\.html)/g)) {
    const r = fileRef(m[1] || m[2] || m[3] || '')
    if (r && /\.(html|svg|png|jpg|webp)$/.test(r)) found.add(r)
  }
  return [...found]
}

/** Markdown with GitHub extensions. Embeddable files it mentions are shown underneath it (mockups, images). */
/** Turn bare project paths in prose into inline code, so they become clickable (fenced blocks are left alone). */
function linkPaths(md: string) {
  return md.split(/(```[\s\S]*?```)/).map((part, i) => (i % 2 ? part
    : part.replace(/(^|[\s(,;])((?:code\/)?(?:docs|public|test|src)\/[\w./-]+\.(?:md|html|svg|png|jpg|webp))(?=[\s),.;:]|$)/gm, '$1`$2`'))).join('')
}

export function Markdown({ children: raw, embeds = true, className, onRef }: { children: string; embeds?: boolean; className?: string; onRef?: (n: number) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  // "#12" refers to comment 12 of the same thread; it becomes a link when the caller can jump to it.
  const children = onRef ? linkPaths(raw).replace(/(^|[\s(,;])#(\d{1,4})\b/g, '$1[#$2](#ref-$2)') : linkPaths(raw)
  const refs = embeds ? refsIn(children) : []
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href = '', children: c }) => {
          const ref = /^#ref-(\d+)$/.exec(href)
          if (ref && onRef) return <button type="button" className="md-link font-mono" onClick={() => onRef(Number(ref[1]))}>{c}</button>
          const r = fileRef(href)
          if (r) return <button type="button" className="md-link" onClick={() => setOpen(r)}>{c}</button>
          return <a href={href} target="_blank" rel="noreferrer">{c}</a>
        },
        // ```mermaid blocks render as diagrams (server-side); <pre> is dropped around them.
        pre: ({ children: c }) => {
          const kid = Array.isArray(c) ? c[0] : c
          const k = kid as { props?: { className?: string; children?: unknown } } | undefined
          if (k?.props?.className?.includes('language-mermaid')) return <Mermaid source={String(k.props.children ?? '').replace(/\n$/, '')} />
          return <pre>{c}</pre>
        },
        code: ({ className: cls, children: c }) => {
          const text = String(c ?? '')
          const r = !cls && !text.includes('\n') ? fileRef(text) : null
          if (r) return <button type="button" className="md-link font-mono text-[0.9em]" onClick={() => setOpen(r)}>{text}</button>
          return <code className={cls}>{c}</code>
        },
      }}>{children}</ReactMarkdown>
      {refs.map((r) => <Embed key={r} path={r} className="mt-2" />)}
      <Viewer path={open} onClose={() => setOpen(null)} />
    </div>
  )
}

/** Inline preview of a file: HTML/images rendered at desktop width and scaled to fit; markdown rendered. */
export function Embed({ path, rev, className, height = 340 }: { path: string; rev?: string; className?: string; height?: number }) {
  const [full, setFull] = useState(false)
  const isMd = path.endsWith('.md')
  return (
    <figure className={cn('min-w-0 overflow-hidden border border-foreground', className)}>
      <figcaption className="flex items-center gap-2 border-b border-foreground px-2 py-1 text-[11px]">
        <span className="truncate font-mono">{path}</span>
        {rev && <span className="font-mono text-muted-foreground">@{rev.slice(0, 7)}</span>}
        <a href={fileUrl(path, rev)} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 hover:underline">
          <ArrowSquareOutIcon />Open
        </a>
        <button type="button" onClick={() => setFull(true)} className="flex items-center gap-1 font-semibold hover:underline">
          <ArrowsOutIcon />Fullscreen
        </button>
      </figcaption>
      {isMd ? <MdFile path={path} rev={rev} className="max-h-[340px] overflow-y-auto px-3 py-2" /> : <Scaled path={path} rev={rev} height={height} />}
      <Viewer path={full ? path : null} rev={rev} onClose={() => setFull(false)} />
    </figure>
  )
}

/** Fullscreen view of a file. */
// Commenting on designs: the item a viewer belongs to, its thread, and how to post to it (set by the item detail).
export interface AnnotateTarget { itemId: string; comments: { author: string; text: string; created_at: string }[]; post: (text: string) => Promise<void>; revOf?: (path: string) => string | undefined }
export const AnnotateContext = createContext<AnnotateTarget | null>(null)

interface Pick { selector: string; tag: string; text: string; quote: string; rect: number[]; viewport: number[] }
interface Note { n: number; selector: string; rect?: number[]; author: string; text: string; at: string }
const NOTE_RE = /<!-- annotation (\{.*?\}) -->/

/** Notes already left on this file, numbered in thread order. */
function notesFor(path: string, comments: AnnotateTarget['comments']): Note[] {
  const out: Note[] = []
  for (const c of comments) {
    const m = NOTE_RE.exec(c.text)
    if (!m) continue
    try {
      const a = JSON.parse(m[1])
      if (a.file !== path) continue
      const body = c.text.replace(NOTE_RE, '').split('\n').filter((l) => !l.startsWith('>') && !l.startsWith('**Design note**')).join('\n').trim()
      out.push({ n: out.length + 1, selector: a.selector, rect: a.rect, author: c.author, text: body, at: c.created_at })
    } catch {}
  }
  return out
}

export function Viewer({ path, rev, onClose }: { path: string | null; rev?: string; onClose: () => void }) {
  const target = useContext(AnnotateContext)
  const canNote = !!target && !!path && path.endsWith('.html') && !rev
  const [noting, setNoting] = useState(false)
  const [pick, setPick] = useState<Pick | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const notes = canNote && path ? notesFor(path, target!.comments) : []

  useEffect(() => { if (!path) { setNoting(false); setPick(null); setText('') } }, [path])
  // Messages from the annotation script inside the sandboxed mockup.
  useEffect(() => {
    if (!noting) return
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const d = e.data || {}
      if (d.type === 'annotate:pick') { setPick(d as Pick); setActive(null) }
      if (d.type === 'annotate:ready') sendPins()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  })
  function sendPins() {
    frame.current?.contentWindow?.postMessage({ type: 'annotate:pins', pins: notes.map((x) => ({ n: x.n, selector: x.selector, rect: x.rect, active: x.n === active })) }, '*')
  }
  useEffect(() => { if (noting) sendPins() }, [active, notes.length, noting]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    if (!pick || !text.trim() || !target || !path) return
    setBusy(true)
    try {
      const r = target.revOf?.(path)
      const meta = { file: path, rev: r, selector: pick.selector, tag: pick.tag, rect: pick.rect, viewport: pick.viewport }
      const lines = [
        `**Design note** on \`${path}\`${r ? ` (at ${r})` : ''}`,
        `> Element: \`<${pick.tag}>\`${pick.text ? ` "${pick.text.slice(0, 120)}"` : ''} · selector \`${pick.selector}\``,
        pick.quote ? `> Quoted: "${pick.quote.replace(/\n+/g, ' ').slice(0, 300)}"` : '',
        `> Position ${pick.rect[0]},${pick.rect[1]} · ${pick.rect[2]}×${pick.rect[3]} at ${pick.viewport[0]}px wide`,
        '', text.trim(), '', `<!-- annotation ${JSON.stringify(meta)} -->`,
      ].filter((l, i) => l !== '' || i > 2)
      await target.post(lines.join('\n'))
      setPick(null); setText('')
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={!!path} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false}
        className="flex h-[100svh] w-screen max-w-none flex-col gap-0 border-0 p-0 sm:max-w-none">
        <div className="flex shrink-0 items-center gap-3 border-t-4 border-b border-foreground px-4 py-2">
          <DialogTitle className="truncate font-mono text-xs font-semibold">{path}{rev ? ` @${rev.slice(0, 7)}` : ''}</DialogTitle>
          {canNote && (
            <button type="button" onClick={() => { setNoting(!noting); setPick(null) }}
              className={cn('ml-4 flex items-center gap-1 px-2 py-0.5 text-xs font-semibold', noting ? 'bg-swiss text-white' : 'border border-foreground hover:bg-muted')}>
              <ChatTeardropTextIcon />{noting ? 'Commenting: click an element or select text' : `Comment${notes.length ? ` · ${notes.length}` : ''}`}
            </button>
          )}
          {path && <a href={fileUrl(path, rev)} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-xs hover:underline"><ArrowSquareOutIcon />New tab</a>}
          <button type="button" onClick={onClose} className="flex items-center gap-1 text-xs font-semibold hover:underline"><XIcon />Close</button>
        </div>
        <div className="flex min-h-0 flex-1">
          {path && (path.endsWith('.md')
            ? <MdFile path={path} rev={rev} className="min-h-0 flex-1 overflow-y-auto px-[max(1.5rem,calc(50vw-26rem))] py-6" />
            : <iframe ref={frame} key={noting ? 'note' : 'view'} title={path} src={fileUrl(path, rev) + (noting ? `${rev ? '&' : '?'}annotate=1` : '')}
                sandbox="allow-scripts allow-popups" className="min-h-0 w-full flex-1 bg-white" />)}
          {noting && (
            <aside className="flex w-80 shrink-0 flex-col border-l border-foreground">
              <div className="border-b px-3 py-2 text-[11px] font-bold tracking-[0.1em] uppercase">Note to the thread</div>
              {pick ? (
                <form className="grid gap-2 border-b px-3 py-3" onSubmit={(e) => { e.preventDefault(); send() }}>
                  <div className="grid gap-0.5 text-[11px]">
                    <span><b>&lt;{pick.tag}&gt;</b> {pick.text && <span className="text-muted-foreground">"{pick.text.slice(0, 80)}"</span>}</span>
                    <span className="truncate font-mono text-muted-foreground" title={pick.selector}>{pick.selector}</span>
                    {pick.quote && <span className="border-l-2 border-swiss pl-2">"{pick.quote.slice(0, 160)}"</span>}
                  </div>
                  <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="What should change here?"
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
                    className="border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus:border-foreground" />
                  <div className="flex gap-2">
                    <button type="submit" disabled={busy || !text.trim()} className="bg-foreground px-3 py-1 text-xs font-semibold text-background disabled:opacity-40">Send to thread</button>
                    <button type="button" onClick={() => setPick(null)} className="px-2 text-xs hover:underline">Cancel</button>
                  </div>
                </form>
              ) : <p className="border-b px-3 py-3 text-xs text-muted-foreground">Hover the design and click the element you mean, or select text to quote it.</p>}
              <ol className="min-h-0 flex-1 overflow-y-auto">
                {notes.map((x) => (
                  <li key={x.n}>
                    <button type="button" onClick={() => setActive(x.n === active ? null : x.n)}
                      className={cn('grid w-full grid-cols-[1.5rem_1fr] gap-2 border-b px-3 py-2 text-left text-xs hover:bg-muted', active === x.n && 'bg-muted')}>
                      <span className="flex size-5 items-center justify-center bg-swiss text-[11px] font-semibold text-white">{x.n}</span>
                      <span className="min-w-0"><b>{x.author}</b> <span className="text-muted-foreground">{x.at.slice(5, 16).replace('T', ' ')}</span>
                        <span className="block truncate">{x.text}</span></span>
                    </button>
                  </li>
                ))}
              </ol>
            </aside>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MdFile({ path, rev, className }: { path: string; rev?: string; className?: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    fetch(fileUrl(path, rev)).then((r) => (r.ok ? r.text() : `*${path}: ${r.status}*`)).then((t) => !gone && setText(t))
    return () => { gone = true }
  }, [path, rev])
  return <div className={className}>{text === null ? <p className="text-xs text-muted-foreground">Loading…</p> : <Markdown embeds={false}>{text}</Markdown>}</div>
}

const DESKTOP = 1280
function Scaled({ path, rev, height }: { path: string; rev?: string; height: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = w ? Math.min(1, w / DESKTOP) : 0
  const isImg = /\.(png|jpg|webp)$/.test(path)
  return (
    <div ref={box} className="relative overflow-hidden bg-white" style={{ height }}>
      {isImg ? <img src={fileUrl(path, rev)} alt={path} className="h-full w-full object-contain" /> : scale > 0 && (
        <iframe title={path} src={fileUrl(path, rev)} sandbox="allow-scripts allow-popups" tabIndex={-1}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style={{ width: DESKTOP, height: height / scale, transform: `scale(${scale})` }} />
      )}
    </div>
  )
}

// ---- Mermaid: POST the source to the board server, show the SVG as an <img> (no script can run in it).
const mermaidCache = new Map<string, Promise<{ url?: string; width?: number; error?: string }>>()
function renderMermaid(source: string, theme: 'default' | 'dark') {
  const key = theme + '\0' + source
  let p = mermaidCache.get(key)
  if (!p) {
    p = fetch(`/api/mermaid?theme=${theme}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: source })
      .then(async (r) => {
        if (!r.ok) return { error: (await r.json().catch(() => ({}))).error || `HTTP ${r.status}` }
        const svg = await r.text()
        const vb = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) [\d.]+"/.exec(svg) // natural width: fit narrow panels, never blow up small diagrams
        return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), width: vb ? Number(vb[1]) : undefined }
      })
      .catch((e) => ({ error: String(e) }))
    mermaidCache.set(key, p)
  }
  return p
}
export function Mermaid({ source }: { source: string }) {
  const [state, setState] = useState<{ url?: string; width?: number; error?: string } | null>(null)
  const theme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'default'
  useEffect(() => {
    let gone = false
    renderMermaid(source, theme).then((r) => { if (!gone) setState(r) })
    return () => { gone = true }
  }, [source, theme])
  if (!state) return <div className="my-2 h-24 animate-pulse bg-muted/60" aria-label="Rendering diagram" />
  if (state.error) return (
    <div className="my-2">
      <pre><code>{source}</code></pre>
      <p className="mt-1 text-[11px] text-swiss">Diagram not rendered: {state.error}</p>
    </div>
  )
  return <img src={state.url} alt="Mermaid diagram" className="my-2 block h-auto w-full" style={{ maxWidth: state.width ? `min(100%, ${state.width}px)` : '100%' }} />
}
