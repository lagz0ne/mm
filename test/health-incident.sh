#!/usr/bin/env bash
# The watchdog's incidents (template/bin/health), hermetic: a throwaway project folder with the template's bin/, a stub
# service and a stub board (bd-serve's REST shape) on free ports, no process manager, no Paseo.
# Proves:
#  1. a service down 3 checks in a row: one incident opened (P0, label incident), state in .health.json
#  2. ...the check passes again: a comment and a close on that incident, and the state forgets it
#  3. the project moved into a box (sy-6n9w): the box's run (HEALTH_STATE=.run/health.json) starts from the host's
#     .health.json and closes the incident the host opened
#  4. ...and back out of the box: the host's run closes the one the box opened (the newer file wins)
#  5. what the other side's file holds is data: an incident id that is not an item id is dropped, a link is not read
#   test/health-incident.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); SP=""
trap '[ -n "$SP" ] && kill "$SP" 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_OBS_METRICS="" PASEO_BIN=true MM_PROJECT=acme-shop
B="$(command -v bun || echo "$HOME/.bun/bin/bun")"
P="$T/projects/acme/shop"; mkdir -p "$P/.run" "$HOME"
cp -r "$SRC/template/bin" "$P/bin"
printf 'client: acme\nname: shop\nproject: acme-shop\n' >"$P/.mm-answers.yaml"
# the stubs: GET /healthz answers 200 while $T/up exists; the board records every call and gives out ids
cat >"$T/stub.ts" <<'EOF'
import { appendFileSync, existsSync } from 'node:fs'
const T = process.argv[2]; let n = 0
const s = Bun.serve({ port: 0, async fetch(r) {
  const u = new URL(r.url)
  if (u.pathname === '/healthz') return new Response('', { status: existsSync(`${T}/up`) ? 200 : 503 })
  const body = r.method === 'POST' ? await r.text() : ''
  appendFileSync(`${T}/calls`, `${r.method} ${u.pathname} ${body}\n`)
  if (r.method === 'POST' && u.pathname === '/v0/beads/issues') return Response.json({ id: `as-${++n}` })
  return Response.json({})
} })
console.log(s.port)
EOF
"$B" "$T/stub.ts" "$T" >"$T/port" 2>"$T/stub.err" & SP=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT=$(cat "$T/port"); [ -n "$PORT" ] || { echo "the stub did not start: $(cat "$T/stub.err")"; exit 2; }
cat >"$P/.run/services.json" <<EOF
{ "project": "acme-shop", "services": { "web": { "port": "http", "ready": { "http": "/healthz" } } } }
EOF
cat >"$P/.run/endpoints.json" <<EOF
{ "services": { "web": { "url": "http://127.0.0.1:$PORT" }, "bd-serve": { "url": "http://127.0.0.1:$PORT" } }, "restart": "true", "self_healing": true }
EOF
health() { (cd "$P" && "$@" node "$P/bin/health") >>"$T/out" 2>&1; }
host() { health env; }
box() { health env HEALTH_STATE="$P/.run/health.json"; }
opened() { grep -c '^POST /v0/beads/issues {' "$T/calls" 2>/dev/null || echo 0; }
closed() { grep -q "^POST /v0/beads/issues/$1:close " "$T/calls" 2>/dev/null; }
incident() { node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log(j.web?.incident ?? 'none')" "$1"; }

echo "== 1. down 3 checks in a row"
host; host; is "...after 2 failed checks no incident yet" [ "$(opened)" = 0 ]
host
is "...after 3: one incident opened" [ "$(opened)" = 1 ]
is "...a P0 with the incident label" grep -q '"priority":0,"labels":\["incident"' "$T/calls"
is "...and the host's state has it (.health.json): $(incident "$P/.health.json")" [ "$(incident "$P/.health.json")" = as-1 ]
host; is "...a 4th failed check opens no second one" [ "$(opened)" = 1 ]

echo "== 2. the check passes again"
touch "$T/up"; host
is "a recovery comment on the incident" grep -q '^POST /v0/beads/issues/as-1/comments .*Recovered' "$T/calls"
is "...and the incident closed" closed as-1
is "...the state forgets it" [ "$(incident "$P/.health.json")" = none ]

echo "== 3. the project moves into a box, with an incident open"
rm -f "$T/up"; host; host; host
is "the host opened a second incident" [ "$(opened)" = 2 ] && is "...in .health.json" [ "$(incident "$P/.health.json")" = as-2 ]
touch "$T/up"; box
is "the box's first run (no .run/health.json yet) closes the host's incident" closed as-2
is "...and writes its own state under .run" [ "$(incident "$P/.run/health.json")" = none ]

echo "== 4. ...and back out of the box"
rm -f "$T/up"; box; box; box
is "the box opened a third incident, in .run/health.json" [ "$(incident "$P/.run/health.json")" = as-3 ]
touch "$T/up"; host
is "the host's run starts from the box's newer state and closes it" closed as-3

echo "== 5. the other side's file is data"
printf '{"web":{"fails":5,"incident":"../../admin"}}' >"$P/.run/health.json"; touch -d '+1 min' "$P/.run/health.json"
: >"$T/calls"; host
is "an incident id that is not an item id: no call with it" bash -c "! grep -q admin '$T/calls'"
printf '{"web":{"fails":5,"incident":"as-9"}}' >"$T/elsewhere.json"; rm -f "$P/.run/health.json"; ln -s "$T/elsewhere.json" "$P/.run/health.json"
touch -h -d '+2 min' "$P/.run/health.json" 2>/dev/null; : >"$T/calls"; host
is "a link at .run/health.json is not followed" bash -c "! grep -q as-9 '$T/calls'"

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ] || { echo "--- health's output"; tail -30 "$T/out"; exit 1; }
