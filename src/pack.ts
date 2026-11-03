// Pack a template directory (shared by the build script and MM_TEMPLATE_DIR). No import of the packed file here:
// the build script runs before it exists.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import pkg from '../package.json'

export type TFile = { p: string; m: number; c: string }
export type Template = { version: string; files: TFile[] }

/** Walk a template directory. The version is mm's version plus a hash of the content, so any template change shows. */
export function packDir(root: string): Template {
  const files: TFile[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n), st = statSync(f)
      if (st.isDirectory()) { if (n !== 'node_modules' && n !== 'dist') walk(f); continue }
      files.push({ p: relative(root, f), m: st.mode & 0o777, c: readFileSync(f).toString('base64') })
    }
  }
  walk(root)
  const h = createHash('sha256')
  for (const f of files) h.update(`${f.p}\0${f.m}\0${f.c}\0`)
  return { version: `${pkg.version}+${h.digest('hex').slice(0, 8)}`, files }
}

