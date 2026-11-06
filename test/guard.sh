#!/usr/bin/env bash
# bin/guard, the PreToolUse hook of every lead and setup (sy-8t0.5), hermetic: a throwaway HOME / MM_HOME and two
# boards rendered from mm's template as mm new lays them out (nothing started): a project, and one with the system
# profile. Proves: config-check renders the guard into every role's and setup's settings by its absolute path and
# refuses a settings file without it; the guard denies what the brain's guard denies a lead (its cases, ported), the
# spellings it adds (secret reads through $( ), python3 -c, node -e, base64, a here-string; sudo in any form; mm's
# owner-only commands; the approval path's files), and lets a lead's normal work through; its answer is the hook's
# exact JSON; a bad input or a broken rules file denies (fail closed); its rules are plain data Python can read.
#   test/guard.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
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
export -f cc
settings() { ls "$1"/leads/*/.claude/settings.json "$1/setup/.claude/settings.json"; }

echo "== config-check renders the guard into every lead's and setup's settings, by its absolute path"
check "the project renders (config-check --render)" cc "$PROJ" --render
check "the system board renders" cc "$SYS" --render
for B in "$PROJ" "$SYS"; do
  n=0; for f in $(settings "$B"); do
    if jq -e --arg g "$B/bin/guard" '.hooks.PreToolUse[0] | (.matcher | split("|")) as $m | (["Bash","Read","Edit","Write","MultiEdit","NotebookEdit","Grep"] - $m | length == 0) and .hooks[0].type == "command" and .hooks[0].command == $g' "$f" >/dev/null
    then n=$((n+1)); else bad "no guard hook first in ${f#$T/}"; fi
  done
  [ "$n" -ge 4 ] && ok "${B#$T/}: the guard runs first in all $n settings (leads and setup), as $B/bin/guard"
done
check "the system board keeps governance's own hook too (the brain's guard), after it: the installed copy, never the brain's working tree (sy-ehq4)" bash -c "for f in $SYS/leads/*/.claude/settings.json; do jq -e '.hooks.PreToolUse[1].hooks[0].command | (contains(\"/.local/lib/brain/guard\") and (contains(\"/brain/bin/guard\") | not))' \"\$f\" >/dev/null || exit 1; done"
# the hook command itself: the installed guard runs when it is there; when it is missing, the call is denied (never let through)
BG=$(jq -r '.hooks.PreToolUse[1].hooks[0].command' "$(ls $SYS/leads/*/.claude/settings.json | head -1)")
printf '%s' "$BG" >"$T/bg.sh"   # the hook command as rendered (the installed guard is not there yet in this HOME)
check "...with no installed guard: the hook denies (the deny answer, exit 0)" bash -c "out=\$(echo '{}' | sh '$T/bg.sh') && echo \"\$out\" | jq -e '.hookSpecificOutput.permissionDecision == \"deny\"' >/dev/null"
mkdir -p "$HOME/.local/lib/brain"; printf '#!/bin/sh\necho installed-guard-ran\n' >"$HOME/.local/lib/brain/guard"; chmod +x "$HOME/.local/lib/brain/guard"
check "...with the installed guard: it runs, and only it answers" bash -c "[ \"\$(echo '{}' | sh '$T/bg.sh')\" = installed-guard-ran ]"
rm -rf "$HOME/.local/lib/brain"
check "an assistant does not get the guard (a read-only assistant has no tool it reads)" bash -c "! grep -q '$SYS/bin/guard' '$SYS/assistants/_template/.claude/settings.json'"
CMD=$(jq -r '.hooks.PreToolUse[0].hooks[0].command' "$PROJ/leads/code/.claude/settings.json")
check "the rendered hook command runs: sudo true is denied, git status passes" bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"sudo true\"}}' | sh -c '$CMD' | grep -q '\"deny\"' && test -z \"\$(printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git status\"}}' | sh -c '$CMD')\""

echo "== config-check refuses a settings file without it"
f="$PROJ/leads/code/.claude/settings.json"; cp "$f" "$T/keep.json"
jq 'del(.hooks)' "$T/keep.json" >"$f"
check "a lead's settings without the hook: refused, and it says why" bash -c "! cc '$PROJ' >'$T/cc.out' 2>&1 && grep -q 'code: settings.json must run the guard hook $PROJ/bin/guard' '$T/cc.out'"
jq --arg g "$T/other/bin/guard" '.hooks.PreToolUse[0].hooks[0].command = $g' "$T/keep.json" >"$f"
check "...a hook naming another guard: refused" bash -c "! cc '$PROJ' >/dev/null 2>&1"
jq '.hooks.PreToolUse[0].matcher = "Bash"' "$T/keep.json" >"$f"
check "...the guard on Bash only: refused" bash -c "! cc '$PROJ' >/dev/null 2>&1"
jq '.disableAllHooks = true' "$T/keep.json" >"$f"
check "...disableAllHooks: refused" bash -c "! cc '$PROJ' >'$T/cc.out' 2>&1 && grep -q 'disableAllHooks is not allowed' '$T/cc.out'"
cp "$T/keep.json" "$f"
s="$PROJ/setup/.claude/settings.json"; cp "$s" "$T/keep-setup.json"
jq 'del(.hooks)' "$T/keep-setup.json" >"$s"
check "setup's settings without the hook: refused" bash -c "! cc '$PROJ' >'$T/cc.out' 2>&1 && grep -q 'setup: settings.json must run the guard hook' '$T/cc.out'"
cp "$T/keep-setup.json" "$s"
chmod -x "$PROJ/bin/guard"
check "bin/guard not executable: refused" bash -c "! cc '$PROJ' >'$T/cc.out' 2>&1 && grep -q 'bin/guard is missing or not executable' '$T/cc.out'"
chmod +x "$PROJ/bin/guard"
check "...all back: config-check passes" cc "$PROJ"
check "...and a render puts a removed hook back" bash -c "jq 'del(.hooks)' '$T/keep.json' >'$f' && cc '$PROJ' --render >/dev/null && cc '$PROJ' >/dev/null"

echo "== what it denies and allows (cases: test/lib/guard-cases.mjs)"
check "a project lead: the brain guard's cases that apply, the spellings it adds, and 34 normal commands" node "$SRC/test/lib/guard-run.mjs" "$PROJ" BRAIN OWN NORMAL
sed -n 's/^\(BRAIN\|OWN\|NORMAL\): /       /p' "$T/check.out"
check "the system board: sudo -n is its ops' and review's (the brain's guard governs it); every other rule holds" node "$SRC/test/lib/guard-run.mjs" "$SYS" SYSTEM NORMAL
sed -n 's/^\(SYSTEM\|NORMAL\): /       /p' "$T/check.out"
cp -r "$PROJ" "$T/boxed"; printf 'profile: system\nbox: true\n' >"$T/boxed/.mm-answers.yaml"
check "a box that says it is the system profile gets the project's rule (sudo denied)" bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"sudo -n true\"}}' | '$T/boxed/bin/guard' | grep -q '\"deny\"'"

echo "== approvals (sy-h2yt): the owner's name in the run files; no agent writes as an approver or sets approved"
cat >"$T/runfiles.ts" <<EOF
import { join } from 'node:path'
import { writeRunFiles } from '$SRC/src/project'
writeRunFiles(process.argv[2], join(process.env.MM_HOME!, 'pc.sock'))
EOF
printf 'owner_name: alex\n' >"$MM_HOME/config.yaml"
check "mm writes the owner's name (config owner_name) into the board's .run/endpoints.json" bash -c "PATH='$HOME/.bun/bin:$PATH' bun '$T/runfiles.ts' '$PROJ' && jq -e '.owner_name == \"alex\"' '$PROJ/.run/endpoints.json'"
rm -f "$MM_HOME/config.yaml"
check "...and none when owner_name is not set" bash -c "PATH='$HOME/.bun/bin:$PATH' bun '$T/runfiles.ts' '$SYS' && jq -e 'has(\"owner_name\") | not' '$SYS/.run/endpoints.json'"
check "the guard: the bridge's and the owner's name (any case) and approved are the owner's; other actors and labels pass" node "$SRC/test/lib/guard-run.mjs" "$PROJ" APPROVER
sed -n 's/^APPROVER: /       /p' "$T/check.out"
check "...no owner_name: the bridge and approved stay denied, a person's name is free" node "$SRC/test/lib/guard-run.mjs" "$SYS" APPROVER_NO_OWNER

echo "== the hook's answer"
G="$PROJ/bin/guard"
hook() { printf '%s' "$1" | "${@:2}" "$G"; }
out=$(hook '{"tool_name":"Bash","tool_input":{"command":"sudo true"}}'); rc=$?
want='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[guard] runs a command as another user (sudo, doas, pkexec, su): a lead never does. Ask the owner on the board."}}'
if [ $rc = 0 ] && [ "$out" = "$want" ]; then ok "a deny is exactly the hook's JSON (exit 0)"; else bad "a deny is exactly the hook's JSON: rc $rc, $out"; fi
out=$(hook '{"tool_name":"Read","tool_input":{"file_path":"/home/alice/.ssh/id_ed25519"}}')
if jq -e '.hookSpecificOutput.permissionDecision == "deny" and (.hookSpecificOutput.permissionDecisionReason | test("^\\[guard\\] .*/home/alice/.ssh/id_ed25519"))' <<<"$out" >/dev/null; then ok "a file deny names the path"; else bad "a file deny names the path: $out"; fi
out=$(hook '{"tool_name":"Bash","tool_input":{"command":"git status"}}'); rc=$?
if [ $rc = 0 ] && [ -z "$out" ]; then ok "no objection: no output, exit 0 (the permission rules decide)"; else bad "no objection: rc $rc, $out"; fi
out=$(hook '{"tool_name":"mcp__paseo__list_agents","tool_input":{}}'); [ -z "$out" ] && ok "a tool it does not read: no objection" || bad "a tool it does not read: $out"

echo "== fail closed"
for inp in 'not json' '' 'null' '[]x' '{"tool_name":"Bash","tool_input":"sudo true"}' '{"tool_name":"Bash","tool_input":{}}' '{"tool_name":"Read","tool_input":7}'; do
  out=$(hook "$inp"); rc=$?
  if [ $rc = 0 ] && jq -e '.hookSpecificOutput.permissionDecision == "deny" and (.hookSpecificOutput.permissionDecisionReason | startswith("[guard] guard error"))' <<<"$out" >/dev/null; then ok "bad input ${inp:-(empty)}: denied"; else bad "bad input ${inp:-(empty)}: rc $rc, $out"; fi
done
out=$(hook '{"tool_name":"Bash","tool_input":{"command":"ls"}}' env MM_GUARD_TEST_RAISE=1)
grep -q '"deny"' <<<"$out" && ok "an internal error: denied" || bad "an internal error: $out"
mkdir -p "$T/broken/bin/lib"; cp "$G" "$T/broken/bin/guard"
out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | "$T/broken/bin/guard")
grep -q '"deny"' <<<"$out" && ok "no rules file: denied" || bad "no rules file: $out"
echo 'export const RULES = {' >"$T/broken/bin/lib/guard-rules.mjs"
out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | "$T/broken/bin/guard")
grep -q '"deny"' <<<"$out" && ok "a rules file that does not parse: denied" || bad "a rules file that does not parse: $out"
echo 'export const RULES = { parts: {}, rules: [{ id: "x", on: "bash", re: "{{NOPE}}", why: "x" }] }' >"$T/broken/bin/lib/guard-rules.mjs"
out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | "$T/broken/bin/guard")
grep -q 'unknown part NOPE' <<<"$out" && ok "a rule naming an unknown part: denied" || bad "a rule naming an unknown part: $out"
echo 'export const RULES = { parts: {}, rules: [{ id: "x", on: "bash", re: "(", why: "x" }] }' >"$T/broken/bin/lib/guard-rules.mjs"
out=$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | "$T/broken/bin/guard")
grep -q '"deny"' <<<"$out" && ok "a rule that is not a regex: denied" || bad "a rule that is not a regex: $out"

echo "== the rules are plain data another guard can read (Python: the brain's guard)"
cat >"$T/rules.py" <<'EOF'
import json, re, sys
t = open(sys.argv[1]).read()
d = json.loads(t.split('// BEGIN RULES\n', 1)[1].split('// END RULES', 1)[0])
parts = dict(d["parts"], ROOT="(?!)", OWNER="(?!)")
def expand(s, n=0):
    return re.sub(r"\{\{(\w+)\}\}", lambda m: expand(parts[m.group(1)], n + 1), s)
for r in d["rules"]:
    re.compile(expand(r["re"]))
    if r.get("and"):
        re.compile(expand(r["and"]))
# the same answers as the guard on a few lines (no free path here: these are not bd commands)
def deny(cmd):
    return any(r["on"] == "bash" and re.search(expand(r["re"]), cmd) and (not r.get("and") or re.search(expand(r["and"]), cmd))
               for r in d["rules"])
want = {"cat ~/.config/secrets/x": True, "sudo -n true": True, "mm token owner shop": True, "git status": False, "ls -l ~/.ssh/": False,
        "bd label add sy-1 approved": True, "bd update sy-1 --actor bridge": True, "bd list -l approved": False}
bad = [c for c, w in want.items() if deny(c) != w]
print(f"{len(d['rules'])} rules compile in Python; {len(want) - len(bad)}/{len(want)} answers match")
sys.exit(1 if bad else 0)
EOF
check "the block between BEGIN and END RULES is JSON; every rule compiles in Python's re and answers the same" python3 -I "$T/rules.py" "$SRC/template/bin/lib/guard-rules.mjs"
sed 's/^/       /' "$T/check.out"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
