#!/usr/bin/env node
// The RACI (sy-lusk; bin/lib/raci.mjs, bin/raci, config-check's RACI part): the letters R A V C I, exactly one A and at
// least one R per row, C and I never with R, A or V, a person only A or I, a row with a C lists its consult cases (a case
// "<role>: ..." names a C of the row); the helpers wake, bin/message and the Supervisor use (mayAsk, noInputOk); both
// templates' raci.json are valid against their roles.json, and the system board's t2-change row has V for review;
// bin/raci shows V and the cases, renders them, and `raci consult` sets a row's cases. The routine fields (sy-mv69.2):
// when, bounds, verify, correct valid and invalid; cases/judge/outside; render and show list them.
// Hermetic: a throwaway folder with a copy of bin/raci and its libs.
//   node test/raci.mjs        exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { actOf, cases, judge, lettersOf, mayAsk, noInputOk, outside, problems, rowOf, withLetter } from '../template/bin/lib/raci.mjs'
const MIN0 = 60000

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const P = ['ops', 'review', 'platform', 'human']
const one = (raci, consult) => problems({ activities: [{ id: 'x', title: 'X', raci, ...(consult ? { consult } : {}) }] }, P)

console.log('== problems()')
ok('a row with R, V, A, C (and its case), I: fine', one({ platform: 'R', review: 'V', human: 'A', ops: 'C' }, ['ops: when it changes a port']).length === 0)
ok('RA, VA and CI are cells', one({ ops: 'RA', review: 'VA', platform: 'CI' }, ['platform: when mm is in it']).some((m) => /exactly one Accountable \(has 2\)/.test(m)) &&
  one({ ops: 'RA', review: 'V', platform: 'CI' }, ['platform: when mm is in it']).length === 0)
ok('no A: refused', one({ ops: 'R' }).some((m) => /exactly one Accountable \(has 0\)/.test(m)))
ok('no R: refused', one({ ops: 'A' }).some((m) => /at least one Responsible/.test(m)))
ok('an unknown letter (X) or one twice (RR): refused', one({ ops: 'RX', human: 'A' }).some((m) => /bad letters ops=RX/.test(m)) && one({ ops: 'RR', human: 'A' }).some((m) => /bad letters/.test(m)))
ok('C with R (RC) or I with V (VI): refused', one({ ops: 'RC', human: 'A' }, ['ops: x']).some((m) => /C and I never go with R, A or V/.test(m)) &&
  one({ ops: 'R', review: 'VI', human: 'A' }).some((m) => /C and I never go/.test(m)))
ok('a person is only A or I: human=V, human=C, human=R refused', ['V', 'C', 'R'].every((l) => one({ ops: 'RA', human: l }, ['human: x']).some((m) => /a person is only A or I/.test(m))))
ok('a C with no consult cases: refused', one({ ops: 'C', platform: 'R', human: 'A' }).some((m) => /has a C \(ops\) but no consult cases/.test(m)))
ok('a case that names a role that is not C in the row: refused', one({ ops: 'C', platform: 'R', human: 'A' }, ['review: when x']).some((m) => /names review, which is not C/.test(m)))
ok('consult not a list of lines: refused', one({ ops: 'RA' }, 'when x').some((m) => /consult is a list of cases/.test(m)) && one({ ops: 'RA' }, ['']).some((m) => /consult is a list/.test(m)))
ok('an unknown participant: refused', one({ ops: 'RA', qa: 'I' }).some((m) => /unknown participant qa/.test(m)))

console.log('== the routine fields: when, bounds, verify, correct (sy-mv69.2)')
const rt = (f) => problems({ activities: [{ id: 'x', title: 'X', raci: { ops: 'RA' }, ...f }] }, P)
ok('an old row without them: fine', rt({}).length === 0)
ok('all four, valid: fine', rt({ bounds: { tier: 't1', paths: ['bin/'], end: '2026-11-11T18:00:00Z' }, verify: { check: 'bin/brain status', expect: 'no ALERT' }, correct: 'the .rollback.sh',
  when: ['sentinel:drift', { on: 'brain:score *', text: '^score', next: 'none', bounds: { within: { of: 'migration', minutes: 60 }, for_min: 30, times: 1, exclude: 'kernel' },
    verify: { check: 'a', expect: 'b' }, correct: 'unexpected: a person decides' }] }).length === 0)
ok('when: an unknown event kind, a case with no kind, not a list, an unknown key: refused',
  rt({ when: ['mail:x'] }).some((m) => /when #1: unknown event kind mail/.test(m)) && rt({ when: ['drift'] }).some((m) => /a when case is "<kind>:<pattern>"/.test(m)) &&
  rt({ when: 'sentinel:drift' }).some((m) => /when is a list of cases/.test(m)) && rt({ when: [{ on: 'sentinel:x', run: 'rm -rf /' }] }).some((m) => /unknown key run/.test(m)) &&
  rt({ when: [{ on: 'sentinel:x', text: '(' }] }).some((m) => /text is a regex/.test(m)))
ok('bounds: an unknown tier, bound, end, within, for_min, times: refused', rt({ bounds: { tier: 't9' } }).some((m) => /bounds\.tier/.test(m)) &&
  rt({ bounds: { size: 1 } }).some((m) => /unknown bound size/.test(m)) && rt({ bounds: { end: 'soon' } }).some((m) => /bounds\.end is an ISO time/.test(m)) &&
  rt({ bounds: { within: { of: 'lunch', minutes: 5 } } }).some((m) => /bounds\.within/.test(m)) && rt({ bounds: { for_min: -1 } }).some((m) => /for_min/.test(m)) &&
  rt({ bounds: { times: 1.5 } }).some((m) => /bounds\.times/.test(m)) && rt({ when: [{ on: 'sentinel:x', bounds: { paths: [] } }] }).some((m) => /when #1: bounds\.paths is a list/.test(m)))
ok('verify: no expect, or an extra key: refused', rt({ verify: { check: 'a' } }).some((m) => /verify is \{ "check"/.test(m)) && rt({ verify: { check: 'a', expect: 'b', run: 'c' } }).some((m) => /verify is/.test(m)))
ok('correct: empty, or more than one line: refused', rt({ correct: '' }).some((m) => /correct is one line/.test(m)) && rt({ correct: 'a\nb' }).some((m) => /correct is one line/.test(m)))
const cs = cases([{ id: 'inc', raci: { ops: 'RA' }, verify: { check: 'row check', expect: 'ok' }, when: [
  { on: 'sentinel:drift', text: 'admin', next: 'none' },
  { on: 'sentinel:drift', bounds: { within: { of: 'migration', minutes: 60 } } },
  { on: 'brain:ALERT *RAID*', correct: 'unexpected: a person decides' }] }, { id: 'bad', raci: {}, when: ['nope:x'] }])
ok('cases(): flat, the row\'s verify filled in, a row with a problem left out', cs.length === 3 && cs[1].verify.check === 'row check' && cs.every((c) => c.row === 'inc'))
const now = Date.parse('2026-11-10T12:00:00Z')
ok('judge: a case with text, every line matches: routine', judge(cs, { events: ['sentinel:drift'], lines: ['+ login admin'] }, { now }).routine)
ok('judge: no case: unexpected, "no row"', /no row/.test(judge(cs, { events: ['sentinel:alert:x'] }, { now }).why))
ok('judge: within 60 min of a migration: routine; 70 min: outside, with the bound', judge(cs, { events: ['sentinel:drift'], lines: ['x'] }, { now, last: { migration: now - 10 * MIN0 } }).routine &&
  /not within 60 min after the last migration/.test(judge(cs, { events: ['sentinel:drift'], lines: ['x'] }, { now, last: { migration: now - 70 * MIN0 } }).why))
ok('judge: a glob on a status line, correct "unexpected": unexpected, with the case', (() => { const v = judge(cs, { events: ['brain:ALERT RAID md0 degraded'] }, { now }); return !v.routine && v.case?.n === 3 && /says: unexpected: a person decides/.test(v.why) })())
ok('outside(): end, exclude, gates, for_min, times', /ended/.test(outside({ end: '2026-01-01T00:00:00Z' }, {}, { now })) && /exclude/.test(outside({ exclude: 'kernel' }, { lines: ['kernel-6'] }, { now })) &&
  outside({ within: { of: 'gates', minutes: 5 } }, {}, { now, gates: [[now - 30 * MIN0, now - 2 * MIN0]] }) === null && /gates run/.test(outside({ within: { of: 'gates', minutes: 5 } }, {}, { now, gates: [] })) &&
  /more than 10 min/.test(outside({ for_min: 10 }, {}, { now, since: now - 11 * MIN0 })) && /episode 2/.test(outside({ times: 1 }, {}, { now, times: 2 })) && outside({ times: 1 }, {}, { now, times: 1 }) === null)
ok('the system board\'s first when rows: 10 cases or more, each on a known kind, and the RAID one escalates',
  (() => { const s = cases(JSON.parse(fs.readFileSync(path.join(SRC, 'template/profiles/system/leads/raci.json'), 'utf8')).activities); return s.length >= 10 && s.some((c) => /RAID/.test(c.on) && /^unexpected/.test(c.correct)) })())

console.log('== the helpers')
const rows = [{ id: 'chg', title: 'A change', raci: { platform: 'R', review: 'VA', ops: 'C', human: 'I' }, consult: ['ops: when it changes a port'] }]
const r = rowOf(rows, actOf(['t2', 'act:chg']))
ok('actOf reads act:<id>; rowOf finds the row', actOf(['x', 'act:chg']) === 'chg' && r?.id === 'chg' && rowOf(rows, 'none') === null && actOf([]) === null)
ok('lettersOf: a worker counts as its role', lettersOf(r, 'review/w1') === 'VA' && lettersOf(r, 'qa') === '')
ok('withLetter', withLetter(r, 'V').join() === 'review' && withLetter(r, 'I').join() === 'human')
ok('mayAsk: C, V, R, A yes; I and no letter no; no row: yes', mayAsk(r, 'ops') && mayAsk(r, 'review') && mayAsk(r, 'platform') && !mayAsk(r, 'human') && !mayAsk(r, 'qa') && mayAsk(null, 'qa'))
ok('noInputOk: only an ASK to a C', noInputOk(r, 'ops', 'ASK') && !noInputOk(r, 'ops', 'HANDOFF') && !noInputOk(r, 'review', 'ASK') && !noInputOk(null, 'ops', 'ASK'))

console.log('== the templates\' rows')
const roles = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')).roles.map((x) => x.id)
const sys = JSON.parse(fs.readFileSync(path.join(SRC, 'template/profiles/system/leads/raci.json'), 'utf8'))
const proj = JSON.parse(fs.readFileSync(path.join(SRC, 'template/leads/raci.json'), 'utf8'))
const sp = problems(sys, [...roles('template/profiles/system/leads/roles.json'), 'human']), pp = problems(proj, [...roles('template/leads/roles.json'), 'human'])
ok(`the system board's raci.json is valid${sp.length ? `: ${sp.join('; ')}` : ''}`, sp.length === 0)
ok(`the project's raci.json is valid${pp.length ? `: ${pp.join('; ')}` : ''}`, pp.length === 0)
ok('system: t2-change has V for review and A for the human', rowOf(sys.activities, 't2-change')?.raci.review === 'V' && rowOf(sys.activities, 't2-change')?.raci.human === 'A')
ok('system: the activity ids items carry today are kept', ['t1-change', 't2-change', 'incident', 'posture', 'mm-template', 'mm-release', 'project-rollout', 'project-governance', 'sync'].every((id) => rowOf(sys.activities, id)))

ok('template/site/src/lib/raci.mjs (the board\'s RACI view) is the same file as template/bin/lib/raci.mjs',
  fs.readFileSync(path.join(SRC, 'template/site/src/lib/raci.mjs'), 'utf8') === fs.readFileSync(path.join(SRC, 'template/bin/lib/raci.mjs'), 'utf8'))

console.log('== bin/raci')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'raci-'))
try {
  fs.mkdirSync(path.join(T, 'bin/lib'), { recursive: true }); fs.mkdirSync(path.join(T, 'leads'))
  fs.copyFileSync(path.join(SRC, 'template/bin/raci'), path.join(T, 'bin/raci'))
  for (const f of ['raci.mjs', 'obs.mjs', 'svc.mjs']) fs.copyFileSync(path.join(SRC, 'template/bin/lib', f), path.join(T, 'bin/lib', f))
  for (const f of ['raci.json', 'roles.json']) fs.copyFileSync(path.join(SRC, 'template/profiles/system/leads', f), path.join(T, 'leads', f))
  const raci = (...a) => spawnSync(process.execPath, [path.join(T, 'bin/raci'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: T, MM_OBS_TRACES: '', MM_OBS_METRICS: '' } })
  const show = raci()
  const head = show.stdout.split('\n')[0].split(/\s+/), t2 = show.stdout.split('\n').find((l) => l.startsWith('t2-change '))?.split(/\s+/) || []
  ok('raci shows V in the review column of t2-change (the done check)', t2[head.indexOf('review')] === 'V')
  ok('...R·A as two letters, and the consult cases', /^t1-change\s+R·A/m.test(show.stdout) && /consult \(when C is asked\):\n- t1-change: platform: when/.test(show.stdout) && !/problems:/.test(show.stdout))
  raci('render')
  const md = fs.readFileSync(path.join(T, 'leads/RACI.md'), 'utf8')
  ok('render: the letters, V in the table, the cases', /- \*\*V\*\* verifies/.test(md) && /`act:t2-change` \| R \| V \| C·I \| A \|/.test(md) && /## When C is asked \(and only then\)/.test(md))
  ok('render: the routine (sy-mv69.2): each row\'s when cases with next, bounds, verify and correct', /## Routine: when each row starts, its bounds, verify and correct/.test(md) &&
    /### `incident`/.test(md) && /- \*\*when\*\* `sentinel:drift` → none \(the effect of the migration\) · bounds: within 60 min of the migration · verify: `bin\/brain status` → .* · correct: the \.rollback\.sh of that migration/.test(md) &&
    /`brain:ALERT \*security update\*` → ops: dnf upgrade .* · bounds: tier: t1 · not \/kernel\|openssh\//.test(md))
  ok('show: the when cases, one line per row', /when \(routine cases; raci render shows them in full\):\n(?:- .*\n)*- incident: sentinel:drift; sentinel:drift; sentinel:errors:mm\/\*/.test(show.stdout))
  const c = raci('consult', 'sync', 'platform: when the push holds an mm file')
  ok('raci consult: names a role that is not C there: saved, with the problem', /saved, but: sync: the consult case .* names platform, which is not C/.test(c.stdout))
  raci('set', 'sync', 'platform=C')
  ok('...after raci set platform=C: no problem', !/problems:/.test(raci().stdout) && JSON.parse(fs.readFileSync(path.join(T, 'leads/raci.json'), 'utf8')).activities.find((a) => a.id === 'sync').consult.length === 1)
  raci('consult', 'sync')
  ok('raci consult with no case clears them (and the C is then a problem)', /sync: has a C \(platform\) but no consult cases/.test(raci().stdout))
} finally { fs.rmSync(T, { recursive: true, force: true }) }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
