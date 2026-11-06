// What an assistant (assistants/<user>/, system profile) may have: no tool that acts or reads on its own. What it needs
// comes in the message (the bridge passes it), later through a scoped read tool (mcp__mm_read, checking the human's
// focus). Every built-in tool is denied by name. The list was checked against a real session (`bin/assist tools <user>`
// must show only Skill), and bin/assist kills any run whose session offers a tool outside ALLOWED. Used by config-check
// (render + checks) and bin/assist (CLI flags + the runtime check).
import fs from 'node:fs'
import path from 'node:path'

export const TOOLS_DENIED = ['Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead', 'Read', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'EnterWorktree', 'ExitWorktree', 'ListAgents',
  'PushNotification', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'ToolSearch', 'Workflow', 'Monitor', 'TaskStop', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode', 'SlashCommand']
/** settings.json deny for an assistant: every built-in tool, and the agent manager's MCP server. */
export const DENY = [...TOOLS_DENIED, 'mcp__paseo']
/** allow rules an assistant's template may have; and the tools a running session may offer. */
export const ALLOW_RULES = [/^Skill$/, /^mcp__mm_read(__[\w-]+)?$/]
// StructuredOutput: how a --json-schema run hands back its answer (added by the CLI for schema runs; it does nothing else)
export const toolAllowed = (t) => t === 'Skill' || t === 'StructuredOutput' || /^mcp__mm_read__[\w-]+$/.test(t)

// ---------- the chat session's tools, from its configuration only (sy-la6o) ----------
// An assistant's chat (bin/assist chat) is started by `paseo run`: no deny flags, no strict MCP, only what Claude Code
// reads at start in its folder. chatAudit() decides from those files which tools that session gets, and starts nothing:
// no Claude Code, no MCP server, no hook (the earlier audit started a session, so it ran the folder's MCP servers and
// hooks on every sentinel pass). What it reads:
//   settings  <managed>/managed-settings.json (+ managed-settings.d/*.json), <folder>/.claude/settings.json and
//             settings.local.json, <Claude folder>/settings.json: permissions.deny of every source (a deny anywhere
//             wins), permissions.allow, hooks, enabledPlugins, and the keys that run a command (statusLine, helpers)
//   MCP       <folder>/.mcp.json and .mcp.tmpl.json (config-check renders one into the other), <Claude folder>/.claude.json
//             (user-scope mcpServers, and projects[<folder>].mcpServers), <managed>/managed-mcp.json. Every server
//             counts, approved or not (fail closed).
// What it decides (bin/assist exits 5 on any of these):
//   - a built-in tool it knows (TOOLS_DENIED) that no source denies by name;
//   - an MCP server not denied whole (mcp__<server>): its tools are known only when it runs, so it is "unverified"
//     (a finding), unless the allow list names its tools one by one (mcp__<server>__<tool>), each allowed for an assistant;
//   - an enabled plugin (it can bring MCP servers and hooks); a hook on any event but PreToolUse (those run on their own:
//     SessionStart, UserPromptSubmit...; PreToolUse runs only on a call of a tool the session has, which is what this
//     audits, and the rendered settings carry governance's guard there); a setting that runs a command; a file it can't
//     parse (its denies would be lost).
// Not seen here: a built-in tool a newer CLI adds (not in TOOLS_DENIED: `bin/assist tools <user>` without --chat, a real
// locked-down run, shows it), and what Paseo itself adds at its start. Step 2, not built: audit Paseo's real start, once
// Paseo exposes its start arguments.
const COMMAND_KEYS = ['statusLine', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'fileSuggestion']
const readJson = (f, bad) => { if (!fs.existsSync(f)) return null; try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { bad.push(`unreadable:${f}`); return null } }
const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})

/** dir: the assistant's folder; configDir: its CLAUDE_CONFIG_DIR; managedDir: Claude Code's managed-settings folder. */
export function chatAudit(dir, { configDir, managedDir = '/etc/claude-code' } = {}) {
  dir = path.resolve(dir)
  const bad = [], settings = [], md = path.join(managedDir, 'managed-settings.d')
  for (const f of [path.join(managedDir, 'managed-settings.json'), ...(fs.existsSync(md) ? fs.readdirSync(md).filter((x) => x.endsWith('.json')).sort().map((x) => path.join(md, x)) : []),
    path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'), ...(configDir ? [path.join(configDir, 'settings.json')] : [])]) {
    const j = readJson(f, bad); if (j) settings.push(obj(j))
  }
  const list = (k) => settings.flatMap((s) => (Array.isArray(s.permissions?.[k]) ? s.permissions[k] : [])).map(String)
  const deny = new Set(list('deny')), allow = list('allow')
  const denied = (t) => deny.has(t) || deny.has(`${t}(*)`)
  const tools = ['Skill', ...TOOLS_DENIED].filter((t) => !denied(t)) // the built-in tools it knows, less those denied
  const servers = new Set()
  for (const f of [path.join(dir, '.mcp.json'), path.join(dir, '.mcp.tmpl.json'), path.join(managedDir, 'managed-mcp.json')]) Object.keys(obj(obj(readJson(f, bad)).mcpServers)).forEach((k) => servers.add(k))
  if (configDir) { const u = obj(readJson(path.join(configDir, '.claude.json'), bad)); for (const o of [u.mcpServers, obj(obj(u.projects)[dir]).mcpServers]) Object.keys(obj(o)).forEach((k) => servers.add(k)) }
  const mcp = [...servers].filter((s) => !denied(`mcp__${s}`) && !deny.has(`mcp__${s}__*`)).sort()
  const unverified = []
  for (const s of mcp) {
    const named = allow.filter((a) => a === `mcp__${s}` || a.startsWith(`mcp__${s}__`))
    if (named.length && named.every((a) => /^mcp__[\w-]+__[\w-]+$/.test(a) && toolAllowed(a))) { for (const a of named) if (!denied(a) && !tools.includes(a)) tools.push(a) }
    else unverified.push(s)
  }
  const plugins = settings.flatMap((s) => Object.entries(obj(s.enabledPlugins)).filter(([, on]) => on).map(([k]) => k))
  const hooks = [...new Set(settings.flatMap((s) => Object.keys(obj(s.hooks))))]
  const commands = [...new Set(settings.flatMap((s) => COMMAND_KEYS.filter((k) => s[k] !== undefined)))]
  const extra = [...tools.filter((t) => !toolAllowed(t)), ...unverified.map((s) => `mcp:${s} (unverified tools)`), ...plugins.map((p) => `plugin:${p}`),
    ...hooks.filter((h) => h !== 'PreToolUse').map((h) => `hook:${h}`), ...commands.map((k) => `command:${k}`), ...bad]
  return { tools, mcp, unverified, hooks, extra }
}
