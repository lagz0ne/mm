// Packs template/ into src/template.gen.json so the compiled mm binary carries the whole project template.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packDir } from '../src/template'

const t = packDir(join(import.meta.dir, '..', 'template'))
writeFileSync(join(import.meta.dir, '..', 'src', 'template.gen.json'), JSON.stringify(t))
console.log(`packed ${t.files.length} template files, version ${t.version}`)
