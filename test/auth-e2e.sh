#!/usr/bin/env bash
# mm.auth end to end (sy-nwp) in a throwaway container: a fresh box in domain mode with the gateway on, a real project
# (mm new), and curl playing both the browser and the web proxy (Traefik's forward-auth). A code shown on the sign-in
# page, approved with `mm auth approve`, reaches the real board's public side as that person; nothing gets there
# without the gateway. A stub `expose` stands in for the machine's router tool. Nothing on the host is touched.
#
#   test/auth-e2e.sh --local dist/mm   [--image ubuntu:24.04] [--keep]      DOCKER="sudo -n docker" if needed
set -uo pipefail
IMAGE=ubuntu:24.04; LOCAL=""; KEEP=""; DOCKER=${DOCKER:-docker}
while [ $# -gt 0 ]; do case "$1" in
  --local) LOCAL=$(readlink -f "$2"); shift 2 ;; --image) IMAGE=$2; shift 2 ;; --keep) KEEP=1; shift ;;
  *) echo "usage: $0 --local <mm binary> [--image <image>] [--keep]"; exit 2 ;; esac; done
[ -n "$LOCAL" ] || { echo "--local <mm binary> is required"; exit 2; }
NAME=mm-auth-e2e-$$
SHIM=${MM_SHIM_URL:-https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm}
WORK=$(mktemp -d); trap '[ -n "$KEEP" ] || $DOCKER rm -f "$NAME" >/dev/null 2>&1; rm -rf -- "$WORK"' EXIT
chmod 755 "$WORK"; cp "$LOCAL" "$WORK/mm"

cat >"$WORK/as-root.sh" <<'EOF'
set -e
if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq git curl ca-certificates sudo >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q git curl sudo >/dev/null; fi
useradd -m -s /bin/bash dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
install -d -o dev -g dev /home/dev/.mm /home/dev/.mm/bin /home/dev/.local/bin && install -o dev -g dev -m 755 /w/mm /home/dev/.mm/bin/mm
# the machine's router tool, stubbed: it records what mm asks for (ops' expose makes the real Traefik route)
printf '#!/bin/sh\necho "$*" >>/tmp/expose.calls\n' >/home/dev/.local/bin/expose && chown dev:dev /home/dev/.local/bin/expose && chmod 755 /home/dev/.local/bin/expose
EOF

cat >"$WORK/as-dev.sh" <<'EOF'
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >/tmp/check.out 2>&1; then ok "$d"; else bad "$d"; tail -5 /tmp/check.out | sed 's/^/       /'; fi; }
export PATH=$HOME/.mm/bin:$HOME/.local/bin:$PATH
D=example.test; BOARD=board-shop-acme.$D
echo "== a box in domain mode, the gateway on"
curl -fsSL "$SHIM" | sh -s -- onboard --yes --access domain --domain $D --name gwbox >/tmp/onboard.out 2>&1
for n in $(mm needs -o json | jq -r '.[] | select(.required and .status == "missing" and .kind == "secret") | .name'); do printf 'e2e-dummy-%s' "$n" | mm fill "$n" >/dev/null; done
mm config set bind_host 127.0.0.1 >/dev/null; mm config set telegram.owner_id 777 >/dev/null; mm config set auth.enabled true >/dev/null
check "mm new acme/shop (domain mode)" mm new acme/shop
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
for _ in $(seq 1 30); do [ -S ~/.mm/run/auth.sock ] && break; sleep 1; done
check "mm.auth runs (its socket is there, 0600)" sh -c '[ "$(stat -c %a ~/.mm/run/auth.sock)" = 600 ]'
GP=$(mm config get auth_port); G=http://127.0.0.1:$GP
BP=$(jq -r '.services.board.public_port' ~/.mm/projects/acme/shop/.run/services.json)
check "the board has a public port, and mm asked the router for its route" sh -c "[ '$BP' -gt 0 ] && grep -q 'board-shop-acme $BP' /tmp/expose.calls"
cd ~/.mm/projects/acme/shop && bin/bd create "seen through the gateway" >/dev/null; cd ~
pub() { curl -s -o /tmp/pub.out -w '%{http_code}' -H "x-forwarded-host: $BOARD" "$@" "http://127.0.0.1:$BP/api/whoami"; }

echo "== nothing without the gateway"
check "the board's public side, no assertion: 401" test "$(pub)" = 401
check "...a forged identity header: 401" test "$(pub -H 'x-board-user: owner' -H 'x-board-role: owner')" = 401
check "forward-auth with no session: to the sign-in page" sh -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' -H 'x-forwarded-uri: /' $G/verify | grep -qi '^location: https://auth.$D/s?b=$BOARD'"

echo "== a code, approved elsewhere"
J=/tmp/jar
CODE=$(curl -s -c $J -b $J -H 'x-forwarded-for: 10.1.1.1' "$G/s?b=$BOARD&r=/" | sed -n 's/.*id="code"[^>]*>\([0-9A-Z-]*\)<.*/\1/p')
check "the sign-in page shows a code" sh -c "echo '$CODE' | grep -qE '^[0-9A-Z]{4}-[0-9A-Z]{4}$'"
check "the page waits until it is approved" sh -c "curl -s -b $J $G/s/poll | grep -q waiting"
check "mm auth approve --as alice --for acme-shop" sh -c "mm auth approve $CODE --as alice --for acme-shop -o json | jq -e '.user == \"alice\" and .role == \"member\"'"
curl -s -c $J -b $J "$G/s/poll" >/tmp/poll.json
check "the page gets a session and the board's callback" jq -e '.state == "approved" and (.next | startswith("https://'"$BOARD"'/_mm/auth/callback?c="))' /tmp/poll.json
NEXT=$(jq -r .next /tmp/poll.json); CB=${NEXT#https://$BOARD}
curl -s -c /tmp/bj -H "x-forwarded-host: $BOARD" -o /dev/null "$G$CB"
check "the board's own cookie (host-only)" grep -q mm_board /tmp/bj
curl -s -D /tmp/v.h -o /dev/null -b /tmp/bj -H "x-forwarded-host: $BOARD" -H 'x-forwarded-uri: /api/whoami' -H 'x-forwarded-proto: https' $G/verify
A=$(sed -n 's/^x-mm-assertion: \(.*\)\r$/\1/ip' /tmp/v.h)
check "forward-auth: 200 and a signed assertion" sh -c "head -1 /tmp/v.h | grep -q 200 && [ -n '$A' ]"

echo "== the real board, through the gateway"
check "the board knows alice (from the assertion)" sh -c "[ \"\$(curl -s -o /tmp/pub.out -w '%{http_code}' -H 'x-forwarded-host: $BOARD' -H 'x-mm-assertion: $A' http://127.0.0.1:$BP/api/whoami)\" = 200 ] && jq -e '.actor == \"alice\" and .source == \"gateway\"' /tmp/pub.out"
check "alice sees the board's items" sh -c "curl -s -H 'x-forwarded-host: $BOARD' -H 'x-mm-assertion: $A' 'http://127.0.0.1:$BP/api/v0/beads/issues?limit=20' | grep -q 'seen through the gateway'"
check "the assertion is bound to its host (another board: 401)" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-forwarded-host: board-other-acme.example.test' -H "x-mm-assertion: $A" http://127.0.0.1:$BP/api/whoami)" = 401
check "the local side is unchanged (portless name)" curl -sf -o /dev/null http://board.acme-shop.localhost:1355/api/whoami

echo "== revoke"
check "mm auth revoke alice" mm auth revoke alice
check "...her board cookie gets no assertion any more" sh -c "! curl -s -D - -o /dev/null -b /tmp/bj -H 'x-forwarded-host: $BOARD' -H 'x-forwarded-uri: /' $G/verify | head -1 | grep -q 200"
check "no code or cookie in the gateway's log" sh -c "! grep -qF '$CODE' ~/.mm/pc/*.log ~/.mm/run/*.log 2>/dev/null"
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
EOF
chmod 644 "$WORK"/*.sh

echo "== $IMAGE (local build)"
$DOCKER run -d --name "$NAME" -v "$WORK:/w:ro" "$IMAGE" sleep infinity >/dev/null || exit 1
$DOCKER exec "$NAME" sh /w/as-root.sh || { echo "container setup failed"; exit 1; }
$DOCKER exec -u dev -e SHIM="$SHIM" -w /home/dev "$NAME" bash /w/as-dev.sh; rc=$?
[ -n "$KEEP" ] && echo "kept: $DOCKER exec -it -u dev $NAME bash"
exit $rc
