#!/usr/bin/env node
// The structured content's schemas and validator (sy-rfup; template/bin/lib/schema.mjs, template/bin/lib/schemas/,
// template/bin/lib/structured.mjs): the validator's keywords (each with a valid and an invalid value), the schemas use
// only the keywords it knows and every $ref leads somewhere; valid and invalid examples of the message, the Task and the
// card, with the reason; the block format (read, write, a ` in a part); the browser's copies are the same files, and
// its schemas list names the same JSON files. Pure and hermetic.
//   node test/schema.mjs      exit 0 = every check passed
import fs from 'node:fs'
import path from 'node:path'
import { validator } from '../template/bin/lib/schema.mjs'
import { SCHEMAS } from '../template/bin/lib/schemas.mjs'
import { formatBlock, messageKeys, readBlock, validate, cardKeys, taskKeys, partsText, MAX_BLOCK } from '../template/bin/lib/structured.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)

step('the validator: each keyword')
const T = validator([{ $id: 'urn:t', $defs: { n: { type: 'integer', minimum: 1, maximum: 3 } }, type: 'object', additionalProperties: false, required: ['a'],
  properties: {
    a: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' }, b: { $ref: '#/$defs/n' }, c: { enum: ['x', 'y'] }, d: { const: 'k' },
    e: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'number' } }, f: { type: ['string', 'null'] },
    g: { anyOf: [{ const: 'none' }, { type: 'object', required: ['r'], properties: { r: { type: 'boolean' } } }] },
    h: { oneOf: [{ required: ['p'] }, { required: ['q'] }] }, i: { not: { const: 'bad' } }, j: { type: 'object', minProperties: 1, maxProperties: 1 },
    k: { $ref: 'urn:u#/$defs/w' }, z: false,
  },
  allOf: [{ if: { required: ['c'], properties: { c: { const: 'x' } } }, then: { required: ['d'] }, else: { properties: { d: false } } }] },
{ $id: 'urn:u', $defs: { w: { type: 'string', description: 'a w', pattern: '^w' } } }])
const errs = (x) => T.validate('urn:t', x)
const without = (o, k) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k))
const has = (x, s) => errs(x).some((e) => e.includes(s))
ok('a valid value: no errors', errs({ a: 'abc', b: 2, c: 'x', d: 'k', e: [1, 2], f: null, g: { r: true }, h: { p: 1 }, i: 'ok', j: { x: 1 }, k: 'ww' }).length === 0, JSON.stringify(errs({ a: 'abc', b: 2, c: 'x', d: 'k', e: [1, 2], f: null, g: { r: true }, h: { p: 1 }, i: 'ok', j: { x: 1 }, k: 'ww' })))
ok('required', has({}, 'a: is missing'))
ok('type', has({ a: 3 }, 'a: is a number, not string'))
ok('type list', has({ a: 'ab', f: 1 }, 'f: is a number, not string or null'))
ok('minLength', has({ a: 'a' }, 'a: is 1 characters (at least 2)'))
ok('maxLength (code points: "ééééé" is 5)', has({ a: 'ééééé' }, 'a: is too long (5 characters; at most 4)'))
ok('pattern', has({ a: 'AB' }, 'a: "AB" does not match ^[a-z]+$'))
ok('pattern with a description: the description', has({ a: 'ab', k: 'x' }, 'k: "x" does not match (a w)'))
ok('$ref into another schema', !has({ a: 'ab', k: 'wx' }, 'k:'))
ok('integer', has({ a: 'ab', b: 1.5 }, 'b: is a number, not integer'))
ok('minimum', has({ a: 'ab', b: 0 }, 'b: 0 is less than 1'))
ok('maximum', has({ a: 'ab', b: 4 }, 'b: 4 is more than 3'))
ok('enum', has({ a: 'ab', c: 'z' }, 'c: "z" is not one of x, y'))
ok('const', has({ a: 'ab', d: 'q', c: 'x' }, 'd: is "q", not "k"'))
ok('minItems', has({ a: 'ab', e: [] }, 'e: has 0 item(s) (at least 1)'))
ok('maxItems', has({ a: 'ab', e: [1, 2, 3] }, 'e: has 3 items (at most 2)'))
ok('uniqueItems', has({ a: 'ab', e: [1, 1] }, 'e: has the same item twice'))
ok('items', has({ a: 'ab', e: ['x'] }, 'e[0]: is a string, not number'))
ok('additionalProperties false', has({ a: 'ab', y: 1 }, 'y: is not a key here'))
ok('a false schema', has({ a: 'ab', z: 1 }, 'z: not allowed'))
ok('anyOf: the form whose shape fits gives its errors', has({ a: 'ab', g: { r: 1 } }, 'g.r: is a number, not boolean'))
ok('anyOf: no form fits: one line naming the forms', has({ a: 'ab', g: 'other' }, 'g: "other" is none of the allowed forms ("none" | object)'))
ok('oneOf: none (required forms): "needs one of"', has({ a: 'ab', h: {} }, 'h: needs one of p, q'))
ok('oneOf: two', has({ a: 'ab', h: { p: 1, q: 1 } }, 'h: matches 2 of the forms, where exactly one is allowed (one of p, q)'))
ok('not', has({ a: 'ab', i: 'bad' }, 'i: is a form that is not allowed here'))
ok('minProperties', has({ a: 'ab', j: {} }, 'j: needs at least 1 key(s)'))
ok('maxProperties', has({ a: 'ab', j: { x: 1, y: 2 } }, 'j: has more than 1 keys'))
ok('if/then: the then\'s errors say the condition', has({ a: 'ab', c: 'x' }, 'd: is missing (with c x)'))
ok('if/else', has({ a: 'ab', c: 'y', d: 'k' }, 'd: not allowed'))
ok('an unknown keyword is a problem of the schema', validator([{ $id: 'urn:x', format: 'email' }]).check().some((e) => e.includes('keyword format is not supported')))
ok('a $ref that leads nowhere is a problem of the schema', validator([{ $id: 'urn:x', $ref: '#/$defs/no' }]).check().some((e) => e.includes('nothing at /$defs/no')))
ok('a schema with no $id is refused', (() => { try { validator([{}]); return false } catch { return true } })())

step('the schemas: only known keywords, every $ref leads somewhere')
const V = validator(SCHEMAS)
ok('check(): no problems', V.check().length === 0, V.check().join('; '))
ok('four schemas with their $id', ['common', 'message', 'task', 'card'].every((k) => SCHEMAS.some((s) => s.$id === `urn:mm:schema:${k}:v1`)))
ok('each says it is 2020-12', SCHEMAS.every((s) => s.$schema === 'https://json-schema.org/draft/2020-12/schema'))
const files = fs.readdirSync(path.join(SRC, 'template/bin/lib/schemas')).sort()
ok('the folder has the four files and nothing else', JSON.stringify(files) === JSON.stringify(['card.v1.json', 'common.v1.json', 'message.v1.json', 'task.v1.json']), files.join(' '))
ok('the required fields: message intent, to; task act, do, done, verify; card what, why, you',
  JSON.stringify(SCHEMAS.slice(1).map((s) => s.required)) === JSON.stringify([['intent', 'to'], ['act', 'do', 'done', 'verify'], ['what', 'why', 'you']]))

step('the message: valid examples')
const E = { role: 'review', do: 'review', on: 'mm@abcdef1' }, W = { done: { is: 'signed-off' }, verify: { check: 'bd show sy-1 --json', expect: 'signed-off' }, by: 'today', else: { do: 'escalate', to: 'ops' } }
const good = {
  ASK: { intent: 'ASK', to: 'review', expect: E, ...W, need: 'review', options: ['keep', 'drop'] },
  HANDOFF: { intent: 'HANDOFF', to: 'review', expect: E, ...W, head: 'mm@abcdef1', ready: ['mm@abcdef1', 'artifacts/sy-1/plan.md', 'branch:sy-1'], surfaces: ['bin', 'site:board'], tests: { artifact: 'artifacts/sy-1/t.txt', passed: 3, failed: 0 }, open: ['sy-2'] },
  VERDICT: { intent: 'VERDICT', to: 'platform', re: 2, expect: { role: 'platform', do: 'fix' }, ...W, result: 'blocked', head: 'mm@abcdef1', mustChange: [{ path: 'src/a.ts', line: 3, rule: 'no-secret' }] },
  ANSWER: { intent: 'ANSWER', to: 'platform', re: 1, expect: 'none', answer: 'keep', verify: { check: 'cat plans/x.md', expect: 'keep' } },
  DONE: { intent: 'DONE', to: 'ops', expect: 'none', result: 'done', verify: { check: 'bd show sy-1', expect: 'closed' }, followUps: ['sy-3'], artifacts: ['artifacts/sy-1/log.txt'] },
  NOTE: { intent: 'NOTE', to: 'ops', parts: [{ type: 'text', text: 'I claim it.' }, { type: 'markdown', markdown: '**x**' }, { type: 'mermaid', mermaid: 'graph LR; a-->b' },
    { type: 'html', html: '<p>x</p>' }, { type: 'html', artifact: 'artifacts/sy-1/a.html' }, { type: 'svg', svg: '<svg viewBox="0 0 1 1"></svg>' }, { type: 'image', artifact: 'artifacts/sy-1/a.png', alt: 'the page' },
    { type: 'table', title: 'Tests', columns: ['file', 'n'], rows: [['a', 1], ['b', null]] }, { type: 'log', log: 'line 1\nline 2' }, { type: 'log', artifact: 'artifacts/sy-1/run.log' }] },
}
for (const [k, d] of Object.entries(good)) ok(`${k}: valid`, validate('message', d).length === 0, validate('message', d).join('; '))
ok('By forms: next-wake, today, 09:30, 2026-11-10, 2026-11-10 09:30', ['next-wake', 'today', '09:30', '2026-11-10', '2026-11-10 09:30'].every((by) => validate('message', { ...good.ASK, by }).length === 0))
ok('to a worker (ops/certs)', validate('message', { ...good.NOTE, to: 'ops/certs' }).length === 0)

step('the message: invalid examples, with the reason')
const badMsg = (d, x, s) => { const e = validate('message', x); ok(`${d}: "${s}"`, e.some((y) => y.includes(s)), e.join('; ')) }
badMsg('no intent', { to: 'ops' }, 'intent: is missing')
badMsg('an unknown key', { ...good.NOTE, why: 'x' }, 'why: is not a key here')
badMsg('Expect none on an ASK', { ...good.ASK, expect: 'none' }, 'expect: is a string, not object (with intent ASK)')
badMsg('an Expect action that is no action', { ...good.ASK, expect: { role: 'review', do: 'look' } }, 'expect.do: "look" is not one of')
badMsg('an Expect with free words', { ...good.ASK, expect: { role: 'review', do: 'review', note: 'please' } }, 'expect.note: is not a key here (the keys: role, do, on)')
badMsg('a role with a capital', { ...good.ASK, to: 'Review' }, 'to: "Review" does not match (a role or its worker')
badMsg('By 24:00', { ...good.ASK, by: '24:00' }, 'by: "24:00" does not match')
badMsg('By 2026-13-01', { ...good.ASK, by: '2026-13-01' }, 'by: "2026-13-01" does not match')
badMsg('a role Expect with no Else', without(good.ASK, 'else'), 'else: is missing (with expect an object)')
badMsg('Verify with no expect', { ...good.ASK, verify: { check: 'x' } }, 'verify.expect: is missing')
badMsg('Verify over two lines', { ...good.ASK, verify: { check: 'a\nb', expect: 'x' } }, 'verify.check: "a\\nb" does not match (one line')
badMsg('Done when as words', { ...good.ASK, done: 'when it works' }, 'done: "when it works" is none of the allowed forms')
badMsg('Done when, an unknown state', { ...good.ASK, done: { is: 'nice' } }, 'done.is: "nice" is not one of closed')
badMsg('Surfaces as a sentence', { ...good.HANDOFF, surfaces: ['the board and the bot'] }, 'surfaces[0]: "the board and the bot" does not match (none, or a place')
badMsg('Tests as words', { ...good.HANDOFF, tests: '3 passed' }, 'tests: is a string, not object')
badMsg('Tests with a negative count', { ...good.HANDOFF, tests: { artifact: 'a.txt', passed: -1, failed: 0 } }, 'tests.passed: -1 is less than 0')
badMsg('a VERDICT with no head', without(good.VERDICT, 'head'), 'head: is missing (with intent VERDICT)')
badMsg('a VERDICT "signed off" (the enum is signed-off)', { ...good.VERDICT, result: 'signed off' }, 'result: "signed off" is not one of')
badMsg('Must change with no path', { ...good.VERDICT, mustChange: [{ line: 3 }] }, 'mustChange[0].path: is missing')
badMsg('an ANSWER as a sentence', { ...good.ANSWER, answer: 'Yes, keep it.' }, 'answer: "Yes, keep it." does not match')
badMsg('an ANSWER with no Verify and no role Expect', without(good.ANSWER, 'verify'), 'verify: is missing (with intent ANSWER, expect none)')
badMsg('a DONE that expects a role', { ...good.DONE, expect: E }, 'expect: is {')
badMsg('a NOTE with Expect', { ...good.NOTE, expect: 'none' }, 'expect: not allowed (with intent NOTE)')
badMsg('options with one option', { ...good.ASK, options: ['one'] }, 'options: has 1 item(s) (at least 2)')
badMsg('a head of upper hex', { ...good.HANDOFF, head: 'mm@ABCDEF1' }, 'head: "mm@ABCDEF1" does not match (<repo>@<sha>')
badMsg('an artifact path from /', { ...good.DONE, artifacts: ['/etc/passwd'] }, 'artifacts[0]: "/etc/passwd" does not match (a relative path')
badMsg('an artifact path with ..', { ...good.DONE, artifacts: ['docs/../../x'] }, 'artifacts[0]')
badMsg('a ref with a space', { ...good.ASK, expect: { ...E, on: 'the board' } }, 'expect.on')

step('the parts: each type\'s own keys')
const badPart = (d, p, s) => { const e = validate('message', { intent: 'NOTE', to: 'ops', parts: [p] }); ok(`${d}: "${s}"`, e.some((y) => y.includes(s)), e.join('; ')) }
badPart('an empty parts list', undefined, 'parts[0]')
ok('parts: [] is refused', validate('message', { intent: 'NOTE', to: 'ops', parts: [] }).some((e) => e.includes('parts: has 0 item(s) (at least 1)')))
badPart('an unknown type', { type: 'video' }, 'parts[0].type: "video" is not one of text, markdown, mermaid, html, svg, image, table, log')
badPart('text with a markdown key', { type: 'text', text: 'a', markdown: 'b' }, 'parts[0].markdown: not allowed (with type text)')
badPart('text too long', { type: 'text', text: 'a'.repeat(601) }, 'parts[0].text: is too long (601 characters; at most 600)')
badPart('html with both artifact and html', { type: 'html', html: '<p>', artifact: 'a.html' }, 'parts[0]: matches 2 of the forms')
badPart('html artifact that is no .html', { type: 'html', artifact: 'a.png' }, 'parts[0].artifact: "a.png" does not match \\.html?$')
badPart('inline html over its cap', { type: 'html', html: 'x'.repeat(16001) }, 'parts[0].html: is too long')
badPart('svg that is no <svg>', { type: 'svg', svg: '<script>1</script>' }, 'parts[0].svg')
badPart('an image with no alt', { type: 'image', artifact: 'a.png' }, 'parts[0].alt: is missing (with type image)')
badPart('a table with no columns', { type: 'table', rows: [] }, 'parts[0].columns: is missing (with type table)')
badPart('a table cell that is an object', { type: 'table', columns: ['a'], rows: [[{}]] }, 'parts[0].rows[0][0]')
badPart('a table of 51 rows', { type: 'table', columns: ['a'], rows: Array.from({ length: 51 }, () => ['x']) }, 'parts[0].rows: has 51 items (at most 50)')
badPart('a table row wider than its columns', { type: 'table', columns: ['a'], rows: [['x', 'y']] }, 'parts[0].rows[0]: has 2 cells (the columns: 1)')
badPart('a log over its cap', { type: 'log', log: 'x'.repeat(8001) }, 'parts[0].log: is too long')
badPart('a title over two lines', { type: 'text', text: 'a', title: 'a\nb' }, 'parts[0].title')
ok('17 parts: too many', validate('message', { intent: 'NOTE', to: 'ops', parts: Array.from({ length: 17 }, () => ({ type: 'text', text: 'a' })) }).some((e) => e.includes('parts: has 17 items (at most 16)')))
ok('partsText: the text parts only, a paragraph each', partsText(good.NOTE.parts.concat([{ type: 'text', text: ' Two. ' }])) === 'I claim it.\n\nTwo.')

step('the Task and the card')
const task = { act: 'build', do: 'build', on: 'sy-1', done: { is: 'closed' }, verify: { check: 'bash test/x.sh', expect: '0 failed' }, head: 'mm@abcdef1',
  rollback: { run: 'git revert HEAD' }, safeguard: { check: 'ssh -o BatchMode=yes host true', expect: 'exit 0' }, parts: [{ type: 'text', text: 'Why.' }] }
ok('a Task: valid', validate('task', task).length === 0, validate('task', task).join('; '))
ok('a Task with no act: "act: is missing"', validate('task', without(task, 'act')).includes('act: is missing'))
ok('a Task with words for do', validate('task', { ...task, do: 'Add the schemas' }).some((e) => e.startsWith('do: "Add the schemas" is not one of')))
ok('a Task with an empty rollback', validate('task', { ...task, rollback: {} }).some((e) => e.includes('rollback: needs at least 1 key(s)')))
ok('taskKeys: Task "<do> <on>", Done when, Verify, Rollback, Safeguard', (() => { const k = taskKeys(task); return k.Task === 'build sy-1' && k.Act === 'build' && k['Done when'] === 'this item is closed' && k.Verify === 'bash test/x.sh → 0 failed' && k.Rollback === 'run git revert HEAD' && k.Safeguard === 'ssh -o BatchMode=yes host true → exit 0' })())
const card = { what: { do: 'apply', on: 'migrations/port.sh' }, why: 'access', you: { kind: 'approve' }, ifYes: { role: 'ops', do: 'apply', on: 'migrations/port.sh', by: 'today' },
  ifNo: { do: 'nothing' }, risk: { level: 'medium', of: ['lockout'] }, head: 'brain@abcdef1', link: 'plans/port.md', item: 'https://board.example/?item=sy-1' }
ok('a card: valid', validate('card', card).length === 0, validate('card', card).join('; '))
ok('a card: you check with no at', validate('card', { ...card, you: { kind: 'check' } }).includes('you.at: is missing (with kind check)'))
ok('a card: risk "very"', validate('card', { ...card, risk: { level: 'very' } }).some((e) => e.startsWith('risk.level: "very" is not one of low, medium, high')))
ok('a card: what as words', validate('card', { ...card, what: 'Approve the port' }).some((e) => e.startsWith('what: is a string, not object')))
ok('a card: an item URL with no ?item=', validate('card', { ...card, item: 'https://board.example/' }).some((e) => e.startsWith('item:')))
ok('cardKeys: What, Why, You, If yes, If no, Risk', (() => { const k = cardKeys(card); return k.What === 'apply migrations/port.sh' && k.Why === 'access' && k.You === 'Tap Approve' && k['If yes'] === 'ops: apply migrations/port.sh by today' && k['If no'] === 'nothing' && k.Risk === 'medium, lockout' })())
ok('cardKeys: You reply -> "Reply: <the first text part>"', cardKeys({ ...card, you: { kind: 'reply' }, parts: [{ type: 'mermaid', mermaid: 'x' }, { type: 'text', text: 'Which port?' }] }).You === 'Reply: Which port?')
ok('cardKeys: You check -> "Check: <at>"', cardKeys({ ...card, you: { kind: 'check', at: 'https://x.example/a' } }).You === 'Check: https://x.example/a')

step('messageKeys: the same keys as the text form')
const mk = messageKeys(good.HANDOFF)
ok('Expect "<role>: <do> <on>"; expect { role, action }', mk.keys.Expect === 'review: review mm@abcdef1' && mk.expect.role === 'review' && mk.expect.action === 'review mm@abcdef1')
ok('By "<by> · Else: <do> <to>"; by "today"', mk.keys.By === 'today · Else: escalate ops' && mk.by === 'today')
ok('By hh:mm reads as "hh:mm UTC"', messageKeys({ ...good.ASK, by: '09:30' }).by === '09:30 UTC' && messageKeys({ ...good.ASK, by: 'next-wake' }).by === 'next wake' && messageKeys({ ...good.ASK, by: '2026-11-10 09:30' }).by === '2026-11-10 09:30 UTC')
ok('Ready and Open as lists, Surfaces, Tests', mk.keys.Ready === '- mm@abcdef1\n- artifacts/sy-1/plan.md\n- branch:sy-1' && mk.keys.Surfaces === 'bin, site:board' && mk.keys.Tests === 'artifacts/sy-1/t.txt: 3 passed, 0 failed' && mk.keys.Open === '- sy-2')
ok('VERDICT: Result "signed off" (the text form), Must change "<path>:<line> (<rule>)"', messageKeys({ ...good.VERDICT, result: 'signed-off' }).keys.Result === 'signed off' && messageKeys(good.VERDICT).keys['Must change'] === '- src/a.ts:3 (no-secret)')
ok('a value of the wrong type never throws', (() => { try { messageKeys({ expect: 3, done: 'x', tests: 4, by: 5, mustChange: 'x' }); cardKeys({ you: 3, risk: 'x' }); taskKeys({ rollback: 1 }); messageKeys(null); return true } catch { return false } })())

step('the block')
const blk = formatBlock('message', { intent: 'NOTE', to: 'ops', parts: [{ type: 'markdown', markdown: 'a ```js\nfence``` and `code`' }] })
ok('formatBlock: ```mm-message v1, the JSON, ```', blk.startsWith('```mm-message v1\n{') && blk.endsWith('\n}\n```'))
ok('...a ` in a part is written \\u0060: the fence holds', !blk.slice(3, -3).includes('`'))
const rb = readBlock(`\n\n${blk}\n\nafter`)
ok('readBlock: blank lines before it are ok; kind, v, the data, the rest', rb.kind === 'message' && rb.v === 1 && rb.data.parts[0].markdown === 'a ```js\nfence``` and `code`' && rb.rest === 'after')
ok('readBlock: no block -> null', readBlock('NOTE → ops\nx') === null && readBlock('') === null)
ok('readBlock: an unknown kind', readBlock('```mm-thing v1\n{}\n```').errors[0].startsWith('mm-thing is no kind of block'))
ok('readBlock: v2', readBlock('```mm-task v2\n{}\n```').errors[0] === 'mm-task v2: this board reads v1')
ok('readBlock: not JSON', readBlock('```mm-task v1\n{x}\n```').errors[0].startsWith('the block is not JSON'))
ok('readBlock: an array', readBlock('```mm-task v1\n[1]\n```').errors[0] === 'the block is not one JSON object')
ok('readBlock: no closing fence', readBlock('```mm-task v1\n{}').errors[0].startsWith('the block has no end'))
ok(`readBlock: over ${MAX_BLOCK} characters`, readBlock(formatBlock('message', { intent: 'NOTE', to: 'ops', parts: Array.from({ length: 4 }, () => ({ type: 'html', html: 'x'.repeat(7000) })) })).errors.some((e) => e.startsWith('the block is too long')))
ok('readBlock: \\r\\n line ends read as \\n', readBlock(blk.replace(/\n/g, '\r\n')).data?.intent === 'NOTE')

step('the board\'s copies')
for (const f of ['schema.mjs', 'structured.mjs'])
  ok(`template/site/src/lib/${f} is the same file as template/bin/lib/${f}`, fs.readFileSync(path.join(SRC, 'template/site/src/lib', f), 'utf8') === fs.readFileSync(path.join(SRC, 'template/bin/lib', f), 'utf8'))
const imports = (f) => [...fs.readFileSync(path.join(SRC, f), 'utf8').matchAll(/schemas\/([a-z]+\.v[0-9]+\.json)/g)].map((m) => m[1])
ok('site/src/lib/schemas.mjs imports the same JSON files as bin/lib/schemas.mjs', JSON.stringify(imports('template/site/src/lib/schemas.mjs')) === JSON.stringify(imports('template/bin/lib/schemas.mjs')) && imports('template/bin/lib/schemas.mjs').length === 4)
ok('...from bin/lib/schemas/, next to the site in a project', /'\.\.\/\.\.\/\.\.\/bin\/lib\/schemas\//.test(fs.readFileSync(path.join(SRC, 'template/site/src/lib/schemas.mjs'), 'utf8')))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
