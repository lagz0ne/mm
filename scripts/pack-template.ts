// Packs template/ into src/template.gen.json so the compiled mm binary carries the whole project template.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..', 'template')
const files: { p: string; m: number; c: string }[] = []
const walk = (d: string) => {
  for (const n of readdirSync(d).sort()) {
    const f = join(d, n), st = statSync(f)
    if (st.isDirectory()) { if (n !== 'node_modules' && n !== 'dist') walk(f); continue }
    files.push({ p: relative(root, f), m: st.mode & 0o777, c: readFileSync(f).toString('base64') })
  }
}
walk(root)
writeFileSync(join(import.meta.dir, '..', 'src', 'template.gen.json'), JSON.stringify({ files }))
console.log(`packed ${files.length} template files`)
