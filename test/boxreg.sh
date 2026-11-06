#!/bin/bash
# Which boxes a machine server (mm.ai, mm.api) answers (src/boxreg.ts, sy-bpgq): the machine's skips a throwaway (test)
# box, so a test's requests never reach the owner's board or Telegram; a test's own server (MM_*_ONLY) answers its box
# only. Hermetic: a throwaway HOME and MM_HOME.
set -u
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm"
mkdir -p "$MM_HOME/pc/boxes" "$T/p/live" "$T/p/qa"
printf 'project: acme-live\nbox: true\n' >"$T/p/live/.mm-answers.yaml"
printf 'project: qa-boxt\nbox: true\nthrowaway: true\n' >"$T/p/qa/.mm-answers.yaml"
printf '# from %s/services.yaml\n' "$T/p/live" >"$MM_HOME/pc/boxes/acme-live.yaml"
printf '# from %s/services.yaml\n' "$T/p/qa" >"$MM_HOME/pc/boxes/qa-boxt.yaml"
printf 'no from line\n' >"$MM_HOME/pc/boxes/odd-one.yaml"
fail=0; n=0
check() { n=$((n + 1)); local name=$1; shift; if "$@"; then echo "  ok   $name"; else echo "  FAIL $name"; fail=$((fail + 1)); fi; }
served() { bun -e "import { servedBoxes } from '$SRC/src/boxreg.ts'; console.log(servedBoxes(/^[a-z][a-z0-9-]*\$/, process.argv[1] || undefined).sort().join(' '))" "${1:-}"; }
check "the machine's server: every box but the throwaway one (a registry file it can't read the answers of still counts)" test "$(served)" = "acme-live odd-one"
check "a test's server (MM_*_ONLY=qa-boxt): its own box only" test "$(served qa-boxt)" = "qa-boxt"
check "...and only a box that is in the registry" test "$(served nope)" = ""
check "...a comma list: those boxes (a test with several)" test "$(served 'acme-live, qa-boxt')" = "acme-live qa-boxt"
echo; echo "$((n - fail)) passed, $fail failed"
[ "$fail" = 0 ]
