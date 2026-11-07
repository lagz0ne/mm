#!/usr/bin/env bash
# The names of a box's backup folders (review sy-rjwg 8), hermetic: box.stampProblem lands only a real date that isn't
# ahead of the host's clock (5 min slack); landBackup refuses the others and says so (box-doop.sh lands a good one).
#   test/box-stamp.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""; mkdir -p "$MM_HOME"
B="$(command -v bun || echo "$HOME/.bun/bin/bun")"
NOW=$(date -u +%s)000
cat >"$T/s.ts" <<EOF
import { stampProblem } from '$SRC/src/box'
const now = Number(process.argv[2]), d = process.argv[3]
console.log(stampProblem(d, now) || 'ok')
EOF
is() { local got; got=$("$B" "$T/s.ts" "$NOW" "$2" 2>&1); [ "$got" = "$3" ] && ok "$1" || bad "$1: want '$3', got '$got'"; }
past=$(date -u -d '-1 day' +%Y-%m-%dT%H%MZ); soon=$(date -u -d '+3 min' +%Y-%m-%dT%H%MZ); late=$(date -u -d '+2 hours' +%Y-%m-%dT%H%MZ)
is "yesterday lands" "$past" ok
is "3 min ahead (clock slack) lands" "$soon" ok
is "2 hours ahead: refused" "$late" "ahead of the host's clock"
is "far future (2099): refused" "2099-01-01T0000Z" "ahead of the host's clock"
is "Feb 30: refused" "2026-02-30T1200Z" "not a real date"
is "Feb 29 in a common year: refused" "2025-02-29T1200Z" "not a real date"
is "Feb 29 in a leap year lands" "2024-02-29T1200Z" ok
is "hour 25: refused" "2026-01-01T2500Z" "not a real date"
is "minute 60: refused" "2026-01-01T1260Z" "not a real date"
is "month 13: refused" "2026-13-01T0000Z" "not a real date"
is "not the shape" "latest" "not a dated name"
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
