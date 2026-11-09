#!/usr/bin/env node
// The monitored placements (sy-rfup; template/bin/lib/placements.mjs): the parts of structured blocks counted per kind and
// type, their size (median, max), the most common leading words of text parts; a description's card and Task both
// counted; old text and unreadable blocks never counted as parts. Pure and hermetic.
//   node test/placements.mjs      exit 0 = every check passed
import { countPlacements, formatPlacements, leading, partSize, TOP } from '../template/bin/lib/placements.mjs'
import { formatBlock } from '../template/bin/lib/structured.mjs'

let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const note = (...parts) => formatBlock('message', { intent: 'NOTE', to: 'ops', parts })
const text = (t) => ({ type: 'text', text: t })

ok('partSize: text, markdown, log: their characters (code points)', partSize(text('héllo')) === 5 && partSize({ type: 'log', log: 'ab' }) === 2)
ok('partSize: a table: its cells\' characters', partSize({ type: 'table', columns: ['ab', 'c'], rows: [['x', 12], [null, true]] }) === 2 + 1 + 1 + 2 + 0 + 4)
ok('partSize: an artifact part: its path', partSize({ type: 'image', artifact: 'a/b.png', alt: 'x' }) === 7)
ok('leading: the first 3 words, lowercase, no punctuation at their ends', leading('"Claimed," I said: go!') === 'claimed i said' && leading('  ') === '')

const desc = formatBlock('card', { what: { do: 'apply' }, why: 'access', you: { kind: 'nothing' }, parts: [text('A card.')] }) + '\n\n' +
  formatBlock('task', { act: 'x', do: 'fix', done: { is: 'closed' }, verify: { check: 'a', expect: 'b' }, parts: [{ type: 'mermaid', mermaid: 'graph' }] }) + '\n\nThe rest.'
const texts = [
  note(text('I claim it.'), text('I claim this one.')), note(text('Done: the tests pass.')), note(text('I claim the rest.')),
  note(...Array.from({ length: 7 }, (_, k) => text(`word${k} x y`))),
  desc, 'NOTE → ops\nOld text: never a part.', '```mm-message v1\n{nope}\n```', '',
]
const c = countPlacements(texts)
ok('blocks per kind; with parts', c.blocks.message.n === 4 && c.blocks.message.withParts === 4 && c.blocks.card.n === 1 && c.blocks.task.n === 1, JSON.stringify(c.blocks))
ok('an unreadable block is counted as such', c.unread === 1)
const row = (k, t) => c.rows.find((r) => r.kind === k && r.type === t)
ok('message text: 11 parts; median and max of their sizes', row('message', 'text')?.count === 11 && row('message', 'text')?.max === 21, JSON.stringify(row('message', 'text')))
ok('the card\'s and the Task\'s parts: both counted, in that order of kinds', row('card', 'text')?.count === 1 && row('task', 'mermaid')?.count === 1 && c.rows.map((r) => r.kind).join() === 'message,task,card')
ok(`the leading words: at most ${TOP} (11 text parts, all different)`, row('message', 'text').leads.length === TOP, JSON.stringify(row('message', 'text').leads))
const c2 = countPlacements([note(text('I claim it.')), note(text('I claim it now.')), note(text('Other words here.'))])
ok('..."i claim it" 2, then "other words here" 1', JSON.stringify(c2.rows[0].leads) === JSON.stringify([{ text: 'i claim it', n: 2 }, { text: 'other words here', n: 1 }]))
const md = formatPlacements(c2, { since: '2026-11-09T00:00:00Z' })
ok('formatPlacements: the blocks, a table, the leading words; no judgement', /^Structured blocks since 2026-11-09T00:00:00Z: 3 messages \(3 with parts\)\./.test(md) && /\| message \| text \| 3 \| 15 \| 17 \|/.test(md) && /- message, text: "i claim it" 2, "other words here" 1/.test(md), md)
ok('formatPlacements: none', formatPlacements(countPlacements(['x'])) === 'Structured blocks: none.\n\nNo parts.')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
