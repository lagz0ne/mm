#!/usr/bin/env node
// The message parser (sy-0gsw; template/bin/lib/message.mjs): the six real examples of the plan are valid; each kind
// of invalid message gives its reason; the size limit; dueAt for each By form; openWaits (an ASK answered by re #n, one
// not answered, one late, a HANDOFF on a later answer, a NOTE never waits); the browser's copy is the same file;
// bin/message check -; bin/message gate (a lead's comment refused, a valid one passed, wake/humans exempt, -f, --stdin).
// Pure and hermetic.
//   node test/message.mjs      exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dueAt, MAX, openWaits, parseMessage } from '../template/bin/lib/message.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const ROLES = ['ops', 'review', 'platform']
const good = (d, t) => { const r = parseMessage(t, { roles: ROLES }); ok(`${d}: valid`, r.ok, JSON.stringify(r.errors)); return r }
const bad = (d, t, re) => { const r = parseMessage(t, { roles: ROLES }); ok(`${d}: invalid, "${re.source}"`, !r.ok && r.errors.some((e) => re.test(e)), JSON.stringify(r.errors)) }

// the six examples of the plan (agent messages), names and addresses made neutral
const EX = {
  verdictBlocked: `VERDICT → ops · re #1
Head: brain@3e3f1d1
Result: blocked
Expect: ops: refuse the Approve tap when the item has no signed-off.
Done when: a tap on a t2 item without signed-off writes no approved label.
Verify: node ops/tests/bridge_card_test.mjs → "tap without signed-off: no approved label" ok
By: next wake · Else: the owner gets no button for this change`,
  verdictSigned: `VERDICT → ops · re #4
Head: brain@233d6ee
Result: signed off
Expect: ops: set needs-you, so the bot sends the owner's Approve.
Done when: the bot sends the Approve button for sy-kqla.
Verify: journalctl --user -u paseo-telegram → "needs-you sent","id":"sy-kqla"
By: next wake · Else: nothing goes live
Notes: 1. The card test has 20 checks, not 21. Write the correct number.`,
  handoff: `HANDOFF → review
Head: mm@56ebb96
Expect: review: sign off or block this head.
Done when: the item has signed-off and signed-head:mm@56ebb96, or a VERDICT blocked.
Verify: bd show sy-wxzx → labels include signed-head:mm@56ebb96
By: next wake · Else: ops waits; nothing rolls out
Ready: the artifact command, the secret scan, the files route, the leads' permission
Tests: artifacts/sy-wxzx/gates-56ebb96.txt → 11 suites, 0 failed
Open: pictures are not scanned for secrets.`,
  ask: `ASK → ops
Expect: ops: find why github.com release downloads answer 504.
Done when: the cause is named, with evidence: GitHub, or this machine.
Verify: curl -I <release URL> from the host → 302, not 504
By: 11:00 UTC · Else: clean-box stays blocked
Why: onboard installs no tools, so clean-box fails 14 of 30.`,
  answer: `ANSWER → platform · re #1
Expect: none
Answer: The cause is one edge server of the host. The other edge servers answer 302. Nothing changed here.
Verify: artifacts/sy-cpek/edges.txt → 192.0.2.10: 504; 192.0.2.20: 302`,
  answerFollow: `ANSWER → watchdog · re #1
Head: mm@10bd473
Answer: The commit is on main and in the mm program. No board runs it.
Expect: platform: move 10bd473 from main to branch sy-c7mh, and rebuild mm.
Done when: mm main is a8993b8, and the alarm clears.
Verify: git -C ~/mm rev-parse --short main → a8993b8; sy-kv6h → "Cleared"
By: 15:10 UTC · Else: the alarm stays open, and review audits it`,
  done: `DONE → review · re #8
Head: mm@02f3609
Result: the 3 boards and the gateway run 02f3609. All 11 checks pass.
Expect: none
Verify: artifacts/sy-3wl6/checks.txt → 11 rows, all ok; each board's last commit names template 0.2.0+4702628e
Follow-ups: the owner opens a board link from Telegram (owner card on sy-3wl6).`,
  note: `NOTE → platform
The platform lead had an error since 17:55 UTC (its session was lost). Ops started a new lead at 18:06 UTC.
Your queue: sy-c7mh, sy-0gsw. The plan is linked on the item.`,
}

step('the plan\'s examples are valid')
for (const [k, t] of Object.entries(EX)) good(k, t)
{
  const r = parseMessage(EX.verdictBlocked, { roles: ROLES })
  ok('VERDICT: intent, to, re, Head, expect, by read', r.intent === 'VERDICT' && r.to === 'ops' && r.re === 1 && r.keys.Head === 'brain@3e3f1d1' && r.expect?.role === 'ops' && r.by === 'next wake')
  const a = parseMessage(EX.ask, { roles: ROLES })
  ok('ASK: by 11:00 UTC, no re', a.by === '11:00 UTC' && a.re === null)
  const h = parseMessage(EX.handoff.replace('HANDOFF → review', 'HANDOFF -> review'))
  ok('"->" is the same as "→"; no roles given: any name', h.ok && h.to === 'review')
}

step('each kind of invalid message')
bad('free text', 'I fixed it, please have a look.', /no message header/)
bad('unknown intent', 'PLEASE → ops\nExpect: ops: x', /no message header/)
bad('header with no →', 'ASK ops\nWhy: x', /is not "<INTENT> → <role>"/)
bad('ASK to a person', EX.ask.replace('ASK → ops', 'ASK → alex'), /goes to a role/)
bad('Expect to a person', EX.ask.replace('Expect: ops:', 'Expect: alex:'), /not a role/)
bad('ASK without Why', EX.ask.replace(/\nWhy:.*$/, ''), /Why is missing/)
bad('ASK with Expect: none', EX.ask.replace(/Expect: .*/, 'Expect: none'), /never none/)
bad('ASK without By', EX.ask.replace(/\nBy: .*/, ''), /By is missing/)
bad('ASK without Done when', EX.ask.replace(/\nDone when: .*/, ''), /Done when is missing/)
bad('By without Else', EX.ask.replace('By: 11:00 UTC · Else: clean-box stays blocked', 'By: 11:00 UTC'), /By is not/)
bad('By as free words', EX.ask.replace('By: 11:00 UTC', 'By: soon'), /By is not/)
bad('By 25:00', EX.ask.replace('By: 11:00 UTC', 'By: 25:00 UTC'), /the hour is 00 to 23/)
bad('Verify with no expected output', EX.ask.replace(/Verify: .*/, 'Verify: looks good'), /Verify is not/)
bad('Expect not "<role>: …"', EX.ask.replace(/Expect: .*/, 'Expect: please find it'), /Expect is not/)
bad('Expect over 20 words', EX.ask.replace(/Expect: ops: .*/, `Expect: ops: ${'word '.repeat(21).trim()}`), /at most 20/)
bad('VERDICT without Head', EX.verdictSigned.replace(/\nHead: .*/, ''), /Head is missing/)
bad('VERDICT with another Result', EX.verdictSigned.replace('Result: signed off', 'Result: fine'), /signed off" or "blocked/)
bad('bad Head', EX.handoff.replace('mm@56ebb96', 'mm@main'), /Head is not/)
bad('ANSWER with no re', EX.answer.replace(' · re #1', ''), /says what it answers/)
bad('ANSWER without Verify', EX.answer.replace(/\nVerify: .*/, ''), /Verify is missing/)
bad('DONE with an Expect role', EX.done.replace('Expect: none', 'Expect: review: check it.'), /a follow-up is a new item/)
bad('a key of another intent', EX.ask + '\nReady: all', /has no key "Ready"/)
bad('a key twice', EX.ask + '\nWhy: again', /Why is there twice/)
bad('a free line in the body', EX.ask + '\nand one more thing', /is not "Key: value"/)
bad('NOTE with an Expect', 'NOTE → ops\nExpect: ops: do it', /a NOTE has no Expect/)
bad('NOTE with no text', 'NOTE → ops', /one line of text/)
bad('re #0', 'NOTE → ops · re #0\nok', /re #0/)
bad('too long', `NOTE → ops\n${'x'.repeat(MAX)}`, /too long/)
{
  const r = parseMessage(EX.verdictSigned + '\n- 2. a second note', { roles: ROLES })
  ok('a list line goes on the key above it', r.ok && r.keys.Notes.includes('\n- 2. a second note'), JSON.stringify(r.errors))
}

step('dueAt')
const at = '2026-11-08T10:30:00Z', T = (s) => Date.parse(s)
ok('next wake: +60 min by default', dueAt('next wake', at) === T('2026-11-08T11:30:00Z'))
ok('next wake: +30 min when told', dueAt('next wake', at, 30) === T('2026-11-08T11:00:00Z'))
ok('today: the end of the UTC day', dueAt('today', at) === T('2026-11-09T00:00:00Z'))
ok('11:00 UTC: the same day', dueAt('11:00 UTC', at) === T('2026-11-08T11:00:00Z'))
ok('09:00 UTC (past): the next day', dueAt('09:00 UTC', at) === T('2026-11-09T09:00:00Z'))
ok('a date: its end', dueAt('2026-11-10', at) === T('2026-11-11T00:00:00Z'))
ok('a date and a time', dueAt('2026-11-10 08:15 UTC', at) === T('2026-11-10T08:15:00Z'))
ok('no By: null', dueAt(null, at) === null)

step('openWaits: what waits on whom')
{
  const c = (author, text, created_at) => ({ author, text, created_at })
  const thread = [
    c('platform', EX.ask, '2026-11-08T10:00:00Z'), // #1 ASK → ops, by 11:00
    c('ops', EX.answer, '2026-11-08T10:40:00Z'), // #2 answers #1
    c('platform', EX.handoff, '2026-11-08T12:00:00Z'), // #3 HANDOFF → review, next wake
    c('alex', 'please hurry', '2026-11-08T12:05:00Z'), // #4 a human: not a message
    c('platform', EX.note, '2026-11-08T12:06:00Z'), // #5 a NOTE: never waits
    c('platform', EX.ask.replace('By: 11:00 UTC', 'By: today'), '2026-11-08T12:10:00Z'), // #6 ASK, today
  ]
  const w = openWaits(thread, { roles: ROLES, now: T('2026-11-08T13:30:00Z') })
  ok('two wait: #3 (HANDOFF) and #6 (ASK)', w.map((x) => x.n).join(',') === '3,6', JSON.stringify(w))
  ok('#3 waits on review, late (next wake + 60 min passed)', w[0]?.role === 'review' && w[0]?.late === true)
  ok('#6 waits on ops, not late yet (today)', w[1]?.role === 'ops' && w[1]?.late === false)
  thread.push(c('review', EX.verdictSigned.replace('re #4', 're #3'), '2026-11-08T13:40:00Z'))
  ok('a VERDICT re #3 answers the HANDOFF', openWaits(thread, { roles: ROLES }).map((x) => x.n).join(',') === '6')
  ok('an answer before the message does not count', openWaits([c('ops', EX.answer, at), c('platform', EX.ask, at)], { roles: ROLES }).length === 1)
  ok('an invalid ASK never waits', openWaits([c('platform', EX.ask.replace(/\nWhy:.*$/, ''), at)], { roles: ROLES }).length === 0)
}

step('the browser\'s copy is the same file')
ok('site/src/lib/message.mjs == bin/lib/message.mjs', fs.readFileSync(path.join(SRC, 'template/site/src/lib/message.mjs'), 'utf8') === fs.readFileSync(path.join(SRC, 'template/bin/lib/message.mjs'), 'utf8'))

step('bin/message check and gate')
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'message-'))
fs.mkdirSync(path.join(D, 'bin', 'lib'), { recursive: true }); fs.mkdirSync(path.join(D, 'leads'))
fs.copyFileSync(path.join(SRC, 'template/bin/message'), path.join(D, 'bin/message'))
for (const f of ['message.mjs', 'owner-card.mjs']) fs.copyFileSync(path.join(SRC, 'template/bin/lib', f), path.join(D, 'bin/lib', f))
fs.writeFileSync(path.join(D, 'leads/roles.json'), JSON.stringify({ roles: ROLES.map((id) => ({ id })) }))
const run = (args, input, env = {}) => spawnSync(process.execPath, [path.join(D, 'bin/message'), ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
{
  let r = run(['check', '-'], EX.handoff)
  ok('check -: a valid message, exit 0', r.status === 0, r.stderr)
  r = run(['check', '-'], 'just text')
  ok('check -: free text, exit 1 with the reason', r.status === 1 && /no message header/.test(r.stderr), r.stderr)
  const gate = (actor, args, input) => run(['gate', actor, '--', ...args], input)
  r = gate('platform', ['comments', 'add', 'sy-1', 'done, have a look'])
  ok('gate: a lead\'s free text is refused (exit 1, the format)', r.status === 1 && /refused/.test(r.stderr) && /ASK, HANDOFF/.test(r.stderr), r.stderr)
  r = gate('platform', ['comments', 'add', 'sy-1', EX.handoff])
  ok('gate: a lead\'s valid message passes', r.status === 0, r.stderr)
  r = gate('platform', ['comment', 'sy-1', ...EX.note.split(' ')])
  ok('gate: bd comment <id> words… are joined and checked', r.status === 0, r.stderr)
  r = gate('ops/certs', ['comments', 'add', 'sy-1', 'free text'])
  ok('gate: a worker (<role>/<name>) is a lead too', r.status === 1, r.stderr)
  for (const a of ['wake', 'watchdog', 'bridge', 'alex', 'mm-upstream']) {
    r = gate(a, ['comments', 'add', 'sy-1', 'free text'])
    ok(`gate: ${a} is exempt`, r.status === 0, r.stderr)
  }
  r = gate('platform', ['comments', 'add', 'sy-1', '--author', 'alex', 'free text'])
  ok('gate: --author does not exempt a lead', r.status === 1, r.stderr)
  fs.writeFileSync(path.join(D, 'm.txt'), EX.done)
  r = gate('review', ['comments', 'add', 'sy-1', '-f', path.join(D, 'm.txt')])
  ok('gate: -f <file> is read and checked', r.status === 0, r.stderr)
  fs.writeFileSync(path.join(D, 'm.txt'), 'free')
  r = gate('review', ['comments', 'add', 'sy-1', `--file=${path.join(D, 'm.txt')}`])
  ok('gate: --file=<file> with free text is refused', r.status === 1, r.stderr)
  r = gate('review', ['comment', 'sy-1', '--stdin'])
  ok('gate: --stdin is refused for a lead (cannot be checked first)', r.status === 1 && /--stdin/.test(r.stderr), r.stderr)
  r = gate('platform', ['comments', 'add', 'sy-1', '--', EX.ask])
  ok('gate: text after -- is the comment', r.status === 0, r.stderr)
  r = gate('platform', ['list', '--json'])
  ok('gate: a call that writes no comment passes', r.status === 0, r.stderr)
  r = gate('platform', ['comments', 'sy-1'])
  ok('gate: reading comments passes', r.status === 0, r.stderr)
}
fs.rmSync(D, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
