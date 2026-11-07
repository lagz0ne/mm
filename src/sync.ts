// mm sync: the machine's backup in the human's private mastermind repo (docs/restore.md). Everything in it is sealed to
// the vault's two recipients, except the vault's own exportable files (already sealed), MANIFEST and a README.
// The checkout lives at $MM_HOME/state/mastermind. Plaintext never lands there: each file is sealed from memory.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { getPath, held, loadConfig, saveConfig, setPath } from './config'
import { DIRS, HOME, run } from './env'
import { expand, machineInputs } from './inputs'
import { boxish, boxRecord, engineRefusal, listProjects, readAnswers } from './project'
import * as vault from './vault'
import { jobArgs, landed } from './box'
import pkg from '../package.json'

type Step = { step: string; status: 'ok' | 'fail' | 'skip'; detail: string }
export const CHECKOUT = join(DIRS.mm, 'state', 'mastermind')
const STATE = join(DIRS.mm, 'state', 'mastermind.json') // path -> fingerprint of what was sealed there (local only)
const ID = '[a-z][a-z0-9-]{0,30}'
/** What may be in mastermind, and nothing else (the pre-commit hook in the checkout checks the same). */
export const ALLOW = new RegExp(`^(MANIFEST|README\\.md|config\\.yaml\\.age|vault/(recipients\\.txt|digests\\.txt|[a-z][a-z0-9_.-]{1,63}\\.age)|brain/repo\\.bundle\\.age|system/(config\\.bundle|board\\.tar)\\.age|projects/${ID}/${ID}/(config\\.bundle|code\\.bundle|board\\.tar|box\\.json)\\.age)$`)
const SECRET_KEY = 'AGE-SECRET-KEY-'
const AGE_HEADER = 'age-encryption.org/v1\n'
const sha = (b: Buffer | Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const tl = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
const short = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 200)
const git = (args: string[], env?: Record<string, string>) => run(['git', '-C', CHECKOUT, ...args], { env: { ...sshEnv(), ...env }, timeoutMs: 600_000 })

export const remote = () => String(getPath(loadConfig(), 'mastermind.remote') || '')
const branch = () => String(getPath(loadConfig(), 'mastermind.branch') || 'main')
/** git over ssh with the deploy key (a path; mm never reads the key itself). Local remotes need none. */
function sshEnv(): Record<string, string> {
  const key = expand(String(machineInputs()['mastermind-deploy-key']?.path || ''))
  return key && existsSync(key) ? { GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes` } : {}
}

const HOOK = `#!/bin/sh
# installed by mm sync: mastermind takes only its allowlist, and never an age secret key
ALLOW='${ALLOW.source}'
git diff --cached --name-only --diff-filter=ACMR -z | tr '\\0' '\\n' | {
  bad=0
  while IFS= read -r f; do
    printf '%s\\n' "$f" | grep -Eq "$ALLOW" || { echo "mastermind: $f is not on the allowlist" >&2; bad=1; }
    if git show ":$f" | grep -qaF '${SECRET_KEY}'; then echo "mastermind: $f holds an age secret key" >&2; bad=1; fi
  done
  exit $bad
}
`
const README = `# mastermind

This machine's backup, written by \`mm sync\`. Every \`.age\` file is sealed to the machine's vault key and the owner's
recovery key; only the recovery key's holder can restore from it (\`mm restore\`, docs/restore.md in mm).
MANIFEST lists each file's sha256. Restore applies a commit only if it carries the owner's signed tag, or the owner
types its hash.
`

/** `mm sync init <remote>`: clone mastermind into the checkout and remember where it is. */
export function init(url: string): Step[] {
  if (!url || /\s/.test(url)) throw new Error('give the mastermind repo, e.g. git@github.com:<you>/mastermind.git')
  if (existsSync(join(CHECKOUT, '.git'))) {
    const have = git(['remote', 'get-url', 'origin']).out.trim()
    if (have !== url) throw new Error(`${tl(CHECKOUT)} already syncs to ${have}`)
  } else {
    mkdirSync(dirname(CHECKOUT), { recursive: true, mode: 0o700 })
    const c = run(['git', 'clone', '-q', url, CHECKOUT], { env: sshEnv(), timeoutMs: 600_000 })
    if (!c.ok) throw new Error(`clone failed: ${short(c)}`)
  }
  chmodSync(CHECKOUT, 0o700)
  git(['config', 'user.name', 'mm sync']); git(['config', 'user.email', 'mm-sync@mastermind.invalid'])
  writeFileSync(join(CHECKOUT, '.git', 'hooks', 'pre-commit'), HOOK, { mode: 0o755 })
  const c = loadConfig(); setPath(c, 'mastermind.remote', url); saveConfig(c)
  return [{ step: 'init', status: 'ok', detail: `${url} -> ${tl(CHECKOUT)} (hook installed)` }]
}

type Board = { id: string; root: string; dir: string; box?: boolean; boxish?: boolean } // dir: where its files go in mastermind
/** The system board and every project that isn't a throwaway. */
export function boards(): Board[] {
  const out: Board[] = []
  if (existsSync(join(DIRS.system, '.mm-answers.yaml'))) out.push({ id: 'system', root: DIRS.system, dir: 'system' })
  for (const p of listProjects()) {
    if (p.throwaway || p.root === '?') continue
    const root = expand(p.root)
    try {
      const a = readAnswers(root)
      if (a.profile === 'system') continue
      out.push({ id: a.project, root, dir: `projects/${a.client}/${a.name}`, ...(a.box ? { box: true } : {}), ...(boxish(root) ? { boxish: true } : {}) })
    } catch {}
  }
  return out
}

/** A repo's fingerprint: its refs (a bundle of the same refs holds the same history). A box's repos: read in the box
 *  (the box can write its .git, so the host runs no git on it; review sy-b15.6 2-3). */
const refsOf = (dir: string, box?: Board) => box
  ? sha(run(jobArgs(box.root, 'refs', `git -C '${dir}' for-each-ref --format='%(objectname) %(refname)'; git -C '${dir}' symbolic-ref -q HEAD`, {})).out)
  : sha(run(['git', '-C', dir, 'for-each-ref', '--format=%(objectname) %(refname)']).out + run(['git', '-C', dir, 'symbolic-ref', '-q', 'HEAD']).out)

/** board: the board whose backup it comes from. One board's failure keeps all of that board's files as they were in
 *  mastermind (never half a new one), and the others still go (sy-bey8). Items without a board fail the whole run. */
type Item = { path: string; from: string; fp: () => string; bytes: () => Buffer | Uint8Array; plain?: boolean; board?: string }
/** What mastermind should hold now. Board items need a fresh backup (made lazily, once per board). */
function plan(work: string, steps: Step[]): Item[] {
  const items: Item[] = []
  if (existsSync(DIRS.config)) items.push({ path: 'config.yaml.age', from: tl(DIRS.config), fp: () => sha(readFileSync(DIRS.config)), bytes: () => readFileSync(DIRS.config) })
  for (const f of existsSync(DIRS.vault) ? readdirSync(DIRS.vault).filter(vault.exportable).sort() : []) {
    const src = join(DIRS.vault, f)
    items.push({ path: `vault/${f}`, from: tl(src), fp: () => sha(readFileSync(src)), bytes: () => readFileSync(src), plain: true }) // sealed already
  }
  if (existsSync(join(DIRS.brain, '.git'))) {
    items.push({ path: 'brain/repo.bundle.age', from: `${tl(DIRS.brain)} (git bundle --all)`, fp: () => refsOf(DIRS.brain), bytes: () => bundle(DIRS.brain) })
  }
  for (const b of boards()) {
    let bk = '' // the board's fresh backup folder
    const backup = () => {
      if (bk) return bk
      const dest = join(work, b.id)
      if (b.box) { // its backup runs in the box and lands in the machine's backups folder (as the nightly one); copy it
        const r = run(jobArgs(b.root, 'backup', join(b.root, 'bin', 'backup'), { MM_PROJECT: b.id }), { timeoutMs: 900_000 })
        if (!r.ok) throw new Error(`${b.id}: bin/backup in the box failed: ${short(r)}`)
        // the newest folder it landed, by path (sy-0z58: never by splitting landBackup's text); Doop's data is in it
        const l = landed(b.root)
        steps.push({ step: `backup ${b.id}`, status: 'ok', detail: `in the box; ${l.newest.split('/').pop()}${l.doop === 'yes' ? ', with doop' : l.doop === 'skipped' ? ', doop skipped' : ''}` })
        return (bk = l.newest)
      }
      // a project that was a box: its bin/ runs on the host only if it is mm's engine (review sy-b15.6 follow-up 2)
      const no = engineRefusal(b.root); if (no) throw new Error(`${b.id}: bin/backup not run: ${no}`)
      const r = run([join(b.root, 'bin', 'backup')], { cwd: b.root, env: { BACKUP_DIR: dest }, timeoutMs: 900_000 })
      const made = existsSync(dest) ? readdirSync(dest).filter((d) => d.startsWith('20')).sort().pop() : undefined
      if (!r.ok || !made) throw new Error(`${b.id}: bin/backup failed: ${short(r)}`)
      steps.push({ step: `backup ${b.id}`, status: 'ok', detail: r.out.trim().split('\n').pop()?.replace(work, '<work>') || 'done' })
      return (bk = join(dest, made))
    }
    const board = b.id
    items.push({ board, path: `${b.dir}/config.bundle.age`, from: `${tl(b.root)} (config repo)`, fp: () => refsOf(b.root, b.box ? b : undefined), bytes: () => readFileSync(join(backup(), 'config.bundle')) })
    if (existsSync(join(b.root, 'code', '.git')))
      items.push({ board, path: `${b.dir}/code.bundle.age`, from: `${tl(join(b.root, 'code'))} (product repo)`, fp: () => refsOf(join(b.root, 'code'), b.box ? b : undefined), bytes: () => readFileSync(join(backup(), 'code.bundle')) })
    items.push({
      board, path: `${b.dir}/board.tar.age`, from: `${b.id} board (Dolt backup + JSONL + releases)`,
      fp: () => { const d = backup(); return sha(readFileSync(join(d, 'board.jsonl')) + (existsSync(join(d, 'releases')) ? readFileSync(join(d, 'releases'), 'utf8') : '')) },
      bytes: () => { const d = backup(); return tarOf(d, ['board.dolt', 'board.jsonl', ...(existsSync(join(d, 'releases')) ? ['releases'] : [])]) },
    })
    // a box (or a project that was one): the backup above is the box's own, so the host adds its own record, made from
    // the host's disk: restore takes the privilege files from it, and restores a recorded box as a box (sy-b15.19)
    if (b.boxish) {
      let rec: Buffer | undefined
      const bytes = () => (rec ??= Buffer.from(JSON.stringify(boxRecord(b.root), null, 1)))
      items.push({ board, path: `${b.dir}/box.json.age`, from: `${b.id}: the host's record of a box (its privilege files, engine seal, template base)`, fp: () => sha(bytes()), bytes })
    }
  }
  return items
}
function bundle(dir: string): Uint8Array {
  const p = Bun.spawnSync(['git', '-C', dir, 'bundle', 'create', '-q', '-', '--all'], { stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git bundle ${tl(dir)}: ${p.stderr.toString().trim().slice(0, 200)}`)
  return p.stdout
}
function tarOf(dir: string, names: string[]): Uint8Array {
  const p = Bun.spawnSync(['tar', '-cf', '-', '-C', dir, ...names], { stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`tar ${names.join(' ')}: ${p.stderr.toString().trim().slice(0, 200)}`)
  return p.stdout
}

/** Every file in the checkout (not .git), relative. */
function files(): string[] {
  const out: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { if (f === '.git' && d === CHECKOUT) continue; const p = join(d, f); statSync(p).isDirectory() ? walk(p) : out.push(relative(CHECKOUT, p)) } }
  walk(CHECKOUT); return out.sort()
}
/** The checkout's rails: only the allowlist, every .age really sealed, no age secret key anywhere. */
export function refusals(): string[] {
  const bad: string[] = []
  for (const f of files()) {
    const b = readFileSync(join(CHECKOUT, f))
    if (!ALLOW.test(f)) bad.push(`${f}: not on the allowlist`)
    if (b.includes(SECRET_KEY)) bad.push(`${f}: holds an age secret key`)
    if (f.endsWith('.age') && !b.subarray(0, AGE_HEADER.length).equals(Buffer.from(AGE_HEADER))) bad.push(`${f}: not an age file`)
  }
  return bad
}

export type SyncOpts = { dryRun?: boolean; push?: boolean; fresh?: boolean; force?: boolean }
/**
 * Bring mastermind up to date: seal what changed since the last sync, drop what's gone (an archived project), write
 * MANIFEST, commit, push. A file is resealed only when its source changed (age output differs on every run, so
 * resealing everything would grow the repo by a full copy each hour). A board whose backup fails keeps its last files
 * there; the rest is committed and pushed, then the run fails, naming it (sy-bey8).
 */
export function sync(o: SyncOpts = {}): { steps: Step[]; ok: boolean; commit?: string } {
  const steps: Step[] = [], fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return { steps, ok: false } }
  if (!existsSync(join(CHECKOUT, '.git'))) return fail('checkout', `no mastermind checkout yet: mm sync init <repo> (${tl(CHECKOUT)})`)
  if (held()) return fail('hold', 'this box is a restore on hold: it must not write to mastermind while the old box may still be up (mm restore --release)')
  if (!vault.ready()) return fail('vault', 'no vault on this machine yet (mm vault init): mastermind is sealed to its recipients')
  if (o.fresh && !o.force) return fail('fresh', `--fresh replaces mastermind's whole history on ${remote()} (${branch()}) with one new commit. It's a t2 step: add --force once it's approved.`)
  const dirty = git(['status', '--porcelain']).out.trim()
  if (dirty && !o.fresh) return fail('checkout', `${tl(CHECKOUT)} has changes mm didn't commit:\n${dirty.slice(0, 400)}`)
  writeFileSync(join(CHECKOUT, '.git', 'hooks', 'pre-commit'), HOOK, { mode: 0o755 })

  mkdirSync(join(DIRS.mm, 'state'), { recursive: true, mode: 0o700 })
  const work = mkdtempSync(join(DIRS.mm, 'state', 'sync-work-')) // fresh backups (plaintext, like ~/.mm/backups): removed below
  chmodSync(work, 0o700)
  const start = git(['symbolic-ref', '-q', '--short', 'HEAD']).out.trim() || branch()
  const undo = () => { if (o.fresh) git(['checkout', '-qf', start]); git(['reset', '-q', '--hard']); git(['clean', '-fdq']) } // back to the last commit
  // boards whose backup failed: the rest is committed and pushed, then the run says which and is not ok (sy-bey8)
  const failed: string[] = []
  const done = (r: { ok: boolean; commit?: string }) => {
    if (failed.length) steps.push({ step: 'failed', status: 'fail', detail: `not backed up: ${failed.join(', ')} (see backup <board> above; the rest went in)` })
    return { steps, ...r, ok: r.ok && !failed.length }
  }
  try {
    const items = plan(work, steps)
    if (o.dryRun) { for (const i of items) steps.push({ step: 'plan', status: 'ok', detail: `${i.path} <- ${i.from}` }); return { steps, ok: true } }
    let prev: Record<string, string> = {}
    try { prev = JSON.parse(readFileSync(STATE, 'utf8')) } catch {}
    if (o.fresh) {
      const r = git(['checkout', '-q', '--orphan', `mm-fresh-${Date.now()}`])
      if (!r.ok) return fail('fresh', short(r))
      git(['rm', '-rq', '--cached', '--ignore-unmatch', '.'])
      prev = {}
    }
    const want = new Set(items.map((i) => i.path).concat('MANIFEST', 'README.md')), next: Record<string, string> = {}
    for (const f of files()) if (!want.has(f)) { rmSync(join(CHECKOUT, f)); steps.push({ step: 'drop', status: 'ok', detail: f }) }
    let sealed = 0, kept = 0
    // a board's items go together (sy-bey8): each is sealed to a staged file, and they move in only when all of that
    // board's made it. A board whose backup fails keeps what mastermind has of it; the other boards still go.
    const groups: Item[][] = []
    for (const i of items) { const g = groups[groups.length - 1]; if (i.board && g?.[0].board === i.board) g.push(i); else groups.push([i]) }
    for (const g of groups) {
      const board = g[0].board, fps: Record<string, string> = {}, staged: [to: string, out: string][] = []
      let k = 0
      try {
        for (const i of g) {
          const out = join(CHECKOUT, i.path), fp = i.fp()
          fps[i.path] = fp
          if (prev[i.path] === fp && existsSync(out)) { k++; continue }
          mkdirSync(dirname(out), { recursive: true })
          const to = board ? `${out}.mm-new` : out
          staged.push([to, out])
          if (i.plain) writeFileSync(to, i.bytes(), { mode: 0o600 }); else vault.sealTo(i.bytes(), to)
        }
      } catch (e) {
        if (!board) throw e
        for (const [to] of staged) { rmSync(to, { force: true }); rmSync(`${to}.tmp-${process.pid}`, { force: true }) }
        // what mastermind has of it stays, with the fingerprint it was sealed from: the next run seals it again
        let had = 0
        for (const i of g) if (existsSync(join(CHECKOUT, i.path))) { had++; if (prev[i.path]) next[i.path] = prev[i.path] }
        const m = (e as Error).message, why = m.startsWith(`${board}: `) ? m.slice(board.length + 2) : m
        failed.push(board)
        steps.push({ step: `backup ${board}`, status: 'fail', detail: `${why.split('\n')[0]} (${had ? 'mastermind keeps its last backup' : 'none in mastermind yet'})` })
        continue
      }
      for (const [to, out] of staged) if (to !== out) renameSync(to, out)
      Object.assign(next, fps); sealed += staged.length; kept += k
    }
    steps.push({ step: 'seal', status: 'ok', detail: `${sealed} sealed, ${kept} unchanged` })
    writeFileSync(join(CHECKOUT, 'README.md'), README)
    const sums = files().filter((f) => f !== 'MANIFEST' && f !== 'README.md').map((f) => `${sha(readFileSync(join(CHECKOUT, f)))}  ${f}`)
    const manifest = `# mastermind: sha256 of each file (mm sync)\nmm ${pkg.version}\n${sums.join('\n')}\n`
    const old = existsSync(join(CHECKOUT, 'MANIFEST')) ? readFileSync(join(CHECKOUT, 'MANIFEST'), 'utf8') : ''
    if (old.replace(/^mm .*$/m, '') !== manifest.replace(/^mm .*$/m, '') || o.fresh) writeFileSync(join(CHECKOUT, 'MANIFEST'), manifest)

    const bad = refusals()
    if (bad.length) { undo(); return fail('refuse', `nothing committed: ${bad.join('; ')}`) }
    git(['add', '-A'])
    if (!o.fresh && !git(['status', '--porcelain']).out.trim()) {
      writeFileSync(STATE, JSON.stringify(next, null, 1), { mode: 0o600 })
      steps.push({ step: 'commit', status: 'skip', detail: 'nothing changed' })
      return done({ ok: true, commit: git(['rev-parse', 'HEAD']).out.trim() })
    }
    const when = new Date().toISOString().slice(0, 16) + 'Z'
    const c = git(['commit', '-q', '-m', o.fresh ? `fresh start ${when} (mm ${pkg.version})` : `sync ${when}`])
    if (!c.ok) { undo(); return fail('commit', short(c)) } // the hook's refusal lands here too
    writeFileSync(STATE, JSON.stringify(next, null, 1), { mode: 0o600 })
    const head = git(['rev-parse', 'HEAD']).out.trim()
    steps.push({ step: 'commit', status: 'ok', detail: `${head.slice(0, 12)} (${git(['show', '--stat', '--format=', 'HEAD']).out.trim().split('\n').pop()?.trim()})` })
    if (o.fresh) git(['branch', '-M', branch()])
    if (o.push === false) { steps.push({ step: 'push', status: 'skip', detail: '--no-push' }); return done({ ok: true, commit: head }) }
    const p = git(['push', '-q', ...(o.fresh ? ['--force'] : []), 'origin', `HEAD:refs/heads/${branch()}`])
    steps.push(p.ok ? { step: 'push', status: 'ok', detail: `${remote()} ${branch()}${o.fresh ? ' (history replaced)' : ''}` } : { step: 'push', status: 'fail', detail: short(p) })
    return done({ ok: p.ok, commit: head })
  } catch (e) {
    undo(); return fail('sync', (e as Error).message)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
