// The vault: secrets sealed with age (docs/vault.md). A value moves only through pipes: into `age` on stdin, out of it
// on stdout into a file this process creates 0600 in a memory-backed folder. Never argv, never env, never printed.
//   $MM_HOME/vault/ (0700): key (the machine's age identity, 0600), recipients.txt (machine + the human's recovery
//   public key), <name>.age (0600), digests.txt (sha256 of each sealed file: the drill's integrity check).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, run } from './env'

export const VAULT = DIRS.vault
const KEY = join(VAULT, 'key'), RCPT = join(VAULT, 'recipients.txt'), DIG = join(VAULT, 'digests.txt')
const NAME = /^[a-z][a-z0-9_.-]{1,63}$/
const AGE_PUB = /^age1[02-9ac-hj-np-z]{58}$/                          // bech32, X25519 recipients
const PLUGIN_PUB = /^age1[a-z0-9]+1[02-9ac-hj-np-z]{20,}$/           // e.g. age1yubikey1… (a hardware recovery key)

export const vaultName = (name: string) => { if (!NAME.test(name)) throw new Error(`not a vault name: ${name}`); return name }
export const ready = () => existsSync(KEY) && existsSync(RCPT)
/** The vault name of a project's secret: <project>.<name, lower-case>. */
export const projectSecretName = (project: string, name: string) => `${project}.${name.toLowerCase()}`
export const sealed = (name: string) => existsSync(join(VAULT, `${name}.age`))
const ageBin = () => { if (!run(['sh', '-c', 'command -v age && command -v age-keygen']).ok) throw new Error('age is not installed (mm doctor; a signed system package)'); return 'age' }
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
function writeAtomic(f: string, data: Buffer | string) { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, data, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, f) }
function digests(): Record<string, string> {
  const out: Record<string, string> = {}
  try { for (const l of readFileSync(DIG, 'utf8').split('\n')) { const [n, h] = l.trim().split(/\s+/); if (n && h) out[n] = h } } catch {}
  return out
}
const saveDigests = (d: Record<string, string>) => writeAtomic(DIG, Object.entries(d).sort().map(([n, h]) => `${n} ${h}`).join('\n') + '\n')

/** Make the machine key and record both recipients. The recovery key is the human's; mm only takes its public half. */
export function init(recoveryPublic: string): { machine: string; recovery: string } {
  ageBin()
  const rec = recoveryPublic.trim()
  if (!AGE_PUB.test(rec) && !PLUGIN_PUB.test(rec)) throw new Error('the recovery key must be an age public key (age1…), never the secret one (AGE-SECRET-KEY-…)')
  mkdirSync(VAULT, { recursive: true, mode: 0o700 }); chmodSync(VAULT, 0o700)
  if (existsSync(KEY)) throw new Error(`${KEY} exists: this machine already has a vault key (restore reseals; a new key would orphan what is sealed)`)
  const g = spawnSync('age-keygen', [], { encoding: 'utf8' }) // the identity comes on stdout; we write it 0600 ourselves
  if (g.status !== 0) throw new Error(`age-keygen failed: ${String(g.stderr).trim().slice(0, 200)}`)
  writeAtomic(KEY, g.stdout)
  const machine = (/^# public key: (age1\S+)$/m.exec(g.stdout) || [])[1] || spawnSync('age-keygen', ['-y', KEY], { encoding: 'utf8' }).stdout.trim()
  if (!machine) throw new Error('age-keygen gave no public key')
  writeAtomic(RCPT, `# the machine's key (vault/key)\n${machine}\n# the human's recovery key (offline; only its public half is here)\n${rec}\n`)
  return { machine, recovery: rec }
}

/** Seal a value (from stdin pipes, never argv) to every recipient. */
export function seal(name: string, value: Buffer) {
  vaultName(name)
  if (!ready()) throw new Error('no vault on this machine yet (mm vault init)')
  const out = join(VAULT, `${name}.age`), tmp = `${out}.tmp-${process.pid}`
  const r = spawnSync(ageBin(), ['-e', '-R', RCPT, '-o', tmp], { input: value })
  if (r.status !== 0) throw new Error(`age failed: ${String(r.stderr).trim().slice(0, 200)}`)
  chmodSync(tmp, 0o600); renameSync(tmp, out)
  const d = digests(); d[name] = sha(readFileSync(out)); saveDigests(d)
}

/** Seal bytes (in memory, never argv) to the vault's recipients into `out` (0600), for mm sync. Not a vault secret:
 *  no digest entry, any path. Written to a temp file first, so `out` is either the old or the new ciphertext. */
export function sealTo(value: Buffer | Uint8Array, out: string) {
  if (!ready()) throw new Error('no vault on this machine yet (mm vault init): mastermind is sealed to its recipients')
  const tmp = `${out}.tmp-${process.pid}`
  const r = spawnSync(ageBin(), ['-e', '-R', RCPT, '-o', tmp], { input: value, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`age failed: ${String(r.stderr).trim().slice(0, 200)}`)
  chmodSync(tmp, 0o600); renameSync(tmp, out)
}
/** The vault's files that may leave the machine (sealed values, recipients, digests): never `key`. */
export const exportable = (f: string) => /^[a-z][a-z0-9_.-]{1,63}\.age$/.test(f) || f === 'recipients.txt' || f === 'digests.txt'

/** The plaintext, in memory, for one caller (open-at-start, reseal). Checks the sealed file's digest first. */
function decrypt(name: string, identity = KEY): Buffer {
  vaultName(name)
  const f = join(VAULT, `${name}.age`), want = digests()[name]
  if (!existsSync(f)) throw new Error(`nothing sealed as ${name}`)
  if (want && sha(readFileSync(f)) !== want) throw new Error(`${name}: the sealed file changed since it was sealed (digest mismatch)`)
  const r = spawnSync(ageBin(), ['-d', '-i', identity, f])
  if (r.status !== 0) throw new Error(`${name}: age could not open it (${String(r.stderr).trim().slice(0, 120)})`)
  return r.stdout as Buffer
}

/** Where a project's opened secrets live while its services run: a memory-backed folder, 0700. */
export function runtimeDir(project: string) {
  const base = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  const d = join(base, 'mm', 'secrets', project)
  mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(join(base, 'mm'), 0o700); chmodSync(join(base, 'mm', 'secrets'), 0o700); chmodSync(d, 0o700)
  return d
}
export const isTmpfs = (dir: string) => /^(tmpfs|ramfs)$/.test(run(['stat', '-f', '-c', '%T', dir]).out.trim())

/** Open the secrets a service declares into its project's runtime folder; returns NAME -> file, for <NAME>_FILE env. */
export function openFor(project: string, names: string[]): Record<string, string> {
  const d = runtimeDir(project)
  if (!isTmpfs(d)) throw new Error(`${d} is not memory-backed (tmpfs): refusing to write secrets there`)
  const out: Record<string, string> = {}
  for (const n of names) { const f = join(d, n); writeAtomic(f, decrypt(n)); out[n] = f }
  return out
}

/** Names, sizes and whether each sealed file still matches its digest. Never a value. */
export function list() {
  const d = digests()
  return (existsSync(VAULT) ? readdirSync(VAULT).filter((f) => f.endsWith('.age')) : []).map((f) => {
    const name = f.slice(0, -4), b = readFileSync(join(VAULT, f))
    return { name, bytes: b.length, digest: (d[name] || '').slice(0, 12), intact: d[name] === sha(b) }
  })
}

/** Restore: open everything with the human's recovery identity (a file they name; read here, never copied), make a
 *  new machine key, and reseal every secret to it plus the recovery public key. The identity file is not kept. */
export function resealWith(recoveryIdentityFile: string, recoveryPublic: string) {
  const names = list().map((x) => x.name), plain = new Map(names.map((n) => [n, decrypt(n, recoveryIdentityFile)]))
  for (const f of [KEY, RCPT]) if (existsSync(f)) renameSync(f, `${f}.old-${Date.now()}`)
  init(recoveryPublic)
  for (const [n, v] of plain) seal(n, v)
  return names
}

/** Modes and the runtime folder, for mm doctor. */
export function check(): { ok: boolean; detail: string }[] {
  const out: { ok: boolean; detail: string }[] = []
  if (!existsSync(VAULT)) return [{ ok: true, detail: 'no vault yet (mm vault init)' }]
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8)
  out.push({ ok: mode(VAULT) === '700', detail: `vault/ ${mode(VAULT)} (want 700)` })
  for (const f of readdirSync(VAULT)) { const m = mode(join(VAULT, f)); if (m !== '600') out.push({ ok: false, detail: `vault/${f} ${m} (want 600)` }) }
  for (const x of list()) if (!x.intact) out.push({ ok: false, detail: `${x.name}: sealed file does not match its digest` })
  return out
}
