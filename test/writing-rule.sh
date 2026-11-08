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

# Words between roles (sy-z29t, the owner): short comments, the substance in linked artifacts, diagrams where they help.
A='## Short comments, the work in artifacts'
echo "== the briefs carry the artifact rule (sy-z29t)"
check "project board: leads/CLAUDE.md" grep -qF "$A" "$PROJ/leads/CLAUDE.md"
check "system board: leads/CLAUDE.md" grep -qF "$A" "$SYS/leads/CLAUDE.md"
check "system board: assistants/CLAUDE.md" grep -qF "$A" "$SYS/assistants/CLAUDE.md"
for f in "$PROJ/leads/CLAUDE.md" "$SYS/leads/CLAUDE.md"; do
  check "...each point is there in ${f#$MM_HOME/} (10 lines, artifact path, mermaid, description is the state, close summary)" sh -c "grep -q 'at most about 10 lines' '$f' && grep -qF 'docs/<area>/<item-id>-<slug>.md' '$f' && grep -q 'mermaid' '$f' && grep -q \"description is the current state\" '$f' && grep -q 'one summary comment with the artifact links' '$f'"
done
check "...the system brief sends machine work to the brain's plans/ and keeps mm's public repo clean" sh -c "grep -q \"(machine work: the brain's .plans/.)\" '$SYS/leads/CLAUDE.md' &&grep -q 'nothing of this machine goes in it' '$SYS/leads/CLAUDE.md'"
echo "== config-check holds the artifact rule"
cp "$PROJ/leads/CLAUDE.md" "$T/l.bak"; grep -vF "$A" "$T/l.bak" >"$PROJ/leads/CLAUDE.md"
check "a leads' brief without it: refused, and named" sh -c "! (cd '$PROJ' && node bin/config-check) >'$T/o' 2>&1; grep -q 'leads/CLAUDE.md: lost its \"$A\"' '$T/o'"
cp "$T/l.bak" "$PROJ/leads/CLAUDE.md"
cp "$SYS/assistants/CLAUDE.md" "$T/a.bak"; grep -vF "$A" "$T/a.bak" >"$SYS/assistants/CLAUDE.md"
check "an assistants' brief without it: refused, and named" sh -c "! (cd '$SYS' && node bin/config-check) >'$T/o' 2>&1; grep -q 'assistants/CLAUDE.md: lost its \"$A\"' '$T/o'"
cp "$T/a.bak" "$SYS/assistants/CLAUDE.md"
check "...both back: both boards pass again" sh -c "(cd '$PROJ' && node bin/config-check) && (cd '$SYS' && node bin/config-check)"

# Asking the owner (sy-z5lz, the owner): the owner card rule in the leads' shared brief (both profiles)
C='## Asking the owner: the owner card'
echo "== the briefs carry the owner card rule (sy-z5lz)"
for f in "$PROJ/leads/CLAUDE.md" "$SYS/leads/CLAUDE.md"; do
  check "${f#$MM_HOME/}: the section, the format, edit in place, never needs-you without it" sh -c "grep -qF '$C' '$f' && grep -qF -- '- **You:** Tap Approve | Reply: <the question> | Check: <what, where> | Nothing' '$f' && grep -qF 'bd update ID --body-file' '$f' && grep -q 'bd refuses .needs-you. on an item with no valid' '$f'"
done
echo "== config-check holds the owner card rule"
cp "$PROJ/leads/CLAUDE.md" "$T/l.bak"; grep -vF "$C" "$T/l.bak" >"$PROJ/leads/CLAUDE.md"
check "a leads' brief without it: refused, and named" sh -c "! (cd '$PROJ' && node bin/config-check) >'$T/o' 2>&1; grep -q 'leads/CLAUDE.md: lost its \"$C\"' '$T/o'"
cp "$T/l.bak" "$PROJ/leads/CLAUDE.md"
cp "$SYS/leads/CLAUDE.md" "$T/l.bak"; grep -vF "$C" "$T/l.bak" >"$SYS/leads/CLAUDE.md"
check "the system board's, without it: refused" sh -c "! (cd '$SYS' && node bin/config-check) >'$T/o' 2>&1; grep -q 'leads/CLAUDE.md: lost its \"$C\"' '$T/o'"
cp "$T/l.bak" "$SYS/leads/CLAUDE.md"
check "...back: both boards pass again" sh -c "(cd '$PROJ' && node bin/config-check) && (cd '$SYS' && node bin/config-check)"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
