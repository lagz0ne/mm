#!/usr/bin/env node
// The Task (sy-lusk; bin/lib/task.mjs, bin/task, bin/bd's gate): the block "## Task" at the top of a description, or
// right after the owner card; Task (at most 20 words), Act (an activity of leads/raci.json), Done when, Verify
// ("<check> → <expected>") required, Head (<repo>@<sha>) optional. bin/bd refuses a lead's create, and a lead's update
// that sets a description, without a valid Task; other actors, other updates and reads pass; -f, --stdin and
// --body-file - are refused for a lead. bin/task check - and check <id>.
// Hermetic: a throwaway folder with a copy of bin/bd, its gates and libs, a stand-in for bd (it records its arguments
// and answers show from a fixture) and for bin/trace.
//   node test/task.mjs        exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatTask, parseTask } from '../template/bin/lib/task.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const ACTS = ['t2-change', 'mm-template']
const TASK = '## Task\n- **Task:** Add V to the RACI and route messages by it.\n- **Act:** mm-template\n- **Done when:** bin/raci shows V for review in t2-change.\n- **Verify:** bin/raci → t2-change row, review column: V\n\nThe rest.'
const CARD = '## Owner\n- **What:** Open the mail port.\n- **Why:** Alerts cannot leave.\n- **You:** Nothing\n'
const errs = (d) => parseTask(d, { acts: ACTS }).errors.join(' | ')

console.log('== formatTask (sy-n3r5: the items the watchdog makes)')
{
  const t = formatTask({ task: 'Find the cause of this alert.', act: 'incident', done: 'it clears', verify: ['bd show x --json', 'status closed'] })
  const p = parseTask(`${t}\n\nThe body.`, { acts: ['incident'] })
  ok('its block parses: Task, Act, Done when, Verify', p.ok && p.task.Act === 'incident' && p.task.Verify === 'bd show x --json → status closed')
  ok('...newlines in a value become spaces (one line per key)', parseTask(formatTask({ task: 'A\nB', act: 'incident', done: 'c', verify: ['d', 'e'] }), { acts: ['incident'] }).task.Task === 'A B')
  ok('...a Head when given', parseTask(formatTask({ task: 'a', act: 'incident', done: 'b', verify: ['c', 'd'], head: 'mm@0a1b2c3' }), { acts: ['incident'] }).task.Head === 'mm@0a1b2c3')
  // each maker puts one at the top of what it opens, and its Task is one instruction of at most 20 words
  for (const [f, re] of [['template/profiles/system/bin/sentinel', /description: `\$\{TASK\}\\n\\n/], ['template/profiles/system/bin/supervisor', /desc = `\$\{task\}\\n\\n/], ['template/bin/health', /description: `\$\{formatTask\(/]]) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8')
    const tasks = [...src.matchAll(/task: (?:p\.parts \? )?'([^']+)'(?: : '([^']+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean)
    ok(`${path.basename(f)}: its items start with formatTask's block`, /formatTask/.test(src) && re.test(src) && tasks.length > 0 && tasks.every((x) => x.split(/\s+/).length <= 20))
  }
}

console.log('== parseTask')
let r = parseTask(TASK, { acts: ACTS })
ok('a valid Task at the top', r.ok && r.found && r.task.Act === 'mm-template' && !('Head' in r.task))
ok('...after the owner card', parseTask(`${CARD}\n${TASK}`, { acts: ACTS }).ok)
ok('...with a Head, and "->" for the arrow', parseTask(TASK.replace('→', '->').replace('\n\nThe rest.', '\n- **Head:** mm@0a1b2c3'), { acts: ACTS }).ok)
ok('no Task: says so', /no Task: the description does not start with "## Task"/.test(errs('Just a text.')))
ok('a Task below other text: not at the top', /the Task is not at the top/.test(errs(`Intro.\n\n${TASK}`)))
ok('...after the card, other text first: not at the top, after the card', /is the first line of the description after the owner card/.test(errs(`${CARD}\nIntro.\n\n${TASK}`)))
ok('Act not a row of raci.json: refused, with the ids', /Act "nope" is not an activity of leads\/raci.json \(t2-change, mm-template\)/.test(errs(TASK.replace('mm-template', 'nope'))))
ok('...no acts given: Act is not checked', parseTask(TASK.replace('mm-template', 'nope')).ok)
ok('a key missing (Verify): refused', /Verify is missing/.test(errs(TASK.replace(/- \*\*Verify:\*\*.*\n/, ''))))
ok('Verify with no arrow: refused', /Verify is not "<the exact check> → <the expected output>"/.test(errs(TASK.replace('bin/raci →', 'bin/raci'))))
ok('a Task of 21 words: refused', /Task is 21 words/.test(errs(TASK.replace('Add V to the RACI and route messages by it.', Array(21).fill('w').join(' ')))))
ok('a bad Head: refused', /Head is not <repo>@<sha>/.test(errs(TASK.replace('\n\nThe rest.', '\n- **Head:** main'))))
ok('an unknown key, a key twice, a line that is no key: refused',
  /unknown key "Owner"/.test(errs(TASK.replace('\n\nThe rest.', '\n- **Owner:** x'))) && /Act is there twice/.test(errs(TASK.replace('\n\nThe rest.', '\n- **Act:** t2-change'))) &&
  /is not "- \*\*Key:\*\* value"/.test(errs(TASK.replace('\n\nThe rest.', '\nfree words'))))

console.log('== bin/bd and bin/task')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'task-'))
try {
  for (const d of ['bin/lib', 'tools', 'control', 'leads']) fs.mkdirSync(path.join(T, d), { recursive: true })
  for (const f of ['bd', 'task', 'message', 'owner-card']) fs.copyFileSync(path.join(SRC, 'template/bin', f), path.join(T, 'bin', f))
  for (const f of ['task.mjs', 'owner-card.mjs', 'message.mjs', 'raci.mjs', 'writing.mjs', 'glossary.mjs']) fs.copyFileSync(path.join(SRC, 'template/bin/lib', f), path.join(T, 'bin/lib', f))
  fs.writeFileSync(path.join(T, 'leads/roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))
  fs.writeFileSync(path.join(T, 'leads/raci.json'), JSON.stringify({ activities: ACTS.map((id) => ({ id, title: id, raci: { platform: 'RA' } })) }))
  fs.writeFileSync(path.join(T, 'bin/trace'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n')
  fs.writeFileSync(path.join(T, 'tools/bd'), `#!/bin/sh\nif [ "$1" = show ]; then cat "${T}/item.json"; exit 0; fi\necho "$*" >>"${T}/ran"\n`)
  for (const f of ['bin/bd', 'bin/task', 'bin/message', 'bin/owner-card', 'bin/trace', 'tools/bd']) fs.chmodSync(path.join(T, f), 0o755)
  const env = { PATH: process.env.PATH, HOME: T }
  const ran = () => { try { return fs.readFileSync(path.join(T, 'ran'), 'utf8') } catch { return '' } }
  const bd = (...a) => { fs.rmSync(path.join(T, 'ran'), { force: true }); return spawnSync(path.join(T, 'bin/bd'), a, { cwd: path.join(T, 'control'), encoding: 'utf8', env }) }
  const refused = (x) => x.status === 1 && !ran() && /bd: refused: a lead's item has a valid Task/.test(x.stderr)
  const passed = (x) => x.status === 0 && !!ran()
  const F = path.join(T, 'desc.md'); fs.writeFileSync(F, TASK)
  const BADF = path.join(T, 'bad.md'); fs.writeFileSync(BADF, 'No task here.')

  let x = bd('create', 'a title', '-d', 'free words', '--actor', 'platform')
  ok('a lead creates an item with no Task: refused, bd never runs', refused(x))
  ok('...the reason names the format and the activities', /no Task/.test(x.stderr) && /Act: one of t2-change, mm-template/.test(x.stderr))
  ok('...a lead creates with no description at all: refused', refused(bd('create', 'a title', '--actor', 'platform')))
  ok('...a worker (platform/w1) too', refused(bd('create', 'a title', '-d', 'x', '--actor', 'platform/w1')))
  ok('a lead creates with a valid Task (-d): passes', passed(bd('create', 'a title', '-d', TASK, '--actor', 'platform')))
  ok('...(--body-file <file>, --description=): passes', passed(bd('create', 'a title', '--body-file', F, '--actor', 'ops')) && passed(bd('create', 'a title', `--description=${TASK}`, '--actor', 'ops')))
  ok('...BEADS_ACTOR=review, bd q: refused without a Task', (() => { env.BEADS_ACTOR = 'review'; const y = bd('q', 'quick'); delete env.BEADS_ACTOR; return refused(y) })())
  ok('a lead\'s create from a file of items (-f), --stdin, --body-file -: refused', refused(bd('create', '-f', F, '--actor', 'ops')) &&
    refused(bd('create', 'x', '--stdin', '--actor', 'ops')) && refused(bd('create', 'x', '--body-file', '-', '--actor', 'ops')))
  ok('a lead updates the description to one with no Task: refused', refused(bd('update', 'sy-1', '--body-file', BADF, '--actor', 'ops')) && refused(bd('update', 'sy-1', '-d', 'x', '--actor', 'ops')))
  ok('...to one with a valid Task: passes', passed(bd('update', 'sy-1', '--body-file', F, '--actor', 'ops')))
  ok('a lead\'s update that sets no description (claim, status, label): passes, the item is not read', passed(bd('update', 'sy-1', '--claim', '--actor', 'ops')) &&
    passed(bd('update', 'sy-1', '-s', 'blocked', '--actor', 'ops')) && passed(bd('label', 'add', 'sy-1', 'x', '--actor', 'ops')))
  ok('wake, watchdog, bridge, mm-upstream and a person create with no Task: pass', ['wake', 'watchdog', 'bridge', 'mm-upstream', 'alex'].every((a) => passed(bd('create', 'a title', '-d', 'free', '--actor', a))))
  ok('...a lead\'s comment is not this gate\'s', passed(bd('comments', 'add', 'sy-1', '--actor', 'ops', '--', 'NOTE → review\nPlan in #2.')))

  const task = (a, input) => spawnSync(process.execPath, [path.join(T, 'bin/task'), ...a], { input, encoding: 'utf8', env })
  x = task(['check', '-'], TASK)
  ok('task check -: a valid one', x.status === 0 && /task ok \(act:mm-template\)/.test(x.stdout))
  x = task(['check', '-'], 'free')
  ok('...an invalid one: exit 1, the reasons', x.status === 1 && /has no Task/.test(x.stderr))
  fs.writeFileSync(path.join(T, 'item.json'), JSON.stringify([{ id: 'sy-1', description: `${CARD}\n${TASK}` }]))
  ok('task check <id>: reads the item through bin/bd show', task(['check', 'sy-1']).status === 0)
} finally { fs.rmSync(T, { recursive: true, force: true }) }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
