#!/usr/bin/env bash
# A box project's top-level folders the box's leads write (sy-u91q), hermetic: src/box.ts makeTopDirs() makes the
# missing ones 2775 (the box can't make a folder in the 2755 root itself), keeps one that is there as it is, and leaves
# a symlink alone (never followed).
#   test/box-topdirs.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mk() { (cd "$SRC" && bun -e "import { makeTopDirs } from './src/box.ts'; console.log(makeTopDirs(process.argv[1]).join(','))" "$1"); }
mode() { stat -c %a "$1"; }

R="$T/p1"; mkdir -p "$R"; chmod 2755 "$R"
got=$(mk "$R"); [ "$got" = "artifacts,worktrees,inbox" ] && ok "a new project: artifacts, worktrees, inbox made" || bad "made: '$got'"
for d in artifacts worktrees inbox; do [ "$(mode "$R/$d")" = 2775 ] && ok "$d is 2775 (group-writable, setgid)" || bad "$d mode $(mode "$R/$d")"; done
got=$(mk "$R"); [ -z "$got" ] && ok "a second run makes nothing" || bad "second run made '$got'"

R="$T/p2"; mkdir -p "$R/worktrees"; chmod 2770 "$R/worktrees"
got=$(mk "$R"); [ "$got" = "artifacts,inbox" ] && ok "one that is there is kept: only the missing are made" || bad "made: '$got'"
[ "$(mode "$R/worktrees")" = 2770 ] && ok "...and keeps its own mode" || bad "worktrees mode $(mode "$R/worktrees")"

R="$T/p3"; mkdir -p "$R" "$T/elsewhere"; ln -s "$T/elsewhere" "$R/artifacts"
got=$(mk "$R"); [ "$got" = "worktrees,inbox" ] && ok "a symlink named artifacts is left alone" || bad "made: '$got'"
[ "$(mode "$T/elsewhere")" != 2775 ] && ok "...and its target is not touched" || bad "the link's target changed"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
