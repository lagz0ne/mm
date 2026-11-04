#!/usr/bin/env bash
# Lifecycle QA on a real machine (one that `mm doctor` passes): new from an OLD template -> data + local edits ->
# update (dry run, conflict, abort, resolve, continue) -> restart -> crash -> machine process-manager restart ->
# archive (clean removal) -> restore -> archive again. Uses a throwaway project and removes it at the end.
#
#   test/lifecycle.sh <old-template-dir> [client/name]      e.g. old dir from: git archive <rev> template | tar -x
#
# Exit 0 = every check passed. Starts one cheap agent (haiku) to check that archive takes agents with it.
set -uo pipefail
OLD=${1:?old template dir}; REF=${2:-qa/life}
CLIENT=${REF%/*}; NAME=${REF#*/}; PROJECT="$CLIENT-$NAME"; ROOT="$HOME/projects/$REF"
PC="process-compose -U -u $HOME/.mm/pc.sock"
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$PATH"
unset PASEO_AGENT_ID PASEO_AGENT_CWD   # run from inside an agent: these would override `paseo run --cwd` (the probe must live in the project)
pass=0; fail=0; T0=$(date +%s)
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
step() { printf '\n\e[1m== %s\e[0m (%ss)\n' "$*" $(( $(date +%s) - T0 )); }
ready_count() { $PC process list -o json 2>/dev/null | jq --arg p "$PROJECT." '[.[]|select((.name|startswith($p)) and .is_ready=="Ready")]|length'; }
proc_count()  { $PC process list -o json 2>/dev/null | jq --arg p "$PROJECT." '[.[]|select((.name|startswith($p)) and .status=="Running")]|length'; }
wait_ready() { for _ in $(seq 1 ${2:-60}); do [ "$(ready_count)" -ge "$1" ] && return 0; sleep 1; done; return 1; }
board() { curl -sf -o /dev/null --max-time 5 "http://board.$PROJECT.localhost:1355${1:-/}"; }
bdq() { (cd "$ROOT" && bin/bd "$@"); }
item_there() { bdq show "$ITEM" --json 2>/dev/null | grep -q 'qa lifecycle item'; }
public_name() { jq -r '.services.board.public.name // empty' "$ROOT/.run/services.json" 2>/dev/null; }
public_port() { jq -r '.services.board.public_port // empty' "$ROOT/.run/services.json" 2>/dev/null; }

[ -e "$ROOT" ] && { echo "$ROOT exists; pick another name"; exit 2; }
mkdir -p "$HOME/.local/share/mm/archive"; ARCH_BEFORE=$(ls "$HOME/.local/share/mm/archive")

step "new from the old template"
MM_TEMPLATE_DIR=$OLD mm new "$REF" --short ql >/tmp/mm-qa-new.$$ 2>&1; rc=$?
[ $rc = 0 ] && ok "mm new exit 0" || { bad "mm new exit $rc"; tail -20 /tmp/mm-qa-new.$$; exit 1; }
rm -f /tmp/mm-qa-new.$$
check "4 services ready" wait_ready 3 90      # wake has no probe: dolt, bd-serve, board
check "board answers by name" board
check "mm-template branch = baseline" git -C "$ROOT" rev-parse -q --verify refs/heads/mm-template
PUB=$(public_name); PORT=$(public_port)
if [ -n "$PUB" ]; then check "public route $PUB listed" sh -c "expose ls | grep -q '$PUB'"; fi
OLDV=$(sed -n 's/^template_version: //p' "$ROOT/.mm-answers.yaml")

step "data and local edits"
ITEM=$(bdq create "qa lifecycle item" --json 2>/dev/null | jq -r '.id'); [ -n "$ITEM" ] && ok "item $ITEM created" || bad "create item"
echo "- QA: a project-local rule that an update must keep." >>"$ROOT/CLAUDE.md"
sed -i 's/"build": "tsc -b && vite build"/"build": "tsc -b \&\& vite build --logLevel warn"/' "$ROOT/site/package.json"
(cd "$ROOT" && git add CLAUDE.md site/package.json && SETUP_HUMAN=1 git commit -qm "qa: local edits") && ok "local edits committed" || bad "commit local edits"
HEAD0=$(git -C "$ROOT" rev-parse HEAD)

step "update: dry run"
out=$(mm update "$REF" --dry-run 2>&1); rc=$?
[ $rc = 1 ] && ok "dry run reports trouble (exit 1)" || bad "dry run exit $rc"
grep -q 'C site/package.json' <<<"$out" && ok "conflict on site/package.json foreseen" || bad "conflict not foreseen: $out"
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$HEAD0" ] && [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] && ok "dry run changed nothing" || bad "dry run changed the repo"

step "update: stops on the conflict, abort undoes it"
mm update "$REF" >/dev/null 2>&1; rc=$?
[ $rc = 1 ] && ok "update stops (exit 1)" || bad "update exit $rc"
check "merge in progress" git -C "$ROOT" rev-parse -q --verify MERGE_HEAD
check "abort" mm update "$REF" --abort
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$HEAD0" ] && [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] && ok "repo as before" || bad "repo not restored"
check "board still answers" board

step "update: resolve, continue"
mm update "$REF" >/dev/null 2>&1
(cd "$ROOT" && git checkout --theirs site/package.json && git add site/package.json) && ok "resolved (take template)" || bad "resolve"
mm update "$REF" --continue >/tmp/mm-qa-up.$$ 2>&1; rc=$?
[ $rc = 0 ] && ok "continue exit 0" || { bad "continue exit $rc"; cat /tmp/mm-qa-up.$$; }
rm -f /tmp/mm-qa-up.$$
check "local CLAUDE.md rule kept" grep -q 'project-local rule that an update must keep' "$ROOT/CLAUDE.md"
check "new template file arrived (site/compress.mjs)" test -f "$ROOT/site/compress.mjs"
NEWV=$(sed -n 's/^template_version: //p' "$ROOT/.mm-answers.yaml"); [ "$NEWV" != "$OLDV" ] && ok "template_version $OLDV -> $NEWV" || bad "template_version unchanged"
check "mm-template advanced" sh -c "git -C '$ROOT' log -1 --format=%s mm-template | grep -q '$NEWV'"
check "clean tree after update" test -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)"
check "services ready after update" wait_ready 3 60
check "board serves brotli assets" sh -c "curl -sf --max-time 5 -H 'accept-encoding: br' -D- -o /dev/null http://board.$PROJECT.localhost:1355/ | grep -qi 'content-encoding: br'"
check "item survived the update" item_there
out=$(mm update "$REF" 2>&1); grep -q 'already at' <<<"$out" && ok "second update is a no-op" || bad "second update: $out"
check "backup runs (bin/backup)" sh -c "cd '$ROOT' && timeout 300 bin/backup"
check "health passes (bin/health)" sh -c "cd '$ROOT' && timeout 120 node bin/health"

step "restart"
check "mm restart" mm restart "$REF"
check "ready after restart" wait_ready 3 60
check "item survived restart" item_there

step "crash: process-compose brings the board back"
pid=$($PC process list -o json | jq -r --arg n "$PROJECT.board" '.[]|select(.name==$n)|.pid')
kill -9 "$pid" 2>/dev/null && ok "board pid $pid killed" || bad "kill board"
sleep 1; for _ in $(seq 1 30); do board && break; sleep 1; done
check "board answers again" board
for _ in $(seq 1 10); do n=$(pgrep -fc "^node $ROOT/site/server.mjs"); [ "$n" = 1 ] && break; sleep 1; done
[ "$n" = 1 ] && ok "no orphan: one board process" || { bad "$n board processes (orphan left by the crash)"; ps -o pid,ppid,etime,cmd -p "$(pgrep -fd, "^node $ROOT/site/server.mjs")" | cut -c1-160; }

step "agent (cheap) and a leftover process for the archive check, both under another spelling of the folder"
# ALIAS is a symlink to the client folder (as ~/projects -> ~/.mm/projects will be): archive must still find what was
# started through it. The leftover runs from a file under the root with cwd /, so only its argv points inside.
ALIAS="$HOME/.mm-qa-alias-$$"; ln -s "$(dirname "$ROOT")" "$ALIAS"
cp "$(command -v sleep)" "$ROOT/qa-leftover" && (cd / && nohup "$ALIAS/$NAME/qa-leftover" 900 >/dev/null 2>&1 &)
check "leftover running" pgrep -f "$ALIAS/$NAME/[q]a-leftover"
AG=$(paseo -q run --no-wait --cwd "$ALIAS/$NAME/leads" --provider claude/claude-haiku-5-5 --title qa-probe --label project=$PROJECT "Reply with the single word: ok" 2>/dev/null | tail -1)
[ -n "$AG" ] && ok "agent $AG started" || bad "start agent"

step "archive: dry run, then clean removal"
check "dry run" mm archive "$REF" --dry-run
check "dry run changed nothing" test -d "$ROOT"
mm archive "$REF" >/tmp/mm-qa-ar.$$ 2>&1; rc=$?
[ $rc = 0 ] && ok "archive exit 0" || { bad "archive exit $rc"; cat /tmp/mm-qa-ar.$$; }
TB=$(sed -n 's/^archived: //p' /tmp/mm-qa-ar.$$); rm -f /tmp/mm-qa-ar.$$
check "project directory gone" test ! -e "$ROOT"
check "no processes left" test "$(proc_count)" = 0
check "process file gone" test ! -e "$HOME/.mm/pc/projects/$PROJECT.yaml"
[ -n "$PUB" ] && check "public route removed" sh -c "! expose ls | grep -q '$PUB'"
[ -n "$PORT" ] && check "public port $PORT free" sh -c "! ss -Hltn | grep -q ':$PORT '"
check "board name gone" sh -c "! curl -sf -o /dev/null --max-time 3 http://board.$PROJECT.localhost:1355/"
check "leftover swept (argv through the symlink)" sh -c "! pgrep -f '$ALIAS/$NAME/[q]a-leftover'"
rm -f "$ALIAS"
[ -n "$AG" ] && check "agent archived (cwd through the symlink)" sh -c "! paseo ls -g --json | jq -e --arg a '$AG' '.[]|select(.id|startswith(\$a))' >/dev/null"
check "tarball kept" test -s "$TB"
check "other projects untouched" sh -c "mm ls | grep -v '$PROJECT' | grep -q running"

step "restore"
mm restore "$TB" >/dev/null 2>&1; rc=$?
[ $rc = 0 ] && ok "restore exit 0" || bad "restore exit $rc"
check "ready after restore" wait_ready 3 90
check "board answers" board
check "item survived archive + restore" item_there
[ -n "$PUB" ] && check "public route back" sh -c "expose ls | grep -q '$PUB'"
check "update state intact (no-op)" sh -c "mm update '$REF' | grep -q 'already at'"

step "cleanup"
mm archive "$REF" >/dev/null 2>&1 && ok "archived again" || bad "final archive"
rm -rf "$HOME/.local/share/backups/$PROJECT"
for f in $(ls "$HOME/.local/share/mm/archive"); do grep -qxF "$f" <<<"$ARCH_BEFORE" || rm -f "$HOME/.local/share/mm/archive/$f"; done
rmdir "$HOME/projects/$CLIENT" 2>/dev/null || true
check "nothing left" test ! -e "$ROOT"

printf '\n%s passed, %s failed in %ss\n' "$pass" "$fail" $(( $(date +%s) - T0 ))
[ "$fail" = 0 ]
