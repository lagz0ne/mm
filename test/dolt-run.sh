#!/usr/bin/env bash
# bin/dolt-run, hermetic: a socket file nothing answers on is removed before Dolt starts (a dead Dolt, or one from the
# other side of a box move, leaves it, and the next Dolt then serves TCP only); a live one is left and the start refused;
# a file that isn't a socket is never removed. A stand-in for Dolt records its arguments and exit code. An orphan
# `dolt sql-server` on this board's data (sy-a0ac) is stopped and logged before Dolt starts; any other process is left.
#   test/dolt-run.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); RUN="$SRC/template/bin/dolt-run"
T=$(mktemp -d); trap 'kill $LIVE 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }
printf '#!/bin/sh\necho "$@" > "%s/args"; exit ${FAKE_EXIT:-0}\n' "$T" >"$T/dolt"; chmod +x "$T/dolt"
# a socket left behind: a server that binds it, then dies without removing it
stale() { node -e "const s=require('net').createServer().listen(process.argv[1],()=>process.kill(process.pid,'SIGKILL'))" "$1"; }

echo "== no socket file: Dolt starts"
check "exit 0, Dolt got its arguments" sh -c "'$RUN' '$T/a.sock' '$T/dolt' sql-server --socket '$T/a.sock' && grep -qx 'sql-server --socket $T/a.sock' '$T/args'"
echo "== a stale socket (its server died)"
stale "$T/s.sock"
check "...the file is there and is a socket" test -S "$T/s.sock"
check "dolt-run removes it, says so, and starts Dolt" sh -c "'$RUN' '$T/s.sock' '$T/dolt' x | grep -q 'removed a stale socket' && [ ! -e '$T/s.sock' ] && grep -qx x '$T/args'"
echo "== a live socket (another Dolt answers)"
node -e "require('net').createServer((c)=>c.end()).listen(process.argv[1])" "$T/l.sock" & LIVE=$!
for _ in $(seq 1 50); do [ -S "$T/l.sock" ] && break; sleep 0.1; done
rm -f "$T/args"
check "refused (exit 1), says why, Dolt not started" sh -c "! '$RUN' '$T/l.sock' '$T/dolt' x 2>'$T/err' && grep -q 'another Dolt answers' '$T/err' && [ ! -e '$T/args' ]"
check "...and the live socket is untouched" test -S "$T/l.sock"
echo "== a file that is not a socket"
echo data >"$T/f.sock"
check "refused, and the file is kept" sh -c "! '$RUN' '$T/f.sock' '$T/dolt' x 2>/dev/null && grep -qx data '$T/f.sock'"
echo "== Dolt's exit code comes back"
check "exit 3 from Dolt: dolt-run exits 3" sh -c "FAKE_EXIT=3 '$RUN' '$T/b.sock' '$T/dolt' x; [ \$? = 3 ]"

# sy-a0ac: a `dolt sql-server` bd started for this board while its Dolt was down holds the database lock; dolt-run
# stops it (TERM, then KILL after 10 s) and logs it at warn before Dolt starts. Two boards (a: this one, b: another),
# each with its own dolt-run; a stand-in `dolt` that runs until stopped (DOLT_IGNORE_TERM: it ignores TERM).
echo "== an orphan Dolt on this board's data"
for b in a b; do mkdir -p "$T/$b/bin" "$T/$b/control/.beads/dolt"; cp "$RUN" "$T/$b/bin/dolt-run"; done
mkdir -p "$T/x"; printf '#!/bin/sh\n[ -n "${DOLT_IGNORE_TERM:-}" ] && trap "" TERM\nwhile :; do sleep 0.2; done\n' >"$T/x/dolt"; chmod +x "$T/x/dolt"
BEADS_A="$T/a/control/.beads"; BEADS_B="$T/b/control/.beads"
up() { [ -e "/proc/$1/stat" ] && [ "$(sed 's/.*) //' "/proc/$1/stat" | cut -c1)" != Z ]; } # running, not a zombie
PIDS=(); trap 'kill ${PIDS[*]:-} $LIVE 2>/dev/null; pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT
(cd "$BEADS_A/dolt" && exec "$T/x/dolt" sql-server --config "$BEADS_A/dolt-server-config.yaml") & O1=$!; PIDS+=($O1)  # as bd starts it
(cd "$T/a" && exec "$T/x/dolt" sql-server --config control/.beads/dolt-server-config.yaml) & O2=$!; PIDS+=($O2)      # relative --config
(cd "$T/a" && exec "$T/x/dolt" --data-dir "$BEADS_A/dolt" sql-server) & O3=$!; PIDS+=($O3)                         # --data-dir
(cd "$BEADS_B/dolt" && exec "$T/x/dolt" sql-server --config "$BEADS_B/dolt-server-config.yaml") & OB=$!; PIDS+=($OB)  # another board's
(cd "$T/x" && exec "$T/x/dolt" sql-server --config "$T/x/c.yaml") & OX=$!; PIDS+=($OX)                             # nobody's board
(cd "$BEADS_A/dolt" && exec "$T/x/dolt" sql -q 'select 1') & N1=$!; PIDS+=($N1)                                    # dolt, not a server
(cd "$BEADS_A/dolt" && exec sleep 300) & N2=$!; PIDS+=($N2)                                                         # not dolt
sleep 0.5
# the Dolt dolt-run starts: it says whether the orphans still run when it starts
printf '#!/bin/sh\nfor p in %s %s %s; do [ -e /proc/$p/stat ] && [ "$(sed "s/.*) //" /proc/$p/stat | cut -c1)" != Z ] && echo "$p up" >>"%s/seen"; done\necho started >>"%s/seen"\n' "$O1" "$O2" "$O3" "$T" "$T" >"$T/dolt-seen"; chmod +x "$T/dolt-seen"
"$T/a/bin/dolt-run" "$T/a/s.sock" "$T/dolt-seen" >"$T/out" 2>"$T/err"; RC=$?
check "exit 0, and Dolt started" sh -c "[ $RC = 0 ] && grep -qx started '$T/seen'"
check "...after the orphans had stopped (none of them still ran)" sh -c "! grep -q ' up' '$T/seen'"
check "the orphan bd starts (cwd and --config in this board's .beads) is stopped" bash -c "$(declare -f up); ! up $O1"
check "...one with a relative --config under this board" bash -c "$(declare -f up); ! up $O2"
check "...one with --data-dir under this board" bash -c "$(declare -f up); ! up $O3"
check "...each logged at warn, with its pid, stopped by TERM" sh -c "for p in $O1 $O2 $O3; do grep '\"pid\":'\$p'[,}]' '$T/out' | jq -e 'select(.level == \"warn\" and (.msg | test(\"orphan Dolt.*TERM\")))' || exit 1; done"
check "another board's Dolt is left" bash -c "$(declare -f up); up $OB"
check "...and a Dolt of nobody's board" bash -c "$(declare -f up); up $OX"
check "...and a dolt that is not a server, in this board's data" bash -c "$(declare -f up); up $N1"
check "...and a process that is not dolt, in this board's data" bash -c "$(declare -f up); up $N2"
check "...and none of them is logged" sh -c "! grep -E '\"pid\":($OB|$OX|$N1|$N2)[,}]' '$T/out'"

echo "== a Dolt another dolt-run of this board runs is not an orphan"
(cd "$BEADS_A/dolt" && exec "$T/a/bin/dolt-run" "$T/a/m.sock" "$T/x/dolt" sql-server --socket "$T/a/m.sock") & MGR=$!; PIDS+=($MGR)
for _ in $(seq 1 50); do M=$(pgrep -P $MGR) && break; sleep 0.1; done; PIDS+=($M)
check "...(the managed Dolt runs)" bash -c "$(declare -f up); [ -n '$M' ] && up $M"
"$T/a/bin/dolt-run" "$T/a/s2.sock" "$T/dolt" x >"$T/out2" 2>&1
check "a second dolt-run leaves it (and its dolt-run) running, and logs nothing" bash -c "$(declare -f up); up $M && up $MGR && ! grep -q orphan '$T/out2'"
kill $MGR; for _ in $(seq 1 50); do up $M || break; sleep 0.1; done

echo "== an orphan that ignores TERM"
(cd "$BEADS_A/dolt" && DOLT_IGNORE_TERM=1 exec "$T/x/dolt" sql-server --config "$BEADS_A/dolt-server-config.yaml") & O4=$!; PIDS+=($O4)
sleep 0.5; S=$SECONDS
"$T/a/bin/dolt-run" "$T/a/s3.sock" "$T/dolt" x >"$T/out3" 2>&1; RC=$?
check "KILL after 10 s: stopped, Dolt started, logged at warn" bash -c "$(declare -f up); [ $RC = 0 ] && ! up $O4 && [ $((SECONDS - S)) -ge 10 ] && grep '\"pid\":$O4[,}]' '$T/out3' | jq -e 'select(.level == \"warn\" and (.msg | test(\"KILL after 10 s\")))'"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
