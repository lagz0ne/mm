#!/usr/bin/env bash
# sy-avky: mm box on stops the host's detached bd Dolt proxy of that project (src/project.ts stopBdProxies), and only
# that one. Hermetic: a temp project whose tools/bd is a tiny compiled program that only waits; no box, no live mm.
#   test/bd-proxy-stop.sh
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/tmp/bd-proxy-stop.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/bd-proxy-stop.out | sed 's/^/       /'; fi; }
T=$(mktemp -d); PIDS=(); trap 'for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done; rm -rf "$T"' EXIT
R=$T/proj; O=$T/other
mkdir -p "$R/tools" "$R/control/.beads/dolt" "$O/tools" "$O/control/.beads/dolt"
echo 'setInterval(() => {}, 1 << 30)' > "$T/wait.ts"
bun build --compile "$T/wait.ts" --outfile "$R/tools/bd" >/dev/null 2>&1 || { echo "could not compile the stand-in"; exit 2; }
cp "$R/tools/bd" "$O/tools/bd"
start() { "$@" >/dev/null 2>&1 & PIDS+=($!); echo $!; }
mine=$(start "$R/tools/bd" db-proxy-child --root "$R/control/.beads/dolt" --port 0 --idle-timeout -1ns)
outside=$(start "$R/tools/bd" db-proxy-child --root "$O/control/.beads/dolt" --port 0)
otherbd=$(start "$O/tools/bd" db-proxy-child --root "$R/control/.beads/dolt" --port 0)
notproxy=$(start "$R/tools/bd" serve --root "$R/control/.beads/dolt")
sleep 0.5
check "the stand-ins run" sh -c "kill -0 $mine && kill -0 $outside && kill -0 $otherbd && kill -0 $notproxy"
out=$(bun -e "import { stopBdProxies } from './src/project.ts'; console.log(JSON.stringify(stopBdProxies(process.argv[1])))" "$R")
check "stopBdProxies: exactly the project's own proxy (its tools/bd, db-proxy-child, --root inside it)" [ "$out" = "[$mine]" ]
sleep 0.3
check "...it is gone" sh -c "! kill -0 $mine 2>/dev/null || [ \"\$(awk '{print \$3}' /proc/$mine/stat)\" = Z ]"
check "...a proxy of the same bd for a root outside the project runs on" kill -0 "$outside"
check "...another project's bd for this root runs on" kill -0 "$otherbd"
check "...the project's bd doing something else (serve) runs on" kill -0 "$notproxy"
check "a project with no proxy: nothing stopped" sh -c "[ \"\$(bun -e \"import { stopBdProxies } from './src/project.ts'; console.log(JSON.stringify(stopBdProxies('$T/none')))\")\" = '[]' ]"
check "src/project.ts: leaveHost (box on) calls it after the stop" grep -q "const proxies = stopBdProxies(root)" src/project.ts
echo; echo "bd-proxy-stop: $pass passed, $fail failed"; [ $fail -eq 0 ]
