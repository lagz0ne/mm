#!/usr/bin/env bash
# A suite stopped by a signal still cleans up (sy-khal), hermetic and docker-free. restore-drill.sh's 3 containers ran for
# hours after its run was stopped. Bash runs a suite's EXIT trap on a TERM, INT or HUP (checked here), so the cleanup
# did start; what cut it off: its containers' PID 1 (sleep infinity) ignores TERM, so podman rm -f waited its 10 s
# stop timeout, and test/gates sent the suite's group a KILL 10 s after the TERM. Now a cleanup kills its containers
# before it removes them (test/gates.mjs checks every suite), and test/gates waits KILL_GRACE (60 s) before the KILL.
# Here: stand-in suites (an EXIT trap that writes a marker, a sleep child) take the signals; then test/gates' runTo
# stops one past its timeout whose cleanup is slower than the grace (cut off) or within it (finishes).
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT
set -m # each background job in its own process group, as test/gates starts a suite (detached)

# standin <name> <fg|bg> [cleanup seconds]: the suite's shape (an EXIT trap that cleans up, a child it waits on)
standin() {
  { echo '#!/usr/bin/env bash'
    echo "M=\$1; trap 'sleep ${3:-0}; echo cleaned >\"\$M.marker\"' EXIT"
    if [ "$2" = fg ]; then echo 'echo $$ >"$M.ready"; sleep 30'
    else echo 'sleep 30 & echo $$ >"$M.ready"; wait'; fi
    echo 'echo finished >"$M.done"'
  } >"$T/$1.sh"; chmod +x "$T/$1.sh"
}
# run <name> <signal> <group|shell>: start it, wait until it runs, signal it, wait for it; its exit code in RC
run() {
  local n=$1 sig=$2 to=$3 pid i
  bash "$T/$n.sh" "$T/$n" </dev/null >/dev/null 2>&1 & pid=$!
  for i in $(seq 100); do [ -s "$T/$n.ready" ] && break; sleep 0.05; done
  if [ "$to" = group ]; then kill -s "$sig" -- "-$pid"; else kill -s "$sig" "$pid"; fi
  wait "$pid" 2>/dev/null; RC=$?
}
cleaned() { [ "$(cat "$T/$1.marker" 2>/dev/null)" = cleaned ] && [ ! -e "$T/$1.done" ]; }

echo "== bash runs the EXIT trap on a signal (no TERM trap needed)"
standin grp fg; run grp TERM group
cleaned grp && [ "$RC" = 143 ] && ok "a TERM to its group, a child in the foreground (test/gates' stop): the cleanup ran, exit 143" || bad "a TERM to its group: the cleanup ran, exit 143 (exit $RC)"
for s in TERM:143 INT:130 HUP:129; do
  n=sh-${s%:*}; standin "$n" bg; run "$n" "${s%:*}" shell
  cleaned "$n" && [ "$RC" = "${s#*:}" ] && ok "a ${s%:*} to the shell alone, while it waits on its child: the cleanup ran, exit $RC" || bad "a ${s%:*} to the shell alone: the cleanup ran, exit ${s#*:} (exit $RC)"
done

echo "== test/gates' runTo: TERM to the group at the timeout, KILL after the grace"
standin slow fg 3; standin quick fg 3
OUT=$(cd "$T" && node --input-type=module -e "
import { runTo, KILL_GRACE } from '$SRC/test/lib/gates.mjs'
const r = (n, grace) => runTo('bash', ['$T/' + n + '.sh', '$T/' + n], { cwd: '$T', env: process.env, log: '$T/' + n + '.log', timeout: 1, grace })
const a = await r('slow', 1), b = await r('quick', 6)
console.log(KILL_GRACE, a.code, Math.round(a.secs), b.code, Math.round(b.secs))
" 2>&1)
read -r GRACE SC SS QC QS <<<"$OUT"
[ "$GRACE" = 60 ] && ok "its grace is KILL_GRACE, 60 s" || bad "its grace is KILL_GRACE, 60 s ($OUT)"
[ "$SC" = 124 ] && [ ! -e "$T/slow.marker" ] && [ "${SS:-9}" -lt 3 ] && ok "a cleanup slower than the grace (3 s, grace 1 s): cut off, no marker (timed out, ${SS} s)" || bad "a cleanup slower than the grace: cut off ($OUT)"
[ "$QC" = 124 ] && cleaned quick && ok "a cleanup within the grace (3 s, grace 6 s): it finishes (timed out, ${QS} s)" || bad "a cleanup within the grace: it finishes ($OUT)"
grep -q 'gates: timed out after 1s' "$T/quick.log" && ok "...and the log says it timed out" || bad "...and the log says it timed out"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
