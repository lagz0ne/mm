#!/usr/bin/env node
// The glossary (sy-ko6r; template/bin/lib/glossary.mjs, template/glossary.yaml, template/bin/lib/words.txt): the
// template's glossary and word list are valid (fields, kinds, one entry per term, one meaning sentence, no machine
// path); the parser's errors (unknown key or field, a bad kind, a term twice, a bad since or refuse_from); the merge
// (local adds only: a clash and a local refuse_from are errors); the word list's format; the browser's copy is the same
// file; the template never ships glossary.local.yaml (so mm update, a three-way merge with the template, never writes
// the board's file) and the config repo keeps both files. config-check on a board stamped from the template (both
// profiles): passes; refuses a broken glossary.yaml, a local clash, a term owned by no role, a brief without "Glossary".
// Hermetic (a throwaway HOME / MM_HOME; the stamp needs bun).
//   node test/glossary.mjs      exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkWords, KINDS, mergeGlossary, parseGlossary, readGlossary } from '../template/bin/lib/glossary.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const tpl = (f) => fs.readFileSync(path.join(SRC, 'template', f), 'utf8')

step('the template\'s glossary and word list')
const base = parseGlossary(tpl('glossary.yaml'))
ok('glossary.yaml parses with no error', base.errors.length === 0, JSON.stringify(base.errors))
ok('...refuse_from is there, and empty (warn only until the rollout)', base.hasRefuseFrom && base.refuseFrom === null)
ok('...at least 60 terms, each kind a known one', base.entries.length >= 60 && base.entries.every((e) => KINDS.includes(e.kind)), String(base.entries.length))
for (const t of ['board', 'item', 'lead', 'role', 'worker', 'capacity', 'queue', 'claim', 'lease', 'owner card', 'Supervisor', 'wake', 'template', 'box', 'mm update', 'migration', 'rollback', 'T1', 'T2', 'T3', 'guard', 'head', 'sign-off', 'RACI', 'ASK', 'HANDOFF', 'VERDICT', 'ANSWER', 'DONE', 'NOTE', 'needs-you', 'P0', 'P4'])
  if (!base.entries.some((e) => e.term === t)) ok(`...the term "${t}" is there`, false)
ok('...the seed terms are there (board, item, ... P4)', true)
ok('...no path of a machine, no home folder', !/\/home\/|\/root\/|~\//.test(tpl('glossary.yaml')))
const words = tpl('bin/lib/words.txt')
ok('words.txt: a valid format', checkWords(words).length === 0, JSON.stringify(checkWords(words).slice(0, 5)))
const nw = words.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length
ok(`words.txt: 1000 to 1500 words (${nw})`, nw >= 1000 && nw <= 1500)
ok('the browser\'s copy is the same file', tpl('bin/lib/glossary.mjs') === tpl('site/src/lib/glossary.mjs'))

step('the parser\'s errors')
const err = (d, text, re) => { const r = parseGlossary(text); ok(`${d}: "${re.source}"`, r.errors.some((e) => re.test(e)), JSON.stringify(r.errors)) }
const E = (more = '') => `terms:\n  - term: zed\n    kind: technical name\n    means: A thing.\n    owner: setup\n    since: 2026-11-08 sy-ko6r\n${more}`
ok('a good entry', parseGlossary(E()).errors.length === 0, JSON.stringify(parseGlossary(E()).errors))
ok('...quoted values and comments', parseGlossary(`refuse_from: "2030-01-01"  # the day\n${E().replace('A thing.', '"A thing: the one."')}`).entries[0].means === 'A thing: the one.')
err('an unknown top key', `color: red\n${E()}`, /unknown key "color"/)
err('an unknown field', E('    color: red\n'), /unknown field "color"/)
err('a bad kind', E().replace('technical name', 'noun'), /kind is one of/)
err('a missing field', E().replace('    owner: setup\n', ''), /has no owner/)
err('a term twice (any case)', E() + E().replace('terms:\n', '').replace('zed', 'Zed'), /"Zed" is there twice/)
err('means: two sentences', E().replace('A thing.', 'A thing. Another thing.'), /one plain sentence/)
err('a bad since', E().replace('2026-11-08 sy-ko6r', 'last week'), /since is/)
err('a bad refuse_from', `refuse_from: soon\n${E()}`, /refuse_from is a date/)

step('the merge: local adds only')
const loc = (t) => parseGlossary(t, 'glossary.local.yaml')
let m = mergeGlossary(base, loc(E()))
ok('a new local term: added, marked local', m.errors.length === 0 && m.entries.some((e) => e.term === 'zed' && e.source === 'glossary.local.yaml'))
m = mergeGlossary(base, loc(E().replace('zed', 'Owner Card')))
ok('a local term that is a template term: an error, and not added', m.errors.some((e) => /"Owner Card" is a term of glossary.yaml/.test(e)) && !m.entries.some((e) => e.term === 'Owner Card'), JSON.stringify(m.errors))
m = mergeGlossary(base, loc(`refuse_from: 2030-01-01\n${E()}`))
ok('a local refuse_from: an error', m.errors.some((e) => /no refuse_from here/.test(e)))
const g = readGlossary((f) => ({ 'glossary.yaml': tpl('glossary.yaml'), 'glossary.local.yaml': null, 'bin/lib/words.txt': 'zed n\n' })[f] ?? null)
ok('readGlossary: no local file is fine; terms for the check', g.errors.length === 0 && g.terms.length === base.entries.length && g.words === 'zed n\n')

step('the word list\'s format')
const we = (d, t, re) => ok(`${d}: "${re.source}"`, checkWords(t).some((e) => re.test(e)), JSON.stringify(checkWords(t)))
we('a word twice', 'zed n\nzed v\n', /"zed" is there twice/)
we('a bad part of speech', 'zed noun\n', /part of speech is one of/)
we('not lowercase', 'Zed n\n', /not a lowercase word/)
we('an -ing form with no part of speech', 'checking\n', /an -ing form/)

step('mm update never writes the board\'s glossary.local.yaml')
const all = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : all(path.join(d, e.name))) : [path.join(d, e.name)]))
ok('the template has no glossary.local.yaml (in no profile): mm update merges only its own files', !all(path.join(SRC, 'template')).some((f) => f.endsWith('glossary.local.yaml')))
const gi = tpl('.gitignore')
ok('the config repo keeps glossary.yaml and glossary.local.yaml', gi.includes('!/glossary.yaml') && gi.includes('!/glossary.local.yaml'))

step('config-check on stamped boards')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-'))
try {
  const env = { ...process.env, HOME: path.join(T, 'home'), MM_HOME: path.join(T, 'home', '.mm'), MM_TEMPLATE_DIR: path.join(SRC, 'template'), MM_OBS_TRACES: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['MM_BRAIN', 'MM_PROJECTS', 'MM_SYSTEM', 'MM_BACKUPS']) delete env[k]
  fs.mkdirSync(env.HOME, { recursive: true })
  fs.writeFileSync(path.join(T, 'stamp.ts'), `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '${SRC}/src/template'
import { templateVars } from '${SRC}/src/project'
const [root, profile] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'shop', project: 'acme-shop', short: 'sh', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, ...(profile === 'system' ? { profile } : {}) }, null, 2) + '\\n')
renderTo(root, { ...templateVars(root), profile }, t)
`)
  const bun = ['bun', path.join(env.HOME, '.bun', 'bin', 'bun'), path.join(os.homedir(), '.bun', 'bin', 'bun')].find((b) => spawnSync(b, ['--version']).status === 0)
  if (!bun) { ok('bun is there (to stamp a board)', false); throw new Error('no bun') }
  const PROJ = path.join(env.MM_HOME, 'projects', 'acme', 'shop'), SYS = path.join(env.MM_HOME, 'system')
  for (const [root, prof] of [[PROJ, 'project'], [SYS, 'system']]) {
    const s = spawnSync(bun, [path.join(T, 'stamp.ts'), root, prof], { env, encoding: 'utf8' })
    if (s.status !== 0) { ok(`stamp ${prof}`, false, s.stderr); throw new Error('stamp') }
  }
  const cc = (root, ...a) => spawnSync('node', ['bin/config-check', ...a], { cwd: root, env, encoding: 'utf8' })
  for (const [root, prof] of [[PROJ, 'project'], [SYS, 'system']]) {
    const r = cc(root, '--render')
    ok(`the ${prof} board passes, with glossary.yaml and the word list`, r.status === 0 && fs.existsSync(path.join(root, 'glossary.yaml')), (r.stderr || r.stdout).slice(-600))
  }
  const refuses = (d, root, re, change, undo) => {
    change()
    const r = cc(root)
    ok(`${d}: refused, "${re.source}"`, r.status === 1 && re.test(r.stderr), r.stderr.slice(-600))
    undo()
  }
  const gy = path.join(PROJ, 'glossary.yaml'), orig = fs.readFileSync(gy, 'utf8'), lf = path.join(PROJ, 'glossary.local.yaml')
  refuses('a glossary.yaml with a bad kind', PROJ, /glossary: glossary.yaml:\d+: board: kind is one of/, () => fs.writeFileSync(gy, orig.replace('kind: technical name', 'kind: noun')), () => fs.writeFileSync(gy, orig))
  refuses('no glossary.yaml', PROJ, /missing glossary.yaml/, () => fs.rmSync(gy), () => fs.writeFileSync(gy, orig))
  refuses('a local term that clashes', PROJ, /glossary.local.yaml:2: "board" is a term of glossary.yaml/, () => fs.writeFileSync(lf, E().replace('zed', 'board')), () => fs.rmSync(lf))
  refuses('a local term owned by no role here', PROJ, /owner nobody is not a role here/, () => fs.writeFileSync(lf, E().replace('owner: setup', 'owner: nobody')), () => fs.rmSync(lf))
  fs.writeFileSync(lf, E())
  let r = cc(PROJ)
  ok('a local term that adds: passes', r.status === 0, r.stderr.slice(-400))
  fs.rmSync(lf)
  const wl = path.join(SYS, 'bin', 'lib', 'words.txt'), wo = fs.readFileSync(wl, 'utf8')
  refuses('a word twice in the list', SYS, /words.txt:\d+: "the" is there twice/, () => fs.writeFileSync(wl, `${wo}the det\n`), () => fs.writeFileSync(wl, wo))
  const lb = path.join(SYS, 'leads', 'CLAUDE.md'), lo = fs.readFileSync(lb, 'utf8')
  refuses('a leads\' brief without "## Glossary"', SYS, /lost its "## Glossary" section/, () => fs.writeFileSync(lb, lo.replace('## Glossary\n', '')), () => fs.writeFileSync(lb, lo))
  r = cc(SYS)
  ok('...all back: the system board passes again', r.status === 0, r.stderr.slice(-400))
} catch (e) { if (!['no bun', 'stamp'].includes(e.message)) throw e }
finally { fs.rmSync(T, { recursive: true, force: true }) }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
