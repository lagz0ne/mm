#!/usr/bin/env node
// test/gates and test/gates.map (sy-v47f), hermetic: (1) the map's rules on their own (globs, sets, groups, the
// catch-all, run order); (2) this repo's own map: it parses, every suite in it exists, every suite in test/ is in it,
// and every tracked file matches a rule; (3) test/gates against a throwaway fixture repo with a fixture map and stub
// suites: --list runs nothing; a run is on the head's content (not the caller's edits) in a worktree that is removed
// after; the result file's shape; the docker group one at a time, hermetic ones side by side; --no-live; a failing
// suite's exit code; --bin as {mm}; --item with and without artifact on PATH; usage and map errors exit 2.
//   node test/gates.mjs          exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { GROUPS, fetchTool, gatesDir, globMatch, markRun, parseMap, resolve, select, selectBoth } from './lib/gates.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GATES = path.join(SRC, 'test', 'gates')
const NODE_DIR = path.dirname(spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim())
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-test-'))
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
ok('machine-panel.sh has needs=site (gates gives it SITE_NODE_MODULES) and mm', (() => { const m = real.suites.find((x) => x.path === 'test/machine-panel.sh'); return m.needs.includes('site') && m.needs.includes('mm') })())
ok('a needs=site suite gets SITE_NODE_MODULES (the site\'s packages gates installed)', /SITE_NODE_MODULES: path\.join\(wt, 'template', 'site', 'node_modules'\)/.test(fs.readFileSync(path.join(SRC, 'test', 'lib', 'gates.mjs'), 'utf8')))
ok('lifecycle.sh takes the base\'s template and the mm (MM_BIN_DIR)', (() => { const l = real.suites.find((x) => x.path === 'test/lifecycle.sh'); return l.args.join() === '{old-template}' && l.needs.includes('mm') })())
ok('lifecycle.sh honours MM_BIN_DIR', /MM_BIN_DIR/.test(fs.readFileSync(path.join(SRC, 'test', 'lifecycle.sh'), 'utf8')))

step('test/gates on a fixture repo')
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
const run = (args, opts = {}) => sh(GATES, args, { cwd: R, env: { ...process.env, PATH: opts.path || process.env.PATH }, ...opts })

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
r = run(['main~1..main', '--no-live', '--out', OUT])
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
r = sh(GATES, ['main~2..main', '--bin', fakeMm, '--item', 'ab-1'], { cwd: R, env: { ...process.env, PATH: `${STUBS}:${process.env.PATH}`, MM_GATES_DIR: GD } })
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
r = run(['main~1..main', '--item', 'ab-1', '--out', path.join(T, 'out', 'r3.txt')], { path: [NODE_DIR, '/usr/bin', '/bin'].join(':') })
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

step('usage and map errors')
r = run([]); ok('no range: exit 2 with the usage', r.status === 2 && /usage: test\/gates/.test(r.stderr))
r = run(['nope..main', '--list']); ok('a range that is not this repo\'s: exit 2', r.status === 2 && /not a commit range/.test(r.stderr), r.stderr)
r = run(['main~1..main', '--frob']); ok('an unknown option: exit 2', r.status === 2)
fs.writeFileSync(path.join(T, 'bad.map'), 'rule x/** test/none.sh\nfallback test/none.sh\n')
r = run(['main~1..main', '--list', '--map', path.join(T, 'bad.map')]); ok('a map error: exit 2, the line named', r.status === 2 && /line 1: test\/none\.sh names no suite/.test(r.stderr), r.stderr)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
