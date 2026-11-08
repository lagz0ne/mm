#!/usr/bin/env bash
# sy-92ch: bin/init keeps bd init's whole output in .run/init-bd.log and tries it once more, from zero, when it fails (its
# temporary Dolt's port can be held for a moment on a busy machine). Hermetic: template/bin/init in a throwaway project
# whose tools/bd and tools/dolt are stand-ins (their sha256 in tools.json); bd's init fails a set number of times.
#   test/init-retry.sh
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=$PWD
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 INIT_RETRY_WAIT=0
# a project with the stand-ins: <n> = how many times bd init fails before it works
proj() { # <dir> <n>
  local P=$1; mkdir -p "$P/bin" "$P/tools"
  cp "$SRC/template/bin/init" "$P/bin/init"
  # tools/bd: init fails while .fails-left > 0 (it leaves a half-made .beads, as a real failure can), else makes .beads
  cat >"$P/tools/bd" <<'EOF'
#!/bin/sh
P=$(cd "$(dirname "$0")/.." && pwd); f="$P/.fails-left"
case "$1" in
  init) n=$(cat "$f" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n-1)) >"$f"; mkdir -p .beads/half; echo "Error: dolt server did not start on 127.0.0.1:38111: bind: address already in use" >&2
      echo "To disable auto-start: set dolt.auto-start: false in .beads/config.yaml" >&2; exit 1; fi
    [ ! -e .beads/half ] || { echo "a half-made .beads was left" >&2; exit 3; }
    mkdir -p .beads && echo ok >.beads/made; echo "bd init: done" ;;
  dolt) echo "$*" >>"$P/.dolt-calls" ;;
esac
exit 0
EOF
  printf '#!/bin/sh\nexit 0\n' >"$P/tools/dolt"; chmod +x "$P/tools/bd" "$P/tools/dolt" "$P/bin/init"
  # bin/bd and bin/bd-quiet: as the template's, run the project's tools/bd from control/
  printf '#!/bin/sh\nP=$(cd "$(dirname "$0")/.." && pwd)\nexec "$P/tools/bd" "$@"\n' >"$P/bin/bd"; printf '#!/bin/sh\nexit 0\n' >"$P/bin/bd-quiet"; chmod +x "$P/bin/bd" "$P/bin/bd-quiet"
  node -e "const c=require('crypto'),f=require('fs'),h=(p)=>c.createHash('sha256').update(f.readFileSync(p)).digest('hex');f.writeFileSync('$P/tools.json',JSON.stringify({bd:{'linux-x64':{installed_sha256:h('$P/tools/bd')}},dolt:{'linux-x64':{installed_sha256:h('$P/tools/dolt')}}}))"
  echo "$2" >"$P/.fails-left"
}
run_init() { (cd "$1" && MM_TRACE_SELF="$1/bin/init" "$1/bin/init" ab >"$1/.out" 2>&1); echo $? >"$1/.rc"; }

echo "== bd init works the first time"
proj "$T/a" 0; run_init "$T/a"
[ "$(cat "$T/a/.rc")" = 0 ] && [ -e "$T/a/control/.beads/made" ] && ok "init ends ok, control/.beads made" || { bad "first-time init"; tail -5 "$T/a/.out"; }
grep -q "bd init: done" "$T/a/.run/init-bd.log" && ok "...bd init's output is kept in .run/init-bd.log" || bad "no init-bd.log"
! grep -q "failed once" "$T/a/.out" && ok "...and no retry was said" || bad "a retry was said"

echo "== bd init fails once (a busy machine), then works"
proj "$T/b" 1; run_init "$T/b"
[ "$(cat "$T/b/.rc")" = 0 ] && [ -e "$T/b/control/.beads/made" ] && ok "init ends ok after one retry" || { bad "retry did not save it"; tail -5 "$T/b/.out"; }
grep -q "bd init failed once (its output: .*init-bd.log); trying again from zero" "$T/b/.out" && ok "...it says it tried again, and where the output is" || bad "no retry message"
grep -q "address already in use" "$T/b/.run/init-bd.log.1" && ok "...the first failure's whole output is kept (init-bd.log.1)" || bad "first failure's output lost"
[ ! -e "$T/b/control/.beads/half" ] && ok "...the retry started from zero (the half-made .beads removed)" || bad "half-made .beads kept"
grep -q "^dolt stop" "$T/b/.dolt-calls" && ok "...and the first try's Dolt was stopped before it" || bad "no dolt stop before the retry"

echo "== bd init fails twice"
proj "$T/c" 2; run_init "$T/c"
[ "$(cat "$T/c/.rc")" != 0 ] && ok "init fails (exit $(cat "$T/c/.rc"))" || bad "init passed though bd init failed twice"
grep -q "bd init failed twice; its output" "$T/c/.out" && grep -q "address already in use" "$T/c/.out" && ok "...and shows bd's own error, not only 'bd init failed'" || { bad "the error is not shown"; tail -5 "$T/c/.out"; }
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
