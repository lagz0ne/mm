#!/usr/bin/env node
// test/gates: the changed files of a commit range decide the test suites (test/gates.map), and the suites run on the
// head's content. Usage:
//   test/gates <base>..<head> [--list] [--out <file>] [--item <id>] [--no-live] [--bin <mm>] [--jobs <n>] [--keep]
//     --list         print the suites and why (which changed file matched which rule); run nothing
//     --out <file>   the result file (default gates-<short head>.txt here); each suite's whole log next to it, in
//                    <file without .txt>.logs/
//     --item <id>    then `artifact <id> <file>` when artifact is on PATH (else it says so)
//     --no-live      skip the live group; the result says "skipped (--no-live)" for each, never "passed"
//     --bin <mm>     the mm the suites get ({mm}, MM_BIN_DIR) instead of one built from the head
//     --jobs <n>     hermetic suites at once (default: half the CPUs, 2 to 6; under load at most the idle CPUs,
//                    max(1, CPUs - 1-minute load average); see defaultJobs)
//     --keep         keep the throwaway worktree and the built mm (their folder is printed)
//     --map <file>   another map (default: the head's test/gates.map, else this checkout's)
// The range: <base>..<head> or <base>...<head>; the files are what <head> changed since its merge base with <base>.
// The run: a throwaway `git worktree` of <head> under $TMPDIR (a shared clone where the repo can't take a worktree),
// removed after; never the caller's checkout. An mm, when a suite needs one, is built from that worktree into the
// same throwaway folder (never dist/mm). Exit: 0 when every suite that ran passed; 1 when one failed (or could not be
// prepared); 2 on a usage or map error.
// The heavy lock: the heavy groups (docker, live) run one suite at a time across every gates run of the user on the
// machine. Each heavy suite takes the lock right before it starts and gives it back right after, so two runs take
// turns suite by suite; hermetic and ports suites never wait for it. The lock: $MM_GATES_LOCK, else
// ~/.cache/mm-gates/heavy.lock. It is flock(2) (through the flock command) when flock is on PATH, else a directory
// <lock>.d made by an atomic rename with the holder in it (MM_GATES_LOCK_MODE=flock|mkdir forces one). A run that
// waits says once: "gates: waits for the heavy lock, held by <item or range> pid <n> since <time>". A holder that no
// longer runs (its pid is gone, or reused: another start time) holds nothing: flock's lock dies with it, and a <lock>.d
// whose holder is gone is taken over.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GROUPS = ['hermetic', 'ports', 'docker', 'live']
const NEEDS = ['mm', 'site']
const PLACEHOLDERS = ['{mm}', '{bd}', '{dolt}', '{old-template}']

// --- the map -------------------------------------------------------------------------------------------------------

// a glob as a RegExp: * and ? within a segment, ** across segments, a trailing / or /** for the whole folder
export function globRe(glob) {
  let g = glob.endsWith('/') ? glob + '**' : glob
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
export const globMatch = (glob, p) => globRe(glob).test(p)

// parseMap(text) -> { suites: [{path, group, needs, args, line}], sets, rules: [{glob, targets, line}], fallback, errors }
export function parseMap(text) {
  const suites = [], sets = {}, rules = [], errors = []
  let fallback = null
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    const s = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!s) return
    const [kw, ...rest] = s.split(/\s+/)
    if (kw === 'suite') {
      const dd = rest.indexOf('--')
      const head = dd < 0 ? rest : rest.slice(0, dd)
      const args = dd < 0 ? [] : rest.slice(dd + 1)
      const [p, group, ...opts] = head
      if (!p || !group) return errors.push(`line ${line}: suite <path> <group> [needs=..] [-- args]`)
      if (!GROUPS.includes(group)) errors.push(`line ${line}: ${p}: unknown group "${group}" (one of ${GROUPS.join(', ')})`)
      if (suites.some((x) => x.path === p)) errors.push(`line ${line}: ${p} declared twice`)
      let needs = []
      for (const o of opts) {
        const m = /^needs=(.+)$/.exec(o)
        if (!m) { errors.push(`line ${line}: ${p}: unknown option "${o}"`); continue }
        needs = m[1].split(',')
        for (const n of needs) if (!NEEDS.includes(n)) errors.push(`line ${line}: ${p}: unknown need "${n}" (one of ${NEEDS.join(', ')})`)
      }
      for (const a of args) for (const ph of a.match(/\{[^}]*\}/g) || []) if (!PLACEHOLDERS.includes(ph)) errors.push(`line ${line}: ${p}: unknown placeholder ${ph}`)
      suites.push({ path: p, group, needs, args, line })
    } else if (kw === 'set') {
      const [name, ...targets] = rest
      if (!name || !targets.length) return errors.push(`line ${line}: set <name> <target>...`)
      ;(sets[name] ||= []).push(...targets.map((t) => ({ t, line })))
    } else if (kw === 'rule') {
      const [glob, ...targets] = rest
      if (!glob || !targets.length) return errors.push(`line ${line}: rule <glob> <target>... (or -)`)
      rules.push({ glob, targets, line })
    } else if (kw === 'fallback') {
      if (!rest.length) return errors.push(`line ${line}: fallback <target>...`)
      if (fallback) errors.push(`line ${line}: a second fallback`)
      fallback = { targets: rest, line }
    } else errors.push(`line ${line}: unknown keyword "${kw}"`)
  })
  const map = { suites, sets, rules, fallback, errors }
  // every target resolves to at least one suite (a typo would otherwise drop a suite silently)
  const check = (t, line) => { try { if (t !== '-' && !resolve(map, t).length) errors.push(`line ${line}: ${t} names no suite`) } catch (e) { errors.push(`line ${line}: ${e.message}`) } }
  for (const r of rules) for (const t of r.targets) check(t, r.line)
  for (const [, ts] of Object.entries(sets)) for (const { t, line } of ts) check(t, line)
  if (fallback) for (const t of fallback.targets) check(t, fallback.line)
  else errors.push('no fallback: a file no rule names would run nothing')
  return map
}

// resolve(map, target) -> the suites' paths it names
export function resolve(map, t, seen = []) {
  if (t === '-') return []
  if (t.startsWith('@')) {
    const name = t.slice(1)
    if (!map.sets[name]) throw new Error(`unknown set @${name}`)
    if (seen.includes(name)) throw new Error(`set @${name} names itself (${[...seen, name].join(' -> ')})`)
    return [...new Set(map.sets[name].flatMap(({ t: x }) => resolve(map, x, [...seen, name])))]
  }
  if (t.startsWith('%')) {
    const g = t.slice(1)
    if (!GROUPS.includes(g)) throw new Error(`unknown group ${t}`)
    return map.suites.filter((s) => s.group === g).map((s) => s.path)
  }
  return map.suites.filter((s) => s.path === t || globMatch(t, s.path)).map((s) => s.path)
}

// select(map, files) -> { files: [{file, rules: [glob|'(the suite itself)'|'(fallback)'], suites}], suites: [{...suite, why}] }
// The suites in run order: by group (hermetic, ports, docker, live), then as the map declares them.
export function select(map, files) {
  const why = new Map()
  const add = (p, file, rule) => { if (!why.has(p)) why.set(p, []); why.get(p).push({ file, rule }) }
  const out = []
  for (const file of files) {
    const hits = []
    if (map.suites.some((s) => s.path === file)) { hits.push('(the suite itself)'); add(file, file, '(the suite itself)') }
    for (const r of map.rules) if (globMatch(r.glob, file)) {
      hits.push(r.glob)
      for (const t of r.targets) for (const p of resolve(map, t)) add(p, file, r.glob)
    }
    if (!hits.length) {
      hits.push('(fallback)')
      for (const t of map.fallback?.targets || []) for (const p of resolve(map, t)) add(p, file, '(fallback)')
    }
    out.push({ file, rules: hits })
  }
  const suites = map.suites.filter((s) => why.has(s.path))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.line - b.line)
    .map((s) => ({ ...s, why: why.get(s.path) }))
  return { files: out, suites }
}

// selectBoth(head, base, files): a range that changes test/gates.map itself must not choose its own gates (review
// sy-v47f #3): the suites either map selects, the union. A suite both maps declare runs as the head declares it; one
// only the base declares (the range dropped it) still runs, as the base declared it, and its why says so.
export function selectBoth(head, base, files) {
  const h = select(head, files), b = select(base, files), out = new Map(h.suites.map((s) => [s.path, s]))
  for (const s of b.suites) {
    const w = s.why.map((x) => ({ ...x, rule: `${x.rule} (the base's map)` }))
    if (out.has(s.path)) { const o = out.get(s.path); o.why = [...o.why, ...w.filter((x) => !o.why.some((y) => y.file === x.file && y.rule.startsWith(x.rule.replace(/ \(the base's map\)$/, ''))))] }
    else out.set(s.path, { ...(head.suites.find((x) => x.path === s.path) || s), why: w })
  }
  const order = (s) => [GROUPS.indexOf(s.group), (head.suites.find((x) => x.path === s.path) || { line: 1e6 + s.line }).line]
  const suites = [...out.values()].sort((a, c) => { const [g1, l1] = order(a), [g2, l2] = order(c); return g1 - g2 || l1 - l2 })
  return { files: h.files, suites }
}

// why(suite): its rules, each with its first file and how many more: "template/site/src/** (template/site/src/A.tsx +2)"
export function why(s) {
  const by = new Map()
  for (const { file, rule } of s.why) { if (!by.has(rule)) by.set(rule, new Set()); by.get(rule).add(file) }
  return [...by].map(([rule, fs_]) => {
    const f = [...fs_]
    return rule === '(the suite itself)' ? 'itself' : `${rule} (${f[0]}${f.length > 1 ? ` +${f.length - 1}` : ''})`
  }).join(', ')
}

// --- git -----------------------------------------------------------------------------------------------------------

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
  if (r.status !== 0 && !opts.ok) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`)
  return r.status === 0 ? r.stdout : null
}

export function parseRange(range) {
  const m = /^(.+?)(\.\.\.?)(.+)$/.exec(range || '')
  if (!m) return null
  return { base: m[1], head: m[3] }
}

export function changedFiles(repo, base, head) {
  const mb = git(repo, ['merge-base', base, head]).trim()
  const files = git(repo, ['diff', '--name-only', '--no-renames', mb, head]).split('\n').filter(Boolean)
  return { mergeBase: mb, files }
}

// --- running -------------------------------------------------------------------------------------------------------

// {old-template}: the template a project upgrades from. Lifecycle's conflict step needs template/site/package.json
// to differ between old and new; a range that does not touch it would give no conflict. So: the base, when its
// package.json differs from the head's; else the newest commit before the head's last change of that file (its
// first parent). Returns { ref, why }; ref is the base when the file has no history (nothing better to pick).
export const CONFLICT_FILE = 'template/site/package.json'
export function oldTemplateRef(repo, base, head, file = CONFLICT_FILE) {
  const blob = (c) => git(repo, ['rev-parse', '--verify', '--quiet', `${c}:${file}`], { ok: true })?.trim() || null
  const hb = blob(head)
  if (blob(base) !== hb) return { ref: base, why: `the base (${file} differs from the head's)` }
  const last = git(repo, ['log', '-1', '--format=%H', head, '--', file], { ok: true })?.trim()
  const before = last && git(repo, ['rev-parse', '--verify', '--quiet', `${last}~1^{commit}`], { ok: true })?.trim()
  if (!before) return { ref: base, why: `the base (${file} has no earlier version)` }
  return { ref: before, why: `${before.slice(0, 7)}, the commit before ${last.slice(0, 7)} (the head's last change of ${file}; the base has the same one)` }
}

const strip = (s) =>s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
// the counts a suite prints: its "ok" and "FAIL" lines (the tests' own check helpers)
export function counts(log) {
  let ok = 0, fail = 0
  for (const l of strip(log).split('\n')) {
    if (/^\s*ok\b/.test(l)) ok++
    else if (/^\s*FAIL\b/.test(l)) fail++
  }
  return { ok, fail }
}

const interp = (p) => p.endsWith('.mjs') || p.endsWith('.js') ? ['node'] : p.endsWith('.ts') ? ['bun'] : ['bash']

// run one command into a log file (appending); resolves {code, secs}
function runTo(cmd, args, { cwd, env, log, timeout }) {
  return new Promise((done) => {
    const fd = fs.openSync(log, 'a')
    const t0 = Date.now()
    let child
    try { child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: true }) } catch (e) {
      fs.writeSync(fd, `gates: cannot start ${cmd}: ${e.message}\n`); fs.closeSync(fd); return done({ code: 127, secs: 0 })
    }
    let timedOut = false
    const timer = timeout ? setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch {} ; setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 10000) }, timeout * 1000) : null
    child.on('error', (e) => fs.writeSync(fd, `gates: ${cmd}: ${e.message}\n`))
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer)
      if (timedOut) fs.writeSync(fd, `\ngates: timed out after ${timeout}s\n`)
      fs.closeSync(fd)
      done({ code: timedOut ? 124 : code ?? (sig ? 128 : 1), secs: (Date.now() - t0) / 1000 })
    })
  })
}

// --- the heavy lock ------------------------------------------------------------------------------------------------

export const defaultLock = () => process.env.MM_GATES_LOCK || path.join(os.homedir(), '.cache', 'mm-gates', 'heavy.lock')

// a process's start (field 22 of /proc/<pid>/stat, clock ticks since boot) and state; '' where not known
function procStat(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), f = s.slice(s.lastIndexOf(')') + 2).split(' '); return { state: f[0] || '', start: f[19] || '' } } catch { return { state: '', start: '' } }
}
export const procStart = (pid) => procStat(pid).start
// the holder still runs: its pid is there (not a zombie) and started when the holder wrote it
export function holderAlive(h) {
  const pid = Number(h?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (e) { if (e.code !== 'EPERM') return false }
  const now = procStat(pid)
  return now.state !== 'Z' && (!h.start || !now.start || String(h.start) === now.start)
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '?' : d.toISOString().replace(/\.\d+Z$/, 'Z') }
export const waitLine = (h) => h ? `gates: waits for the heavy lock, held by ${h.label || '?'} pid ${h.pid ?? '?'} since ${fmtTime(h.since)}` : 'gates: waits for the heavy lock, held by an unknown holder'

// heavyLock({file, mode, label, say, poll}) -> { mode, acquire(): Promise<release()> }. One acquire at a time per lock
// object (the heavy lanes of a run already run one suite at a time).
export function heavyLock({ file = defaultLock(), mode = process.env.MM_GATES_LOCK_MODE, label = '?', say = () => {}, poll = 250 } = {}) {
  if (!mode) mode = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0 ? 'flock' : 'mkdir'
  if (mode !== 'flock' && mode !== 'mkdir') throw new Error(`MM_GATES_LOCK_MODE: flock or mkdir, not "${mode}"`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const me = () => ({ label, pid: process.pid, start: procStart(process.pid), since: new Date().toISOString() })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  if (mode === 'flock') {
    // a helper holds the lock: flock runs `cat` on our stdin pipe; closing it (or our death) releases the lock
    const hold = (wait) => new Promise((done, fail) => {
      const c = spawn('flock', ['-x', ...(wait ? [] : ['-n']), file, 'sh', '-c', 'echo held; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] })
      let held = false
      c.stdout.on('data', (d) => { if (!held && String(d).includes('held')) { held = true; done(c) } })
      c.on('error', fail)
      c.on('close', (code) => { if (!held) wait ? fail(new Error(`flock ${file}: exit ${code}`)) : done(null) })
    })
    return {
      mode, file,
      async acquire() {
        let c = await hold(false)
        if (!c) { say(waitLine(readJson(file))); c = await hold(true) }
        fs.writeFileSync(file, JSON.stringify(me()) + '\n') // the inode stays: the lock is on it, not on its content
        return async () => { const gone = new Promise((r) => c.once('close', r)); c.stdin.end(); await gone }
      },
    }
  }

  // mkdir: <file>.d, made whole (with its holder file) under another name and renamed into place
  const dir = file + '.d', brk = file + '.break'
  const tryTake = () => {
    const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    fs.mkdirSync(tmp); fs.writeFileSync(path.join(tmp, 'holder'), JSON.stringify(me()) + '\n')
    try { fs.renameSync(tmp, dir); return true } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true })
      if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(e.code)) return false
      throw e
    }
  }
  const age = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs } catch { return 0 } }
  const remove = (p) => { const t = `${p}.gone-${process.pid}-${crypto.randomBytes(4).toString('hex')}`; try { fs.renameSync(p, t) } catch { return false } fs.rmSync(t, { recursive: true, force: true }); return true }
  // a holder that is gone: take it away, under <file>.break so that two runs never both break (and one the new lock)
  const breakStale = (h) => {
    try { fs.mkdirSync(brk) } catch (e) { if (e.code === 'EEXIST' && age(brk) > 30_000) fs.rmSync(brk, { recursive: true, force: true }); return false }
    try {
      const now = readJson(path.join(dir, 'holder'))
      if (JSON.stringify(now) !== JSON.stringify(h)) return false // it changed hands meanwhile
      if (now ? holderAlive(now) : age(dir) < 30_000) return false
      say(`gates: takes the heavy lock over from ${now?.label || 'an unknown holder'} pid ${now?.pid ?? '?'} (no longer running)`)
      return remove(dir)
    } finally { fs.rmSync(brk, { recursive: true, force: true }) }
  }
  // the waiters queue in <file>.q (one ticket each, oldest first), so a run that gives the lock back and wants it
  // again for its next suite goes behind the run that waited; a ticket whose run is gone is dropped
  const q = file + '.q'
  let mine = null, ticket = null
  process.on('exit', () => {
    if (ticket) fs.rmSync(ticket, { force: true })
    if (mine && JSON.stringify(readJson(path.join(dir, 'holder'))) === mine) remove(dir)
  })
  const first = () => {
    for (const e of fs.readdirSync(q).sort()) {
      const t = path.join(q, e), h = readJson(t)
      if (h ? holderAlive(h) : age(t) < 30_000) return t
      fs.rmSync(t, { force: true })
    }
    return null
  }
  return {
    mode, file: dir,
    async acquire() {
      fs.mkdirSync(q, { recursive: true })
      ticket = path.join(q, `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(8, '0')}-${crypto.randomBytes(4).toString('hex')}`)
      fs.writeFileSync(ticket, JSON.stringify(me()) + '\n')
      let said = false
      try {
        for (;;) {
          if (first() === ticket && tryTake()) break
          const h = readJson(path.join(dir, 'holder'))
          if (fs.existsSync(dir) && !(h ? holderAlive(h) : age(dir) < 30_000) && breakStale(h)) continue
          if (!said && h) { say(waitLine(h)); said = true }
          await sleep(poll)
        }
      } finally { fs.rmSync(ticket, { force: true }); ticket = null }
      mine = JSON.stringify(readJson(path.join(dir, 'holder')))
      return async () => { if (JSON.stringify(readJson(path.join(dir, 'holder'))) === mine) remove(dir); mine = null }
    },
  }
}

// the hermetic suites at once by default: half the CPUs (2 to 6), and no more than the idle CPUs when the machine is
// busy: max(1, CPUs - the 1-minute load average)
export function defaultJobs(cpus = os.cpus().length, load = os.loadavg()[0]) {
  return Math.max(1, Math.min(Math.max(2, Math.min(6, Math.floor(cpus / 2))), Math.floor(cpus - load)))
}

// a pool of n workers over the items, in order
async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

function parseArgs(argv) {
  const o = { list: false, noLive: false, keep: false, jobs: defaultJobs(), timeout: 1800 }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v }
    if (a === '--list') o.list = true
    else if (a === '--no-live') o.noLive = true
    else if (a === '--keep') o.keep = true
    else if (a === '--out') o.out = val()
    else if (a === '--item') o.item = val()
    else if (a === '--bin') o.bin = val()
    else if (a === '--map') o.map = val()
    else if (a === '--jobs') o.jobs = Number(val())
    else if (a === '--timeout') o.timeout = Number(val())
    else if (a === '-h' || a === '--help') o.help = true
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
    else rest.push(a)
  }
  if (rest.length > 1) throw new Error(`one range only (got ${rest.join(' ')})`)
  o.range = rest[0]
  if (!Number.isInteger(o.jobs) || o.jobs < 1) throw new Error('--jobs: a whole number from 1')
  return o
}

const usage = 'usage: test/gates <base>..<head> [--list] [--out <file>] [--item <id>] [--no-live] [--bin <mm>] [--jobs <n>] [--keep]'

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const say = (s = '') => stdout.write(s + '\n')
  const warn = (s) => stderr.write(`gates: ${s}\n`)
  let o
  try { o = parseArgs(argv) } catch (e) { warn(e.message); warn(usage); return 2 }
  if (o.help) { say(usage); return 0 }
  const range = parseRange(o.range)
  if (!range) { warn(usage); return 2 }
  const repo = git(cwd, ['rev-parse', '--show-toplevel'], { ok: true })?.trim()
  if (!repo) { warn(`not in a git repo: ${cwd}`); return 2 }
  let base, head
  try {
    base = git(repo, ['rev-parse', '--verify', '--quiet', `${range.base}^{commit}`]).trim()
    head = git(repo, ['rev-parse', '--verify', '--quiet', `${range.head}^{commit}`]).trim()
  } catch { warn(`not a commit range of this repo: ${o.range}`); return 2 }
  const short = head.slice(0, 7)
  const { mergeBase, files } = changedFiles(repo, base, head)

  // the map: --map, else the head's own, else this checkout's (a head from before the map)
  let mapText, mapFrom
  if (o.map) { mapText = fs.readFileSync(o.map, 'utf8'); mapFrom = o.map }
  else {
    mapText = git(repo, ['show', `${head}:test/gates.map`], { ok: true })
    mapFrom = `test/gates.map at ${short}`
    if (mapText == null) {
      const own = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gates.map')
      mapText = fs.readFileSync(own, 'utf8'); mapFrom = `${own} (the head has no test/gates.map)`
    }
  }
  const map = parseMap(mapText)
  if (map.errors.length) { for (const e of map.errors) warn(`${mapFrom}: ${e}`); return 2 }
  // the range changes the map itself: the base's map chooses too (selectBoth), unless --map names one
  let baseMap = null
  if (!o.map && files.includes('test/gates.map')) {
    const t = git(repo, ['show', `${mergeBase}:test/gates.map`], { ok: true })
    if (t != null) {
      baseMap = parseMap(t)
      if (baseMap.errors.length) { for (const e of baseMap.errors) warn(`test/gates.map at ${mergeBase.slice(0, 7)} (the base): ${e}`); return 2 }
      mapFrom += ` and at ${mergeBase.slice(0, 7)} (the base's: this range changes the map)`
    }
  }
  const sel = baseMap ? selectBoth(map, baseMap, files) : select(map, files)
  const skipLive = (s) => o.noLive && s.group === 'live'

  if (o.list) {
    say(`gates ${o.range}: ${files.length} file(s) changed since ${mergeBase.slice(0, 7)}, ${sel.suites.length} suite(s); map: ${mapFrom}`)
    say('')
    say('files -> rules:')
    const w = Math.min(60, Math.max(10, ...sel.files.map((f) => f.file.length)))
    for (const f of sel.files) {
      const none = f.rules.length && f.rules.every((g) => map.rules.find((r) => r.glob === g)?.targets.every((t) => t === '-'))
      say(`  ${f.file.padEnd(w)}  ${f.rules.join(', ')}${none ? '  (no suite)' : ''}`)
    }
    say('')
    say('suites (in run order):')
    const sw = Math.max(10, ...sel.suites.map((s) => s.path.length))
    for (const s of sel.suites) {
      say(`  ${s.group.padEnd(8)}  ${s.path.padEnd(sw)}  <- ${why(s)}${skipLive(s) ? '   [skipped: --no-live]' : ''}`)
    }
    if (!sel.suites.length) say('  (none)')
    return 0
  }

  // --- the run ---
  const outFile = path.resolve(cwd, o.out || `gates-${short}.txt`)
  const logDir = outFile.replace(/\.txt$/, '') + '.logs'
  fs.rmSync(logDir, { recursive: true, force: true })
  fs.mkdirSync(logDir, { recursive: true })
  const T = fs.mkdtempSync(path.join(os.tmpdir(), `gates-${short}-`))
  const wt = path.join(T, 'head')
  const prepLog = path.join(logDir, '_prepare.log')
  const note = (s) => fs.appendFileSync(prepLog, `== ${s}\n`)
  const results = []
  let mmNote = 'not needed'
  let viaWorktree = false
  const t0 = new Date()
  say(`gates ${o.range}: ${sel.suites.length} suite(s) on ${short}; logs in ${logDir}`)
  for (const s of sel.suites.filter(skipLive)) results.push({ suite: s.path, group: s.group, status: 'skipped', note: '--no-live', secs: 0, log: '-' })

  try {
    // the head's content, never the caller's checkout
    note(`git worktree add --detach ${wt} ${head}`)
    const pfd = fs.openSync(prepLog, 'a')
    viaWorktree = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', wt, head], { stdio: ['ignore', pfd, pfd] }).status === 0
    fs.closeSync(pfd)
    if (!viaWorktree) {
      note(`no worktree; a shared clone instead`)
      fs.rmSync(wt, { recursive: true, force: true })
      const c = spawnSync('git', ['clone', '-q', '--shared', '--no-checkout', repo, wt], { encoding: 'utf8' })
      const k = c.status === 0 && spawnSync('git', ['-C', wt, 'checkout', '-q', '--detach', head], { encoding: 'utf8' })
      if (!k || k.status !== 0) throw new Error(`cannot check out ${short}: ${(c.stderr || k?.stderr || '').trim()}`)
    }

    const toRun = sel.suites.filter((s) => !skipLive(s))
    const env = { ...process.env }
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
    const step = async (name, cmd, args, cwd2 = wt, extraEnv = {}) => {
      note(`${name}: ${cmd} ${args.join(' ')}`)
      const r = await runTo(cmd, args, { cwd: cwd2, env: { ...env, ...extraEnv }, log: prepLog, timeout: 1200 })
      if (r.code !== 0) throw new Error(`${name} failed (exit ${r.code}; ${prepLog})`)
    }
    // what the suites need, each step once; a failed step fails the suites that need it (the others still run)
    const failedPrep = new Map() // suite path -> reason
    const prep = async (name, suites, fn) => {
      if (!suites.length) return
      try { await fn() } catch (e) { for (const s of suites) if (!failedPrep.has(s.path)) failedPrep.set(s.path, e.message) }
    }
    const uses = (s, ph) => s.args.some((a) => a.includes(ph))
    const needMm = toRun.filter((s) => uses(s, '{mm}') || s.needs.includes('mm'))
    await prep('packages', toRun, async () => {
      if (fs.existsSync(path.join(wt, 'package.json'))) await step('packages', 'bun', ['install', '--frozen-lockfile'])
      if (fs.existsSync(path.join(wt, 'scripts', 'pack-template.ts'))) await step('pack the template', 'bun', ['scripts/pack-template.ts'])
    })
    const needSite = toRun.filter((s) => s.needs.includes('site'))
    await prep('site', needSite, async () => {
      const site = path.join(wt, 'template', 'site')
      await step('the site\'s packages', 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], site)
      await step('build the site', 'npm', ['run', 'build'], site)
    })
    let mmBin = null
    await prep('mm', needMm, async () => {
      if (o.bin) { mmBin = path.resolve(cwd, o.bin); if (!fs.existsSync(mmBin)) throw new Error(`--bin ${o.bin}: no such file`); mmNote = `--bin ${mmBin}` }
      else {
        mmBin = path.join(T, 'bin', 'mm')
        await step('build mm', 'bun', ['build', 'src/cli.ts', '--compile', '--outfile', mmBin])
        mmNote = `built from ${short} (${mmBin}${o.keep ? '' : ', removed after'})`
      }
    })
    const mmDir = path.join(T, 'mmdir')
    if (mmBin) { fs.mkdirSync(mmDir, { recursive: true }); fs.symlinkSync(mmBin, path.join(mmDir, 'mm')) }
    const tools = {}
    await prep('bd + dolt', toRun.filter((s) => uses(s, '{bd}') || uses(s, '{dolt}')), async () => {
      for (const t of ['bd', 'dolt']) tools[t] = process.env[`GATES_${t.toUpperCase()}`] || await fetchTool(wt, t, T, note, step)
    })
    let oldTpl = null
    await prep('old template', toRun.filter((s) => uses(s, '{old-template}')), async () => {
      const d = path.join(T, 'old'); fs.mkdirSync(d)
      const pick = oldTemplateRef(repo, mergeBase, head)
      note(`old template: ${pick.why}`)
      say(`gates: old template: ${pick.why}`)
      const a = spawnSync('sh', ['-c', `git -C "$1" archive "$2" template | tar -x -C "$3"`, 'sh', repo, pick.ref, d], { encoding: 'utf8' })
      if (a.status !== 0) throw new Error(`git archive ${pick.ref.slice(0, 7)} template: ${a.stderr.trim()}`)
      oldTpl = path.join(d, 'template')
    })
    const fill = (a) => a.replaceAll('{mm}', mmBin || '').replaceAll('{bd}', tools.bd || '').replaceAll('{dolt}', tools.dolt || '').replaceAll('{old-template}', oldTpl || '')

    const runOne = async (s) => {
      const log = path.join(logDir, s.path.replace(/^test\//, '').replace(/\//g, '_') + '.log')
      const r = { suite: s.path, group: s.group, log }
      results.push(r)
      if (failedPrep.has(s.path)) { fs.writeFileSync(log, `gates: not run: ${failedPrep.get(s.path)}\n`); return Object.assign(r, { status: 'failed', note: 'not prepared', secs: 0 }) }
      if (!fs.existsSync(path.join(wt, s.path))) { fs.writeFileSync(log, `gates: ${s.path} is not in ${short}\n`); return Object.assign(r, { status: 'failed', note: 'not in the head', secs: 0 }) }
      const args = s.args.map(fill)
      const extra = s.needs.includes('site') ? { BOARD_PHONE_NOBUILD: '1' } : {} // the site is built once, above
      if (mmBin && (s.needs.includes('mm') || uses(s, '{mm}'))) extra.MM_BIN_DIR = mmDir
      fs.writeFileSync(log, `# gates: ${[...interp(s.path), s.path, ...args].join(' ')}   (in the worktree of ${short}, group ${s.group})\n`)
      const x = await runTo(interp(s.path)[0], [s.path, ...args], { cwd: wt, env: { ...env, ...extra }, log, timeout: o.timeout })
      const c = counts(fs.readFileSync(log, 'utf8'))
      Object.assign(r, { status: x.code === 0 ? 'passed' : 'failed', code: x.code, secs: x.secs, ...c })
      say(`  ${r.status.padEnd(6)}  ${s.group.padEnd(8)}  ${s.path}  (${x.secs.toFixed(0)}s)`)
    }
    const lane = (g) => toRun.filter((s) => s.group === g)
    // the heavy groups: one suite at a time across every gates run (the heavy lock), taken per suite
    let lock = null
    const heavy = async (s) => {
      if (failedPrep.has(s.path) || !fs.existsSync(path.join(wt, s.path))) return runOne(s) // nothing to run: no lock
      lock ||= heavyLock({ label: o.item || o.range, say })
      const release = await lock.acquire()
      try { await runOne(s) } finally { await release() }
    }
    await Promise.all([pool(lane('hermetic'), o.jobs, runOne), pool(lane('ports'), 1, runOne), pool(lane('docker'), 1, heavy)])
    await pool(lane('live'), 1, heavy)
  } catch (e) {
    warn(e.message)
    for (const s of sel.suites) if (!results.some((r) => r.suite === s.path)) results.push({ suite: s.path, group: s.group, status: 'failed', note: 'not run: ' + e.message, secs: 0, log: prepLog })
  } finally {
    if (o.keep) say(`kept: ${T}`)
    else {
      if (viaWorktree) { spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]); spawnSync('git', ['-C', repo, 'worktree', 'prune']) }
      fs.rmSync(T, { recursive: true, force: true })
    }
  }

  // --- the result file ---
  const order = new Map(sel.suites.map((s, i) => [s.path, i]))
  results.sort((a, b) => order.get(a.suite) - order.get(b.suite))
  const subject = git(repo, ['log', '-1', '--format=%s', head]).trim()
  const failed = results.filter((r) => r.status === 'failed')
  const passed = results.filter((r) => r.status === 'passed')
  const skipped = results.filter((r) => r.status === 'skipped')
  const verdict = failed.length ? 'failed' : skipped.length ? 'passed (live skipped: --no-live)' : 'passed'
  const sw = Math.max(10, ...results.map((r) => r.suite.length))
  const lines = [
    `head: ${head} ${subject}`,
    `range: ${o.range} (${base.slice(0, 7)}..${short}, merge base ${mergeBase.slice(0, 7)}, ${files.length} file(s) changed)`,
    `date: ${t0.toISOString()}`,
    `map: ${mapFrom}`,
    `mm: ${mmNote}`,
    `result: ${verdict}: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped, of ${results.length}`,
    '',
    ...results.map((r) => {
      const st = r.status === 'skipped' ? `skipped (${r.note})` : r.note ? `${r.status} (${r.note})` : r.status === 'failed' && r.code != null ? `failed (exit ${r.code})` : r.status
      const ct = r.ok != null && (r.ok || r.fail) ? `${r.ok} ok, ${r.fail} FAIL` : '-'
      return [r.suite.padEnd(sw), r.group.padEnd(8), st.padEnd(20), ct.padEnd(16), `${Math.round(r.secs)}s`.padStart(6), r.log].join('  ')
    }),
  ]
  fs.writeFileSync(outFile, lines.join('\n') + '\n')
  say(`result: ${verdict}; ${outFile}`)
  if (o.item) {
    const which = spawnSync('sh', ['-c', 'command -v artifact'], { encoding: 'utf8' })
    if (which.status === 0) {
      const a = spawnSync('artifact', [o.item, outFile], { encoding: 'utf8' })
      if (a.status === 0) say(`artifact: on ${o.item}${a.stdout.trim() ? ': ' + a.stdout.trim() : ''}`)
      else warn(`artifact ${o.item} ${outFile} failed: ${(a.stderr || a.stdout).trim()}`)
    } else say(`artifact: not on PATH; the result file is not on ${o.item}`)
  }
  return failed.length ? 1 : 0
}

// the release template/tools.json pins (as bin/init installs it): the download's sha256, then the binary's
export async function fetchTool(wt, t, T, note, step) {
  const pin = JSON.parse(fs.readFileSync(path.join(wt, 'template', 'tools.json'), 'utf8'))[t]
  const plat = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const p = pin?.[plat]
  if (!p?.url) throw new Error(`template/tools.json has no ${t} for ${plat}`)
  const d = path.join(T, 'tools', t); fs.mkdirSync(d, { recursive: true })
  const tgz = path.join(d, 'release.tgz')
  await step(`download ${t}`, 'curl', ['-fsSL', '-o', tgz, p.url], d)
  const sum = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  // review sy-v47f #3: no pin, no run; a binary that is not the pinned one fails too (as bin/init would refuse it)
  if (!p.sha256) throw new Error(`template/tools.json pins no sha256 for ${t} (${plat}): not run unchecked`)
  if (sum(tgz) !== p.sha256) throw new Error(`${t}: the download's checksum is not the pinned one`)
  await step(`extract ${t}`, 'tar', ['-xzf', tgz, '-C', d, p.extract], d)
  const bin = path.join(d, p.extract)
  if (p.installed_sha256 && sum(bin) !== p.installed_sha256) throw new Error(`${t}: the extracted binary is not the pinned one (installed_sha256)`)
  fs.chmodSync(bin, 0o755)
  return bin
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`gates: ${e.stack || e}\n`); process.exit(2) })
}
