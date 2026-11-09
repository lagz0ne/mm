#!/usr/bin/env node
// test/gates and test/gates.map (sy-v47f), hermetic: (1) the map's rules on their own (globs, sets, groups, the
// fallback for an unmapped path, run order, a range that changes the map: sy-sbjh.1); (2) this repo's own map: it parses,
// every suite in it exists, every suite in test/ is in it, no catch-all rule, a one-file change runs few suites,
// and every tracked file matches a rule; (3) test/gates against a throwaway fixture repo with a fixture map and stub
// suites: --list runs nothing; a run is on the head's content (not the caller's edits) in a worktree that is removed
// after; the result file's shape; the docker group one at a time, hermetic ones side by side; --no-live; a failing
// suite's exit code; --bin as {mm}; --item with and without artifact on PATH; usage and map errors exit 2; (4) the
// run lock (sy-1nb8; the heavy lock of sy-gb26 before it), flock and mkdir both: two runs at once never run a suite
// side by side (ports, docker, live or hermetic): one run's suites, then the other's; a run waits for another holder
// before its first suite and says who holds it; a holder that is gone (dead or its pid reused) frees it; a run with
// nothing to start takes no lock; the --jobs default under load; (5) the rerun (sy-sbjh.4): a suite that fails once
// then passes alone is flaky and the run passes, one that fails twice is failed, --no-rerun; the history file and its
// bound; (6) the build cache (sy-sbjh.2): two runs of one head build mm once, a stamp that does not match is built
// again, the suites get that mm (and its template), the result file's mm line, a failed build leaves nothing, the
// bound keeps mm ship's current and previous; (7) --all <ref> (sy-sbjh.5): every suite of the map, live too, one run,
// its result file. Every test/gates it starts has a clean PATH, its own history file (MM_GATES_HISTORY) and its own
// build cache (MM_BUILDS).
//   node test/gates.mjs          exit 0 = every check passed
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { BUILD_STAMP, BUILDS_KEEP, CONFLICT_FILE, GROUPS, HISTORY_MAX, buildName, pruneBuilds, appendHistory, defaultJobs, fetchTool, gatesDir, globMatch, markRun, oldTemplateRef, parseMap, procStart, mapChanges, resolve, select, selectAll, selectMapChange, waitLine } from './lib/gates.mjs'
import { gatesVerdict } from '../template/bin/lib/gates-file.mjs'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GATES = path.join(SRC, 'test', 'gates')
const NODE_DIR = path.dirname(spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim())
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-test-'))
// review sy-gb26 #3: every test/gates this suite starts gets a PATH with no board on it (node, flock, git, sh only)
// and its own MM_GATES_DIR, so no run of it posts a result file (artifact) or a run mark to a real board.
const CLEAN_PATH = [NODE_DIR, '/usr/local/bin', '/usr/bin', '/bin'].join(':')
const GATES_DIR = path.join(T, 'gates-dir')
// sy-sbjh.4: every test/gates run here (each inherits process.env) writes this suite's own history, never ~/.cache's
const HISTORY = path.join(T, 'history.jsonl')
process.env.MM_GATES_HISTORY = HISTORY
// sy-sbjh.2: and its own build cache, never ~/.mm/builds
const BUILDS = path.join(T, 'builds')
process.env.MM_BUILDS = BUILDS
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${String(more).slice(0, 1500)}`}`) }
const checkStamp = (d) => { try { return fs.readFileSync(path.join(d, 'mm.sha256'), 'utf8').split(/\s+/)[0] === crypto.createHash('sha256').update(fs.readFileSync(path.join(d, 'mm'))).digest('hex') } catch { return false } }
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
// sy-sbjh.1: a range that changes the map: the head's map for its files, plus the suites of the rules it changed, plus
// what the base's map chose for a file that the head's drops (review sy-v47f #3: it cannot drop its own gates). Never
// the base's whole selection, never every suite.
const fxBase = parseMap(`
suite t/h1.sh hermetic
suite t/h2.mjs hermetic
suite t/p.sh ports
suite t/d1.sh docker
suite t/d2.sh docker -- --local {mm}
set two t/h2.mjs
rule lib/** t/h1.sh t/d1.sh
rule bin/** @two
rule test/gates.map t/h1.sh
rule docs/** -
fallback %hermetic
`)
const fxHead = parseMap(`
suite t/h1.sh hermetic
suite t/h2.mjs hermetic
suite t/p.sh ports
suite t/d1.sh docker
suite t/d2.sh docker -- {mm}
suite t/n.sh hermetic
set two t/h2.mjs t/p.sh
rule lib/** t/h1.sh
rule bin/** @two
rule test/gates.map t/h1.sh
rule docs/** -
rule new/** t/n.sh
fallback %hermetic
`)
const paths = (x) => x.suites.map((y) => y.path).join(' ')
const mc = mapChanges(fxHead, fxBase).map((c) => `${c.path}:${c.rule}`)
ok('mapChanges: a new rule, a set that grew, a new suite, a changed declaration (nothing for a dropped target)', ['t/n.sh:rule new/** (changed)', 't/p.sh:rule bin/** (changed)', 't/n.sh:suite (new in the map)', 't/d2.sh:suite (its declaration changed)'].every((x) => mc.includes(x)) && !mc.some((x) => x.startsWith('t/d1.sh') || x.startsWith('t/h1.sh') || x.startsWith('t/h2.mjs')), mc)
s = selectMapChange(fxHead, fxBase, ['test/gates.map'])
ok("map change only: the map's own rule and the changed rules' suites, not every suite", paths(s) === 't/h1.sh t/n.sh t/p.sh t/d2.sh', paths(s))
ok('...each changed suite says the map chose it', s.suites.find((x) => x.path === 't/p.sh')?.why.every((w) => w.file === 'test/gates.map' && /rule bin\/\*\* \(changed\)/.test(w.rule)))
s = selectMapChange(fxHead, fxBase, ['test/gates.map', 'docs/a.md'])
ok('map change + a docs file: still no more (docs/** runs nothing)', paths(s) === 't/h1.sh t/n.sh t/p.sh t/d2.sh', paths(s))
s = selectMapChange(fxHead, fxBase, ['test/gates.map', 'lib/x.mjs'])
ok("map change that drops lib/**'s t/d1.sh, and a lib file: t/d1.sh still runs (the base's map)", s.suites.some((x) => x.path === 't/d1.sh' && x.why.some((w) => w.file === 'lib/x.mjs' && /lib\/\*\* \(the base's map\)/.test(w.rule))), paths(s))
ok('...a suite both maps declare runs as the head declares it', s.suites.find((x) => x.path === 't/d2.sh')?.args.join(' ') === '{mm}')
s = selectMapChange(fxHead, fxBase, ['test/gates.map', 'other/new.txt'])
ok("a file the base left to its fallback: the head's choice only (not the base's fallback again)", paths(s) === 't/h1.sh t/h2.mjs t/n.sh t/p.sh t/d2.sh', paths(s))
s = selectMapChange(fxBase, fxBase, ['test/gates.map'])
ok('an unchanged map (only its comments changed): only the map\'s own rule', paths(s) === 't/h1.sh', paths(s))
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
// sy-sbjh.1: no catch-all; each path runs the suites it needs, and the heavy upgrade / box suites only for those paths
ok('no catch-all rule (src/**, template/**, **)', !real.rules.some((r) => ['src/**', 'template/**', '**', 'src/', 'template/'].includes(r.glob)), real.rules.map((r) => r.glob).filter((g) => /^(src|template)\/\*\*$/.test(g)))
ok('template/bin/wt -> only its suites (sysworkers, memory-links, lead, wt-ro-config)', [...pick('template/bin/wt')].sort().join(' ') === 'test/lead.sh test/memory-links.sh test/sysworkers.sh test/wt-ro-config.sh', pick('template/bin/wt'))
ok('template/bin/lib/gates-file.mjs -> only its suites (bd-actor, owner-card-bd, gates: it reads a flaky line)', [...pick('template/bin/lib/gates-file.mjs')].sort().join(' ') === 'test/bd-actor.sh test/gates.mjs test/owner-card-bd.sh', pick('template/bin/lib/gates-file.mjs'))
ok('src/flow.ts -> flow.mjs and board-pull.mjs only', [...pick('src/flow.ts')].sort().join(' ') === 'test/board-pull.mjs test/flow.mjs', pick('src/flow.ts'))
ok('a brief (CLAUDE.md) -> the writing rule and a rendered board, nothing else', [...pick('template/leads/CLAUDE.md')].sort().join(' ') === 'test/template-base.sh test/writing-rule.sh', pick('template/leads/CLAUDE.md'))
ok('docs/**, README.md -> nothing', pick('docs/vault.md').length === 0 && pick('README.md').length === 0)
const heavy = ['test/lifecycle.sh', 'test/clean-box.sh', 'test/restore-drill.sh']
const heavyFrom = tracked.filter((f) => pick(f).some((p) => heavy.includes(p)))
const heavyOk = (f) => /^(src\/(box|lifecycle|install|onboard|manifest|pack|restore|sync|template|updlock)\.ts|box\/|bin\/mm|manifest\.yaml|package\.json|bun\.lock|deps\/|scripts\/pack-template\.ts|template\/(services\.yaml|tools\.json|bin\/(backup|init)|ops\/githooks\/|setup\/|site\/package(-lock)?\.json)|test\/(lib\/|lifecycle\.sh|clean-box\.sh|restore-drill\.sh))/.test(f)
ok('lifecycle, clean-box, restore-drill: only for paths that change the upgrade, the install or a box', heavyFrom.every(heavyOk) && heavyFrom.length < 40, heavyFrom.filter((f) => !heavyOk(f)))
// sy-sbjh.5: the Docker suites of the upgrade, the box, the gateway and Doop come only from their own paths (the rest:
// the nightly run of main, test/gates --all)
const boxy = /^test\/(clean-box|restore-drill|auth-e2e|box-gateway|doop-[a-z]+)\.sh$/
const boxyOk = (f) => heavyOk(f) || /^(src\/auth\.ts|template\/bin\/(doop-run|lib\/doop-init\.mjs)|template\/site\/(designs\.mjs|annotate\.js)|test\/(auth-e2e|box-gateway|doop-[a-z]+)\.sh)$/.test(f)
const boxyFrom = tracked.filter((f) => pick(f).some((p) => boxy.test(p)))
ok('clean-box, restore-drill, auth-e2e, box-gateway, doop-*: only from box/, src/box.ts, src/auth.ts, the Doop files, the install, upgrade or restore path', boxyFrom.every(boxyOk), boxyFrom.filter((f) => !boxyOk(f)))
ok('template/leads/roles.json, template/setup/**, template/ops/githooks/**: no Docker suite', ['template/leads/roles.json', 'template/setup/CLAUDE.md', 'template/ops/githooks/pre-commit'].every((f) => !pick(f).some((p) => real.suites.find((x) => x.path === p)?.group === 'docker')), ['template/leads/roles.json', 'template/setup/CLAUDE.md', 'template/ops/githooks/pre-commit'].map((f) => `${f}: ${pick(f)}`))
ok('selectAll: every suite of the map, in run order (live last)', selectAll(real).suites.length === real.suites.length && selectAll(real).suites.at(-1).group === 'live' && selectAll(real).suites.every((x, i, a) => !i || GROUPS.indexOf(a[i - 1].group) <= GROUPS.indexOf(x.group)))
ok('src/pc.ts, template/bin/lead: no lifecycle, clean-box or restore-drill', !['src/pc.ts', 'template/bin/lead'].some((f) => pick(f).some((p) => heavy.includes(p))))
const sizes = tracked.map((f) => pick(f).length)
const small = sizes.filter((n) => n <= 15).length
ok(`a one-file change: at most 15 suites for most tracked files (${small}/${tracked.length})`, small / tracked.length >= 0.95, tracked.filter((f) => pick(f).length > 15).map((f) => `${f}:${pick(f).length}`))
const dflt = select(real, ['a-new-folder/x.txt'])
ok(`an unmapped path: a small default set (${dflt.suites.length} suites, not every one of ${real.suites.length}), and it says "(fallback)"`, dflt.suites.length > 0 && dflt.suites.length <= 15 && dflt.files[0].rules.join() === '(fallback)', dflt.suites.map((x) => x.path))
ok('a page of template/site/src -> the site build and its two pages, plus its own suite (Message.tsx: board-message)', [...pick('template/site/src/Message.tsx')].sort().join(' ') === 'test/board-message.mjs test/board-phone.mjs test/board-space.mjs', pick('template/site/src/Message.tsx'))
ok('docs/** -> nothing', pick('docs/vault.md').length === 0)
ok('a suite that builds the site has needs=site (built once by gates)', real.suites.filter((x) => /board-(message|owner-card|phone|phone-space|space|artifacts)\.mjs$/.test(x.path)).every((x) => x.needs.includes('site')))
const mmSuites = real.suites.filter((x) => x.args.some((a) => a.includes('{mm}'))).map((x) => x.path)
ok('clean-box takes the built mm (--local {mm})', real.suites.find((x) => x.path === 'test/clean-box.sh')?.args.join(' ') === '--local {mm}', mmSuites)
ok('machine-panel.sh has needs=site (gates gives it SITE_NODE_MODULES) and mm', (() => { const m = real.suites.find((x) => x.path === 'test/machine-panel.sh'); return m.needs.includes('site') && m.needs.includes('mm') })())
ok('a needs=site suite gets SITE_NODE_MODULES (the site\'s packages gates installed)', /SITE_NODE_MODULES: path\.join\(wt, 'template', 'site', 'node_modules'\)/.test(fs.readFileSync(path.join(SRC, 'test', 'lib', 'gates.mjs'), 'utf8')))
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
// never the machine's run lock: this test's own
const run = (args, opts = {}) => sh(GATES, args, { cwd: R, env: { ...process.env, MM_GATES_LOCK: path.join(T, 'fixture.lock'), MM_GATES_DIR: GATES_DIR, PATH: opts.path || CLEAN_PATH }, ...opts })

let r = run(['main~1..main', '--list'])
ok('--list: exit 0', r.status === 0, r.stderr)
ok('--list: each changed file with its rules (docs: no suite; a new folder: the fallback)', /lib\/a\.txt\s+lib\/\*\*/.test(r.stdout) && /docs\/a\.md\s+docs\/\*\*\s+\(no suite\)/.test(r.stdout) && /other\/new\.txt\s+\(fallback\)/.test(r.stdout), r.stdout)
ok('--list: the suites in run order with why', /hermetic\s+test\/h1\.sh\s+<- lib\/\*\* \(lib\/a\.txt\), \(fallback\)/.test(r.stdout) && r.stdout.indexOf('test/d2.sh') < r.stdout.indexOf('test/l.sh'), r.stdout)
ok('--list: an unmapped path is named, and gates warns on stderr', /unmapped \(no rule names them[^\n]*\n\s+other\/new\.txt/.test(r.stdout) && /no rule of test\/gates\.map names: other\/new\.txt/.test(r.stderr) && /default set \(1 suite/.test(r.stderr), r.stdout + r.stderr)
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
ok('result: the failed suite with its exit code and counts (failed twice: again alone)', /^test\/f\.sh\s+hermetic\s+failed \(exit 1, again alone\)\s+2 ok, 1 FAIL/m.test(res2) && /^result: failed: 1 passed, 1 failed, 0 skipped, of 2/m.test(res2), res2)
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
ok("a range that changes the map: the base's map chooses too (the dropped suites still listed)", r.status === 0 && /test\/d1\.sh\s+<- lib\/\*\* \(the base's map\) \(lib\/a\.txt\)/.test(r.stdout) && /test\/l\.sh/.test(r.stdout) && /this range changes the map/.test(r.stdout), r.stdout + r.stderr)
ok('...and only those: no fallback to every suite (test/m.sh, test/f.sh not listed)', !/test\/(m|f)\.sh/.test(r.stdout), r.stdout)
// sy-sbjh.1: a range that changes only one rule of the map: that rule's new suite, nothing else
W('test/gates.map', fs.readFileSync(path.join(R, 'test/gates.map'), 'utf8').replace('rule bad/** test/f.sh', 'rule bad/** test/f.sh test/m.sh\nrule test/gates.map -'))
g('add', 'test/gates.map'); g('commit', '-qm', 'one rule gains a suite')
r = run(['main~1..main', '--list'])
ok("a range that changes only one rule of the map: only that rule's new suite (test/m.sh)", r.status === 0 && /test\/m\.sh\s+<- rule bad\/\*\* \(changed\) \(test\/gates\.map\)/.test(r.stdout) && (r.stdout.match(/^\s+(hermetic|ports|docker|live)\s+test\//gm) || []).length === 1, r.stdout + r.stderr)

step('--all <ref>: every suite of the map, one run (sy-sbjh.5)')
fs.rmSync(MARK, { force: true })
r = run(['--all', 'main', '--list'])
const allListed = (r.stdout.match(/^\s+(hermetic|ports|docker|live)\s+test\//gm) || []).length
ok('--all main --list: every suite of the map (7), live too, each "<- --all"', r.status === 0 && allListed === 7 && /live\s+test\/l\.sh\s+<- --all/.test(r.stdout) && /every suite of the map/.test(r.stdout), r.stdout + r.stderr)
const ALL = path.join(T, 'out', 'all.txt')
r = run(['--all', 'main', '--out', ALL, '--no-rerun', '--bin', fakeMm])
const resAll = fs.existsSync(ALL) ? fs.readFileSync(ALL, 'utf8') : ''
const ranAll = fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]).sort() : []
ok('--all main: each suite ran once, live too', ranAll.join(' ') === 'd1.sh d2.sh f.sh h1.sh h2.sh l.sh m.sh', ranAll)
ok('--all main: its result file names --all and every suite; f.sh fails it (exit 1)', r.status === 1 && /^range: --all main \([0-9a-f]{7}: every suite of the map\)$/m.test(resAll) && /^result: failed: 6 passed, 1 failed, 0 skipped, of 7/m.test(resAll) && /^test\/l\.sh\s+live\s+passed/m.test(resAll), resAll + r.stderr)
const histAll = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').slice(-7).map((l) => JSON.parse(l))
ok('--all main: one run (its 7 history lines, written once inside the run lock, share one date)', histAll.length === 7 && new Set(histAll.map((e) => e.date)).size === 1 && histAll.some((e) => e.suite === 'test/l.sh'), histAll)
ok('--all main: its worktree removed after', g('worktree', 'list').stdout.trim().split('\n').length === 1, g('worktree', 'list').stdout)
r = run(['--all', 'main~1..main', '--list']); ok('--all with a range: exit 2, says one ref', r.status === 2 && /--all takes one ref/.test(r.stderr), r.stderr)
r = run(['--all', '--list']); ok('--all with no ref: exit 2', r.status === 2 && /--all takes one ref/.test(r.stderr), r.stderr)

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

step('the run lock (sy-1nb8)')
ok('the wait line', waitLine({ label: 'sy-x', pid: 42, since: '2026-01-02T03:04:05.678Z' }) === 'gates: waits for the run lock, held by sy-x pid 42 since 2026-01-02T03:04:05Z')
{
  // a fixture of its own: two hermetic, two ports (fake: they bind nothing), two docker and one live suite, a second
  // each; spans tagged by run
  const R2 = path.join(T, 'repo2'), SP = path.join(T, 'spans2')
  const W2 = (f, x) => { fs.mkdirSync(path.dirname(path.join(R2, f)), { recursive: true }); fs.writeFileSync(path.join(R2, f), x) }
  const stub2 = (sec) => `#!/usr/bin/env bash\necho "$(basename "$0")@\${RUN_TAG:-x} $(date +%s.%N) start" >>"${SP}"\necho "  ok   one"\nsleep ${sec}\necho "$(basename "$0")@\${RUN_TAG:-x} $(date +%s.%N) end" >>"${SP}"\n`
  for (const n of ['h1', 'h2', 'p1', 'p2', 'd1', 'd2', 'l1']) W2(`test/${n}.sh`, stub2(1))
  W2('test/gates.map', 'suite test/h1.sh hermetic\nsuite test/h2.sh hermetic\nsuite test/p1.sh ports\nsuite test/p2.sh ports\nsuite test/d1.sh docker\nsuite test/d2.sh docker\nsuite test/l1.sh live\nrule lib/** %hermetic %ports %docker %live\nrule light/** %hermetic\nrule heavy1/** test/d1.sh\nrule ports1/** test/p1.sh\nrule live1/** test/l1.sh\nfallback %hermetic\n')
  W2('lib/a', '1\n'); W2('light/a', '1\n'); W2('heavy1/a', '1\n'); W2('ports1/a', '1\n'); W2('live1/a', '1\n')
  const g2 = (...a) => sh('git', ['-C', R2, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } })
  g2('init', '-q', '-b', 'main'); g2('add', '-A'); g2('commit', '-qm', 'base')
  W2('live1/a', '2\n'); g2('add', '-A'); g2('commit', '-qm', 'live only') // main~3..main~2: l1
  W2('ports1/a', '2\n'); g2('add', '-A'); g2('commit', '-qm', 'ports only') // main~2..main~1: p1
  W2('lib/a', '2\n'); W2('light/a', '2\n'); W2('heavy1/a', '2\n'); g2('add', '-A'); g2('commit', '-qm', 'lib') // main~1..main: every suite
  const runA = (args, env) => new Promise((done) => {
    // review sy-gb26 #3: these runs pass --item; with the real PATH they posted their result files to a real board
    const c = spawn(GATES, args, { cwd: R2, env: { ...process.env, MM_GATES_DIR: GATES_DIR, ...env, PATH: CLEAN_PATH } })
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => done({ code, out }))
  })
  const readSpans = () => (fs.existsSync(SP) ? fs.readFileSync(SP, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => l.split(' '))
    .reduce((a, [n, t, k]) => ((a[n] ||= { n })[k] = Number(t), a), {})
  const pairsOverlap = (xs) => xs.some((a, i) => xs.some((b, j) => i < j && a.start < b.end && b.start < a.end))
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const runOf = (x) => x.n.split('@')[1]
  // the two runs' suites never side by side: every suite of one ended before any of the other's started
  const apart = (xs) => { const by = (t) => xs.filter((x) => runOf(x) === t); const [p, q] = ['a', 'b'].map(by); return p.length && q.length && xs.every((x) => x.end) && (Math.max(...p.map((x) => x.end)) <= Math.min(...q.map((x) => x.start)) || Math.max(...q.map((x) => x.end)) <= Math.min(...p.map((x) => x.start))) }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const hasFlock = sh('sh', ['-c', 'command -v flock']).status === 0
  const deadPid = () => Number(sh('sh', ['-c', 'echo $$']).stdout.trim())
  for (const mode of ['flock', 'mkdir']) {
    if (mode === 'flock' && !hasFlock) { ok('flock: not on PATH, its checks skipped', true); continue }
    const LOCK = path.join(T, `lock-${mode}`, 'heavy.lock')
    const env = (tag) => ({ MM_GATES_LOCK: LOCK, MM_GATES_LOCK_MODE: mode, RUN_TAG: tag })
    const clean = () => !fs.existsSync(LOCK + '.d') && (!fs.existsSync(LOCK + '.q') || fs.readdirSync(LOCK + '.q').length === 0) && !fs.existsSync(LOCK + '.break')
    // 1. two runs at once, every suite (hermetic, ports, docker, live)
    fs.rmSync(SP, { force: true })
    const [a, b] = await Promise.all([
      runA(['main~1..main', '--item', 'run-a', '--jobs', '2', '--out', path.join(T, `a-${mode}.txt`)], env('a')),
      runA(['main~1..main', '--item', 'run-b', '--jobs', '2', '--out', path.join(T, `b-${mode}.txt`)], env('b')),
    ])
    const sp = Object.values(readSpans())
    ok(`${mode}: two runs at once both pass`, a.code === 0 && b.code === 0, a.out + b.out)
    ok(`${mode}: ...and neither reached a board (artifact not on their PATH)`, /artifact: not on PATH; the result file is not on run-a/.test(a.out) && /artifact: not on PATH; the result file is not on run-b/.test(b.out), a.out + b.out)
    ok(`${mode}: all fourteen suites ran`, sp.length === 14 && sp.every((x) => x.end), JSON.stringify(sp))
    ok(`${mode}: their ports suites never side by side`, !pairsOverlap(sp.filter((x) => /^p\d/.test(x.n))), JSON.stringify(sp))
    ok(`${mode}: no suite of one beside a suite of the other: one run's suites, then the other's`, apart(sp), JSON.stringify(sp))
    ok(`${mode}: ...within a run, its hermetic suites still side by side`, ['a', 'b'].every((t) => pairsOverlap(sp.filter((x) => /^h\d/.test(x.n) && runOf(x) === t))), JSON.stringify(sp))
    ok(`${mode}: the one that waited said once who holds the lock`, (a.out + b.out).match(/gates: waits for the run lock, held by run-[ab] pid \d+ since \d{4}-/g)?.length === 1, a.out + b.out)
    ok(`${mode}: nothing left behind (no ticket, no lock dir)`, clean())

    // 1b. two runs at once with a fake ports suite only (it binds nothing; the lock alone keeps them apart)
    fs.rmSync(SP, { force: true })
    const [pa, pb] = await Promise.all([
      runA(['main~2..main~1', '--out', path.join(T, `pa-${mode}.txt`)], env('a')),
      runA(['main~2..main~1', '--out', path.join(T, `pb-${mode}.txt`)], env('b')),
    ])
    const psp = Object.values(readSpans())
    ok(`${mode}: two ports-only runs: both pass, their ports suites never side by side`, pa.code === 0 && pb.code === 0 && psp.length === 2 && psp.every((x) => /^p1\.sh@/.test(x.n)) && apart(psp), JSON.stringify(psp) + pa.out + pb.out)

    // 1c. a run with nothing to start (its only suite is live, --no-live) takes no lock, even while another holds it
    if (mode === 'mkdir') {
      fs.mkdirSync(LOCK + '.d', { recursive: true }); fs.writeFileSync(path.join(LOCK + '.d', 'holder'), JSON.stringify({ label: 'busy-run', pid: process.pid, start: procStart(process.pid), since: '2026-01-02T03:04:05.000Z' }))
      const n = await runA(['main~3..main~2', '--no-live', '--out', path.join(T, `n-${mode}.txt`)], env('n'))
      ok('mkdir: a run with nothing to start does not wait (no lock)', n.code === 0 && !/waits for the run lock/.test(n.out) && /skipped/.test(fs.readFileSync(path.join(T, `n-${mode}.txt`), 'utf8')), n.out)
      ok('mkdir: ...and leaves the holder\'s lock alone', readJson(path.join(LOCK + '.d', 'holder'))?.label === 'busy-run')
      fs.rmSync(LOCK + '.d', { recursive: true, force: true })
    }

    // 2. another holder has it for 3s: the run prepares meanwhile, and starts its first suite only after
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
    ok(`${mode}: a run waits for another holder, and passes`, c.code === 0 && /gates: waits for the run lock, held by other-run pid \d+ since 2026-01-02T03:04:05Z/.test(c.out), c.out)
    const csp = Object.values(sp2).filter((x) => runOf(x) === 'c')
    ok(`${mode}: ...each of its suites (hermetic too) only after the other gave it back`, rel && csp.length === 7 && csp.every((x) => x.start >= rel), JSON.stringify({ rel, sp2 }))
    if (mode === 'mkdir') ok('mkdir: ...and says it took the lock over from the holder that is gone', /takes the run lock over from other-run pid \d+ \(no longer running\)/.test(c.out), c.out)

    // 3. a holder that is gone
    if (mode === 'flock') {
      fs.rmSync(SP, { force: true })
      const h = spawn('flock', ['-x', LOCK, 'sleep', '100'], { detached: true, stdio: 'ignore' })
      await wait(300)
      process.kill(-h.pid, 'SIGKILL')
      await wait(200)
      const d = await runA(['main~2..main~1', '--out', path.join(T, 'd-flock.txt')], env('d'))
      ok('flock: a holder killed (SIGKILL) holds nothing: no wait', d.code === 0 && !/waits for the run lock/.test(d.out) && !!readSpans()['p1.sh@d'], d.out)
    } else {
      // a dead pid; a live pid with another start time (reused)
      for (const [what, h] of [['dead', { label: 'gone-run', pid: deadPid(), start: '1', since: '2026-01-02T03:04:05.000Z' }], ['reused', { label: 'gone-run', pid: process.pid, start: '1', since: '2026-01-02T03:04:05.000Z' }]]) {
        fs.rmSync(SP, { force: true })
        fs.mkdirSync(LOCK + '.d', { recursive: true }); fs.writeFileSync(path.join(LOCK + '.d', 'holder'), JSON.stringify(h))
        const d = await runA(['main~2..main~1', '--out', path.join(T, `d-${what}.txt`)], env('d'))
        ok(`mkdir: a holder whose pid is ${what} is taken over, without waiting`, d.code === 0 && /takes the run lock over from gone-run/.test(d.out) && !/waits for the run lock/.test(d.out) && !!readSpans()['p1.sh@d'], d.out)
        ok('mkdir: ...and the lock is given back after', !fs.existsSync(LOCK + '.d'))
      }
    }
  }
}

step('the rerun and the history (sy-sbjh.4)')
{
  const R3 = path.join(T, 'repo3'), SP3 = path.join(T, 'spans3'), CNT = path.join(T, 'fl.count'), H3 = path.join(T, 'history3.jsonl')
  const W3 = (f, x) => { fs.mkdirSync(path.dirname(path.join(R3, f)), { recursive: true }); fs.writeFileSync(path.join(R3, f), x) }
  const span = (n) => `echo "${n} $(date +%s.%N) start" >>"${SP3}"`, end = (n) => `echo "${n} $(date +%s.%N) end" >>"${SP3}"`
  // fl: fails its first run (the count file), passes after; bad: always fails; good: passes after a second
  W3('test/fl.sh', `#!/usr/bin/env bash\n${span('fl')}\nn=$(cat "${CNT}" 2>/dev/null || echo 0); echo $((n+1)) >"${CNT}"\necho "  ok   one"\n${end('fl')}\nif [ "$n" -lt 1 ]; then echo "  FAIL two"; exit 3; fi\n`)
  W3('test/bad.sh', `#!/usr/bin/env bash\n${span('bad')}\necho "  FAIL one"\n${end('bad')}\nexit 1\n`)
  W3('test/good.sh', `#!/usr/bin/env bash\n${span('good')}\necho "  ok   one"\nsleep 1\n${end('good')}\n`)
  W3('test/gates.map', 'suite test/fl.sh hermetic\nsuite test/bad.sh hermetic\nsuite test/good.sh hermetic\nrule a/** test/fl.sh test/good.sh\nrule b/** test/bad.sh test/good.sh\nfallback test/good.sh\n')
  W3('a/x', '1\n'); W3('b/x', '1\n')
  const g3 = (...a) => sh('git', ['-C', R3, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } })
  g3('init', '-q', '-b', 'main'); g3('add', '-A'); g3('commit', '-qm', 'base')
  W3('a/x', '2\n'); g3('add', '-A'); g3('commit', '-qm', 'a') // main~2..main~1: fl + good
  W3('b/x', '2\n'); g3('add', '-A'); g3('commit', '-qm', 'b') // main~1..main: bad + good
  const aRange = 'main~2..main~1', bRange = 'main~1..main'
  const run3 = (args) => sh(GATES, args, { cwd: R3, env: { ...process.env, MM_GATES_LOCK: path.join(T, 'r3.lock'), MM_GATES_DIR: GATES_DIR, MM_GATES_HISTORY: H3, PATH: CLEAN_PATH } })
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  const spans3 = () => read(SP3).trim().split('\n').filter(Boolean).map((l) => l.split(' ')).map(([n, t, k]) => ({ n, t: Number(t), k }))
  const hist = () => read(H3).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  // 1. fails once, then passes alone: flaky; the run passes
  fs.rmSync(CNT, { force: true }); fs.rmSync(SP3, { force: true })
  const O1 = path.join(T, 'r3-flaky.txt')
  let x = run3([aRange, '--jobs', '2', '--out', O1])
  const t1 = read(O1)
  ok('a suite that fails, then passes alone: the run passes (exit 0)', x.status === 0, x.stdout + x.stderr)
  ok("...its line: flaky (exit 3, then passed alone), and it stays in the result file", /^test\/fl\.sh\s+hermetic\s+flaky \(exit 3, then passed alone\)\s/m.test(t1), t1)
  ok('...the result line counts it: passed: 1 passed, 0 failed, 1 flaky, 0 skipped, of 2', /^result: passed: 1 passed, 0 failed, 1 flaky, 0 skipped, of 2$/m.test(t1), t1)
  const sp1 = spans3(), flStarts = sp1.filter((s) => s.n === 'fl' && s.k === 'start'), goodEnd = sp1.find((s) => s.n === 'good' && s.k === 'end')
  ok('...it ran twice; the rerun started after every other suite ended (alone)', flStarts.length === 2 && goodEnd && flStarts[1].t >= goodEnd.t, JSON.stringify(sp1))
  const flLog = (t1.split('\n').find((l) => l.startsWith('test/fl.sh')) || '').split(/\s+/).pop()
  ok('...both runs in its one log, the rerun after "# gates: rerun alone"', /FAIL two[\s\S]*# gates: rerun alone \(the first run failed with exit 3\)[\s\S]*ok {3}one/.test(read(flLog)), read(flLog))
  ok("...a review sign-off reads a flaky line as no failure (gates-file's verdict)", gatesVerdict(t1, g3('rev-parse', 'main~1').stdout.trim()) === null, t1)
  let h = hist()
  ok('the history: one line per suite of the run, with suite, head, group, status, secs, date', h.length === 2 &&
    h.some((e) => e.suite === 'test/fl.sh' && e.status === 'flaky' && e.group === 'hermetic' && e.head === g3('rev-parse', 'main~1').stdout.trim() && typeof e.secs === 'number' && !isNaN(Date.parse(e.date))) &&
    h.some((e) => e.suite === 'test/good.sh' && e.status === 'passed' && e.secs >= 1), JSON.stringify(h))

  // 2. fails twice: failed; the run fails
  fs.rmSync(SP3, { force: true })
  const O2 = path.join(T, 'r3-bad.txt')
  x = run3([bRange, '--out', O2])
  const t2 = read(O2)
  ok('a suite that fails twice: failed (exit 1, again alone); the run fails (exit 1)', x.status === 1 && /^test\/bad\.sh\s+hermetic\s+failed \(exit 1, again alone\)/m.test(t2) && /^result: failed: 1 passed, 1 failed, 0 skipped, of 2$/m.test(t2), x.stdout + t2)
  ok('...it ran twice', spans3().filter((s) => s.n === 'bad' && s.k === 'start').length === 2, read(SP3))
  h = hist()
  ok('...the history grows by its two lines (bad: failed)', h.length === 4 && h.at(-1).suite !== h.at(-2).suite && h.some((e) => e.suite === 'test/bad.sh' && e.status === 'failed'), JSON.stringify(h))

  // 3. --no-rerun: a fail is a fail, run once
  fs.rmSync(CNT, { force: true }); fs.rmSync(SP3, { force: true })
  const O3 = path.join(T, 'r3-norerun.txt')
  x = run3([aRange, '--no-rerun', '--out', O3])
  const t3 = read(O3)
  ok('--no-rerun: the suite that fails once is failed (exit 3), run once; the run fails', x.status === 1 && /^test\/fl\.sh\s+hermetic\s+failed \(exit 3\)\s/m.test(t3) &&
    spans3().filter((s) => s.n === 'fl' && s.k === 'start').length === 1 && !/rerun alone/.test(read(path.join(T, 'r3-norerun.logs', 'fl.sh.log'))), x.stdout + t3)
  ok('...and its history line says failed', hist().at(-2)?.suite === 'test/fl.sh' && hist().at(-2)?.status === 'failed', JSON.stringify(hist().slice(-2)))

  // 4. --list writes no history
  const n = hist().length
  run3([aRange, '--list'])
  ok('--list: no history line', hist().length === n)

  // 5. the bound
  ok('the history keeps the last 5000 lines', HISTORY_MAX === 5000)
  const HB = path.join(T, 'hb', 'history.jsonl')
  appendHistory(HB, Array.from({ length: 4 }, (_, i) => ({ i })), 5)
  appendHistory(HB, Array.from({ length: 4 }, (_, i) => ({ i: i + 4 })), 5)
  const hb = read(HB).trim().split('\n').map((l) => JSON.parse(l).i)
  ok('appendHistory: past its bound, the file is cut to its last lines (oldest dropped)', hb.join(',') === '3,4,5,6,7', hb.join(','))
  ok('...and leaves no temp file', fs.readdirSync(path.dirname(HB)).join() === 'history.jsonl', fs.readdirSync(path.dirname(HB)))
}

step('the build cache (sy-sbjh.2)')
{
  const R4 = path.join(T, 'repo4'), CALLS = path.join(T, 'build.calls'), SEEN4 = path.join(T, 'seen4')
  const W4 = (f, x) => { fs.mkdirSync(path.dirname(path.join(R4, f)), { recursive: true }); fs.writeFileSync(path.join(R4, f), x) }
  const g4 = (...a) => sh('git', ['-C', R4, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } })
  // m: takes {mm}; l: a live suite with needs=mm that finds mm on its PATH (as lifecycle does); both say what they got
  W4('test/m.sh', `#!/usr/bin/env bash\necho "m arg=$1 tpl=\${MM_TEMPLATE_DIR:-} out=$("$1")" >>"${SEEN4}"\necho "  ok   m"\n`)
  W4('test/l.sh', `#!/usr/bin/env bash\nexport PATH="\${MM_BIN_DIR:-/nowhere}:$PATH"\necho "l mm=$(readlink -f "$(command -v mm)") tpl=\${MM_TEMPLATE_DIR:-} out=$(mm)" >>"${SEEN4}"\necho "  ok   l"\n`)
  W4('test/gates.map', 'suite test/m.sh hermetic -- {mm}\nsuite test/l.sh live needs=mm\nrule lib/** test/m.sh test/l.sh\nfallback test/m.sh\n')
  W4('template/a.txt', 'tpl\n'); W4('lib/a', '1\n')
  g4('init', '-q', '-b', 'main'); g4('add', '-A'); g4('commit', '-qm', 'base')
  W4('lib/a', '2\n'); g4('add', '-A'); g4('commit', '-qm', 'one')
  const head4 = g4('rev-parse', 'HEAD').stdout.trim()
  // the stub build: records each call (its folder and args); its mm prints the head it was built from
  const BUILD = path.join(T, 'stub-build')
  fs.writeFileSync(BUILD, `#!/bin/sh\necho "$(pwd) $*" >>"${CALLS}"\nprintf '#!/bin/sh\\necho mm-of-%s\\n' "$(git rev-parse HEAD)" >"$1"\nchmod +x "$1"\n`, { mode: 0o755 })
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  const calls = () => read(CALLS).split('\n').filter(Boolean).length
  const run4 = (args, more = {}) => sh(GATES, args, { cwd: R4, env: { ...process.env, MM_GATES_LOCK: path.join(T, 'r4.lock'), MM_GATES_DIR: GATES_DIR, MM_GATES_BUILD: BUILD, PATH: CLEAN_PATH, ...more } })
  const shas = () => fs.readdirSync(BUILDS).filter((n) => /^[0-9a-f]{40}$/.test(n))
  const sum = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  // the cache already holds 23 older builds; mm ship's current links to the oldest, previous is a copy of the second
  const fake = Array.from({ length: BUILDS_KEEP + 3 }, (_, i) => crypto.createHash('sha1').update(`fake${i}`).digest('hex'))
  fake.forEach((f, i) => { const d = path.join(BUILDS, f); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'mm'), 'x'); const t = new Date(Date.now() - (100 - i) * 3600_000); fs.utimesSync(d, t, t) })
  fs.symlinkSync(fake[0], path.join(BUILDS, 'current'))
  fs.mkdirSync(path.join(BUILDS, 'previous')); fs.writeFileSync(path.join(BUILDS, 'previous', 'sha'), fake[1] + '\n')
  const B = path.join(BUILDS, head4)

  // 1. the first run builds
  const O1 = path.join(T, 'b1.txt')
  let x = run4(['main~1..main', '--out', O1])
  const t1 = read(O1), seen1 = read(SEEN4)
  ok("a run that needs mm: passes, one build, in the worktree (not the caller's checkout)", x.status === 0 && calls() === 1 && !read(CALLS).startsWith(R4) && /mm built: /.test(x.stdout), x.stdout + x.stderr + read(CALLS))
  ok("...into <builds>/<full sha>/: mm, template/ (the head's), and the stamp (mm's sha256)", fs.existsSync(path.join(B, 'mm')) && read(path.join(B, 'template', 'a.txt')) === 'tpl\n' && checkStamp(B), fs.existsSync(B) ? fs.readdirSync(B) : 'no ' + B)
  ok('...no dist/, no temp folder left in the cache', !fs.existsSync(path.join(R4, 'dist')) && !fs.readdirSync(BUILDS).some((n) => n.startsWith('.')), fs.readdirSync(BUILDS))
  const mmLine = `mm: ${BUILDS}/${head4.slice(0, 7)}…/mm (sha256 ${fs.existsSync(B) ? sum(path.join(B, 'mm')).slice(0, 12) : '?'})`
  ok(`the result file names the build: ${mmLine.replace(BUILDS, '<builds>')}`, t1.split('\n').includes(mmLine) && buildName(B) === mmLine.slice(4, mmLine.indexOf(' (')), t1)
  ok('{mm} is that build, with its template (MM_TEMPLATE_DIR)', seen1.includes(`m arg=${B}/mm tpl=${B}/template out=mm-of-${head4}`), seen1)
  ok("a needs=mm suite (lifecycle's way: MM_BIN_DIR on PATH) runs that same binary, with its template", seen1.includes(`l mm=${B}/mm tpl=${B}/template out=mm-of-${head4}`), seen1)
  const left = shas()
  ok(`the bound: the ${BUILDS_KEEP} newest kept, plus current's and previous's; the other old ones removed`, left.length === BUILDS_KEEP + 2 && left.includes(head4) && left.includes(fake[0]) && left.includes(fake[1]) && !left.includes(fake[2]) && !left.includes(fake[3]) && left.includes(fake[4]), left.length + ' ' + JSON.stringify(fake.map((f) => left.includes(f))))
  ok('...it says which it removed; current and previous are left as they are', /build cache keeps 20: removed /.test(x.stdout) && fs.readlinkSync(path.join(BUILDS, 'current')) === fake[0] && read(path.join(BUILDS, 'previous', 'sha')).trim() === fake[1], x.stdout)

  // 2. a second run of the same head: no build
  fs.rmSync(SEEN4, { force: true })
  const O2 = path.join(T, 'b2.txt')
  x = run4(['main~1..main', '--out', O2])
  ok('two runs of one head: one build (the second takes the cache)', x.status === 0 && calls() === 1 && /mm from the cache: /.test(x.stdout) && !/mm built/.test(x.stdout), x.stdout + x.stderr)
  ok('...its result file names the same build', read(O2).split('\n').includes(mmLine), read(O2))
  ok('...its suites ran that same binary', read(SEEN4).includes(`m arg=${B}/mm`) && read(SEEN4).includes(`l mm=${B}/mm`), read(SEEN4))

  // 3. a stamp that is not the binary's, or none: built again
  fs.writeFileSync(path.join(B, BUILD_STAMP), `${'0'.repeat(64)}  mm\n`)
  x = run4(['main~1..main', '--out', path.join(T, 'b3.txt')])
  ok('a stamp that does not match the binary: built again (and it says why)', x.status === 0 && calls() === 2 && /does not count \(its mm's sha256 .* is not the stamp's/.test(x.stdout), x.stdout + x.stderr)
  ok('...the new stamp matches again', checkStamp(B))
  fs.rmSync(path.join(B, BUILD_STAMP))
  x = run4(['main~1..main', '--out', path.join(T, 'b4.txt')])
  ok('no stamp: built again', x.status === 0 && calls() === 3 && checkStamp(B), x.stdout + x.stderr)

  // 4. --bin: no build; the result names it with its sha256
  const fm = path.join(T, 'fake-mm4'); fs.writeFileSync(fm, '#!/bin/sh\necho fake\n', { mode: 0o755 })
  x = run4(['main~1..main', '--bin', fm, '--out', path.join(T, 'b5.txt')])
  ok('--bin: no build, the result names it with its sha256', x.status === 0 && calls() === 3 && read(path.join(T, 'b5.txt')).includes(`mm: --bin ${fm} (sha256 ${sum(fm).slice(0, 12)})`), read(path.join(T, 'b5.txt')))

  // 5. a build that fails: the suites that need mm are not prepared; nothing is left in the cache
  W4('lib/a', '3\n'); g4('add', '-A'); g4('commit', '-qm', 'two')
  const head5 = g4('rev-parse', 'HEAD').stdout.trim()
  x = run4(['main~1..main', '--out', path.join(T, 'b6.txt')], { MM_GATES_BUILD: path.join('/bin', 'false') })
  ok('a failed build: exit 1, the suites not prepared, no build and no temp folder left', x.status === 1 && /test\/m\.sh\s+hermetic\s+failed \(not prepared\)/.test(read(path.join(T, 'b6.txt'))) && !fs.existsSync(path.join(BUILDS, head5)) && !fs.readdirSync(BUILDS).some((n) => n.startsWith('.')), x.stdout + read(path.join(T, 'b6.txt')))
}
{
  // pruneBuilds on its own: an absolute link with a trailing slash, a relative one; leftovers a day old
  const P = path.join(T, 'prune'); fs.mkdirSync(P)
  const ids = Array.from({ length: 6 }, (_, i) => crypto.createHash('sha1').update(`p${i}`).digest('hex'))
  ids.forEach((f, i) => { const d = path.join(P, f); fs.mkdirSync(d); const t = new Date(Date.now() - (10 - i) * 60_000); fs.utimesSync(d, t, t) })
  fs.symlinkSync(path.join(P, ids[0]) + '/', path.join(P, 'current')); fs.symlinkSync(ids[1], path.join(P, 'previous'))
  for (const [n, days] of [['.tmp-old', 2], ['.tmp-new', 0]]) { const d = path.join(P, n); fs.mkdirSync(d); const t = new Date(Date.now() - days * 86_400_000 - 1000); fs.utimesSync(d, t, t) }
  const gone = pruneBuilds(P, 2, [ids[2]])
  ok("pruneBuilds: keeps the newest n, current (absolute link), previous (relative link) and the run's own", gone.join() === ids[3] && [0, 1, 2, 4, 5].every((i) => fs.existsSync(path.join(P, ids[i]))), gone)
  ok('...a temp folder a day old goes, a fresh one stays', !fs.existsSync(path.join(P, '.tmp-old')) && fs.existsSync(path.join(P, '.tmp-new')))
  ok('...no cache folder: nothing to do', pruneBuilds(path.join(T, 'none')).length === 0)
}

step('usage and map errors')
r = run([]); ok('no range: exit 2 with the usage', r.status === 2 && /usage: test\/gates/.test(r.stderr))
r = run(['nope..main', '--list']); ok('a range that is not this repo\'s: exit 2', r.status === 2 && /not a commit range/.test(r.stderr), r.stderr)
r = run(['main~1..main', '--frob']); ok('an unknown option: exit 2', r.status === 2)
fs.writeFileSync(path.join(T, 'bad.map'), 'rule x/** test/none.sh\nfallback test/none.sh\n')
r = run(['main~1..main', '--list', '--map', path.join(T, 'bad.map')]); ok('a map error: exit 2, the line named', r.status === 2 && /line 1: test\/none\.sh names no suite/.test(r.stderr), r.stderr)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
