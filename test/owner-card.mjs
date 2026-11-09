#!/usr/bin/env node
// The owner card's parser (sy-z5lz; template/bin/lib/owner-card.mjs): valid cards (two written by hand on a board),
// each kind of invalid card with its reason, the t2 keys, the limits, a blank line ending the card, a card not at the
// top; the browser's copy (template/site/src/lib/owner-card.mjs) is the same file; bin/owner-card check - and --t2.
// Pure and hermetic.
//   node test/owner-card.mjs      exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { approvalRefusal, goLabels, headRefusal, isApproved, isGoAsk, isNonGoAsk, NO_GO, NOT_APPROVED, parseCard, youKind } from '../template/bin/lib/owner-card.mjs'

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

## Task
- **Task:** Open the mail port to the relay.
- **Act:** t2-change
- **Done when:** one alert reaches the relay.
- **Verify:** the alert test → sent
- **Rollback:** close the port again with the plan's rule.
- **Safeguard:** none, no access change

The plan: plans/mail.md`
const GO_TASK = '## Task\n- **Task:** Check the admin login.\n- **Act:** t2-change\n- **Done when:** sudo works.\n- **Verify:** sudo -v → no error\n- **Rollback:** remove the account.\n- **Safeguard:** a second admin session stays open.\n\nThe rest.'
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
  ok('isNonGoAsk: Reply:, Check:, Nothing; not Tap Approve, no form, no You, no card', isNonGoAsk({ You: 'Check: x, y' }) && isNonGoAsk({ You: 'Reply: q' }) && isNonGoAsk({ You: 'Nothing' })
    && !isNonGoAsk({ You: 'Tap Approve' }) && !isNonGoAsk({ You: 'Hmm' }) && !isNonGoAsk({}) && !isNonGoAsk(null))
  const H = 'mm@0a1b2c3', CH = C.replace('\n\nThe rest', `\n- **Head:** ${H}\n\nThe rest`)
  ok('headRefusal: a t2 non-go ask gets no go (NO_GO), signed off or not', headRefusal(C, ['t2']) === NO_GO && headRefusal(C, ['t2', 'signed-off']) === NO_GO)
  ok('...not even with a Head review signed', headRefusal(CH, ['t2', 'signed-off', `signed-head:${H}`]) === NO_GO)
  ok('...NO_GO names the reason', /asks for no go/.test(NO_GO))
  ok('headRefusal: a card whose You is no form, with a signed Head: refused (fail-closed)',
    /asks for no go/.test(headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Look at it'), ['t2', 'signed-off', `signed-head:${H}`]) || ''))
  ok('headRefusal: the card changed to a go ask: the go checks apply at once', headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Tap Approve'), ['t2', 'signed-off']) === `review's sign-off names no head (card: ${H})`
    && headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Tap Approve').replace('The rest.', GO_TASK), ['t2', 'signed-off', `signed-head:${H}`]) === null)
  ok('...and its Task needs a Rollback and a Safeguard then (sy-w5az)', /^the item's Task has no Rollback and no Safeguard line/.test(headRefusal(CH.replace(/\*\*You:\*\* .*/, '**You:** Tap Approve'), ['t2', 'signed-off', `signed-head:${H}`]) || ''))
  ok('a t2 non-go ask needs no Rollback or Safeguard (sy-w5az): NO_GO, never the Task\'s reason', headRefusal(CH, ['t2', 'signed-off', `signed-head:${H}`]) === NO_GO)
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
  // sy-6gz6: approved counts only for the head it was given for (approved-head:<repo>@<sha>)
  const SG = (h) => ['t2', 'signed-off', `signed-head:${h}`]
  ok('approvalRefusal: approved for the card\'s Head, signed: counts (null); headRefusal null', approvalRefusal(D, [...SG(H), 'approved', `approved-head:${H}`]) === null
    && isApproved(D, [...SG(H), 'approved', `approved-head:${H}`]) && headRefusal(D, [...SG(H), 'approved', `approved-head:${H}`]) === null)
  ok('approvalRefusal: approved for the old head, the Head now H2 (signed too): no go, with the reason',
    approvalRefusal(D2, [...SG(H2), 'approved', `approved-head:${H}`]) === `approved for ${H}; the Head is now ${H2}: a new go is needed`
    && !isApproved(D2, [...SG(H2), 'approved', `approved-head:${H}`]))
  ok('...headRefusal reads that item as not approved: a new go may be given for the signed H2 (null)', headRefusal(D2, [...SG(H2), 'approved', `approved-head:${H}`]) === null)
  ok('...and when review signed only the old head: headRefusal gives the head check\'s reason (no fall-through to the old go)',
    headRefusal(D2, [...SG(H), 'approved', `approved-head:${H}`]) === `the head changed since review's sign-off (card: ${H2}, signed: ${H})`)
  // review #3: an approved with no approved-head (a go from before heads were recorded, or the bot before it records
  // one) counts as before, but only for a Head review signed
  ok('approvalRefusal: an old approved with no approved-head, on the signed Head: it counts (as before)',
    approvalRefusal(D, [...SG(H), 'approved']) === null)
  ok('...but not when the card moved past the signed head: a new sign-off and a new go',
    /review's sign-off does not name mm@9f8e7d6c5b4a/.test(approvalRefusal(D2, [...SG(H), 'approved']) || ''))
  ok('approvalRefusal: approved-head for H, but review signed another head: no go', /^approved for mm@0a1b2c3, but review's sign-off does not name mm@0a1b2c3 \(signed: mm@9f8e7d6c5b4a\)/.test(approvalRefusal(D, [...SG(H2), 'approved', `approved-head:${H}`]) || ''))
  ok('approvalRefusal: two approved-head:*: no go (fail closed)', /approved names more than one head/.test(approvalRefusal(D, [...SG(H), 'approved', `approved-head:${H}`, `approved-head:${H2}`]) || ''))
  ok('approvalRefusal: a prefix of the head is not the head', /^approved for mm@0a1b2c;/.test(approvalRefusal(D, [...SG(H), 'approved', 'approved-head:mm@0a1b2c']) || ''))
  ok('approvalRefusal: approved on a t2 card with no Head: no go', /names no valid Head/.test(approvalRefusal(T2NH, ['t2', 'signed-off', 'approved', `approved-head:${H}`]) || ''))
  ok('approvalRefusal: no approved: NOT_APPROVED (an approved-head alone is nothing)', approvalRefusal(D, [...SG(H), `approved-head:${H}`]) === NOT_APPROVED)
  ok('approvalRefusal: not t2: approved counts as it is', approvalRefusal(D2, ['approved']) === null && approvalRefusal('', ['t1', 'approved']) === null)
  ok('goLabels: approved and approved-head:<the card\'s Head>, every other approved-head:* to remove',
    JSON.stringify(goLabels(D2, [...SG(H2), 'approved', `approved-head:${H}`])) === JSON.stringify({ head: H2, add: ['approved', `approved-head:${H2}`], remove: [`approved-head:${H}`] })
    && goLabels(T2NH, ['t2']) === null)
  ok('headRefusal: not t2: null', headRefusal(D2, ['signed-off', `signed-head:${H}`]) === null && headRefusal(D, []) === null)
  ok('headRefusal: an invalid Head is refused, with the reason', /the card's Head is not <repo>@<sha>/.test(headRefusal(withHead('mm@main'), ['t2', 'signed-off', 'signed-head:mm@main']) || ''))
  // sy-w5az: the go needs the Task's Rollback and Safeguard (task.mjs goTaskRefusal), after the head checks
  const SIG = ['t2', 'signed-off', `signed-head:${H}`]
  ok('headRefusal: no Rollback: refused, the reason names it', headRefusal(D.replace(/- \*\*Rollback:\*\*.*\n/, ''), SIG)
    === 'the item\'s Task has no Rollback line: a t2 go needs both (- **Rollback:** how to undo it; - **Safeguard:** the lockout safeguard, or none, no access change)')
  ok('headRefusal: no Safeguard: refused, the reason names it', /^the item's Task has no Safeguard line/.test(headRefusal(D.replace(/- \*\*Safeguard:\*\*.*\n/, ''), SIG) || ''))
  ok('headRefusal: an empty Safeguard counts as none', /has no Safeguard line/.test(headRefusal(D.replace(/(- \*\*Safeguard:\*\*).*/, '$1'), SIG) || ''))
  ok('headRefusal: no Task at all: both named', /has no Rollback and no Safeguard line/.test(headRefusal(D.replace(/## Task[\s\S]*?\n\n/, ''), SIG) || ''))
  ok('headRefusal: the head checks come first (a moved head with no Task: the head\'s reason)', /the head changed/.test(headRefusal(D2.replace(/## Task[\s\S]*?\n\n/, ''), SIG) || ''))
  ok('headRefusal: the reason fits the Waiting list (at most 200 characters)', headRefusal(D.replace(/## Task[\s\S]*?\n\n/, ''), SIG).length <= 200)
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

step('the structured form (sy-rfup, step 1): one ```mm-card v1 block at the top')
{
  const J = (d, rest = '\n\nThe rest.') => '```mm-card v1\n' + JSON.stringify(d, null, 2) + '\n```' + rest
  const go = { what: { do: 'apply', on: 'migrations/port.sh' }, why: 'access', you: { kind: 'approve' }, ifYes: { role: 'ops', do: 'apply', on: 'migrations/port.sh' },
    ifNo: { do: 'nothing' }, risk: { level: 'high', of: ['lockout'] }, head: 'brain@abcdef1', misc: [{ type: 'text', text: 'The port opens.' }] }
  const r = parseCard(J(go), ['t2'])
  ok('a t2 go ask: ok, the keys of the text form', r.ok && r.found && r.card.What === 'apply migrations/port.sh' && r.card.You === 'Tap Approve' && r.card.Risk === 'high, lockout' && r.card.Head === 'brain@abcdef1', r.errors.join('; '))
  ok('...rest: the description after the block; json: the data', r.rest === 'The rest.' && r.json?.why === 'access')
  // sy-w5az: the go also needs the Task's Rollback and Safeguard; a block card is followed by a text Task here
  ok('...isGoAsk; headRefusal: ok with the signed head and a Task with Rollback and Safeguard, refused with another head', isGoAsk(r.card) && headRefusal(J(go, `\n\n${GO_TASK}`), ['t2', 'signed-head:brain@abcdef1']) === null && /changed since review's sign-off/.test(headRefusal(J(go, `\n\n${GO_TASK}`), ['t2', 'signed-head:brain@1234567']) || ''))
  ok('...with no Task, or a ```mm-task v1 block (no rollback or safeguard in task.v1 yet, sy-wx71): the Task reason', /^the item's Task has no Rollback and no Safeguard line/.test(headRefusal(J(go), ['t2', 'signed-head:brain@abcdef1']) || '')
    && /^the item's Task has no Rollback and no Safeguard line/.test(headRefusal(J(go, '\n\n```mm-task v1\n' + JSON.stringify({ act: 't2-change', do: 'apply', on: 'migrations/port.sh', done: { is: 'closed' }, verify: { check: 'ss -lnt', expect: 'the port' } }) + '\n```\n\nThe rest.'), ['t2', 'signed-head:brain@abcdef1']) || ''))
  const { ifYes, ifNo, risk, head, ...short } = go
  const t = parseCard(J(short), ['t2'])
  ok('t2 go ask with none of ifYes, ifNo, risk, head: each is missing', !t.ok && ['ifYes', 'ifNo', 'risk', 'head'].every((k) => t.errors.some((e) => e.startsWith(`${k}: is missing (required with t2`))), t.errors.join('; '))
  ok('...the same card with no t2: ok', parseCard(J(short), []).ok)
  ok('...a non-go ask (reply) on t2 needs none of them', parseCard(J({ ...short, you: { kind: 'reply' } }), ['t2']).ok)
  const rp = parseCard(J({ ...short, you: { kind: 'reply' }, misc: [{ type: 'text', text: 'Which port: 25 or 587?' }] }))
  ok('you reply: You is "Reply: <the first text part>"; youKind reads it; isNonGoAsk', rp.card.You === 'Reply: Which port: 25 or 587?' && youKind(rp.card.You) === 'reply' && isNonGoAsk(rp.card))
  const nq = parseCard(J({ ...short, you: { kind: 'reply' }, misc: [{ type: 'markdown', markdown: 'x' }] }))
  ok('you reply with no text part: refused', !nq.ok && nq.errors.some((e) => /the question is the first text part/.test(e)))
  ok('you check: "Check: <at>"', parseCard(J({ ...short, you: { kind: 'check', at: 'https://x.example/page' } })).card.You === 'Check: https://x.example/page')
  ok('item: a URL of another item is refused', parseCard(J({ ...short, item: 'https://b.example/?item=sy-2' }), [], 'sy-1').errors.some((e) => e === 'item: points to sy-2, not to this item (sy-1)'))
  ok('a schema error: the path and the reason', parseCard(J({ ...short, why: 'because' })).errors.some((e) => e.startsWith('why: "because" is not one of')))
  ok('an mm-task block at the top: no card (found false)', !parseCard('```mm-task v1\n{}\n```').found)
  const words = new Map(['the', 'port', 'opens'].map((x) => [x, { pos: '', base: '' }]))
  const w = parseCard(J({ ...short, misc: [{ type: 'text', text: 'The zorblax opens.' }] }), [], '', { writing: { words, terms: [], refuseFrom: '2020-01-01' } })
  ok('the writing check runs on the text parts', !w.ok && w.writing.length === 1 && w.errors.some((e) => /zorblax/.test(e)), JSON.stringify(w.errors))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
