#!/usr/bin/env node
// test/gates and test/gates.map (sy-v47f), hermetic: (1) the map's rules on their own (globs, sets, groups, the
// catch-all, run order); (2) this repo's own map: it parses, every suite in it exists, every suite in test/ is in it,
// and every tracked file matches a rule; (3) test/gates against a throwaway fixture repo with a fixture map and stub
// suites: --list runs nothing; a run is on the head's content (not the caller's edits) in a worktree that is removed
// after; the result file's shape; the docker group one at a time, hermetic ones side by side; --no-live; a failing
// suite's exit code; --bin as {mm}; --item with and without artifact on PATH; usage and map errors exit 2; (4) the
// heavy lock (sy-gb26), flock and mkdir both: two runs at once never run heavy suites side by side and take turns
// suite by suite; light suites run while another run holds it; a holder that is gone (dead or its pid reused) frees
// it; the --jobs default under load.
//   node test/gates.mjs          exit 0 = every check passed
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFLICT_FILE, GROUPS, defaultJobs, fetchTool, gatesDir, globMatch, markRun, oldTemplateRef, parseMap, procStart, resolve, select, selectBoth, waitLine } from './lib/gates.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GATES = path.join(SRC, 'test', 'gates')
const NODE_DIR = path.dirname(spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim())
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-test-'))
// review sy-gb26 #3: every test/gates this suite starts gets a PATH with no board on it (node, flock, git, sh only)
// and its own MM_GATES_DIR, so no run of it posts a result file (artifact) or a run mark to a real board.
const CLEAN_PATH = [NODE_DIR, '/usr/local/bin', '/usr/bin', '/bin'].join(':')
const GATES_DIR = path.join(T, 'gates-dir')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${String(more).slice(0, 1500)}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }))

step('the rules on their own')
ok('glob: * stays in a segment', globMatch('test/*.sh', 'test/a.sh') && !globMatch('test/*.sh', 'test/lib/a.sh'))
ok('glob: ** spans segments, and matches none', globMatch('src/**', 'src/a/b.ts') && globMatch('a/**/b', 'a/b') && globMatch('a/**/b', 'a/x/y/b'))
ok('glob: a trailing / is the whole folder', globMatch('docs/', 'docs/x/y.md') && !globMatch('docs/', 'docsx'))
ok('glob: ? is one character, dots are literal', globMatch('a?.md', 'ab.md') && !globMatch('a.md', 'aXmd'))
const fx = parseMap(`
suite t/h1.sh hermetic
suite t/h2.mjs hermetic needs=site
suite t/p.sh ports -- {bd} {dolt}
suite t/d1.sh docker
suite t/d2.sh docker -- --local {mm}
suite t/l.sh live needs=mm
set both t/h1.sh @more
set more t/h2.mjs
rule lib/**  @both
rule lib/x.mjs t/d*.sh
rule docs/** -
rule live/*  t/l.sh t/h1.sh
fallback %hermetic %ports
`)
ok('a good map has no errors', fx.errors.length === 0, fx.errors.join('; '))
ok('sets nest (@both -> @more)', resolve(fx, '@both').join(' ') === 't/h1.sh t/h2.mjs')
ok('%group is every suite of the group', resolve(fx, '%docker').join(' ') === 't/d1.sh t/d2.sh')
ok('needs and args are read', fx.suites[1].needs.join() === 'site' && fx.suites[4].args.join(' ') === '--local {mm}')
let s = select(fx, ['lib/x.mjs'])
ok('rules add up: lib/** and lib/x.mjs', s.suites.map((x) => x.path).join(' ') === 't/h1.sh t/h2.mjs t/d1.sh t/d2.sh', s.suites.map((x) => x.path))
s = select(fx, ['live/a', 'lib/y'])
ok('run order: by group (hermetic, ports, docker, live), then as declared', s.suites.map((x) => x.path).join(' ') === 't/h1.sh t/h2.mjs t/l.sh')
ok('each suite says which file and rule chose it', s.suites[0].why.some((w) => w.file === 'live/a' && w.rule === 'live/*') && s.suites[0].why.some((w) => w.file === 'lib/y' && w.rule === 'lib/**'))
s = select(fx, ['docs/a.md'])
ok('a rule with "-" matches and runs nothing (no fallback)', s.suites.length === 0 && s.files[0].rules.join() === 'docs/**')
s = select(fx, ['new/thing.txt'])
ok('a file no rule names: the fallback (%hermetic %ports)', s.suites.map((x) => x.path).join(' ') === 't/h1.sh t/h2.mjs t/p.sh' && s.files[0].rules.join() === '(fallback)')
s = select(fx, ['t/d1.sh'])
ok('a changed suite runs itself, without a rule', s.suites.map((x) => x.path).join(' ') === 't/d1.sh' && s.files[0].rules.join() === '(the suite itself)')
// review #3, 1: a range that changes the map also uses the base's map (it cannot drop its own gates)
const fxHead = parseMap(`
suite t/h1.sh hermetic
suite t/d1.sh docker
rule lib/** t/h1.sh
rule test/gates.map -
fallback %hermetic
`)
s = selectBoth(fxHead, fx, ['lib/x.mjs'])
ok('map changed: the base map\'s suites run too (lib/x.mjs: the head chose t/h1.sh only)', s.suites.map((x) => x.path).join(' ') === 't/h1.sh t/h2.mjs t/d1.sh t/d2.sh', s.suites.map((x) => x.path))
ok('...a suite only the base declares (dropped by the range) still runs, and its why names the base\'s map', s.suites.find((x) => x.path === 't/d2.sh')?.why.every((w) => /the base's map/.test(w.rule)))
ok('...a suite both declare runs as the head declares it', s.suites.find((x) => x.path === 't/d1.sh')?.args.length === 0)
const bad = parseMap('suite t/a.sh nightly\nsuite t/a.sh hermetic needs=gpu -- {foo}\nrule x/** t/nope.sh @none\nset loop @loop\nrule y @loop\nwhat now\n')
const has = (re) => bad.errors.some((e) => re.test(e))
ok('map errors: unknown group, twice, unknown need, unknown placeholder', has(/unknown group "nightly"/) && has(/declared twice/) && has(/unknown need "gpu"/) && has(/unknown placeholder \{foo\}/), bad.errors)
ok('map errors: a target naming no suite, an unknown set, a set naming itself, an unknown keyword, no fallback', has(/t\/nope\.sh names no suite/) && has(/unknown set @none/) && has(/names itself/) && has(/unknown keyword "what"/) && has(/no fallback/), bad.errors)

step("this repo's map")
const real = parseMap(fs.readFileSync(path.join(SRC, 'test', 'gates.map'), 'utf8'))
ok('test/gates.map parses with no errors', real.errors.length === 0, real.errors.join('\n'))
const missing = real.suites.filter((x) => !fs.existsSync(path.join(SRC, x.path))).map((x) => x.path)
ok('every suite it declares exists', missing.length === 0, missing.join(' '))
const tests = fs.readdirSync(path.join(SRC, 'test')).filter((f) => /\.(sh|mjs|ts)$/.test(f)).map((f) => `test/${f}`)
const undeclared = tests.filter((t) => !real.suites.some((x) => x.path === t))
ok('every suite in test/ is declared, with its group', undeclared.length === 0, undeclared.join(' '))
ok('only the four groups', real.suites.every((x) => GROUPS.includes(x.group)))
const tracked = sh('git', ['-C', SRC, 'ls-files']).stdout.split('\n').filter(Boolean)
const unruled = select(real, tracked).files.filter((f) => f.rules.includes('(fallback)')).map((f) => f.file)
ok(`every tracked file (${tracked.length}) matches a rule (none left to the fallback)`, tracked.length > 100 && unruled.length === 0, unruled.join(' '))
const live = real.suites.filter((x) => x.group === 'live').map((x) => x.path)
ok('the suites that use the machine are live', ['test/lifecycle.sh', 'test/box.sh', 'test/doop.sh', 'test/sentinel.sh', 'test/machine-panel.sh', 'test/paseo-lib.mjs'].every((p) => live.includes(p)), live)
const pick = (f) => select(real, [f]).suites.map((x) => x.path)
ok('template/bin/lib/message.mjs -> message.mjs, bd-actor.sh, owner-card-bd.sh', ['test/message.mjs', 'test/bd-actor.sh', 'test/owner-card-bd.sh'].every((p) => pick('template/bin/lib/message.mjs').includes(p)))
ok('src/** -> the CLI suites, clean-box.sh, lifecycle.sh', ['test/vault.sh', 'test/names.sh', 'test/clean-box.sh', 'test/lifecycle.sh'].every((p) => pick('src/pc.ts').includes(p)))
ok('template/site/src/** -> the browser suites', ['test/board-message.mjs', 'test/board-phone.mjs', 'test/board-space.mjs'].every((p) => pick('template/site/src/App.tsx').includes(p)))
ok('docs/** -> nothing', pick('docs/vault.md').length === 0)
ok('a suite that builds the site has needs=site (built once by gates)', real.suites.filter((x) => /board-(message|owner-card|phone|phone-space|space|artifacts)\.mjs$/.test(x.path)).every((x) => x.needs.includes('site')))
const mmSuites = real.suites.filter((x) => x.args.some((a) => a.includes('{mm}'))).map((x) => x.path)
ok('clean-box takes the built mm (--local {mm})', real.suites.find((x) => x.path === 'test/clean-box.sh')?.args.join(' ') === '--local {mm}', mmSuites)
ok('lifecycle.sh takes the base\'s template and the mm (MM_BIN_DIR)', (() => { const l = real.suites.find((x) => x.path === 'test/lifecycle.sh'); return l.args.join() === '{old-template}' && l.needs.includes('mm') })())
ok('lifecycle.sh honours MM_BIN_DIR', /MM_BIN_DIR/.test(fs.readFileSync(path.join(SRC, 'test', 'lifecycle.sh'), 'utf8')))

step('test/gates on a fixture repo')
ok('the PATH of every test/gates run here has no artifact on it (review sy-gb26 #3)', sh('sh', ['-c', 'command -v artifact'], { env: { PATH: CLEAN_PATH } }).status !== 0)
const R = path.join(T, 'repo')
fs.mkdirSync(path.join(R, 'test'), { recursive: true })
const g = (...a) => sh('git', ['-C', R, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } })
const MARK = path.join(T, 'ran'), SPANS = path.join(T, 'spans'), SEEN = path.join(T, 'gates-seen')
const W = (f, s) => { fs.mkdirSync(path.dirname(path.join(R, f)), { recursive: true }); fs.writeFileSync(path.join(R, f), s) }
// a stub suite: records its run (start, end) and its args, prints ok/FAIL lines, exits as told
const stub = (name, { fails = 0, sleep = 0 } = {}) => `#!/usr/bin/env bash
echo "$(basename "$0") $(date +%s.%N) start" >>"${SPANS}"; echo "$(basename "$0") $*" >>"${MARK}"
[ -z "\${MM_GATES_DIR:-}" ] || ls "\$MM_GATES_DIR" >>"${SEEN}" 2>/dev/null
echo "args: $*"; echo "cwd: $(pwd)"; for i in $(seq 1 200); do echo "line $i of a long log"; done
printf '  \\033[32mok\\033[0m   one\\n  \\033[32mok\\033[0m   two\\n'
${fails ? "printf '  \\033[31mFAIL\\033[0m three\\n'" : ''}
sleep ${sleep}; echo "$(basename "$0") $(date +%s.%N) end" >>"${SPANS}"
exit ${fails ? 1 : 0}
`
W('test/h1.sh', stub('h1', { sleep: 1 }))
W('test/h2.sh', stub('h2', { sleep: 1 }))
W('test/d1.sh', stub('d1', { sleep: 1 }))
W('test/d2.sh', stub('d2', { sleep: 1 }))
W('test/m.sh', stub('m'))
W('test/l.sh', stub('l'))
W('test/f.sh', stub('f'))
W('test/gates.map', `suite test/h1.sh hermetic
suite test/h2.sh hermetic
suite test/m.sh hermetic -- {mm} x
suite test/d1.sh docker
suite test/d2.sh docker
suite test/f.sh hermetic
suite test/l.sh live
rule lib/** test/h1.sh test/h2.sh test/d1.sh test/d2.sh test/l.sh
rule bin/** test/m.sh
rule bad/** test/f.sh
rule docs/** -
fallback test/h1.sh
`)
W('lib/a.txt', '1\n'); W('docs/a.md', '1\n')
g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'base')
W('lib/a.txt', '2\n'); W('docs/a.md', '2\n'); W('other/new.txt', 'x\n')
g('add', '-A'); g('commit', '-qm', 'change lib, docs, a new folder')
// never the machine's heavy lock: this test's own
const run = (args, opts = {}) => sh(GATES, args, { cwd: R, env: { ...process.env, MM_GATES_LOCK: path.join(T, 'fixture.lock'), MM_GATES_DIR: GATES_DIR, PATH: opts.path || CLEAN_PATH }, ...opts })

let r = run(['main~1..main', '--list'])
ok('--list: exit 0', r.status === 0, r.stderr)
ok('--list: each changed file with its rules (docs: no suite; a new folder: the fallback)', /lib\/a\.txt\s+lib\/\*\*/.test(r.stdout) && /docs\/a\.md\s+docs\/\*\*\s+\(no suite\)/.test(r.stdout) && /other\/new\.txt\s+\(fallback\)/.test(r.stdout), r.stdout)
ok('--list: the suites in run order with why', /hermetic\s+test\/h1\.sh\s+<- lib\/\*\* \(lib\/a\.txt\), \(fallback\)/.test(r.stdout) && r.stdout.indexOf('test/d2.sh') < r.stdout.indexOf('test/l.sh'), r.stdout)
ok('--list runs nothing', !fs.existsSync(MARK))
ok('--list: no worktree left, no result file', !fs.readdirSync(R).some((f) => f.startsWith('gates-')) && g('worktree', 'list').stdout.trim().split('\n').length === 1)

// the caller's checkout has an edit that would fail h1: the run must not see it
const h1 = fs.readFileSync(path.join(R, 'test/h1.sh'), 'utf8')
fs.writeFileSync(path.join(R, 'test/h1.sh'), h1.replace('exit 0', 'exit 7'))
const OUT = path.join(T, 'out', 'res.txt'); fs.mkdirSync(path.dirname(OUT))
r = run(['main~1..main', '--no-live', '--jobs', '2', '--out', OUT]) // --jobs: the default follows the load
ok('a run: exit 0 when every suite that ran passed (live skipped)', r.status === 0, r.stdout + r.stderr)
const res = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
const head = g('rev-parse', 'HEAD').stdout.trim()
ok('result: head, range, date first', res.startsWith(`head: ${head} change lib, docs, a new folder\nrange: main~1..main (`) && /\ndate: \d{4}-\d\d-\d\dT/.test(res), res)
ok('result: one line per suite: name, group, status, counts, seconds, log', /^test\/h1\.sh\s+hermetic\s+passed\s+2 ok, 0 FAIL\s+\d+s\s+\S+h1\.sh\.log$/m.test(res), res)
ok('result: --no-live says skipped, never passed', /^test\/l\.sh\s+live\s+skipped \(--no-live\)/m.test(res) && /^result: passed \(live skipped: --no-live\)/m.test(res), res)
ok('the live suite did not run', !fs.readFileSync(MARK, 'utf8').includes('l.sh'))
ok("the run used the head's content, not the caller's edit", /^test\/h1\.sh\s+hermetic\s+passed/m.test(res))
const logLine = res.split('\n').find((l) => l.startsWith('test/h1.sh')) || ''
const log = logLine.split(/\s+/).pop()
const logText = log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
ok('each suite\'s whole log is kept (all 200 lines), next to the result file', logText.includes('line 1 of') && logText.includes('line 200 of') && log.startsWith(path.join(T, 'out', 'res.logs')), log)
const cwdLine = (logText.match(/^cwd: (.*)$/m) || [])[1] || ''
ok('it ran in a throwaway folder under TMPDIR, not the caller\'s checkout', cwdLine.startsWith(os.tmpdir()) && !cwdLine.startsWith(R) && !fs.existsSync(cwdLine), cwdLine)
ok('the worktree is removed after (git worktree list: only the checkout)', g('worktree', 'list').stdout.trim().split('\n').length === 1, g('worktree', 'list').stdout)
const spans = fs.readFileSync(SPANS, 'utf8').trim().split('\n').map((l) => l.split(' ')).reduce((a, [n, t, k]) => ((a[n] ||= {})[k] = Number(t), a), {})
const overlap = (a, b) => spans[a] && spans[b] && spans[a].start < spans[b].end && spans[b].start < spans[a].end
ok('the docker group: one after another, never side by side', spans['d1.sh'] && spans['d2.sh'] && !overlap('d1.sh', 'd2.sh'), JSON.stringify(spans))
ok('the hermetic group: side by side', overlap('h1.sh', 'h2.sh'), JSON.stringify(spans))
ok('lanes: a docker suite runs next to the hermetic ones', overlap('d1.sh', 'h1.sh') || overlap('d1.sh', 'h2.sh') || overlap('d2.sh', 'h1.sh') || overlap('d2.sh', 'h2.sh'), JSON.stringify(spans))
fs.writeFileSync(path.join(R, 'test/h1.sh'), h1)

// a failing suite, the default result file name, the {mm} from --bin, --item
fs.rmSync(MARK, { force: true })
W('bad/x', '1\n'); W('bin/y', '1\n'); g('add', 'bad', 'bin'); g('commit', '-qm', 'bad and bin')
W('test/f.sh', stub('f', { fails: 1 })); g('add', '-A'); g('commit', '-qm', 'f fails')
const short = g('rev-parse', '--short=7', 'HEAD').stdout.trim()
const STUBS = path.join(T, 'stubs'); fs.mkdirSync(STUBS)
fs.writeFileSync(path.join(STUBS, 'artifact'), `#!/bin/sh\necho "$@" >"${T}/artifact.args"\necho "artifacts/$1/$(basename "$2")"\n`, { mode: 0o755 })
const fakeMm = path.join(T, 'fake-mm'); fs.writeFileSync(fakeMm, '#!/bin/sh\necho fake\n', { mode: 0o755 })
const GD = path.join(T, 'board', '.run', 'gates')
r = sh(GATES, ['main~2..main', '--bin', fakeMm, '--item', 'ab-1'], { cwd: R, env: { ...process.env, MM_GATES_LOCK: path.join(T, 'fixture.lock'), PATH: `${STUBS}:${CLEAN_PATH}`, MM_GATES_DIR: GD } })
ok('a failing suite: exit 1', r.status === 1, r.stdout + r.stderr)
const def = path.join(R, `gates-${short}.txt`)
const res2 = fs.existsSync(def) ? fs.readFileSync(def, 'utf8') : ''
ok(`the default result file: gates-<short head>.txt (${path.basename(def)})`, res2.length > 0, fs.readdirSync(R))
ok('result: the failed suite with its exit code and counts', /^test\/f\.sh\s+hermetic\s+failed \(exit 1\)\s+2 ok, 1 FAIL/m.test(res2) && /^result: failed: 1 passed, 1 failed, 0 skipped, of 2/m.test(res2), res2)
ok('{mm} is the --bin binary', fs.readFileSync(MARK, 'utf8').includes(`m.sh ${fakeMm} x`) && /^mm: --bin /m.test(res2), fs.readFileSync(MARK, 'utf8'))
ok('--item: artifact <id> <result file>', fs.existsSync(`${T}/artifact.args`) && fs.readFileSync(`${T}/artifact.args`, 'utf8').trim() === `ab-1 ${def}` && /artifact: on ab-1/.test(r.stdout), r.stdout)
const seen = fs.existsSync(SEEN) ? fs.readFileSync(SEEN, 'utf8') : ''
ok('--item: while it runs, the board has its mark (<item>.<pid>.pid, sy-brny)', /^ab-1\.\d+\.pid$/m.test(seen), seen)
ok('...removed when the run ends', fs.existsSync(GD) && fs.readdirSync(GD).length === 0, fs.existsSync(GD) ? fs.readdirSync(GD) : 'no folder')
r = run(['main~1..main', '--item', 'ab-1', '--out', path.join(T, 'out', 'r3.txt')], { path: CLEAN_PATH })
ok('--item without artifact on PATH: says so (the run still counts)', r.status === 1 && /artifact: not on PATH/.test(r.stdout), r.stdout + r.stderr)
r = run(['main~3..main', '--list', '--no-live'])
ok('--list --no-live marks the live suites skipped', r.status === 0 && /test\/l\.sh .*\[skipped: --no-live\]/.test(r.stdout), r.stdout + r.stderr)
// review #3, 1, end to end: a range that drops lib/**'s suites from the map and changes lib/ still lists them
const mapNow = fs.readFileSync(path.join(R, 'test/gates.map'), 'utf8')
W('test/gates.map', mapNow.replace('rule lib/** test/h1.sh test/h2.sh test/d1.sh test/d2.sh test/l.sh', 'rule lib/** test/h1.sh'))
W('lib/a.txt', '3\n'); g('add', 'lib/a.txt', 'test/gates.map'); g('commit', '-qm', 'drop gates from the map')
r = run(['main~1..main', '--list'])
ok("a range that changes the map: the base's map chooses too (the dropped suites still listed)", r.status === 0 && /test\/d1\.sh\s+<- lib\/\*\* \(the base's map\) \(lib\/a\.txt\)/.test(r.stdout) && /test\/l\.sh/.test(r.stdout) && /the base's: this range changes the map/.test(r.stdout), r.stdout + r.stderr)

step('markRun: the mark wake reads (sy-brny)')
{
  const MD = path.join(T, 'marks'), um = markRun('ab-2.1', () => {}, { MM_GATES_DIR: MD })
  const f = path.join(MD, `ab-2.1.${process.pid}.pid`), j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
  ok('a mark: <item>.<pid>.pid, with the pid, the item and (on Linux) the start', j.pid === process.pid && j.item === 'ab-2.1' && (process.platform !== 'linux' || /^\d+$/.test(j.start)), JSON.stringify(j))
  um(); ok('...and its remover removes it', !fs.existsSync(f))
  ok('a bad item id: no mark', (markRun('../x', () => {}, { MM_GATES_DIR: MD }), fs.readdirSync(MD).length === 0), fs.readdirSync(MD))
  const B = path.join(T, 'brd'); fs.mkdirSync(path.join(B, 'bin'), { recursive: true }); for (const n of ['wake', 'lead', 'artifact']) fs.writeFileSync(path.join(B, 'bin', n), '')
  ok('the board from PATH: the folder with wake, lead and artifact', gatesDir({ PATH: `/nowhere:${path.join(B, 'bin')}` }) === path.join(fs.realpathSync(B), '.run', 'gates'))
  ok('no board on PATH: no mark', gatesDir({ PATH: '/usr/bin:/bin' }) === null)
}

step("lifecycle's old template (sy-1nb8): its template/site/package.json differs from the head's")
{
  const O = path.join(T, 'otpl')
  fs.mkdirSync(path.join(O, 'test'), { recursive: true })
  const go = (...a) => sh('git', ['-C', O, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } })
  const WO = (f, s) => { fs.mkdirSync(path.dirname(path.join(O, f)), { recursive: true }); fs.writeFileSync(path.join(O, f), s) }
  const rev = (r) => go('rev-parse', r).stdout.trim()
  go('init', '-q', '-b', 'main')
  const commit = (m) => { go('add', '-A'); go('commit', '-qm', m); return rev('HEAD') }
  // a stub "lifecycle" that prints the old template's package.json and fails when it is the head's
  WO('test/lc.sh', `#!/usr/bin/env bash
old=$(cat "$1/site/package.json"); new=$(cat template/site/package.json)
echo "old: $old"; echo "new: $new"
if [ "$old" = "$new" ]; then printf '  \\033[31mFAIL\\033[0m conflict\\n'; exit 1; fi
printf '  \\033[32mok\\033[0m   conflict\\n'
`)
  WO('test/gates.map', 'suite test/lc.sh live -- {old-template}\nrule template/** test/lc.sh\nrule bin/** test/lc.sh\nfallback test/lc.sh\n')
  WO('template/site/package.json', '{"v":1}\n'); WO('template/a.txt', '1\n')
  const c1 = commit('first package.json')
  WO('template/a.txt', '2\n'); const c2 = commit('other template change')
  WO('template/site/package.json', '{"v":2}\n'); const c3 = commit('last package.json change')
  WO('bin/wt', '1\n'); const c4 = commit('bin only')
  WO('bin/wt', '2\n'); const c5 = commit('bin only again')
  ok('the fixture: five commits', [c1, c2, c3, c4, c5].every((c) => /^[0-9a-f]{40}$/.test(c)) && new Set([c1, c2, c3, c4, c5]).size === 5)
  let p = oldTemplateRef(O, c4, c5)
  ok('a range that leaves package.json alone: the commit before its last change (not the base)', p.ref === c2 && p.ref !== c4, JSON.stringify(p))
  ok('...it says why, naming that change', p.why.includes(c3.slice(0, 7)) && p.why.includes(CONFLICT_FILE), p.why)
  p = oldTemplateRef(O, c2, c5)
  ok('a range that changes package.json itself: the base (it differs already)', p.ref === c2, JSON.stringify(p))
  p = oldTemplateRef(O, c1, c1)
  ok('no earlier version of package.json: the base', p.ref === c1, JSON.stringify(p))
  const before = go('log', '-1', '--format=%H', `${c3}~1`).stdout.trim()
  ok('the pick is git log\'s (the last change\'s first parent), not a fixed commit', before === c2)
  const r = sh(GATES, [`${c4}..${c5}`, '--out', path.join(T, 'otpl-res.txt')], { cwd: O, env: { ...process.env, MM_GATES_LOCK: path.join(T, 'otpl.lock'), MM_GATES_DIR: GATES_DIR, PATH: CLEAN_PATH } })
  ok('end to end: test/gates on a bin-only range gives the stub lifecycle a conflicting old template (passed)', r.status === 0 && /gates: old template: .*the commit before/.test(r.stdout), r.stdout + r.stderr)
}

step('fetchTool: the pinned checksums (review #3, 2)')
{
  const FT = path.join(T, 'ft'), rel = path.join(FT, 'rel'), wt0 = path.join(FT, 'wt')
  fs.mkdirSync(rel, { recursive: true }); fs.mkdirSync(path.join(wt0, 'template'), { recursive: true })
  fs.writeFileSync(path.join(rel, 'bd'), '#!/bin/sh\necho bd\n')
  sh('tar', ['-czf', path.join(FT, 'bd.tgz'), '-C', rel, 'bd'])
  const sum = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const plat = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const pin = (p) => fs.writeFileSync(path.join(wt0, 'template', 'tools.json'), JSON.stringify({ bd: { [plat]: { url: `file://${FT}/bd.tgz`, extract: 'bd', ...p } } }))
  const stepF = async (name, cmd, args, cwd) => { const x = sh(cmd, args, { cwd }); if (x.status !== 0) throw new Error(`${name} failed`) }
  const tryF = async (n) => { try { return { bin: await fetchTool(wt0, 'bd', path.join(FT, `t${n}`), () => {}, stepF) } } catch (e) { return { err: e.message } } }
  pin({}); let x = await tryF(1)
  ok('no sha256 pinned: fails, says why', /pins no sha256/.test(x.err || ''), JSON.stringify(x))
  pin({ sha256: '0'.repeat(64) }); x = await tryF(2)
  ok("a download that is not the pinned one: fails", /download's checksum/.test(x.err || ''), JSON.stringify(x))
  pin({ sha256: sum(path.join(FT, 'bd.tgz')), installed_sha256: '0'.repeat(64) }); x = await tryF(3)
  ok('an extracted binary that differs from installed_sha256: fails (no longer only a note)', /installed_sha256/.test(x.err || ''), JSON.stringify(x))
  pin({ sha256: sum(path.join(FT, 'bd.tgz')), installed_sha256: sum(path.join(rel, 'bd')) }); x = await tryF(4)
  ok('both pins right: the binary', !!x.bin && fs.existsSync(x.bin), JSON.stringify(x))
}

step('the --jobs default under load')
ok('idle: half the CPUs, 2 to 6', defaultJobs(8, 0) === 4 && defaultJobs(2, 0) === 2 && defaultJobs(32, 0) === 6 && defaultJobs(1, 0) === 1)
ok('busy: at most the idle CPUs, max(1, CPUs - load)', defaultJobs(8, 5) === 3 && defaultJobs(8, 6.4) === 1 && defaultJobs(16, 40) === 1 && defaultJobs(8, 3.9) === 4)

step('the heavy lock (sy-gb26)')
ok('the wait line', waitLine({ label: 'sy-x', pid: 42, since: '2026-01-02T03:04:05.678Z' }) === 'gates: waits for the heavy lock, held by sy-x pid 42 since 2026-01-02T03:04:05Z')
{
  // a fixture of its own: two hermetic, two docker and one live suite, a second each; spans tagged by run
  const R2 = path.join(T, 'repo2'), SP = path.join(T, 'spans2')
  const W2 = (f, x) => { fs.mkdirSync(path.dirname(path.join(R2, f)), { recursive: true }); fs.writeFileSync(path.join(R2, f), x) }
  const stub2 = (sec) => `#!/usr/bin/env bash\necho "$(basename "$0")@\${RUN_TAG:-x} $(date +%s.%N) start" >>"${SP}"\necho "  ok   one"\nsleep ${sec}\necho "$(basename "$0")@\${RUN_TAG:-x} $(date +%s.%N) end" >>"${SP}"\n`
  for (const n of ['h1', 'h2', 'd1', 'd2', 'l1']) W2(`test/${n}.sh`, stub2(1))
  W2('test/gates.map', 'suite test/h1.sh hermetic\nsuite test/h2.sh hermetic\nsuite test/d1.sh docker\nsuite test/d2.sh docker\nsuite test/l1.sh live\nrule lib/** %hermetic %docker %live\nrule light/** %hermetic\nrule heavy1/** test/d1.sh\nfallback %hermetic\n')
  W2('lib/a', '1\n'); W2('light/a', '1\n'); W2('heavy1/a', '1\n')
  const g2 = (...a) => sh('git', ['-C', R2, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } })
  g2('init', '-q', '-b', 'main'); g2('add', '-A'); g2('commit', '-qm', 'base')
  W2('lib/a', '2\n'); g2('add', '-A'); g2('commit', '-qm', 'lib') // main~2..main~1: every suite
  W2('light/a', '2\n'); W2('heavy1/a', '2\n'); g2('add', '-A'); g2('commit', '-qm', 'light and heavy') // main~1..main: h1 h2 d1
  const runA = (args, env) => new Promise((done) => {
    // review sy-gb26 #3: these runs pass --item; with the real PATH they posted their result files to a real board
    const c = spawn(GATES, args, { cwd: R2, env: { ...process.env, MM_GATES_DIR: GATES_DIR, ...env, PATH: CLEAN_PATH } })
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => done({ code, out }))
  })
  const readSpans = () => (fs.existsSync(SP) ? fs.readFileSync(SP, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => l.split(' '))
    .reduce((a, [n, t, k]) => ((a[n] ||= { n })[k] = Number(t), a), {})
  const isHeavy = (n) => /^(d1|d2|l1)\.sh@/.test(n)
  const pairsOverlap = (xs) => xs.some((a, i) => xs.some((b, j) => i < j && a.start < b.end && b.start < a.end))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const hasFlock = sh('sh', ['-c', 'command -v flock']).status === 0
  const deadPid = () => Number(sh('sh', ['-c', 'echo $$']).stdout.trim())
  for (const mode of ['flock', 'mkdir']) {
    if (mode === 'flock' && !hasFlock) { ok('flock: not on PATH, its checks skipped', true); continue }
    const LOCK = path.join(T, `heavy-${mode}`, 'heavy.lock')
    const env = (tag) => ({ MM_GATES_LOCK: LOCK, MM_GATES_LOCK_MODE: mode, RUN_TAG: tag })
    // 1. two runs at once
    fs.rmSync(SP, { force: true })
    const [a, b] = await Promise.all([
      runA(['main~2..main~1', '--item', 'run-a', '--out', path.join(T, `a-${mode}.txt`)], env('a')),
      runA(['main~2..main~1', '--item', 'run-b', '--out', path.join(T, `b-${mode}.txt`)], env('b')),
    ])
    const sp = readSpans(), heavy = Object.values(sp).filter((x) => isHeavy(x.n)).sort((x, y) => x.start - y.start)
    ok(`${mode}: two runs at once both pass`, a.code === 0 && b.code === 0, a.out + b.out)
    ok(`${mode}: ...and neither reached a board (artifact not on their PATH)`, /artifact: not on PATH; the result file is not on run-a/.test(a.out) && /artifact: not on PATH; the result file is not on run-b/.test(b.out), a.out + b.out)
    ok(`${mode}: their six heavy suites never side by side`, heavy.length === 6 && heavy.every((x) => x.end) && !pairsOverlap(heavy), JSON.stringify(heavy))
    const tags = heavy.map((x) => x.n.split('@')[1]).join('')
    ok(`${mode}: they take turns suite by suite (not one run's heavy suites, then the other's)`, !/^(a{3}b{3}|b{3}a{3})$/.test(tags), tags)
    ok(`${mode}: the one that waited said who holds the lock`, /gates: waits for the heavy lock, held by run-[ab] pid \d+ since \d{4}-/.test(a.out + b.out), a.out + b.out)
    const light = Object.values(sp).filter((x) => !isHeavy(x.n))
    ok(`${mode}: the hermetic suites of both ran side by side regardless`, light.length === 4 && pairsOverlap(light), JSON.stringify(light))
    ok(`${mode}: nothing left behind (no ticket, no lock dir)`, !fs.existsSync(LOCK + '.d') && (!fs.existsSync(LOCK + '.q') || fs.readdirSync(LOCK + '.q').length === 0) && !fs.existsSync(LOCK + '.break'))

    // 2. another holder has it for 3s: the light suites run meanwhile, the heavy one after
    fs.rmSync(SP, { force: true })
    const REL = path.join(T, `released-${mode}`)
    if (mode === 'flock') {
      spawn('flock', ['-x', LOCK, 'sh', '-c', `printf '{"label":"other-run","pid":%s,"since":"2026-01-02T03:04:05.000Z"}' $$ >"${LOCK}"; sleep 3; date +%s.%N >"${REL}"`], { detached: true, stdio: 'ignore' }).unref()
    } else {
      // a holder that ends without giving the lock back: gates waits while it runs, then takes the lock over
      const h = spawn('sleep', ['3'], { stdio: 'ignore' })
      fs.mkdirSync(LOCK + '.d', { recursive: true })
      fs.writeFileSync(path.join(LOCK + '.d', 'holder'), JSON.stringify({ label: 'other-run', pid: h.pid, start: procStart(h.pid), since: '2026-01-02T03:04:05.000Z' }))
      h.on('exit', () => fs.writeFileSync(REL, String(Date.now() / 1000)))
    }
    await wait(300)
    const c = await runA(['main~1..main', '--jobs', '2', '--out', path.join(T, `c-${mode}.txt`)], env('c'))
    const rel = Number(fs.existsSync(REL) ? fs.readFileSync(REL, 'utf8') : 0), sp2 = readSpans()
    ok(`${mode}: a run waits for another holder, and passes`, c.code === 0 && /gates: waits for the heavy lock, held by other-run pid \d+ since 2026-01-02T03:04:05Z/.test(c.out), c.out)
    ok(`${mode}: ...its light suites ran (and ended) while the other held the lock`, rel && sp2['h1.sh@c']?.end < rel && sp2['h2.sh@c']?.end < rel, JSON.stringify({ rel, sp2 }))
    ok(`${mode}: ...its heavy suite only after the other gave it back`, rel && sp2['d1.sh@c']?.start >= rel, JSON.stringify({ rel, sp2 }))
    if (mode === 'mkdir') ok('mkdir: ...and says it took the lock over from the holder that is gone', /takes the heavy lock over from other-run pid \d+ \(no longer running\)/.test(c.out), c.out)

    // 3. a holder that is gone
    if (mode === 'flock') {
      fs.rmSync(SP, { force: true })
      const h = spawn('flock', ['-x', LOCK, 'sleep', '100'], { detached: true, stdio: 'ignore' })
      await wait(300)
      process.kill(-h.pid, 'SIGKILL')
      await wait(200)
      const d = await runA(['main~1..main', '--out', path.join(T, 'd-flock.txt')], env('d'))
      ok('flock: a holder killed (SIGKILL) holds nothing: no wait', d.code === 0 && !/waits for the heavy lock/.test(d.out) && !!readSpans()['d1.sh@d'], d.out)
    } else {
      // a dead pid; a live pid with another start time (reused)
      for (const [what, h] of [['dead', { label: 'gone-run', pid: deadPid(), start: '1', since: '2026-01-02T03:04:05.000Z' }], ['reused', { label: 'gone-run', pid: process.pid, start: '1', since: '2026-01-02T03:04:05.000Z' }]]) {
        fs.rmSync(SP, { force: true })
        fs.mkdirSync(LOCK + '.d', { recursive: true }); fs.writeFileSync(path.join(LOCK + '.d', 'holder'), JSON.stringify(h))
        const d = await runA(['main~1..main', '--out', path.join(T, `d-${what}.txt`)], env('d'))
        ok(`mkdir: a holder whose pid is ${what} is taken over, without waiting`, d.code === 0 && /takes the heavy lock over from gone-run/.test(d.out) && !/waits for the heavy lock/.test(d.out) && !!readSpans()['d1.sh@d'], d.out)
        ok('mkdir: ...and the lock is given back after', !fs.existsSync(LOCK + '.d'))
      }
    }
  }
}

step('usage and map errors')
r = run([]); ok('no range: exit 2 with the usage', r.status === 2 && /usage: test\/gates/.test(r.stderr))
r = run(['nope..main', '--list']); ok('a range that is not this repo\'s: exit 2', r.status === 2 && /not a commit range/.test(r.stderr), r.stderr)
r = run(['main~1..main', '--frob']); ok('an unknown option: exit 2', r.status === 2)
fs.writeFileSync(path.join(T, 'bad.map'), 'rule x/** test/none.sh\nfallback test/none.sh\n')
r = run(['main~1..main', '--list', '--map', path.join(T, 'bad.map')]); ok('a map error: exit 2, the line named', r.status === 2 && /line 1: test\/none\.sh names no suite/.test(r.stderr), r.stderr)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
