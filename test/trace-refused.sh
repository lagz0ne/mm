#!/usr/bin/env bash
# bin/trace around bd: bd's answers to its caller (not claimable, blocked, held by another role, a lost guarded
# update, an id that isn't there) are "refused" (warn, span not failed); a real failure stays an error (sy-v7oo). Hermetic: a copy of the
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
run() { : > "$T/spans"; "$T/bin/trace" "$1" -- "$T/fake-bd" "$2" "$3" >"$T/stdout" 2>/dev/null; echo $? > "$T/code"; tail -1 "$T/.run/logs/ops.log" > "$T/last"; }  # stdout a file, not a pipe
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
echo "== an item another role holds (sy-936h): bd's own wording, refused"
run "bd close" 1 'Error closing sy-936h: cannot close sy-936h: assignee is "ops", actor is "platform"; reclaim or use --force to override'
check "a close of another role's item: refused" refused 1
run "bd update" 1 'Error updating sy-936h: cannot reassign sy-936h: held by "ops" (in_progress); coordinate with the holder (bd mail ops)'
check "a reassign of an item another role holds: refused" refused 1
run "bd update" 1 "Error claiming sy-936h: issue is claimed by another actor"
check "a claim of an item another actor holds: refused" refused 1
run "bd update" 1 "Error: claim failed: sy-936h is held by ops; coordinate with the holder"
check "...the claim's other wording: refused" refused 1
run "bd close" 1 "Error closing sy-936h: cannot close sy-936h: 2 open child issue(s); close children first or use --force to override"
check "a close of an item with open children: refused" refused 1
echo "== real failures stay errors"
run "bd update" 1 "Error: lock busy: held by another process"
check "a busy lock (held by another process): error" failed 1
run "bd close" 1 "Error: proxy lock held by another proxy on this rootDir"
check "...the proxy's lock: error" failed 1
run "bd update" 1 "Error: dial unix /x/dolt.sock: connect: connection refused"
check "Dolt down: error, the span failed" failed 1
run "bd show" 128 "fatal: something broke"
check "an exit 128: error" failed 128
run "deploy" 13 "issue not claimable"
check "not bd: the same text and exit 13 are still a failure" failed 13
run "bd ready" 0 ""
check "a good run: info, done" jq -e '.level == "info"' "$T/last"

echo "== land's answers to its caller (sy-4dg8): refused, not failed"
run "land" 1 "land: w-pg-1 refused by ops/land-check (fix it on the branch, then land again)"
check "its check said no: refused, exit 1 kept" refused 1
run "land" 1 "land: w-pg-1 conflicts with main; rebase and resolve in the worktree, then land again"
check "a conflict with main: refused" refused 1
run "land" 1 "land: w-pg-1 has uncommitted changes; commit first"
check "uncommitted changes: refused" refused 1
run "land" 2 "land: no worktree w-pg-9"
check "no such worktree (exit 2): refused" refused 2
run "land" 1 "land: lock busy for 120s"
check "...but a busy lock stays a failure" failed 1
echo "== exit 141 (SIGPIPE): the reader closed the pipe"
: > "$T/spans"; "$T/bin/trace" "deploy" -- "$T/fake-bd" 141 "" 2>/dev/null | true; tail -1 "$T/.run/logs/ops.log" > "$T/last"
check "piped (deploy status | head): info, outcome reader-closed, the span not failed" sh -c "jq -e '.level == \"info\" and .outcome == \"reader-closed\"' '$T/last' && ! grep -q '\"code\":2' '$T/spans'"
run "deploy" 141 ""
check "...not piped: exit 141 is still a failure" failed 141
# the child killed by SIGPIPE itself (bd show x | head -1: node gets no exit code, only the signal; sy-m8dv)
: > "$T/spans"; "$T/bin/trace" "deploy" -- sh -c 'kill -PIPE $$' 2>/dev/null | true; tail -1 "$T/.run/logs/ops.log" > "$T/last"
check "killed by SIGPIPE itself, piped: info, outcome reader-closed, the span not failed (sy-m8dv)" sh -c "jq -e '.level == \"info\" and .outcome == \"reader-closed\"' '$T/last' && ! grep -q '\"code\":2' '$T/spans'"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
