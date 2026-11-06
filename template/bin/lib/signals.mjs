// Typed end signals (plans/slp step 1): a lead ends a unit of work with one comment line whose first word is fixed:
//   HANDOFF <role> <head|artifact> | BLOCKED <why> | DEPENDENCY <item> [why] | REOPEN <item> <why> | DONE <evidence>
// One parser for everything that reads them (bin/wake, the board's lead states, the Supervisor).
export const SIGNALS = ['HANDOFF', 'BLOCKED', 'DEPENDENCY', 'REOPEN', 'DONE']

/** The signal of a comment: the last line whose first word is a signal (leading spaces allowed), as
 *  { kind, rest, role?, ref? } (role: HANDOFF's first argument; ref: DEPENDENCY's and REOPEN's item), or null. */
export function parseSignal(text) {
  let s = null
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([A-Z]+)(?:\s+(.*?))?\s*$/.exec(line)
    if (m && SIGNALS.includes(m[1])) s = { kind: m[1], rest: m[2] || '' }
  }
  if (!s) return null
  const [first = '', ...more] = s.rest.split(/\s+/).filter(Boolean)
  if (s.kind === 'HANDOFF') return { ...s, role: first, what: more.join(' ') }
  if (s.kind === 'DEPENDENCY' || s.kind === 'REOPEN') return { ...s, ref: first, why: more.join(' ') }
  return s
}
