#!/usr/bin/env bash
# template bin/land's deploy after a land (sy-gxws), hermetic: a throwaway project (code/ on main, a worktree per land),
# a stand-in bin/deploy that records its call. A land with an app slot starts `deploy main` detached (its log in
# .run/logs/deploy-land.log, the land lock not held by it); no app slot: one line, no deploy; deploy.on_land off: nothing.
#   test/land.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export MM_HOME="$T/mm"; mkdir -p "$MM_HOME"; unset DEPLOY_ON_LAND
P="$T/acme/shop"; mkdir -p "$P/bin" "$P/.run" "$P/code" "$P/worktrees"
cp "$SRC/template/bin/land" "$P/bin/"
# deploy: records its args and cwd, then waits for $T/go (so the test sees land return while it runs); FAIL: exit 1
cat >"$P/bin/deploy" <<EOF
#!/bin/sh
echo "deploy \$* in \$PWD" >>"$T/deploy.calls"; echo "deploying \$1 now"
i=0; while [ ! -e "$T/go" ] && [ \$i -lt 100 ]; do sleep 0.05; i=\$((i+1)); done
[ ! -e "$T/FAIL" ] || { echo "deploy: it broke" >&2; exit 1; }
echo "deployed \$1"; touch "$T/deploy.done"
EOF
chmod +x "$P/bin/"*
export MM_TRACE_SELF="$P/bin/land"
C="$P/code"; git -C "$C" init -q -b main; git -C "$C" commit -q --allow-empty -m c0
n=0
# lnd: a new worktree with one commit, landed; OUT/ERR/RC from land
lnd() { n=$((n+1)); : >"$T/deploy.calls"; rm -f "$T/go" "$T/deploy.done"
  git -C "$C" worktree add -q -b "w-$n" "$P/worktrees/w-$n" main && git -C "$P/worktrees/w-$n" commit -q --allow-empty -m "c$n"
  OUT=$("$P/bin/land" "w-$n" 2>"$T/err"); RC=$?; ERR=$(cat "$T/err"); }
waitfor() { local i=0; while [ ! -e "$1" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; [ -e "$1" ]; }
DL="$P/.run/logs/deploy-land.log"

echo "== no app slot: one line, no deploy"
printf '{"processes": {"board": {}}}\n' >"$P/.run/services.json"
lnd
check "the land works (exit 0), stdout is the new main's hash only" sh -c "[ $RC = 0 ] && [ '$OUT' = \"\$(git -C '$C' rev-parse --short main)\" ]"
check "one line: no app slot, no deploy" sh -c "[ '$ERR' = 'land: no app slot, no deploy' ]"
sleep 0.3
check "no deploy ran, no log" sh -c "[ ! -s '$T/deploy.calls' ] && [ ! -e '$DL' ]"

echo "== an app slot: deploy main starts detached, logged"
printf '{"processes": {"board": {}, "app": {}}}\n' >"$P/.run/services.json"
lnd; h=$OUT
check "the land works (exit 0), stdout is the new main's hash only" sh -c "[ $RC = 0 ] && [ '$h' = \"\$(git -C '$C' rev-parse --short main)\" ]"
check "one line says the deploy started, with the hash and the log" sh -c "[ '$ERR' = 'land: deploying $h in the background (log: .run/logs/deploy-land.log)' ]"
check "land returned while the deploy still runs (not done yet)" test ! -e "$T/deploy.done"
check "...and the land lock is free meanwhile (the deploy doesn't hold it)" flock -n "$P/worktrees/.land.lock" true
touch "$T/go"; waitfor "$T/deploy.done"
check "bin/deploy main ran, from the project root" grep -qx "deploy main in $P" "$T/deploy.calls"
check "the log: a header with the land's name, hash and time, then deploy's output (appended)" sh -c "grep -Eq '^== [0-9-]+T[0-9:]+Z land w-$n -> $h: deploy main\$' '$DL' && grep -qx 'deploying main now' '$DL' && grep -qx 'deployed main' '$DL'"
lnd
touch "$T/go"; waitfor "$T/deploy.done"
check "a second land appends to the same log (two headers)" sh -c "[ \$(grep -c '^== .* land ' '$DL') = 2 ]"

echo "== a deploy that fails never fails the land"
touch "$T/FAIL"; lnd; touch "$T/go"; sleep 0.5
check "the land exits 0 and prints its hash" sh -c "[ $RC = 0 ] && [ '$OUT' = \"\$(git -C '$C' rev-parse --short main)\" ]"
check "the deploy's error is in the log" grep -qx 'deploy: it broke' "$DL"
rm -f "$T/FAIL"

echo "== the first deploy: services.yaml declares app, services.json has none yet: land deploys too"
printf '{"processes": {"board": {}}}\n' >"$P/.run/services.json"
printf 'version: 1\nservices:\n  board:\n    command: x\n  app:\n    optional: true\n' >"$P/services.yaml"
lnd; touch "$T/go"; waitfor "$T/deploy.done"
check "declared only: the deploy started (its line), deploy main ran" sh -c "[ $RC = 0 ] && echo '$ERR' | grep -q '^land: deploying ' && grep -qx 'deploy main in $P' '$T/deploy.calls'"
printf 'version: 1\nservices:\n  board:\n    env:\n      app: nested\n' >"$P/services.yaml"
lnd; sleep 0.3
check "an app: key deeper down is no app slot: the line, no deploy" sh -c "[ '$ERR' = 'land: no app slot, no deploy' ] && [ ! -s '$T/deploy.calls' ]"
printf '{"processes": {"board": {}, "app": {}}}\n' >"$P/.run/services.json"

echo "== deploy.on_land off: nothing"
printf 'version: 1\ndeploy:\n  on_land: false   # the owner deploys by hand\nservices: {}\n' >"$P/services.yaml"
lnd; sleep 0.3
check "services.yaml deploy.on_land false: the land works, no line, no deploy" sh -c "[ $RC = 0 ] && [ -z '$ERR' ] && [ ! -s '$T/deploy.calls' ]"
DEPLOY_ON_LAND=1 lnd; touch "$T/go"; waitfor "$T/deploy.done"
check "...DEPLOY_ON_LAND=1 wins over it: deploy ran" grep -qx "deploy main in $P" "$T/deploy.calls"
rm "$P/services.yaml"; printf 'wake:\n  cap: 4\ndeploy:\n  on_land: "false"\n' >"$MM_HOME/config.yaml"
lnd; sleep 0.3
check "mm config deploy.on_land false (the machine's): no line, no deploy" sh -c "[ $RC = 0 ] && [ -z '$ERR' ] && [ ! -s '$T/deploy.calls' ]"
printf 'version: 1\ndeploy:\n  on_land: true\n' >"$P/services.yaml"
lnd; touch "$T/go"; waitfor "$T/deploy.done"
check "...the project's services.yaml on_land true wins over the machine's false" sh -c "[ $RC = 0 ] && grep -qx 'deploy main in $P' '$T/deploy.calls'"
rm "$P/services.yaml"; DEPLOY_ON_LAND=0 lnd; sleep 0.3
check "DEPLOY_ON_LAND=0: nothing" sh -c "[ $RC = 0 ] && [ -z '$ERR' ] && [ ! -s '$T/deploy.calls' ]"

echo "== nothing new to land: no deploy"
rm -f "$MM_HOME/config.yaml"; : >"$T/deploy.calls"
OUT=$("$P/bin/land" "w-$n" 2>"$T/err"); RC=$?; sleep 0.3
check "land of a landed branch: exit 0, nothing new, no deploy" sh -c "[ $RC = 0 ] && echo '$OUT' | grep -q 'nothing new' && [ ! -s '$T/deploy.calls' ]"

echo; echo "land: $pass passed, $fail failed"
[ "$fail" = 0 ]
