#!/usr/bin/env bash
# Every process mm gives the process manager writes its log file line by line (sy-7e99), hermetic: a throwaway HOME /
# MM_HOME with stub tools, and a throwaway process-compose on its own socket (never the machine's).
# Proves: (1) every process in the generated base file (mm.portless, mm.cron, mm.auth, mm.ai, the obs stack, mm.ship)
# and a project's process carry log_configuration with flush_each_line and rotation; (2) with that configuration a
# line reaches its file within seconds and survives a restart; without it, it stays in process-compose's memory.
#   test/pc-logs.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
PC_BIN=${PC_BIN:-$(command -v process-compose || echo "$HOME/.mm/bin/process-compose")}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); SOCK="$T/pc.sock"
cleanup() { [ -S "$SOCK" ] && "$PC_BIN" -U -u "$SOCK" down >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
mkdir -p "$MM_HOME/bin" "$MM_HOME/pc"
for t in mm portless victoria-metrics victoria-logs victoria-traces; do printf '#!/bin/sh\nexit 0\n' >"$MM_HOME/bin/$t"; chmod +x "$MM_HOME/bin/$t"; done
printf 'auth:\n  enabled: true\nai:\n  enabled: true\n' >"$MM_HOME/config.yaml"

echo "== the generated definitions"
bun -e "import { writeBase } from '$SRC/src/pc.ts'; writeBase()" || bad "writeBase"
# every process: flush_each_line and rotation (rotation is what makes process-compose append instead of truncate)
check() { bun -e "
  const f = process.argv[1], want = process.argv[2].split(','), y = Bun.YAML.parse(await Bun.file(f).text())
  const ps = y.processes, miss = want.filter((n) => !ps[n])
  const bad = Object.entries(ps).filter(([, p]) => !(p.log_configuration?.flush_each_line === true && p.log_configuration?.rotation?.max_size_mb > 0)).map(([n]) => n)
  if (miss.length || bad.length) { console.error('missing:', miss.join(' '), 'without flush/rotation:', bad.join(' ')); process.exit(1) }" "$1" "$2"; }
is "base: every mm service flushes each line and rotates (portless, cron, auth, ai, metrics, logs, traces, ship)" \
  check "$MM_HOME/pc/base.yaml" mm.portless,mm.cron,mm.auth,mm.ai,mm.metrics,mm.logs,mm.traces,mm.ship
bun -e "
  import { serviceProcess } from '$SRC/src/project.ts'
  const s = { command: 'node x', port: 'none' }
  const p = serviceProcess('/p', 'acme', 'wake', s, { wake: s }, { env: {}, socket: '/p/.dolt/mysql.sock', pdeath: '' })
  await Bun.write('$T/proj.yaml', Bun.YAML.stringify({ processes: { 'acme.wake': p } }))" || bad "serviceProcess"
is "a project's process too" check "$T/proj.yaml" acme.wake

echo "== a throwaway process-compose: the line reaches the file"
[ -x "$PC_BIN" ] || { bad "no process-compose at $PC_BIN"; echo "$pass passed, $fail failed"; exit 1; }
LOGCFG=$(bun -e "import { MM_LOG_CONFIG } from '$SRC/src/obs.ts'; console.log(JSON.stringify(MM_LOG_CONFIG))")
cat >"$T/p.yaml" <<EOF
version: "0.5"
processes:
  with:
    command: "echo line-with-\$\$\$\$; sleep 600"
    log_location: $T/with.log
    log_configuration: $LOGCFG
  without:
    command: "echo line-without; sleep 600"
    log_location: $T/without.log
EOF
"$PC_BIN" up -t=false --keep-project -U -u "$SOCK" -L "$T/pcm.log" -f "$T/p.yaml" >/dev/null 2>&1 &
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
seen() { for _ in $(seq 1 30); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
is "with mm's log configuration: the line is in the file within 3 s" seen "$T/with.log" line-with-
first=$(grep -o 'line-with-[0-9]*' "$T/with.log" | head -1)
is "without it: the file is still empty (the line stays in process-compose's memory; the old behaviour)" bash -c "sleep 1; [ ! -s '$T/without.log' ]"
"$PC_BIN" -U -u "$SOCK" process restart with >/dev/null 2>&1
for _ in $(seq 1 60); do [ "$(grep -c 'line-with-' "$T/with.log")" -ge 2 ] && break; sleep 0.1; done
is "after a restart: the new line is there, and the line from before the restart too (appended, not truncated)" \
  bash -c "[ \$(grep -c 'line-with-' '$T/with.log') -ge 2 ] && grep -q '$first' '$T/with.log'"

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
