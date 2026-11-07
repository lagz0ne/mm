import { Fragment, useCallback, useEffect, useState } from 'react'
import { usePhone } from '@/lib/phone'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type Line = { kind: string; text: string }
type Project = { project: string; root: string; processes?: string; ready?: string; self?: boolean; logs?: number; errors?: number; spans?: number; failed_spans?: number }
type MachineData = {
  at: string
  brain: { ok: boolean; lines: Line[]; score: { total: number; items: [number, string][] } | null; error?: string } | null
  obs: { ok: boolean; stores: { store: string; status: string; port?: number }[] }
  projects: Project[]
}

const LOUD = new Set(['alert', 'lint error', 'uncovered'])
const ago = (iso: string) => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago` }
const running = (p: Project) => { const m = /^(\d+)\/(\d+)/.exec(p.processes || ''); return m ? m[1] === m[2] && m[2] !== '0' : false }

/**
 * The machine panel (system board): the box's state from `bin/brain status` + score and the observability stores, and one
 * row per project (mm ls + mm obs status). A row's action files an item on that project's own board, never on its files.
 */
export function Machine() {
  const [d, setD] = useState<MachineData | null>(null)
  const [err, setErr] = useState('')
  const [filing, setFiling] = useState<string | null>(null)
  const phone = usePhone()
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/machine')
      const j = await r.json()
      if (!r.ok) throw new Error(j.title || `${r.status}`)
      setD(j); setErr('')
    } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  if (!d) return <div className="p-6 text-xs text-muted-foreground">{err ? `Machine panel unavailable: ${err}` : 'Loading the machine…'}</div>
  const alerts = d.brain?.lines.filter((l) => LOUD.has(l.kind)) || []
  return (
    <div className="min-w-0 flex-1 overflow-auto px-4 py-4 md:px-6 md:py-5">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4">
        <h2 className="text-xl font-bold tracking-tight">Machine</h2>
        <span className="text-xs text-muted-foreground tabular-nums">updated {ago(d.at)}{err ? ` · last refresh failed: ${err}` : ''}</span>
      </div>

      <div className="grid grid-cols-12 gap-6 [&>section]:min-w-0">
        <section className="col-span-12 border-t-2 border-foreground pt-3 lg:col-span-8">
          <h3 className="mb-2 text-[13px] font-semibold">Status <span className="font-normal text-muted-foreground">(bin/brain status)</span></h3>
          {!d.brain ? <p className="text-xs text-muted-foreground">No brain on this machine.</p> : (
            <ul className="space-y-1 text-[13px]">
              {alerts.length === 0 && <li className="text-xs text-muted-foreground">No alerts.</li>}
              {d.brain.lines.map((l, i) => (
                <li key={i} className={cn('font-mono text-xs leading-5 [overflow-wrap:anywhere]', LOUD.has(l.kind) ? 'font-semibold text-swiss' : l.kind === 'info' ? 'text-muted-foreground' : 'text-foreground')}>{l.text}</li>
              ))}
              {!d.brain.ok && <li className="text-xs text-swiss">brain status failed: {d.brain.error}</li>}
            </ul>
          )}
        </section>

        <section className="col-span-12 space-y-4 lg:col-span-4">
          <div className="border-t-2 border-foreground pt-3">
            <h3 className="mb-2 text-[13px] font-semibold">Score <span className="font-normal text-muted-foreground">(debt, lower is better)</span></h3>
            {d.brain?.score ? (<>
              <div className="text-3xl leading-none font-bold tabular-nums">{d.brain.score.total}</div>
              <ul className="mt-2 space-y-0.5 text-xs">{d.brain.score.items.map(([n, what], i) => <li key={i} className="flex gap-2"><span className="w-6 text-right font-semibold tabular-nums">{n}</span><span>{what}</span></li>)}</ul>
            </>) : <p className="text-xs text-muted-foreground">No score.</p>}
          </div>
          <div className="border-t-2 border-foreground pt-3">
            <h3 className="mb-2 text-[13px] font-semibold">Observability</h3>
            <ul className="flex flex-wrap gap-x-4 text-xs">{d.obs.stores.map((s) => <li key={s.store} className={cn(s.status === 'ok' ? '' : 'font-semibold text-swiss')}>{s.store} {s.status}</li>)}</ul>
          </div>
        </section>

        <section className="col-span-12 border-t-2 border-foreground pt-3">
          <h3 className="mb-2 text-[13px] font-semibold">Projects <span className="font-normal text-muted-foreground">(mm ls · last hour from mm obs)</span></h3>
          {phone ? (
            <ul className="grid">{d.projects.map((p) => (
              <li key={p.project} className="grid gap-1 border-b py-3">
                <div className="flex flex-wrap items-baseline gap-x-2"><b className="text-[15px] [overflow-wrap:anywhere]">{p.project}</b>{p.self && <span className="text-xs text-muted-foreground">(this board)</span>}
                  <span className={cn('ml-auto text-xs tabular-nums', !running(p) && 'font-semibold text-swiss')}>{p.processes} · {p.ready}</span></div>
                <div className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{p.root}</div>
                <dl className="grid grid-cols-3 text-xs">
                  {([['Logs', p.logs, false], ['Errors', p.errors, (p.errors || 0) > 0], ['Failed ops', p.failed_spans, (p.failed_spans || 0) > 0]] as const).map(([k, v, hot]) => (
                    <div key={k}><dt className="text-[11px] text-muted-foreground">{k}</dt><dd className={cn('tabular-nums', hot && 'font-semibold text-swiss')}>{v ?? '–'}</dd></div>
                  ))}
                </dl>
                {!p.self && <Button variant="outline" className="mt-1 w-full" onClick={() => setFiling(filing === p.project ? null : p.project)}>{filing === p.project ? 'Cancel' : 'File on its board'}</Button>}
                {filing === p.project && <div className="pt-2"><FileItem project={p.project} onDone={() => setFiling(null)} /></div>}
              </li>
            ))}</ul>
          ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-semibold">Project</th><th className="font-semibold">Folder</th><th className="font-semibold">Processes</th>
              <th className="text-right font-semibold">Logs</th><th className="text-right font-semibold">Errors</th><th className="text-right font-semibold">Failed ops</th><th />
            </tr></thead>
            <tbody>{d.projects.map((p) => (<Fragment key={p.project}>
              <tr className="border-b align-top">
                <td className="py-1.5 font-semibold">{p.project}{p.self && <span className="ml-1 text-xs font-normal text-muted-foreground">(this board)</span>}</td>
                <td className="font-mono text-xs text-muted-foreground">{p.root}</td>
                <td className={cn('tabular-nums', !running(p) && 'font-semibold text-swiss')}>{p.processes} · {p.ready}</td>
                <td className="text-right tabular-nums">{p.logs ?? '–'}</td>
                <td className={cn('text-right tabular-nums', (p.errors || 0) > 0 && 'font-semibold text-swiss')}>{p.errors ?? '–'}</td>
                <td className={cn('text-right tabular-nums', (p.failed_spans || 0) > 0 && 'font-semibold text-swiss')}>{p.failed_spans ?? '–'}</td>
                <td className="text-right">{!p.self && <Button size="sm" variant="outline" onClick={() => setFiling(filing === p.project ? null : p.project)}>File on its board</Button>}</td>
              </tr>
              {filing === p.project && <tr><td colSpan={7} className="border-b py-3"><FileItem project={p.project} onDone={() => setFiling(null)} /></td></tr>}
            </Fragment>))}</tbody>
          </table>)}
        </section>
      </div>
    </div>
  )
}

/** A new item on a project's own board, as the human at this board (labelled from-system there). */
function FileItem({ project, onDone }: { project: string; onDone: () => void }) {
  const [title, setTitle] = useState(''), [desc, setDesc] = useState(''), [assignee, setAssignee] = useState('setup'), [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/project-item', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, title, description: desc, assignee: assignee || undefined }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.title || `${r.status}`)
      toast.success(`Filed ${j.text}`); onDone()
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="grid max-w-3xl gap-2">
      <div className="text-xs text-muted-foreground">A new item on <b>{project}</b>'s own board. Its leads (or its setup agent) pick it up there.</div>
      <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <Textarea placeholder="What you need, and why (markdown)" value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} />
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-40 max-md:w-full" placeholder="assignee (role)" value={assignee} onChange={(e) => setAssignee(e.target.value.trim())} />
        <Button size="sm" disabled={busy || !title.trim()} onClick={submit}>{busy ? 'Filing…' : 'File it'}</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  )
}
