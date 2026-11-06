// mm.ai: the AI gateway (plans/project-box.md B2; sy-b15.10). Every model call from a box goes through it: the box has
// no provider key, only a short-lived mm key that works for its own project only. The gateway checks the key, the
// budgets and the cap on parallel runs, then calls the upstream (the Anthropic Messages API, or a gateway that speaks
// it) with the machine's upstream key, and counts each answer's tokens and cost.
//
//   The way in: one Unix socket per box, $MM_HOME/box/<project>/ai/ai.sock (made here for each box in pc/boxes).
//   Only that box's egress proxy mounts it, and forwards its port 4000 to it. The project is the socket the call came
//   in on, never a name in the call (review sy-b15.8 5). No TCP port on the host.
//   The store: $MM_HOME/ai/ai.db (0600, SQLite, WAL): keys (sha256 only), usage, budgets, notices sent.
//   The upstream key: the machine input `ai-upstream-key` (a file, 0600), or the one `ai.upstream_key_input` names (only
//   `claude-oauth-token` besides), read at each call, never logged or passed on.
import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'bun'
import { getPath, loadConfig } from './config'
import { DIRS } from './env'
import { expand, machineInputs } from './inputs'

// MM_AI_DIR, MM_AI_UPSTREAM, MM_AI_UPSTREAM_KEY_FILE and MM_AI_ENABLED are for tests on a live machine (test/box.sh):
// a throwaway store, upstream and key, with the machine's config untouched
export const AI_DIR = process.env.MM_AI_DIR || join(DIRS.mm, 'ai')
export const aiEnabled = () => { if (process.env.MM_AI_ENABLED === '1') return true; const v = getPath(loadConfig(), 'ai.enabled'); return v === true || v === 'true' }
export const aiSocket = (project: string) => join(DIRS.mm, 'box', project, 'ai', 'ai.sock')
export const AI_PORT = 4000 // the port the box's egress proxy forwards to the box's socket
const h = (s: string) => createHash('sha256').update(s).digest('hex')
const now = () => Date.now()
const log = (level: string, msg: string, attrs: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, project: 'mm', service: 'ai', ...attrs }))

// ---------- prices (USD per million tokens) ----------
// Defaults: Anthropic's first-party prices (2026-10); a cache write is 1.25x input (5-minute TTL). `ai.prices` in the
// machine's config overrides or adds a model: { <model>: { input, output, cache_read, cache_write } }. A model with no
// price is counted at the dearest known one, so a budget is never under-counted.
type Price = { input: number; output: number; cache_read: number; cache_write: number }
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
}
export function prices(): Record<string, Price> {
  const extra = (getPath(loadConfig(), 'ai.prices') || {}) as Record<string, Partial<Price>>
  const out: Record<string, Price> = { ...DEFAULT_PRICES }
  for (const [m, p] of Object.entries(extra)) {
    const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined)
    const i = n(p.input), o = n(p.output)
    if (i === undefined || o === undefined) continue
    out[m] = { input: i, output: o, cache_read: n(p.cache_read) ?? i * 0.1, cache_write: n(p.cache_write) ?? i * 1.25 }
  }
  return out
}
export type Usage = { input: number; output: number; cache_read: number; cache_write: number }
/** What one answer cost, in USD. The model's own name first, then the longest known name it starts with
 *  (e.g. a dated or suffixed id), else the dearest price. */
export function cost(model: string, u: Usage, table = prices()): number {
  const m = String(model || '').replace(/\[.*$/, '')
  const p = table[m] || Object.entries(table).filter(([k]) => m.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
    || Object.values(table).sort((a, b) => b.output - a.output)[0]
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cache_write * p.cache_write) / 1e6
}

// ---------- the store ----------
export function store(): Database {
  mkdirSync(AI_DIR, { recursive: true, mode: 0o700 }); chmodSync(AI_DIR, 0o700)
  const f = join(AI_DIR, 'ai.db'), d = new Database(f, { create: true })
  d.run('PRAGMA journal_mode = WAL'); d.run('PRAGMA busy_timeout = 5000')
  d.run(`CREATE TABLE IF NOT EXISTS ai_key (hash TEXT PRIMARY KEY, project TEXT NOT NULL, person TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`)
  d.run(`CREATE TABLE IF NOT EXISTS ai_usage (at INTEGER NOT NULL, project TEXT NOT NULL, person TEXT NOT NULL, model TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, usd REAL NOT NULL)`)
  d.run('CREATE INDEX IF NOT EXISTS ai_usage_pm ON ai_usage (project, at)')
  d.run(`CREATE TABLE IF NOT EXISTS ai_budget (project TEXT NOT NULL, person TEXT NOT NULL, usd REAL NOT NULL, PRIMARY KEY (project, person))`)
  d.run(`CREATE TABLE IF NOT EXISTS ai_notice (project TEXT NOT NULL, person TEXT NOT NULL, month TEXT NOT NULL, level INTEGER NOT NULL,
    PRIMARY KEY (project, person, month, level))`)
  for (const x of readdirSync(AI_DIR)) try { chmodSync(join(AI_DIR, x), 0o600) } catch {}
  return d
}
const NAME = /^[a-z][a-z0-9-]{0,62}$/
const check = (what: string, v: string, allowEmpty = false) => { if (!(allowEmpty && v === '') && !NAME.test(v)) throw new Error(`not a ${what} name: ${v}`); return v }

/** A key for one project (and one person, or the project's own background work). The raw key is returned once;
 *  only its sha256 is kept. */
export function mintKey(d: Database, project: string, o: { person?: string; kind?: 'run' | 'project'; ttlMs?: number } = {}) {
  const person = check('person', o.person || '', true), kind = o.kind || (person ? 'run' : 'project')
  const ttl = Math.min(Math.max(o.ttlMs ?? 8 * 3600e3, 60e3), 31 * 24 * 3600e3)
  const raw = `mmk_${randomBytes(24).toString('base64url')}`
  d.query('INSERT INTO ai_key (hash, project, person, kind, created, expires) VALUES (?, ?, ?, ?, ?, ?)').run(h(raw), check('project', project), person, kind, now(), now() + ttl)
  return { key: raw, project, person, kind, expires: new Date(now() + ttl).toISOString() }
}
export function revokeKeys(d: Database, project: string, kind?: string) {
  return d.query(`UPDATE ai_key SET revoked = 1 WHERE project = ? AND revoked = 0${kind ? ' AND kind = ?' : ''}`).run(...(kind ? [project, kind] : [project])).changes
}
export const monthStart = (t = now()) => { const x = new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1) }
const monthName = (t = now()) => new Date(t).toISOString().slice(0, 7)
export function spent(d: Database, project: string, person?: string, since = monthStart()) {
  const r = d.query(`SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE project = ? AND at >= ?${person ? ' AND person = ?' : ''}`)
    .get(...(person ? [project, since, person] : [project, since])) as { usd: number }
  return r.usd
}
/** A monthly budget in USD for a project (person '') or one person in it; 0 removes it. */
export function setBudget(d: Database, project: string, person: string, usd: number) {
  check('project', project); check('person', person, true)
  if (!(usd >= 0)) throw new Error('a budget is a number of USD, 0 or more')
  if (usd === 0) d.query('DELETE FROM ai_budget WHERE project = ? AND person = ?').run(project, person)
  else d.query('INSERT INTO ai_budget (project, person, usd) VALUES (?, ?, ?) ON CONFLICT (project, person) DO UPDATE SET usd = excluded.usd').run(project, person, usd)
}
const budgetOf = (d: Database, project: string, person: string) =>
  (d.query('SELECT usd FROM ai_budget WHERE project = ? AND person = ?').get(project, person) as { usd: number } | null)?.usd
/** This month's use, by project, person and model, with the budgets. */
export function report(d: Database, since = monthStart()) {
  const rows = d.query(`SELECT project, person, model, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
    SUM(cache_write) AS cache_write, ROUND(SUM(usd), 4) AS usd FROM ai_usage WHERE at >= ? GROUP BY project, person, model ORDER BY project, person, model`).all(since) as Record<string, unknown>[]
  const budgets = d.query('SELECT project, person, usd FROM ai_budget ORDER BY project, person').all() as { project: string; person: string; usd: number }[]
  return { month: monthName(since), rows, budgets: budgets.map((b) => ({ ...b, spent: Math.round(spent(d, b.project, b.person || undefined, since) * 1e4) / 1e4 })) }
}

// ---------- the gateway ----------
type KeyRow = { project: string; person: string; kind: string; expires: number; revoked: number }

/** The accounts the owner marked as their own personas (`ai.owner_personas` in mm's config: a list, or names split by
 *  commas or spaces; set only by the owner). Names that aren't account names are dropped. */
export function ownerPersonas(cfg: Record<string, unknown> = loadConfig()): Set<string> {
  const v = getPath(cfg, 'ai.owner_personas'), list = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/)
  return new Set(list.map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9._-]{1,31}$/.test(s)))
}

/** Oauth mode carries the machine owner's own subscription, which its terms keep to the owner's own use (review
 *  sy-b15.10): only a run of the owner or of one of the owner's personas (ai.owner_personas: accounts the owner uses to
 *  emulate users), or a project's background key, and only for a project where nobody but the owner and those personas
 *  holds a role (mm.auth's grants). The reason it is refused, or null. Fails closed: grants it can't read refuse. */
export function ownerOnly(k: { project: string; person: string }, owner: string, personas: Set<string> = new Set(), accounts = join(DIRS.mm, 'auth', 'accounts.db')): string | null {
  if (k.person && k.person !== owner && !personas.has(k.person)) return `a run for ${k.person}: in oauth mode only the owner's own runs (and the owner's personas, ai.owner_personas) may call`
  if (!existsSync(accounts)) return null                          // no gateway on this machine: no grants to anyone
  let db: Database | undefined
  try {
    db = new Database(accounts, { readonly: true })
    const rows = db.query(`SELECT u.name AS name FROM member m JOIN organization o ON o.id = m.organizationId JOIN user u ON u.id = m.userId
      WHERE o.slug = ? AND COALESCE(u.role, '') != 'admin' AND COALESCE(u.banned, 0) = 0`).all(k.project) as { name: string }[]
    const others = rows.filter((r) => !personas.has(r.name)).length
    return others > 0 ? `${k.project} has ${others} other ${others === 1 ? 'person' : 'people'} with a role (not the owner's personas): in oauth mode only a project of the owner alone may call` : null
  } catch { return 'the grants could not be read, so oauth mode refuses' }
  finally { db?.close() }
}
const apiError = (status: number, type: string, message: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: `mm.ai: ${message}` } }), { status, headers: { 'content-type': 'application/json', ...extra } })
const PASS_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-dangerous-direct-browser-access']

// ---------- the model's own way out (review sy-b15.18) ----------
// The Messages API has tools that run on the provider's side and reach the internet from there (web search and fetch,
// code execution, MCP servers, skills in a container): a way out of the box that its egress list never sees. So a tool
// passes only when it runs in the box: a tool the caller defines (no type, or `custom`), or one Anthropic defines that
// the caller runs itself (bash, text editor, computer, memory, tool search). Anything else, `mcp_servers` and
// `container` are refused (400), unless the owner allows that server tool for the project:
//   ai.server_tools: { <project>: [web_search, web_fetch, code_execution, mcp, container] }
const CLIENT_TOOL = /^(custom|bash|text_editor|computer|computer_toolset|memory|tool_search_tool_(regex|bm25))(_\d{8})?$/
const toolBase = (t: string) => t.replace(/_\d{8}$/, '').replace(/^(web_search|web_fetch|code_execution|mcp)_?.*$/, '$1')
// beta values that turn on provider-side egress: dropped unless allowed (the body check is the real control; this is a
// second one). Every other beta passes, so a new Claude Code release that sends a new one keeps working.
const EGRESS_BETA = /^(mcp-client|code-execution|web-fetch|web-search|files-api|skills|container)-/
export function serverToolsAllowed(project: string): Set<string> {
  const all = (getPath(loadConfig(), 'ai.server_tools') || {}) as Record<string, unknown>
  const v = all[project]; return new Set(Array.isArray(v) ? v.map(String) : [])
}
/** Why a request may not go upstream, or null. */
export function egressRefusal(body: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const t of (Array.isArray(body.tools) ? body.tools : []) as { type?: string; name?: string }[]) {
    if (!t || typeof t !== 'object' || t.type === undefined || CLIENT_TOOL.test(String(t.type))) continue
    const base = toolBase(String(t.type))
    if (!allowed.has(base)) return `the tool ${t.type} runs on the provider's side and can reach the internet outside this box's egress list; the owner can allow ${base} for this project (ai.server_tools)`
  }
  if (body.mcp_servers !== undefined && !allowed.has('mcp')) return 'mcp_servers reach remote MCP servers from the provider\'s side, outside this box\'s egress list; the owner can allow mcp for this project (ai.server_tools)'
  if (body.container !== undefined && !allowed.has('container')) return 'a container (skills, code execution) runs on the provider\'s side; the owner can allow container for this project (ai.server_tools)'
  return null
}
export function betaHeader(v: string | null, allowed: Set<string>): string | null {
  if (!v) return null
  const keep = v.split(',').map((x) => x.trim()).filter(Boolean).filter((b) => !EGRESS_BETA.test(b) || allowed.size > 0)
  return keep.length ? keep.join(',') : null
}

// ---------- the upstream's credential (sy-b15.10) ----------
// `ai.upstream_key_input` names the machine input mm.ai calls the upstream with: one of these names only, never a free
// path. `claude-oauth-token` is the machine's long-term Claude token (the owner's choice "for now"); it goes with
// `ai.upstream_auth: oauth`. Either way the file stays on the host: read by path at each call, never logged, never in a box.
export const UPSTREAM_INPUTS = ['ai-upstream-key', 'claude-oauth-token']
export function upstreamInput(c = loadConfig()): string {
  const v = getPath(c, 'ai.upstream_key_input')
  const name = v === undefined || v === null || v === '' ? 'ai-upstream-key' : String(v)
  // the value itself is not repeated (it could be a path, or a token pasted by mistake)
  if (!UPSTREAM_INPUTS.includes(name)) throw new Error(`ai.upstream_key_input may only be ${UPSTREAM_INPUTS.join(' or ')} (unset means ai-upstream-key)`)
  return name
}
// an OAuth token (ai.upstream_auth: oauth) goes as `Authorization: Bearer`, with this beta, which the API needs for it
export const OAUTH_BETA = 'oauth-2025-04-20'
export const OAUTH_IDENTITY = ['user-agent', 'x-app']
export function mergeBeta(v: string | null, add: string): string {
  return [...new Set([...(v || '').split(',').map((x) => x.trim()).filter(Boolean), add])].join(',')
}

/** Read the token counts out of an answer: a JSON body, or the SSE stream's message_start and message_delta events. */
export function usageOf(u: Record<string, number | undefined> | undefined, into: Usage) {
  if (!u) return
  if (u.input_tokens !== undefined) into.input = u.input_tokens
  if (u.output_tokens !== undefined) into.output = u.output_tokens          // message_delta: the running total
  if (u.cache_read_input_tokens !== undefined) into.cache_read = u.cache_read_input_tokens
  if (u.cache_creation_input_tokens !== undefined) into.cache_write = u.cache_creation_input_tokens
}

export async function serve() {
  const cfg = () => loadConfig()
  try { upstreamInput(cfg()) } catch (e) { log('error', 'mm.ai refused to start', { why: (e as Error).message }); process.exit(1) }
  const d = store()
  const upstream = () => String(process.env.MM_AI_UPSTREAM || getPath(cfg(), 'ai.upstream') || 'https://api.anthropic.com').replace(/\/+$/, '')
  // the chosen input's file, read at each call (a new key needs no restart); a bad choice made while mm.ai runs is
  // refused here too
  const upstreamKey = (): { input: string; key: string; why?: string } => {
    let input: string
    try { input = upstreamInput(cfg()) } catch (e) { return { input: '', key: '', why: (e as Error).message } }
    const f = process.env.MM_AI_UPSTREAM_KEY_FILE || expand(String(machineInputs()[input]?.path || (input === 'ai-upstream-key' ? '~/.config/secrets/ai-upstream.key' : '')))
    try { return { input, key: f ? readFileSync(f, 'utf8').trim() : '' } } catch { return { input, key: '' } }
  }
  const maxParallel = () => Math.max(1, Number(getPath(cfg(), 'ai.max_parallel') ?? 3) || 3)
  const inflight = new Map<string, number>()
  const tellOwner = (text: string) => {
    const chat = String(getPath(cfg(), 'telegram.owner_id') ?? ''), tf = expand(String(machineInputs()['telegram-bot-token']?.path || ''))
    let token = ''; try { token = readFileSync(tf, 'utf8').trim() } catch {}
    if (!chat || !token) { log('warn', 'owner not told (no Telegram bot token or owner id)', { notice: text }); return }
    fetch(`${process.env.MM_TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `mm: ${text}` }), signal: AbortSignal.timeout(10000) })
      .then((r) => log(r.ok ? 'info' : 'warn', r.ok ? 'owner told' : 'owner not told', { notice: text })).catch(() => log('warn', 'owner not told', { notice: text }))
  }
  /** After a call: 80 % and 100 % of a budget are told once a month (the owner; the person's own channel comes later). */
  const notices = (project: string, person: string) => {
    for (const who of person ? ['', person] : ['']) {
      const b = budgetOf(d, project, who); if (!b) continue
      const s = spent(d, project, who || undefined), pct = s / b
      for (const level of [100, 80]) {
        if (pct * 100 < level) continue
        const done = d.query('INSERT OR IGNORE INTO ai_notice (project, person, month, level) VALUES (?, ?, ?, ?)').run(project, who, monthName(), level).changes
        if (done) {
          const whose = who ? `${who} in ${project}` : project
          const text = level === 100 ? `AI budget reached: ${whose} used $${s.toFixed(2)} of $${b.toFixed(2)} this month. New calls wait until you raise it: mm ai budget ${project}${who ? ` --person ${who}` : ''} <usd>`
            : `AI budget at ${Math.floor(pct * 100)} %: ${whose} used $${s.toFixed(2)} of $${b.toFixed(2)} this month.`
          log('warn', 'budget notice', { box: project, person: who || undefined, level, usd: s, budget: b }); tellOwner(text)
        }
        break
      }
    }
  }
  const record = (project: string, person: string, model: string, u: Usage) => {
    const usd = cost(model, u)
    d.query('INSERT INTO ai_usage (at, project, person, model, input, output, cache_read, cache_write, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), project, person, model, u.input, u.output, u.cache_read, u.cache_write, usd)
    log('info', 'call', { box: project, person: person || undefined, model, ...u, usd: Math.round(usd * 1e6) / 1e6 })
    notices(project, person)
  }

  async function handle(req: Request, project: string): Promise<Response> {
    const u = new URL(req.url), path = u.pathname
    const messages = req.method === 'POST' && path === '/v1/messages'
    const allowed = messages || (req.method === 'POST' && path === '/v1/messages/count_tokens') || (req.method === 'GET' && /^\/v1\/models(\/[\w.-]+)?$/.test(path))
    if (!allowed) return apiError(404, 'not_found_error', `${req.method} ${path} is not served here`)
    const raw = req.headers.get('x-api-key') || /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1] || ''
    const k = raw ? d.query('SELECT project, person, kind, expires, revoked FROM ai_key WHERE hash = ?').get(h(raw)) as KeyRow | null : null
    if (!k || k.revoked || k.expires < now() || k.project !== project) {
      log('warn', 'key refused', { box: project, key: raw ? h(raw).slice(0, 6) : undefined, why: !k ? 'unknown' : k.revoked ? 'revoked' : k.expires < now() ? 'expired' : `for ${k.project}` })
      return apiError(401, 'authentication_error', 'this key is not valid for this project (it may have expired)')
    }
    if (String(getPath(cfg(), 'ai.upstream_auth') || '') === 'oauth') {
      const no = ownerOnly(k, String(getPath(cfg(), 'owner_name') ?? 'owner'), ownerPersonas(cfg()))
      if (no) { log('warn', 'oauth mode: not the owner\'s own use', { box: project, person: k.person || undefined, why: no }); return apiError(403, 'permission_error', no) }
    }
    const { input, key, why: badInput } = upstreamKey()
    if (badInput) { log('error', 'upstream key input refused', { why: badInput }); return apiError(503, 'api_error', `the machine's AI config is wrong: ${badInput}`) }
    if (!key) { log('error', `no upstream key (mm fill ${input})`); return apiError(503, 'api_error', `the machine has no upstream key yet: the file of ${input} is missing or empty (the owner: mm fill ${input})`) }
    const bytes = req.method === 'POST' ? await req.arrayBuffer() : undefined
    let parsed: Record<string, unknown> = {}
    if (bytes) {
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { return apiError(400, 'invalid_request_error', 'the body is not JSON') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return apiError(400, 'invalid_request_error', 'the body is not a JSON object')
    }
    // the upstream gets exactly what was checked (review sy-jm5 1): the parsed body, written out again, never the bytes
    // as sent. Those could say more than the check saw: a key twice ("tools"), where JS keeps the last and the provider
    // may read the first
    const body = bytes ? JSON.stringify(parsed) : undefined
    const serverOk = serverToolsAllowed(project), why = body ? egressRefusal(parsed, serverOk) : null
    if (why) { log('warn', 'server tool refused', { box: project, person: k.person || undefined, why: why.split(';')[0] }); return apiError(400, 'invalid_request_error', why) }
    if (messages) {
      for (const who of k.person ? ['', k.person] : ['']) {
        const b = budgetOf(d, project, who)
        if (b && spent(d, project, who || undefined) >= b) {
          log('warn', 'budget reached, call refused', { box: project, person: who || undefined, budget: b })
          return apiError(403, 'permission_error', `the monthly AI budget of ${who ? `${who} in ${project}` : project} is used up ($${b.toFixed(2)}); the owner can raise it`)
        }
      }
      if ((inflight.get(project) || 0) >= maxParallel()) {
        log('info', 'cap: call waits', { box: project, inflight: inflight.get(project), max: maxParallel() })
        return apiError(429, 'rate_limit_error', `${project} has ${maxParallel()} calls running already; try again shortly`, { 'retry-after': '5' })
      }
    }
    const headers = new Headers()
    for (const n of PASS_HEADERS) { const v = req.headers.get(n); if (v) headers.set(n, v) }
    // the client's own authorization / x-api-key (the box's mm key) are not among the passed headers: only ours goes up
    const auth = String(getPath(cfg(), 'ai.upstream_auth') || 'x-api-key')
    let beta = betaHeader(req.headers.get('anthropic-beta'), serverOk); if (auth === 'oauth') beta = mergeBeta(beta, OAUTH_BETA)
    if (beta) headers.set('anthropic-beta', beta)
    if (auth === 'bearer' || auth === 'oauth') headers.set('authorization', `Bearer ${key}`); else headers.set('x-api-key', key)
    // oauth only: the client's own identity (Claude Code's user-agent and x-app) goes up as it came, so the upstream sees
    // the client its token is for. Not secret; each cut to 256 characters, dropped if it holds a control character
    if (auth === 'oauth') for (const n of OAUTH_IDENTITY) { const v = req.headers.get(n); if (v && !/[\x00-\x1f\x7f]/.test(v)) headers.set(n, v.slice(0, 256)) }
    let model = messages ? String(parsed.model || '') : ''
    if (messages) inflight.set(project, (inflight.get(project) || 0) + 1)
    let released = false
    const release = () => { if (messages && !released) { released = true; inflight.set(project, Math.max(0, (inflight.get(project) || 1) - 1)) } }
    let up: Response
    try { up = await fetch(`${upstream()}${path}${u.search}`, { method: req.method, headers, body, signal: req.signal }) }
    catch (e) { release(); log('error', 'upstream unreachable', { box: project, error: (e as Error).name }); return apiError(502, 'api_error', 'the upstream did not answer') }
    const out = new Headers(); for (const [n, v] of up.headers) if (!/^(content-encoding|content-length|transfer-encoding|connection|set-cookie)$/i.test(n)) out.set(n, v)
    if (!messages || !up.ok || !up.body) { const b = await up.arrayBuffer(); release(); return new Response(b, { status: up.status, headers: out }) }
    const usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
    if (!/text\/event-stream/.test(up.headers.get('content-type') || '')) {
      const b = await up.arrayBuffer(); release()
      try { const j = JSON.parse(new TextDecoder().decode(b)); usageOf(j.usage, usage); record(project, k.person, String(j.model || model), usage) } catch {}
      return new Response(b, { status: up.status, headers: out })
    }
    // a stream: passed through as it comes; its usage events are read on the way
    const dec = new TextDecoder(); let buf = '', done = false
    const finish = () => { if (done) return; done = true; release(); record(project, k.person, model, usage) }
    const scan = (text: string) => {
      buf += text; let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        try {
          const ev = JSON.parse(line.slice(5))
          if (ev.type === 'message_start') { usageOf(ev.message?.usage, usage); if (ev.message?.model) model = ev.message.model }
          else if (ev.type === 'message_delta') usageOf(ev.usage, usage)
        } catch {}
      }
    }
    const stream = up.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) { scan(dec.decode(chunk, { stream: true })); ctl.enqueue(chunk) },
      flush() { finish() },
    }))
    req.signal.addEventListener('abort', finish)
    return new Response(stream, { status: up.status, headers: out })
  }

  // one socket per box (pc/boxes), kept in step with the registry
  const servers = new Map<string, Server<undefined>>()
  const sync = () => {
    const dir = join(DIRS.pc, 'boxes')
    const want = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).filter((p) => NAME.test(p)) : [])
    for (const [p, s] of servers) if (!want.has(p)) { s.stop(true); servers.delete(p); rmSync(aiSocket(p), { force: true }); log('info', 'socket closed', { box: p }) }
    for (const p of want) {
      if (servers.has(p)) continue
      const sock = aiSocket(p), dir = join(sock, '..'); mkdirSync(dir, { recursive: true, mode: 0o750 }); chmodSync(dir, 0o750); rmSync(sock, { force: true })
      try {
        servers.set(p, Bun.serve({ unix: sock, fetch: (req) => handle(req, p) }))
        // only the owner and its group: the box's proxy connects with the owner's group (box.ts, --group-add); the box
        // itself never mounts this folder (review sy-b15.18)
        chmodSync(sock, 0o660)
        log('info', 'socket open', { box: p })
      } catch (e) { log('error', 'socket failed', { box: p, error: (e as Error).message }) }
    }
  }
  sync(); setInterval(sync, 5000)
  log('info', 'mm.ai up', { upstream: upstream(), upstream_key_input: upstreamInput(cfg()), upstream_auth: String(getPath(cfg(), 'ai.upstream_auth') || 'x-api-key'), max_parallel: maxParallel() })
  await new Promise(() => {})
}
