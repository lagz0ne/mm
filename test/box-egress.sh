#!/usr/bin/env bash
# Project box, the network (sy-9il step 0 (c); sy-59m8): a box on a Docker network with `internal: true` gets out only
# through its egress proxy, the image this repo builds (box/egress.Dockerfile, mm-egress), run the way mm runs it
# (src/box.ts: read-only, no capabilities but the two setpriv needs, its own user, the log appended to a host file).
# Throwaway image, containers, networks and folders only; the host's services and the live Traefik are not touched.
# Proves: an allowed site works; a site off the list, plain http and port 80 are refused; an allowed name that
# resolves to loopback, a private address, the metadata address, a docker bridge, or a network mm names is refused
# and logged with the name and the address, also when the name changes after it was allowed (rebinding); without the
# proxy nothing gets out (no route, no DNS); the box can't reach the host's services.
#   test/box-egress.sh        [--keep]        DOCKER="sudo -n docker" if needed; EGRESS_IMAGE=<tag> to skip the build
set -uo pipefail
DOCKER=${DOCKER:-docker}; KEEP=""; [ "${1:-}" = --keep ] && KEEP=1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ID=$$; NET=mm-box-int-$ID; PX=mm-box-proxy-$ID; BOX=mm-box-$ID; FETCH=mm-box-fetch-$ID; BASE=${BASE:-ubuntu:24.04}
ALLOW=${ALLOW:-github.com}
TMP=$(mktemp -d); LOGD=$TMP/log; ELOG=$LOGD/egress.log
BUILT=""; IMG=${EGRESS_IMAGE:-}
cleanup() {
  [ -n "$KEEP" ] && { echo "kept: $BOX $PX $FETCH $NET ${BUILT:+$IMG} $TMP"; return; }
  $DOCKER rm -f "$BOX" "$PX" "$FETCH" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1
  [ -n "$BUILT" ] && $DOCKER rmi -f "$IMG" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >"$TMP/out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$TMP/out" | sed 's/^/       /'; fi; }

echo "== the proxy image"
if [ -z "$IMG" ]; then
  IMG=mm-egress-test:$ID
  $DOCKER build -q -t "$IMG" -f "$ROOT/box/egress.Dockerfile" "$ROOT/box" >/dev/null || { echo "image build failed"; exit 1; }
  BUILT=1
fi
echo "  $IMG"

echo "== the network, the proxy, the box"
# a helper on the normal bridge: the box's curl (the box itself has no way to apt), and an address of the allowed site
$DOCKER run -d --name "$FETCH" "$BASE" sleep infinity >/dev/null || exit 1
$DOCKER exec "$FETCH" sh -c 'export DEBIAN_FRONTEND=noninteractive; rm -f /etc/apt/apt.conf.d/docker-clean; apt-get update -qq >/dev/null && apt-get install -y -qq --download-only curl ca-certificates openssl libcurl4t64 >/dev/null 2>&1; ls /var/cache/apt/archives/*.deb' >/dev/null || { echo "fetch failed"; exit 1; }
PUB=$($DOCKER exec "$FETCH" getent ahostsv4 "$ALLOW" | awk 'NR==1{print $1}')
[ -n "$PUB" ] || { echo "can't resolve $ALLOW"; exit 1; }
$DOCKER network create --internal "$NET" >/dev/null || exit 1
SUBNET=$($DOCKER network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$NET")
HOST_IP=$($DOCKER network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
# the allow list as mm writes it (src/box.ts allowPatterns): one anchored, escaped pattern per name. The test names
# point where an attacker's DNS would: a hosts file the proxy's resolver reads before DNS, mounted read-only from
# here, so the test can move a name later (rebinding) the way a DNS answer would change.
NAMES="$ALLOW loop.mm-test ten.mm-test meta.mm-test bridge.mm-test pooled.mm-test rebind.mm-test"
mkdir -p "$LOGD"; chmod 0770 "$LOGD"; : >"$ELOG"; chmod 0660 "$ELOG"
for h in $NAMES; do printf '^%s(:443)?$\n' "$(printf %s "$h" | sed 's/\./\\./g')"; done >"$TMP/allow"; chmod 0644 "$TMP/allow"
hosts() { printf '%s\n' '127.0.0.1 localhost' '::1 localhost' '127.0.0.1 loop.mm-test' '10.20.30.40 ten.mm-test' \
  '169.254.169.254 meta.mm-test' "$HOST_IP bridge.mm-test" '203.0.114.7 pooled.mm-test' "$1 rebind.mm-test"; }
hosts "$PUB" >"$TMP/hosts"; chmod 0644 "$TMP/hosts"
# 203.0.114.0/24 stands for a docker network on public addresses: mm passes every docker subnet (MM_EGRESS_DENY)
$DOCKER run -d --name "$PX" --init --read-only --tmpfs /run:size=8m --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges --pids-limit 256 --memory 256m --group-add "$(id -g)" \
  -e "MM_EGRESS_DENY=203.0.114.0/24,$SUBNET" \
  -v "$TMP/hosts:/etc/hosts:ro" -v "$TMP/allow:/etc/mm/allow:ro" -v "$LOGD:/run/mm/log" "$IMG" \
  sh -c 'exec setpriv --reuid=egress --regid=egress --clear-groups /usr/local/bin/mm-egress >>/run/mm/log/egress.log 2>&1' >/dev/null || { echo "proxy start failed"; exit 1; }
$DOCKER network connect "$NET" "$PX" || exit 1
$DOCKER run -d --name "$BOX" --network "$NET" "$BASE" sleep infinity >/dev/null || exit 1
for f in $($DOCKER exec "$FETCH" sh -c 'ls /var/cache/apt/archives/*.deb'); do $DOCKER cp "$FETCH:$f" - | $DOCKER cp - "$BOX:/tmp/"; done
$DOCKER exec "$BOX" sh -c 'dpkg -i /tmp/*.deb >/dev/null 2>&1; dpkg -i /tmp/*.deb >/dev/null 2>&1; command -v curl && test -s /etc/ssl/certs/ca-certificates.crt' >/dev/null || { echo "curl and CA certificates in the box failed"; exit 1; }
P=http://$PX:8888
IN() { $DOCKER exec "$BOX" sh -c "$1"; }
# the proxy's answer to a CONNECT: curl prints it (and fails) when the tunnel is refused
code() { IN "curl -s -o /dev/null -w '%{http_connect}' --max-time 20 --proxy $P https://$1/" 2>/dev/null; }
logged() { grep -F "$1" "$ELOG" | grep -qF "$2"; }
for i in $(seq 1 20); do grep -q ' start ' "$ELOG" && break; sleep 0.5; done

echo "== the proxy"
# the proxy process's status: the one whose command is the proxy itself (not the init or the shell that started it)
pxstatus() { $DOCKER exec "$PX" sh -c 'for p in /proc/[0-9]*; do case "$(tr "\0" " " <$p/cmdline 2>/dev/null)" in /usr/local/bin/mm-egress*) cat $p/status;; esac; done'; }
check "it runs as its own user (not root), with no capabilities" eval "s=\$(pxstatus); echo \"\$s\" | grep -E '^(Uid|CapEff)'; echo \"\$s\" | grep -qE '^Uid:[[:space:]]+[1-9][0-9]*[[:space:]]' && echo \"\$s\" | grep -qE '^CapEff:[[:space:]]+0+\$'"
echo "== out"
check "through the proxy: a site on the list works ($ALLOW)" eval "c=\$($DOCKER exec $BOX curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P https://$ALLOW/); echo \$c; [ \"\$c\" -ge 200 ] && [ \"\$c\" -lt 400 ]"
check "...and it is logged: allowed, with the name and the address" eval "grep -E ' allowed .*name=$ALLOW port=443 address=' '$ELOG'"
check "a site off the list is refused (example.com), and logged" eval "[ \"\$(code example.com)\" = 403 ] && logged 'name=example.com' 'not on this project'"
check "plain http is refused (http://$ALLOW/), and logged" eval "[ \"\$(IN \"curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P http://$ALLOW/\")\" = 403 ] && logged 'name=$ALLOW' 'not GET'"
check "a tunnel to port 80 is refused ($ALLOW:80), and logged" eval "[ \"\$(IN \"curl -s -o /dev/null -w '%{http_connect}' -p --max-time 20 --proxy $P http://$ALLOW:80/\")\" = 403 ] && logged 'name=$ALLOW port=80' 'only port 443'"
echo "== an allowed name that resolves to a place inside"
check "loopback (127.0.0.1): refused, logged with the name and the address" eval "[ \"\$(code loop.mm-test)\" = 403 ] && logged 'name=loop.mm-test' 'address=127.0.0.1 why='"
check "a private address (10.20.30.40): refused, logged" eval "[ \"\$(code ten.mm-test)\" = 403 ] && logged 'name=ten.mm-test' 'address=10.20.30.40 why='"
check "the metadata address (169.254.169.254): refused, logged" eval "[ \"\$(code meta.mm-test)\" = 403 ] && logged 'name=meta.mm-test' 'address=169.254.169.254 why='"
check "the docker bridge ($HOST_IP, the host): refused, logged" eval "[ \"\$(code bridge.mm-test)\" = 403 ] && logged 'name=bridge.mm-test' 'address=$HOST_IP why='"
check "a docker network mm names (MM_EGRESS_DENY, 203.0.114.7): refused, logged" eval "[ \"\$(code pooled.mm-test)\" = 403 ] && logged 'name=pooled.mm-test' 'address=203.0.114.7 why=\"the name resolves to a docker or local network'"
check "an address literal on the box's own network, by IP (not a name on the list): refused" eval "[ \"\$(code ${SUBNET%.0/*}.1)\" = 403 ]"
echo "== rebinding: the name moves to 127.0.0.1 after it was allowed"
check "first: rebind.mm-test at $PUB, the tunnel opens (allowed, logged)" eval "IN \"curl -s -o /dev/null --max-time 20 --proxy $P -k https://rebind.mm-test/\"; logged 'name=rebind.mm-test' 'address=$PUB'"
hosts 127.0.0.1 >"$TMP/hosts.new"; cat "$TMP/hosts.new" >"$TMP/hosts" # in place: the mount keeps the same file
sleep 6 # the resolver's view of the hosts file is up to 5 s old
check "then: rebind.mm-test at 127.0.0.1 is refused, logged with the new address" eval "[ \"\$(code rebind.mm-test)\" = 403 ] && logged 'name=rebind.mm-test' 'address=127.0.0.1 why='"
echo "== no other way out"
check "without the proxy: nothing gets out (by name)" eval "! IN 'curl -s -o /dev/null --max-time 10 https://$ALLOW/'"
check "without the proxy: nothing gets out (by address, 1.1.1.1)" eval "! IN 'curl -s -o /dev/null --max-time 10 https://1.1.1.1/'"
echo "== in: the host"
check "the box can't reach the host's services (docker bridge $HOST_IP: names proxy 1355, VictoriaMetrics 8428)" eval "! IN 'curl -s -o /dev/null --max-time 5 http://$HOST_IP:1355/' && ! IN 'curl -s -o /dev/null --max-time 5 http://$HOST_IP:8428/'"
check "...nor through the proxy (it isn't a way back in)" eval "[ \"\$(IN \"curl -s -o /dev/null -w '%{http_code}' --max-time 10 --proxy $P http://$HOST_IP:8428/\")\" = 403 ]"
echo "== the log"
check "one line per decision, every refusal with a reason" eval "n=\$(grep -c ' refused ' '$ELOG'); echo \$n refusals; [ \"\$n\" -ge 10 ] && ! grep ' refused ' '$ELOG' | grep -vq ' why='"
{ [ -n "$KEEP" ] || [ "$fail" != 0 ] || [ -n "${SHOW_LOG:-}" ]; } && { echo "== the egress log"; cat "$ELOG"; }
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
