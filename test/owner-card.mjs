#!/usr/bin/env node
// The owner card's parser (sy-z5lz; template/bin/lib/owner-card.mjs): valid cards (two written by hand on a board),
// each kind of invalid card with its reason, the t2 keys, the limits, a blank line ending the card, a card not at the
// top; the browser's copy (template/site/src/lib/owner-card.mjs) is the same file; bin/owner-card check - and --t2.
// Pure and hermetic.
//   node test/owner-card.mjs      exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { headRefusal, isGoAsk, NO_GO, parseCard, youKind } from '../template/bin/lib/owner-card.mjs'

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
// a t2 card without a Head (invalid since review sy-hzmu #3), and the full one with it
const T2NH = `## Owner
- **What:** Open the mail port to the relay.
- **Why:** The alerts cannot leave the machine.
- **You:** Tap Approve
- **If yes:** Ops opens the port and tests one alert.
- **If no:** The alerts stay on the board only.
- **Risk:** medium, a wrong rule can close the SSH port; the rollback is tested.

The plan: plans/mail.md`
const T2 = T2NH.replace('- **Risk:**', '- **Head:** mm@0a1b2c3\n- **Risk:**')

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
  const BA = B.replace('**You:** Nothing', '**You:** Tap Approve')
  bad('a t2 go ask with no If yes, If no, Risk', BA, /If yes is missing \(required with t2\)/, ['t2'])
  const r = parseCard(BA, ['t2'])
  ok('...all four named', ['If yes', 'If no', 'Risk', 'Head'].every((k) => r.errors.some((e) => e.startsWith(`${k} is missing`))))
  ok('without t2 they are not required', parseCard(B, ['needs-you']).ok)
  ok('without t2 they may be there', parseCard(T2).ok)
}

step('go and non-go asks on a t2 item (sy-t9tg)')
{
  const NG = (you) => `## Owner
- **What:** Check that the new admin login works before the plan is written.
- **Why:** The plan depends on sudo working for that account.
- **You:** ${you}

The rest.`
  for (const you of ['Check: run ssh admin@host, then sudo -v, and say if it worked', 'Reply: which account?', 'Nothing for you now'])
    ok(`a t2 non-go ask (You: ${you.split(':')[0].split(' ')[0]}) needs no If yes, If no, Risk, Head`, parseCard(NG(you), ['t2', 'needs-you']).ok, JSON.stringify(parseCard(NG(you), ['t2']).errors))
  const C = NG('Check: run ssh admin@host, then sudo -v')
  ok('...its optional keys are checked when there: a bad Risk', !parseCard(C.replace('\n\nThe rest', '\n- **Risk:** maybe\n\nThe rest'), ['t2']).ok)
  ok('...a bad Head', !parseCard(C.replace('\n\nThe rest', '\n- **Head:** mm@main\n\nThe rest'), ['t2']).ok)
  ok('...valid ones are ok', parseCard(C.replace('\n\nThe rest', '\n- **If yes:** ops writes the plan.\n- **Risk:** low, a read-only check\n- **Head:** mm@0a1b2c3\n\nThe rest'), ['t2']).ok)
  bad('a t2 go ask still needs Head', NG('Tap Approve').replace('- **You:** Tap Approve', '- **You:** Tap Approve\n- **If yes:** y\n- **If no:** n\n- **Risk:** low, x'), /Head is missing \(required with t2\)/, ['t2'])
  bad('a t2 card with no You: the go keys are required too (fail-closed)', C.replace(/- \*\*You:\*\* .*\n/, ''), /Head is missing/, ['t2'])
  ok('isGoAsk: only "Tap Approve"', isGoAsk({ You: 'Tap Approve in Telegram' }) && !isGoAsk({ You: 'Check: x, y' }) && !isGoAsk({ You: 'Reply: q' })
    && !isGoAsk({ You: 'Nothing' }) && !isGoAsk({ You: 'Hmm' }) && !isGoAsk({}) && !isGoAsk(null) && !isGoAsk(undefined))
  const H = 'mm@0a1b2c3', CH = C.replace('\n\nThe rest', `\n- **Head:** ${H}\n\nThe rest`)
  ok('headRefusal: a t2 non-go ask gets no go (NO_GO), signed off or not', headRefusal(C, ['t2']) === NO_GO && headRefusal(C, ['t2', 'signed-off']) === NO_GO)
  ok('...not even with a Head review signed', headRefusal(CH, ['t2', 'signed-off', `signed-head:${H}`]) === NO_GO)
  ok('...NO_GO names the reason', /asks for no go/.test(NO_GO))
  ok('headRefusal: a card whose You is no form, with a signed Head: refused (fail-closed)',
    /asks for no go/.test(headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Look at it'), ['t2', 'signed-off', `signed-head:${H}`]) || ''))
  ok('headRefusal: the card changed to a go ask: the go checks apply at once', headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Tap Approve'), ['t2', 'signed-off']) === `review's sign-off names no head (card: ${H})`
    && headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Tap Approve'), ['t2', 'signed-off', `signed-head:${H}`]) === null)
}

step('a blank line ends the card')
{
  const r = parseCard(B.replace('- **You:** Nothing', '\n- **You:** Nothing'))
  ok('a key after a blank line is not in the card (You missing)', !r.ok && r.errors.some((e) => /You is missing/.test(e)) && r.rest.includes('**You:** Nothing'))
  const l = parseCard(`${B.split('\n\n')[0]}\n\n- **When:** later`)
  ok('a list after the blank line is the rest, not the card', l.ok && l.rest === '- **When:** later')
}

step('the Head key and headRefusal (sy-hzmu)')
{
  const H = 'mm@0a1b2c3', H2 = 'mm@9f8e7d6c5b4a'
  const withHead = (h, card = T2NH) => card.replace('- **Risk:**', `- **Head:** ${h}\n- **Risk:**`)
  ok('a Head <repo>@<sha>: ok, read', (() => { const r = parseCard(withHead(H), ['t2']); return r.ok && r.card.Head === H })(), JSON.stringify(parseCard(withHead(H), ['t2']).errors))
  ok('Head: 40 hex, a repo with digits and dashes of 31 characters: ok', parseCard(withHead(`a${'b-1'.repeat(10)}@${'f'.repeat(40)}`), ['t2']).ok)
  bad('Head is required with t2 (no fail-open, review sy-hzmu #3)', T2NH, /Head is missing \(required with t2\)/, ['t2'])
  ok('...without t2 a card needs no Head', parseCard(T2NH, []).ok)
  for (const [d, h] of [['a short sha (6)', 'mm@0a1b2c'], ['a sha of 41', `mm@${'a'.repeat(41)}`], ['upper-case hex', 'mm@0A1B2C3'], ['no repo', '@0a1b2c3'],
    ['a repo of 32', `a${'b'.repeat(31)}@0a1b2c3`], ['a repo starting with a digit', '1mm@0a1b2c3'], ['no @', 'mm0a1b2c3'], ['two heads', `${H} ${H2}`], ['a branch, not a sha', 'mm@main']])
    bad(`Head: ${d}`, withHead(h), /Head is not <repo>@<sha>/, ['t2'])
  const D = withHead(H), D2 = withHead(H2)
  ok('headRefusal: a t2 card with no Head is refused (no fail-open)', /the card names no head/.test(headRefusal(T2NH, ['t2', 'signed-off', `signed-head:${H}`]) || ''))
  ok('headRefusal: the signed head matches: null', headRefusal(D, ['t2', 'signed-off', `signed-head:${H}`]) === null)
  ok('headRefusal: a Set of labels works the same', headRefusal(D, new Set(['t2', 'signed-off', `signed-head:${H}`])) === null)
  ok('headRefusal: no signed-head: "review\'s sign-off names no head (card: X)"', headRefusal(D, ['t2', 'signed-off']) === `review's sign-off names no head (card: ${H})`)
  ok('headRefusal: the head moved: "the head changed since review\'s sign-off (card: X, signed: Y)"',
    headRefusal(D2, ['t2', 'signed-off', `signed-head:${H}`]) === `the head changed since review's sign-off (card: ${H2}, signed: ${H})`)
  ok('headRefusal: a prefix of the head is not the head', headRefusal(D, ['t2', 'signed-off', 'signed-head:mm@0a1b2c']) !== null)
  ok('headRefusal: approved is not re-checked: null', headRefusal(D2, ['t2', 'signed-off', `signed-head:${H}`, 'approved']) === null)
  ok('headRefusal: not t2: null', headRefusal(D2, ['signed-off', `signed-head:${H}`]) === null && headRefusal(D, []) === null)
  ok('headRefusal: an invalid Head is refused, with the reason', /the card's Head is not <repo>@<sha>/.test(headRefusal(withHead('mm@main'), ['t2', 'signed-off', 'signed-head:mm@main']) || ''))
  ok('headRefusal: a t2 with no card is refused; nothing to check without t2', /the card names no head/.test(headRefusal('Some text.', ['t2', 'signed-off']) || '') && headRefusal(undefined, undefined) === null)
}

step('the browser copy and the CLI')
{
  ok('template/site/src/lib/owner-card.mjs is the same file as template/bin/lib/owner-card.mjs',
    fs.readFileSync(path.join(SRC, 'template/site/src/lib/owner-card.mjs'), 'utf8') === fs.readFileSync(path.join(SRC, 'template/bin/lib/owner-card.mjs'), 'utf8'))
  const cli = (input, ...a) => spawnSync(process.execPath, [path.join(SRC, 'template/bin/owner-card'), 'check', '-', ...a], { input, encoding: 'utf8' })
  const g = cli(B), b = cli(`x\n${B}`), t = cli(B.replace('**You:** Nothing', '**You:** Tap Approve'), '--t2'), tn = cli(B, '--t2')
  ok('owner-card check - (valid): exit 0', g.status === 0, g.stderr)
  ok('owner-card check - (not at the top): exit 1, the reason and the format', b.status === 1 && /not at the top/.test(b.stderr) && /The format:/.test(b.stderr), b.stderr)
  ok('owner-card check - --t2: the t2 keys required on a go ask', t.status === 1 && /If no is missing/.test(t.stderr), t.stderr)
  ok('owner-card check - --t2: a non-go ask (You: Nothing) needs none of them', tn.status === 0, tn.stderr)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
