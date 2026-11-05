#!/usr/bin/env bash
# Project box, the way in (sy-9il step 0 (d)): a real Traefik in front of a box's board, with forward-auth to the
# sign-in gateway, as ops' `expose` makes the route. Throwaway containers and network only; the live Traefik is not
# touched. curl is the browser and talks to Traefik only (https, Traefik's default certificate). Proves: no session
# -> the sign-in page; a code approved with `mm auth approve` -> the board knows the person; a client's own
# X-MM-Assertion or X-Board-* never gets through; revoke ends it.
#   test/box-gateway.sh --local dist/mm   [--keep]        DOCKER="sudo -n docker" if needed
set -uo pipefail
DOCKER=${DOCKER:-docker}; LOCAL=""; KEEP=""; IMAGE=${IMAGE:-ubuntu:24.04}; TRAEFIK=${TRAEFIK:-traefik:v3.6.25}
while [ $# -gt 0 ]; do case "$1" in --local) LOCAL=$(readlink -f "$2"); shift 2 ;; --keep) KEEP=1; shift ;; *) echo "usage: $0 --local <mm> [--keep]"; exit 2 ;; esac; done
[ -n "$LOCAL" ] || { echo "--local <mm binary> is required"; exit 2; }
ID=$$; NET=mm-boxgw-$ID; BOX=mm-boxgw-box-$ID; TR=mm-boxgw-traefik-$ID
SHIM=${MM_SHIM_URL:-https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm}
WORK=$(mktemp -d); chmod 755 "$WORK"; cp "$LOCAL" "$WORK/mm"
cleanup() { [ -n "$KEEP" ] || { $DOCKER rm -f "$BOX" "$TR" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1; }; rm -rf -- "$WORK"; }
trap cleanup EXIT
D=example.test; BOARD=board-shop-acme.$D; AUTH=auth.$D

cat >"$WORK/as-root.sh" <<'EOF'
set -e
export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq git curl ca-certificates sudo >/dev/null
useradd -m -s /bin/bash dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
install -d -o dev -g dev /home/dev/.mm /home/dev/.mm/bin /home/dev/.local/bin && install -o dev -g dev -m 755 /w/mm /home/dev/.mm/bin/mm
printf '#!/bin/sh\necho "$*" >>/tmp/expose.calls\n' >/home/dev/.local/bin/expose && chown dev:dev /home/dev/.local/bin/expose && chmod 755 /home/dev/.local/bin/expose
EOF
cat >"$WORK/box.sh" <<'EOF'
set -u
export PATH=$HOME/.mm/bin:$HOME/.local/bin:$PATH
IP=$(hostname -i | awk '{print $1}')
curl -fsSL "$SHIM" | sh -s -- onboard --yes --access domain --domain example.test --name boxgw >/tmp/onboard.out 2>&1
for n in $(mm needs -o json | jq -r '.[] | select(.required and .status == "missing" and .kind == "secret") | .name'); do printf 'dummy-%s' "$n" | mm fill "$n" >/dev/null; done
# the box's own address is where the web proxy reaches it: mm's forwarder (board) and the gateway listen there
mm config set bind_host "$IP" >/dev/null; mm config set telegram.owner_id 777 >/dev/null; mm config set auth.enabled true >/dev/null
mm new acme/shop >/tmp/new.out 2>&1 || { tail -20 /tmp/new.out; exit 1; }
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
for _ in $(seq 1 30); do [ -S ~/.mm/run/auth.sock ] && break; sleep 1; done
(cd ~/.mm/projects/acme/shop && bin/bd create "seen through Traefik" >/dev/null)
echo "IP=$IP GP=$(mm config get auth_port) BP=$(jq -r .services.board.public_port ~/.mm/projects/acme/shop/.run/services.json)"
EOF
chmod 644 "$WORK"/*.sh

echo "== the box (domain mode, the gateway on, a real project)"
$DOCKER network create "$NET" >/dev/null || exit 1
$DOCKER run -d --name "$BOX" --network "$NET" -v "$WORK:/w:ro" "$IMAGE" sleep infinity >/dev/null || exit 1
$DOCKER exec "$BOX" sh /w/as-root.sh || { echo "box setup failed"; exit 1; }
OUT=$($DOCKER exec -u dev -e SHIM="$SHIM" -w /home/dev "$BOX" bash /w/box.sh) || { echo "box failed: $OUT"; exit 1; }
eval "$(echo "$OUT" | tail -1)"; echo "  box $IP: gateway :$GP, board public side :$BP"

echo "== Traefik in front (forward-auth to the gateway, as expose makes it)"
mkdir -p "$WORK/traefik" && cat >"$WORK/traefik/dyn.yml" <<EOF
http:
  middlewares:
    mm-auth:
      forwardAuth:
        address: "http://$IP:$GP/verify"
        trustForwardHeader: false
        authResponseHeaders: ["X-MM-Assertion", "X-Board-User", "X-Board-Role"]
  routers:
    board:
      rule: "Host(\`$BOARD\`)"
      entryPoints: [websecure]
      tls: {}
      middlewares: [mm-auth]
      service: board
    board-callback:
      rule: "Host(\`$BOARD\`) && PathPrefix(\`/_mm/auth/\`)"
      priority: 1000
      entryPoints: [websecure]
      tls: {}
      service: gateway
    gateway:
      rule: "Host(\`$AUTH\`)"
      entryPoints: [websecure]
      tls: {}
      service: gateway
  services:
    board: { loadBalancer: { servers: [ { url: "http://$IP:$BP" } ] } }
    gateway: { loadBalancer: { servers: [ { url: "http://$IP:$GP" } ] } }
EOF
chmod -R a+rX "$WORK/traefik"
$DOCKER run -d --name "$TR" --network "$NET" -v "$WORK/traefik:/etc/traefik/dyn:ro" "$TRAEFIK" \
  --entrypoints.websecure.address=:443 --providers.file.directory=/etc/traefik/dyn --log.level=WARN >/dev/null || exit 1
TIP=$($DOCKER inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$TR")
sleep 3

pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >"$WORK/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$WORK/check.out" | sed 's/^/       /'; fi; }
# the browser: curl from the box's container, to Traefik only, with names resolved to Traefik
B() { $DOCKER exec "$BOX" curl -sk --resolve "$BOARD:443:$TIP" --resolve "$AUTH:443:$TIP" "$@"; }
J=/tmp/jar

echo "== through Traefik"
check "no session: Traefik sends the browser to the sign-in page" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -D - -o /dev/null https://$BOARD/api/whoami | grep -qi '^location: https://$AUTH/s?b=$BOARD'"
check "...a client's own X-MM-Assertion and X-Board-User don't get through" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; [ \"\$(B -o /dev/null -w '%{http_code}' -H 'x-mm-assertion: forged.forged' -H 'x-board-user: owner' -H 'x-board-role: owner' https://$BOARD/api/whoami)\" = 302 ]"
CODE=$(B -c $J -b $J "https://$AUTH/s?b=$BOARD&r=/api/whoami" | sed -n 's/.*id="code"[^>]*>\([0-9A-Z-]*\)<.*/\1/p')
check "the sign-in page (through Traefik) shows a code" sh -c "echo '$CODE' | grep -qE '^[0-9A-Z]{4}-[0-9A-Z]{4}$'"
check "mm auth approve --as alice (in the box)" sh -c "$DOCKER exec -u dev $BOX sh -c 'PATH=\$HOME/.mm/bin:\$PATH mm auth approve $CODE --as alice --for acme-shop' >/dev/null"
NEXT=$(B -c $J -b $J "https://$AUTH/s/poll" | sed -n 's/.*"next":"\([^"]*\)".*/\1/p')
check "the page gets a session and the board's callback" sh -c "echo '$NEXT' | grep -q '^https://$BOARD/_mm/auth/callback?c='"
B -c $J -b $J -o /dev/null "$NEXT"
check "the board knows alice, through Traefik and the gateway" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J https://$BOARD/api/whoami | grep -q '\"actor\":\"alice\".*\"source\":\"gateway\"'"
check "alice sees the board's items" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J 'https://$BOARD/api/v0/beads/issues?limit=20' | grep -q 'seen through Traefik'"
check "...and her forged role header changes nothing (Traefik takes the gateway's)" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J -H 'x-board-role: owner' -H 'x-mm-assertion: forged.forged' https://$BOARD/api/whoami | grep -q '\"actor\":\"alice\"'"
check "mm auth revoke alice: the next request goes back to sign-in" sh -c "$DOCKER exec -u dev $BOX sh -c 'PATH=\$HOME/.mm/bin:\$PATH mm auth revoke alice' >/dev/null && $(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; [ \"\$(B -b $J -o /dev/null -w '%{http_code}' https://$BOARD/api/whoami)\" = 302 ]"
echo; echo "$pass passed, $fail failed"
[ -n "$KEEP" ] && echo "kept: $DOCKER exec -it -u dev $BOX bash"
[ "$fail" = 0 ]
