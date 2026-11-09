#!/usr/bin/env node
// The writing check (sy-ko6r; template/bin/lib/writing.mjs): each rule (word, sentence procedural and descriptive,
// paragraph, passive, ing), what is skipped (numbers, ids, heads, paths, commands, URLs, code marks, keys, role names,
// #n, names), the glossary's terms and their forms, warn vs refuse by refuse_from (and passive/ing never refuse); the
// hooks in message.mjs and owner-card.mjs; bin/message and bin/owner-card warn on stderr and pass before the date and
// refuse after it, a person's comment is not read; the browser's copy is the same file. Pure and hermetic.
//   node test/writing.mjs      exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkWriting, parseWords, refusing, writingCheck, SOFT } from '../template/bin/lib/writing.mjs'
import { readGlossary } from '../template/bin/lib/glossary.mjs'
import { parseMessage } from '../template/bin/lib/message.mjs'
import { parseCard } from '../template/bin/lib/owner-card.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const G = readGlossary((f) => { try { return fs.readFileSync(path.join(SRC, 'template', f), 'utf8') } catch { return null } })
const ROLES = ['ops', 'review', 'platform']
const W = { terms: G.terms, words: parseWords(G.words), roles: ROLES }
const run = (t) => checkWriting(t, W)
const rules = (t) => run(t).map((p) => p.rule)
const clean = (d, t) => { const r = run(t); ok(`${d}: no problem`, r.length === 0, JSON.stringify(r)) }
const has = (d, t, rule, re) => { const r = run(t); ok(`${d}: ${rule}${re ? ` "${re.source}"` : ''}`, r.some((p) => p.rule === rule && (!re || re.test(p.text))), JSON.stringify(r)) }

step('the word list and the glossary load')
ok('the word list has 1000 to 1500 words', W.words.size >= 1000 && W.words.size <= 1500, String(W.words.size))
ok('the glossary has terms, and no errors', G.terms.length > 50 && G.errors.length === 0, JSON.stringify(G.errors))

step('word')
clean('common words', 'Review the head and close the item.')
has('an unknown word', 'Review the frobnicated head.', 'word', /"frobnicated"/)
ok('...each unknown word once', run('The widget and the widget and the widget.').filter((p) => p.rule === 'word').length === 1)
clean('regular forms: -s, -ed, -er, -est, -ly', 'The tests passed. It is shorter. The fastest one. Do it quickly.')
clean('irregular forms of the list', 'Ops wrote the plan and ran the tests.')
clean('glossary terms, one word and more', 'The owner card asks the owner. The Supervisor watches the queue.')
clean('a technical verb in its forms', 'Review signs off the head. Ops claimed the item. Platform hands over the item.')
clean('a term with a hyphen', 'The item has needs-you.')

step('not words: skipped')
clean('numbers and #n', 'See #3: 12 tests passed, 0 failed.')
clean('ids and heads', 'Review signs off mm@abc1234 on sy-ko6r.')
clean('paths and flags', 'Read template/bin/lib/writing.mjs and pass -f with --json.')
clean('code marks', 'Run `frobnicate --xyzzy` on the item.')
clean('URLs, a link\'s address', 'Open https://example.org/x?q=1 or [the plan](docs/zzqx.md).')
clean('names and acronyms in a sentence', 'Ops sends it to Telegram at 14:00 UTC.')
clean('a message key and a role in Expect', 'Expect: review: sign off the head.')
clean('an owner card key', '- **What:** Approve the change.')
clean('a ``` block', 'Run this:\n```\nfrobnicate --quux | xyzzy\n```')
clean('role names', 'Platform asks review and ops.')

step('sentence')
const n = (k) => Array.from({ length: k }, () => 'one').join(' ')
clean('an instruction of 20 words', `Add ${n(19)}.`)
has('an instruction of 21 words', `Add ${n(20)}.`, 'sentence', /an instruction of 21 words \(at most 20\)/)
clean('a descriptive sentence of 25 words', `The ${n(24)}.`)
has('a descriptive sentence of 26 words', `The ${n(25)}.`, 'sentence', /a sentence of 26 words \(at most 25\)/)
has('...after "never": an instruction', `Never add ${n(19)}.`, 'sentence', /instruction of 21/)
ok('a sentence that wraps over two lines is one sentence', run(`The ${n(15)}\n${n(10)}.`).some((p) => p.rule === 'sentence'))
ok('"·" ends a sentence', !run(`The ${n(15)} · ${n(15)}.`).some((p) => p.rule === 'sentence'))
ok('"e.g." does not end a sentence', run('Use a short word, e.g. this one. It is good.').length === 0, JSON.stringify(run('Use a short word, e.g. this one. It is good.')))

step('paragraph')
clean('6 sentences', 'It is one. It is two. It is three. It is four. It is five. It is six.')
has('7 sentences', 'It is one. It is two. It is three. It is four. It is five. It is six. It is seven.', 'paragraph', /7 sentences \(at most 6\)/)
ok('a blank line, a list item or a key line starts a new paragraph', !rules('It is one. It is two. It is three. It is four.\n\nIt is five. It is six. It is seven.').includes('paragraph')
  && !rules('- It is one. It is two. It is three. It is four.\n- It is five. It is six. It is seven.').includes('paragraph'))

step('passive and ing')
has('"is checked"', 'The head is checked by review.', 'passive', /"is checked"/)
has('"was not sent"', 'The plan was not sent.', 'passive', /"was not sent"/)
clean('a state word of the list is no passive', 'The item is blocked. The work is done.')
has('an -ing form', 'The checking of the head.', 'ing', /"checking".*"check"/)
clean('a noun of its own that ends in -ing', 'Nothing is missing. Do something.')

step('warn vs refuse (refuse_from)')
ok('no date: never refusing', !refusing(null) && !refusing(''))
ok('before the date: not refusing', !refusing('2030-01-02', '2030-01-01'))
ok('on the date and after: refusing', refusing('2030-01-02', '2030-01-02') && refusing('2030-01-02', new Date('2030-03-01T00:00:00Z')))
ok('passive and ing are soft', SOFT.includes('passive') && SOFT.includes('ing'))
let errs = []
let p = writingCheck('The frobnicated head is checked.', { ...W, refuseFrom: '2030-01-02', today: '2030-01-01' }, errs)
ok('before the date: problems returned, no errors', p.length >= 2 && errs.length === 0, JSON.stringify(errs))
errs = []
p = writingCheck('The frobnicated head is checked.', { ...W, refuseFrom: '2030-01-02', today: '2030-01-02' }, errs)
ok('on the date: the word refuses, the passive does not', errs.length === 1 && /frobnicated/.test(errs[0]), JSON.stringify(errs))
errs = []
writingCheck(Array.from({ length: 12 }, (_, k) => `zz${'q'.repeat(k + 1)}`).join(' ') + '.', { ...W, refuseFrom: '2000-01-01' }, errs)
ok('at most 8 reasons, then a count', errs.length === 9 && /4 more/.test(errs[8]), JSON.stringify(errs))
ok('no setting: no check', writingCheck('frobnicate', undefined, []).length === 0)

step('the hooks: parseMessage, parseCard')
const NOTE = 'NOTE → ops\nThe frobnicated head.'
ok('a message with no writing setting: as before (ok, no warnings)', parseMessage(NOTE, { roles: ROLES }).ok && parseMessage(NOTE, { roles: ROLES }).writing.length === 0)
let r = parseMessage(NOTE, { roles: ROLES, writing: { terms: G.terms, words: G.words } })
ok('...with one, before the date: ok, one warning on line 2', r.ok && r.writing.length === 1 && r.writing[0].line === 2, JSON.stringify(r))
r = parseMessage(NOTE, { roles: ROLES, writing: { terms: G.terms, words: G.words, refuseFrom: '2000-01-01' } })
ok('...after the date: invalid, the reason names the word', !r.ok && r.errors.some((e) => /frobnicated/.test(e)), JSON.stringify(r.errors))
r = parseMessage('ASK → review\nExpect: review: sign off the head.\nDone when: the item has signed-off.\nVerify: bd show sy-1 → signed-off\nBy: next wake · Else: ops waits\nWhy: the plan is ready.', { roles: ROLES, writing: { terms: G.terms, words: G.words, refuseFrom: '2000-01-01' } })
ok('a good ASK passes after the date (keys, the role, the arrow, By skipped)', r.ok && r.writing.length === 0, JSON.stringify([r.errors, r.writing]))
const CARD = '## Owner\n- **What:** Approve the frobnicated change.\n- **Why:** The machine needs it.\n- **You:** Tap Approve in Telegram.\n- **Link:** artifacts/sy-1/plan.md'
r = parseCard(CARD, [], '', { writing: { terms: G.terms, words: G.words } })
ok('a card, before the date: ok, one warning (What)', r.ok && r.writing.length === 1 && /frobnicated/.test(r.writing[0].text), JSON.stringify(r))
r = parseCard(CARD, [], '', { writing: { terms: G.terms, words: G.words, refuseFrom: '2000-01-01' } })
ok('...after the date: invalid', !r.ok && r.errors.some((e) => /frobnicated/.test(e)))
ok('...with no setting: as before', parseCard(CARD).ok && parseCard(CARD).writing.length === 0)

step('the browser copy')
ok('site/src/lib/writing.mjs is the same file', fs.readFileSync(path.join(SRC, 'template/bin/lib/writing.mjs'), 'utf8') === fs.readFileSync(path.join(SRC, 'template/site/src/lib/writing.mjs'), 'utf8'))

step('bin/message and bin/owner-card')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'writing-'))
try {
  const B = path.join(T, 'board')
  fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(SRC, 'template', 'glossary.yaml'), path.join(B, 'glossary.yaml'))
  fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
  fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: ROLES.map((id) => ({ id })) }))
  const env = { ...process.env, HOME: T, MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
  for (const k of ['BEADS_ACTOR', 'BD_ACTOR']) delete env[k]
  const sh = (args, input, more = {}) => spawnSync(path.join(B, 'bin', args[0]), args.slice(1), { input, encoding: 'utf8', env: { ...env, ...more } })
  const setDate = (d) => fs.writeFileSync(path.join(B, 'glossary.yaml'), fs.readFileSync(path.join(SRC, 'template', 'glossary.yaml'), 'utf8').replace(/^refuse_from:.*$/m, `refuse_from: ${d}`))
  let x = sh(['message', 'check', '-'], NOTE)
  ok('message check -: no date: exit 0, the warning on stderr', x.status === 0 && /writing \(ASD-STE100\): 1 warning/.test(x.stderr) && /frobnicated/.test(x.stderr), x.stderr)
  x = sh(['message', 'gate', 'ops', '--', 'comments', 'add', 'sy-1', NOTE])
  ok('message gate, a lead, no date: passes, warns', x.status === 0 && /frobnicated/.test(x.stderr), x.stderr)
  setDate('2000-01-01')
  x = sh(['message', 'gate', 'ops', '--', 'comments', 'add', 'sy-1', NOTE])
  ok('...after the date: refused, the reason', x.status === 1 && /refused/.test(x.stderr) && /frobnicated/.test(x.stderr), x.stderr)
  x = sh(['message', 'gate', 'alex', '--', 'comments', 'add', 'sy-1', 'The frobnicated widget, please.'])
  ok('...a person\'s comment: not read', x.status === 0 && !x.stderr, x.stderr)
  fs.writeFileSync(path.join(T, 'card.md'), CARD)
  x = sh(['owner-card', 'check', '-'], CARD)
  ok('owner-card check -, after the date: refused (the word)', x.status === 1 && /frobnicated/.test(x.stderr), x.stderr)
  setDate('')
  x = sh(['owner-card', 'check', '-'], CARD)
  ok('...no date: ok, the warning on stderr', x.status === 0 && /frobnicated/.test(x.stderr), x.stderr)
  setDate('2000-01-01')
  x = sh(['owner-card', 'gate', '--', 'create', 'A title', '--body-file', path.join(T, 'card.md'), '-l', 'needs-you'], '', { BEADS_ACTOR: 'ops' })
  ok('owner-card gate, a lead\'s card after the date: refused', x.status === 1 && /frobnicated/.test(x.stderr), x.stderr)
  x = sh(['owner-card', 'gate', '--', 'create', 'A title', '--body-file', path.join(T, 'card.md'), '-l', 'needs-you', '--actor', 'alex'])
  ok('...a person\'s card: words not read, passes', x.status === 0 && !x.stderr, x.stderr)
} finally { fs.rmSync(T, { recursive: true, force: true }) }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
