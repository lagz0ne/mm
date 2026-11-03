import { useContext, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ROLE_DEFS } from '@/lib/board'
import { Avatar, PersonaContext, personaOf } from '@/lib/persona'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Activity = { id: string; title: string; raci: Record<string, string> }
const LETTERS = ['', 'R', 'A', 'C', 'I', 'RA'] as const
const HELP: Record<string, string> = { R: 'Responsible: does it', A: 'Accountable: approves (one per row)', C: 'Consulted: asked before', I: 'Informed: told after', RA: 'Does it and approves it' }

async function request(body: Record<string, unknown>) {
  const r = await fetch('/api/config/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.title || `${r.status}`)
  toast.success(`Sent to the setup agent: ${d.id}`)
}

/** The RACI matrix: rows are kinds of work, columns are roles plus humans. Edits become one request to the setup agent. */
export function Raci({ raci }: { raci: { activities: Activity[] } | null }) {
  const personas = useContext(PersonaContext)
  const [draft, setDraft] = useState<Activity[]>([])
  const [newRow, setNewRow] = useState({ id: '', title: '' })
  const [busy, setBusy] = useState(false)
  const base = raci?.activities || []
  useEffect(() => { setDraft(structuredClone(base)) }, [JSON.stringify(base)]) // eslint-disable-line react-hooks/exhaustive-deps
  const who = [...ROLE_DEFS.map((r) => r.id), 'human']

  const changes: string[] = []
  for (const a of draft) {
    const b = base.find((x) => x.id === a.id)
    const cells = who.filter((p) => (a.raci[p] || '') !== (b?.raci[p] || '')).map((p) => `${p}=${a.raci[p] || '-'}`)
    if (!b) changes.push(`raci add ${a.id} "${a.title}"`)
    if (cells.length) changes.push(`raci set ${a.id} ${cells.join(' ')}`)
  }
  for (const b of base) if (!draft.some((a) => a.id === b.id)) changes.push(`raci rm ${b.id}`)
  const problems = draft.flatMap((a) => {
    const v = Object.values(a.raci)
    const A = v.filter((l) => l.includes('A')).length
    return [...(A !== 1 ? [`${a.title}: needs exactly one A (has ${A})`] : []), ...(!v.some((l) => l.includes('R')) ? [`${a.title}: needs an R`] : [])]
  })

  return (
    <div className="min-h-0 overflow-y-auto">
      <header className="flex flex-wrap items-baseline gap-4 border-b border-foreground px-6 pt-4 pb-2">
        <h2 className="text-[11px] font-bold tracking-[0.1em] uppercase">RACI</h2>
        <p className="text-[11px] text-muted-foreground">
          Who is <b>R</b>esponsible, <b>A</b>ccountable (approves), <b>C</b>onsulted, <b>I</b>nformed for each kind of work. Items carry <code>act:&lt;id&gt;</code>;
          the board asks Consulted roles when one is created and tells Informed roles when it closes. Leads read this matrix in their brief.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-foreground">
              <th className="px-6 py-2 text-left text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Activity</th>
              {who.map((p) => {
                const per = personaOf(personas, p)
                return (
                  <th key={p} className="px-2 py-2 text-center font-semibold">
                    <span className="inline-flex flex-col items-center gap-1">
                      {per ? <Avatar actor={p} size="sm" /> : <span className="inline-flex size-5 items-center justify-center bg-muted text-[10px]">you</span>}
                      <span style={{ color: per?.color }}>{per?.name || 'Humans'}</span>
                      <span className="text-[10px] font-normal text-muted-foreground">{per?.roleTitle || 'approvals'}</span>
                    </span>
                  </th>
                )
              })}
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.map((a, k) => (
              <tr key={a.id} className="border-b hover:bg-muted/40">
                <td className="px-6 py-1.5"><b>{a.title}</b> <code className="text-[11px] text-muted-foreground">act:{a.id}</code></td>
                {who.map((p) => (
                  <td key={p} className="px-1 py-1 text-center">
                    <select value={a.raci[p] || ''} title={HELP[a.raci[p] || ''] || 'not involved'}
                      onChange={(e) => { const d = structuredClone(draft); if (e.target.value) d[k].raci[p] = e.target.value; else delete d[k].raci[p]; setDraft(d) }}
                      className={cn('h-7 w-12 border text-center font-mono font-bold', a.raci[p]?.includes('A') && 'border-swiss text-swiss', !a.raci[p] && 'text-muted-foreground',
                        (a.raci[p] || '') !== (base.find((x) => x.id === a.id)?.raci[p] || '') && 'bg-swiss/10')}>
                      {LETTERS.map((l) => <option key={l} value={l}>{l || '·'}</option>)}
                    </select>
                  </td>
                ))}
                <td className="pr-6 text-right"><button className="text-[11px] text-muted-foreground hover:text-swiss" onClick={() => setDraft(draft.filter((x) => x.id !== a.id))}>remove</button></td>
              </tr>
            ))}
            <tr>
              <td className="px-6 py-2" colSpan={who.length + 2}>
                <form className="flex gap-2" onSubmit={(e) => {
                  e.preventDefault()
                  if (!/^[a-z][a-z0-9-]{0,31}$/.test(newRow.id) || !newRow.title.trim() || draft.some((x) => x.id === newRow.id)) return toast.error('id: a-z 0-9 -; title required; unique')
                  setDraft([...draft, { id: newRow.id, title: newRow.title.trim(), raci: {} }]); setNewRow({ id: '', title: '' })
                }}>
                  <Input value={newRow.id} onChange={(e) => setNewRow({ ...newRow, id: e.target.value })} placeholder="activity id (e.g. infra)" className="h-7 w-44" />
                  <Input value={newRow.title} onChange={(e) => setNewRow({ ...newRow, title: e.target.value })} placeholder="title (e.g. Infrastructure changes)" className="h-7 w-72" />
                  <Button size="xs" variant="outline" type="submit">Add activity</Button>
                </form>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="grid gap-2 px-6 py-3">
        {problems.length > 0 && <ul className="text-xs text-swiss">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {changes.length > 0 && <pre className="bg-muted/40 px-3 py-2 font-mono text-[11px]">{changes.join('\n')}</pre>}
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !changes.length || problems.length > 0} onClick={async () => {
            setBusy(true)
            try { await request({ kind: 'ask', note: `RACI: run these, then config-check (renders leads/RACI.md) and commit. The leads pick it up on their next turn/restart.\n${changes.map((c) => `- \`${c}\``).join('\n')}` }) }
            catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
          }}>Send {changes.length || ''} change{changes.length === 1 ? '' : 's'} to setup agent</Button>
          {changes.length > 0 && <Button size="sm" variant="ghost" onClick={() => setDraft(structuredClone(base))}>Discard</Button>}
        </div>
      </div>
    </div>
  )
}

/** Ask the setup agent for a new role: same structure as the others (brief, skills, permissions, persona, RACI column). */
export function AddRole() {
  const [f, setF] = useState({ id: '', title: '', initial: '', color: '#555555', summary: '', workers: false, note: '' })
  const [busy, setBusy] = useState(false)
  const taken = new Set(ROLE_DEFS.map((r) => r.id))
  const ok = /^[a-z][a-z0-9-]{1,23}$/.test(f.id) && !taken.has(f.id) && f.title.trim() && /^[A-Z]$/.test(f.initial)
  return (
    <div className="min-h-0 overflow-y-auto">
      <header className="border-b border-foreground px-6 pt-4 pb-2">
        <h2 className="text-[11px] font-bold tracking-[0.1em] uppercase">Add a role</h2>
        <p className="text-[11px] text-muted-foreground">Same structure as every lead: brief, skills, permissions, persona (name starts with the initial), a board row and a RACI column. The setup agent scaffolds it and works out the brief with you.</p>
      </header>
      <div className="grid max-w-3xl gap-3 px-6 py-4 text-xs">
        <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
          <label>Id</label><Input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase() })} placeholder="e.g. ops, architecture" className="h-7" />
          <label>Title</label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value, initial: f.initial || e.target.value.trim()[0]?.toUpperCase() || '' })} placeholder="e.g. CI/CD & production, System architecture" className="h-7" />
          <label>Initial</label><Input value={f.initial} onChange={(e) => setF({ ...f, initial: e.target.value.toUpperCase().slice(0, 1) })} placeholder="one letter; the persona name starts with it" className="h-7 w-24" />
          <label>Color</label><span className="flex items-center gap-2"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-7 w-9 border" /><span className="font-mono">{f.color}</span></span>
          <label>One line</label><Input value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} placeholder="What this lead is for" className="h-7" />
          <label>Workers</label><label className="flex items-center gap-2"><input type="checkbox" checked={f.workers} onChange={(e) => setF({ ...f, workers: e.target.checked })} className="accent-foreground" />orchestrates workers in worktrees (like Code)</label>
        </div>
        <textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} rows={6}
          placeholder="What should it own, produce and protect? Which RACI activities (R/A/C/I)? What may it touch (e.g. CI config, deploy scripts)?"
          className="border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus:border-foreground" />
        <div><Button size="sm" disabled={busy || !ok} onClick={async () => {
          setBusy(true)
          try {
            await request({ kind: 'ask', note: [`New role: run \`role add ${f.id} --title ${JSON.stringify(f.title.trim())} --initial ${f.initial} --color ${f.color}${f.summary ? ` --summary ${JSON.stringify(f.summary.trim())}` : ''}${f.workers ? ' --workers' : ''}\`.`,
              'Then: write its brief (leads/' + f.id + '/CLAUDE.md) from the notes below, set its RACI cells, give it only the permissions its work needs (template, {root}-relative),',
              'config-check, commit, and `lead start ' + f.id + '`. Ask me if the notes leave real gaps.', '', f.note.trim()].join('\n') })
            setF({ id: '', title: '', initial: '', color: '#555555', summary: '', workers: false, note: '' })
          } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) }
        }}>Ask the setup agent to add it</Button></div>
      </div>
    </div>
  )
}

/** Remove a role (setup agent refuses while it has open items or unlanded work). */
export async function requestRemoveRole(role: string) {
  if (!window.confirm(`Ask the setup agent to remove the ${role} role? It refuses while ${role} has open items; history stays.`)) return
  try { await request({ kind: 'ask', note: `Remove role: run \`role rm ${role}\` (it refuses with open items or unlanded work; then reassign and retry). Make sure every RACI activity still has an A and an R, config-check, commit.` }) }
  catch (e) { toast.error((e as Error).message) }
}
