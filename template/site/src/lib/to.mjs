// Whom a person's comment is for (sy-uykv). A person writes to the board's Lead (leads/roles.json `lead`), who routes
// it on; the board's comment box lets the person pick a role instead ("To"), and stores the pick in the comment itself,
// as its first line:
//   → <role>
//   <the person's words>
// No line: the Lead (on a board with no Lead: the item's assignee, as before). The pick is plain text, so it survives
// bd (a comment is text, nothing else), the bridge's bot and every reader of the thread: a lead sees it in the quoted
// comment, wake reads it with pickOf(). On the public side the board's server puts the writer's role in front
// (`[owner] → review`): pickOf() reads past it. A message (ASK → ops, ...) starts with its intent, never with a bare
// arrow, so the two never meet.
// Pure; used by bin/wake and, as an identical copy, the board's browser code (site/src/lib/to.mjs; test/board-thread.mjs
// keeps them equal).

const LINE = /^(\[[a-z][\w-]*\][ \t]+)?(?:→|->)[ \t]*([a-z][a-z0-9_-]*)[ \t]*(?:\r?\n|$)/

/**
 * The role a comment was sent to, or null (none picked, or not one of `roles` when given).
 * @param {string} text  the comment's text
 * @param {string[]} [roles]  the board's roles
 * @returns {string|null}
 */
export function pickOf(text, roles) {
  const m = LINE.exec(String(text ?? ''))
  return m && (!roles || roles.includes(m[2])) ? m[2] : null
}

/** The comment's words without its pick line (a public side's `[role] ` prefix stays): { to, body }. */
export function splitPick(text, roles) {
  const s = String(text ?? ''), m = LINE.exec(s)
  if (!m || (roles && !roles.includes(m[2]))) return { to: null, body: s }
  return { to: m[2], body: (m[1] || '') + s.slice(m[0].length) }
}

/** The text the comment box sends: the pick line on top when a role is picked (none: to the Lead). */
export const withPick = (text, role) => (role ? `→ ${role}\n${text}` : text)
