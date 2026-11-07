#!/usr/bin/env bash
# mm.front, the local names (sockets first, steps 2-3; docs/plans/sockets-first.md), hermetic: a throwaway HOME and
# MM_HOME, the front on a free test port, fake services (a "board" on a unix socket, one on a loopback port), stubs
# for the process manager. Never the machine's portless, mm or process manager.
# Step 2 (the front): routes a name to a socket and to a port; Host and x-forwarded-* passed on (what the front saw,
# not what a client claims); POST bodies, gzip untouched, SSE streams (events arrive as sent), a websocket; an unknown
# name 404, a public host 404; a route to a public side (its -public socket, a gated public port) or to a name that is
# not .localhost is refused; the table reloads when a file comes or goes; a dead target 502; it listens on 127.0.0.1
# and ::1 only (ss; nothing answers on a non-loopback address).
#   test/front.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d /tmp/mm-front.XXXXXX)
cleanup() { pkill -f "$T/" 2>/dev/null; [ -n "${FP:-}" ] && kill "$FP" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
export HOME="$T/h" MM_HOME="$T/h/.mm" MM_OBS_TRACES=""
unset PASEO_AGENT_ID PASEO_AGENT_CWD MM_FRONT_DIR
mkdir -p "$T/stub" "$MM_HOME/pc/projects" "$MM_HOME/run/acme-shop"
for c in systemctl process-compose; do printf '#!/bin/sh\nexit 1\n' >"$T/stub/$c"; chmod +x "$T/stub/$c"; done
export PATH="$T/stub:$PATH:/usr/sbin"
RD="$MM_HOME/front/routes"; mkdir -p "$RD"
freeport() { local p; while :; do p=$(( 20000 + RANDOM % 30000 )); ss -Htln | grep -q ":$p\b" || { echo "$p"; return; }; done; }

# the fake services: echo what they got; /events: three SSE events 300 ms apart; /gz: a gzip body
cat >"$T/svc.mjs" <<'EOF'
import http from 'node:http'
import zlib from 'node:zlib'
const [where, mark] = process.argv.slice(2)
const srv = http.createServer((q, r) => {
  if (q.url === '/events') {
    r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let i = 0; const t = setInterval(() => { r.write(`data: ${i} ${Date.now()}\n\n`); if (++i === 3) { clearInterval(t); r.end() } }, 300); return
  }
  if (q.url === '/gz') { r.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }); r.end(zlib.gzipSync('squeezed')); return }
  let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { r.setHeader('content-type', 'application/json'); r.setHeader('x-mark', mark)
    r.end(JSON.stringify({ mark, method: q.method, url: q.url, host: q.headers.host, xfh: q.headers['x-forwarded-host'], xfp: q.headers['x-forwarded-proto'], xff: q.headers['x-forwarded-for'], body: b })) })
})
if (/^\d+$/.test(where)) srv.listen(Number(where), '127.0.0.1'); else { process.umask(0o177); srv.listen(where) }
EOF
# a websocket echo on a port (Bun)
cat >"$T/ws.ts" <<'EOF'
Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]), fetch(req, s) { return s.upgrade(req, { data: req.headers.get('host') }) ? undefined : new Response('no') },
  websocket: { message(ws, m) { ws.send(`echo ${m} host=${ws.data}`) } } })
EOF
SOCK="$MM_HOME/run/acme-shop/board.sock"
SP=$(freeport); WP=$(freeport); DEAD=$(freeport); PUBP=$(freeport); FP=$(freeport)
node "$T/svc.mjs" "$SOCK" board &
node "$T/svc.mjs" "$SP" bd &
bun "$T/ws.ts" "$WP" &
cat >"$RD/acme-shop.json" <<EOF
{ "project": "acme-shop", "public_ports": [$PUBP],
  "routes": [ { "host": "board.acme-shop.localhost", "socket": "$SOCK" }, { "host": "bd-serve.acme-shop.localhost", "port": $SP },
              { "host": "ws.acme-shop.localhost", "port": $WP }, { "host": "gone.acme-shop.localhost", "port": $DEAD },
              { "host": "pub.acme-shop.localhost", "socket": "$MM_HOME/run/acme-shop/board-public.sock" },
              { "host": "pubport.acme-shop.localhost", "port": $PUBP },
              { "host": "board-shop-acme.example.org", "port": $SP } ] }
EOF
(cd "$T" && exec bun "$SRC/src/cli.ts" front serve --port "$FP") >"$T/front.log" 2>&1 &
FP_PID=$!
for _ in $(seq 1 100); do [ -S "$SOCK" ] && curl -s -o /dev/null "http://127.0.0.1:$FP/" && break; sleep 0.1; done
c() { curl -s --max-time 5 "$@"; }
F="http://127.0.0.1:$FP"

echo '== step 2: routing'
R=$(c -H 'Host: board.acme-shop.localhost:1355' -H 'x-forwarded-host: evil.example.org' -H 'x-forwarded-proto: https' "$F/api/whoami?x=1")
is "board.acme-shop.localhost -> the board's socket (path and query through)" test "$(jq -r '.mark + " " + .url' <<<"$R")" = "board /api/whoami?x=1"
is "Host passed on as the client sent it" test "$(jq -r .host <<<"$R")" = "board.acme-shop.localhost:1355"
is "x-forwarded-host / -proto / -for: what the front saw, not what the client claimed" test "$(jq -r '.xfh + " " + .xfp + " " + .xff' <<<"$R")" = "board.acme-shop.localhost:1355 http 127.0.0.1"
R=$(c -H 'Host: bd-serve.acme-shop.localhost' -X POST --data-binary '{"a":1}' "$F/api/list")
is "bd-serve.acme-shop.localhost -> its loopback port, POST and body through" test "$(jq -c '[.mark, .method, .body]' <<<"$R")" = '["bd","POST","{\"a\":1}"]'
is "a name is case-blind, a trailing dot too" test "$(c -H 'Host: BD-Serve.Acme-Shop.LOCALHOST.' "$F/" | jq -r .mark)" = bd
is "a response header comes back" bash -c "curl -s -D - -o /dev/null -H 'Host: bd-serve.acme-shop.localhost' '$F/' | grep -qi '^x-mark: bd'"
is "gzip: the body passes untouched (curl --compressed reads it)" test "$(c --compressed -H 'Host: bd-serve.acme-shop.localhost' "$F/gz")" = squeezed
# SSE: each event must arrive when it was sent, not all at the end
c -N -H 'Host: board.acme-shop.localhost' "$F/events" | while IFS= read -r l; do [ -n "$l" ] && echo "$l $(date +%s%3N)"; done >"$T/sse"
N=$(wc -l <"$T/sse"); GAP=$(awk 'NR==1{a=$4} END{print $4-a}' "$T/sse")
is "SSE through the front: 3 events, the first ~600 ms before the last (streamed, not buffered; gap ${GAP} ms)" bash -c "[ '$N' = 3 ] && [ '$GAP' -ge 400 ]"
R=$(cd "$T" && bun -e "
  const ws = new WebSocket('ws://127.0.0.1:$FP/x', { headers: { host: 'ws.acme-shop.localhost' } })
  ws.onopen = () => ws.send('hi'); ws.onmessage = (e) => { console.log(e.data); ws.close(); process.exit(0) }; setTimeout(() => { console.log('timeout'); process.exit(1) }, 4000)" 2>&1)
is "a websocket through the front (to a port target), Host kept" test "$R" = "echo hi host=ws.acme-shop.localhost"

echo '== step 2: what the front refuses'
is "an unknown name: 404" test "$(c -o /dev/null -w '%{http_code}' -H 'Host: nope.acme-shop.localhost' "$F/")" = 404
is "a public host (board-shop-acme.example.org): 404, even though a route file names it" test "$(c -o /dev/null -w '%{http_code}' -H 'Host: board-shop-acme.example.org' "$F/")" = 404
is "a bare IP as Host: 404" test "$(c -o /dev/null -w '%{http_code}' -H "Host: 127.0.0.1:$FP" "$F/")" = 404
is "a route to a board's -public socket: refused (404), and logged" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: pub.acme-shop.localhost' '$F/')\" = 404 ] && grep -q 'pub.acme-shop.localhost: a public side.s socket' '$T/front.log'"
is "a route to a gated public port: refused (404), and logged" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: pubport.acme-shop.localhost' '$F/')\" = 404 ] && grep -q \"pubport.acme-shop.localhost: port $PUBP is a public side's\" '$T/front.log'"
is "a route that is not a .localhost name: refused, logged" grep -q 'board-shop-acme.example.org: not a local name' "$T/front.log"
is "a target that does not answer: 502" test "$(c -o /dev/null -w '%{http_code}' -H 'Host: gone.acme-shop.localhost' "$F/")" = 502
is "mm front ls: the table, the refusals on stderr" bash -c "cd '$T' && bun '$SRC/src/cli.ts' front ls -o json 2>'$T/ls.err' | jq -e 'map(.name) | sort == [\"bd-serve.acme-shop.localhost\",\"board.acme-shop.localhost\",\"gone.acme-shop.localhost\",\"ws.acme-shop.localhost\"]' >/dev/null && grep -q 'refused: acme-shop: pub.acme-shop.localhost' '$T/ls.err'"

echo '== step 2: reload'
printf '{ "project": "acme-two", "routes": [ { "host": "app.acme-two.localhost", "port": %s }, { "host": "board.acme-shop.localhost", "port": %s } ] }' "$SP" "$SP" >"$RD/.t" && mv "$RD/.t" "$RD/acme-two.json"
for _ in $(seq 1 40); do [ "$(c -H 'Host: app.acme-two.localhost' "$F/" | jq -r .mark 2>/dev/null)" = bd ] && break; sleep 0.1; done
is "a new project's file: its name routes (within 4 s)" test "$(c -H 'Host: app.acme-two.localhost' "$F/" | jq -r .mark 2>/dev/null)" = bd
is "...a name another project holds stays that project's (first file wins), logged" bash -c "[ \"\$(curl -s -H 'Host: board.acme-shop.localhost' '$F/' | jq -r .mark)\" = board ] && grep -q 'acme-two: board.acme-shop.localhost is another project.s already' '$T/front.log'"
rm "$RD/acme-two.json"
for _ in $(seq 1 40); do [ "$(c -o /dev/null -w '%{http_code}' -H 'Host: app.acme-two.localhost' "$F/")" = 404 ] && break; sleep 0.1; done
is "its file gone: 404 again" test "$(c -o /dev/null -w '%{http_code}' -H 'Host: app.acme-two.localhost' "$F/")" = 404

echo '== step 2: where it listens (review condition 1)'
L=$(ss -Htlnp | grep "pid=$FP_PID," | awk '{print $4}' | LC_ALL=C sort | tr '\n' ' ')
V6=$(grep -c '^0\{31\}1 ' /proc/net/if_inet6 2>/dev/null || true)
if [ "${V6:-0}" -gt 0 ]; then is "listeners: exactly 127.0.0.1:$FP and [::1]:$FP ($L)" test "$L" = "127.0.0.1:$FP [::1]:$FP "
  is "...and it answers on ::1" test "$(c -o /dev/null -w '%{http_code}' -H 'Host: bd-serve.acme-shop.localhost' "http://[::1]:$FP/")" = 200
else is "listeners: exactly 127.0.0.1:$FP (no ::1 on this host) ($L)" test "$L" = "127.0.0.1:$FP "; fi
EXT=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4; exit}')
if [ -n "$EXT" ]; then is "nothing answers on a non-loopback address ($EXT:$FP)" bash -c "! curl -s --max-time 2 -o /dev/null -H 'Host: bd-serve.acme-shop.localhost' 'http://$EXT:$FP/'"
else ok "no non-loopback address on this host: nothing to try"; fi
is "no 0.0.0.0 / [::] listener of the front" bash -c "! ss -Htlnp | grep 'pid=$FP_PID,' | awk '{print \$4}' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):'"
kill "$FP_PID" 2>/dev/null; wait "$FP_PID" 2>/dev/null; FP=

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
