#!/usr/bin/env bash
# mm.auth's start, hermetic (sy-u4oo): one log line per step, and a start that cannot go on (the accounts db locked
# by another process) ends with an error line naming the step and a non-zero exit, never a silent hang.
#   test/auth-start.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); GW=""; LK=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; [ -n "$LK" ] && kill $LK 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
mkdir -p "$MM_HOME/pc/projects"
PORT=$(( 43900 + RANDOM % 800 ))
printf 'domain: example.org\naccess: domain\nauth_port: %s\nbind_host: 127.0.0.1\n' "$PORT" >"$MM_HOME/config.yaml"
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
# the exit code of a background process, waited on for at most $2 seconds (124: still running)
waitfor() { local pid=$1 n=$(( $2 * 10 )); for _ in $(seq 1 "$n"); do kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null; return $?; }; sleep 0.1; done; return 124; }

echo '== a start with the accounts db locked by another process'
mkdir -p "$MM_HOME/auth"; chmod 700 "$MM_HOME/auth"
cat >"$T/lock.ts" <<'EOS'
import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs'
const [db, ready] = process.argv.slice(2)
const d = new Database(db, { create: true }); d.exec('PRAGMA journal_mode = WAL'); d.exec('BEGIN IMMEDIATE')
d.exec('CREATE TABLE IF NOT EXISTS held (x)'); writeFileSync(ready, 'ok')
setInterval(() => d.query('SELECT 1').get(), 200) // d stays referenced: a collected handle would close, and drop the lock
EOS
bun "$T/lock.ts" "$MM_HOME/auth/accounts.db" "$T/locked" & LK=$!
for _ in $(seq 1 50); do [ -f "$T/locked" ] && break; sleep 0.1; done
check "the lock is held (another process: BEGIN IMMEDIATE, never committed)" test -f "$T/locked"
t0=$(date +%s)
MM_AUTH_START_TIMEOUT_MS=30000 mm auth serve >"$T/gw1.log" 2>&1 & GW=$!
waitfor $GW 25; rc=$?; t1=$(date +%s); kill $GW 2>/dev/null; GW=""
check "mm auth serve exits non-zero (exit $rc), not a hang" bash -c "[ $rc != 0 ] && [ $rc != 124 ]"
check "...after its busy timeout (a few seconds; took $((t1 - t0)) s)" bash -c "[ $((t1 - t0)) -ge 4 ] && [ $((t1 - t0)) -lt 20 ]"
check "...one log line per step up to it (opening the accounts db, migrating)" bash -c "grep -q '\"mm.auth start: opening the accounts db\"' '$T/gw1.log' && grep -q '\"mm.auth start: migrating\"' '$T/gw1.log'"
check "...and an error line naming the step" bash -c "grep '\"level\":\"error\"' '$T/gw1.log' | grep -q 'mm.auth start failed while migrating'"
check "...nothing listens" bash -c "! curl -s -o /dev/null --max-time 2 http://127.0.0.1:$PORT/s"

echo '== the same lock, a start timeout shorter than the busy wait: the thread is blocked, the watchdog ends it'
MM_AUTH_START_TIMEOUT_MS=500 mm auth serve >"$T/gw4.log" 2>&1 & GW=$!; t0=$(date +%s)
waitfor $GW 15; rc=$?; t1=$(date +%s); kill $GW 2>/dev/null; GW=""
check "it ends non-zero (exit $rc: killed) at the limit + 2 s, before the busy timeout (took $((t1 - t0)) s)" bash -c "[ $rc != 0 ] && [ $rc != 124 ] && [ $((t1 - t0)) -lt 5 ]"
check "...with an error line naming the step it waits on" bash -c "grep '\"level\":\"error\"' '$T/gw4.log' | grep -q 'mm.auth start blocked for 2500 ms while migrating; killed'"
kill $LK 2>/dev/null; wait $LK 2>/dev/null; LK=""

echo '== the lock gone: the start goes through every step'
MM_AUTH_START_TIMEOUT_MS=30000 mm auth serve >"$T/gw2.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do grep -q 'mm.auth listening on' "$T/gw2.log" 2>/dev/null && break; sleep 0.2; done
check "the steps, in order: starting, opening, migrating, migrated, waiting for the context, context ready, binding, listening on" bash -c "grep -o '\"msg\":\"mm.auth [^\"]*' '$T/gw2.log' | sed 's/\"msg\":\"//; s/ on 127.*//' | tr '\n' '|' | grep -qF 'mm.auth start: starting|mm.auth start: opening the accounts db|mm.auth start: migrating|mm.auth start: migrated|mm.auth start: waiting for the auth context|mm.auth start: context ready|mm.auth start: binding|mm.auth listening|'"
check "...and it answers" bash -c "curl -s -o /dev/null --max-time 2 http://127.0.0.1:$PORT/s"
kill $GW 2>/dev/null; wait $GW 2>/dev/null; GW=""
MM_AUTH_START_TIMEOUT_MS=1500 mm auth serve >"$T/gw3.log" 2>&1 & GW=$!
sleep 4
check "a start that listens in time keeps running past its start timeout (MM_AUTH_START_TIMEOUT_MS=1500)" bash -c "kill -0 $GW && ! grep -q 'timed out' '$T/gw3.log'"
kill $GW 2>/dev/null; GW=""

[ "$fail" = 0 ] || { for f in "$T"/gw*.log; do echo "--- $f"; tail -8 "$f"; done; }
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
