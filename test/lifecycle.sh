#!/usr/bin/env bash
# Lifecycle QA on a real machine (one that `mm doctor` passes): new from an OLD template -> data + local edits ->
# update (dry run, conflict, abort, resolve, continue) -> restart -> crash -> machine process-manager restart ->
# archive (clean removal) -> restore -> archive again. Uses a throwaway project and removes it at the end.
#
#   test/lifecycle.sh <old-template-dir> [client/name]      e.g. old dir from: git archive <rev> template | tar -x
#
# Exit 0 = every check passed. Starts one cheap agent (haiku) to check that archive takes agents with it.
set -uo pipefail
PROJECTS_DIR=$(grep -qsE '^layout: *.?one-root' "${MM_HOME:-$HOME/.mm}/config.yaml" && echo "${MM_HOME:-$HOME/.mm}/projects" || echo "$HOME/projects")   # where mm keeps projects (its layout)
OLD=${1:?old template dir}; REF=${2:-qa/life}
CLIENT=${REF%/*}; NAME=${REF#*/}; PROJECT="$CLIENT-$NAME"; ROOT="$PROJECTS_DIR/$REF"
PC="process-compose -U -u $HOME/.mm/pc.sock"
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$PATH"
. "$(dirname "$0")/lib/routes.sh"   # this run's routes in its own folder, never in the live web proxy (review sy-uzh)
. "$(dirname "$0")/lib/paseo.sh"    # at the end: the Paseo workspaces and projects this run made are archived and removed
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
MM_TEMPLATE_DIR=$OLD mm new "$REF" --short ql --throwaway >/tmp/mm-qa-new.$$ 2>&1; rc=$?
[ $rc = 0 ] && ok "mm new exit 0" || { bad "mm new exit $rc"; tail -20 /tmp/mm-qa-new.$$; exit 1; }
rm -f /tmp/mm-qa-new.$$
if wait_ready 3 90; then ok "4 services ready"   # wake has no probe: dolt, bd-serve, board
else bad "4 services ready"   # what each one shows, for sy-ynb (it fails now and then)
  $PC process list -o json 2>/dev/null | jq -r --arg p "$PROJECT." '.[] | select(.name | startswith($p)) | "       \(.name) \(.status) ready=\(.is_ready) restarts=\(.restarts)"'
  for s in bd-serve board; do echo "       -- $s.log"; tail -5 "$ROOT/.run/logs/$s.log" 2>/dev/null | cut -c1-200 | sed 's/^/       /'; done
fi
check "board answers by name" board
check "marked throwaway (mm ls)" sh -c "mm ls -o json | jq -e --arg p '$PROJECT' '.[] | select(.project == \$p) | .throwaway == true'"
check "mm-template branch = baseline" git -C "$ROOT" rev-parse -q --verify refs/heads/mm-template
PUB=$(public_name); PORT=$(public_port)
if [ -n "$PUB" ]; then check "public route $PUB listed" sh -c "$MM_EXPOSE ls | grep -q '$PUB'"; fi
BIND=$(mm config get bind_host 2>/dev/null || echo 127.0.0.1)
if [ -n "$PORT" ] && [ "${BIND#127.}" = "$BIND" ]; then   # domain mode with the web proxy in docker: the forwarder
  listening() { for _ in $(seq 1 20); do ss -Hltn | awk '{print $4}' | grep -qx -- "$1" && return 0; sleep 1; done; return 1; }   # the forwarder starts just after the service
  check "public port: the service on loopback" listening "127.0.0.1:$PORT"
  if listening "$BIND:$PORT"; then ok "public port: mm's forwarder on $BIND"; else bad "public port: mm's forwarder on $BIND"
    echo "      forwarder: $($PC process list -o json 2>/dev/null | jq -c --arg n "$PROJECT.board-public" '.[] | select(.name==$n) | {status, restarts, exit_code}')"
    tail -5 "$ROOT/.run/logs/board-public.log" 2>/dev/null | sed 's/^/      /'; ss -Hltn | awk '{print $4}' | grep ":$PORT$" | sed 's/^/      listening: /'; fi
  check "public port: nothing on every interface" sh -c "! ss -Hltn | awk '{print \$4}' | grep -qxE '(0[.]0[.]0[.]0|[*]|[[]::[]]):$PORT'"
  check "public port (old template, before the update): still served through $BIND" curl -sf -o /dev/null --max-time 5 "http://$BIND:$PORT/api/whoami"
fi
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
check "still throwaway after the update" sh -c "mm ls -o json | jq -e --arg p '$PROJECT' '.[] | select(.project == \$p) | .throwaway == true'"
if [ -n "$PORT" ] && [ "${BIND#127.}" = "$BIND" ]; then   # now on the current template: the board's gated public side
  check "public port through $BIND: refused without the gateway's assertion (401)" sh -c "[ \$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'x-board-user: owner' 'http://$BIND:$PORT/api/whoami') = 401 ]"
  check "...and the local side still answers (health, leads)" board /api/whoami
fi
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

step "a lead with this project's own Claude folder (no shared instructions)"
CDIR="$HOME/.mm/claude/$PROJECT"; LDIR="$ROOT/leads/qa"
(cd "$ROOT" && bin/lead start qa --model claude/claude-haiku-5-5) >/dev/null 2>&1 && ok "bin/lead start qa (cheap model)" || bad "bin/lead start qa"
check "the project's Claude folder, 0700" sh -c "[ \$(stat -c %a '$CDIR') = 700 ]"
check "...with the lead's folder trusted (so its allow rules apply)" jq -e --arg d "$LDIR" '.projects[$d].hasTrustDialogAccepted == true' "$CDIR/.claude.json"
lead_env() { for _ in $(seq 1 60); do for p in $(pgrep -x claude 2>/dev/null); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$LDIR" ] && { tr '\0' '\n' </proc/$p/environ | grep '^CLAUDE_CONFIG_DIR='; return 0; }; done; sleep 1; done; return 1; }
LE=$(lead_env); [ "$LE" = "CLAUDE_CONFIG_DIR=$CDIR" ] && ok "the lead's Claude process has CLAUDE_CONFIG_DIR=$CDIR" || bad "the lead's CLAUDE_CONFIG_DIR: ${LE:-none found}"
check "its session is in the project's folder, not ~/.claude" sh -c "for _ in \$(seq 1 30); do ls '$CDIR/projects' 2>/dev/null | grep -q 'leads-qa' && exit 0; sleep 1; done; exit 1"

step "the project's memory: in its own repo, linked from each agent's Claude folder"
MLINK="$CDIR/projects/$(printf '%s' "$LDIR" | sed 's/[^A-Za-z0-9]/-/g')/memory"
check "the lead's Claude memory folder links to the project's memory/" sh -c "[ \"\$(readlink '$MLINK')\" = '$ROOT/memory' ]"
printf -- '---\nname: qa-probe\ndescription: a fact the lifecycle test writes through the link\nmetadata:\n  type: project\n  verified: 2026-11-04\n  ttl_days: 30\n---\nlifecycle probe\n' >"$MLINK/qa-probe.md"
check "a memory written through the link lands in the project's repo folder" test -f "$ROOT/memory/qa-probe.md"
check "config-check accepts a well-formed memory" sh -c "cd '$ROOT' && bin/config-check"
printf -- '---\nname: bad\n---\nno description\n' >"$ROOT/memory/qa-bad.md"
check "config-check refuses one without a description" sh -c "! (cd '$ROOT' && bin/config-check)"
rm -f "$ROOT/memory/qa-bad.md"
printf -- '---\nname: undated\ndescription: no verified, no ttl_days (what built-in memory writes)\nmetadata:\n  type: project\n---\nx\n' >"$ROOT/memory/qa-undated.md"
check "config-check refuses one without verified and ttl_days" sh -c "cd '$ROOT' && bin/config-check 2>&1 | grep -q 'qa-undated.md: needs verified'"
rm -f "$ROOT/memory/qa-undated.md"
printf -- '---\nname: qa-stale\ndescription: a fact past its time\nmetadata:\n  type: project\n  verified: 2020-01-01\n  ttl_days: 1\n---\nold\n' >"$ROOT/memory/qa-stale.md"
HST=$(mktemp); (cd "$ROOT" && HEALTH_STATE="$HST" node bin/health >/dev/null 2>&1)
SITEM=$(jq -r '.memory.item // empty' "$HST")
check "health: a stale memory opens one item for setup, listing it" sh -c "[ -n '$SITEM' ] && cd '$ROOT' && bin/bd show '$SITEM' --json | jq -e 'if type==\"array\" then .[0] else . end | .assignee == \"setup\" and (.description | test(\"qa-stale.md\"))'"
rm -f "$ROOT/memory/qa-stale.md"; (cd "$ROOT" && HEALTH_STATE="$HST" node bin/health >/dev/null 2>&1)
check "health: the item closes once no memory is stale" sh -c "cd '$ROOT' && bin/bd show '$SITEM' --json | jq -e 'if type==\"array\" then .[0] else . end | .status == \"closed\"'"
rm -f "$HST"
check "memory/ is tracked by the project's config repo" sh -c "cd '$ROOT' && git add memory/qa-probe.md && git -c user.name=qa -c user.email=qa@qa commit -qm 'qa: memory probe' && git ls-files memory | grep -q qa-probe.md"

step "bd stays quiet (sy-8s1): made by an old template, then updated"
check "after mm update: no-hooks, metrics off, no-git-ops, no Dolt auto-start (sy-a0ac, sy-nsnp)" sh -c "cd '$ROOT/control' && [ \"\$(../bin/bd config get no-hooks | tail -1)\" = true ] && ../bin/bd metrics | grep -qx 'Anonymous usage metrics: OFF' && grep -q '^export BD_DISABLE_METRICS=1 ' ../bin/bd && [ \"\$(../bin/bd config get no-git-ops | tail -1)\" = true ] && [ \"\$(../bin/bd config get dolt.auto-start | tail -1)\" = false ]"
check "mm doctor: bd quiet ok for this project" sh -c "mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item == \"bd quiet $REF\") | .status == \"ok\"'"
printf '#!/bin/sh\nexec bd hooks run pre-commit "$@"\n' >"$ROOT/control/.git/hooks/pre-commit"; chmod +x "$ROOT/control/.git/hooks/pre-commit"
check "...a bd hook planted in control/: doctor fails, naming it" sh -c "mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item == \"bd quiet $REF\") | .status == \"fail\" and (.detail | test(\"control/.git/hooks/pre-commit\"))'"
rm -f "$ROOT/control/.git/hooks/pre-commit"
# the shared temp folders (review sy-b15.16): a writable file is listed, unless a folder the group can't enter is above it
loose_n() { mm doctor -o json 2>/dev/null | jq -r '.[] | select(.item == "shared temp folders") | if .status == "ok" then "0" else (.detail | capture("^(?<n>[0-9]+)").n) end'; }
L0=$(loose_n); WALL=$(mktemp -d /tmp/mm-qa-wall.XXXXXX); OPEN=$(mktemp -d /tmp/mm-qa-open.XXXXXX)
chmod 700 "$WALL"; chmod 755 "$OPEN"; (umask 000; : >"$WALL/f"; : >"$OPEN/f")
L1=$(loose_n); rm -rf "$WALL" "$OPEN"
check "mm doctor: a world-writable file of yours in /tmp is listed, one under a 0700 folder is not ($L0 -> $L1)" test "$L1" = "$((L0 + 1))"
check "a lead may not install bd hooks or turn metrics on (rendered denies)" sh -c "jq -e '.permissions.deny | index(\"Bash(bd hooks*)\") and index(\"Bash(bin/bd config set metrics*)\") and index(\"Bash(bd init*)\")' '$ROOT/leads/qa/.claude/settings.json'"
check "a lead may not make people, links, grants or tokens, nor reach the gateway's socket or store (review sy-b15.13)" sh -c "jq -e --arg mm \"/\${MM_HOME:-$HOME/.mm}\" '.permissions.deny | index(\"Bash(mm user*)\") and index(\"Bash(mm grant*)\") and index(\"Bash(mm token*)\") and index(\"Bash(*auth.sock*)\") and index(\"Read(\(\$mm)/auth/**)\")' '$ROOT/leads/qa/.claude/settings.json'"
check "...nor set an AI budget, or read or edit the AI gateway's store or the upstream key (sy-b15.10)" sh -c "jq -e --arg mm \"/\${MM_HOME:-$HOME/.mm}\" --arg home \"/$HOME\" '.permissions.deny | index(\"Bash(mm ai budget*)\") and index(\"Bash(*ai.sock*)\") and index(\"Read(\(\$mm)/ai/**)\") and index(\"Edit(\(\$mm)/ai/**)\") and index(\"Read(\(\$home)/.config/secrets/ai-upstream.key)\")' '$ROOT/leads/qa/.claude/settings.json'"
check "...nor read the machine's secrets, from the manifest (bot token, Cloudflare token, Paseo, Claude's login): Read, Edit and Bash forms (review sy-5ag)" sh -c "jq -e --arg home \"/$HOME\" --arg h '$HOME' '.permissions.deny | index(\"Read(\(\$home)/brain/.keys/.telebot)\") and index(\"Read(\(\$home)/brain/.keys/**)\") and index(\"Bash(*~/brain/.keys*)\") and index(\"Bash(*\(\$h)/brain/.keys/.cf*)\") and index(\"Bash(*\$HOME/.config/secrets*)\") and index(\"Read(\(\$home)/.paseo/**)\") and index(\"Read(\(\$home)/.claude/.credentials.json)\")' '$ROOT/leads/qa/.claude/settings.json' && jq -e '.files | index(\"$HOME/brain/.keys/.telebot\")' '${MM_HOME:-$HOME/.mm}/secret-paths.json' && jq -e 'has(\"machine_secrets\") | not' '$ROOT/.run/endpoints.json'"
check "...nor anything in the brain, in either layout (a project has no business there)" sh -c "jq -e --arg home \"/$HOME\" '.permissions.deny | index(\"Read(\(\$home)/brain/**)\") and index(\"Edit(\(\$home)/brain/**)\") and index(\"Bash(*~/brain*)\") and index(\"Read(\(\$home)/.mm/brain/**)\") and index(\"Bash(*~/.mm/brain*)\")' '$ROOT/leads/qa/.claude/settings.json'"
check "...the brain's keys in the one-root layout too (~/.mm/brain/.keys: the owner's report)" sh -c "jq -e --arg home \"/$HOME\" '.permissions.deny | index(\"Read(\(\$home)/.mm/brain/.keys/**)\") and index(\"Bash(*~/.mm/brain/.keys*)\")' '$ROOT/leads/qa/.claude/settings.json'"
check "...the vault (its key) and the opened-secrets tmpfs, for every role and setup (sy-uvgq)" sh -c "for f in '$ROOT'/leads/*/.claude/settings.json '$ROOT/setup/.claude/settings.json'; do jq -e --arg home \"/$HOME\" --arg run \"//run/user/$(id -u)/mm/secrets\" '.permissions.deny | index(\"Read(\(\$home)/.mm/vault/**)\") and index(\"Edit(\(\$home)/.mm/vault/**)\") and index(\"Read(\(\$run)/**)\") and index(\"Edit(\(\$run)/**)\") and index(\"Bash(*vault/key*)\")' \"\$f\" >/dev/null || exit 1; done"
check "...and the vault's opener and key maker (review sy-uvgq), for every role and setup" sh -c "for f in '$ROOT'/leads/*/.claude/settings.json '$ROOT/setup/.claude/settings.json'; do jq -e '.permissions.deny | index(\"Bash(*mm vault run*)\") and index(\"Bash(*mm vault init*)\")' \"\$f\" >/dev/null || exit 1; done"
# the run file is the project's to write (a box's too): mm no longer lists the secrets there (review sy-v92 2; the rest
# in test/denies.sh), and a run file that lists none still renders the fixed denies
cp "$ROOT/.run/endpoints.json" "/tmp/mm-ep.$$"
jq '.machine_secrets = {}' "/tmp/mm-ep.$$" > "$ROOT/.run/endpoints.json"
check "...and a run file that lists none (machine_secrets {}) still renders the fixed denies (review sy-v92 4)" sh -c "'$ROOT/bin/config-check' --render >/dev/null && jq -e --arg home \"/$HOME\" '.permissions.deny | index(\"Read(\(\$home)/.mm/brain/.keys/**)\") and index(\"Read(\(\$home)/brain/.keys/**)\") and index(\"Read(\(\$home)/.config/secrets/**)\") and index(\"Read(\(\$home)/.paseo/**)\") and index(\"Read(\(\$home)/.claude/.credentials.json)\")' '$ROOT/leads/qa/.claude/settings.json'"
cp "/tmp/mm-ep.$$" "$ROOT/.run/endpoints.json"; rm -f "/tmp/mm-ep.$$"; "$ROOT/bin/config-check" --render >/dev/null 2>&1
check "a lead's identity and tools are in its settings, so a lead resumed without bin/lead's env still has them (sy-670)" sh -c "jq -e --arg r '$ROOT' '.env.BEADS_ACTOR == \"qa\" and .env.GIT_AUTHOR_NAME == \"qa\" and (.env.PATH | startswith(\$r + \"/bin:\"))' '$ROOT/leads/qa/.claude/settings.json' && jq -e '.env.BEADS_ACTOR == \"setup\"' '$ROOT/setup/.claude/settings.json'"

step "archive: dry run, then clean removal"
check "dry run" mm archive "$REF" --dry-run
check "dry run changed nothing" test -d "$ROOT"
mm archive "$REF" >/tmp/mm-qa-ar.$$ 2>&1; rc=$?
[ $rc = 0 ] && ok "archive exit 0" || { bad "archive exit $rc"; cat /tmp/mm-qa-ar.$$; }
TB=$(sed -n 's/^archived: //p' /tmp/mm-qa-ar.$$); rm -f /tmp/mm-qa-ar.$$
check "project directory gone" test ! -e "$ROOT"
check "no processes left" test "$(proc_count)" = 0
check "process file gone" test ! -e "$HOME/.mm/pc/projects/$PROJECT.yaml"
[ -n "$PUB" ] && check "public route removed" sh -c "! $MM_EXPOSE ls | grep -q '$PUB'"
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
check "the memory survived archive + restore" test -f "$ROOT/memory/qa-probe.md"
[ -n "$PUB" ] && check "public route back" sh -c "$MM_EXPOSE ls | grep -q '$PUB'"
check "update state intact (no-op)" sh -c "mm update '$REF' | grep -q 'already at'"

step "cleanup"
mm archive "$REF" >/dev/null 2>&1 && ok "archived again" || bad "final archive"
rm -rf "$HOME/.local/share/backups/$PROJECT"
for f in $(ls "$HOME/.local/share/mm/archive"); do grep -qxF "$f" <<<"$ARCH_BEFORE" || rm -f "$HOME/.local/share/mm/archive/$f"; done
rmdir "$PROJECTS_DIR/$CLIENT" 2>/dev/null || true
check "nothing left" test ! -e "$ROOT"
check "its Claude folder is gone too" test ! -e "$HOME/.mm/claude/$PROJECT"
# Paseo keeps a workspace and a project for each folder an agent ran in (the probe's, through the symlink; the qa lead's)
PL=$(paseo_left "$ROOT" "${ALIAS:-}"); paseo_forget "$ROOT" "${ALIAS:-}"
check "its Paseo workspaces and projects are gone (were: $PL)" test "$(paseo_left "$ROOT" "${ALIAS:-}")" = "0 0"

check "no route written into the live web proxy (review sy-uzh)" live_routes_same
printf '\n%s passed, %s failed in %ss\n' "$pass" "$fail" $(( $(date +%s) - T0 ))
[ "$fail" = 0 ]
