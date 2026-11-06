#!/usr/bin/env node
// bin/lib/allow-only.mjs (sy-txfn), hermetic: the PreToolUse hook that gives a read or board worker dontAsk's effect
// under Paseo's auto mode. For each rule form our worker templates use, a call it names (no objection) and one it does
// not (refused); a compound command with one part not allowed, substitutions and redirects, a path outside the allow
// globs or out through a symlink, an MCP tool not listed, a tool with no rule; and as the hook runs it: bad JSON, no
// settings file, a wrong argument, all refused with the dontAsk message.
//   node test/allow-only.mjs          exit 0 = every check passed
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HOOK = path.join(SRC, 'template', 'bin', 'lib', 'allow-only.mjs')
const { decide, splitCommand } = await import(HOOK)
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'allow-only-')))
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }))
let pass = 0, fail = 0
const ok = (d, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${extra && !c ? `  (${extra})` : ''}`) }

// a worker's folder, a repo it may read, a folder it may not, and a symlink from the first into the last
const W = path.join(T, 'worktrees', 'ops-o1'), REPO = path.join(T, 'mm'), OUT = path.join(T, 'secret'), HOME = path.join(T, 'home')
for (const d of [path.join(W, '.claude'), path.join(REPO, 'src'), OUT, path.join(HOME, 'notes')]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(OUT, 'key'), 'x')
fs.symlinkSync(OUT, path.join(REPO, 'out'))
fs.symlinkSync(REPO, path.join(T, 'mm-link'))
const settings = { permissions: { defaultMode: 'dontAsk', allow: [
  'Bash(bd show *)', 'Bash(bd comments *)', 'Bash(git status*)', 'Bash(cat /proc/loadavg)', 'Bash(cat /proc/pressure/*)', 'Bash(npm run test:*)',
  `Read(/${REPO}/**)`, `Read(/${T}/mm-link/**)`, 'Read(~/notes/**)', 'Read(/docs/**)', 'TodoRead', 'Skill(*)', 'mcp__mm_read', 'mcp__board__show',
], deny: ['Bash(bd comments add*)'] } }
fs.writeFileSync(path.join(W, '.claude', 'settings.local.json'), JSON.stringify(settings))
const ctx = { folder: W, kind: 'board', home: HOME }
const call = (tool_name, tool_input = {}, cwd = W) => decide({ tool_name, tool_input, cwd }, settings, ctx)
const allowed = (d, ...a) => { const r = call(...a); ok(`allowed: ${d}`, r === null, r) }
const refused = (d, ...a) => { const r = call(...a); ok(`refused: ${d}`, typeof r === 'string' && r.startsWith('a board worker runs only what its allow list names (dontAsk)'), r ?? 'allowed') }
const sh = (command) => ['Bash', { command }]

console.log('== Bash(prefix *): the word and anything after it, never a longer word')
allowed('bd show sy-1', ...sh('bd show sy-1'))
allowed('bd comments add sy-1 "a; b && c | d" (operators inside quotes)', ...sh('bd comments add sy-1 "a; b && c | d (e)"'))
allowed("bd comments sy-1 --json 2>&1 (a dup of stderr)", ...sh('bd comments sy-1 --json 2>&1'))
allowed('bd show sy-1 2>/dev/null', ...sh('bd show sy-1 2>/dev/null'))
refused('bd showx', ...sh('bd showx sy-1'))
refused('bd update sy-1 (not in the list)', ...sh('bd update sy-1 --status closed'))
refused('BEADS_ACTOR=x bd show (an env prefix is not the command)', ...sh('BEADS_ACTOR=x bd show sy-1'))
console.log('== Bash(prefix*) and Bash(prefix:*)')
allowed('git status', ...sh('git status'))
allowed('git status --short', ...sh('git status --short'))
allowed('npm run test (legacy :*)', ...sh('npm run test'))
allowed('npm run test -- x', ...sh('npm run test -- x'))
refused('git stash', ...sh('git stash'))
console.log('== Bash(exact), and a * inside a word')
allowed('cat /proc/loadavg', ...sh('cat /proc/loadavg'))
allowed('cat /proc/pressure/cpu', ...sh('cat /proc/pressure/cpu'))
refused('cat /proc/loadavg /etc/shadow (exact means exact)', ...sh('cat /proc/loadavg /etc/shadow'))
refused('cat /proc/meminfo', ...sh('cat /proc/meminfo'))
console.log('== a compound command is allowed only if every part is')
allowed('bd show a && bd show b; git status | bd show c', ...sh('bd show a && bd show b; git status | bd show c'))
refused('bd show a && rm -rf /', ...sh('bd show a && rm -rf /'))
refused('bd show a || bd update a', ...sh('bd show a || bd update a'))
refused('bd show a | sh', ...sh('bd show a | sh'))
refused('bd show a & curl x (background)', ...sh('bd show a & curl x'))
refused('bd show a\\ncurl x (a newline)', ...sh('bd show a\ncurl x'))
console.log('== what the prefix rules cannot see through')
refused('bd show $(curl x)', ...sh('bd show $(curl x)'))
refused('bd show "$(curl x)" (in double quotes too)', ...sh('bd show "$(curl x)"'))
refused('bd show `id`', ...sh('bd show `id`'))
refused('bd show a > /tmp/f (a redirect to a file)', ...sh('bd show a > /tmp/f'))
refused('bd show a < /etc/passwd', ...sh('bd show a < /etc/passwd'))
refused('bd show <<EOF (heredoc)', ...sh('bd show <<EOF\nx\nEOF'))
refused('(bd show a) (a subshell)', ...sh('(bd show a)'))
refused('bd show "unclosed', ...sh('bd show "unclosed'))
refused('an empty command', ...sh(''))
refused('no command at all', 'Bash', {})
ok("single quotes are literal: bd comments add x '$(id)' is one part", JSON.stringify(splitCommand("bd comments add x '$(id)'")) === JSON.stringify(["bd comments add x '$(id)'"]))
console.log('== Read(//abs/**), Read(~/x/**), Read(/rel/**), and Grep, Glob, LS by them')
allowed('Read a file in the repo', 'Read', { file_path: path.join(REPO, 'src', 'a.ts') })
allowed('Grep the repo folder itself', 'Grep', { pattern: 'x', path: REPO })
allowed('Glob in the repo', 'Glob', { pattern: '**/*.ts', path: REPO })
allowed('Read ~/notes/a (~/ form)', 'Read', { file_path: path.join(HOME, 'notes', 'a') })
allowed('Read <folder>/docs/a (the /rel form, from the settings folder)', 'Read', { file_path: path.join(W, 'docs', 'a') })
allowed('Read its own folder without a rule (as Claude Code does)', 'Read', { file_path: path.join(W, 'notes.md') })
allowed('Grep with no path: its cwd, its own folder', 'Grep', { pattern: 'x' })
allowed('Read through a rule on a symlinked folder (mm-link/**)', 'Read', { file_path: path.join(T, 'mm-link', 'src', 'a.ts') })
refused('Read a path outside the allow globs', 'Read', { file_path: path.join(OUT, 'key') })
refused('Read ../ out of the repo', 'Read', { file_path: `${REPO}/../secret/key` })
refused('Read out through a symlink inside the repo', 'Read', { file_path: path.join(REPO, 'out', 'key') })
refused('Read a sibling that only starts like the repo (mm2)', 'Read', { file_path: `${REPO}2/a` })
refused('Grep with no path from a cwd outside', 'Grep', { pattern: 'x' }, OUT)
refused('Glob with a pattern that leaves its path (../)', 'Glob', { pattern: '../secret/*', path: REPO })
refused('Glob with an absolute pattern', 'Glob', { pattern: '/etc/*', path: REPO })
refused('Grep with a glob that leaves its path', 'Grep', { pattern: 'x', path: REPO, glob: '../**' })
refused('Read with no file_path', 'Read', {})
refused('Edit a file in the repo (Read rules name no edit)', 'Edit', { file_path: path.join(REPO, 'a'), old_string: 'a', new_string: 'b' })
refused('Write in its own folder (no Edit rule)', 'Write', { file_path: path.join(W, 'x'), content: '' })
console.log('== Tool, Tool(*), and tools with no rule')
allowed('TodoRead (bare tool)', 'TodoRead')
allowed('Skill (Skill(*))', 'Skill', { skill: 'x' })
allowed('TodoWrite (acts on nothing)', 'TodoWrite', { todos: [] })
refused('WebFetch (no rule)', 'WebFetch', { url: 'https://example.com' })
refused('Agent (no rule)', 'Agent', { prompt: 'x' })
refused('AskUserQuestion (it would reach a phone)', 'AskUserQuestion', {})
console.log('== mcp__server, mcp__server__tool')
allowed('mcp__mm_read__ls (the server listed)', 'mcp__mm_read__ls')
allowed('mcp__board__show (the tool listed)', 'mcp__board__show')
refused('mcp__board__update (its server not listed, another tool is)', 'mcp__board__update')
refused('mcp__paseo__create_agent (not listed)', 'mcp__paseo__create_agent')
refused('mcp__mm_reader__x (a server that only starts like a listed one)', 'mcp__mm_reader__x')
console.log('== bad input')
ok('refused: no input', typeof decide(null, settings, ctx) === 'string')
ok('refused: no tool_name', typeof decide({ tool_input: {} }, settings, ctx) === 'string')
ok('refused: settings with no allow list', typeof decide({ tool_name: 'TodoRead' }, { permissions: {} }, ctx) === 'string')

console.log('== as the hook runs (stdin, stdout, exit)')
const hook = (args, stdin) => spawnSync(HOOK, args, { input: stdin, encoding: 'utf8', env: { ...process.env, HOME } })
const denied = (r) => r.status === 0 && JSON.parse(r.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny'
let r = hook(['board', W], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bd show sy-1' }, cwd: W }))
ok('an allowed call: exit 0, nothing on stdout', r.status === 0 && r.stdout === '', `${r.status} ${r.stdout}${r.stderr}`)
r = hook(['board', W], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'bd update sy-1 --claim' }, cwd: W }))
ok('a refused call: a deny decision with the dontAsk message', denied(r) && r.stdout.includes('a board worker runs only what its allow list names (dontAsk)'), r.stdout + r.stderr)
r = hook(['board', W], '{not json')
ok('bad JSON on stdin: refused', denied(r), r.stdout + r.stderr)
r = hook(['board', W], '')
ok('nothing on stdin: refused', denied(r), r.stdout + r.stderr)
r = hook(['board', path.join(T, 'nowhere')], JSON.stringify({ tool_name: 'TodoRead', cwd: W }))
ok('no settings file: refused', denied(r) && r.stdout.includes('unreadable'), r.stdout + r.stderr)
r = hook(['write', W], JSON.stringify({ tool_name: 'TodoRead', cwd: W }))
ok('a wrong kind argument: refused', denied(r), r.stdout + r.stderr)
r = hook(['read'], JSON.stringify({ tool_name: 'TodoRead', cwd: W }))
ok('no folder argument: refused', denied(r), r.stdout + r.stderr)
r = spawnSync('sh', ['-c', `node ${path.join(T, 'missing.mjs')} board ${W} || exit 2`], { input: '{}', encoding: 'utf8' })
ok('the rendered form `... || exit 2`: a hook that cannot run at all blocks (exit 2)', r.status === 2, String(r.status))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
