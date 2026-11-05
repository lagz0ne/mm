// The project template: packed into the binary at build time (src/template.gen.json), or read from a directory
// (MM_TEMPLATE_DIR, for development and for adopting projects made by an older mm).
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run } from './env'
import packed from './template.gen.json'
import { packDir, type TFile, type Template } from './pack'
export type { TFile, Template } from './pack'

export function template(): Template {
  const dir = process.env.MM_TEMPLATE_DIR
  return dir ? packDir(dir) : (packed as Template)
}

/**
 * The files of one profile. `project` (default): the base template. Another profile `<p>` overlays
 * `profiles/<p>/` on the base and drops the base paths listed in `profiles/<p>/profile.json` "omit" (prefixes).
 * `profiles/` itself is never rendered.
 */
export function profileFiles(t: Template, profile = 'project'): TFile[] {
  const base = t.files.filter((f) => !f.p.startsWith('profiles/'))
  if (profile === 'project') return base
  const pre = `profiles/${profile}/`
  const own = t.files.filter((f) => f.p.startsWith(pre))
  const spec = own.find((f) => f.p === `${pre}profile.json`)
  if (!spec) throw new Error(`no template profile "${profile}"`)
  const omit: string[] = JSON.parse(Buffer.from(spec.c, 'base64').toString('utf8')).omit || []
  const over = own.filter((f) => f !== spec).map((f) => ({ ...f, p: f.p.slice(pre.length) }))
  const mine = new Set(over.map((f) => f.p))
  return [...base.filter((f) => !mine.has(f.p) && !omit.some((o) => f.p === o || f.p.startsWith(o.endsWith('/') ? o : `${o}/`))), ...over]
}

/** Write the rendered template under `dest`. Text files get {{var}} filled; binary files are copied as they are.
 *  `vars.profile` picks the template profile (default `project`). */
export function renderTo(dest: string, vars: Record<string, string>, t = template()) {
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m)
  for (const f of profileFiles(t, vars.profile)) {
    const out = join(dest, fill(f.p))
    mkdirSync(dirname(out), { recursive: true })
    const buf = Buffer.from(f.c, 'base64'), text = buf.toString('utf8')
    writeFileSync(out, text.includes('�') ? buf : fill(text))
    chmodSync(out, f.m)
  }
}

/**
 * Commit the rendered template (only what its own .gitignore keeps) to the project's config repo without touching
 * the working tree or index. Returns the commit. The branch `mm-template` holds these commits: it is the merge base
 * `mm update` uses, so a project's own edits and the template's changes meet in an ordinary three-way merge.
 */
export function templateCommit(root: string, vars: Record<string, string>, msg: string, parent?: string, t = template(), gitEnv: Record<string, string> = {}): string {
  const scratch = join(root, '.git', 'mm-render'), index = join(root, '.git', 'mm-template.index')
  rmSync(scratch, { recursive: true, force: true }); rmSync(index, { force: true })
  try {
    renderTo(scratch, vars, t)
    const env = { ...gitEnv, GIT_INDEX_FILE: index } // gitEnv: a box project's hardened host git (review sy-b15.6 2b)
    const git = (args: string[]) => {
      const r = run(['git', '-C', root, ...args], { env })
      if (!r.ok) throw new Error(`git ${args[0]}: ${(r.err || r.out).trim().slice(0, 200)}`)
      return r.out.trim()
    }
    git([`--work-tree=${scratch}`, 'add', '-A', '.'])
    const tree = git(['write-tree'])
    return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg])
  } finally {
    rmSync(scratch, { recursive: true, force: true }); rmSync(index, { force: true })
  }
}
