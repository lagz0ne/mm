#!/usr/bin/env bash
# Whose Claude memory is the project's (review, sy-0e5), hermetic: a system board stamped from mm's template (nothing
# started), its bin/lib/claude.mjs run as bin/lead, bin/wt and bin/assist run it. Proves: a lead's folder, setup's, a
# lead's own worktree and the root link to <root>/memory; a worker's and an assistant's (--no-memory) don't, and a note
# written there doesn't reach <root>/memory; --no-memory removes a link a worker had (from before this fix); forget
# (wt rm) removes a folder's trust and entry; prune removes dead links and workers', keeps the leads'; nothing in
# <root>/memory is ever deleted.
#   test/memory-links.sh
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
const [root] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'mm', name: 'system', project: 'system', short: 'sy', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, profile: 'system' }, null, 2) + '\n')
renderTo(root, { ...templateVars(root), profile: 'system' }, t)
EOF
S="$MM_HOME/system"
PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$S" >/dev/null || { echo "stamp failed"; exit 1; }
cl() { (cd "$S" && MM_PROJECT=system node bin/lib/claude.mjs "$@"); }
D=$(cl dir); MEM="$S/memory"
at() { echo "$D/projects/$(printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g')/memory"; }
linked() { [ -L "$(at "$1")" ] && [ "$(readlink "$(at "$1")")" = "$MEM" ]; }
LEAD="$S/leads/ops"; SETUP="$S/setup"; LWT="$S/worktrees/lead-ops"; WK="$S/worktrees/review-actors"; AS="$S/assistants/alex"
mkdir -p "$LEAD" "$SETUP" "$LWT" "$WK" "$AS"

echo "== who shares the project's memory"
cl trust "$LEAD" "$S" >/dev/null; cl trust "$SETUP" "$LWT" >/dev/null
check "a lead's folder links to <root>/memory" linked "$LEAD"
check "setup's, a lead's own worktree and the root too" sh -c "$(declare -f at linked); D='$D' MEM='$MEM'; linked '$SETUP' && linked '$LWT' && linked '$S'"
cl trust --no-memory "$WK" >/dev/null; (cd "$S" && MM_PROJECT=system node -e "import('./bin/lib/claude.mjs').then((c) => c.trust(['$AS'], 'system', { memory: false }))")
check "a worker's folder (wt, --no-memory): no link" sh -c "! [ -L '$(at "$WK")' ]"
check "an assistant's (assist, memory: false): no link" sh -c "! [ -L '$(at "$AS")' ]"
check "...both are still trusted (the trust dialog stays accepted)" sh -c "jq -e '.projects[\"$WK\"].hasTrustDialogAccepted and .projects[\"$AS\"].hasTrustDialogAccepted' '$D/.claude.json'"
mkdir -p "$(at "$WK")"; echo 'a worker note' >"$(at "$WK")/w.md"
check "a note written in a worker's memory does not appear in <root>/memory" sh -c "! grep -rq 'a worker note' '$MEM'"

echo "== a link from before the fix"
WK2="$S/worktrees/platform-old"; mkdir -p "$WK2"; cl trust "$WK2" >/dev/null   # as before sy-0e5: linked
check "(a worker linked the old way)" linked "$WK2"
cl trust --no-memory "$WK2" >/dev/null
check "--no-memory removes that link; <root>/memory keeps all its files" sh -c "! [ -L '$(at "$WK2")' ] && [ -d '$MEM' ]"

echo "== forget (wt rm) and prune"
WK3="$S/worktrees/ops-gone"; mkdir -p "$WK3"; cl trust "$WK3" >/dev/null; rmdir "$WK3"   # an old wt rm left its link
WK4="$S/worktrees/review-live"; mkdir -p "$WK4"; cl trust "$WK4" >/dev/null           # a live worker linked the old way
echo 'a lead note' >"$MEM/lead.md"
out=$(cl prune)
check "prune: a removed worktree's link goes" sh -c "! [ -L '$(at "$WK3")' ] && grep -q -- '-worktrees-ops-gone' <<<'$out'"
check "...and a live worker's link from before the fix" sh -c "! [ -L '$(at "$WK4")' ]"
check "...the leads', setup's, the lead worktree's and the root's stay" sh -c "$(declare -f at linked); D='$D' MEM='$MEM'; linked '$LEAD' && linked '$SETUP' && linked '$LWT' && linked '$S'"
check "...and <root>/memory is untouched (the lead's note is there)" grep -q 'a lead note' "$MEM/lead.md"
WK5="$S/worktrees/review-done"; mkdir -p "$WK5"; cl trust --no-memory "$WK5" >/dev/null; cl forget "$WK5"
check "forget: its trust and its (empty) entry are gone" sh -c "! jq -e '.projects[\"$WK5\"]' '$D/.claude.json' && ! [ -e '$(dirname "$(at "$WK5")")' ]"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
