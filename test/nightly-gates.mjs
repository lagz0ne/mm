#!/usr/bin/env node
// bin/nightly-gates (profile system, sy-sbjh.5), hermetic: a stub mm (its config), a throwaway repo whose test/gates is
// a stub, a fake clock (NIGHTLY_NOW). gates.repo unset: a log line, nothing runs; gates.nightly off or not HH:MM; the
// first pass waits for the next slot; before the slot nothing; after it one detached run (the pass exits at once) and
// never a second the same night, nor one beside a run still going; --run: test/gates --all main in the repo, last.json
// with the failed suites and their logs' last lines; a passing run: code 0, no failed file; the last 14 nights kept;
// test/gates gets bun on PATH (not there: the first fallback folder that has it; none: last.json says so, no run),
// umask 022 (from a parent's 077) and GATES_DOOP_IMAGE = mm's doop.image (only when set) (sy-czyo).
// The Supervisor's side (one item, closed by a passing night): test/supervisor.mjs. Clean PATH; temp folder only.
//   node test/nightly-gates.mjs        exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-gates-'))
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }))
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${String(more).slice(0, 1500)}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const NODE_DIR = path.dirname(spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim())
const hasBun = (d) => { try { fs.accessSync(path.join(d, 'bun'), fs.constants.X_OK); return true } catch { return false } }
// no folder of the job's PATH has a bun (node alone, linked, if its folder has one)
let CLEAN_PATH = [NODE_DIR, '/usr/local/bin', '/usr/bin', '/bin'].filter((d) => !hasBun(d))
if (!CLEAN_PATH.includes(NODE_DIR)) { const nb = path.join(T, 'nodebin'); fs.mkdirSync(nb); fs.symlinkSync(process.execPath, path.join(nb, 'node')); CLEAN_PATH.unshift(nb) }
CLEAN_PATH = CLEAN_PATH.join(':')
// fake buns: one in a fallback folder of the tests (BUNS), and later one in $HOME/.bun/bin
const BUNS = path.join(T, 'buns'), NOBUN = path.join(T, 'nobun')
fs.mkdirSync(BUNS); fs.mkdirSync(NOBUN); fs.writeFileSync(path.join(BUNS, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

// the board folder: <sys>/bin/nightly-gates + bin/lib
const SYS = path.join(T, 'sys'), HOME = path.join(T, 'home'), DIR = path.join(T, 'nightly')
fs.mkdirSync(path.join(SYS, 'bin'), { recursive: true }); fs.mkdirSync(HOME)
fs.copyFileSync(path.join(SRC, 'template/profiles/system/bin/nightly-gates'), path.join(SYS, 'bin/nightly-gates'))
fs.cpSync(path.join(SRC, 'template/bin/lib'), path.join(SYS, 'bin/lib'), { recursive: true })
// stub mm: `mm config get <key>` from <T>/conf/<key>; not there: exit 1 (as mm does)
const CONF = path.join(T, 'conf'); fs.mkdirSync(CONF)
fs.writeFileSync(path.join(T, 'mm'), `#!/bin/sh\n[ "$1 $2" = "config get" ] || { echo "stub mm: $*" >&2; exit 9; }\n[ -f "${CONF}/$3" ] && exec cat "${CONF}/$3"\nexit 1\n`, { mode: 0o755 })
const set = (k, v) => (v === undefined ? fs.rmSync(path.join(CONF, k), { force: true }) : fs.writeFileSync(path.join(CONF, k), `${v}\n`))

// a throwaway repo; its test/gates is a stub: records its args, writes a result file as test/gates does, exits as told
const R = path.join(T, 'repo'), CALLS = path.join(T, 'calls')
fs.mkdirSync(path.join(R, 'test'), { recursive: true })
fs.writeFileSync(path.join(R, 'test/gates'), `#!/bin/sh
echo "$*" >>"${CALLS}"
{ echo "PATH=$PATH"; echo "umask=$(umask)"; echo "doop=\${GATES_DOOP_IMAGE-unset}"; } >"${T}/gates.env"
[ -f "${T}/gates.sleep" ] && sleep "$(cat "${T}/gates.sleep")"
out=$4; logs=\${out%.txt}.logs; mkdir -p "$logs"
for i in $(seq 1 100); do echo "box line $i"; done >"$logs/box.sh.log"
h=$(git rev-parse main)
{ echo "head: $h the subject"; echo "range: --all main ($(echo $h | cut -c1-7): every suite of the map)"; echo "result: x"; echo
  echo "test/a.sh         hermetic  passed   1 ok, 0 FAIL   1s  $logs/a.sh.log"
  if [ -f "${T}/gates.fail" ]; then echo "test/box.sh       live      failed (exit 1, again alone)  -  9s  $logs/box.sh.log"; exit_code=1; else exit_code=0; fi
} >"$out"
[ -f "${T}/gates.fail" ] && exit 1; exit 0
`, { mode: 0o755 })
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' }
const g = (...a) => spawnSync('git', ['-C', R, ...a], { encoding: 'utf8', env: GENV })
g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'init')
const SHA7 = g('rev-parse', '--short=7', 'main').stdout.trim()

const at = (h, m = 0, day = 9) => new Date(2026, 10, day, h, m).getTime() // local time
const job = (now, args = [], more = { NIGHTLY_BUN_DIRS: BUNS }) => spawnSync('node', [path.join(SYS, 'bin/nightly-gates'), ...args], { encoding: 'utf8', cwd: SYS,
  env: { PATH: CLEAN_PATH, HOME, MM_PROJECT: 'sysqa', MM_OBS_TRACES: '', MM_OBS_METRICS: '', MM_BIN: path.join(T, 'mm'), MM_GATES_NIGHTLY: DIR, NIGHTLY_NOW: String(now), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...more } })
const genv = () => { try { return Object.fromEntries(fs.readFileSync(path.join(T, 'gates.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) } catch { return {} } }
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : [])
const last = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'last.json'), 'utf8')) } catch { return null } }
const wait = async (fn, ms = 15000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 100)); return fn() }

step('the settings')
let r = job(at(4))
ok('gates.repo unset: exit 0, a log line, nothing runs', r.status === 0 && /gates\.repo is not set/.test(r.stdout) && !calls().length && !fs.existsSync(DIR), r.stdout + r.stderr)
set('gates.repo', path.join(T, 'nope'))
r = job(at(4)); ok('gates.repo with no test/gates: exit 1, says so', r.status === 1 && /has no test\/gates/.test(r.stdout), r.stdout + r.stderr)
set('gates.repo', R); set('gates.nightly', 'off')
r = job(at(4)); ok('gates.nightly off: nothing runs', r.status === 0 && /off/.test(r.stdout) && !calls().length, r.stdout + r.stderr)
set('gates.nightly', '25:00')
r = job(at(4)); ok('gates.nightly not HH:MM: exit 1, says so', r.status === 1 && /not HH:MM/.test(r.stdout), r.stdout + r.stderr)
set('gates.nightly')

step('when it runs (default 03:00)')
r = job(at(2, 50)); ok('the first pass: waits for the next slot (no run, even past one)', r.status === 0 && /first pass/.test(r.stdout) && !calls().length, r.stdout + r.stderr)
r = job(at(2, 59)); ok('02:59: not yet', r.status === 0 && !calls().length && !last())
fs.writeFileSync(path.join(T, 'gates.fail'), '')
fs.writeFileSync(path.join(T, 'gates.sleep'), '2')
const t0 = Date.now()
r = job(at(3, 5))
ok('03:05: it starts one run, detached, and the pass exits at once', r.status === 0 && /started test\/gates --all main/.test(r.stdout) && Date.now() - t0 < 1500, r.stdout + r.stderr)
r = job(at(3, 15)); ok('03:15, still running: none beside it, and none twice tonight', r.status === 0 && !/started/.test(r.stdout))
const st = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'))
await wait(() => last())
ok('one call: test/gates --all main --out <dir>/nightly-<date>-<sha7>.txt', calls().length === 1 && new RegExp(`^--all main --out ${DIR}/nightly-\\d{4}-\\d\\d-\\d\\d-${SHA7}\\.txt$`).test(calls()[0]), calls())
const L = last() || {}
ok('last.json: the head, exit 1, the failed suite', L.sha7 === SHA7 && L.code === 1 && L.failed?.join() === 'test/box.sh' && L.result && fs.existsSync(L.result), L)
const fl = L.failedLogs && fs.existsSync(L.failedLogs) ? fs.readFileSync(L.failedLogs, 'utf8') : ''
ok("the failed suite's log: its last 60 lines, in one file next to the result", /== test\/box\.sh/.test(fl) && fl.includes('box line 100') && fl.includes('box line 41') && !fl.includes('box line 40\n'), fl.slice(0, 300))
ok('the run log of the night is there', fs.readdirSync(DIR).some((f) => /^nightly-\d{4}-\d\d-\d\d\.log$/.test(f)))
r = job(at(23, 50)); ok('23:50 the same day: no second run', !/started/.test(r.stdout) && calls().length === 1)
// a run that is gone mid-night: its pid no longer runs (no state pid kept alive)
ok('the state names the run (pid, its start)', Number(st.pid) > 0)

step('the next night: a run still going from the night before: none beside it')
const startOf = (pid) => { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }
fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify({ last: at(3, 5), pid: process.pid, start: startOf(process.pid) }))
r = job(at(3, 1, 10)); ok('a live run (its pid and start): says so, starts none', /still runs: none beside it/.test(r.stdout) && calls().length === 1, r.stdout + r.stderr)
fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify({ last: at(3, 5), pid: process.pid, start: '1' }))
fs.rmSync(path.join(DIR, 'last.json'))
fs.rmSync(path.join(T, 'gates.fail')); fs.rmSync(path.join(T, 'gates.sleep'))
r = job(at(3, 1, 10)); ok('its pid reused by another process (another start): a new run', /started/.test(r.stdout), r.stdout + r.stderr)
await wait(() => last())
ok('last.json: code 0, nothing failed, no failed file', last()?.code === 0 && last().failed.length === 0 && last().failedLogs === null, last())

step('the night after: a passing run')
fs.rmSync(path.join(DIR, 'last.json'))
r = job(at(3, 1, 11)); ok('03:01 the day after: one more run', /started/.test(r.stdout) && (await wait(() => last())) && calls().length === 3, r.stdout + r.stderr)
r = job(at(4, 0, 11)); ok('...and not a second one that night', !/started/.test(r.stdout) && calls().length === 3)

step('--run by hand, and the last 14 nights')
for (let d = 1; d <= 16; d++) fs.writeFileSync(path.join(DIR, `nightly-2026-10-${String(d).padStart(2, '0')}-abcdef0.txt`), 'x\n')
r = job(at(12, 0, 10), ['--run'])
ok('--run: runs at once, in the foreground (exit 0)', r.status === 0 && /passed/.test(r.stdout), r.stdout + r.stderr)
const nights = [...new Set(fs.readdirSync(DIR).map((f) => /^nightly-(\d{4}-\d\d-\d\d)/.exec(f)?.[1]).filter(Boolean))]
ok('only the last 14 nights are kept', nights.length === 14 && !nights.includes('2026-10-01'), nights)

step('what test/gates runs with: bun on PATH, umask 022, the live Doop image (sy-czyo)')
fs.rmSync(path.join(T, 'gates.env'), { force: true })
r = job(at(12, 0, 10), ['--run'])
let ge = genv()
ok('no bun on PATH: the fallback folder that has one goes first, and the log names it', ge.PATH?.split(':')[0] === BUNS && ge.PATH.endsWith(CLEAN_PATH) && r.stdout.includes(`bun: ${BUNS}/bun`), r.stdout + JSON.stringify(ge))
ok('doop.image unset: no GATES_DOOP_IMAGE', ge.doop === 'unset', ge)
fs.mkdirSync(path.join(HOME, '.bun', 'bin'), { recursive: true }); fs.copyFileSync(path.join(BUNS, 'bun'), path.join(HOME, '.bun', 'bin', 'bun'))
set('doop.image', 'sha256:feed')
const um = process.umask(0o077)
r = job(at(12, 0, 10), ['--run'], {})
process.umask(um)
ge = genv()
ok('the default fallbacks: $HOME/.bun/bin first', r.status === 0 && ge.PATH?.split(':')[0] === path.join(HOME, '.bun', 'bin'), r.stdout + r.stderr + JSON.stringify(ge))
ok('a parent with umask 077: test/gates runs with 022', ge.umask === '0022', ge)
ok('GATES_DOOP_IMAGE: mm config doop.image', ge.doop === 'sha256:feed' && /GATES_DOOP_IMAGE: sha256:feed/.test(r.stdout), ge)
set('doop.image')
r = job(at(12, 0, 10), ['--run'], { PATH: `${BUNS}:${CLEAN_PATH}`, NIGHTLY_BUN_DIRS: NOBUN })
ok('bun already on PATH: PATH as it was, nothing added', genv().PATH === `${BUNS}:${CLEAN_PATH}` && !/added to PATH/.test(r.stdout), r.stdout + JSON.stringify(genv()))
fs.rmSync(path.join(T, 'gates.env')); fs.rmSync(path.join(DIR, 'last.json')); const n0 = calls().length
r = job(at(12, 0, 10), ['--run'], { NIGHTLY_BUN_DIRS: NOBUN })
ok('no bun anywhere: exit 2, last.json says so, test/gates does not run', r.status === 2 && /^no bun: not on PATH, nor in /.test(last()?.error) && last().code === 2 && last().failed.length === 0 && calls().length === n0 && !fs.existsSync(path.join(T, 'gates.env')), r.stdout + JSON.stringify(last()))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
