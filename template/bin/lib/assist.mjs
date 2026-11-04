// What an assistant (assistants/<user>/, system profile) may have: no tool that acts or reads on its own. What it needs
// comes in the message (the bridge passes it), later through a scoped read tool (mcp__mm_read, checking the human's
// focus). Every built-in tool is denied by name. The list was checked against a real session (`bin/assist tools <user>`
// must show only Skill), and bin/assist kills any run whose session offers a tool outside ALLOWED. Used by config-check
// (render + checks) and bin/assist (CLI flags + the runtime check).
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
