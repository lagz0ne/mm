#!/usr/bin/env bash
# bin/trace around bd: bd's answers to its caller (not claimable, blocked, a lost guarded update, an id that isn't
# there) are "refused" (warn, span not failed); a real failure stays an error (sy-v7oo). Hermetic: a copy of the
# template's bin/ in a throwaway folder, a stand-in for bd, and a stand-in trace collector on loopback.
#   test/trace-refused.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'kill $COL 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }

cp -r "$SRC/template/bin" "$T/bin"; mkdir -p "$T/.run/logs"
cat > "$T/fake-bd" <<'EOF'
#!/bin/sh
# fake-bd <exit code> <stderr text>
printf '%s\n' "$2" >&2; exit "$1"
EOF
chmod +x "$T/fake-bd"
cat > "$T/col.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const out = process.argv[2]
const s = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { fs.appendFileSync(out, b + '\n'); r.end('{}') }) })
s.listen(0, '127.0.0.1', () => fs.writeFileSync(out + '.port', String(s.address().port)))
EOF
node "$T/col.mjs" "$T/spans" & COL=$!
for _ in $(seq 1 50); do [ -s "$T/spans.port" ] && break; sleep 0.1; done
export MM_OBS_TRACES="http://127.0.0.1:$(cat "$T/spans.port")/v1/traces" MM_OBS_METRICS=

# one run: name, exit code, stderr; then the last ops.log line and the collected span
run() { : > "$T/spans"; "$T/bin/trace" "$1" -- "$T/fake-bd" "$2" "$3" 2>/dev/null; echo $? > "$T/code"; tail -1 "$T/.run/logs/ops.log" > "$T/last"; }
refused() { jq -e '.level == "warn" and .outcome == "refused"' "$T/last" && ! grep -q '"code":2' "$T/spans" && [ "$(cat "$T/code")" = "$1" ]; }
failed() { jq -e '.level == "error" and (.outcome == null)' "$T/last" && grep -q '"code":2' "$T/spans" && [ "$(cat "$T/code")" = "$1" ]; }

echo "== bd's answers to its caller: refused, not failed"
run "bd update" 1 "Error updating sy-b15.10: issue not claimable: status blocked"
check "a claim of a blocked item: warn, refused, the span not failed, exit 1 kept" refused 1
run "bd close" 1 "cannot close blocked issue: sy-4in is blocked by [sy-641] (use --force to override)"
check "a close of a blocked item: refused" refused 1
run "bd update" 13 "precondition: assignee changed"
check "a guarded update that lost (exit 13): refused, exit 13 kept" refused 13
run "bd show" 1 "Issue sy-zzzz9 not found"
check "an id that isn't there: refused" refused 1
echo "== real failures stay errors"
run "bd update" 1 "Error: dial unix /x/dolt.sock: connect: connection refused"
check "Dolt down: error, the span failed" failed 1
run "bd show" 128 "fatal: something broke"
check "an exit 128: error" failed 128
run "deploy" 13 "issue not claimable"
check "not bd: the same text and exit 13 are still a failure" failed 13
run "bd ready" 0 ""
check "a good run: info, done" jq -e '.level == "info"' "$T/last"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
