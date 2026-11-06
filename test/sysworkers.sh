#!/usr/bin/env bash
# Workers on the system board (sy-asaw), hermetic: a throwaway HOME / MM_HOME, a system board rendered from mm's
# template as mm new lays it out (nothing started), a throwaway git repo standing in for mm's, a stub paseo and a stub
# bd. Proves: workers are off as shipped (wt and lead worker refuse); switched on, wt makes each kind's folder (write:
# a worktree on its own branch; read: a detached checkout; board: a plain folder) and config-check renders each one's
# permissions with the worker denies (asserted, and a lost one is refused); wt refuses the brain (or a repo holding it)
# and config-check refuses such a spec, and a write repo outside the role's write roots; a lead's allow rules name only
# its own workers; lead worker start needs the item claimed, counts each worker as a place within the role's capacity
# and the project's cap, and starts the agent with its labels, mode and actor; report, stop, wt rm.
#   test/sysworkers.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
refused() { [ "$1" -ne 0 ] && grep -q -- "$3" <<<"$2"; } # refused <rc> <output> <pattern>
says() { grep -q -- "$2" <<<"$1"; }                        # says <output> <pattern>
lsok() { grep -qE '^platform +w2 +ab-1' <<<"$1" && grep -qE '^review +r2 +ab-3' <<<"$1"; }
stopok() { grep -q 'archived platform/w2' <<<"$1" && grep -qF '"archive","--force","ag1"' "$STUB_PASEO.log"; }
wtlsok() { grep -q '^platform-w1 ' <<<"$1" && grep -q '^review-r2 ' <<<"$1"; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_OBS_METRICS="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset WAKE_CAP MM_BRAIN MM_PROJECTS MM_SERVICE
mkdir -p "$HOME"
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const [root, profile] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'b', project: 'acme-b', short: 'ab', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, ...(profile === 'system' ? { profile } : {}) }, null, 2) + '\n')
renderTo(root, { ...templateVars(root), profile }, t)
EOF
SYS="$T/sys"
PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$SYS" system >/dev/null || { echo "stamp failed"; exit 1; }
cc() { (cd "$SYS" && node bin/config-check "$@" 2>&1); }
cc --render >/dev/null
# mm's repo (where the system profile's roles.json says it is: {home}/mm), and a brain
for r in "$HOME/mm" "$HOME/.mm/brain"; do mkdir -p "$r"; git -C "$r" init -q -b main; echo x >"$r/README.md"; git -C "$r" add README.md; git -C "$r" commit -qm init; done
RJ="$SYS/leads/roles.json"
roles() { jq "$1" "$RJ" >"$T/r.json" && cp "$T/r.json" "$RJ"; }
S="settings.local.json"
denies() { jq -r '.permissions.deny[]' "$1/.claude/$S"; }
has()  { denies "$1" | grep -xF -- "$2" >/dev/null; }
allows() { jq -r '.permissions.allow[]' "$1/.claude/$S"; }
hasA() { allows "$1" | grep -xF -- "$2" >/dev/null; }

echo "== as shipped: workers off"
check "config-check passes on the system board as rendered" bash -c "cd '$SYS' && node bin/config-check >/dev/null 2>&1"
out=$("$SYS/bin/wt" platform w0 2>&1); rc=$?
check "wt platform w0 refuses: not switched on (exit $rc)" refused $rc "$out" 'not switched on'
check "...and made nothing" test ! -e "$SYS/worktrees/platform-w0"

echo "== switched on (setup's step): wt makes each kind's folder, config-check renders its permissions"
roles '.roles |= map(.workers = true)'
cc --render >/dev/null
W="$SYS/worktrees"
P1=$("$SYS/bin/wt" platform w1 2>"$T/err"); rc=$?
check "wt platform w1 prints its folder (exit $rc)" test "$rc" = 0 -a "$P1" = "$W/platform-w1"
check "...a worktree of mm's repo on its own branch w1" test "$(git -C "$P1" rev-parse --abbrev-ref HEAD 2>/dev/null)" = w1
check "...whose rendered permissions git ignores" bash -c "[ -z \"\$(git -C '$P1' status --porcelain)\" ]"
R1=$("$SYS/bin/wt" review r1 2>>"$T/err")
check "wt review r1: a detached checkout of main" bash -c "[ '$R1' = '$W/review-r1' ] && [ \"\$(git -C '$R1' rev-parse --abbrev-ref HEAD)\" = HEAD ] && [ \"\$(git -C '$R1' rev-parse HEAD)\" = \"\$(git -C '$HOME/mm' rev-parse main)\" ]"
O1=$("$SYS/bin/wt" ops o1 2>>"$T/err")
check "wt ops o1: a plain folder (no repo)" bash -c "[ '$O1' = '$W/ops-o1' ] && [ -d '$O1' ] && [ ! -e '$O1/.git' ]"
check "config-check passes with the three workers" bash -c "cd '$SYS' && node bin/config-check >/dev/null 2>&1"

echo "== a platform worker writes only its own worktree"
for f in "$P1" "$R1" "$O1"; do check "$(basename "$f"): its settings file is there" test -f "$f/.claude/$S"; done
check "platform-w1's board actor is platform/w1" test "$(jq -r .env.BEADS_ACTOR "$P1/.claude/$S")" = platform/w1
check "...it may edit its own worktree" hasA "$P1" "Edit(/$W/platform-w1/**)"
for d in "Edit(/$HOME/mm/**)" "Edit(/$HOME/.mm/brain/**)" "Edit(/$W/review-r1/**)" "Edit(/$W/ops-o1/**)" "Edit(/$W/platform-w1/.claude/**)" \
  "Edit(/$SYS/leads/**)" "Edit(/$SYS/bin/**)" "Edit(/$SYS/governance.json)" "Edit(/$SYS/worktrees/CLAUDE.md)" \
  "Bash(mm *)" "Bash(*$HOME/.mm/bin/mm*)" "Bash(mm update*)" "Bash(mm up*)" "Bash(sudo *)" "Bash(git push*)" "Bash(git tag*)" "Bash(*brain migrate*)" "Bash(*bin/brain*)" \
  "Bash(bd comments add*)" "Bash(bd update*)" "Bash(bd close*)" "Bash(*bd --actor*)" "Bash(*BEADS_ACTOR*)" "Bash(lead *)" "Bash(wt *)" "Bash(paseo *)" "mcp__paseo" \
  "Bash(*test/lifecycle.sh*)" "Bash(*test/box.sh*)" "Read(/$HOME/.mm/vault/**)"; do
  check "platform-w1 denies $d" has "$P1" "$d"
done
check "...and runs the guard" bash -c "jq -e '.hooks.PreToolUse[0].hooks[0].command | startswith(\"mm_g=\$( \") and contains(\"/bin/guard\\n)\")' '$P1/.claude/$S' >/dev/null"

echo "== a review worker reads only; an ops worker reads and comments"
check "review-r1 refuses what is not allowed (defaultMode dontAsk)" test "$(jq -r .permissions.defaultMode "$R1/.claude/$S")" = dontAsk
check "ops-o1 refuses what is not allowed (defaultMode dontAsk)" test "$(jq -r .permissions.defaultMode "$O1/.claude/$S")" = dontAsk
for d in Edit Write NotebookEdit "Bash(git commit*)" "Bash(git checkout*)" "Bash(rm *)" "Bash(bd comments add*)" "Bash(bd update*)" "Bash(sudo *)" "Bash(mm update*)" "Edit(/$W/platform-w1/**)"; do
  check "review-r1 denies $d" has "$R1" "$d"
done
check "review-r1 allows no Edit or Write at all" bash -c "! jq -r '.permissions.allow[]' '$R1/.claude/$S' | grep -qE '^(Edit|Write)'"
for d in Edit Write "Bash(bd update*)" "Bash(bd close*)" "Bash(bd create*)" "Bash(*brain run*)" "Bash(*brain migrate*)" "Bash(*brain promote*)" "Bash(mm restart*)" "Bash(sudo *)" "Bash(*bd --actor*)"; do
  check "ops-o1 denies $d" has "$O1" "$d"
done
check "ops-o1 may comment (bd comments add is not denied), as ops/o1" bash -c "! jq -r '.permissions.deny[]' '$O1/.claude/$S' | grep -qxF 'Bash(bd comments add*)' && [ \"\$(jq -r .env.BEADS_ACTOR '$O1/.claude/$S')\" = ops/o1 ]"
# dontAsk's effect under Paseo's auto (sy-txfn): the allow-only hook, first, on every tool, for read and board only
aoc() { jq -r '.hooks.PreToolUse[0] | select(.matcher == "*") | .hooks[0].command' "$1/.claude/$S"; }
check "review-r1 runs the allow-only hook first, on every tool (matcher *)" bash -c "[ \"\$(jq -r '.hooks.PreToolUse[0].hooks[0].command' '$R1/.claude/$S')\" = '$SYS/bin/lib/allow-only.mjs read $W/review-r1 || exit 2' ] && [ \"\$(jq -r '.hooks.PreToolUse[0].matcher' '$R1/.claude/$S')\" = '*' ]"
check "ops-o1 runs it as a board worker, on its own folder" test "$(aoc "$O1")" = "$SYS/bin/lib/allow-only.mjs board $W/ops-o1 || exit 2"
check "...and the guard still, after it" bash -c "jq -e '.hooks.PreToolUse[1].hooks[0].command | endswith(\"/bin/guard\")' '$O1/.claude/$S' >/dev/null"
check "platform-w1 (write) has no allow-only hook (auto, option b)" bash -c "! grep -q allow-only '$P1/.claude/$S'"
hk() { (cd "$O1" && printf '%s' "$2" | sh -c "$(aoc "$O1")"); } # hk <folder> <hook input>: the rendered command, as Claude Code runs it
hin() { jq -cn --arg t "$1" --arg c "$2" --arg w "$O1" '{tool_name: $t, tool_input: {command: $c}, cwd: $w}'; }
out=$(hk "$O1" "$(hin Bash 'bd show ab-1 --json')"); check "ops-o1's hook, as rendered: bd show (in its allow list) passes" test -z "$out"
out=$(hk "$O1" "$(hin Bash 'bd update ab-1 --status closed')"); check "...bd update (not in it) is refused: 'a board worker runs only what its allow list names (dontAsk)'" bash -c "jq -e '.hookSpecificOutput.permissionDecision == \"deny\"' <<<'$out' >/dev/null && grep -qF 'a board worker runs only what its allow list names (dontAsk)' <<<'$out'"
out=$(hk "$O1" "$(hin Bash 'bd show ab-1 && curl -s example.com')"); check "...a compound command with one part not in it is refused" grep -q '"deny"' <<<"$out"
out=$(hk "$O1" "$(jq -cn --arg w "$O1" '{tool_name: "WebFetch", tool_input: {url: "https://example.com"}, cwd: $w}')"); check "...a tool with no rule (WebFetch) is refused" grep -q '"deny"' <<<"$out"
out=$(hk "$O1" "$(jq -cn --arg w "$O1" '{tool_name: "Read", tool_input: {file_path: "/root/x"}, cwd: $w}')"); check "...a Read outside its Read rules is refused" grep -q '"deny"' <<<"$out"
out=$(hk "$O1" "$(jq -cn --arg w "$O1" --arg f "$HOME/.mm/brain/README.md" '{tool_name: "Read", tool_input: {file_path: $f}, cwd: $w}')"); check "...a Read of the brain (Read({brain}/**)) passes" test -z "$out"
out=$(hk "$O1" 'not json'); check "...bad JSON is refused" grep -q '"deny"' <<<"$out"
check "the leads, with workers on, may not edit worktrees/ nor read worker transcripts" bash -c "jq -r '.permissions.deny[]' '$SYS/leads/platform/.claude/settings.json' | grep -qxF 'Edit(/$W/**)' && jq -r '.permissions.deny[]' '$SYS/leads/platform/.claude/settings.json' | grep -qxF mcp__paseo__get_agent_activity"

echo "== config-check holds the line"
jq '.permissions.deny -= ["Bash(sudo *)"]' "$P1/.claude/$S" >"$T/s.json" && cp "$T/s.json" "$P1/.claude/$S"
out=$(cc); check "a worker's lost deny is refused: 'settings lost the worker deny Bash(sudo *)'" grep -qF "worker platform-w1: settings lost the worker deny Bash(sudo *)" <<<"$out"
cc --render >/dev/null
check "...and --render puts it back" has "$P1" "Bash(sudo *)"
jq '.hooks.PreToolUse |= .[1:]' "$O1/.claude/$S" >"$T/s.json" && cp "$T/s.json" "$O1/.claude/$S"
out=$(cc); check "a board worker without the allow-only hook is refused" grep -qF "worker ops-o1: a board worker must run the allow-only hook first, on every tool" <<<"$out"
jq '.hooks.PreToolUse[0].matcher = "Bash"' "$R1/.claude/$S" >"$T/s.json" && cp "$T/s.json" "$R1/.claude/$S"
out=$(cc); check "...a read worker whose hook is not on every tool, too" grep -qF "worker review-r1: a read worker must run the allow-only hook first" <<<"$out"
cc --render >/dev/null
check "...and --render puts both back" bash -c "[ -n \"\$(jq -r '.hooks.PreToolUse[0] | select(.matcher == \"*\") | .hooks[0].command' '$O1/.claude/$S')\" ] && [ \"\$(jq -r '.hooks.PreToolUse[0].matcher' '$R1/.claude/$S')\" = '*' ]"
cp "$RJ" "$T/roles.ok"
roles '(.roles[] | select(.id == "platform") | .worker.repo) = "{home}/.mm/brain"'
out=$("$SYS/bin/wt" platform b1 2>&1); rc=$?
check "wt refuses a worktree of the brain (exit $rc)" refused $rc "$out" 'never a worktree of the brain' && test ! -e "$W/platform-b1"
out=$(cc); check "config-check refuses a worker spec on the brain" grep -q "platform's worker: repo {home}/.mm/brain is the brain" <<<"$out"
roles '(.roles[] | select(.id == "review") | .worker.repo) = "{brain}"'
out=$("$SYS/bin/wt" review b2 2>&1); rc=$?
check "wt refuses even a read checkout of the brain ({brain}) (exit $rc)" refused $rc "$out" 'never a worktree of the brain'
roles '(.roles[] | select(.id == "review") | .worker.repo) = "{home}"'
out=$("$SYS/bin/wt" review b3 2>&1); rc=$?
check "wt refuses a repo that holds the brain ({home}) (exit $rc)" refused $rc "$out" 'holds it'
cp "$T/roles.ok" "$RJ"
roles '(.roles[] | select(.id == "review") | .worker.kind) = "write"'
out=$(cc); check "config-check refuses a write worker outside the role's write roots (one writer per repo)" grep -q "review's write worker's repo {home}/mm is not one of review's write roots" <<<"$out"
cp "$T/roles.ok" "$RJ"
for r in "Bash(lead worker start review *)" "Bash(wt *)" "Bash(wt rm review-*)"; do
  t="$SYS/leads/platform/.claude/settings.tmpl.json"; cp "$t" "$T/tmpl.ok"
  jq --arg r "$r" '.permissions.allow += [$r]' "$T/tmpl.ok" >"$t"
  out=$(cc --render); check "config-check refuses the platform lead the rule $r" grep -qF "platform: $r:" <<<"$out"
  cp "$T/tmpl.ok" "$t"
done
cc --render >/dev/null
check "config-check passes again" bash -c "cd '$SYS' && node bin/config-check >/dev/null 2>&1"
out=$("$SYS/bin/wt" nope x 2>&1); check "wt refuses a role with no worker spec" grep -q 'no workers for this role' <<<"$out"
out=$("$SYS/bin/wt" platform main 2>&1); check "wt refuses the name main" grep -q 'bad worker name' <<<"$out"

echo "== lead worker: the item claimed, within capacity and the cap; labels, mode, actor"
cat >"$T/paseo" <<'EOF'
#!/usr/bin/env node
const fs = require('fs'), S = process.env.STUB_PASEO, a = process.argv.slice(2)
let st = []; try { st = JSON.parse(fs.readFileSync(S, 'utf8')) } catch {}
fs.appendFileSync(S + '.log', JSON.stringify(a) + '\n')
const save = () => fs.writeFileSync(S, JSON.stringify(st)), lab = {}
for (let i = 0; i < a.length; i++) if (a[i] === '--label') { const [k, v] = a[i + 1].split('='); lab[k] = v }
if (a[0] === 'ls') console.log(JSON.stringify(st.filter((x) => (a.includes('-a') || !x.archived) && Object.entries(lab).every(([k, v]) => x.labels[k] === v)).map(({ labels, ...x }) => x)))
else if (a[0] === 'run') { const id = `ag${st.length + 1}`; st.push({ id, shortId: id, title: a[a.indexOf('--title') + 1], status: 'running', labels: lab }); save(); console.log(id) }
else if (a[0] === 'archive') { for (const x of st) if (x.id === a[a.length - 1]) x.archived = true; save() }
else if (a[0] === 'logs') console.log('RESULT: done\nITEM: ab-1')
EOF
chmod +x "$T/paseo"
cat >"$T/items.json" <<'EOF'
[{"id":"ab-1","assignee":"platform","status":"in_progress","priority":2},{"id":"ab-3","assignee":"review","status":"in_progress","priority":2},{"id":"ab-4","assignee":"ops/o9","status":"in_progress","priority":2}]
EOF
printf '#!/bin/sh\ncase "$1" in list) cat %s ;; *) exit 0 ;; esac\n' "$T/items.json" >"$SYS/bin/bd"; chmod +x "$SYS/bin/bd"
export PASEO_BIN="$T/paseo" STUB_PASEO="$T/paseo.json"
echo "the brief" >"$T/brief.md"
LW() { "$SYS/bin/lead" worker "$@" 2>&1; }
out=$(LW start platform w2 --item ab-1 --brief "$T/brief.md"); rc=$?
check "start platform w2 on ab-1 (claimed, 1 of capacity 1) (exit $rc)" test "$rc" = 0
run=$(grep '"run"' "$STUB_PASEO.log" | tail -1)
for x in '"--label","role=platform-worker"' '"--label","worker=w2"' '"--label","item=ab-1"' '"--mode","auto"' "\"--cwd\",\"$W/platform-w2\"" '"BEADS_ACTOR=platform/w2"' '"--title","acme-b · platform worker w2 on ab-1"'; do
  check "...paseo run has $x" grep -qF -- "$x" <<<"$run"
done
check "...its folder and permissions are there" test -f "$W/platform-w2/.claude/$S"
out=$(LW start platform w3 --item ab-1 --brief "$T/brief.md"); rc=$?
check "a second worker on ab-1 is refused: 2 places past capacity 1 (exit $rc)" refused $rc "$out" 'holds 1 of its capacity 1'
out=$(LW start platform w4 --item ab-2 --brief "$T/brief.md"); rc=$?
check "a worker on an item not claimed is refused (exit $rc)" refused $rc "$out" 'claim it first'
out=$(LW start platform w2 --item ab-1 --brief "$T/brief.md"); check "a second w2 is refused while the first is there" grep -q 'still there' <<<"$out"
out=$(WAKE_CAP=2 LW start review r2 --item ab-3 --brief "$T/brief.md"); rc=$?
check "the project's cap counts workers: w2 + ab-3 + ab-4 = 3 of cap 2, refused (exit $rc)" refused $rc "$out" 'the project holds 3 of its cap 2'
out=$(LW start review r2 --item ab-3 --brief "$T/brief.md" --ref main); rc=$?
check "start review r2 on ab-3 (exit $rc): mode auto (Paseo has no dontAsk; its allow-only hook refuses), a read checkout" bash -c "[ $rc = 0 ] && grep '\"run\"' '$STUB_PASEO.log' | tail -1 | grep -qF '\"--mode\",\"auto\"' && [ \"\$(git -C '$W/review-r2' rev-parse --abbrev-ref HEAD)\" = HEAD ]"
roles '(.roles[] | select(.id == "ops") | .workers) = false'
out=$(LW start ops o2 --item ab-4 --brief "$T/brief.md"); rc=$?
check "a role switched off is refused (exit $rc)" refused $rc "$out" 'not switched on'
out=$(LW report platform w2); check "report prints only its final reply" grep -q 'RESULT: done' <<<"$out"
check "...read with paseo logs --filter text --tail 1" grep -qF '"logs","ag1","--filter","text","--tail","1"' "$STUB_PASEO.log"
out=$(LW ls); check "ls lists platform w2 on ab-1 and review r2 on ab-3" lsok "$out"
out=$(LW stop platform w2); check "stop archives it" stopok "$out"
out=$(LW start platform w3 --item ab-1 --brief "$T/brief.md"); rc=$?
check "its place is free again: a new worker on ab-1 starts (exit $rc)" test "$rc" = 0

echo "== wt sync and rm"
echo y >"$W/platform-w2/f.txt"; git -C "$W/platform-w2" add f.txt; git -C "$W/platform-w2" commit -qm "work"
out=$("$SYS/bin/wt" rm platform-w2 2>&1); rc=$?
check "wt rm refuses a branch with commits not on main (exit $rc)" refused $rc "$out" 'commits not on main' && test -d "$W/platform-w2"
check "wt sync rebases it onto main" bash -c "'$SYS/bin/wt' sync platform-w2 >/dev/null 2>&1"
out=$("$SYS/bin/wt" rm platform-w2 --force 2>&1); rc=$?
check "wt rm --force removes it and its branch (exit $rc)" bash -c "[ $rc = 0 ] && [ ! -e '$W/platform-w2' ] && ! git -C '$HOME/mm' rev-parse -q --verify refs/heads/w2 >/dev/null"
check "...and the others' permissions no longer name it" bash -c "! jq -r '.permissions.deny[]' '$P1/.claude/$S' | grep -qF 'worktrees/platform-w2/'"
"$SYS/bin/wt" rm review-r1 >/dev/null 2>&1; "$SYS/bin/wt" rm ops-o1 >/dev/null 2>&1
check "wt rm removes a read checkout and a board folder" bash -c "[ ! -e '$W/review-r1' ] && [ ! -e '$W/ops-o1' ]"
out=$("$SYS/bin/wt" ls 2>&1); check "wt ls lists what is left" wtlsok "$out"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
