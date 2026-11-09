// mm ship <sha> --item <id>: one rollout per signed head (sy-sbjh step 5). Ops runs it. In order, and it stops at the
// first thing that is not right:
//   1. the checks: <sha> is on mm's main; the board item that carries it is signed off for that head (signed-off,
//      signed-head:mm@<sha>), and on a t2 item approved for that head too (approved-head:mm@<sha>, sy-6gz6's rule);
//      a gates file for that head that passed (artifacts/<id>/gates-<sha7>.txt). The board is read through its bd;
//      mm ship never writes a label.
//   2. the build: <builds>/<sha>/ (mm, its template/ and mm.sha256, the stamp), made once from a clean worktree of
//      <sha>; never dist/mm. <builds> is $MM_BUILDS, else $MM_HOME/builds: test/gates' cache too. A cached build counts
//      only when its mm's sha256 is its stamp's; else it is built again. mm ship never prunes the cache.
//   3. a dry run on every board (mm update --dry-run, with that build): a conflict stops it, naming the board and file.
//   4. each board in turn: the build it replaces is kept as <builds>/previous; mm update (umask 022); then mm inspect
//      shows the new template version and mm obs errors shows no new error. A failed check stops the rollout and prints
//      the one-line rollback; nothing is rolled back by itself.
//   5. one comment per board on the item (bd, as the role that runs it).
// --dry-run: steps 1 to 3 only.
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { getPath, loadConfig } from './config'
import { DIRS, run, tilde } from './env'
import { gatesVerdict, parseSignedHead } from '../template/bin/lib/gates-file.mjs'
import { approvalRefusal, APPROVED_HEAD } from '../template/bin/lib/owner-card.mjs'

export interface ShipOpts { item: string; dryRun?: boolean; boards?: string[]; repo?: string }
type Say = (line: string) => void

/** The build cache, shared with test/gates: $MM_BUILDS, else $MM_HOME/builds, else ~/.mm/builds. */
export const BUILDS = () => process.env.MM_BUILDS ? resolve(process.env.MM_BUILDS) : join(DIRS.mm, 'builds')
/** A build's stamp: its mm's sha256 in `sha256sum -c` form, written when it is built (by mm ship or test/gates). */
export const BUILD_STAMP = 'mm.sha256'
/** The system board's bd (MM_SHIP_BD for a test), run in the board's folder. */
const BD = () => process.env.MM_SHIP_BD || join(DIRS.system, 'bin', 'bd')
const BOARD = () => process.env.MM_SHIP_BOARD_DIR || DIRS.system
const bd = (args: string[]) => run([BD(), ...args], { cwd: existsSync(BOARD()) ? BOARD() : undefined, timeoutMs: 60_000 })
const git = (repo: string, args: string[]) => run(['git', '-C', repo, ...args])
/** One sha names the other (one is the start of the other, 7 characters at least). */
const agree = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

/** mm's repo: --repo, else config ship.repo, else the source this mm runs from (bun src/cli.ts). */
export function mmRepo(given?: string): string | null {
  const c = given || String(getPath(loadConfig(), 'ship.repo') ?? '')
  if (c) return c.replace(/^~(?=\/)/, process.env.HOME || '')
  const src = join(import.meta.dir, '..')
  return existsSync(join(src, '.git')) ? src : null
}

/** The item's labels and description, read through bd; or the reason it can't be read. */
function readItem(id: string): { labels: string[]; description: string } | string {
  const r = bd(['show', id, '--json'])
  if (!r.ok) return `cannot read ${id} on the board (bd show: ${(r.err || r.out).trim().split('\n').pop()?.slice(0, 160) || `exit ${r.code}`})`
  try {
    const j = JSON.parse(r.out), i = Array.isArray(j) ? j[0] : j
    if (!i) return `no item ${id} on the board`
    return { labels: Array.isArray(i.labels) ? i.labels.map(String) : [], description: String(i.description ?? '') }
  } catch { return `cannot read ${id} on the board (bd show gave no JSON)` }
}

/** The gates file for sha on item id (gates-<sha7>.txt, or a gates-<sha>.txt that agrees): null when one passed, else why. */
export function gatesRefusal(board: string, id: string, sha: string, t2: boolean): string | null {
  const dir = join(board, 'artifacts', id), want = `artifacts/${id}/gates-${sha.slice(0, 7)}.txt`
  let listed: string[] = []
  try { listed = readdirSync(dir) } catch {}
  const names = [...new Set([`gates-${sha.slice(0, 7)}.txt`, ...listed.filter((n) => { const m = /^gates-([0-9a-f]{7,40})\.txt$/.exec(n); return !!m && agree(m[1], sha) }).sort((a, b) => b.length - a.length)])]
  let first: string | null = null
  for (const n of names) {
    const f = join(dir, n)
    try { if (!lstatSync(f).isFile()) continue } catch { continue }
    const why = gatesVerdict(readFileSync(f, 'utf8'), sha, { t2, file: `artifacts/${id}/${n}` })
    if (!why) return null
    first ??= why
  }
  return first ?? `no passing gates file for ${sha.slice(0, 7)}: no ${want} (test/gates <base>..${sha.slice(0, 7)} --item ${id} writes it)`
}

/** Step 1. The full sha when every check passes; else the refusal. */
export function checkHead(sha: string, o: ShipOpts): { sha: string; repo: string } | { refused: string } {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return { refused: `${sha} is not a commit sha (7 to 40 lowercase hex)` }
  if (!o.item) return { refused: 'name the board item that carries the head: --item <id>' }
  const repo = mmRepo(o.repo)
  if (!repo || !git(repo, ['rev-parse', '--git-dir']).ok) return { refused: `no mm repo to read main from${repo ? ` (${repo} is not a git repo)` : ''}: --repo <dir> or mm config set ship.repo <dir>` }
  const full = git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).out.trim()
  if (!full) return { refused: `${sha} is no commit of mm's repo` }
  if (!git(repo, ['rev-parse', '--verify', '--quiet', 'main^{commit}']).ok) return { refused: 'mm\'s repo has no main branch' }
  if (!git(repo, ['merge-base', '--is-ancestor', full, 'main']).ok) return { refused: `${full.slice(0, 7)} is not on main (not main, nor an ancestor of it): only a head that landed ships` }
  const item = readItem(o.item)
  if (typeof item === 'string') return { refused: item }
  const ls = item.labels, t2 = ls.includes('t2'), s7 = full.slice(0, 7)
  if (!ls.includes('signed-off')) return { refused: `${o.item} is not signed off (no signed-off label)` }
  const signed = ls.map(parseSignedHead).filter((h): h is { repo: string; sha: string } => !!h && h.repo === 'mm')
  if (!signed.some((h) => agree(h.sha, full))) return { refused: `${o.item} is not signed for mm@${s7} (${signed.length ? `signed: ${signed.map((h) => `mm@${h.sha.slice(0, 12)}`).join(', ')}` : 'no signed-head:mm@…'})` }
  if (t2) {
    const given = ls.filter((l) => l.startsWith(`${APPROVED_HEAD}mm@`)).map((l) => l.slice(`${APPROVED_HEAD}mm@`.length))
    if (!ls.includes('approved')) return { refused: `${o.item} is t2 and not approved (the owner's go comes first)` }
    if (!given.some((g) => agree(g, full))) return { refused: `${o.item} is t2 and its go is not for mm@${s7} (${given.length ? `approved-head: ${given.map((g) => `mm@${g.slice(0, 12)}`).join(', ')}` : `no ${APPROVED_HEAD}mm@…`}): a new go is needed` }
    const why = approvalRefusal(item.description, ls)
    if (why) return { refused: `${o.item} is t2 and its go does not count: ${why}` }
  }
  const g = gatesRefusal(BOARD(), o.item, full, t2)
  if (g) return { refused: `${o.item}: ${g}` }
  return { sha: full, repo }
}

const isBuild = (d: string) => { try { return statSync(join(d, 'mm')).isFile() && statSync(join(d, 'template')).isDirectory() } catch { return false } }

const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
/** A cached build that counts: mm, template/ and a stamp that is mm's sha256; else why it does not. */
export function checkBuild(dir: string): { sha256: string } | { why: string } {
  try { if (!statSync(join(dir, 'mm')).isFile()) return { why: 'its mm is not a file' } } catch { return { why: 'no mm' } }
  try { if (!statSync(join(dir, 'template')).isDirectory()) return { why: 'no template/' } } catch { return { why: 'no template/' } }
  let stamp: string
  try { stamp = readFileSync(join(dir, BUILD_STAMP), 'utf8').trim().split(/\s+/)[0] } catch { return { why: `no ${BUILD_STAMP}` } }
  const sum = sha256(join(dir, 'mm'))
  if (stamp !== sum) return { why: `its mm's sha256 (${sum.slice(0, 12)}) is not the stamp's (${stamp.slice(0, 12)})` }
  return { sha256: sum }
}

/** Step 2. <builds>/<sha>/ (mm + template/ + mm.sha256): the cached one when its stamp holds, else built once from a
 *  clean worktree of sha (in a temp folder, stamped, then renamed into place). */
export function buildFor(repo: string, sha: string, say: Say): { dir: string } | { refused: string } {
  const root = BUILDS(), dir = join(root, sha)
  const have = checkBuild(dir)
  if ('sha256' in have) { say(`build: cached ${tilde(dir)} (sha256 ${have.sha256.slice(0, 12)})`); return { dir } }
  if (existsSync(dir)) say(`build: ${tilde(dir)} does not count (${have.why}): built again`)
  mkdirSync(root, { recursive: true })
  const tag = () => `${sha.slice(0, 12)}-${process.pid}-${randomBytes(4).toString('hex')}`
  const tmp = join(root, `.tmp-${tag()}`), src = join(tmp, 'src')
  mkdirSync(tmp, { recursive: true })
  say(`build: ${sha.slice(0, 7)} from a clean worktree into ${tilde(dir)}`)
  const fail = (what: string, r: { err: string; out: string; code: number }) => {
    git(repo, ['worktree', 'remove', '--force', src]); rmSync(tmp, { recursive: true, force: true })
    return { refused: `build: ${what} failed (exit ${r.code}): ${(r.err || r.out).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` }
  }
  const steps: [string, string[], string?][] = [
    ['worktree', ['git', '-C', repo, 'worktree', 'add', '--detach', src, sha]],
    ['bun install', ['bun', 'install', '--frozen-lockfile'], src],
    ['pack', ['bun', 'scripts/pack-template.ts'], src],
    ['compile', ['bun', 'build', 'src/cli.ts', '--compile', '--outfile', join(tmp, 'mm')], src],
    ['template', ['sh', '-c', 'git -C "$1" archive "$2" template | tar -x -C "$3"', 'sh', repo, sha, tmp]],
  ]
  for (const [what, argv, cwd] of steps) { const r = run(argv, { cwd, timeoutMs: 15 * 60_000 }); if (!r.ok) return fail(what, r) }
  git(repo, ['worktree', 'remove', '--force', src]); rmSync(src, { recursive: true, force: true })
  if (!isBuild(tmp)) return fail('check', { err: 'no mm or template/ after the build', out: '', code: 1 })
  const sum = sha256(join(tmp, 'mm'))
  writeFileSync(join(tmp, BUILD_STAMP), `${sum}  mm\n`)
  if (existsSync(dir)) { // one that does not count: away first
    const old = join(root, `.old-${tag()}`)
    try { renameSync(dir, old); rmSync(old, { recursive: true, force: true }) } catch {}
  }
  try { renameSync(tmp, dir) } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    const other = checkBuild(dir) // another run (mm ship or test/gates) placed it meanwhile: that one
    if (!('sha256' in other)) return { refused: `build: cannot place it in ${tilde(dir)}: ${(e as Error).message}` }
    say(`build: cached ${tilde(dir)} (sha256 ${other.sha256.slice(0, 12)}; another run built it meanwhile)`)
    return { dir }
  }
  say(`build: built ${tilde(dir)} (sha256 ${sum.slice(0, 12)})`)
  return { dir }
}

/** The build the boards run now: <builds>/current (mm ship points it at each head it shipped), else none known. */
function currentBuild(): string | null {
  const c = join(BUILDS(), 'current')
  try { const t = readlinkSync(c); const d = t.startsWith('/') ? t : join(BUILDS(), t); return isBuild(d) ? d : null } catch { return null }
}
/** Keep the build being replaced as <builds>/previous (a copy: the cache of that sha may be pruned). */
function keepPrevious(cur: string | null, say: Say): string | null {
  const prev = join(BUILDS(), 'previous')
  if (!cur) { say(`rollback: no earlier build of mm ship known (${tilde(join(BUILDS(), 'current'))}); none kept`); return isBuild(prev) ? prev : null }
  if (basename(cur) === readFileSync0(join(prev, 'sha'))) return prev
  const tmp = `${prev}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  cpSync(cur, tmp, { recursive: true, preserveTimestamps: true })
  Bun.write(join(tmp, 'sha'), basename(cur))
  rmSync(prev, { recursive: true, force: true }); renameSync(tmp, prev)
  say(`rollback: kept ${basename(cur).slice(0, 7)} as ${tilde(prev)}`)
  return prev
}
const readFileSync0 = (f: string) => { try { return readFileSync(f, 'utf8').trim() } catch { return '' } }
function setCurrent(sha: string) {
  const c = join(BUILDS(), 'current'), tmp = `${c}.tmp-${process.pid}`
  rmSync(tmp, { force: true }); symlinkSync(sha, tmp); renameSync(tmp, c)
}

/** Run the build's mm (its template as MM_TEMPLATE_DIR), JSON out. umask 022 for a command that writes boards. */
function mmOf(build: string) {
  const env = { MM_TEMPLATE_DIR: join(build, 'template') }
  return (args: string[], o: { umask?: boolean } = {}) => {
    const argv = [join(build, 'mm'), '-o', 'json', ...args]
    return run(o.umask ? ['sh', '-c', 'umask 022 && exec "$@"', 'sh', ...argv] : argv, { env, timeoutMs: 30 * 60_000 })
  }
}
const json = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }
const lastLine = (r: { out: string; err: string; code: number }) => (r.err || r.out).trim().split('\n').pop()?.slice(0, 200) || `exit ${r.code}`

/** mm obs errors -p <project> --since 5m as keys and counts (a log's service+message, a span's service+op+why). */
function errorCounts(mm: ReturnType<typeof mmOf>, project: string): Map<string, number> | string {
  const r = mm(['obs', 'errors', '-p', project, '--since', '5m'])
  const j = json(r.out) as { logs?: Record<string, unknown>[]; spans?: Record<string, unknown>[] } | undefined
  if (!r.ok || !j) return `mm obs errors failed: ${lastLine(r)}`
  const m = new Map<string, number>()
  for (const x of j.logs || []) m.set(`log ${x.service} ${x._msg}`, Number(x.n) || 1)
  for (const x of j.spans || []) m.set(`span ${x['resource_attr:service.name']} ${x.name} ${x.status_message}`, Number(x.n) || 1)
  return m
}

/** mm ship: the whole rollout. Returns the exit code (0 shipped / dry run clean, 1 refused or stopped). */
export function ship(shaArg: string, o: ShipOpts, say: Say = console.log, err: Say = console.error): number {
  const h = checkHead(shaArg, o)
  if ('refused' in h) { err(`mm ship: refused: ${h.refused}`); return 1 }
  const sha = h.sha, s7 = sha.slice(0, 7)
  say(`checks: ${s7} is on main; ${o.item} signed for mm@${s7}; gates passed`)
  const b = buildFor(h.repo, sha, say)
  if ('refused' in b) { err(`mm ship: ${b.refused}`); return 1 }
  const mm = mmOf(b.dir)

  // the boards: --board, else every project mm ls lists (a throwaway one is left out)
  let boards = o.boards ?? []
  if (!boards.length) {
    const r = mm(['ls']), ls = json(r.out) as { project: string; throwaway?: boolean }[] | undefined
    if (!r.ok || !Array.isArray(ls)) { err(`mm ship: mm ls failed: ${lastLine(r)}`); return 1 }
    boards = ls.filter((p) => !p.throwaway).map((p) => p.project)
  }
  if (!boards.length) { err('mm ship: no board to update'); return 1 }

  // step 3: the dry run on every board, before any is touched
  const plan: { board: string; from: string; to: string }[] = []
  for (const board of boards) {
    const r = mm(['update', '--dry-run', board]), u = json(r.out) as { from?: string; to?: string; changed?: string[]; conflicts?: string[]; ok?: boolean } | undefined
    if (!u) { err(`mm ship: dry run on ${board} failed: ${lastLine(r)}`); return 1 }
    if (u.conflicts?.length) { err(`mm ship: stopped: the dry run on ${board} conflicts in ${u.conflicts.join(', ')}; nothing was updated`); return 1 }
    if (!r.ok || u.ok === false) { err(`mm ship: dry run on ${board} failed: ${lastLine(r)}`); return 1 }
    plan.push({ board, from: String(u.from), to: String(u.to) })
    say(`dry run: ${board} ${u.from} -> ${u.to} (${u.changed?.length ?? 0} file(s), no conflict)`)
  }
  if (o.dryRun) {
    say(`would update ${plan.length} board(s) with ${tilde(b.dir)}, each then checked: mm inspect shows the new template version, mm obs errors -p <board> --since 5m shows no new error`)
    return 0
  }

  // step 4: each board in turn
  const prev = keepPrevious(currentBuild(), say)
  const rollback = (board: string) => prev
    ? `MM_TEMPLATE_DIR=${tilde(join(prev, 'template'))} ${tilde(join(prev, 'mm'))} update ${board}`
    : `MM_TEMPLATE_DIR=<the template ${board} had> mm update ${board}   (no earlier build kept)`
  const note = (line: string) => {
    const r = bd(['comments', 'add', o.item, `NOTE → ops\nmm ship ${s7}: ${line}`])
    if (!r.ok) err(`mm ship: the comment on ${o.item} was not written (${lastLine(r)}): ${line}`)
  }
  for (const p of plan) {
    const before = mm(['inspect', p.board]), bj = json(before.out) as { project?: string; template_version?: string }[] | undefined
    const project = bj?.[0]?.project || p.board, old = bj?.[0]?.template_version || p.from
    const base = errorCounts(mm, project)
    const u = mm(['update', p.board], { umask: true }), uj = json(u.out) as { ok?: boolean; to?: string } | undefined
    const fails: string[] = []
    if (!u.ok || uj?.ok === false) fails.push(`mm update failed: ${lastLine(u)}`)
    const to = uj?.to || p.to
    const after = mm(['inspect', p.board]), aj = json(after.out) as { template_version?: string }[] | undefined, now = aj?.[0]?.template_version
    if (!after.ok || !aj) fails.push(`mm inspect failed: ${lastLine(after)}`)
    else if (now !== to) fails.push(`mm inspect shows template ${now}, not ${to}`)
    const errs = errorCounts(mm, project)
    if (typeof errs === 'string') fails.push(errs)
    else {
      const was = typeof base === 'string' ? new Map<string, number>() : base
      const fresh = [...errs].filter(([k, n]) => n > (was.get(k) ?? 0)).map(([k]) => k)
      if (fresh.length) fails.push(`mm obs errors: ${fresh.length} new: ${fresh.slice(0, 3).join('; ').slice(0, 200)}`)
    }
    const line = `${p.board} ${old} -> ${now || to}, checks ${fails.length ? `failed: ${fails.join('; ')}` : 'ok'}`
    say(`${fails.length ? 'FAIL' : 'ok  '} ${line}`)
    note(line)
    if (fails.length) {
      err(`mm ship: stopped at ${p.board}; later boards not updated. Nothing is rolled back by itself. Rollback:\n  ${rollback(p.board)}`)
      return 1
    }
  }
  setCurrent(sha)
  say(`shipped ${s7} to ${plan.length} board(s); rollback build: ${prev ? tilde(prev) : 'none'}`)
  return 0
}
