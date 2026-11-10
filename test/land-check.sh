#!/usr/bin/env bash
# template/ops/land-check (sy-qlsx): a Bun project (bun.lock) gets bun install --frozen-lockfile and its package.json
# test script (bun run test); a project without a bun lock keeps npm and node --test. Hermetic: a throwaway git repo
# per case, stand-ins for bun and npm on PATH that log their calls.
#   test/land-check.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }
CHECK="$SRC/template/ops/land-check"
NODE=$(command -v node)

# stand-ins: bun logs its arguments; `bun -e` runs the script with node; `bun run test` fails when FAKE_BUN_TEST_FAIL=1
mkdir -p "$T/fake" "$T/nobun"
cat > "$T/fake/bun" <<'SH'
#!/bin/sh
printf 'bun %s\n' "$*" >> "$CALLS"
case "$1" in
  -e) exec node -e "$2" ;;
  install) [ "${FAKE_BUN_INSTALL_FAIL:-0}" = 1 ] && { echo "error: lockfile had changes, but lockfile is frozen"; exit 1; }; exit 0 ;;
  run) [ "${FAKE_BUN_TEST_FAIL:-0}" = 1 ] && { echo " FAIL  test/unit/a.test.ts"; echo "      Tests  1 failed (1)"; exit 1; }
       echo "      Tests  2 passed (2)"; exit 0 ;;
esac
SH
cat > "$T/fake/npm" <<'SH'
#!/bin/sh
printf 'npm %s\n' "$*" >> "$CALLS"; exit 0
SH
chmod +x "$T/fake/bun" "$T/fake/npm"
cp "$T/fake/npm" "$T/nobun/npm"
# PATH without bun: the system's tools minus any bun, plus node and the npm stand-in
mkdir -p "$T/sys"; for t in sh git grep tr tail head cat printf dirname mkdir rm env; do p=$(command -v "$t") && ln -sf "$p" "$T/sys/$t"; done
ln -sf "$NODE" "$T/sys/node"

# a worktree: an empty main, a branch with one change; then the given files
repo() {
  local d="$T/r$1"; shift; rm -rf "$d"; mkdir -p "$d"
  git -C "$d" init -q -b main; git -C "$d" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$d" checkout -q -b w; echo x > "$d/src.js"
  while [ $# -gt 0 ]; do mkdir -p "$(dirname "$d/$1")"; printf '%s\n' "$2" > "$d/$1"; shift 2; done
  git -C "$d" add -A; git -C "$d" -c user.email=t@t -c user.name=t commit -q -m change; echo "$d"
}
go() { local path=$1 d=$2; shift 2; : > "$T/calls"; env "$@" CALLS="$T/calls" PATH="$path" sh "$CHECK" "$d" > "$T/out" 2>&1; echo $? > "$T/code"; }
code() { [ "$(cat "$T/code")" = "$1" ]; }
called() { grep -qxF "$1" "$T/calls"; }
said() { grep -qF "$1" "$T/out"; }
PKG_TEST='{"name":"a","scripts":{"test":"bun --bun vitest run"}}'

echo "== a Bun project (bun.lock and a test script)"
d=$(repo 1 package.json "$PKG_TEST" bun.lock '{}')
go "$T/fake:$T/sys" "$d"
check "it lands (exit 0)" code 0
check "bun install --frozen-lockfile is called" called "bun install --frozen-lockfile"
check "bun run test is called" called "bun run test"
check "...and neither npm nor node --test" sh -c "! grep -q '^npm' '$T/calls' && ! grep -q 'node --test' '$T/out'"
check "the test summary is printed" said "Tests 2 passed (2)"
go "$T/fake:$T/sys" "$d" FAKE_BUN_TEST_FAIL=1
check "a failing bun test: refused (exit 1)" code 1
check "...with land-check: tests failed and the failing test" sh -c "grep -qF 'land-check: tests failed' '$T/out' && grep -qF 'test/unit/a.test.ts' '$T/out'"
go "$T/fake:$T/sys" "$d" FAKE_BUN_INSTALL_FAIL=1
check "a lockfile that does not match: refused, the tests not run" sh -c "[ \$(cat '$T/code') = 1 ] && grep -qF 'bun install --frozen-lockfile failed' '$T/out' && ! grep -qx 'bun run test' '$T/calls'"
d=$(repo 2 package.json "$PKG_TEST" bun.lockb 'bin')
go "$T/fake:$T/sys" "$d"
check "bun.lockb (the older binary lock) counts too" sh -c "[ \$(cat '$T/code') = 0 ] && grep -qx 'bun run test' '$T/calls'"

echo "== a Bun project without a test script"
d=$(repo 3 package.json '{"name":"a","scripts":{"dev":"vite"}}' bun.lock '{}')
go "$T/fake:$T/sys" "$d"
check "it lands, tests skipped" sh -c "[ \$(cat '$T/code') = 0 ] && grep -qF 'no test script' '$T/out'"
check "...after the install; bun run test not called" sh -c "grep -qx 'bun install --frozen-lockfile' '$T/calls' && ! grep -qx 'bun run test' '$T/calls'"

echo "== bun.lock but no bun on PATH"
d=$(repo 4 package.json "$PKG_TEST" bun.lock '{}')
go "$T/nobun:$T/sys" "$d"
check "a clear failure, not a silent pass" sh -c "[ \$(cat '$T/code') = 1 ] && grep -qF 'land-check: bun.lock but no bun' '$T/out'"

echo "== no bun lock: npm and node --test as before"
d=$(repo 5 package.json '{"name":"a"}' package-lock.json '{}' a.test.js "require('node:test')('ok', () => {})")
go "$T/fake:$T/sys" "$d"
check "it lands (node --test passes)" code 0
check "npm ci is called, bun is not" sh -c "grep -q '^npm ci' '$T/calls' && ! grep -q '^bun' '$T/calls'"
check "node --test's summary is printed" said "pass 1"
d=$(repo 6 package.json '{"name":"a"}' a.test.js "require('node:test')('bad', () => { throw new Error('no') })")
go "$T/fake:$T/sys" "$d"
check "a failing node test: refused, npm install (no lock)" sh -c "[ \$(cat '$T/code') = 1 ] && grep -qF 'land-check: tests failed' '$T/out' && grep -q '^npm install' '$T/calls'"
d=$(repo 7 docs/a.md 'doc')
git -C "$d" rm -q src.js; git -C "$d" -c user.email=t@t -c user.name=t commit -q -m docs
go "$T/fake:$T/sys" "$d"
check "docs only: tests skipped, nothing installed" sh -c "[ \$(cat '$T/code') = 0 ] && grep -qF 'docs only' '$T/out' && [ ! -s '$T/calls' ]"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
