#!/usr/bin/env bash
# bd never starts a Dolt of its own on an mm board (sy-a0ac), with the real bd and dolt in a throwaway HOME and project
# (nothing of the machine's is used or started). bin/init may (it has no Dolt yet), then bd-quiet turns it off for good:
# with the board's Dolt down, a bd call fails fast and says so instead of starting a server that outlives it and locks
# the board's own Dolt out. The template's bin/bd sets BEADS_DOLT_AUTO_START=0, so a board bd-quiet has not reached yet
# is covered too. And bin/dolt-run, as services.yaml runs it, stops an orphan bd started before the board's Dolt starts.
#   test/bd-autostart.sh <bd> <dolt>     the pinned binaries (e.g. a project's tools/bd and tools/dolt)
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
BD=${1:?usage: test/bd-autostart.sh <bd> <dolt>}; DOLT=${2:?usage: test/bd-autostart.sh <bd> <dolt>}
T=$(mktemp -d); export P="$T/proj"
trap '(cd "$P/control" 2>/dev/null && "$P/bin/bd" dolt stop >/dev/null 2>&1); pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
export HOME="$T/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; unset BEADS_DOLT_AUTO_START BEADS_DIR
mkdir -p "$HOME" "$P/tools"; cp -r "$SRC/template/bin" "$P/bin"
cp "$BD" "$P/tools/bd"; cp "$DOLT" "$P/tools/dolt"; chmod +x "$P/tools/bd" "$P/tools/dolt"
sha() { sha256sum "$1" | cut -d' ' -f1; }
printf '{"bd":{"linux-x64":{"installed_sha256":"%s"}},"dolt":{"linux-x64":{"installed_sha256":"%s"}}}\n' "$(sha "$P/tools/bd")" "$(sha "$P/tools/dolt")" >"$P/tools.json"
servers() { pgrep -f "$P/.*sql-server|sql-server.*$P/" ; } # a dolt sql-server of this throwaway project
CFG="$P/control/.beads/config.yaml"
bdc() { (cd "$P/control" && timeout 60 "$P/bin/bd" "$@"); }

echo "== bin/init: bd starts a Dolt for init only, bd-quiet turns auto-start off"
"$P/bin/init" tt >"$T/init.out" 2>&1; RC=$?
check "init: exit 0" sh -c "[ $RC = 0 ]"
check "...no Dolt left running" bash -c "$(declare -f servers); ! servers"
check "...dolt.auto-start: false in .beads/config.yaml (under dolt:)" sh -c "awk '/^dolt:/{d=1;next} /^[^ #]/{d=0} d && /^ +auto-start: false/{f=1} END{exit !f}' '$CFG'"

echo "== the board's Dolt down: bd fails fast, says so, starts nothing"
S=$SECONDS; bdc list >"$T/list.out" 2>&1; RC=$?
check "bd list: fails" sh -c "[ $RC != 0 ]"
check "...fast (under 30 s)" sh -c "[ $((SECONDS - S)) -lt 30 ]"
check "...and says auto-start is off" grep -q 'auto-start is disabled' "$T/list.out"
check "...no Dolt started" bash -c "$(declare -f servers); ! servers"
bdc config get no-hooks >"$T/get.out" 2>&1
check "bd config get (doctor's, bd-quiet's): no Dolt started either" bash -c "$(declare -f servers); ! servers"
BEADS_DOLT_AUTO_START=1 bdc list >/dev/null 2>&1
check "BEADS_DOLT_AUTO_START=1 does not turn it back on (the config wins)" bash -c "$(declare -f servers); ! servers"

echo "== a board bd-quiet has not reached yet (no dolt.auto-start in config.yaml): bin/bd's env alone"
sed -i '/^ *auto-start: false/d' "$CFG"
check "...(the setting is gone)" sh -c "! grep -q 'auto-start: false' '$CFG'"
bdc list >"$T/list2.out" 2>&1; RC=$?
check "bd list: fails, says auto-start is off, no Dolt started" bash -c "$(declare -f servers); [ $RC != 0 ] && grep -q 'auto-start is disabled' '$T/list2.out' && ! servers"
BEADS_DOLT_AUTO_START=1 bdc list >/dev/null 2>&1
check "control: with auto-start asked for, bd does start one (so the checks above can see one)" bash -c "$(declare -f servers); servers"

echo "== the board's Dolt starts (as services.yaml runs it) while that orphan holds the database"
ORPHAN=$(servers | head -1)
SOCK="$P/.dolt/mysql.sock"; mkdir -p "$P/.dolt" "$P/.dolt-root" "$P/.config"
PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
(cd "$P/control/.beads/dolt" && DOLT_ROOT_PATH="$P/.dolt-root" XDG_CONFIG_HOME="$P/.config" exec node "$P/bin/dolt-run" "$SOCK" "$P/tools/dolt" sql-server --host 127.0.0.1 --port "$PORT" --socket "$SOCK" --loglevel warning) >"$T/dolt.out" 2>&1 & DR=$!
for _ in $(seq 1 150); do node "$P/bin/dolt-ready" "$SOCK" >/dev/null 2>&1 && break; sleep 0.2; done
check "dolt-run stopped bd's orphan (pid $ORPHAN) and logged it at warn" bash -c "[ -n '$ORPHAN' ] && ! kill -0 $ORPHAN 2>/dev/null && grep '\"pid\":$ORPHAN[,}]' '$T/dolt.out' | jq -e 'select(.level == \"warn\")'"
check "...and the board's Dolt answers on its socket (not locked out)" node "$P/bin/dolt-ready" "$SOCK"
check "...bd works through it" sh -c "cd '$P/control' && timeout 60 '$P/bin/bd' list >/dev/null"
kill $DR; for _ in $(seq 1 50); do kill -0 $DR 2>/dev/null || break; sleep 0.2; done
check "...and when it stops, no Dolt is left" bash -c "$(declare -f servers); ! servers"

echo "== bd-quiet sets it again (with a Dolt up)"
BEADS_DOLT_AUTO_START=1 bdc list >/dev/null 2>&1
"$P/bin/bd-quiet" >"$T/quiet.out" 2>&1; RC=$?
check "bd-quiet: exit 0, says dolt.auto-start = false" sh -c "[ $RC = 0 ] && grep -qx 'bd-quiet: dolt.auto-start = false' '$T/quiet.out'"
check "...bd config get dolt.auto-start: false" sh -c "[ \"\$(cd '$P/control' && '$P/bin/bd' config get dolt.auto-start | tail -1)\" = false ]"
"$P/bin/bd-quiet" >"$T/quiet2.out" 2>&1
check "...a second run: nothing to set" sh -c "[ ! -s '$T/quiet2.out' ]"
bdc dolt stop >/dev/null 2>&1; for _ in $(seq 1 50); do servers >/dev/null || break; sleep 0.2; done
bdc list >/dev/null 2>&1
check "...and with the Dolt down again, bd starts none" bash -c "$(declare -f servers); ! servers"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
