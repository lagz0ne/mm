import { useEffect, useMemo, useState } from 'react'

interface Term { term: string; kind: string; means: string; not: string; owner: string; since: string; local: boolean }
interface Data { terms: Term[]; refuseFrom: string | null; words: number; errors: number }

/** The glossary (sy-ko6r): each term of the board with its one plain meaning, the words not to use for it, and who
 *  keeps it; from glossary.yaml (the template's) and glossary.local.yaml (this board's, marked "this board"). A search
 *  over the term and its meaning. Read-only: a new term is an item labelled glossary (the leads' brief, "Glossary"). */
export function Glossary() {
  const [d, setD] = useState<Data | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    fetch('/api/glossary').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))).then(setD, (e) => setErr(String(e.message || e)))
  }, [])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (d?.terms || []).filter((t) => !s || t.term.toLowerCase().includes(s) || t.means.toLowerCase().includes(s))
  }, [d, q])
  if (err) return <div className="p-6 text-sm text-destructive">The glossary did not load ({err}).</div>
  if (!d) return <div className="p-6 text-xs text-muted-foreground">Loading…</div>
  return (
    <main data-glossary className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-3xl px-4 py-5 md:px-6">
        <h2 className="text-lg font-bold tracking-tight">Glossary</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The terms of this board, each with one meaning. Messages and owner cards use these terms and the {d.words} approved
          words, and no other words. {d.refuseFrom ? `From ${d.refuseFrom}, bd refuses other words.` : 'For now, bd only warns about other words.'}
          {' '}To add a term, make an item with the label glossary.
        </p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a term" aria-label="Find a term" type="search"
          className="mt-4 h-11 w-full border border-input bg-background px-3 text-base outline-none focus:border-foreground md:h-9 md:text-sm" />
        <p className="mt-2 text-xs text-muted-foreground tabular-nums">{shown.length} of {d.terms.length} terms</p>
        <dl className="mt-2 divide-y border-y">
          {shown.map((t) => (
            <div key={t.term} data-term={t.term} className="grid gap-1 py-3 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-4">
              <dt className="min-w-0">
                <span className="font-bold [overflow-wrap:anywhere]">{t.term}</span>
                <span className="block text-xs text-muted-foreground">{t.kind}{t.local && <span className="text-swiss"> · this board</span>}</span>
              </dt>
              <dd className="min-w-0 text-sm">
                <p className="[overflow-wrap:anywhere]">{t.means}</p>
                {t.not && <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">Not: {t.not}</p>}
                <p className="mt-0.5 text-xs text-muted-foreground">Kept by {t.owner} · since {t.since}</p>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </main>
  )
}
