#!/usr/bin/env bash
# The first-start race (sy-5ku, sy-ynb), hermetic: a throwaway HOME / MM_HOME, a throwaway process-compose on its own
# socket (never the machine's) and stub processes shaped like a project (dolt <- bd-serve <- board, wake).
# Proves:
#  1. bin/dolt-ready says ready only when a query gets a result (a stand-in MySQL socket: ok, auth switch, refused,
#     silent), and quits cleanly
#  2. the generated definitions: dolt's readiness is that query (ready.exec, placeholders filled), bd-serve waits for
#     it, and every HTTP service's portless wrapper has --force
#  3. loadAll: a restart of dolt while its dependents wait (what an old board's health did) leaves them Skipped in
#     process-compose; loadAll starts them once dolt is ready again, and returns with all of them up
#  4. the same project unloaded and loaded again (a stale instance of each process): all up after each load
#  5. a dependency that is down for good: loadAll doesn't wait for it, and starts nothing behind it
#   test/pc-skipped.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
PC_BIN=${PC_BIN:-$HOME/.mm/bin/process-compose}
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun"); NODE=$(command -v node)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d)
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
SOCK="$MM_HOME/pc.sock"
cleanup() { [ -S "$SOCK" ] && "$PC_BIN" -U -u "$SOCK" down >/dev/null 2>&1; pkill -f "$T/" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/bin" "$MM_HOME/bin" "$MM_HOME/pc/projects"
ln -s "$PC_BIN" "$T/bin/process-compose"; ln -s "$BUN" "$T/bin/bun"; ln -s "$NODE" "$T/bin/node"
printf '#!/bin/sh\nexec sleep 600\n' >"$MM_HOME/bin/mm"; chmod +x "$MM_HOME/bin/mm" # mm.cron's command
# only what this test gives it: no portless or obs tools, so the base file is mm.cron alone
export PATH="$T/bin:/usr/bin:/bin:/usr/sbin"
for t in portless victoria-logs; do command -v $t >/dev/null && { echo "$t is on PATH: the base file would start it"; exit 2; }; done

echo "== 1. bin/dolt-ready"
FM="$SRC/test/lib/fake-mysql.mjs" DR="$SRC/template/bin/dolt-ready"
probe() { # <mode>: start the stand-in, run dolt-ready; prints its exit code
  local s="$T/my-$1.sock"; node "$FM" "$s" "$1" & local pid=$!
  for _ in $(seq 1 50); do [ -S "$s" ] && break; sleep 0.05; done
  DOLT_READY_TIMEOUT_MS=1500 node "$DR" "$s" 2>"$T/dr-$1.err"; local rc=$?; kill $pid 2>/dev/null; wait $pid 2>/dev/null; echo $rc; }
is "a query gets a result: ready (exit 0)" [ "$(probe ok)" = 0 ]
is "...as root, without a password, then SELECT 1, then a clean quit" bash -c "l='$T/my-ok.sock.log'; sed -n 1p \"\$l\" | grep -q '726f6f7400' && sed -n 2p \"\$l\" | grep -q '^0 0353454c4543542031$' && sed -n 3p \"\$l\" | grep -q '^0 01$'"
is "the server asks to switch the auth method: answered, ready" [ "$(probe switch)" = 0 ]
rc=$(probe deny); is "login refused: not ready, and says why" bash -c "[ $rc = 1 ] && grep -q 'error 1045' '$T/dr-deny.err'"
rc=$(probe silent); is "connects but no answer (Dolt still loading): not ready within its timeout" bash -c "[ $rc = 1 ] && grep -q 'no answer' '$T/dr-silent.err'"
is "no socket yet: not ready" bash -c "DOLT_READY_TIMEOUT_MS=1000 node '$DR' '$T/none.sock' 2>/dev/null; [ \$? = 1 ]"

echo "== 2. the generated definitions"
R="$T/acme"; mkdir -p "$R/release"
cp "$SRC/template/services.yaml" "$R/services.yaml"
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: as\n' >"$R/.mm-answers.yaml"
"$BUN" -e "
  import { resolve, serviceProcess } from '$SRC/src/project.ts'
  const { services } = resolve('$R'), o = { env: {}, socket: '$R/.dolt/mysql.sock', pdeath: '' }
  const ps = Object.fromEntries(Object.entries(services).map(([n, s]) => [n, serviceProcess('$R', 'acme-shop', n, s, services, o)]))
  await Bun.write('$T/defs.json', JSON.stringify(ps))" || bad "resolve/serviceProcess"
is "dolt's readiness runs the query over its socket (placeholders filled)" \
  bash -c "[ \"\$(jq -r '.dolt.readiness_probe.exec.command' '$T/defs.json')\" = 'node $R/bin/dolt-ready $R/.dolt/mysql.sock' ]"
is "bd-serve waits for dolt to be healthy (that probe)" bash -c "[ \"\$(jq -r '.\"bd-serve\".depends_on.\"acme-shop.dolt\".condition' '$T/defs.json')\" = process_healthy ]"
is "every HTTP service's portless wrapper takes over its own name (--force)" \
  bash -c "jq -e '[to_entries[] | select(.value.command | startswith(\"portless \"))] | length >= 3 and all(.value.command | test(\"^portless [a-z-]+[.]acme-shop --force \"))' '$T/defs.json' >/dev/null"

echo "== 3. loadAll heals what a restart of dolt left Skipped"
# dolt: ready DOLT_UP seconds after each start (its marker is removed at start), like a slow Dolt under load
cat >"$MM_HOME/pc/projects/t.yaml" <<EOF
version: "0.5"
processes:
  t.dolt:
    namespace: t
    command: "rm -f $T/dolt.up; sleep \$\${DOLT_UP:-4}; touch $T/dolt.up; exec sleep 600"
    environment: ["DOLT_UP=4"]
    availability: { restart: on_failure, backoff_seconds: 1 }
    readiness_probe: { exec: { command: "test -f $T/dolt.up" }, period_seconds: 1, failure_threshold: 60 }
  t.bd-serve:
    namespace: t
    command: "exec sleep 600"
    availability: { restart: always, backoff_seconds: 1 }
    readiness_probe: { exec: { command: "true" }, period_seconds: 1 }
    depends_on: { t.dolt: { condition: process_healthy } }
  t.board:
    namespace: t
    command: "exec sleep 600"
    availability: { restart: always, backoff_seconds: 1 }
    readiness_probe: { exec: { command: "true" }, period_seconds: 1 }
    depends_on: { t.bd-serve: { condition: process_healthy } }
  t.wake:
    namespace: t
    command: "exec sleep 600"
    availability: { restart: always, backoff_seconds: 1 }
    depends_on: { t.bd-serve: { condition: process_healthy } }
EOF
cp "$MM_HOME/pc/projects/t.yaml" "$T/t.yaml"
"$BUN" -e "import { writeBase } from '$SRC/src/pc.ts'; writeBase()"
"$PC_BIN" up -t=false --keep-project -U -u "$SOCK" -L "$T/pcm.log" -f "$MM_HOME/pc/base.yaml" >/dev/null 2>&1 &
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
st() { "$PC_BIN" -U -u "$SOCK" process list -o json 2>/dev/null | jq -r --arg n "t.$1" '.[] | select(.name == $n) | "\(.status) \(.is_ready)"'; }
allup() { [ "$(st dolt)" = "Running Ready" ] && [ "$(st bd-serve)" = "Running Ready" ] && [ "$(st board)" = "Running Ready" ] && [ "$(st wake | cut -d' ' -f1)" = Running ]; }
load() { "$BUN" -e "import { loadAll } from '$SRC/src/project.ts'; const r = loadAll(); await Bun.write('$T/started', (r.started || []).join(' ')); if (!r.ok) { console.error(r.err || r.out); process.exit(1) }"; }
# the restart comes 1.5 s into the load (bd-serve, board and wake wait for dolt then)
( sleep 1.5; "$PC_BIN" -U -u "$SOCK" process restart t.dolt >/dev/null 2>&1 ) &
t0=$(date +%s); load; rc=$?; t1=$(date +%s)
is "the restart left them Skipped in process-compose (the race happened)" grep -q "process t.bd-serve won't run" "$T/pcm.log"
is "loadAll returns ok, having started again: $(cat "$T/started")" bash -c "[ $rc = 0 ] && grep -q t.bd-serve '$T/started'"
is "...with dolt, bd-serve, board and wake up ($((t1 - t0)) s)" allup

echo "== 4. unloaded and loaded again, three times"
for i in 1 2 3; do
  rm -f "$MM_HOME/pc/projects/t.yaml"; load >/dev/null 2>&1
  cp "$T/t.yaml" "$MM_HOME/pc/projects/t.yaml"; load
  is "load $i: all up" allup
done

echo "== 5. a dependency down for good"
rm -f "$MM_HOME/pc/projects/t.yaml"; load >/dev/null 2>&1
sed -e 's/sleep \$\${DOLT_UP:-4}; touch [^;]*; exec sleep 600/exit 0/' "$T/t.yaml" >"$MM_HOME/pc/projects/t.yaml"
grep -q 'command: "rm -f [^"]*; exit 0"' "$MM_HOME/pc/projects/t.yaml" || bad "the test's dolt that exits"
t0=$(date +%s); load; t1=$(date +%s)
is "loadAll doesn't wait for it ($((t1 - t0)) s)" [ $((t1 - t0)) -lt 20 ]
is "...and starts nothing behind it" [ ! -s "$T/started" ]

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
