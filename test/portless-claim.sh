#!/usr/bin/env bash
# portless --force never signals a process that only got the pid of a dead wrapper (sy-1qkv), hermetic: a throwaway
# HOME / MM_HOME and portless' registry in $T, a stand-in portless on PATH (test/lib/fake-portless.mjs: it registers
# and, with --force, sends TERM to the live pid on record, as portless' addRoute does; no proxy). Proves:
#  1. the definitions: an HTTP service runs mm's check (src/portless-claim.mjs, written by writePortlessClaim) and then
#     execs its wrapper; leaveHost still knows the wrapper (wrapperCommand, sameCommand), also an older definition
#  2. a restart takes its name over from its previous wrapper (that one gets TERM, as before)
#  3. control: without the check, a stand-in on the recorded pid gets TERM
#  4. a stand-in on the recorded pid (a reused pid: another command line): never signalled; its record goes, one WARN
#     line says so; another name's record stays
#  5. ...another project's wrapper on that pid: the same (a wrapper, but not of this name)
#  6. the pid is gone: the check leaves the record to portless (which drops it itself); the start works
#  7. the registry: none (nothing written, exit 0); the default ~/.portless without PORTLESS_STATE_DIR; a stale lock is
#     taken over; a held one is never passed (exit 1 after 15 s, the file unchanged)
#   test/portless-claim.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun"); NODE=$(command -v node)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d)
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" PORTLESS_STATE_DIR="$T/pl"
cleanup() { pkill -9 -f "$T/" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/bin" "$MM_HOME/pc" "$PORTLESS_STATE_DIR" "$T/r"
ln -s "$NODE" "$T/bin/node"; ln -s "$BUN" "$T/bin/bun"
cp "$SRC/test/lib/fake-portless.mjs" "$T/bin/portless"; chmod +x "$T/bin/portless"
export PATH="$T/bin:/usr/bin:/bin"
RJ="$PORTLESS_STATE_DIR/routes.json" H=web.acme-shop.localhost
alive() { [ -d "/proc/$1" ] && ! grep -q '^[0-9]* ([^)]*) Z' "/proc/$1/stat" 2>/dev/null; }
rec() { jq -r --arg h "${1:-$H}" '[.[] | select(.hostname == $h) | .pid][0] // empty' "$RJ" 2>/dev/null; }
setrec() { jq --arg h "${2:-$H}" --argjson p "$1" '[.[] | select(.hostname != $h)] + [{hostname: $h, port: 4999, pid: $p, registeredAt: 1}]' "$RJ" >"$RJ.new" && mv "$RJ.new" "$RJ"; }
export T RJ H; export -f alive rec
waitrec() { for _ in $(seq 1 50); do [ "$(rec)" = "$1" ] && return 0; sleep 0.1; done; return 1; }
# a stand-in on a reused pid: another command line, and a mark if it ever gets TERM
standin() { bash -c "trap 'echo TERM >>$T/term.$1; exit 0' TERM; while :; do sleep 0.1; done" </dev/null >/dev/null 2>&1 & echo $!; }
start() { ( cd "$T/r" && exec bash -c "$1" ) </dev/null >>"$T/run.log" 2>&1 & echo $!; } # as process-compose runs a command

echo "== 1. the definitions"
"$BUN" -e "
  import { serviceProcess, writePortlessClaim, wrapperCommand } from '$SRC/src/project.ts'
  const claim = writePortlessClaim('$MM_HOME/pc'), s = { command: 'exec sleep 600', port: 'http' }
  const p = serviceProcess('$T/r', 'acme-shop', 'web', s, { web: s }, { env: {}, socket: '/x', pdeath: '', claim })
  await Bun.write('$T/defs.json', JSON.stringify({ claim, again: writePortlessClaim('$MM_HOME/pc'), cmd: p.command, w: wrapperCommand(p.command),
    old: wrapperCommand(\"portless web.acme-shop --force sh -c 'exec sleep 600'\"), none: wrapperCommand('exec sleep 600') }))" || bad "serviceProcess/writePortlessClaim"
CLAIM="$MM_HOME/pc/portless-claim.mjs"
CMD=$(jq -r .cmd "$T/defs.json") W=$(jq -r .w "$T/defs.json")
is "an HTTP service: the check, then exec its wrapper ($CMD)" \
  [ "$CMD" = "node '$CLAIM' web.acme-shop && exec portless web.acme-shop --force sh -c 'exec sleep 600'" ]
is "...the check is mm's (src/portless-claim.mjs), written once (again: same path, no temp file left)" \
  bash -c "cmp -s '$CLAIM' '$SRC/src/portless-claim.mjs' && [ \"\$(jq -r .again '$T/defs.json')\" = '$CLAIM' ] && [ \"\$(ls -A '$MM_HOME/pc')\" = portless-claim.mjs ]"
is "wrapperCommand: the wrapper's part; an older definition is its own; none for another command" \
  bash -c "[ \"\$(jq -r .w '$T/defs.json')\" = \"portless web.acme-shop --force sh -c 'exec sleep 600'\" ] && [ \"\$(jq -r .old '$T/defs.json')\" = \"\$(jq -r .w '$T/defs.json')\" ] && [ -z \"\$(jq -r .none '$T/defs.json')\" ]"
is "a box's definitions run the check from its cfg folder, which writePc fills" \
  bash -c "grep -q \"const BOX_CLAIM = '/run/mm/cfg/portless-claim.mjs'\" '$SRC/src/box.ts' && grep -q 'claim: BOX_CLAIM' '$SRC/src/box.ts' && grep -q 'writePortlessClaim(cfg)' '$SRC/src/box.ts'"

echo "== 2. a restart takes over its own name"
W1=$(start "$CMD"); waitrec "$W1" || bad "the first wrapper did not register"
W2=$(start "$CMD"); waitrec "$W2" || bad "the second wrapper did not register"
sleep 0.3
is "the new wrapper holds the name (pid $W2), the old one (pid $W1) got TERM from it" bash -c "! alive $W1 && grep -qx 'killed $W1' '$T/run.log'"
is "...the wrapper runs on the pid the shell had (exec), as Node runs portless" \
  bash -c "tr '\0' ' ' </proc/$W2/cmdline | grep -qx 'node $T/bin/portless web.acme-shop --force sh -c exec sleep 600 '"
W="$W" "$BUN" -e "
  import { readFileSync } from 'node:fs'
  import { sameCommand } from '$SRC/src/project.ts'
  const argv = readFileSync('/proc/$W2/cmdline', 'utf8').split('\0').filter(Boolean), w = process.env.W
  process.exit(sameCommand(argv, w) && !sameCommand(argv.map((x) => x.replace('acme-shop', 'acme-two')), w) ? 0 : 1)" \
  && ok "...leaveHost knows it: its command line is exactly the wrapper's part (sameCommand), not another project's" \
  || bad "...leaveHost knows it: its command line is exactly the wrapper's part (sameCommand), not another project's"
kill -9 "$W2"; wait "$W1" "$W2" 2>/dev/null

echo "== 3. control: without the check, portless --force signals whatever has the pid"
C=$(standin control); setrec "$C"
W3=$(start "$W"); waitrec "$W3" || bad "the wrapper did not register"
for _ in $(seq 1 20); do [ -s "$T/term.control" ] && break; sleep 0.1; done
is "the stand-in on the recorded pid ($C) got TERM" [ -s "$T/term.control" ]
kill -9 "$W3" "$C" 2>/dev/null; wait "$W3" "$C" 2>/dev/null

echo "== 4. a stand-in on the recorded pid"
S=$(standin reused); B=$(standin board); setrec "$S"; setrec "$B" board.acme-shop.localhost
: >"$T/run.log"
W4=$(start "$CMD"); waitrec "$W4" || bad "the wrapper did not register"
sleep 0.5
is "the stand-in (pid $S, another command line) still runs, never signalled" bash -c "alive $S && [ ! -e '$T/term.reused' ] && ! grep -q 'killed' '$T/run.log'"
is "...its record went; the wrapper registered (pid $W4)" [ "$(jq --arg h $H '[.[] | select(.hostname == $h)] | length' "$RJ")" = 1 ]
is "...one WARN line says so (the service's log)" \
  bash -c "[ \"\$(grep -c WARN '$T/run.log')\" = 1 ] && grep -qx 'WARN portless record for web.acme-shop ($H) pointed at pid $S, which is not its wrapper: record removed, nothing signalled' '$T/run.log'"
is "...another name's record stays (board.acme-shop: pid $B, not signalled)" bash -c "[ \"\$(rec board.acme-shop.localhost)\" = $B ] && alive $B && [ ! -e '$T/term.board' ]"
kill -9 "$W4"; wait "$W4" 2>/dev/null

echo "== 5. another project's wrapper on the recorded pid"
( cd "$T/r" && exec portless web.acme-two --force sh -c 'exec sleep 600' ) >>"$T/two.log" 2>&1 & O=$!
for _ in $(seq 1 50); do [ "$(rec web.acme-two.localhost)" = "$O" ] && break; sleep 0.1; done
setrec "$O"; : >"$T/run.log"
W5=$(start "$CMD"); waitrec "$W5" || bad "the wrapper did not register"
sleep 0.3
is "acme-two's wrapper (pid $O) still runs and keeps its own name; one WARN, nothing killed" \
  bash -c "alive $O && [ \"\$(rec web.acme-two.localhost)\" = $O ] && grep -q 'pointed at pid $O, which is not its wrapper' '$T/run.log' && ! grep -q killed '$T/run.log'"
kill -9 "$W5" "$O"; wait "$W5" "$O" 2>/dev/null

echo "== 6. the recorded pid is gone"
D=$(standin dead); kill -9 "$D"; wait "$D" 2>/dev/null; setrec "$D"; cp "$RJ" "$T/before.json"
node "$CLAIM" web.acme-shop 2>"$T/gone.err"; rc=$?
is "the check exits 0 and leaves the record to portless (file unchanged, nothing logged)" bash -c "[ $rc = 0 ] && cmp -s '$RJ' '$T/before.json' && [ ! -s '$T/gone.err' ]"
W6=$(start "$CMD"); waitrec "$W6" && ok "...the start registers (pid $W6): portless dropped the dead record" || bad "...the start registers"
kill -9 "$W6"; wait "$W6" 2>/dev/null

echo "== 7. the registry"
PORTLESS_STATE_DIR="$T/none" node "$CLAIM" web.acme-shop; rc=$?
is "no registry: exit 0, nothing written" bash -c "[ $rc = 0 ] && [ ! -e '$T/none' ]"
mkdir -p "$HOME/.portless"; S2=$(standin home)
printf '[{"hostname":"%s","port":4999,"pid":%s,"registeredAt":1}]' "$H" "$S2" >"$HOME/.portless/routes.json"
env -u PORTLESS_STATE_DIR node "$CLAIM" web.acme-shop 2>/dev/null; rc=$?
is "without PORTLESS_STATE_DIR: ~/.portless, as portless (the foreign record went)" bash -c "[ $rc = 0 ] && [ \"\$(jq length '$HOME/.portless/routes.json')\" = 0 ] && alive $S2"
setrec "$S2"; mkdir "$PORTLESS_STATE_DIR/routes.lock"; touch -d '-1 min' "$PORTLESS_STATE_DIR/routes.lock"
timeout 10 node "$CLAIM" web.acme-shop 2>/dev/null; rc=$?
is "a stale lock (1 min old) is taken over, then released: the record went" bash -c "[ $rc = 0 ] && [ -z \"\$(rec)\" ] && [ ! -e '$PORTLESS_STATE_DIR/routes.lock' ]"
setrec "$S2"; mkdir "$PORTLESS_STATE_DIR/routes.lock"; cp "$RJ" "$T/before.json"
( while :; do touch "$PORTLESS_STATE_DIR/routes.lock" 2>/dev/null; sleep 1; done ) >/dev/null 2>&1 & HOLD=$!
t0=$(date +%s); node "$CLAIM" web.acme-shop 2>"$T/held.err"; rc=$?; t1=$(date +%s)
kill "$HOLD"; wait "$HOLD" 2>/dev/null; rmdir "$PORTLESS_STATE_DIR/routes.lock"
is "a held lock is never passed: exit 1 after $((t1 - t0)) s, the file unchanged, an ERROR line" \
  bash -c "[ $rc = 1 ] && [ $((t1 - t0)) -ge 14 ] && cmp -s '$RJ' '$T/before.json' && grep -q '^ERROR portless record for web.acme-shop: could not lock' '$T/held.err'"
is "...and the stand-ins were never signalled" bash -c "alive $S && alive $S2 && alive $B && ! ls '$T'/term.* 2>/dev/null | grep -v control"

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
