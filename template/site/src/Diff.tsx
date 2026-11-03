import { cn } from '@/lib/utils'

type Op = { t: ' ' | '+' | '-'; line: string }

/** Line diff (LCS). Fine for documents up to a few thousand lines. */
export function diffLines(a: string, b: string): Op[] {
  const A = a.split('\n'), B = b.split('\n')
  const n = A.length, m = B.length
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: Op[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', line: A[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', line: A[i++] })
    else out.push({ t: '+', line: B[j++] })
  }
  while (i < n) out.push({ t: '-', line: A[i++] })
  while (j < m) out.push({ t: '+', line: B[j++] })
  return out
}

/** Unified diff with unchanged runs folded to 2 lines of context. */
export function DiffView({ before, after, className }: { before: string; after: string; className?: string }) {
  const ops = diffLines(before, after)
  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - 2), k + 3).some((x) => x.t !== ' '))
  const rows: React.ReactNode[] = []
  let skipped = 0
  ops.forEach((o, k) => {
    if (!keep[k]) { skipped++; return }
    if (skipped) { rows.push(<span key={`s${k}`} className="block text-muted-foreground">  ⋯ {skipped} unchanged line{skipped > 1 ? 's' : ''}</span>); skipped = 0 }
    rows.push(<span key={k} className={cn('block', o.t === '+' && 'bg-[#e6f4ea]', o.t === '-' && 'bg-[#fde8e8] text-muted-foreground line-through decoration-[#c62828]/40')}>{o.t} {o.line || ' '}</span>)
  })
  if (skipped) rows.push(<span key="end" className="block text-muted-foreground">  ⋯ {skipped} unchanged line{skipped > 1 ? 's' : ''}</span>)
  const added = ops.filter((o) => o.t === '+').length, removed = ops.filter((o) => o.t === '-').length
  return (
    <div className={cn('border', className)}>
      <div className="border-b px-3 py-1 text-[11px]"><span className="text-[#1e7e34]">+{added}</span> <span className="text-swiss">−{removed}</span></div>
      <pre className="max-h-[32rem] overflow-auto px-3 py-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">{rows}</pre>
    </div>
  )
}
