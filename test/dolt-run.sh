#!/usr/bin/env bash
# bin/dolt-run, hermetic: a socket file nothing answers on is removed before Dolt starts (a dead Dolt, or one from the
# other side of a box move, leaves it, and the next Dolt then serves TCP only); a live one is left and the start refused;
# a file that isn't a socket is never removed. A stand-in for Dolt records its arguments and exit code.
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

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
