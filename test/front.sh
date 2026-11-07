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
# the listening TCP sockets on a port, from the kernel's own tables (no ss needed: a box image has none): "4 <addr>" or
# "6 <addr>", the address as /proc writes it (127.0.0.1 = 0100007F, ::1 = 00000000000000000000000001000000)
listeners() { local h; h=$(printf '%04X' "$1"); for v in 4 6; do f=/proc/net/tcp; [ $v = 6 ] && f=/proc/net/tcp6
  [ -r $f ] && awk -v h="$h" -v v=$v 'NR > 1 && $4 == "0A" { n = split($2, a, ":"); if (a[n] == h) print v, a[1] }' $f; done | LC_ALL=C sort | tr '\n' ' '; }
freeport() { local p; while :; do p=$(( 20000 + RANDOM % 30000 )); [ -z "$(listeners "$p")" ] && { echo "$p"; return; }; done; }

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
L=$(listeners "$FP")
V6=$(grep -c '^0\{31\}1 ' /proc/net/if_inet6 2>/dev/null || true)
if [ "${V6:-0}" -gt 0 ]; then is "listeners on its port: exactly 127.0.0.1 and ::1 ($L)" test "$L" = "4 0100007F 6 00000000000000000000000001000000 "
  is "...and it answers on ::1" test "$(c -o /dev/null -w '%{http_code}' -H 'Host: bd-serve.acme-shop.localhost' "http://[::1]:$FP/")" = 200
else is "listeners on its port: exactly 127.0.0.1 (no ::1 on this host) ($L)" test "$L" = "4 0100007F "; fi
EXT=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4; exit}')
[ -z "$EXT" ] && EXT=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -vE '^(127\.|::1$|$)' | grep -v : | head -1)
if [ -n "$EXT" ]; then is "nothing answers on a non-loopback address ($EXT:$FP)" bash -c "! curl -s --max-time 2 -o /dev/null -H 'Host: bd-serve.acme-shop.localhost' 'http://$EXT:$FP/'"
else ok "no non-loopback address on this host: nothing to try"; fi
is "no 0.0.0.0 / [::] listener on its port" bash -c '[[ -n "$1" && " $1" != *" 4 00000000 "* && " $1" != *" 6 00000000000000000000000000000000 "* ]]' _ "$L"
kill "$FP_PID" 2>/dev/null; wait "$FP_PID" 2>/dev/null; FP=

# ---------- step 3: front.enabled ----------
# a host project as mm reads it: a board with its gated public side (its server.mjs knows BOARD_PUBLIC_PORT), bd-serve,
# an open app slot, and a service on its socket; and a box project
echo '== step 3: front.enabled off (the default): portless, as before'
printf '#!/bin/sh\nexit 0\n' >"$T/stub/portless"; chmod +x "$T/stub/portless"
conf() { printf 'access: domain\ndomain: example.org\nbind_host: 127.0.0.1\n%b' "${1:-}" >"$MM_HOME/config.yaml"; }
proj() { # <dir> <project> [box]
  mkdir -p "$1/site" "$1/release"; echo 'process.env.BOARD_PUBLIC_PORT' >"$1/site/server.mjs"
  printf 'client: acme\nname: shop\nproject: %s\nshort: x\nroot: %s\ntemplate_version: test\ncreated: test\n%s' "$2" "$1" "${3:+box: true
}" >"$1/.mm-answers.yaml"
  cat >"$1/services.yaml" <<'EOF'
services:
  bd-serve:
    command: "exec node {home}/svc.mjs $PORT bd"
    port: http
    ready: { http: /healthz }
  board:
    command: "true"
    port: http
    public: { name: "board-{project}", auth: required }
    ready: { http: /api/whoami }
  app:
    optional: true
    command: "true"
    port: http
    public: { name: "app-{project}", auth: none }
  sock:
    command: "true"
    port: http
    listen: unix
    ready: { http: /healthz }
EOF
  echo "# from $1/services.yaml" >"$MM_HOME/pc/projects/$2.yaml"; }
cp "$T/svc.mjs" "$HOME/svc.mjs"
proj "$T/p1" acme-shop; proj "$T/p2" acme-two; proj "$T/bx" acme-box box
js() { (cd "$T" && bun -e "import * as P from '$SRC/src/project.ts'; import * as PC from '$SRC/src/pc.ts'; $1" 2>&1); }
base() { js "PC.writeBase()" >/dev/null; bun -e "const y = Bun.YAML.parse(await Bun.file('$MM_HOME/pc/base.yaml').text()); console.log(Object.keys(y.processes).filter((k) => /portless|front/.test(k)).join(' ') + ' | ' + (y.processes['mm.front']?.command || ''))"; }
svcs() { js "const s = P.resolve('$1').services; console.log(JSON.stringify(s))"; }
proc() { js "const r = P.resolve('$1'); const s = r.services; console.log(JSON.stringify(P.serviceProcess('$1', r.answers.project, '$2', s['$2'], s, { env: {}, socket: '/x', pdeath: '', claim: '/c.mjs' })))"; }
export -f js svcs proc base; export T SRC
rm -f "$RD"/*.json
conf
is "writeBase: mm.portless, no mm.front" test "$(base)" = "mm.portless | "
S=$(svcs "$T/p1")
is "resolve: no mm port for any service (local_port), no PORT; the app keeps PORTLESS_APP_PORT" \
  test "$(jq -c '[[.[] | .local_port // empty], [.[] | .env.PORT // empty], (.app.env.PORTLESS_APP_PORT == (.app.public_port | tostring))]' <<<"$S")" = '[[],[],true]'
is "serviceProcess: the portless wrapper and the probe through the name, as before" \
  test "$(proc "$T/p1" bd-serve | jq -r '.command + " # " + .readiness_probe.exec.command')" = "node '/c.mjs' bd-serve.acme-shop && exec portless bd-serve.acme-shop --force sh -c 'exec node $HOME/svc.mjs \$\$PORT bd' # curl -sf -o /dev/null --max-time 3 http://bd-serve.acme-shop.localhost:1355/healthz"
js "P.writeRunFiles('$T/p1', '$T/pc.sock')" >/dev/null
is "writeRunFiles: no route file for the front" test ! -e "$RD/acme-shop.json"

echo '== step 3: front.enabled on'
conf 'front:\n  enabled: true\n'
is "writeBase: mm.front on portless_port, no mm.portless (portless is on PATH)" test "$(base)" = "mm.front | $(command -v true >/dev/null; echo "$(cd "$T" && bun -e "import { which } from '$SRC/src/env.ts'; import { DIRS } from '$SRC/src/env.ts'; import { join } from 'node:path'; console.log(which('mm') || join(DIRS.bin, 'mm'))") front serve --port 1355")"
S=$(svcs "$T/p1")
BD=$(jq -r '."bd-serve".local_port' <<<"$S")
is "bd-serve: an mm port in 38100-38999, as its PORT ($BD)" bash -c "[ '$BD' -ge 38100 ] && [ '$BD' -le 38999 ] && [ \"\$(jq -r '.\"bd-serve\".env.PORT' <<<'$S')\" = '$BD' ]"
is "board: its own local port, not its public side's" test "$(jq -r '(.board.local_port != .board.public_port) and (.board.env.PORT == (.board.local_port | tostring)) and (.board.env.BOARD_PUBLIC_PORT == (.board.public_port | tostring))' <<<"$S")" = true
is "app (an open public side): its PORT is its public port, no PORTLESS_APP_PORT" test "$(jq -r '(.app.local_port == .app.public_port) and (.app.env.PORT == (.app.public_port | tostring)) and (.app.env.PORTLESS_APP_PORT == null)' <<<"$S")" = true
is "sock (listen: unix): MM_SOCKET, no port" test "$(jq -r '[.sock.env.MM_SOCKET, .sock.local_port // "-", .sock.env.PORT // "-"] | join(" ")' <<<"$S")" = "$MM_HOME/run/acme-shop/sock.sock - -"
is "every port this project holds is distinct (dolt, public, local; the app's local port is its public one)" bash -c "js \"const r = P.resolve('$T/p1'); const p = [r.dport, ...Object.values(r.services).flatMap((s) => [s.public_port, s.local_port]).filter(Boolean)]; console.log(new Set(p).size === p.length - 1 ? 'ok' : p.join(','))\" | grep -qx ok"
P=$(proc "$T/p1" bd-serve)
is "serviceProcess: no portless wrapper, the command as written" test "$(jq -r .command <<<"$P")" = "exec node $HOME/svc.mjs \$\$PORT bd"
is "...its probe goes to mm's port, with its name as Host (curl --connect-to)" test "$(jq -r .readiness_probe.exec.command <<<"$P")" = "curl -sf -o /dev/null --max-time 3 --connect-to ::127.0.0.1:$BD http://bd-serve.acme-shop.localhost:1355/healthz"
is "a socket service's probe: curl --unix-socket" test "$(proc "$T/p1" sock | jq -r .readiness_probe.exec.command)" = "curl -sf -o /dev/null --max-time 3 --unix-socket '$MM_HOME/run/acme-shop/sock.sock' http://sock.acme-shop.localhost:1355/healthz"
js "P.writeRunFiles('$T/p1', '$T/pc.sock')" >/dev/null
RF="$RD/acme-shop.json"
is "writeRunFiles: the project's route file, every HTTP service by name" test "$(jq -c '[.routes[] | .host] | sort' "$RF" 2>/dev/null)" = '["app.acme-shop.localhost","bd-serve.acme-shop.localhost","board.acme-shop.localhost","sock.acme-shop.localhost"]'
is "...bd-serve to its port, sock to its socket" test "$(jq -r '[(.routes[] | select(.host == "bd-serve.acme-shop.localhost") | .port), (.routes[] | select(.host == "sock.acme-shop.localhost") | .socket)] | join(" ")' "$RF")" = "$BD $MM_HOME/run/acme-shop/sock.sock"
is "...the board's public port is listed as never a target, and is no route" test "$(jq -r --argjson p "$(jq .board.public_port <<<"$S")" '(.public_ports == [$p]) and ([.routes[].port] | index($p) == null)' "$RF")" = true
is "...the ports are recorded (.run/services.json local_port): the same at the next resolve" test "$(jq -r '.services."bd-serve".local_port' "$T/p1/.run/services.json"):$(svcs "$T/p1" | jq -r '."bd-serve".local_port')" = "$BD:$BD"
S2=$(svcs "$T/p2"); js "P.writeRunFiles('$T/p2', '$T/pc.sock')" >/dev/null
is "a second project gets none of the first one's ports" bash -c "comm -12 <(jq -r '.held_ports[]' '$RD/acme-shop.json' | sort) <(jq -r '.held_ports[]' '$RD/acme-two.json' | sort) | grep -q . && exit 1 || exit 0"
is "a box project: no mm ports, the portless wrapper (its own portless in the box)" bash -c "[ \"\$(svcs '$T/bx' | jq -c '[.[] | .local_port // empty]')\" = '[]' ] && proc '$T/bx' bd-serve | jq -r .command | grep -q 'exec portless bd-serve.acme-box --force'"
js "P.up('$T/p1')" >/dev/null
is "mm up: the process file has no portless at all" bash -c "! grep -q portless '$MM_HOME/pc/projects/acme-shop.yaml' && grep -q 'PORT=$BD' '$MM_HOME/pc/projects/acme-shop.yaml'"

echo '== step 3: end to end (the front on the project route file, the service on mm`s port, the probe)'
FP=$(freeport)
(cd "$HOME" && PORT=$BD exec node "$HOME/svc.mjs" "$BD" bd) &
(cd "$T" && exec bun "$SRC/src/cli.ts" front serve --port "$FP") >"$T/front2.log" 2>&1 &
FP_PID=$!
for _ in $(seq 1 100); do curl -s -o /dev/null "http://127.0.0.1:$FP/" && curl -s -o /dev/null "http://127.0.0.1:$BD/" && break; sleep 0.1; done
is "bd-serve.acme-shop.localhost through the front: the service on mm's port" test "$(curl -s -H 'Host: bd-serve.acme-shop.localhost' "http://127.0.0.1:$FP/healthz" | jq -r .mark)" = bd
is "the readiness probe as mm wrote it: passes, and the service saw its name as Host" bash -c "$(jq -r .readiness_probe.exec.command <<<"$P") && [ \"\$(curl -s --connect-to ::127.0.0.1:$BD http://bd-serve.acme-shop.localhost:1355/ | jq -r .host)\" = bd-serve.acme-shop.localhost:1355 ]"
is "a public name through the front: 404" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: board-acme-shop.example.org' "http://127.0.0.1:$FP/")" = 404
kill "$FP_PID" 2>/dev/null; wait "$FP_PID" 2>/dev/null; FP=
conf
is "front.enabled off again (the rollback): writeBase has mm.portless again" test "$(base)" = "mm.portless | "

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
