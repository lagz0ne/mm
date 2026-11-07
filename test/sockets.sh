#!/usr/bin/env bash
# Sockets first, step 1 (docs/plans/sockets-first.md), hermetic: a throwaway HOME and MM_HOME, no process manager.
# Proves: a service with `listen: unix` gets its socket path under $MM_HOME/run/<project>/ (and one for a gated public
# side); one without, or a box project's, gets none; a path longer than a socket can hold (107 bytes) and an unknown
# `listen` are refused with a clear message; {socket:<service>} fills; .run/endpoints.json carries `socket` next to
# `url`; the template's svc.mjs finds it (svcSocket) and its request() helper talks HTTP over the socket (Host: the
# service's name) and over TCP, and an SVC_URL_ override wins.
#   test/sockets.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d /tmp/mm-sock.XXXXXX)
cleanup() { pkill -f "$T/" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
export HOME="$T/h" MM_HOME="$T/h/.mm" MM_OBS_TRACES=""
unset PASEO_AGENT_ID PASEO_AGENT_CWD
mkdir -p "$T/stub" "$MM_HOME/pc/projects"
for c in systemctl process-compose; do printf '#!/bin/sh\nexit 1\n' >"$T/stub/$c"; chmod +x "$T/stub/$c"; done
export PATH="$T/stub:$PATH:/usr/sbin"
printf 'access: domain\ndomain: example.org\nbind_host: 127.0.0.1\n' >"$MM_HOME/config.yaml"
fakeproj() { # <dir> <project> [box]
  mkdir -p "$1"
  printf 'client: acme\nname: shop\nproject: %s\nshort: x\nroot: %s\ntemplate_version: test\ncreated: test\n%s' "$2" "$1" "${3:+box: true
}" >"$1/.mm-answers.yaml"
  cat >"$1/services.yaml" <<'EOF'
services:
  board:
    command: "true"
    port: http
    listen: unix
    env: { BOARD_SOCKET: "{socket:board}" }
    public: { name: "board-shop-acme", auth: required }
  bd-serve:
    command: "true"
    port: http
  app:
    command: "true"
    port: http
    listen: unix
    public: { name: "shop-acme", auth: none }
EOF
}
js() { (cd "$T" && bun -e "import * as P from '$SRC/src/project.ts'; $1" 2>&1); }
fakeproj "$T/p" acme-shop

echo '== the paths'
R=$(js "const s = P.resolve('$T/p').services; console.log(JSON.stringify(Object.fromEntries(Object.entries(s).map(([n, x]) => [n, [x.socket || '', x.public_socket || '', x.env.BOARD_SOCKET || '']]))))")
is "board: \$MM_HOME/run/acme-shop/board.sock, and board-public.sock for its gated side" \
  test "$(jq -r '.board[0] + " " + .board[1]' <<<"$R")" = "$MM_HOME/run/acme-shop/board.sock $MM_HOME/run/acme-shop/board-public.sock"
is "{socket:board} fills to the same path" test "$(jq -r '.board[2]' <<<"$R")" = "$MM_HOME/run/acme-shop/board.sock"
is "bd-serve (no listen): no socket" test "$(jq -r '.["bd-serve"][0]' <<<"$R")" = ""
is "app (open public side): its socket, no public socket" test "$(jq -r '.app[0] + "|" + .app[1]' <<<"$R")" = "$MM_HOME/run/acme-shop/app.sock|"
is "nothing listens yet: no folder made by resolve()" test ! -e "$MM_HOME/run/acme-shop"
fakeproj "$T/b" acme-box box
is "a box project: no host socket (its sockets come in a later step)" \
  test "$(js "const s = P.resolve('$T/b').services; console.log(Object.values(s).filter((x) => x.socket).length)")" = 0

echo '== refusals'
L="$T/$(printf 'x%.0s' $(seq 1 80))"; mkdir -p "$L"; fakeproj "$L/p" acme-shop
OUT=$( (cd "$T" && MM_HOME="$L/.mm" bun -e "import * as P from '$SRC/src/project.ts'; try { P.resolve('$L/p'); console.log('resolved') } catch (e) { console.log(e.message) }") 2>&1)
is "a socket path over 107 bytes: refused, says which and why" bash -c 'grep -q "acme-shop.board: its socket .* bytes, more than a unix socket path can hold (107)" <<<"$1"' _ "$OUT"
is "sockPath at exactly 107 bytes is fine, 108 is refused" bash -c "cd '$T' && bun -e \"
  import { sockPath } from '$SRC/src/project.ts'
  const base = '$MM_HOME/run/'.length, pad = (n) => 'p'.repeat(n - base - '/b.sock'.length)
  let a = '', b = ''; try { a = sockPath(pad(107), 'b') } catch {} ; try { sockPath(pad(108), 'b') } catch (e) { b = e.message }
  process.exit(Buffer.byteLength(a) === 107 && b.includes('108 bytes') ? 0 : 1)\""
sed -i 's/listen: unix/listen: udp/' "$T/p/services.yaml"
OUT=$(js "try { P.resolve('$T/p') } catch (e) { console.log(e.message) }")
is "listen: udp: refused, with the choices" bash -c 'grep -q "acme-shop.board: listen: \"udp\" is not one of unix, tcp" <<<"$1"' _ "$OUT"
fakeproj "$T/p" acme-shop

echo '== .run/endpoints.json and up()'
js "P.writeRunFiles('$T/p', '$T/pc.sock')" >/dev/null
E="$T/p/.run/endpoints.json"
is "board: socket next to url" test "$(jq -r '.services.board | .url + " " + .socket' "$E")" = "http://board.acme-shop.localhost:1355 $MM_HOME/run/acme-shop/board.sock"
is "...the public socket is not in it (the local side's file)" bash -c "! grep -q board-public '$E'"
is "bd-serve: url only" test "$(jq -c '.services["bd-serve"] | keys' "$E")" = '["url"]'
js "P.up('$T/p')" >/dev/null
is "up(): the project's socket folder, 0700" test "$(stat -c %a "$MM_HOME/run/acme-shop" 2>/dev/null)" = 700

echo '== svc.mjs: svcSocket() and request()'
mkdir -p "$T/p/bin/lib"; cp "$SRC/template/bin/lib/svc.mjs" "$T/p/bin/lib/"
mkdir -p "$MM_HOME/run/acme-shop"
SOCK="$MM_HOME/run/acme-shop/board.sock"
# a node server on the socket, and one on a loopback port: each echoes method, path, Host and body
cat >"$T/echo.mjs" <<'EOF'
import http from 'node:http'
const [where, mark] = process.argv.slice(2)
const srv = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ mark, method: q.method, url: q.url, host: q.headers.host, body: b })) }) })
if (/^\d+$/.test(where)) srv.listen(Number(where), '127.0.0.1'); else { process.umask(0o177); srv.listen(where) }
EOF
node "$T/echo.mjs" "$SOCK" sock &
PORT=$(( 20000 + RANDOM % 20000 )); node "$T/echo.mjs" "$PORT" tcp &
for _ in $(seq 1 50); do [ -S "$SOCK" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
is "the socket is born 0600 (umask 0177)" test "$(stat -c %a "$SOCK")" = 600
q() { (cd "$T/p" && node --input-type=module -e "import * as S from '$T/p/bin/lib/svc.mjs'; $1" 2>&1); }
is "svcSocket(board): the path from endpoints.json; bd-serve: null" test "$(q "console.log(S.svcSocket('board'), S.svcSocket('bd-serve'))")" = "$SOCK null"
R=$(q "const r = await S.request('board', '/api/x?y=1', { method: 'POST', body: { a: 1 } }); console.log(r.status, r.body)")
is "request(board): over the socket, POST, path and body through" test "$R" = '200 {"mark":"sock","method":"POST","url":"/api/x?y=1","host":"board.acme-shop.localhost:1355","body":"{\"a\":1}"}'
R=$(SVC_URL_BD_SERVE="http://127.0.0.1:$PORT" q "const r = await S.request('bd-serve', '/healthz'); console.log(r.status, JSON.parse(r.body).mark, JSON.parse(r.body).url)")
is "request(bd-serve): over TCP to its URL" test "$R" = "200 tcp /healthz"
R=$(SVC_URL_BOARD="http://127.0.0.1:$PORT" q "const r = await S.request('board', '/'); console.log(JSON.parse(r.body).mark)")
is "an SVC_URL_BOARD override wins over endpoints.json's socket" test "$R" = tcp
R=$(SVC_SOCKET_BD_SERVE="$SOCK" q "console.log(JSON.parse((await S.request('bd-serve', '/')).body).mark)")
is "SVC_SOCKET_BD_SERVE: over that socket" test "$R" = sock
R=$(q "try { await S.request('nope', '/') } catch (e) { console.log(e.message) }")
is "an unknown service: refused, names the env vars" bash -c 'grep -q "nope: unknown address; set SVC_URL_NOPE or SVC_SOCKET_NOPE" <<<"$1"' _ "$R"
R=$(SVC_SOCKET_X="$T/none.sock" q "try { await S.request('x', '/') } catch (e) { console.log(e.code) }")
is "a socket nothing listens on: rejects (ENOENT)" test "$R" = ENOENT

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
