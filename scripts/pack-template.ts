// Packs template/ into src/template.gen.json so the compiled mm binary carries the whole project template.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packDir } from '../src/pack'

const t = packDir(join(import.meta.dir, '..', 'template'))
writeFileSync(join(import.meta.dir, '..', 'src', 'template.gen.json'), JSON.stringify(t))
console.log(`packed ${t.files.length} template files, version ${t.version}`)

// template/.gitignore is the projects' one and ignores most of template/ in this repo too: a packed file git does not
// track ships in a local build but not from a clean checkout (CI, releases). Tracked files are fine; new ones need -f.
const repo = join(import.meta.dir, '..')
const r = spawnSync('git', ['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--', 'template'], { encoding: 'utf8' })
const missing = (r.stdout || '').split('\n').filter((f) => f && t.files.some((x) => `template/${x.p}` === f))
if (missing.length) console.warn(`warning: ${missing.length} packed template file(s) not in git (git add -f):\n  ${missing.join('\n  ')}`)
