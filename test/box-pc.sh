#!/usr/bin/env bash
# A box's process managers, hermetic: a throwaway HOME / MM_HOME, throwaway process-composes on their own sockets (never
# the machine's), no Docker (MM_DOCKER=false: a box's up stops at its image), stub processes shaped like a project.
# Proves:
#  1. sameCommand: a process is the one process-compose started only when its command line is exactly mm's (the
#     wrapper as Node runs it, the shell's own form, leading NAME=value words), never a near match (sy-pfbr)
#  2. mm box on, with a portless wrapper that ignores TERM (as in a container): the host's reload still finishes, and
#     the step says what mm stopped; a person's shell in the project, and the same command line started by hand, stay
#  3. a process that ignores TERM and isn't a wrapper with mm's command line: mm leaves it, and the step's failure says
#     what hung (never an empty "host FAIL"); the project is not boxed
#  4. a box's own process manager (its socket under mm's box folder): a restart of dolt during its first start leaves
#     bd-serve, board and wake Skipped; healSkipped starts them, and only the names in mm's file for the box (sy-5pvp)
#  5. ...a dependency down for good there: healSkipped doesn't wait, and starts nothing
#   test/box-pc.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
PC_BIN=${PC_BIN:-$HOME/.mm/bin/process-compose}
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun"); NODE=$(command -v node)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d)
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_DOCKER=false
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t GIT_CONFIG_GLOBAL=/dev/null
SOCK="$MM_HOME/pc.sock" BSOCK=""
# everything this test started works in $T (or is a process-compose on its socket): only those are stopped
inT() { local c; c=$(readlink "/proc/$1/cwd" 2>/dev/null) && case "$c" in "$T"|"$T"/*) return 0;; esac; return 1; }
cleanup() {
  for s in "$SOCK" "$BSOCK"; do [ -S "$s" ] && timeout 5 "$PC_BIN" -U -u "$s" down >/dev/null 2>&1; done
  for p in /proc/[0-9]*; do p=${p#/proc/}; [ "$p" != $$ ] && inT "$p" && kill -9 "$p" 2>/dev/null; done
  pkill -9 -f "$T/" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/bin" "$MM_HOME/bin" "$MM_HOME/pc/projects"
ln -s "$PC_BIN" "$T/bin/process-compose"; ln -s "$BUN" "$T/bin/bun"; ln -s "$NODE" "$T/bin/node"
printf '#!/bin/sh\nexec sleep 600\n' >"$MM_HOME/bin/mm"; chmod +x "$MM_HOME/bin/mm" # mm.cron's command
export PATH="$T/bin:/usr/bin:/bin:/usr/sbin"
command -v victoria-logs >/dev/null && { echo "victoria-logs is on PATH: the base file would start it"; exit 2; }
# the stand-in wrapper: a script on PATH (run by its #! interpreter, as Node runs portless) that ignores TERM
printf '#!/bin/bash\ntrap "" TERM\nwhile :; do sleep 0.2; done\n' >"$T/bin/portless"; chmod +x "$T/bin/portless"
mkroot() { # <dir> <project>: a project's config repo, as the host has it
  mkdir -p "$1"; printf 'client: acme\nname: %s\nproject: %s\nshort: as\n' "${2#acme-}" "$2" >"$1/.mm-answers.yaml"
  git -C "$1" init -q -b main && git -C "$1" add -A && git -C "$1" commit -qm init; }
alive() { [ -d "/proc/$1" ] && ! grep -q '^[0-9]* ([^)]*) Z' "/proc/$1/stat" 2>/dev/null; }
host() { jq -r '.[] | select(.step == "host") | "\(.status) \(.detail)"' "$T/on.json"; }
export T; export -f alive host

echo "== 1. sameCommand"
"$BUN" -e "
  import { sameCommand as s } from '$SRC/src/project.ts'
  const w = \"portless web.acme-shop --force setpriv --pdeathsig TERM sh -c '/r/bin/bd serve --addr 127.0.0.1:\$\$PORT --x '\\\"'\\\"'y z'\\\"'\\\"''\"
  const argv = ['node', '/h/.mm/bin/portless', 'web.acme-shop', '--force', 'setpriv', '--pdeathsig', 'TERM', 'sh', '-c', \"/r/bin/bd serve --addr 127.0.0.1:\$PORT --x 'y z'\"]
  const cases = [
    ['the wrapper as Node runs it (#! interpreter, the script found on PATH)', s(argv, w), true],
    ['...another project of the same service', s(argv.map((x) => x.replace('acme-shop', 'acme-shop2')), w), false],
    ['...one word more', s([...argv, 'x'], w), false],
    ['...one word less', s(argv.slice(0, -1), w), false],
    ['...another program by that name', s(['node', '/h/other', ...argv.slice(2)], w), false],
    ['a person\'s shell in the project', s(['bash'], w) || s(['-bash'], w) || s(['bash', '-i'], w), false],
    ['the shell running the command itself (bash -c, \$\$ as \$)', s(['bash', '-c', 'a \$x; b'], 'a \$\$x; b'), true],
    ['...but not another command', s(['bash', '-c', 'a; c'], 'a; b'), false],
    ['a command process-compose fills (\$VAR): only its shell form', s(['sleep', '600'], 'sleep \$T'), false],
    ['leading NAME=value words and exec go', s(['node', 'server.js'], 'HOST=\$\${MM_BIND:-\$\$HOST} exec node server.js'), true],
    ['a program run as typed', s(['sleep', '600'], 'exec sleep 600'), true],
    ['...its path is not its name', s(['/bin/sleep', '600'], 'sleep 600'), false],
  ]
  let bad = 0
  for (const [d, got, want] of cases) { console.log((got === want ? 'ok ' : 'BAD ') + d); if (got !== want) bad++ }
  process.exit(bad ? 1 : 0)" >"$T/same.out" 2>&1
while read -r st d; do [ "$st" = ok ] && ok "$d" || bad "$st $d"; done <"$T/same.out"
is "...all 12 cases ran" [ "$(grep -c '^\(ok\|BAD\) ' "$T/same.out")" = 12 ]

echo "== 2. mm box on: a wrapper that ignores TERM"
R="$T/projects/acme/shop"; mkroot "$R" acme-shop
cat >"$MM_HOME/pc/projects/acme-shop.yaml" <<EOF
version: "0.5"
processes:
  acme-shop.web:
    namespace: acme-shop
    command: "portless web.acme-shop --force sh -c 'exec sleep 600'"
    working_dir: $R
  acme-shop.db:
    namespace: acme-shop
    command: "exec sleep 600"
    working_dir: $R
EOF
"$BUN" -e "import { writeBase } from '$SRC/src/pc.ts'; writeBase()"
"$PC_BIN" up -t=false --keep-project -U -u "$SOCK" -L "$T/pcm.log" -f "$MM_HOME/pc/base.yaml" >/dev/null 2>&1 &
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
"$BUN" -e "import { loadAll } from '$SRC/src/project.ts'; process.exit(loadAll().ok ? 0 : 1)" || bad "loading the project"
pid() { "$PC_BIN" -U -u "$SOCK" process list -o json 2>/dev/null | jq -r --arg n "$1" '.[] | select(.name == $n and .status == "Running") | .pid'; }
for _ in $(seq 1 30); do [ -n "$(pid acme-shop.web)" ] && break; sleep 0.2; done
WEB=$(pid acme-shop.web)
is "the wrapper runs on the host's process manager (pid $WEB)" [ -n "$WEB" ]
# the decoys: a person's shell working in the project that ignores TERM, and the wrapper's exact command line by hand
( cd "$R" && exec bash -c 'trap "" TERM; while :; do sleep 0.2; done' ) & SHELLP=$!
( cd "$R" && exec portless web.acme-shop --force sh -c 'exec sleep 600' ) & HAND=$!
on() { "$BUN" -e "import { on } from '$SRC/src/box.ts'; await Bun.write('$T/on.json', JSON.stringify(on('$1')))"; }
t0=$(date +%s); MM_PC_UPDATE_MS=20000 on "$R"; t1=$(date +%s)
is "box on's host step finishes ok ($((t1 - t0)) s): $(host)" bash -c "[ \"\$(host | cut -d' ' -f1)\" = ok ] && [ $((t1 - t0)) -lt 30 ]"
is "...and says what it stopped (the wrapper, by name and pid)" bash -c "host | grep -q 'stopped 1 wrapper(s) left running after the stop: acme-shop.web (pid $WEB, KILL)'"
is "...the wrapper is gone, and nothing of the project is on the host's process manager" bash -c "! alive $WEB && ! '$PC_BIN' -U -u '$SOCK' process list -o json | jq -e '.[] | select(.name | startswith(\"acme-shop.\"))' >/dev/null"
is "...a person's shell in the project, and the same command line started by hand, still run" bash -c "alive $SHELLP && alive $HAND"
is "...then on to the box (its up stops at the image here: no Docker)" bash -c "jq -e '[.[].step] | index(\"answers\") and index(\"image\")' '$T/on.json' >/dev/null && grep -qx 'box: true' '$R/.mm-answers.yaml'"
kill -9 $SHELLP $HAND 2>/dev/null; wait $SHELLP $HAND 2>/dev/null

echo "== 3. a process that ignores TERM and isn't mm's wrapper: what hung, never an empty failure"
R2="$T/projects/acme/two"; mkroot "$R2" acme-two
cat >"$MM_HOME/pc/projects/acme-two.yaml" <<EOF
version: "0.5"
processes:
  acme-two.odd:
    namespace: acme-two
    command: "exec bash -c 'trap \"\" TERM; while :; do sleep 0.2; done'"
    working_dir: $R2
EOF
"$BUN" -e "import { loadAll } from '$SRC/src/project.ts'; process.exit(loadAll().ok ? 0 : 1)" || bad "loading the second project"
for _ in $(seq 1 30); do [ -n "$(pid acme-two.odd)" ] && break; sleep 0.2; done
ODD=$(pid acme-two.odd)
t0=$(date +%s); MM_PC_UPDATE_MS=4000 on "$R2"; t1=$(date +%s)
is "box on fails, bounded ($((t1 - t0)) s): $(host | cut -c1-220)" bash -c "[ \"\$(host | cut -d' ' -f1)\" = fail ] && [ $((t1 - t0)) -lt 40 ]"
is "...the failure says the reload got no answer, and what still runs (name, pid, why mm left it)" bash -c "host | grep -q \"gave no answer in 4 s; still running: acme-two.odd (pid $ODD, not a wrapper with mm's exact command line: left alone)\""
is "...mm left it running, and the project is not boxed (no box: line, nothing after the host step)" bash -c "alive $ODD && ! grep -q '^box:' '$R2/.mm-answers.yaml' && [ \"\$(jq length '$T/on.json')\" = 1 ]"
kill -9 "$ODD" 2>/dev/null

echo "== 4. inside a box: heal what its own process manager left Skipped"
B="$T/projects/acme/boxed"; mkroot "$B" acme-boxed
HD="$MM_HOME/box/acme-boxed"; mkdir -p "$HD/cfg" "$HD/sock"; BSOCK="$HD/sock/pc.sock"
# mm's file for the box (src/box.ts writePc): dolt ready DOLT_UP s after each start, like a slow Dolt under load
cat >"$T/box.yaml" <<EOF
version: "0.5"
processes:
  acme-boxed.dolt:
    namespace: acme-boxed
    command: "rm -f $T/dolt.up; sleep \$\${DOLT_UP:-4}; touch $T/dolt.up; exec sleep 600"
    environment: ["DOLT_UP=4"]
    availability: { restart: on_failure, backoff_seconds: 1 }
    readiness_probe: { exec: { command: "test -f $T/dolt.up" }, period_seconds: 1, failure_threshold: 60 }
  acme-boxed.bd-serve:
    namespace: acme-boxed
    command: "exec sleep 600"
    availability: { restart: always, backoff_seconds: 1 }
    readiness_probe: { exec: { command: "true" }, period_seconds: 1 }
    depends_on: { acme-boxed.dolt: { condition: process_healthy } }
  acme-boxed.board:
    namespace: acme-boxed
    command: "exec sleep 600"
    availability: { restart: always, backoff_seconds: 1 }
    readiness_probe: { exec: { command: "true" }, period_seconds: 1 }
    depends_on: { acme-boxed.bd-serve: { condition: process_healthy } }
  acme-boxed.wake:
    namespace: acme-boxed
    command: "exec sleep 600"
    availability: { restart: always, backoff_seconds: 1 }
    depends_on: { acme-boxed.bd-serve: { condition: process_healthy } }
EOF
cp "$T/box.yaml" "$HD/cfg/pc.yaml"
# ...and one the box added itself (not in mm's file): it waits on dolt too, and mm must not start it
cat >"$T/rogue.yaml" <<EOF
version: "0.5"
processes:
  rogue:
    command: "exec sleep 600"
    depends_on: { acme-boxed.dolt: { condition: process_healthy } }
EOF
bst() { "$PC_BIN" -U -u "$BSOCK" process list -o json 2>/dev/null | jq -r --arg n "$1" '.[] | select(.name == $n) | "\(.status) \(.is_ready)"'; }
ballup() { [ "$(bst acme-boxed.dolt)" = "Running Ready" ] && [ "$(bst acme-boxed.bd-serve)" = "Running Ready" ] && [ "$(bst acme-boxed.board)" = "Running Ready" ] && [ "$(bst acme-boxed.wake | cut -d' ' -f1)" = Running ]; }
heal() { "$BUN" -e "import { healSkipped } from '$SRC/src/box.ts'; await Bun.write('$T/healed', healSkipped('$B').join(' '))"; }
boxpc() { # the box's process manager, as the box starts it (its first start)
  ( cd "$B" && exec "$PC_BIN" up -t=false --keep-project -U -u "$BSOCK" -L "$T/box-pc.log" -f "$HD/cfg/pc.yaml" "$@" ) >/dev/null 2>&1 &
  for _ in $(seq 1 50); do [ -S "$BSOCK" ] && break; sleep 0.1; done; }
boxpc -f "$T/rogue.yaml"
( sleep 1.5; "$PC_BIN" -U -u "$BSOCK" process restart acme-boxed.dolt >/dev/null 2>&1 ) &
t0=$(date +%s); heal; t1=$(date +%s)
is "the restart left them Skipped in the box's process manager (the race happened)" grep -q "process acme-boxed.bd-serve won't run" "$T/box-pc.log"
is "healSkipped started them again, on the box's socket: $(cat "$T/healed")" grep -q acme-boxed.bd-serve "$T/healed"
ballup; up=$?
is "...dolt, bd-serve, board and wake up ($((t1 - t0)) s, at most 90)" bash -c "[ $up = 0 ] && [ $((t1 - t0)) -le 95 ]"
is "...and the process the box added itself stays as it was (Skipped): mm starts only its own names" bash -c "[ \"\$('$PC_BIN' -U -u '$BSOCK' process list -o json | jq -r '.[] | select(.name == \"rogue\") | .status')\" = Skipped ] && ! grep -qw rogue '$T/healed'"

echo "== 5. ...a dependency down for good in the box"
timeout 10 "$PC_BIN" -U -u "$BSOCK" down >/dev/null 2>&1; for _ in $(seq 1 50); do [ -S "$BSOCK" ] || break; sleep 0.1; done; rm -f "$BSOCK"
sed -e 's/sleep \$\${DOLT_UP:-4}; touch [^;]*; exec sleep 600/exit 0/' "$T/box.yaml" >"$HD/cfg/pc.yaml"
grep -q 'command: "rm -f [^"]*; exit 0"' "$HD/cfg/pc.yaml" || bad "the test's dolt that exits"
boxpc
t0=$(date +%s); heal; t1=$(date +%s)
is "healSkipped doesn't wait for it ($((t1 - t0)) s)" [ $((t1 - t0)) -lt 20 ]
is "...and starts nothing behind it" [ ! -s "$T/healed" ]

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
