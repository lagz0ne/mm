#!/usr/bin/env bash
# A throwaway MM_HOME ships no telemetry (sy-28ev): mm sends its spans, and writes the endpoints its projects' engine code
# ships to, only when the Victoria stack is this MM_HOME's (its stores keep their data under <mm home>/data). A test's
# mm, with the stack's binaries on PATH and a stack answering on the configured loopback ports, sends nothing; the same
# home once its stores have data there sends its spans. Hermetic: a throwaway HOME / MM_HOME, stub Victoria binaries,
# and a stand-in collector on loopback in place of the stack (the machine's stores are never reached).
#   test/obs-home.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); COL=''
trap '[ -n "$COL" ] && kill "$COL" 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }

export HOME="$T/home" MM_HOME="$T/home/.mm"
unset MM_OBS_TRACES MM_OBS_METRICS TRACEPARENT MM_SERVICE
mkdir -p "$MM_HOME/bin" "$MM_HOME/pc"
for t in victoria-metrics victoria-logs victoria-traces; do printf '#!/bin/sh\nexit 0\n' >"$MM_HOME/bin/$t"; chmod +x "$MM_HOME/bin/$t"; done

# the stand-in for the stack: every request it gets is one line in $T/got
printf '%s\n' "import http from 'node:http'; import fs from 'node:fs'" \
  "const s = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { fs.appendFileSync(process.argv[2], q.url + ' ' + b.length + '\\n'); r.end('{}') }) })" \
  "s.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2] + '.port', String(s.address().port)))" >"$T/col.mjs"
node "$T/col.mjs" "$T/got" & COL=$!
for _ in $(seq 1 50); do [ -s "$T/got.port" ] && break; sleep 0.1; done
PORT=$(cat "$T/got.port"); : >"$T/got"
printf 'layout: one-root\ntraces_port: %s\nmetrics_port: %s\nlogs_port: %s\n' "$PORT" "$PORT" "$PORT" >"$MM_HOME/config.yaml"

mmrun() { (cd "$SRC" && bun src/cli.ts config get no.such.key) >/dev/null 2>&1; sleep 1; }

echo "== a throwaway MM_HOME (no store data here): nothing shipped"
check "the stack's binaries are found (installed)" test -x "$MM_HOME/bin/victoria-traces"
check "obsEndpoints() is empty: a project set up from here gets no endpoints" sh -c "[ \"\$(cd '$SRC' && bun -e \"import { obsEndpoints } from './src/obs.ts'; console.log(JSON.stringify(obsEndpoints()))\")\" = '{}' ]"
mmrun
check "an mm command sends no span to the stack's port" test ! -s "$T/got"
check "...its own line in mm.log is still written (local)" grep -q '"op":"mm config get"' "$MM_HOME/pc/mm.log"

echo "== the stack is this home's (its stores keep data here): mm ships as before"
mkdir -p "$MM_HOME/data/traces" "$MM_HOME/data/metrics" "$MM_HOME/data/logs"
check "obsEndpoints() names the traces and metrics endpoints on the configured port" sh -c "cd '$SRC' && bun -e \"import { obsEndpoints } from './src/obs.ts'; const e = obsEndpoints(); process.exit(e.traces === 'http://127.0.0.1:$PORT/insert/opentelemetry/v1/traces' && e.metrics ? 0 : 1)\""
mmrun
check "an mm command sends its span" grep -q '^/insert/opentelemetry/v1/traces ' "$T/got"
: >"$T/got"
(export MM_OBS_TRACES=''; mmrun)
check "...and MM_OBS_TRACES='' still turns it off" test ! -s "$T/got"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
