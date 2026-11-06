// Each person's own long-term Claude token (sy-8n4w): set by that person on the gateway's own host ("Your Claude
// token") or by the owner in their own terminal; sealed in the vault (the machine key + the recovery key) as
// `claude_token.<person>`, one per person; never shown again, never logged. A run done for a person gets that
// person's token only (mm run-as), never the owner's. `claude_token` is never a project's name (no `_` in one), so the
// name can't meet a project's secret (`<project>.<name>`). Design: docs/auth-gateway.md ("Your Claude token").
import { Database } from 'bun:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS } from './env'
import * as vault from './vault'

export const PERSON = /^[a-z][a-z0-9._-]{1,31}$/ // mm.auth's names
export const tokenName = (person: string) => { if (!PERSON.test(person)) throw new Error('not a person\'s name'); return `claude_token.${person}` }
// what `claude setup-token` makes: sk-ant-oat01-…, then base64url. A light check of its shape; the value is never echoed
const SHAPE = /^sk-ant-oat01-[A-Za-z0-9_-]{40,400}$/
export const looksLikeToken = (v: string) => SHAPE.test(v)
export const SHAPE_HELP = 'That does not look like a Claude long-term token. Make one with `claude setup-token` on your own computer: it starts with sk-ant-oat01-.'
export const hasToken = (person: string) => PERSON.test(person) && vault.sealed(tokenName(person))
/** When it was set (the sealed file's time), or null. Never the value. */
export function tokenSince(person: string): string | null {
  try { return statSync(join(vault.VAULT, `${tokenName(person)}.age`)).mtime.toISOString() } catch { return null }
}
/** Seal a person's token (replaces the one there). Throws with a message that never holds the value. */
export function setToken(person: string, value: string) {
  const v = String(value || '').trim()
  if (!looksLikeToken(v)) throw new Error(SHAPE_HELP)
  if (!vault.ready()) throw new Error('This machine has no vault yet, so mm can\'t keep a token. Ask the owner (mm vault init).')
  vault.seal(tokenName(person), Buffer.from(v))
}
export const removeToken = (person: string) => PERSON.test(person) && vault.drop(tokenName(person))

/** A person's role on a project, from mm.auth's grants (read-only): owner (the admin), designer, member, viewer, or null
 *  with the reason. Fails closed: grants that can't be read give null. */
export function roleOf(person: string, project: string, accounts = join(DIRS.mm, 'auth', 'accounts.db')): { role: string | null; why?: string } {
  if (!existsSync(accounts)) return { role: null, why: 'this machine has no accounts (mm.auth)' }
  let db: Database | undefined
  try {
    db = new Database(accounts, { readonly: true })
    const u = db.query('SELECT id, role, banned FROM user WHERE name = ?').get(person) as { id: string; role?: string; banned?: number } | null
    if (!u) return { role: null, why: `no account ${person}` }
    if (u.banned) return { role: null, why: `${person} is banned` }
    if (u.role === 'admin') return { role: 'owner' }
    const m = db.query('SELECT m.role AS role FROM member m JOIN organization o ON o.id = m.organizationId WHERE o.slug = ? AND m.userId = ?').get(project, u.id) as { role: string } | null
    return m ? { role: m.role } : { role: null, why: `${person} has no role on ${project}` }
  } catch { return { role: null, why: 'the grants could not be read' } }
  finally { db?.close() }
}
