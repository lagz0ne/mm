#!/usr/bin/env bash
# mm's own spans (sy-ha9x), hermetic: an answer is not a fault. `mm config get` on an unset key exits 1 but its span is
# not failed; `mm doctor` failing only on a throwaway project (a test planted the fault) marks its span mm_throwaway,
# so neither raises an mm/mm incident; nor does a project API decision refused on a throwaway project's request
# (sy-qsif: the request's project, from the store, then its answers). A throwaway HOME / MM_HOME with a throwaway project and a real one (nothing
# started), a stand-in trace collector on loopback.
#   test/span-answers.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'kill $COL 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -p "$MM_HOME/pc/projects" "$T/bin"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
printf 'layout: one-root\naccess: tailscale\nhost: qa-host\n' >"$MM_HOME/config.yaml"

cat > "$T/col.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const out = process.argv[2]
const s = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { fs.appendFileSync(out, b + '\n'); r.end('{}') }) })
s.listen(0, '127.0.0.1', () => fs.writeFileSync(out + '.port', String(s.address().port)))
EOF
node "$T/col.mjs" "$T/spans" & COL=$!
for _ in $(seq 1 50); do [ -s "$T/spans.port" ] && break; sleep 0.1; done
export MM_OBS_TRACES="http://127.0.0.1:$(cat "$T/spans.port")/v1/traces"

# a board as doctor sees it: answers, a config repo, control/ with its own repo, a bd that answers "quiet"
board() {  # <client> <name> [throwaway]
  local P="$MM_HOME/projects/$1/$2"; mkdir -p "$P/bin" "$P/control"
  printf 'client: %s\nname: %s\nproject: %s-%s\nshort: qa\nroot: %s\ntemplate_version: 0.0.0\ncreated: 2026-01-01T00:00:00Z\n' "$1" "$2" "$1" "$2" "$P" >"$P/.mm-answers.yaml"
  [ -n "${3:-}" ] && echo 'throwaway: true' >>"$P/.mm-answers.yaml"
  printf '#!/bin/sh\n[ "$1" = metrics ] && { echo "Anonymous usage metrics: OFF"; exit 0; }\n[ "$3" = dolt.auto-start ] && echo false || echo true\n' >"$P/bin/bd"; chmod +x "$P/bin/bd"
  git -C "$P" init -q && git -C "$P/control" init -q
  echo "# from $P/services.yaml" >"$MM_HOME/pc/projects/$1-$2.yaml"
}
board acme qa throwaway; board acme shop
QA="$MM_HOME/projects/acme/qa"
LOG="$MM_HOME/pc/mm.log"
last() { tail -1 "$LOG"; }

echo "== mm config get"
: >"$T/spans"; mm config get host >/dev/null 2>&1; RC=$?
check "a set key: exit 0, info, ok" sh -c "[ $RC = 0 ] && tail -1 '$LOG' | jq -e '.op == \"mm config get\" and .level == \"info\" and .ok == true'"
: >"$T/spans"; mm config get no.such.key >"$T/out" 2>&1; RC=$?
check "an unset key: still exit 1 (scripts test it), nothing printed" sh -c "[ $RC = 1 ] && [ ! -s '$T/out' ]"
check "...its span is not failed: info, ok, outcome 'not set', exit_code 1 kept" sh -c "tail -1 '$LOG' | jq -e '.op == \"mm config get\" and .level == \"info\" and .ok == true and .outcome == \"not set\" and .exit_code == 1 and .msg == \"mm config get not set\"'"
check "...the trace span has status ok (1), not error (2)" sh -c "grep -q '\"mm config get\"' '$T/spans' && grep -q '\"status\":{\"code\":1}' '$T/spans' && ! grep -q '\"code\":2' '$T/spans'"

echo "== mm doctor: which failures are a throwaway project's"
printf '#!/bin/sh\nexec bd hooks run pre-commit "$@"\n' >"$QA/control/.git/hooks/pre-commit"; chmod +x "$QA/control/.git/hooks/pre-commit"
: >"$T/spans"; mm doctor -o json >"$T/doc.json" 2>/dev/null; RC=$?
check "the planted bd hook: doctor fails 'bd quiet acme/qa', naming it" jq -e '.[] | select(.item == "bd quiet acme/qa") | .status == "fail" and (.detail | test("control/.git/hooks/pre-commit"))' "$T/doc.json"
check "...and the real project's 'bd quiet acme/shop' is ok" jq -e '.[] | select(.item == "bd quiet acme/shop") | .status == "ok"' "$T/doc.json"
check "this throwaway home fails machine checks too: exit 1, and the span is failed and NOT marked throwaway" sh -c "[ $RC = 1 ] && jq -e '[.[] | select(.status == \"fail\" and (.item | test(\"acme\") | not))] | length > 0' '$T/doc.json' && tail -1 '$LOG' | jq -e '.op == \"mm doctor\" and .level == \"error\" and (has(\"mm_throwaway\") | not)' && ! grep -q mm_throwaway '$T/spans'"

# the rule on doctor's own checks, with the projects above: what this run found, minus the machine's failures
cat >"$T/only.ts" <<EOF
import { readFileSync } from 'node:fs'
import { throwawayOnly } from '$SRC/src/doctor'
const all = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { item: string; status: string }[]
const qa = all.filter((c) => c.item === 'bd quiet acme/qa'), shop = all.filter((c) => c.item === 'bd quiet acme/shop')
const machine = all.find((c) => c.status === 'fail' && !/acme/.test(c.item))!
const warn = { layer: 'machine', item: 'shared temp folders', status: 'warn', detail: '1 path(s)' }
const asFail = (c: { item: string }) => ({ ...c, status: 'fail' })
const cases: [string, unknown[], string][] = [
  ['only the throwaway fails', qa, 'acme-qa'],
  ['the throwaway fails, the machine only warns', [...qa, warn], 'acme-qa'],
  ['its engine check fails too', [...qa, { layer: 'projects', item: 'engine acme-qa', status: 'fail', detail: '' }], 'acme-qa'],
  ['a machine check fails too', [...qa, machine], ''],
  ['a real project fails', [...qa, ...shop.map(asFail)], ''],
  ['a real project only', shop.map(asFail), ''],
  ['nothing fails', [warn, ...shop], ''],
]
for (const [d, checks, want] of cases) { const got = throwawayOnly(checks as never); console.log(\`\${got === want ? 'ok' : 'FAIL'}\t\${d}: '\${got}'\`) }
EOF
bun "$T/only.ts" "$T/doc.json" >"$T/only.out" 2>&1 || cat "$T/only.out"
while IFS=$'\t' read -r st d; do [ "$st" = ok ] && ok "throwawayOnly: $d" || bad "throwawayOnly: $d"; done <"$T/only.out"

echo "== mm api <verb> <id>: the request's project decides, from its answers (sy-qsif)"
# this test's own API store (MM_API_DIR, as test/box.sh and test/api.sh use one), a request of each project; no mm.api
# runs, so every decision is refused (it does not answer): the refusals the tests expect
export MM_API_DIR="$T/api"; unset CLAUDECODE PASEO_AGENT_ID
cat >"$T/reqs.ts" <<EOF
import { store } from '$SRC/src/api'
const d = store(), add = d.query("INSERT INTO request (id, project, call, value, hash, status, item, created) VALUES (?, ?, 'egress', 'example.com', 'ab', 'pending', ?, 0)")
add.run('rq-qa', 'acme-qa', 'qa-1'); add.run('rq-shop', 'acme-shop', 'qa-2')
EOF
bun "$T/reqs.ts" || bad "make the API store"
api_case() {  # <description> <want: project or ''> <mm api args...>
  local d=$1 want=$2; shift 2
  : >"$T/spans"; mm api "$@" </dev/null >/dev/null 2>&1; local rc=$?
  if [ -n "$want" ]; then
    check "$d: refused, its record marked mm_throwaway $want, and its trace span too" sh -c "[ $rc != 0 ] && tail -1 '$LOG' | jq -e '.op == \"mm api $1\" and .level == \"error\" and .mm_throwaway == \"$want\"' && grep -q '\"key\":\"mm_throwaway\",\"value\":{\"stringValue\":\"$want\"}' '$T/spans'"
  else
    check "$d: refused, and NOT marked" sh -c "[ $rc != 0 ] && tail -1 '$LOG' | jq -e '.op == \"mm api $1\" and .level == \"error\" and (has(\"mm_throwaway\") | not)' && grep -q '\"mm api $1\"' '$T/spans' && ! grep -q mm_throwaway '$T/spans'"
  fi
}
api_case "approve a throwaway project's request" acme-qa approve rq-qa --hash 000000000000
api_case "...the same by its item's id (deny qa-1)" acme-qa deny qa-1
api_case "...undo" acme-qa undo rq-qa
api_case "...code" acme-qa code rq-qa
api_case "...show" acme-qa show rq-qa
api_case "approve a real project's request" '' approve rq-shop --hash 000000000000
api_case "...deny it by its item's id (qa-2)" '' deny qa-2
api_case "a request id that is not in the store" '' approve rq-none --hash 000000000000
# the request id read as a project ref would be wrong: a request named as a throwaway project is still the real one's
bun -e "import { Database } from 'bun:sqlite'; new Database('$T/api/api.db').run(\"UPDATE request SET id = 'acme-qa' WHERE id = 'rq-shop'\")"
api_case "a real project's request whose id is a throwaway project's name: NOT marked" '' approve acme-qa --hash 000000000000
check "the store was only read: no store made where there was none" sh -c "MM_API_DIR='$T/none' mm api show rq-qa >/dev/null 2>&1; [ ! -e '$T/none' ]"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
