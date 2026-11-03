// Output in the user's format: table (default), json, yaml. `-q` prints only the essential column.
export type Format = 'table' | 'json' | 'yaml'
export interface OutOpts { format: Format; quiet?: boolean }

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
export const statusMark: Record<string, string> = {
  ok: paint('32', 'ok'), warn: paint('33', 'warn'), fail: paint('31', 'FAIL'), skip: paint('2', 'skip'), fixed: paint('36', 'fixed'),
}

export function print(rows: Record<string, unknown>[], o: OutOpts, quietKey?: string) {
  if (o.format === 'json') return console.log(JSON.stringify(rows, null, 2))
  if (o.format === 'yaml') return console.log(Bun.YAML.stringify(rows, null, 2))
  if (o.quiet && quietKey) { for (const r of rows) console.log(String(r[quietKey])); return }
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const cell = (r: Record<string, unknown>, c: string) => (c === 'status' ? statusMark[String(r[c])] ?? String(r[c]) : String(r[c] ?? ''))
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const width = cols.map((c) => Math.min(70, Math.max(c.length, ...rows.map((r) => plain(cell(r, c)).length))))
  console.log(cols.map((c, i) => c.toUpperCase().padEnd(width[i])).join('  '))
  for (const r of rows) console.log(cols.map((c, i) => { const v = cell(r, c); return v + ' '.repeat(Math.max(0, width[i] - plain(v).length)) }).join('  ').trimEnd())
}
