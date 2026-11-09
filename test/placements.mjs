#!/usr/bin/env node
// The monitored placements (sy-rfup; template/bin/lib/placements.mjs): the parts of structured blocks counted per kind and
// type, their size (median, max), the most common leading words of text parts; a description's card and Task both
// counted; old text and unreadable blocks never counted as parts. Pure and hermetic.
//   node test/placements.mjs      exit 0 = every check passed
import { allows, countPlacements, FLAGS, flagsOf, formatPlacements, leading, partSize, TOP } from '../template/bin/lib/placements.mjs'
import { formatBlock } from '../template/bin/lib/structured.mjs'

let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const note = (...misc) => formatBlock('message', { intent: 'NOTE', to: 'ops', misc })
const text = (t) => ({ type: 'text', text: t })

ok('partSize: text, markdown, log: their characters (code points)', partSize(text('héllo')) === 5 && partSize({ type: 'log', log: 'ab' }) === 2)
ok('partSize: a table: its cells\' characters', partSize({ type: 'table', columns: ['ab', 'c'], rows: [['x', 12], [null, true]] }) === 2 + 1 + 1 + 2 + 0 + 4)
ok('partSize: an artifact part: its path', partSize({ type: 'image', artifact: 'a/b.png', alt: 'x' }) === 7)
ok('leading: the first 3 words, lowercase, no punctuation at their ends', leading('"Claimed," I said: go!') === 'claimed i said' && leading('  ') === '')

const desc = formatBlock('card', { what: { do: 'apply' }, why: 'access', you: { kind: 'nothing' }, misc: [text('A card.')] }) + '\n\n' +
  formatBlock('task', { act: 'x', do: 'fix', done: { is: 'closed' }, verify: { check: 'a', expect: 'b' }, misc: [{ type: 'mermaid', mermaid: 'graph' }] }) + '\n\nThe rest.'
const texts = [
  note(text('I claim it.'), text('I claim this one.')), note(text('Done: the tests pass.')), note(text('I claim the rest.')),
  note(...Array.from({ length: 7 }, (_, k) => text(`word${k} x y`))),
  desc, 'NOTE → ops\nOld text: never a part.', '```mm-message v1\n{nope}\n```', '',
]
const c = countPlacements(texts)
ok('blocks per kind; with misc', c.blocks.message.n === 4 && c.blocks.message.withMisc === 4 && c.blocks.card.n === 1 && c.blocks.task.n === 1, JSON.stringify(c.blocks))
ok('an unreadable block is counted as such', c.unread === 1)
const row = (k, t) => c.rows.find((r) => r.kind === k && r.type === t)
ok('message text: 11 parts; median and max of their sizes', row('message', 'text')?.count === 11 && row('message', 'text')?.max === 21, JSON.stringify(row('message', 'text')))
ok('the card\'s and the Task\'s misc: both counted, in that order of kinds', row('card', 'text')?.count === 1 && row('task', 'mermaid')?.count === 1 && c.rows.map((r) => r.kind).join() === 'message,task,card')
ok(`the leading words: at most ${TOP} (11 text parts, all different)`, row('message', 'text').leads.length === TOP, JSON.stringify(row('message', 'text').leads))
const c2 = countPlacements([note(text('I claim it.')), note(text('I claim it now.')), note(text('Other words here.'))])
ok('..."i claim it" 2, then "other words here" 1', JSON.stringify(c2.rows[0].leads) === JSON.stringify([{ text: 'i claim it', n: 2 }, { text: 'other words here', n: 1 }]))
const md = formatPlacements(c2, { since: '2026-11-09T00:00:00Z' })
ok('formatPlacements: the blocks, a table, the leading words; no judgement', /^Structured blocks since 2026-11-09T00:00:00Z: 3 messages \(3 with misc\)\./.test(md) && /\| message \| text \| 3 \| 15 \| 17 \|/.test(md) && /- message, text: "i claim it" 2, "other words here" 1/.test(md), md)
ok('formatPlacements: none', formatPlacements(countPlacements(['x'])) === 'Structured blocks: none.\n\nNo misc.')
ok('no misc text a field could hold: no flags, no flags table', c2.flags.length === 0 && !/Misc text a typed field/.test(md))

// the misc flags: misc text a typed field could hold, per field, only where the block allows the field
const W = { expect: 'none', verify: { check: 'a', expect: 'b' } }
const done = (...misc) => formatBlock('message', { intent: 'DONE', to: 'ops', result: 'done', ...W, misc })
const F = (t, kind = 'message', data = { intent: 'DONE' }, ids) => flagsOf(kind, data, t, ids)
ok('allows: followUps on a DONE, not on a NOTE; head on a NOTE (no then-branch forbids it)', allows('message', { intent: 'DONE' }, 'followUps') && !allows('message', { intent: 'NOTE' }, 'followUps') && allows('message', { intent: 'NOTE' }, 'head'))
ok('allows: a field no schema has: never; task rollback yes, card risk yes, task risk no', !allows('message', {}, 'nope') && allows('task', {}, 'rollback') && allows('card', {}, 'risk') && !allows('task', {}, 'risk'))
ok('head: <repo>@<sha>', F('Built at mm@abcdef1.').includes('head') && !F('mail me at a@b.c').includes('head') && !F('mm@abc').includes('head'))
ok('re: re #3', F('re #3: yes').includes('re'))
ok('result: signed off, blocked (on a DONE)', F('It is signed off.').includes('result') && F('Blocked on ops.').includes('result'))
ok('verify: a check -> expect pair', F('`bash test/x.sh` → 0 failed').includes('verify') && F('run the scan -> clean').includes('verify') && !F('a -> b').includes('verify'))
ok('by: by 11:00 (a DONE may have By), not on a NOTE (its schema forbids by)', F('Back by 11:00.').includes('by') && !F('Back by 11:00.', 'message', { intent: 'NOTE' }).includes('by'))
ok('...by on an ASK', F('Answer by today.', 'message', { intent: 'ASK' }).includes('by') && F('by 2026-11-10', 'message', { intent: 'ASK' }).includes('by'))
ok('tests: 12/12 passed, 3 failed (on a HANDOFF)', F('12/12 passed', 'message', { intent: 'HANDOFF' }).includes('tests') && F('3 failed', 'message', { intent: 'HANDOFF' }).includes('tests'))
ok('followUps: an id with a digit, or a known id', F('Next: sy-ab1c.').includes('followUps') && !F('Next: sy-rfup.').includes('followUps') && F('Next: sy-rfup.', 'message', { intent: 'DONE' }, new Set(['sy-rfup'])).includes('followUps'))
ok('...not a word with a dash, not inside a path', !F('a read-only re-run').includes('followUps') && !F('see a/sy-ab1c.md').includes('followUps'))
ok('open: an id on a HANDOFF', F('still open: sy-ab1c', 'message', { intent: 'HANDOFF' }).includes('open'))
ok('artifacts: a path with a file type', F('see docs/plan.md').includes('artifacts') && !F('see https://x.io/a.md').includes('artifacts'))
ok('rollback (task), risk and link (card)', F('revert it', 'task', {}).includes('rollback') && F('a lockout', 'card', {}).includes('risk') && F('https://x.io/p', 'card', {}).includes('link'))
ok('a NOTE: none of the intent-bound fields (result, followUps), head yes', JSON.stringify(F('Blocked; sy-ab1c; at mm@abcdef1', 'message', { intent: 'NOTE' })) === JSON.stringify(['head']))
ok('FLAGS: every field is in some schema', FLAGS.every((f) => ['message', 'task', 'card'].some((k) => allows(k, {}, f.field))), FLAGS.map((f) => f.field).join())

const cf = countPlacements([
  { id: 'sy-1', text: done({ type: 'text', text: 'Done at mm@abcdef1; follow-up sy-ab1c.' }, { type: 'markdown', markdown: 'mm@abcdef1' }) },
  { id: 'sy-2', text: done({ type: 'text', text: 'Head mm@1234567.' }) },
  { id: 'sy-2', text: note(text('At mm@1234567, blocked.')) },
  'NOTE → ops\nold text mm@abcdef1',
], { ids: new Set(['sy-1', 'sy-2']) })
const fl = (f) => cf.flags.find((x) => x.field === f)
ok('countPlacements: flags per field, the text parts only, items sorted once each', fl('head')?.count === 3 && JSON.stringify(fl('head').ids) === '["sy-1","sy-2"]', JSON.stringify(cf.flags))
ok('...followUps: 1 (the DONE), result: 0 (blocked was on a NOTE)', fl('followUps')?.count === 1 && !fl('result'), JSON.stringify(cf.flags))
ok('...in FLAGS order', cf.flags.map((f) => f.field).join() === FLAGS.map((f) => f.field).filter((f) => fl(f)).join())
ok('...a string text: counted, no id', countPlacements([note(text('mm@abcdef1'))]).flags[0].ids.length === 0)
const mf = formatPlacements(cf)
ok('formatPlacements: the flags table (field, looks like, text parts, items)', /Misc text a typed field could hold/.test(mf) && /\| head \| <repo>@<sha> \(7 to 40 hex\) \| 3 \| sy-1, sy-2 \|/.test(mf) && /\| followUps \| an item id \| 1 \| sy-1 \|/.test(mf), mf)
ok('...it never changes a message: the texts are the same after', (() => { const t = [done(text('mm@abcdef1'))], b = JSON.stringify(t); countPlacements(t); return JSON.stringify(t) === b })())

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
