#!/usr/bin/env node
// The owner card's parser (sy-z5lz; template/bin/lib/owner-card.mjs): valid cards (two written by hand on a board),
// each kind of invalid card with its reason, the t2 keys, the limits, a blank line ending the card, a card not at the
// top; the browser's copy (template/site/src/lib/owner-card.mjs) is the same file; bin/owner-card check - and --t2.
// Pure and hermetic.
//   node test/owner-card.mjs      exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseCard, youKind } from '../template/bin/lib/owner-card.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const bad = (d, desc, re, labels = []) => { const r = parseCard(desc, labels); ok(`${d}: invalid, "${re.source}"`, !r.ok && r.errors.some((e) => re.test(e)), JSON.stringify(r.errors)) }

// two cards as written by hand (the text of real items; nothing of a machine in them)
const A = `## Owner
- **What:** A fixed short card like this one at the top of each item that needs you, also sent to Telegram as written.
- **Why:** You see in 6 lines what is asked and why, without reading the agents' threads.
- **You:** Reply: ok, or say which line to change.
- **Link:** plans/owner-card.md


The owner (~08:4x): make the output "controlled" ... "loud and clear, correct and enough".
Plan: plans/owner-card.md.`
const B = `## Owner
- **What:** Every item that needs you shows a fixed short card at the top; the board checks it.
- **Why:** You see what is asked and why without reading the agents' threads.
- **You:** Nothing

The owner: "I look at the board, the status is needs you but I don't know why".
Done when: ...`
const T2 = `## Owner
- **What:** Open the mail port to the relay.
- **Why:** The alerts cannot leave the machine.
- **You:** Tap Approve
- **If yes:** Ops opens the port and tests one alert.
- **If no:** The alerts stay on the board only.
- **Risk:** medium, a wrong rule can close the SSH port; the rollback is tested.

The plan: plans/mail.md`

step('valid cards')
{
  const r = parseCard(A, ['needs-you'])
  ok('a hand-written card (Reply, Link): ok', r.ok && r.found, JSON.stringify(r.errors))
  ok('...its keys read', r.card.What.startsWith('A fixed short card') && r.card.You === 'Reply: ok, or say which line to change.' && r.card.Link === 'plans/owner-card.md')
  ok('...the rest without the card', r.rest.startsWith('The owner (~08:4x)') && !/## Owner|\*\*What/.test(r.rest))
  const b = parseCard(B)
  ok('a second one (You: Nothing): ok', b.ok && b.card.You === 'Nothing' && b.rest.startsWith('The owner:'))
  ok('a t2 card with If yes, If no, Risk: ok with t2', parseCard(T2, ['t2', 'needs-you']).ok)
  ok('leading blank lines are ok', parseCard(`\n\n  \n${B}`).ok)
  ok('a blank line between the heading and the list is ok', parseCard(B.replace('## Owner\n', '## Owner\n\n')).ok)
  ok('CRLF line ends are ok', parseCard(B.replace(/\n/g, '\r\n')).ok)
  ok('a card alone (no rest)', (() => { const r = parseCard(B.split('\n\n')[0]); return r.ok && r.rest === '' })())
  ok('You: Check: <what, where>', parseCard(B.replace('**You:** Nothing', '**You:** Check: the shot, artifacts/sy-1/a.png')).ok)
  ok('You: Tap Approve', parseCard(B.replace('**You:** Nothing', '**You:** Tap Approve')).ok)
  ok('a value of exactly 120 characters is ok', parseCard(B.replace(/\*\*What:\*\* .*/, `**What:** ${'x'.repeat(120)}`)).ok)
  ok('Risk with 80 characters after the level is ok', parseCard(T2.replace(/\*\*Risk:\*\* .*/, `**Risk:** low, ${'r'.repeat(80)}`), ['t2']).ok)
  ok('a form with more words after it (where to act), up to 160 characters', parseCard(B.replace('**You:** Nothing', '**You:** Tap Approve in Telegram, or press Approve on this item')).ok
    && parseCard(B.replace('**You:** Nothing', `**You:** Reply: ${'q'.repeat(153)}`)).ok && parseCard(B.replace('**You:** Nothing', '**You:** Nothing for you now.')).ok)
  ok('an Item line: an http(s) URL ending in ?item=<this id>', parseCard(B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Item:** https://board-shop.example.org/?item=ab-12'), [], 'ab-12').ok
    && parseCard(B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Item:** http://127.0.0.1:4100/?item=ab-12.3')).ok)
  ok('youKind: the four forms', youKind('Tap Approve') === 'approve' && youKind('Reply: which?') === 'reply' && youKind('Check: x, y') === 'check' && youKind('Nothing') === 'nothing' && youKind('Look at it') === null)
}

step('invalid cards, each with its reason')
{
  const r = parseCard('Some text.\n\nMore.')
  ok('no card: not found, a reason', !r.ok && !r.found && r.card === null && /no owner card/.test(r.errors[0]) && r.rest === 'Some text.\n\nMore.')
  ok('an empty description: no card', !parseCard('').ok && !parseCard(undefined).ok)
  bad('not at the top', `Intro line.\n\n${B}`, /not at the top/)
  bad('a heading first', `# Title\n${B}`, /not at the top/)
  bad('an unknown key', B.replace('- **You:** Nothing', '- **You:** Nothing\n- **When:** today'), /unknown key "When"/)
  bad('a duplicate key', B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Why:** again'), /Why is there twice/)
  bad('What over 120', B.replace(/\*\*What:\*\* .*/, `**What:** ${'x'.repeat(121)}`), /What is too long \(121 characters; at most 120\)/)
  bad('Why over 120', B.replace(/\*\*Why:\*\* .*/, `**Why:** ${'é'.repeat(121)}`), /Why is too long/)
  bad('If yes over 120', T2.replace(/\*\*If yes:\*\* .*/, `**If yes:** ${'y'.repeat(121)}`), /If yes is too long/, ['t2'])
  bad('If no over 120', T2.replace(/\*\*If no:\*\* .*/, `**If no:** ${'n'.repeat(121)}`), /If no is too long/, ['t2'])
  bad('Risk over 80', T2.replace(/\*\*Risk:\*\* .*/, `**Risk:** high, ${'r'.repeat(81)}`), /Risk is too long/, ['t2'])
  bad('an empty value', B.replace('**Why:** You see', '**Why:**').replace(/(\*\*Why:\*\*).*/, '$1'), /Why is empty/)
  bad('You of no form', B.replace('**You:** Nothing', '**You:** Please look at it'), /You starts with none of/)
  bad('a form glued to more letters ("Tap Approved")', B.replace('**You:** Nothing', '**You:** Tap Approved'), /You starts with none of/)
  bad('You over 160', B.replace('**You:** Nothing', `**You:** Reply: ${'q'.repeat(154)}`), /You is too long \(161 characters; at most 160\)/)
  bad('an Item that is no URL', B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Item:** the board, ab-12'), /Item is not an http\(s\) URL that ends in \?item=/)
  bad('an Item with no ?item=', B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Item:** https://board-shop.example.org/'), /Item is not an http\(s\) URL/)
  bad('an Item with more after the id', B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Item:** https://board-shop.example.org/?item=ab-12&x=1'), /Item is not an http\(s\) URL/)
  { const r = parseCard(B.replace('- **You:** Nothing', '- **You:** Nothing\n- **Item:** https://board-shop.example.org/?item=ab-99'), [], 'ab-12')
    ok('an Item to another item: invalid, "Item points to ab-99, not to this item (ab-12)"', !r.ok && r.errors.includes('Item points to ab-99, not to this item (ab-12)'), JSON.stringify(r.errors)) }
  bad('You: Reply: with no question', B.replace('**You:** Nothing', '**You:** Reply:'), /You starts with none of/)
  bad('Risk without a level', T2.replace(/\*\*Risk:\*\* .*/, '**Risk:** some, it may break'), /Risk does not start with low, medium or high/, ['t2'])
  bad('Risk "lowish"', T2.replace(/\*\*Risk:\*\* .*/, '**Risk:** lowish'), /Risk does not start/, ['t2'])
  bad('What missing', B.replace(/- \*\*What:\*\* .*\n/, ''), /What is missing/)
  bad('You missing', B.replace('- **You:** Nothing\n', ''), /You is missing/)
  bad('a line not of the list', B.replace('- **You:** Nothing', '- **You:** Nothing\nand a note'), /is not "- \*\*Key:\*\* value"/)
  bad('a heading alone', '## Owner\n\nText.', /What is missing/)
  const many = parseCard(B.replace('**You:** Nothing', '**You:** Hmm').replace(/\*\*What:\*\* .*/, `**What:** ${'x'.repeat(130)}`))
  ok('every reason is given, not only the first', many.errors.length === 2, JSON.stringify(many.errors))
}

step('the t2 keys')
{
  bad('t2 with no If yes, If no, Risk', B, /If yes is missing \(required with t2\)/, ['t2'])
  const r = parseCard(B, ['t2'])
  ok('...all three named', ['If yes', 'If no', 'Risk'].every((k) => r.errors.some((e) => e.startsWith(`${k} is missing`))))
  ok('without t2 they are not required', parseCard(B, ['needs-you']).ok)
  ok('without t2 they may be there', parseCard(T2).ok)
}

step('a blank line ends the card')
{
  const r = parseCard(B.replace('- **You:** Nothing', '\n- **You:** Nothing'))
  ok('a key after a blank line is not in the card (You missing)', !r.ok && r.errors.some((e) => /You is missing/.test(e)) && r.rest.includes('**You:** Nothing'))
  const l = parseCard(`${B.split('\n\n')[0]}\n\n- **When:** later`)
  ok('a list after the blank line is the rest, not the card', l.ok && l.rest === '- **When:** later')
}

step('the browser copy and the CLI')
{
  ok('template/site/src/lib/owner-card.mjs is the same file as template/bin/lib/owner-card.mjs',
    fs.readFileSync(path.join(SRC, 'template/site/src/lib/owner-card.mjs'), 'utf8') === fs.readFileSync(path.join(SRC, 'template/bin/lib/owner-card.mjs'), 'utf8'))
  const cli = (input, ...a) => spawnSync(process.execPath, [path.join(SRC, 'template/bin/owner-card'), 'check', '-', ...a], { input, encoding: 'utf8' })
  const g = cli(B), b = cli(`x\n${B}`), t = cli(B, '--t2')
  ok('owner-card check - (valid): exit 0', g.status === 0, g.stderr)
  ok('owner-card check - (not at the top): exit 1, the reason and the format', b.status === 1 && /not at the top/.test(b.stderr) && /The format:/.test(b.stderr), b.stderr)
  ok('owner-card check - --t2: the t2 keys required', t.status === 1 && /If no is missing/.test(t.stderr), t.stderr)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
