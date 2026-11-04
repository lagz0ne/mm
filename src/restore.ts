// mm restore <mastermind>: a whole machine from the human's mastermind repo onto a blank box (docs/restore.md).
// Part 2 of sy-240: trust, MANIFEST, unseal, lay the brain and every board's repos and board data out, reseal the
// vault to a new machine key. Nothing starts here; bringing the boards up (and the outward gate) is the next part.
// Plaintext only ever lives in memory or in a 0700 work folder under $MM_HOME/state, removed at the end.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIRS, HOME, run } from './env'
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
  drill?: boolean             // a throwaway box: nothing outward-facing will start (the next part)
}

/** Which commit to restore: the newest tag the human signed, or HEAD if they typed its hash. Lists what is unsigned. */
export function trust(dir: string, o: Pick<RestoreOpts, 'accept' | 'allowedSigners'>): { commit?: string; steps: Step[] } {
  const g = (a: string[]) => run(['git', '-C', dir, ...a], { timeoutMs: 120_000 })
  const steps: Step[] = [], head = g(['rev-parse', 'HEAD']).out.trim()
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
/** A repo from a bundle, with every branch as a local branch (not only the default one) and no remote left. */
function fromBundle(bundle: string, dir: string, who: { name: string; email: string }) {
  mkdirSync(dir, { recursive: true })
  const g = (a: string[]) => { const r = run(['git', '-C', dir, ...a], { timeoutMs: 600_000 }); if (!r.ok) throw new Error(`${tl(dir)}: git ${a[0]}: ${short(r)}`); return r.out }
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
export function restoreMachine(src: string, o: RestoreOpts): { steps: Step[]; ok: boolean; boards: string[] } {
  const steps: Step[] = [], boards: string[] = []
  const fail = (step: string, detail: string) => { steps.push({ step, status: 'fail', detail }); return { steps, ok: false, boards } }
  const there = [DIRS.config, DIRS.brain, DIRS.system, DIRS.projects, join(DIRS.vault, 'key'), join(HOME, 'projects'), join(HOME, 'brain')].filter(existsSync)
  if (there.length) return fail('blank box', `this box already has mm's state (${there.map(tl).join(', ')}): restore only onto a blank box`)
  if (!o.identity || !existsSync(o.identity)) return fail('identity', 'give the recovery identity as a file you name (--identity <file>); it is read by age only, never copied')

  mkdirSync(dirname(RESTORE_CHECKOUT), { recursive: true, mode: 0o700 })
  if (!existsSync(join(RESTORE_CHECKOUT, '.git'))) {
    const c = run(['git', 'clone', '-q', src, RESTORE_CHECKOUT], { timeoutMs: 900_000 })
    if (!c.ok) return fail('clone', short(c))
  }
  chmodSync(RESTORE_CHECKOUT, 0o700)
  const t = trust(RESTORE_CHECKOUT, o); steps.push(...t.steps)
  if (!t.commit) return { steps, ok: false, boards }
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
    writeFileSync(DIRS.config, /^layout:/m.test(cfg) ? cfg.replace(/^layout:.*$/m, 'layout: one-root') : `${cfg.trimEnd()}\nlayout: one-root\n`, { mode: 0o600 })
    steps.push({ step: 'config', status: 'ok', detail: `${tl(DIRS.config)}${layout && layout !== 'one-root' ? ` (was ${layout}; now one-root)` : ''}` })
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
      const a = Bun.YAML.parse(readFileSync(join(root, '.mm-answers.yaml'), 'utf8')) as { project: string; root?: string }
      run(['git', '-C', root, 'config', 'user.email', `mm@${a.project}.local`])
      if (existsSync(join(root, 'ops', 'githooks'))) run(['git', '-C', root, 'config', 'core.hooksPath', 'ops/githooks'])
      if (a.root && a.root !== root) { // the answers name the old box's folder: point them here
        writeFileSync(join(root, '.mm-answers.yaml'), readFileSync(join(root, '.mm-answers.yaml'), 'utf8').replace(/^root:.*$/m, `root: ${root}`))
        run(['git', '-C', root, 'commit', '-q', '-m', 'mm restore: root on this box', '.mm-answers.yaml'], { env: { SETUP_HUMAN: '1' } })
      }
      if (existsSync(join(M, d, 'code.bundle.age'))) fromBundle(unseal(`${d}/code.bundle.age`), join(root, 'code'), { name: 'mm', email: `mm@${a.project}.local` })
      const stage = join(root, '.restore'); mkdirSync(stage, { recursive: true, mode: 0o700 })
      const x = run(['tar', '-xf', unseal(`${d}/board.tar.age`), '-C', stage], { timeoutMs: 600_000 })
      if (!x.ok) throw new Error(`${d}: board data: ${short(x)}`)
      const items = existsSync(join(stage, 'board.jsonl')) ? readFileSync(join(stage, 'board.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0
      boards.push(a.project)
      steps.push({ step: `board ${a.project}`, status: 'ok', detail: `${tl(root)}: config${existsSync(join(root, 'code', '.git')) ? ' + product' : ''} repo, board data staged (${items} record(s))` })
    }
    steps.push({ step: 'start', status: 'skip', detail: o.drill ? 'drill: data restored and checked; nothing started' : 'next: the boards are brought up (onboard, tools, board database), outward-facing services only after you confirm the old box is down' })
    return { steps, ok: true, boards }
  } catch (e) {
    return fail('restore', (e as Error).message)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
