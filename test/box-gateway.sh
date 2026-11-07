#!/usr/bin/env bash
# Project box, the way in (sy-9il step 0 (d)): a real Traefik in front of a box's board, with forward-auth to the
# sign-in gateway, as ops' `expose` makes the route. Throwaway containers and network only; the live Traefik is not
# touched. curl is the browser and talks to Traefik only (https, Traefik's default certificate). Proves: no session
# -> the sign-in page; a single-use link from `mm user link` (after `mm grant`) -> the board knows the person; a client's own
# X-MM-Assertion or X-Board-* never gets through; revoke ends it.
#   test/box-gateway.sh --local dist/mm   [--keep]        IMAGE=ubuntu:24.04 TRAEFIK=traefik:v3.6.25 (the defaults)
#   rootless podman by default (test/lib/stock.sh); DOCKER="sudo -n docker" or DOCKER=docker for docker.
set -uo pipefail
. "$(dirname "$0")/lib/stock.sh"
LOCAL=""; KEEP=""; IMAGE=$(stock_image "${IMAGE:-ubuntu:24.04}"); TRAEFIK=$(stock_image "${TRAEFIK:-traefik:v3.6.25}")
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
# a box that lies (review sy-b15.17): registered as mm does it (pc/boxes), its answers and services.yaml its own, but its
# .run/services.json (which a box can write) claims acme-shop's board host for itself
E=$HOME/evil; mkdir -p "$E/.run" ~/.mm/pc/boxes
printf 'client: acme\nname: evil\nproject: acme-evil\nshort: ev\nroot: %s\ntemplate_version: test\ncreated: test\nbox: true\n' "$E" >"$E/.mm-answers.yaml"
printf 'services:\n  board:\n    command: "true"\n    port: http\n    public: { name: board-evil-acme, auth: required }\n' >"$E/services.yaml"
echo '{"project":"acme-evil","services":{"board":{"public_url":"https://board-shop-acme.example.test","public":{"name":"board-shop-acme","auth":"required"}}}}' >"$E/.run/services.json"
echo "# from $E/services.yaml" >~/.mm/pc/boxes/acme-evil.yaml
mm new acme/shop >/tmp/new.out 2>&1 || { tail -20 /tmp/new.out; exit 1; }
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
for _ in $(seq 1 30); do [ -S ~/.mm/run/auth.sock ] && break; sleep 1; done
(cd ~/.mm/projects/acme/shop && bin/bd create "seen through Traefik" --actor qa >/dev/null)
echo "IP=$IP GP=$(mm config get auth_port) BP=$(jq -r .services.board.public_port ~/.mm/projects/acme/shop/.run/services.json)"
EOF
chmod 644 "$WORK"/*.sh

echo "== the box (domain mode, the gateway on, a real project)"
$DOCKER network create "$NET" >/dev/null || exit 1
$DOCKER run -d --name "$BOX" --network "$NET" -v "$WORK:/w:$STOCK_RO" "$IMAGE" sleep infinity >/dev/null || exit 1
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
$DOCKER run -d --name "$TR" --network "$NET" -v "$WORK/traefik:/etc/traefik/dyn:$STOCK_RO" "$TRAEFIK" \
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
check "no session, through Traefik: /_mm/auth/../api/…, %2e%2e and ..%2f never reach the board (review sy-b15.14 3)" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; for u in '/_mm/auth/../api/v0/beads/issues' '/_mm/auth/%2e%2e/api/v0/beads/issues' '/_mm/auth/..%2fapi/v0/beads/issues'; do out=\$(B --path-as-is \"https://$BOARD\$u\"); echo \"\$out\" | grep -q 'seen through Traefik' && exit 1; echo \"\$out\" | grep -q '\"actor\"' && exit 1; done; exit 0"
check "...a client's own X-MM-Assertion and X-Board-User don't get through" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; [ \"\$(B -o /dev/null -w '%{http_code}' -H 'x-mm-assertion: forged.forged' -H 'x-board-user: owner' -H 'x-board-role: owner' https://$BOARD/api/whoami)\" = 302 ]"
MM_IN() { $DOCKER exec -u dev "$BOX" sh -c "export PATH=\$HOME/.mm/bin:\$PATH; $*"; }
check "in the box: mm user add boss --owner; mm user add alice; mm grant alice acme-shop" sh -c "$(declare -f MM_IN); BOX=$BOX DOCKER='$DOCKER'; MM_IN 'mm user add boss --owner && mm user add alice && mm grant alice acme-shop' >/dev/null"
L=$(MM_IN 'mm user link alice -o json' | jq -r .link)
check "mm user link alice: a single-use link on the gateway's host" sh -c "echo '$L' | grep -q '^https://$AUTH/api/auth/magic-link/verify?token='"
# the link opens a Continue page (no session); its button POSTs from the gateway's page (review sy-g8v 2)
B -c $J -b $J -o /dev/null "$L"
LQ=${L#*\?}; LT=$(printf '%s' "$LQ" | tr '&' '\n' | sed -n 's/^token=//p'); LC=$(printf '%s' "$LQ" | tr '&' '\n' | sed -n 's/^callbackURL=//p')
B -c $J -b $J -o /dev/null -H "origin: https://$AUTH" -d "t=$LT&c=$LC" "https://$AUTH/s/l"
check "the link (through Traefik): a session, then the board opens with no new link (callback, the board's cookie)" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -L -c $J -b $J https://$BOARD/api/whoami | grep -q '\"actor\":\"alice\"'"
check "the same link again: no new session" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; ! B -D - -o /dev/null -H 'origin: https://$AUTH' -d 't=$LT&c=$LC' 'https://$AUTH/s/l' | grep -qi 'set-cookie: __Secure-better-auth.session_token'"
check "the board knows alice, through Traefik and the gateway" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J https://$BOARD/api/whoami | grep -q '\"actor\":\"alice\".*\"source\":\"gateway\"'"
check "alice sees the board's items" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J 'https://$BOARD/api/v0/beads/issues?limit=20' | grep -q 'seen through Traefik'"
check "...and her forged role header changes nothing (Traefik takes the gateway's)" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J -H 'x-board-role: owner' -H 'x-mm-assertion: forged.forged' https://$BOARD/api/whoami | grep -q '\"actor\":\"alice\"'"
# the lying box (acme-evil, set up in box.sh): its .run/ claims this board's host; bob is granted acme-evil only
MM_IN 'mm user add bob && mm grant bob acme-evil' >/dev/null
TKB=$(MM_IN 'mm token bob acme-evil -o json' | jq -r .token); LB=$(MM_IN 'mm user link bob -o json' | jq -r .link); J2=/tmp/jar2
B -c $J2 -b $J2 -o /dev/null "$LB"; LBQ=${LB#*\?}
B -c $J2 -b $J2 -o /dev/null -H "origin: https://$AUTH" -d "t=$(printf '%s' "$LBQ" | tr '&' '\n' | sed -n 's/^token=//p')&c=$(printf '%s' "$LBQ" | tr '&' '\n' | sed -n 's/^callbackURL=//p')" "https://$AUTH/s/l"
check "a box's .run/ claims this board's host (review sy-b15.17): its member's bearer token gets 401 here" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; [ \"\$(B -o /dev/null -w '%{http_code}' -H 'authorization: Bearer $TKB' https://$BOARD/api/whoami)\" = 401 ]"
check "...and its member's session never gets into this board (no callback for it)" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; ! B -L -c $J2 -b $J2 https://$BOARD/api/whoami | grep -q '\"actor\":\"bob\"'"
check "...while alice, the board's own member, still gets in" sh -c "$(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; B -b $J https://$BOARD/api/whoami | grep -q '\"actor\":\"alice\"'"
check "mm revoke alice (every project): the next request goes back to sign-in" sh -c "$DOCKER exec -u dev $BOX sh -c 'PATH=\$HOME/.mm/bin:\$PATH mm revoke alice' >/dev/null && $(declare -f B); BOX=$BOX BOARD=$BOARD AUTH=$AUTH TIP=$TIP DOCKER='$DOCKER'; [ \"\$(B -b $J -o /dev/null -w '%{http_code}' https://$BOARD/api/whoami)\" = 302 ]"
echo; echo "$pass passed, $fail failed"
[ -n "$KEEP" ] && echo "kept: $DOCKER exec -it -u dev $BOX bash"
[ "$fail" = 0 ]
