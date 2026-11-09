// The rules of a project memory file (memory/README.md), in one place: config-check runs them on the working tree, and
// bin/memory-commit on each note before it commits it (sy-3wn3).
// Each file says what it is (frontmatter name + description, like the brain's) and when it was last checked and for how
// long it holds (verified + ttl_days, required: the owner, sy-0e5). No defaults: a default would claim a check nobody
// made. MEMORY.md (the index) and README.md have no frontmatter.

/** The files of memory/ that are not notes (no frontmatter). */
export const PLAIN = ['MEMORY.md', 'README.md']

/** What is wrong with memory/<name> holding `text` ([] when nothing). */
export function memoryProblems(name, text) {
  if (PLAIN.includes(name)) return []
  const head = /^---\n([\s\S]*?)\n---/.exec(String(text))
  if (!head || !/^name:\s*\S/m.test(head[1]) || !/^description:\s*\S/m.test(head[1])) return [`memory/${name}: needs frontmatter with name and description`]
  const out = []
  const v = /^\s*verified:\s*(\S+)/m.exec(head[1]), t = /^\s*ttl_days:\s*(\S+)/m.exec(head[1])
  if (!v || !t) out.push(`memory/${name}: needs verified: <YYYY-MM-DD> and ttl_days: <days> under metadata: (when it was last checked, and how long it holds)`)
  if (v && !/^\d{4}-\d\d-\d\d$/.test(v[1])) out.push(`memory/${name}: verified must be a date (YYYY-MM-DD)`)
  if (t && !/^\d+$/.test(t[1])) out.push(`memory/${name}: ttl_days must be a number of days`)
  return out
}
