#!/usr/bin/env bash
# mm's own spans (sy-ha9x), hermetic: an answer is not a fault. `mm config get` on an unset key exits 1 but its span is
# not failed; `mm doctor` failing only on a throwaway project (a test planted the fault) marks its span mm_throwaway,
# so neither raises an mm/mm incident. A throwaway HOME / MM_HOME with a throwaway project and a real one (nothing
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
printf 'access: tailscale\nhost: qa-host\n' >"$MM_HOME/config.yaml"

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
  printf '#!/bin/sh\n[ "$3" = dolt.auto-start ] && echo false || echo true\n' >"$P/bin/bd"; chmod +x "$P/bin/bd"
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

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
