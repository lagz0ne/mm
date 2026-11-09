import { useEffect, useState } from 'react'
import { ArrowLeftIcon, DownloadSimpleIcon, FileIcon, FolderIcon } from '@phosphor-icons/react'
import { Markdown, Mermaid } from '@/Markdown'
import { ago } from '@/lib/board'
import { cn } from '@/lib/utils'

// The Files view (sy-oprc; docs/board/sy-oprc-files.md): the board's document folders (artifacts, docs, plans, memory,
// a project's code/docs), one folder at a time, and each file by its type. Read-only. The address is #files/<path>, so
// Back goes up again. The server (site/files.mjs) decides what is listed and served; this only shows it.

type Kind = 'folder' | 'image' | 'markdown' | 'mermaid' | 'html' | 'text' | 'binary'
interface Entry { name: string; path: string; dir: boolean; kind: Kind; size: number; mtime: string }
const VIEW_MAX = 2 << 20 // larger files: download only (the server's VIEW_MAX)

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')
const hashOf = (p: string) => (p ? `#files/${enc(p)}` : '#files')
const rawUrl = (p: string) => `/api/files/raw/${enc(p)}`
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/')
function size(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1 << 20) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1 << 20)).toFixed(1)} MB`
}
function pathOfHash(hash: string) {
  if (!hash.startsWith('#files/')) return ''
  try { return hash.slice(7).split('/').map(decodeURIComponent).join('/').replace(/\/$/, '') } catch { return '' }
}
async function listOf(p: string): Promise<{ path: string; entries: Entry[] } | null> {
  const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

type State = { loading: true } | { error: string } | { folder: { path: string; entries: Entry[] } } | { file: Entry }

export function Files({ hash }: { hash: string }) {
  const p = pathOfHash(hash)
  const [st, setSt] = useState<State>({ loading: true })
  useEffect(() => {
    let gone = false
    setSt({ loading: true })
    ;(async () => {
      const folder = await listOf(p)
      if (folder) return { folder }
      // not a folder: a file, found in its folder's list (so the list's checks hold for it too)
      const up = p ? await listOf(parentOf(p)) : null
      const f = up?.entries.find((e) => e.path === p && !e.dir)
      return f ? { file: f } : { error: 'Not available: no such folder or file, or not one the board shows.' }
    })().then((s) => !gone && setSt(s), (e) => !gone && setSt({ error: `The files did not load (${(e as Error).message}).` }))
    return () => { gone = true }
  }, [p])

  const crumbs = p ? p.split('/') : []
  return (
    <main data-files className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-4xl px-4 py-4 md:px-6">
        <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm">
          {p && (
            <a data-files-up href={hashOf(parentOf(p))} aria-label="Up one folder"
              className="-ml-2 mr-1 flex h-11 items-center gap-1 px-2 font-semibold hover:underline md:h-8">
              <ArrowLeftIcon weight="bold" className="size-4" />Up
            </a>
          )}
          <a href="#files" className={cn('font-bold hover:underline', !p && 'text-lg tracking-tight')}>Files</a>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-x-1">
              <span aria-hidden className="text-muted-foreground">/</span>
              {i === crumbs.length - 1
                ? <span className="font-semibold [overflow-wrap:anywhere]" aria-current="page">{c}</span>
                : <a href={hashOf(crumbs.slice(0, i + 1).join('/'))} className="hover:underline [overflow-wrap:anywhere]">{c}</a>}
            </span>
          ))}
        </nav>
        {!p && <p className="mt-1 text-sm text-muted-foreground">The board's documents: what the leads made for items, its docs, plans and memory. Read-only.</p>}
        <div className="mt-3">
          {'loading' in st ? <p className="text-xs text-muted-foreground">Loading…</p>
            : 'error' in st ? <p className="text-sm text-destructive">{st.error}</p>
            : 'folder' in st ? <Folder entries={st.folder.entries} top={!p} />
            : <FileView f={st.file} />}
        </div>
      </div>
    </main>
  )
}

function Folder({ entries, top }: { entries: Entry[]; top: boolean }) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">{top ? 'No document folders on this board yet.' : 'Empty folder.'}</p>
  return (
    <ul data-files-list className="divide-y border-y">
      {entries.map((e) => (
        <li key={e.path}>
          <a href={hashOf(e.path)} data-entry={e.name} data-kind={e.kind}
            className="flex min-h-12 min-w-0 items-center gap-3 px-1 py-1.5 hover:bg-muted">
            {e.dir ? <FolderIcon weight="fill" className="size-5 shrink-0" /> : <FileIcon className="size-5 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{e.name}</span>
            <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {!e.dir && <span className="block">{size(e.size)}</span>}
              <span className="block">{ago(e.mtime)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function useText(url: string, on: boolean) {
  const [t, setT] = useState<{ text?: string; error?: string } | null>(null)
  useEffect(() => {
    if (!on) return
    let gone = false
    setT(null)
    fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => !gone && setT({ text }), (e) => !gone && setT({ error: String(e.message || e) }))
    return () => { gone = true }
  }, [url, on])
  return t
}

function FileView({ f }: { f: Entry }) {
  const url = rawUrl(f.path)
  const tooBig = f.size > VIEW_MAX
  const shown = !tooBig && f.kind !== 'binary'
  const needsText = shown && ['markdown', 'mermaid', 'text'].includes(f.kind)
  const t = useText(url, needsText)
  return (
    <article data-file={f.path} data-kind={f.kind} className="min-w-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-foreground pb-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{size(f.size)}</span>
        <span>{ago(f.mtime)}</span>
        <a data-download href={`${url}?download=1`} download={f.name} className="ml-auto flex h-11 items-center gap-1 font-semibold text-foreground hover:underline md:h-8">
          <DownloadSimpleIcon weight="bold" className="size-4" />Download
        </a>
      </header>
      <div className="mt-3 min-w-0">
        {!shown ? (
          <p data-no-preview className="text-sm text-muted-foreground">
            {tooBig ? `Too large to show here (${size(f.size)}; the limit is ${size(VIEW_MAX)}).` : 'No preview for this type.'} Download it to open it.
          </p>
        ) : f.kind === 'image' ? (
          <img src={url} alt={f.name} className="block h-auto max-w-full border" />
        ) : f.kind === 'html' ? (
          // no token in sandbox: no script, no same-origin, no form, no popup; the server adds the same as a CSP
          <iframe data-html-frame title={f.name} src={url} sandbox="" referrerPolicy="no-referrer"
            className="block h-[70svh] w-full border bg-white" />
        ) : !t ? <p className="text-xs text-muted-foreground">Loading…</p>
          : t.error ? <p className="text-sm text-destructive">It did not load ({t.error}).</p>
          : f.kind === 'markdown' ? <Markdown embeds={false} className="text-[15px] md:text-sm">{t.text!}</Markdown>
          : f.kind === 'mermaid' ? <Mermaid source={t.text!} />
          : <Lines text={t.text!} />}
      </div>
    </article>
  )
}

/** Text with line numbers; long lines wrap (no sideways scroll on a phone). */
function Lines({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n')
  const w = String(lines.length).length
  return (
    <div data-lines className="border bg-muted/30 py-1 font-mono text-xs leading-5">
      {lines.map((l, i) => (
        <div key={i} className="flex min-w-0">
          <span aria-hidden className="shrink-0 select-none pr-3 pl-2 text-right text-muted-foreground tabular-nums" style={{ width: `${w + 2}ch` }}>{i + 1}</span>
          <span className="min-w-0 flex-1 pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}
