// Runs a board's bin/guard on cases from guard-cases.mjs, as Claude Code calls it (the hook's JSON on stdin), in
// parallel. Prints each mismatch and "<list>: <pass>/<n>"; exit 1 on any mismatch.
//   node test/lib/guard-run.mjs <board root> <list>[@<actor>] [...]
// Each call runs as the session <actor> (BEADS_ACTOR, as config-check renders it into a lead's settings; default code).
import { spawn } from 'node:child_process'
import * as CASES from './guard-cases.mjs'

const [root, ...lists] = process.argv.slice(2)
const KEY = { Bash: 'command', Read: 'file_path', Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Grep: 'path', Glob: 'pattern' }
function call(tool, value, actor) {
  const input = { [KEY[tool]]: value, ...(tool === 'Grep' ? { pattern: 'x' } : {}), ...(tool === 'Edit' ? { old_string: 'a', new_string: 'b' } : {}) }
  return new Promise((resolve) => {
    const p = spawn(`${root}/bin/guard`, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'BD_ACTOR')), BEADS_ACTOR: actor } })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', (code) => {
      if (code !== 0) return resolve(`exit ${code}`)
      if (!out.trim()) return resolve('allow')
      try { resolve(JSON.parse(out).hookSpecificOutput.permissionDecision) } catch { resolve(`bad output ${out.trim()}`) }
    })
    p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: `${root}/leads/code`, tool_name: tool, tool_input: input }))
  })
}
let bad = 0
for (const arg of lists) {
  const [name, actor = 'code'] = arg.split('@')
  const cases = CASES[name]
  if (!cases) { console.error(`no case list ${name}`); process.exit(2) }
  const got = []
  for (let i = 0; i < cases.length; i += 16) got.push(...await Promise.all(cases.slice(i, i + 16).map(([t, v]) => call(t, v.replaceAll('{root}', root), actor))))
  let pass = 0
  cases.forEach(([tool, value, want, why], i) => {
    if (got[i] === want) pass++
    else { bad++; console.log(`FAIL ${name} ${tool} ${JSON.stringify(value)}: want ${want}, got ${got[i]}${why ? ` (${why})` : ''}`) }
  })
  console.log(`${arg}: ${pass}/${cases.length}`)
}
process.exit(bad ? 1 : 0)
