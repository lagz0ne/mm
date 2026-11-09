#!/usr/bin/env node
// The RACI (sy-lusk; bin/lib/raci.mjs, bin/raci, config-check's RACI part): the letters R A V C I, exactly one A and at
// least one R per row, C and I never with R, A or V, a person only A or I, a row with a C lists its consult cases (a case
// "<role>: ..." names a C of the row); the helpers wake, bin/message and the Supervisor use (mayAsk, noInputOk); both
// templates' raci.json are valid against their roles.json, and the system board's t2-change row has V for review;
// bin/raci shows V and the cases, renders them, and `raci consult` sets a row's cases.
// Hermetic: a throwaway folder with a copy of bin/raci and its libs.
//   node test/raci.mjs        exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { actOf, lettersOf, mayAsk, noInputOk, problems, rowOf, withLetter } from '../template/bin/lib/raci.mjs'

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
  const c = raci('consult', 'sync', 'platform: when the push holds an mm file')
  ok('raci consult: names a role that is not C there: saved, with the problem', /saved, but: sync: the consult case .* names platform, which is not C/.test(c.stdout))
  raci('set', 'sync', 'platform=C')
  ok('...after raci set platform=C: no problem', !/problems:/.test(raci().stdout) && JSON.parse(fs.readFileSync(path.join(T, 'leads/raci.json'), 'utf8')).activities.find((a) => a.id === 'sync').consult.length === 1)
  raci('consult', 'sync')
  ok('raci consult with no case clears them (and the C is then a problem)', /sync: has a C \(platform\) but no consult cases/.test(raci().stdout))
} finally { fs.rmSync(T, { recursive: true, force: true }) }
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
