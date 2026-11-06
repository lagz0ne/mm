#!/usr/bin/env node
// allow-only — dontAsk's effect for a read or board worker, as a PreToolUse hook (sy-txfn). Paseo's Claude provider
// has no dontAsk mode, so these workers run in auto, and this hook refuses first whatever their own allow list does
// not name: a call outside it is refused, never asked and never left to the classifier.
//   allow-only <kind> <folder>   stdin: the hook's JSON (tool_name, tool_input, cwd). Reads <folder>/.claude/
//   settings.local.json (config-check renders it, and this hook into it, for kind read and board only).
//   stdout: nothing (an allow rule names the call: the deny rules, the guard and the mode decide the rest), or
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}.
// The rule forms it knows (any other form names nothing): Tool and Tool(*); Bash(exact), Bash(prefix *), Bash(prefix*)
// and Bash(prefix:*) (a * inside a word matches within that word only); Read(//abs/**), Read(~/x/**), Read(/rel/**)
// (rel to <folder>) path globs, which Grep, Glob and LS also read by; Edit(...) the same for Edit, Write, MultiEdit and
// NotebookEdit; mcp__server, mcp__server__* and mcp__server__tool. A compound Bash command is allowed only when every
// part is; a substitution, a subshell, a heredoc or a redirect to a file is refused. Reads inside <folder> need no rule
// (as Claude Code's own). It fails closed: bad input, an unreadable settings file or any error denies the call (and
// config-check renders the hook as `... || exit 2`, so even a crash of node blocks).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// tools that act on nothing and ask nothing (a worker's own task list, loading a tool's schema)
const FREE = new Set(['TodoWrite', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])
const READS = { Read: 'file_path', NotebookRead: 'notebook_path', Grep: 'path', Glob: 'path', LS: 'path' }
const EDITS = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** A rule string → { tool, spec } (spec null: the bare tool), or null when it is not a rule. */
export function parseRule(r) {
  if (typeof r !== 'string') return null
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/s.exec(r.trim())
  return m ? { tool: m[1], spec: m[2] === undefined ? null : m[2] } : null
}

/** A shell command → its simple commands (split on && || ; | & and newlines, outside quotes), or null when it has
 *  anything the prefix rules can't see through: $( ), backticks, <( ), subshells or groups, heredocs, redirects to a
 *  file (2>&1 and >/dev/null are fine), an unclosed quote. */
export function splitCommand(cmd) {
  if (typeof cmd !== 'string') return null
  const parts = []
  let cur = '', q = '', i = 0
  const cut = () => { parts.push(cur.trim()); cur = '' }
  while (i < cmd.length) {
    const c = cmd[i], n = cmd[i + 1]
    if (q === "'") { cur += c; if (c === "'") q = ''; i++; continue }
    if (c === '\\') { if (n === '\n') { i += 2; continue } cur += c + (n ?? ''); i += 2; continue }
    if (q === '"') {
      if (c === '`' || (c === '$' && n === '(')) return null
      cur += c; if (c === '"') q = ''; i++; continue
    }
    if (c === "'" || c === '"') { q = c; cur += c; i++; continue }
    if (c === '`' || (c === '$' && n === '(') || c === '(' || c === ')' || (c === '{' && /^\{\s/.test(cmd.slice(i)))) return null
    if (c === '&' && n === '&') { cut(); i += 2; continue }
    if (c === '|' && n === '|') { cut(); i += 2; continue }
    if (c === '|' && n === '&') { cut(); i += 2; continue }
    if (c === ';' || c === '|' || c === '\n') { cut(); i++; continue }
    if (c === '<' || c === '>' || (c === '&' && n === '>')) {
      const r = /^(?:[0-2]?>&[0-2]|&?>{1,2} ?\/dev\/null|[0-2]>{1,2} ?\/dev\/null)(?=\s|$|[;&|])/.exec(cmd.slice(i))
      if (!r) return null
      cur += r[0]; i += r[0].length; continue
    }
    if (c === '&') { cut(); i++; continue }
    if (/[0-2]/.test(c) && (n === '>') && /(^|\s)$/.test(cur)) { const r = /^[0-2](?:>&[0-2]|>{1,2} ?\/dev\/null)(?=\s|$|[;&|])/.exec(cmd.slice(i)); if (!r) return null; cur += r[0]; i += r[0].length; continue }
    cur += c; i++
  }
  if (q) return null
  cut()
  const out = parts.map((p) => p.replace(/\s+/g, ' ')).filter(Boolean)
  return out.length ? out : null
}

/** Does Bash(spec) name this one simple command? */
export function bashMatch(spec, c) {
  let s = spec.trim()
  if (s === '*' || s === '') return s === '*'
  if (s.endsWith(':*')) s = `${s.slice(0, -2)} *`
  let tail = ''
  if (s.endsWith(' *')) { s = s.slice(0, -2); tail = '(?: .*)?' } else if (s.endsWith('*')) { s = s.slice(0, -1); tail = '.*' }
  const body = s.split('*').map(esc).join('[^\\s]*')
  return new RegExp(`^${body}${tail}$`, 's').test(c)
}

/** A path glob (gitignore-like: ** any depth, * and ? within one name) → a RegExp on absolute paths. */
function globRe(g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += esc(c)
  }
  return new RegExp(`^${re}$`, 's')
}

/** A Read/Edit rule's spec → its absolute glob, or null when its form is not one we know. */
function ruleGlob(spec, folder, home) {
  if (typeof spec !== 'string' || !spec) return null
  if (spec.startsWith('//')) return spec.slice(1)
  if (spec.startsWith('~/')) return home ? `${home}/${spec.slice(2)}` : null
  if (spec.startsWith('/')) return `${folder}${spec}`
  return null
}

/** The real path of p, or of its nearest existing parent (with the rest put back). */
function realish(p) {
  let rest = ''
  for (let cur = p; ; cur = path.dirname(cur)) {
    try { return path.join(fs.realpathSync(cur), rest) } catch {}
    if (cur === path.dirname(cur)) return p
    rest = path.join(path.basename(cur), rest)
  }
}

/** Does this absolute glob name p (a folder rule `x/**` names the folder x itself too)? */
const under = (glob, p) => globRe(glob).test(p) || (glob.endsWith('/**') && p === glob.slice(0, -3))
/** ...and its real path too (no symlink out of it), the rule's literal part taken as real as well: a rule on a folder
 *  that is itself a symlink still names what is in it. */
function pathMatch(glob, p) {
  if (!under(glob, p)) return false
  const real = realish(p)
  if (real === p || under(glob, real)) return true
  const lit = glob.split(/[*?]/)[0], cut = lit.endsWith('/') ? lit.slice(0, -1) : lit
  return under(realish(cut) + glob.slice(cut.length), real)
}

/** The absolute path a file tool's input names, or null (none, or not a string). */
function targetOf(tool, input, cwd) {
  const key = READS[tool] || EDITS[tool]
  let p = input?.[key]
  if (p === undefined && (tool === 'Grep' || tool === 'Glob' || tool === 'LS')) p = cwd
  if (typeof p !== 'string' || !p) return null
  return path.resolve(cwd, p)
}

/**
 * The decision: null (an allow rule names the call) or why it is refused.
 *   input: the hook's JSON; settings: the worker's rendered settings; folder: the worker's folder; kind: read|board.
 */
export function decide(input, settings, { folder, kind, home = os.homedir() }) {
  const no = (why) => `a ${kind} worker runs only what its allow list names (dontAsk): ${why}`
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_name) return no('no tool named in the hook input')
  const allow = settings?.permissions?.allow
  if (!Array.isArray(allow)) return no('its settings have no allow list')
  const tool = input.tool_name, ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : folder
  if (FREE.has(tool)) return null
  const rules = allow.map(parseRule).filter(Boolean)
  // the bare tool (or Tool(*)) names every call of it
  if (rules.some((r) => r.tool === tool && (r.spec === null || r.spec === '*'))) return null
  if (tool.startsWith('mcp__')) {
    const [, server] = tool.split('__')
    const ok = rules.some((r) => r.spec === null && (r.tool === tool || r.tool === `mcp__${server}` || r.tool === `mcp__${server}__*`))
    return ok ? null : no(`${tool} is not in it`)
  }
  if (tool === 'Bash') {
    const parts = splitCommand(ti.command)
    if (!parts) return no('a command it cannot read part by part (a substitution, subshell, heredoc or redirect to a file)')
    const bash = rules.filter((r) => r.tool === 'Bash' && typeof r.spec === 'string')
    const off = parts.find((c) => !bash.some((r) => bashMatch(r.spec, c)))
    return off === undefined ? null : no(`\`${off.slice(0, 120)}\` is not in it`)
  }
  const reads = tool in READS, edits = tool in EDITS
  if (!reads && !edits) return no(`${tool} is not in it`)
  const p = targetOf(tool, ti, cwd)
  if (!p) return no(`${tool} names no path`)
  // a Grep or Glob pattern that leaves its path
  for (const k of ['glob', ...(tool === 'Glob' ? ['pattern'] : [])]) {
    const g = ti[k]
    if (g !== undefined && (typeof g !== 'string' || g.startsWith('/') || g.startsWith('~') || /(^|[/{,])\.\.([/},]|$)/.test(g))) return no(`its ${k} leaves the path`)
  }
  const ruleTool = reads ? 'Read' : 'Edit'
  if (reads && pathMatch(`${folder}/**`, p)) return null
  const ok = rules.some((r) => r.tool === ruleTool && (() => { const g = ruleGlob(r.spec, folder, home); return g && pathMatch(g, p) })())
  return ok ? null : no(`${p} is not under its ${ruleTool} rules`)
}

function answer(why) {
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[allow-only] ${why}` } }) + '\n')
  process.exit(0)
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  const [kind, folder] = process.argv.slice(2)
  const k = kind === 'read' || kind === 'board' ? kind : 'read'
  try {
    if (k !== kind || !folder || !path.isAbsolute(folder)) answer(`a ${k} worker runs only what its allow list names (dontAsk): the hook is rendered wrong (allow-only <read|board> <folder>)`)
    let raw = ''
    try { raw = fs.readFileSync(0, 'utf8') } catch {}
    let input = null
    try { input = JSON.parse(raw) } catch {}
    let settings = null
    try { settings = JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.local.json'), 'utf8')) } catch {}
    const why = settings ? decide(input, settings, { folder: path.resolve(folder), kind: k, home: process.env.HOME || os.homedir() })
      : `a ${k} worker runs only what its allow list names (dontAsk): its settings are unreadable`
    if (why) answer(why)
    process.exit(0)
  } catch (e) {
    answer(`a ${k} worker runs only what its allow list names (dontAsk): internal error (${String(e?.message || e).slice(0, 200)})`)
  }
}
