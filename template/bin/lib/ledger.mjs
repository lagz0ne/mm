// ledger — read the owner's approvals from mm-approve's ledger (docs/approvals.md, sy-1jmi). The same checks as
// `box/mm-approve verify`, in node (its crypto has ed25519): bin/supervisor's t2 check and bin/flow use it.
// The switch: `verifier = actor | ledger` in /etc/mm-approve.conf (root's, so the machine's owner account can't flip
// it). With `actor` (or no file) the approvals are read as before, from the journal's actor. Only when /etc's file is
// absent, MM_APPROVE_CONF may name another config (tests); it can't turn a machine's ledger off.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const ETC = '/etc/mm-approve.conf'
const VERSION = 'mm-approve/1'
const ITEM = /^[a-z][a-z0-9]*-[a-z0-9]+(?:\.\d+)*$/, HEX64 = /^[0-9a-f]{64}$/, SUBJECT = /^(?:sha256:[0-9a-f]{64}|git:[0-9a-f]{40}(?:[0-9a-f]{24})?)$/
const APPROVER = /^telegram:[0-9]{1,20}$/, OFFER = /^[0-9a-f]{32}$/, TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/
const FIELDS = ['v', 'item', 'plan', 'subjects', 'approver', 'time', 'offer', 'sig']

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
/** A migration's subject: its script and its rollback, each by its sha256 (mm-approve migration_subject). */
export const migrationSubject = (script, rollback = '') => `sha256:${sha256(`${VERSION} migration\n${sha256(script)}\n${sha256(rollback)}\n`)}`
/** The bytes a line's signature covers (mm-approve signed_text). */
export const signedText = (l) => Buffer.from(`${VERSION}\nitem=${l.item}\nplan=${l.plan}\nsubjects=${l.subjects.join(',')}\napprover=${l.approver}\ntime=${l.time}\noffer=${l.offer}\n`)

/** A line's fields, each checked, or null. */
export function parseLine(text) {
  let o; try { o = JSON.parse(text) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const keys = Object.keys(o).sort()
  if (keys.join() !== [...FIELDS].sort().join()) return null
  const str = (k, re) => typeof o[k] === 'string' && re.test(o[k])
  const ok = o.v === 1 && str('item', ITEM) && str('plan', HEX64) && Array.isArray(o.subjects) && o.subjects.length > 0 &&
    o.subjects.every((s) => typeof s === 'string' && SUBJECT.test(s)) && str('approver', APPROVER) && str('time', TIME) && str('offer', OFFER) &&
    typeof o.sig === 'string'
  return ok ? o : null
}

/** Whether the line's signature is the key's (a KeyObject or PEM). */
export function goodSig(line, key) {
  const sig = Buffer.from(line.sig, 'base64')
  if (sig.length !== 64 || sig.toString('base64') !== line.sig) return false
  try { return crypto.verify(null, signedText(line), key, sig) } catch { return false }
}

/** The config: { path, strict, verifier, user, uid, dir, ledger, public_key }, or { verifier: 'actor' } with no file. */
export function loadConf({ etc = ETC, env = process.env } = {}) {
  let p = etc, strict = true
  if (!fs.existsSync(etc)) { if (!env.MM_APPROVE_CONF) return { verifier: 'actor', path: null }; p = env.MM_APPROVE_CONF; strict = false }
  const c = { path: p, strict, verifier: 'ledger', problems: [] } // a config we can't read: the strict side (ledger, and a finding)
  let fd
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (e) { c.problems.push(`${p}: ${e.code}`); return c }
  try {
    const st = fs.fstatSync(fd)
    if (strict && (st.uid !== 0 || st.mode & 0o022)) c.problems.push(`${p} must be root-owned and writable by root only`)
    const kv = {}
    for (const l of fs.readFileSync(fd, 'utf8').split('\n')) { const s = l.split('#', 1)[0], i = s.indexOf('='); if (i > 0) kv[s.slice(0, i).trim()] = s.slice(i + 1).trim() }
    c.verifier = kv.verifier || 'actor'
    if (!['actor', 'ledger'].includes(c.verifier)) { c.problems.push(`verifier = ${c.verifier}: actor or ledger`); c.verifier = 'ledger' }
    c.user = kv.user || 'mm-approve'
    c.dir = kv.dir || '/var/lib/mm-approve'
    c.public_key = kv.public_key || '/etc/mm-approve.pub'
    c.ledger = path.join(c.dir, 'ledger.jsonl')
    c.uid = uidOf(c.user)
    if (c.uid === null) c.problems.push(`user = ${c.user} has no account`)
  } finally { fs.closeSync(fd) }
  return c
}

function uidOf(name) {
  try { for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const f = l.split(':'); if (f[0] === name) return Number(f[2]) } } catch {}
  try { return Number(execFileSync('id', ['-u', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { return null }
}

function owned(p, uids, what, kind) {
  let st; try { st = fs.lstatSync(p) } catch (e) { return `${what} ${p}: ${e.code}` }
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) return `${what} ${p} is not a ${kind === 'file' ? 'plain file' : 'folder'}`
  if (!uids.has(st.uid)) return `${what} ${p} belongs to uid ${st.uid}, not ${[...uids].join('/')}`
  if (st.mode & 0o022) return `${what} ${p} is writable by its group or others (mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')})`
  if (kind === 'file' && st.nlink !== 1) return `${what} ${p} has ${st.nlink} links`
  return null
}
function parents(p, uids) {
  let d = path.dirname(path.resolve(p))
  for (;;) {
    let st; try { st = fs.lstatSync(d) } catch (e) { return `${d}: ${e.code}` }
    if (st.isSymbolicLink()) return `${d} is a symlink`
    const stickyRoot = st.mode & 0o1000 && st.uid === 0
    if (!(uids.has(st.uid) || st.uid === 0) || (st.mode & 0o022 && !stickyRoot)) return `${d} (above ${p}) can be changed by others (uid ${st.uid}, mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')})`
    if (d === '/') return null
    d = path.dirname(d)
  }
}

/** Why the ledger, its folder or the public key can't be trusted (condition 8), or []. */
export function problems(c) {
  if (c.verifier !== 'ledger') return []
  if (c.problems?.length || c.uid === null || c.uid === undefined) return [...(c.problems || [])]
  const signer = new Set([c.uid]), keyBy = new Set(c.strict ? [0] : [0, c.uid])
  return [owned(c.dir, signer, 'the ledger folder', 'dir'), parents(c.dir, signer), owned(c.ledger, signer, 'the ledger', 'file'),
    owned(c.public_key, keyBy, 'the public key', 'file'), parents(c.public_key, keyBy)].filter(Boolean)
}

/**
 * The ledger's well-signed lines, read once: { ok, problems, lines, has(item, subject?) }. With problems (owner, mode,
 * no key) nothing counts: ok false, has() always false. A line that doesn't parse or verify is left out (and counted).
 */
export function readLedger(c = loadConf()) {
  const out = { ok: false, problems: problems(c), lines: [], bad: 0, has: () => false }
  if (c.verifier !== 'ledger' || out.problems.length) return out
  let key, text
  try { key = crypto.createPublicKey(fs.readFileSync(c.public_key)); if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an ed25519 key') }
  catch (e) { out.problems.push(`the public key ${c.public_key}: ${e.message}`); return out }
  try { text = fs.readFileSync(c.ledger, 'utf8') } catch (e) { out.problems.push(`the ledger ${c.ledger}: ${e.code}`); return out }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    const l = parseLine(raw)
    if (l && goodSig(l, key)) out.lines.push(l); else out.bad++
  }
  out.ok = true
  out.has = (item, subject) => out.lines.some((l) => l.item === item && (subject === undefined || l.subjects.includes(subject)))
  return out
}
