#!/usr/bin/env bash
# The ASD-STE100 rules for words to a person (sy-dz7y, the owner), hermetic: a project board and a system board stamped
# from mm's template as mm new lays them out (nothing started). Proves: the leads' shared brief (both profiles) and the
# assistants' shared brief carry the section, the assistant template points to it from its Language line; config-check
# accepts each board, and refuses one whose leads' or assistants' brief lost the section.
#   test/writing-rule.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset MM_BRAIN MM_PROJECTS MM_SYSTEM MM_BACKUPS
mkdir -p "$HOME"
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const [root, profile] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'shop', project: 'acme-shop', short: 'sh', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, ...(profile === 'system' ? { profile } : {}) }, null, 2) + '\n')
renderTo(root, { ...templateVars(root), profile }, t)
EOF
PROJ="$MM_HOME/projects/acme/shop"; SYS="$MM_HOME/system"
PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$PROJ" project >/dev/null || { echo "stamp failed"; exit 1; }
PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$SYS" system >/dev/null || { echo "stamp failed"; exit 1; }
cc() { (cd "$1" && node bin/config-check "${@:2}"); }
R='## Writing to a person (ASD-STE100)'

echo "== the briefs carry the rules"
check "project board: leads/CLAUDE.md" grep -qF "$R" "$PROJ/leads/CLAUDE.md"
check "system board: leads/CLAUDE.md" grep -qF "$R" "$SYS/leads/CLAUDE.md"
check "system board: assistants/CLAUDE.md, with the person's own language" sh -c "grep -qF '$R' '$SYS/assistants/CLAUDE.md' && grep -q \"person's own language\" '$SYS/assistants/CLAUDE.md'"
check "the assistant template's Language line points to them" grep -q 'Language: .*ASD-STE100' "$SYS/assistants/_template/CLAUDE.md"
check "...each rule is there (8 lines, first line what happened, last line what to do, no ids)" sh -c "grep -q 'about 8 short lines' '$SYS/leads/CLAUDE.md' && grep -q 'First line: what happened. Last line' '$SYS/leads/CLAUDE.md' && grep -q 'No item ids or commit hashes' '$SYS/leads/CLAUDE.md'"

echo "== config-check holds them"
check "the project board renders and passes" cc "$PROJ" --render
check "the system board renders and passes" cc "$SYS" --render
cp "$PROJ/leads/CLAUDE.md" "$T/l.bak"; grep -vF "$R" "$T/l.bak" >"$PROJ/leads/CLAUDE.md"
check "a leads' brief without the section: refused, and named" sh -c "! (cd '$PROJ' && node bin/config-check) >'$T/o' 2>&1; grep -q 'leads/CLAUDE.md: lost its' '$T/o'"
cp "$T/l.bak" "$PROJ/leads/CLAUDE.md"
cp "$SYS/assistants/CLAUDE.md" "$T/a.bak"; grep -vF "$R" "$T/a.bak" >"$SYS/assistants/CLAUDE.md"
check "an assistants' brief without the section: refused, and named" sh -c "! (cd '$SYS' && node bin/config-check) >'$T/o' 2>&1; grep -q 'assistants/CLAUDE.md: lost its' '$T/o'"
cp "$T/a.bak" "$SYS/assistants/CLAUDE.md"
check "...both back: passes again" cc "$SYS"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
