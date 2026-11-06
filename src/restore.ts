// mm restore <mastermind>: a whole machine from the human's mastermind repo onto a blank box (docs/restore.md).
// Part 2 of sy-240: trust, MANIFEST, unseal, lay the brain and every board's repos and board data out, reseal the
// vault to a new machine key. Nothing starts here; bringing the boards up (and the outward gate) is the next part.
// Plaintext only ever lives in memory or in a 0700 work folder under $MM_HOME/state, removed at the end.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { held, loadConfig, saveConfig, setPath, unsetPath } from './config'
import { DIRS, HOME, run } from './env'
import { install } from './install'
import { type Install, manifest } from './manifest'
import { onboard } from './onboard'
import { spanNote } from './obs'
import { pcRunning } from './pc'
import { BOX_RECORD_FILES, type BoxRecord, engineRefusal, hostGitEnv, installTools, processes, readAnswers, repairKernel, sealFile, templateRecFile, up, writeInProject } from './project'
import { ALLOW } from './sync'
import * as vault from './vault'

type Step = { step: string; status: 'ok' | 'fail' | 'skip'; detail: string }
const tl = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)
const short = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 200)
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex')
export const RESTORE_CHECKOUT = join(DIRS.mm, 'state', 'mastermind')

export type RestoreOpts = {
  identity: string            // the human's recovery identity: a file they name (read by age only, never copied)
  accept?: string             // the HEAD hash, typed by the human, to restore commits no signed tag covers
  allowedSigners?: string     // ssh allowed_signers for the human's tag key
  drill?: boolean             // a throwaway box: nothing outward-facing ever starts here
  dataOnly?: boolean          // stop once the data is in place (no onboard, nothing started)
}

/** Which commit to restore: the newest tag the human signed, or HEAD if they typed its hash. Lists what is unsigned. */
export function trust(dir: string, o: Pick<RestoreOpts, 'accept' | 'allowedSigners'>): { commit?: string; steps: Step[] } {
  const g = (a: string[]) => run(['git', '-C', dir, ...a], { timeoutMs: 120_000 })
  const steps: Step[] = [], h = g(['rev-parse', '-q', '--verify', 'HEAD^{commit}']), head = h.out.trim()
  if (!h.ok || !head) return { steps: [{ step: 'trust', status: 'fail', detail: 'mastermind has no commit on its branch (an empty repo, or HEAD names a branch that is not there)' }] }
  let signed: { tag: string; commit: string } | undefined
  if (o.allowedSigners) { // every tag is checked; of the valid ones, the one on the newest commit (most history) wins
    let depth = -1
    for (const tag of g(['tag']).out.trim().split('\n').filter(Boolean)) {
      const v = g(['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${o.allowedSigners}`, 'verify-tag', tag])
      if (!v.ok) { steps.push({ step: 'trust', status: 'skip', detail: `tag ${tag}: no valid signature from an allowed signer` }); continue }
      const commit = g(['rev-parse', `${tag}^{commit}`]).out.trim(), n = Number(g(['rev-list', '--count', commit]).out.trim())
      if (g(['merge-base', '--is-ancestor', commit, 'HEAD']).ok && n > depth) { signed = { tag, commit }; depth = n }
    }
  }
  if (signed) steps.push({ step: 'trust', status: 'ok', detail: `signed tag ${signed.tag} -> ${signed.commit.slice(0, 12)}` })
  const unsigned = g(['log', '--format=%h %ci %s', signed ? `${signed.commit}..HEAD` : 'HEAD']).out.trim()
  if (!unsigned) return { commit: signed!.commit, steps }
  const files = g(['diff', '--name-only', ...(signed ? [signed.commit, 'HEAD'] : ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'HEAD'])]).out.trim().split('\n').filter(Boolean)
  const what = `${unsigned.split('\n').length} unsigned commit(s) up to HEAD ${head.slice(0, 12)}, ${files.length} file(s): ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''}`
  if (o.accept && o.accept.length >= 12 && head.startsWith(o.accept.toLowerCase())) {
    steps.push({ step: 'trust', status: 'ok', detail: `${what}; accepted by the typed hash` }); return { commit: head, steps }
  }
  if (signed) { steps.push({ step: 'trust', status: 'ok', detail: `${what}: not applied (type --accept <HEAD hash> to include them)` }); return { commit: signed.commit, steps } }
  steps.push({ step: 'trust', status: 'fail', detail: `no signed tag; ${what}. Check them, then give --accept ${head}` })
  return { steps }
}

/** MANIFEST lists every file with its sha256, and nothing is off the allowlist. */
export function manifestOk(dir: string): string[] {
  const bad: string[] = [], listed = new Map<string, string>()
  for (const l of readFileSync(join(dir, 'MANIFEST'), 'utf8').split('\n')) { const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l); if (m) listed.set(m[2], m[1]) }
  const tracked = run(['git', '-C', dir, 'ls-files']).out.trim().split('\n').filter(Boolean)
  for (const f of tracked) {
    if (!ALLOW.test(f)) bad.push(`${f}: not on the allowlist`)
    if (f === 'MANIFEST' || f === 'README.md') continue
    const want = listed.get(f)
    if (!want) bad.push(`${f}: not in MANIFEST`)
    else if (sha(readFileSync(join(dir, f))) !== want) bad.push(`${f}: sha256 differs from MANIFEST`)
  }
  for (const f of listed.keys()) if (!tracked.includes(f)) bad.push(`${f}: in MANIFEST but missing`)
  return bad
}

const open = (file: string, identity: string): Uint8Array => {
  const r = spawnSync('age', ['-d', '-i', identity, file], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`${file.split('/').slice(-3).join('/')}: the recovery identity could not open it (${String(r.stderr).trim().slice(0, 120)})`)
  return r.stdout
}
/** No repo hook runs in what restore does itself (its checkouts and commits, and the board tools it runs): a bundle can
 *  carry a box's own ops/githooks (sy-b15.19). core.hooksPath is set only after the box record is applied and, for a
 *  box, its ops/ is mm's again (sy-atqr). */
const NO_HOOKS = { GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' }
/** restore's own git on a board: no hooks; for a box (as its answers now say), the host's hardened git (hostGitEnv). */
const restoreGit = (root: string) => { const h = hostGitEnv(root); return h.GIT_CONFIG_COUNT ? h : { ...h, ...NO_HOOKS } }

/** A repo from a bundle, with every branch as a local branch (not only the default one) and no remote left. */
function fromBundle(bundle: string, dir: string, who: { name: string; email: string }) {
  mkdirSync(dir, { recursive: true })
  const g = (a: string[]) => { const r = run(['git', '-C', dir, ...a], { env: NO_HOOKS, timeoutMs: 600_000 }); if (!r.ok) throw new Error(`${tl(dir)}: git ${a[0]}: ${short(r)}`); return r.out }
  g(['init', '-q', '-b', 'main'])
  g(['fetch', '-q', '--update-head-ok', bundle, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'])
  const heads = run(['git', 'bundle', 'list-heads', bundle]).out
  const headSha = /^([0-9a-f]{40}) HEAD$/m.exec(heads)?.[1]
  const onHead = [...heads.matchAll(/^([0-9a-f]{40}) refs\/heads\/(\S+)$/gm)].filter((m) => m[1] === headSha).map((m) => m[2])
  const head = onHead.includes('main') ? 'main' : onHead[0] || (/refs\/heads\/main$/m.test(heads) ? 'main' : /refs\/heads\/(\S+)/.exec(heads)?.[1] || 'main')
  g(['symbolic-ref', 'HEAD', `refs/heads/${head}`]); g(['checkout', '-qf']); g(['config', 'user.name', who.name]); g(['config', 'user.email', who.email])
}

/** The recovery public key recorded in mastermind, and the identity's own public key: they must be the same. */
function recoveryPublic(dir: string, identity: string): string {
  const lines = readFileSync(join(dir, 'vault', 'recipients.txt'), 'utf8').split('\n')
  const i = lines.findIndex((l) => /recovery key/.test(l)), rec = lines.slice(i + 1).find((l) => /^age1/.test(l))?.trim()
  if (i < 0 || !rec) throw new Error('mastermind vault/recipients.txt names no recovery key')
  const pub = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' })
  if (pub.status !== 0) throw new Error(`not an age identity: ${tl(identity)}`)
  if (pub.stdout.trim() !== rec) throw new Error('this identity is not the recovery key mastermind was sealed to')
  return rec
}

/**
 * Restore the machine's data from mastermind onto a blank box (`mm restore <repo>`). Refuses a box that already has
 * mm's state. The layout is always one-root: a restore is also how a legacy box moves.
 */
export async function restoreMachine(src: string, o: RestoreOpts): Promise<{ steps: Step[]; ok: boolean; boards: string[] }> {
  const seen: Seen = {}, r = await restoreRun(src, o, seen)
  if (!o.drill || !seen.blank) return r // a drill refused before it began (not a blank box) leaves that box's record alone
  const rec: DrillRecord = { at: new Date().toISOString(), ok: r.ok, data_only: !!o.dataOnly, mastermind: seen.commit ?? null, report: r.steps.map(reportLine) }
  try { writeDrillRecord(rec); r.steps.push({ step: 'drill record', status: 'ok', detail: `${tl(DRILL_RECORD)} (ok: ${rec.ok})` }) }
  catch (e) { r.steps.push({ step: 'drill record', status: 'fail', detail: `${tl(DRILL_RECORD)}: ${(e as Error).message}` }); r.ok = false }
  // the drill is one span: the command's own (cli.ts), with its outcome and its record (obs.ts spanNote)
  Object.assign(spanNote.attrs, { drill: true, drill_ok: r.ok, data_only: rec.data_only, mastermind: rec.mastermind ?? '', drill_record: DRILL_RECORD, outcome: r.ok ? 'drill passed' : 'drill failed' })
  return r
}

/** The last drill's result, for the brain's score (docs/restore.md, "The drill's record"). Names, counts and hashes
 *  only: the steps carry no value, and anything shaped like an age identity is cut anyway. */
export const DRILL_RECORD = join(DIRS.mm, 'state', 'drill.json')
export type DrillRecord = { at: string; ok: boolean; data_only: boolean; mastermind: string | null; report: string[] }
type Seen = { blank?: boolean; commit?: string }
const reportLine = (s: Step) => {
  const l = `${s.status} ${s.step}: ${s.detail}`.replace(/AGE-SECRET-KEY-1[0-9A-Z]+|AGE-PLUGIN-[A-Z0-9-]+1[0-9A-Z]+/gi, '[cut]')
  return l.length > 300 ? `${l.slice(0, 299)}…` : l
}
/** Written whole: a fresh 0600 temp file next to it (never through a link), renamed over the old one; its folder 0700. */
export function writeDrillRecord(r: DrillRecord, file = DRILL_RECORD) {
  const dir = dirname(file); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
  const tmp = `${file}.${process.pid}.tmp`; rmSync(tmp, { force: true })
  try { writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); chmodSync(tmp, 0o600); renameSync(tmp, file) }
  catch (e) { rmSync(tmp, { force: true }); throw e }
}

async function restoreRun(src: string, o: RestoreOpts, seen: Seen): Promise<{ steps: Step[]; ok: boolean; boards: string[] }> {
  const fail = (step: string, detail: string) => ({ steps: [{ step, status: 'fail' as const, detail }], ok: false, boards: [] as string[] })
  // sy-suk 2: moving the machine's secrets is the human's (T3). An agent may run only a drill (test keys, nothing out).
  const inAgent = !!(process.env.CLAUDECODE || process.env.PASEO_AGENT_ID)
  if (inAgent && !o.drill) return fail('agent', 'a restore opens the recovery key and every secret: run it yourself at a terminal, not from an agent (only --drill with test keys may run in one)')
  if (o.identity) return restoreWith(src, o, seen)
  if (inAgent) return fail('identity', 'give --identity <file>: the hidden prompt is for a human at a terminal')
  let file = ''
  try { file = promptIdentity() } catch (e) { return fail('identity', (e as Error).message) }
  try { return await restoreWith(src, { ...o, identity: file }, seen) } finally { rmSync(file, { force: true }) }
}

/** The recovery identity, typed (or pasted) at the terminal with no echo, into a 0600 file in a memory-backed folder
 *  that lives only while restore runs. Never argv, never env, never on disk. */
function promptIdentity(): string {
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') } catch { throw new Error('no terminal for the hidden prompt: give --identity <file>') }
  let line = ''
  try {
    writeSync(fd, 'Paste your recovery identity (the AGE-SECRET-KEY-1… line; nothing shows): ')
    spawnSync('sh', ['-c', 'stty -echo </dev/tty'])
    const b = Buffer.alloc(512), n = readSync(fd, b, 0, 512, null); line = b.subarray(0, n).toString().trim(); b.fill(0)
  } finally { spawnSync('sh', ['-c', 'stty echo </dev/tty']); writeSync(fd, '\n'); closeSync(fd) }
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(line) && !/^AGE-PLUGIN-[A-Z0-9-]+1[0-9A-Z]+$/.test(line)) throw new Error('that is not an age identity line')
  const dir = vault.secretsBase(); mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!vault.isTmpfs(dir)) throw new Error(`${dir} is not memory-backed: refusing to hold the identity there (name a tmpfs in vault.secrets_dir, or give --identity <file>)`)
  const f = join(dir, `.restore-identity-${process.pid}`); writeFileSync(f, `${line}\n`, { mode: 0o600 }); line = ''
  return f
}

async function restoreWith(src: string, o: RestoreOpts, seen: Seen): Promise<{ steps: Step[]; ok: boolean; boards: string[] }> {
  const steps: Step[] = [], boards: string[] = []
  const fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return { steps, ok: false, boards } }
  const there = [DIRS.config, DIRS.brain, DIRS.system, DIRS.projects, join(DIRS.vault, 'key'), join(HOME, 'projects'), join(HOME, 'brain')].filter(existsSync)
  if (there.length) return fail('blank box', `this box already has mm's state (${there.map(tl).join(', ')}): restore only onto a blank box`)
  seen.blank = true
  if (!o.identity || !existsSync(o.identity)) return fail('identity', 'the recovery identity file is not there; it is read by age only, never copied')

  // a blank box has no age yet, and everything in mastermind is sealed: the signed distro package first (the manifest)
  if (!run(['sh', '-c', 'command -v age && command -v age-keygen']).ok) {
    try { steps.push({ step: 'age', status: 'ok', detail: await install('age', (manifest.machine.tools as Record<string, { install: Install }>).age.install) }) }
    catch (e) { return fail('age', `age is needed to open mastermind: ${(e as Error).message}`) }
  }
  mkdirSync(dirname(RESTORE_CHECKOUT), { recursive: true, mode: 0o700 })
  if (!existsSync(join(RESTORE_CHECKOUT, '.git'))) {
    const c = run(['git', 'clone', '-q', src, RESTORE_CHECKOUT], { timeoutMs: 900_000 })
    if (!c.ok) return fail('clone', short(c))
  }
  chmodSync(RESTORE_CHECKOUT, 0o700)
  // the remote's HEAD may name a branch mm sync never pushed (a bare repo made with another default): take mastermind.branch's
  if (!run(['git', '-C', RESTORE_CHECKOUT, 'rev-parse', '-q', '--verify', 'HEAD^{commit}']).ok)
    for (const b of ['main', 'master']) if (run(['git', '-C', RESTORE_CHECKOUT, 'checkout', '-q', '-B', b, `origin/${b}`]).ok) break
  const t = trust(RESTORE_CHECKOUT, o); steps.push(...t.steps)
  if (!t.commit) return { steps, ok: false, boards }
  seen.commit = t.commit
  const co = run(['git', '-C', RESTORE_CHECKOUT, 'checkout', '-q', '--detach', t.commit])
  if (!co.ok) return fail('checkout', short(co))
  const bad = manifestOk(RESTORE_CHECKOUT)
  if (bad.length) return fail('manifest', bad.join('; '))
  steps.push({ step: 'manifest', status: 'ok', detail: `${t.commit.slice(0, 12)}: every file matches` })

  const M = RESTORE_CHECKOUT, work = mkdtempSync(join(DIRS.mm, 'state', 'restore-work-')); chmodSync(work, 0o700)
  try {
    const rec = recoveryPublic(M, o.identity)
    // 1. config.yaml (always one-root: this process already runs with one-root paths on a blank box)
    const cfg = Buffer.from(open(join(M, 'config.yaml.age'), o.identity)).toString('utf8')
    const layout = /^layout:\s*["']?([\w-]+)/m.exec(cfg)?.[1]
    writeFileSync(DIRS.config, cfg, { mode: 0o600 })
    // the hold goes in before anything can start: nothing outward-facing until the human says the old box is down
    const c = loadConfig(); setPath(c, 'layout', 'one-root'); setPath(c, 'restore', { hold: true, drill: !!o.drill, from: t.commit, at: new Date().toISOString() }); saveConfig(c)
    chmodSync(DIRS.config, 0o600)
    steps.push({ step: 'config', status: 'ok', detail: `${tl(DIRS.config)}${layout && layout !== 'one-root' ? ` (was ${layout}; now one-root)` : ''}; restore hold on` })
    // 2. the vault: the sealed files, then a new machine key; everything resealed to it and the recovery key
    mkdirSync(DIRS.vault, { recursive: true, mode: 0o700 }); chmodSync(DIRS.vault, 0o700)
    for (const f of readdirSync(join(M, 'vault'))) if (vault.exportable(f) && f !== 'recipients.txt') { copyFileSync(join(M, 'vault', f), join(DIRS.vault, f)); chmodSync(join(DIRS.vault, f), 0o600) }
    const names = vault.resealWith(o.identity, rec)
    steps.push({ step: 'vault', status: 'ok', detail: `new machine key; ${names.length} secret(s) resealed to it and the recovery key` })
    // 3. the brain (its migrations are root: the human applies them)
    const unseal = (rel: string) => { const f = join(work, rel.replace(/\//g, '_').replace(/\.age$/, '')); writeFileSync(f, open(join(M, rel), o.identity), { mode: 0o600 }); return f }
    if (existsSync(join(M, 'brain', 'repo.bundle.age'))) {
      fromBundle(unseal('brain/repo.bundle.age'), DIRS.brain, { name: 'brain', email: 'brain@localhost' })
      steps.push({ step: 'brain', status: 'ok', detail: `${tl(DIRS.brain)} (its migrations are yours to apply: they run as root)` })
    }
    // 4. every board: config repo, product repo, board data staged in <root>/.restore for the board's first start
    const dirs = [...(existsSync(join(M, 'system')) ? ['system'] : []), ...(existsSync(join(M, 'projects')) ? readdirSync(join(M, 'projects')).flatMap((c) => readdirSync(join(M, 'projects', c)).map((n) => `projects/${c}/${n}`)) : [])]
    for (const d of dirs) {
      const root = d === 'system' ? DIRS.system : join(DIRS.projects, ...d.split('/').slice(1))
      fromBundle(unseal(`${d}/config.bundle.age`), root, { name: 'mm', email: 'mm@localhost' })
      // a box's bundle is the box's own history: the host's record (mm sync) decides its privilege files and whether it
      // is a box, over whatever the box committed (sy-b15.19)
      const rec = existsSync(join(M, d, 'box.json.age')) ? applyBoxRecord(root, Buffer.from(open(join(M, d, 'box.json.age'), o.identity)).toString('utf8')) : null
      const a = Bun.YAML.parse(readFileSync(join(root, '.mm-answers.yaml'), 'utf8')) as { project: string; root?: string; box?: boolean }
      run(['git', '-C', root, 'config', 'user.email', `mm@${a.project}.local`])
      const commit: string[] = rec ? [...rec.files] : []
      if (a.root && a.root !== root) { // the answers name the old box's folder: point them here
        writeInProject(root, '.mm-answers.yaml', readFileSync(join(root, '.mm-answers.yaml'), 'utf8').replace(/^root:.*$/m, `root: ${root}`))
        commit.push('.mm-answers.yaml')
      }
      if (commit.length) { // restore's own commit: no repo hook runs (a box's bundle can carry its own)
        const g = (args: string[]) => run(['git', '-C', root, ...args], { env: { SETUP_HUMAN: '1', ...restoreGit(root) } })
        // -A: what the kernel check removed goes too (a path neither on disk nor in git would fail the whole add)
        const paths = [...new Set(commit)].filter((p) => existsSync(join(root, p)) || g(['ls-files', '--', p]).out.trim())
        const ad = g(['add', '-A', '--', ...paths]); if (!ad.ok) throw new Error(`${d}: git add: ${short(ad)}`)
        if (!g(['diff', '--cached', '--quiet']).ok) {
          const c = g(['commit', '-q', '-m', rec ? `mm restore: the host's record of this box over its own history${a.root && a.root !== root ? '; root on this box' : ''}` : 'mm restore: root on this box'])
          if (!c.ok) throw new Error(`${d}: commit: ${short(c)}`)
        }
      }
      // the repo's hooks only now, after the check: for a box, its ops/ is mm's again (repairKernel), so it keeps the
      // governance pre-commit for the commits made in it, as mm new --box sets it; the host's own git on a box still
      // runs no hook (hostGitEnv; review sy-atqr)
      if (existsSync(join(root, 'ops', 'githooks'))) run(['git', '-C', root, 'config', 'core.hooksPath', 'ops/githooks'])
      if (existsSync(join(M, d, 'code.bundle.age'))) fromBundle(unseal(`${d}/code.bundle.age`), join(root, 'code'), { name: 'mm', email: `mm@${a.project}.local` })
      const stage = join(root, '.restore'); mkdirSync(stage, { recursive: true, mode: 0o700 })
      const x = run(['tar', '-xf', unseal(`${d}/board.tar.age`), '-C', stage], { timeoutMs: 600_000 })
      if (!x.ok) throw new Error(`${d}: board data: ${short(x)}`)
      const items = existsSync(join(stage, 'board.jsonl')) ? readFileSync(join(stage, 'board.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
      boards.push(a.project)
      steps.push({ step: `board ${a.project}`, status: 'ok', detail: `${tl(root)}: config${existsSync(join(root, 'code', '.git')) ? ' + product' : ''} repo, board data staged (${items} record(s))${rec ? `; ${rec.detail}` : ''}` })
    }
    if (o.dataOnly) { steps.push({ step: 'start', status: 'skip', detail: '--data-only: data in place; nothing started' }); return { steps, ok: true, boards } }

    // 5. the machine (tools, process manager, observability), then each board, inward only (the hold)
    const ob = await onboard({ yes: true })
    const missing = ob.checks.filter((x) => (x as { status?: string }).status === 'fail').map((x) => (x as { item?: string }).item).filter(Boolean)
    if (!pcRunning()) return fail('onboard', 'the process manager is not running after onboard (mm doctor)')
    steps.push({ step: 'onboard', status: 'ok', detail: missing.length ? `done; still missing (yours: mm needs): ${missing.join(', ')}` : 'done' })
    const report: string[] = []
    for (const project of boards) {
      const root = findBoard(project)
      const r = await bringUp(root, work); steps.push(...r.steps)
      report.push(`${project}: ${r.items}/${r.expected} item record(s)${r.ready ? ', board answers' : ', board NOT ready'}`)
      if (!r.ok) return { steps, ok: false, boards }
    }
    // 6. the drill's checks: every sealed input opens (to memory only); then the report
    const opened = vault.list().filter((x) => { try { vault.canOpen(x.name); return true } catch { return false } })
    steps.push({ step: 'secrets', status: opened.length === vault.list().length ? 'ok' : 'fail', detail: `${opened.length}/${vault.list().length} sealed input(s) open with the new machine key (to memory only)` })
    // the teardown (sy-4in 2), checked rather than assumed: unsealed copies gone, nothing opened left in the tmpfs
    rmSync(work, { recursive: true, force: true })
    const base = vault.secretsBase(), inBase = existsSync(base) ? readdirSync(base) : []
    const mine = inBase.filter((f) => f.startsWith('.restore-identity-') && f !== `.restore-identity-${process.pid}`) // the prompt's own file goes when restore returns
    const held = inBase.filter((f) => !f.startsWith('.')).flatMap((d) => { try { return readdirSync(join(base, d)).map((f) => `${d}/${f}`) } catch { return [] } })
    steps.push({ step: 'teardown', status: !existsSync(work) && !mine.length ? 'ok' : 'fail', detail: `unsealed copies removed: ${!existsSync(work) ? 'yes' : `no (${tl(work)})`}; stray identity files: ${mine.length || 'none'}; values opened by running services (tmpfs, gone at reboot): ${held.length ? held.join(', ') : 'none'}` })
    steps.push({ step: 'report', status: steps.some((x) => x.status === 'fail') ? 'fail' : 'ok', detail: report.join('; ') })
    steps.push({ step: 'hold', status: 'skip', detail: o.drill ? 'drill box: nothing outward-facing starts here, ever (no public routes, no leads, no sync)' : 'on: once the old box is down (or this is a move), run `mm restore --release` yourself' })
    return { steps, ok: !steps.some((x) => x.status === 'fail'), boards }
  } catch (e) {
    return fail('restore', (e as Error).message)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * A box project's record from mastermind (sy-b15.19). mm sync made it on the old machine's host, from the host's disk,
 * never from the box's backup. Its privilege files replace what the box's bundle checked out; a recorded box is a box
 * whatever its own answers said; the host's seal of its engine and its mm-template record go back where mm keeps them.
 * Returns the files to commit.
 */
function applyBoxRecord(root: string, text: string): { files: string[]; detail: string } {
  const r = JSON.parse(text) as BoxRecord
  if (!r || typeof r !== 'object' || !r.files || typeof r.files !== 'object' || !/^[a-z][a-z0-9-]{0,62}$/.test(String(r.project))) throw new Error(`${tl(root)}: the box record is not one mm sync made`)
  const odd = Object.keys(r.files).filter((f) => !BOX_RECORD_FILES.includes(f))
  if (odd.length) throw new Error(`${tl(root)}: the box record names ${odd.join(', ')}, not a privilege file`)
  // never through a link the bundle checked out: each file goes to a fresh name, renamed over the old one
  for (const [f, b64] of Object.entries(r.files)) writeInProject(root, f, Buffer.from(String(b64), 'base64'))
  const af = join(root, '.mm-answers.yaml'), at = readFileSync(af, 'utf8'), ans = Bun.YAML.parse(at) as { project?: string; box?: boolean }
  if (ans.project !== r.project) throw new Error(`${tl(root)}: the box record is for ${r.project}, but the answers name ${ans.project}`)
  if (r.box && ans.box !== true) writeInProject(root, '.mm-answers.yaml', `${at.replace(/^box:.*\n?/m, '').trimEnd()}\nbox: true\n`)
  const hd = dirname(sealFile(r.project)); mkdirSync(hd, { recursive: true, mode: 0o755 })
  if (r.engine) writeFileSync(sealFile(r.project), JSON.stringify(r.engine, null, 2))
  if (r.template) writeFileSync(templateRecFile(r.project), JSON.stringify(r.template, null, 2))
  // mm-template back on the commit mm recorded, when the bundle has it (else mm update refuses, and says why; sy-055t)
  const c = String(r.template?.commit || ''), env = restoreGit(root)
  const base = !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c) ? ''
    : run(['git', '-C', root, 'cat-file', '-e', `${c}^{commit}`], { env }).ok && run(['git', '-C', root, 'update-ref', 'refs/heads/mm-template', c], { env }).ok
      ? `, mm-template at ${c.slice(0, 12)}` : `, mm-template: the recorded ${c.slice(0, 12)} is not in the bundle`
  // its kernel (ops/: the git hooks; setup/: the setup agent's brief and settings) as mm has it, before anything runs
  // from it: a file that is neither mm's render nor what the host sealed is written over, or removed (review sy-atqr)
  const seal = (r.engine as { files?: Record<string, string> } | null)?.files
  const kernel = repairKernel(root, seal && typeof seal === 'object' ? seal : null)
  const kd = kernel.length ? `; ops/ and setup/: ${kernel.length} file(s) put back as mm has them (${kernel.slice(0, 4).join('; ')}${kernel.length > 4 ? '; …' : ''})` : '; ops/ and setup/ as mm has them'
  return { files: [...Object.keys(r.files), '.mm-answers.yaml', 'ops', 'setup'], detail: `${r.box ? 'a box' : 'once a box'}: ${Object.keys(r.files).length} privilege file(s)${r.engine ? ', the engine seal' : ''}${base} from the host's record (sy-b15.19)${kd} (sy-atqr)` }
}

/** The restored board's folder by its project id (system, or projects/<client>/<name>). */
function findBoard(project: string): string {
  if (project === 'system') return DIRS.system
  for (const c of existsSync(DIRS.projects) ? readdirSync(DIRS.projects) : []) for (const n of readdirSync(join(DIRS.projects, c))) {
    try { if (readAnswers(join(DIRS.projects, c, n)).project === project) return join(DIRS.projects, c, n) } catch {}
  }
  throw new Error(`restored board ${project} not found`)
}

/**
 * A restored board's first start: its tools, a fresh Beads database replaced by the backup (Dolt keeps history), the
 * board's build, the lead worktrees, then its services (on hold: inward only). Counts the items against the backup.
 */
async function bringUp(root: string, work: string): Promise<{ steps: Step[]; ok: boolean; items: number; expected: number; ready: boolean }> {
  const a = readAnswers(root), stage = join(root, '.restore'), steps: Step[] = []
  const res = (ok: boolean, items = 0, ready = false) => ({ steps, ok, items, expected, ready })
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0)
  const expected = lines(join(stage, 'board.jsonl'))
  const must = (step: string, r: { ok: boolean; out: string; err: string }) => { steps.push({ step: `${a.project}: ${step}`, status: r.ok ? 'ok' : 'fail', detail: r.ok ? (r.out.trim().split('\n').pop() || 'done').slice(0, 120) : short(r) }); return r.ok }
  try { for (const s of await installTools(root)) steps.push({ ...s, step: `${a.project}: ${s.step}` }) } catch (e) { steps.push({ step: `${a.project}: tools`, status: 'fail', detail: (e as Error).message }); return res(false) }
  // a box's bundle is the box's own history: the host runs its bin/ and site/ (init, npm, config-check, wt, bd) only
  // if they are mm's engine (review sy-b15.6 follow-up 2)
  const no = engineRefusal(root); if (no) { steps.push({ step: `${a.project}: engine`, status: 'fail', detail: `refused: ${no}` }); return res(false) }
  if (!must('board database (bin/init)', run([join(root, 'bin', 'init'), a.short], { cwd: root, env: NO_HOOKS, timeoutMs: 300_000 }))) return res(false)
  const db = JSON.parse(readFileSync(join(root, 'control', '.beads', 'metadata.json'), 'utf8')).dolt_database as string
  const denv = { DOLT_ROOT_PATH: join(root, '.dolt-root'), XDG_CONFIG_HOME: join(root, '.config') }
  if (!must(`board data -> ${db} (dolt backup restore)`, run([join(root, 'tools', 'dolt'), 'backup', 'restore', '--force', `file://${join(stage, 'board.dolt')}`, db], { cwd: join(root, 'control', '.beads', 'dolt'), env: denv, timeoutMs: 600_000 }))) return res(false)
  // the restored database keeps the old box's project identity (its metadata table); bin/init wrote a new one into
  // metadata.json, and bd refuses to connect on a mismatch: take the database's
  const q = run([join(root, 'tools', 'dolt'), 'sql', '-r', 'csv', '-q', "select value from metadata where `key` = '_project_id'"], { cwd: join(root, 'control', '.beads', 'dolt', db), env: denv })
  const pid = q.out.trim().split('\n').pop()?.trim() || ''
  if (!q.ok || !/^[0-9a-f-]{36}$/.test(pid)) { steps.push({ step: `${a.project}: project identity`, status: 'fail', detail: `the restored database names no project id (${short(q)})` }); return res(false) }
  const mf = join(root, 'control', '.beads', 'metadata.json'), meta = JSON.parse(readFileSync(mf, 'utf8'))
  if (meta.project_id !== pid) { meta.project_id = pid; writeFileSync(mf, JSON.stringify(meta, null, 2) + '\n') }
  steps.push({ step: `${a.project}: project identity`, status: 'ok', detail: `${pid} (the database's)` })
  if (existsSync(join(root, 'site', 'package.json')) && !must('board build', run(['sh', '-c', 'npm ci --no-audit --no-fund --silent && npm run build --silent'], { cwd: join(root, 'site'), timeoutMs: 900_000 }))) return res(false)
  if (existsSync(join(root, 'bin', 'config-check'))) {
    if (!must('governance check', run([join(root, 'bin', 'config-check'), '--render'], { cwd: root, env: NO_HOOKS }))) return res(false)
    // restore's own commit: no repo hook runs (sy-b15.19)
    if (run(['git', '-C', root, 'status', '--porcelain', '--untracked-files=no'], { env: restoreGit(root) }).out.trim())
      run(['git', '-C', root, 'commit', '-qam', 'mm restore: rendered for this box'], { env: { SETUP_HUMAN: '1', ...restoreGit(root) } })
  }
  try {
    const roles = JSON.parse(readFileSync(join(root, 'leads', 'roles.json'), 'utf8')).roles as { id: string; workers?: boolean }[]
    if (existsSync(join(root, 'code', '.git'))) for (const r of roles.filter((x) => !x.workers)) run([join(root, 'bin', 'wt'), `lead-${r.id}`], { cwd: root, env: NO_HOOKS })
  } catch {}
  for (const s of up(root)) steps.push({ ...s, step: `${a.project}: ${s.step}` })
  let ready = false
  for (let i = 0; i < 90 && !ready; i++) { ready = processes(a.project).some((p) => p.name === `${a.project}.board` && p.is_ready === 'Ready'); if (!ready) Bun.sleepSync(2000) }
  const out = join(work, `${a.project}.export.jsonl`)
  const ex = run([join(root, 'bin', 'bd'), 'export', '--all', '-o', out], { cwd: join(root, 'control'), timeoutMs: 120_000 })
  // every record of the backup must be back (the box may already have added its own, e.g. the watchdog's incidents)
  const ids = (f: string) => new Set(existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return String(JSON.parse(l).id) } catch { return '' } }) : [])
  const want = ids(join(stage, 'board.jsonl')), have = ex.ok ? ids(out) : new Set<string>()
  const items = [...want].filter((x) => have.has(x)).length, extra = have.size - items, all = ready && items === expected
  steps.push({ step: `${a.project}: items`, status: all ? 'ok' : 'fail', detail: `${items} of the backup's ${expected} on the board${extra > 0 ? ` (+${extra} new since)` : ''}${ready ? '' : '; the board is not ready'}` })
  if (all) rmSync(stage, { recursive: true, force: true })
  return res(all, items, ready)
}

/** `mm restore --release`: the human, at a terminal, says the old box is down; the hold ends and every board starts fully. */
export function release(): Step[] {
  const c = loadConfig()
  if (!held(c)) return [{ step: 'release', status: 'skip', detail: 'no restore hold on this box' }]
  if ((c.restore as { drill?: boolean }).drill) return [{ step: 'release', status: 'fail', detail: 'a drill box never goes outward: throw it away' }]
  const phrase = 'the old box is down'
  const said = typed(`This starts the leads, public routes and mastermind sync on this box.\nIf the old box still runs, both would act at once.\nType "${phrase}" to go on: `)
  if (said !== phrase) return [{ step: 'release', status: 'fail', detail: 'not confirmed; the hold stays' }]
  unsetPath(c, 'restore.hold'); setPath(c, 'restore.released', new Date().toISOString()); saveConfig(c)
  const steps: Step[] = [{ step: 'release', status: 'ok', detail: 'hold lifted' }]
  for (const root of [DIRS.system, ...(existsSync(DIRS.projects) ? readdirSync(DIRS.projects).flatMap((x) => readdirSync(join(DIRS.projects, x)).map((n) => join(DIRS.projects, x, n))) : [])])
    if (existsSync(join(root, '.mm-answers.yaml'))) for (const s of up(root)) steps.push({ ...s, step: `${readAnswers(root).project}: ${s.step}` })
  return steps
}

/** A line the human types at the terminal (not stdin, not an agent). */
function typed(question: string): string {
  if (process.env.CLAUDECODE || process.env.PASEO_AGENT_ID) throw new Error('this needs the human at a terminal, not an agent')
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') } catch { throw new Error('no terminal: run it yourself, in a terminal') }
  try { writeSync(fd, question); const b = Buffer.alloc(256), n = readSync(fd, b, 0, 256, null); return b.subarray(0, n).toString().trim() } finally { closeSync(fd) }
}
