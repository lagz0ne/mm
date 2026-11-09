#!/usr/bin/env bash
# mm ship <sha> --item <id> (sy-sbjh step 5), hermetic: a throwaway HOME / MM_HOME, a throwaway mm repo (its main and a
# side branch), a fake bd (the item's labels from a file, comments to a log), and a cached build whose mm is a fake
# (ls, update, inspect, obs errors: what it ran and with which umask goes to a log). Nothing is started.
#   test/ship.sh [mm command]       default: bun <repo>/src/cli.ts (bun by its full path: a build case puts a fake bun first)
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); BUN=$(command -v bun); MMC=${1:-"$BUN $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_LAYOUT=one-root MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export MM_SHIP_BD="$T/bin/bd" BD_ACTOR=ops STATE="$T/state"
mkdir -p "$HOME" "$MM_HOME/system" "$T/bin" "$STATE"
BOARD="$MM_HOME/system"
mmship() { $MMC ship "$@" --repo "$T/repo"; }

# --- mm's repo: main has A and B; side has C (not on main) ---
R="$T/repo"; G() { git -C "$R" -c user.name=t -c user.email=t@example.com "$@"; }
git init -q -b main "$R"
G commit -q --allow-empty -m A; A=$(G rev-parse HEAD)
G commit -q --allow-empty -m B; B=$(G rev-parse HEAD)
G checkout -q -b side; G commit -q --allow-empty -m C; C=$(G rev-parse HEAD); G checkout -q main
a7=${A:0:7}; b7=${B:0:7}; c7=${C:0:7}

# --- the fake bd: show <id> --json from $STATE/item-<id>.json; comments add <id> <text> to $STATE/comments.log ---
cat >"$T/bin/bd" <<'EOF'
#!/bin/sh
case "$1" in
  show) [ -f "$STATE/item-$2.json" ] || { echo "no issue $2" >&2; exit 1; }; cat "$STATE/item-$2.json" ;;
  comments) [ "$2" = add ] || exit 2; printf '%s|%s|%s\n' "$BD_ACTOR" "$3" "$4" | tr '\n' ' ' >>"$STATE/comments.log"; echo >>"$STATE/comments.log" ;;
  label|update|set-state) echo "fake bd: mm ship wrote the board: $*" >>"$STATE/writes.log"; exit 1 ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/bin/bd"
item() { # item <id> <labels, comma-separated> [description]
  printf '[{"id":"%s","labels":[%s],"description":%s}]\n' "$1" "$(printf '%s' "$2" | sed 's/[^,][^,]*/"&"/g')" "$(printf '%s' "${3:-}" | jq -Rs .)" >"$STATE/item-$1.json"
}
gates() { # gates <id> <sha> <result> [suite status]
  mkdir -p "$BOARD/artifacts/$1"
  printf 'head: %s\nresult: %s\n\ntest/a.sh  hermetic  %s\n' "$2" "$3" "${4:-passed}" >"$BOARD/artifacts/$1/gates-${2:0:7}.txt"
}

# --- the cached build of B: a fake mm. Boards in $STATE/boards (one per line); each board's version in $STATE/v-<b> ---
build() {
  mkdir -p "$MM_HOME/builds/$1/template"
  cat >"$MM_HOME/builds/$1/mm" <<EOF
#!/bin/sh
NEW=$2
EOF
  cat >>"$MM_HOME/builds/$1/mm" <<'EOF'
[ "$1" = -o ] && shift 2
echo "$* | umask $(umask) | tpl ${MM_TEMPLATE_DIR##*/builds/}" >>"$STATE/mm.log"
v() { cat "$STATE/v-$1" 2>/dev/null || echo old; }
case "$1" in
  ls) printf '['; sep=''; while read -r b; do printf '%s{"project":"%s","root":"~/x"}' "$sep" "$b"; sep=,; done <"$STATE/boards"; echo ']' ;;
  update)
    if [ "$2" = --dry-run ]; then b=$3
      if [ -f "$STATE/conflict-$b" ]; then printf '{"from":"%s","to":"%s","changed":["bin/x"],"conflicts":["bin/x"],"ok":false}\n' "$(v $b)" "$NEW"; exit 1; fi
      printf '{"from":"%s","to":"%s","changed":["bin/x"],"conflicts":[],"ok":true}\n' "$(v $b)" "$NEW"; exit 0
    fi
    b=$2; echo "$b" >>"$STATE/updated"; from=$(v $b)
    [ -f "$STATE/stuck-$b" ] || echo "$NEW" >"$STATE/v-$b"
    [ -f "$STATE/errs-after-$b" ] && cp "$STATE/errs-after-$b" "$STATE/errs-$b"
    printf '{"from":"%s","to":"%s","changed":["bin/x"],"conflicts":[],"ok":true}\n' "$from" "$NEW" ;;
  inspect) printf '[{"project":"%s","template_version":"%s"}]\n' "$2" "$(v $2)" ;;
  obs) [ -f "$STATE/errs-$4" ] && cat "$STATE/errs-$4" || echo '{"logs":[],"spans":[]}' ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$MM_HOME/builds/$1/mm"
  (cd "$MM_HOME/builds/$1" && sha256sum mm >mm.sha256)   # stamped, as test/gates makes it
}
build "$B" new-b
printf 'acme-shop\nacme-blog\nacme-docs\n' >"$STATE/boards"
reset() { rm -f "$STATE"/v-* "$STATE"/updated "$STATE"/mm.log "$STATE"/comments.log "$STATE"/errs-* "$STATE"/stuck-* "$STATE"/conflict-*; }

refused() { # refused <what it must say> <args...>
  local want=$1; shift
  mmship "$@" >"$T/out" 2>&1; local rc=$?
  [ $rc = 1 ] && grep -q 'refused' "$T/out" && grep -qF -- "$want" "$T/out" && [ ! -s "$STATE/updated" ] || { cat "$T/out"; return 1; }
}

echo "== refusals (step 1)"
item sy-a "signed-off,signed-head:mm@$b7"; gates sy-a "$B" passed
check "no --item: refused" refused '--item <id>' "$B"
check "a head not on main: refused" refused 'is not on main' "$C" --item sy-a
check "not a commit of mm's repo: refused" refused 'no commit of mm' 0000000 --item sy-a
item sy-n "signed-head:mm@$b7"; gates sy-n "$B" passed
check "no signed-off: refused" refused 'is not signed off' "$B" --item sy-n
item sy-o "signed-off,signed-head:mm@$a7"; gates sy-o "$B" passed
check "signed for another head: refused" refused "is not signed for mm@$b7" "$B" --item sy-o
item sy-g "signed-off,signed-head:mm@$b7"
check "no gates file: refused" refused "no passing gates file for $b7" "$B" --item sy-g
gates sy-g "$B" 'failed (1)' failed
check "a failed gates file: refused" refused 'the gates failed' "$B" --item sy-g
gates sy-g "$A" passed; mv "$BOARD/artifacts/sy-g/gates-$a7.txt" "$BOARD/artifacts/sy-g/gates-$b7.txt"
check "a gates file for another head: refused" refused 'is for another head' "$B" --item sy-g
CARD="## Owner
- **What:** x
- **Why:** y
- **You:** Tap Approve
- **Risk:** low
- **Head:** mm@$b7
"
item sy-t "signed-off,signed-head:mm@$b7,t2" "$CARD"; gates sy-t "$B" passed
check "t2 with no approved: refused" refused 'is t2 and not approved' "$B" --item sy-t
item sy-t "signed-off,signed-head:mm@$b7,t2,approved" "$CARD"
check "t2 approved with no approved-head: refused" refused "its go is not for mm@$b7" "$B" --item sy-t
item sy-t "signed-off,signed-head:mm@$b7,t2,approved,approved-head:mm@$a7" "$CARD"
check "t2 approved for another head: refused" refused "its go is not for mm@$b7" "$B" --item sy-t
item sy-t "signed-off,signed-head:mm@$b7,t2,approved,approved-head:mm@$b7" "$CARD"
printf 'head: %s\nresult: passed (--no-live)\n\ntest/a.sh  hermetic  passed\ntest/l.sh  live  skipped (--no-live)\n' "$B" >"$BOARD/artifacts/sy-t/gates-$b7.txt"
check "t2 whose gates skipped the live group: refused" refused 'needs every group' "$B" --item sy-t
check "no refusal wrote a label (bd only read)" test ! -s "$STATE/writes.log"

echo "== the dry run (steps 1-3)"
reset
check "--dry-run: exit 0" sh -c "$MMC ship $B --item sy-a --repo '$T/repo' --dry-run >'$T/dry' 2>&1"
check "...lists every board mm ls lists, old -> new" sh -c "grep -c 'dry run: acme-.* old -> new-b' '$T/dry' | grep -qx 3"
check "...uses the cached build" grep -q "build: cached" "$T/dry"
check "...with its template (MM_TEMPLATE_DIR)" grep -q "tpl $B/template" "$STATE/mm.log"
check "...and updates nothing, writes no comment" sh -c "[ ! -s '$STATE/updated' ] && [ ! -s '$STATE/comments.log' ] && ! grep -q '^update acme' '$STATE/mm.log'"
check "--board: only that board" sh -c "$MMC ship $B --item sy-a --repo '$T/repo' --dry-run --board acme-blog 2>&1 | grep 'dry run:' | grep -q acme-blog && [ \$($MMC ship $B --item sy-a --repo '$T/repo' --dry-run --board acme-blog 2>&1 | grep -c 'dry run:') = 1 ]"
touch "$STATE/conflict-acme-blog"
check "a conflict stops it, naming the board and file; nothing updated" sh -c "! $MMC ship $B --item sy-a --repo '$T/repo' >'$T/c' 2>&1; grep -q 'acme-blog conflicts in bin/x' '$T/c' && [ ! -s '$STATE/updated' ]"

echo "== the rollout (step 4-5)"
reset
mkdir -p "$MM_HOME/builds/$A/template"; printf '#!/bin/sh\n' >"$MM_HOME/builds/$A/mm"; chmod +x "$MM_HOME/builds/$A/mm"; ln -sfn "$A" "$MM_HOME/builds/current"
check "every board shipped: exit 0" sh -c "(umask 077; $MMC ship $B --item sy-a --repo '$T/repo') >'$T/run' 2>&1"
check "...each board in turn" sh -c "[ \"\$(tr '\n' ' ' <'$STATE/updated')\" = 'acme-shop acme-blog acme-docs ' ]"
check "...mm update ran with umask 022 (the caller's was 077)" sh -c "grep '^update acme' '$STATE/mm.log' | grep -v -- --dry-run | grep -c 'umask 0022' | grep -qx 3"
check "...the replaced build kept as builds/previous" sh -c "[ -x '$MM_HOME/builds/previous/mm' ] && [ \"\$(cat '$MM_HOME/builds/previous/sha')\" = '$A' ]"
check "...builds/current now names the head" sh -c "[ \"\$(readlink '$MM_HOME/builds/current')\" = '$B' ]"
check "...one comment per board on the item, as the role" sh -c "[ \$(grep -c '^ops|sy-a|NOTE → ops mm ship $b7: acme-.* old -> new-b, checks ok' '$STATE/comments.log') = 3 ]"
reset
printf '{"logs":[],"spans":[]}' >"$STATE/errs-acme-blog"
printf '{"logs":[{"project":"acme-blog","service":"board","_msg":"boom","n":2}],"spans":[]}' >"$STATE/errs-after-acme-blog"
check "a new error after a board: stops there (exit 1)" sh -c "! $MMC ship $B --item sy-a --repo '$T/repo' >'$T/f' 2>&1"
check "...later boards not updated" sh -c "[ \"\$(tr '\n' ' ' <'$STATE/updated')\" = 'acme-shop acme-blog ' ]"
check "...prints the one-line rollback with the kept build" grep -q "MM_TEMPLATE_DIR=.*builds/previous/template .*builds/previous/mm update acme-blog" "$T/f"
check "...the comment says checks failed" grep -q 'acme-blog old -> new-b, checks failed: mm obs errors: 1 new' "$STATE/comments.log"
check "...nothing rolled back by itself" sh -c "[ \"\$(cat '$STATE/v-acme-blog')\" = new-b ] && ! grep -q 'builds/previous' '$STATE/mm.log'"
reset
printf '{"logs":[{"project":"acme-shop","service":"board","_msg":"old one","n":1}],"spans":[]}' >"$STATE/errs-acme-shop"
touch "$STATE/stuck-acme-shop"
check "inspect not at the new version: stops at the first board" sh -c "! $MMC ship $B --item sy-a --repo '$T/repo' >'$T/s' 2>&1; grep -q 'shows template old, not new-b' '$T/s' && [ \"\$(cat '$STATE/updated')\" = acme-shop ]"
check "an error already there before is not new" sh -c "! grep -q 'obs errors' '$STATE/comments.log'"
reset
item sy-t "signed-off,signed-head:mm@$b7,t2,approved,approved-head:mm@$b7" "$CARD"; gates sy-t "$B" passed
check "t2 approved for this head, full gates: ships" sh -c "$MMC ship $B --item sy-t --repo '$T/repo' --board acme-shop >'$T/t2' 2>&1"
check "mm ship with no sha is still the log shipper's (refuses --item)" sh -c "$MMC ship --item sy-a 2>&1 | grep -q 'need a <sha>'"

echo "== the build (step 2): never dist/, a clean worktree, a cache"
item sy-c "signed-off,signed-head:mm@$a7"; gates sy-c "$A" passed; rm -rf "$MM_HOME/builds/$A"
check "...the build fails on a repo with no mm source, and leaves no temp folder" sh -c "! $MMC ship $A --item sy-c --repo '$T/repo' --dry-run >'$T/b' 2>&1; grep -q 'build: .* failed' '$T/b' && ! ls -a '$MM_HOME/builds' | grep -q '^\.tmp-' && [ ! -e '$MM_HOME/builds/$A' ] && [ -z \"\$(git -C '$T/repo' worktree list | sed 1d)\" ]"


# a fake bun first on PATH for the build: install and pack do nothing, build copies the fake mm to --outfile; each call
# goes to $STATE/bun.log. D (on main) has a template/ to archive.
mkdir -p "$T/fakebun"
cat >"$T/fakebun/bun" <<EOF
#!/bin/sh
FAKE_MM='$MM_HOME/builds/$B/mm'
EOF
cat >>"$T/fakebun/bun" <<'EOF'
echo "$*" >>"$STATE/bun.log"
case "$1" in
  install|scripts/pack-template.ts) exit 0 ;;
  build) while [ $# -gt 0 ]; do [ "$1" = --outfile ] && { cp "$FAKE_MM" "$2"; chmod +x "$2"; exit 0; }; shift; done; exit 1 ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/fakebun/bun"
mkdir -p "$R/template"; echo 1 >"$R/template/VERSION"; G add template; G commit -q -m D; D=$(G rev-parse HEAD); d7=${D:0:7}
item sy-d "signed-off,signed-head:mm@$d7"; gates sy-d "$D" passed
fship() { rm -f "$STATE/bun.log"; PATH="$T/fakebun:$PATH" $MMC ship "$@" --repo "$T/repo" --dry-run; }
fship "$D" --item sy-d >"$T/d" 2>&1; echo "exit $?" >>"$T/d"
check "a build ship makes: built, from a clean worktree" sh -c "grep -q 'build: built' '$T/d' && grep -q '^exit 0' '$T/d' && grep -q '^build src/cli.ts --compile' '$STATE/bun.log'"
check "...its stamp: mm.sha256 in sha256sum -c form" sh -c "cd '$MM_HOME/builds/$D' && [ -d template ] && grep -qE '^[0-9a-f]{64}  mm\$' mm.sha256 && sha256sum -c --quiet mm.sha256"
check "...no temp folder left" sh -c "! ls -a '$MM_HOME/builds' | grep -qE '^\.(tmp|old)-'"
fship "$B" --item sy-a >"$T/g" 2>&1
check "a gates-made build with a good stamp: reused, no build call" sh -c "grep -q 'build: cached .*$B (sha256 ' '$T/g' && [ ! -s '$STATE/bun.log' ]"
echo "0000000000000000000000000000000000000000000000000000000000000000  mm" >"$MM_HOME/builds/$D/mm.sha256"
fship "$D" --item sy-d >"$T/w" 2>&1
check "a wrong stamp: says why, built again" sh -c "grep -q \"does not count (its mm's sha256 .* is not the stamp's (000000000000)): built again\" '$T/w' && grep -q 'build: built' '$T/w' && grep -q '^build ' '$STATE/bun.log'"
check "...and stamped right again" sh -c "cd '$MM_HOME/builds/$D' && sha256sum -c --quiet mm.sha256"
rm -f "$MM_HOME/builds/$D/mm.sha256"
fship "$D" --item sy-d >"$T/m" 2>&1
check "a missing stamp: says why, built again" sh -c "grep -q 'does not count (no mm.sha256): built again' '$T/m' && grep -q '^build ' '$STATE/bun.log' && [ -s '$MM_HOME/builds/$D/mm.sha256' ]"
mkdir -p "$T/elsewhere"
check "MM_BUILDS: the cache root (the build goes there, not under MM_HOME)" sh -c "rm -f '$STATE/bun.log'; MM_BUILDS='$T/elsewhere' PATH='$T/fakebun':\"\$PATH\" $MMC ship $D --item sy-d --repo '$T/repo' --dry-run >'$T/e' 2>&1 && [ -x '$T/elsewhere/$D/mm' ] && (cd '$T/elsewhere/$D' && sha256sum -c --quiet mm.sha256)"
check "mm ship never prunes the cache (current, previous and the other builds still there)" sh -c "[ -e '$MM_HOME/builds/previous/mm' ] && [ -L '$MM_HOME/builds/current' ] && [ -d '$MM_HOME/builds/$B' ]"

echo
echo "ship: $pass passed, $fail failed"
[ "$fail" = 0 ]
