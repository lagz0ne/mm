#!/usr/bin/env bash
# Project box, the network (sy-9il step 0 (c)): a box on a Docker network with `internal: true` gets out only through an
# egress proxy with an allowlist. Throwaway containers and networks only; the host's services and the live Traefik are
# not touched. Proves: the Claude API answers through the proxy; a site off the list is refused by the proxy; without
# the proxy nothing gets out (no route, no DNS); the box can't reach the host's own services.
#   test/box-egress.sh        [--keep]        DOCKER="sudo -n docker" if needed
set -uo pipefail
DOCKER=${DOCKER:-docker}; KEEP=""; [ "${1:-}" = --keep ] && KEEP=1
ID=$$; NET=mm-box-int-$ID; PX=mm-box-proxy-$ID; BOX=mm-box-$ID; IMAGE=${IMAGE:-ubuntu:24.04}
ALLOW=${ALLOW:-api.anthropic.com}
cleanup() { [ -n "$KEEP" ] && return; $DOCKER rm -f "$BOX" "$PX" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >/tmp/box-egress.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/box-egress.out | sed 's/^/       /'; fi; }

echo "== the network and the proxy"
$DOCKER network create --internal "$NET" >/dev/null || exit 1
# the proxy: on the normal bridge (it gets out) and on the box's internal network; only the allowlisted names pass
$DOCKER run -d --name "$PX" "$IMAGE" sleep infinity >/dev/null || exit 1
$DOCKER exec "$PX" sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq tinyproxy >/dev/null' || { echo "proxy setup failed"; exit 1; }
# IPv4 first: the proxy's network has no IPv6 route, and a name with an AAAA record would hang there
$DOCKER exec "$PX" sh -c "echo 'precedence ::ffff:0:0/96 100' >>/etc/gai.conf"
# one anchored, escaped pattern per allowed name (dots literal); a CONNECT names host:443
for h in $ALLOW; do printf '^%s(:443)?$\n' "$h" | sed 's/\./\\./g'; done | $DOCKER exec -i "$PX" sh -c 'cat >/etc/tinyproxy/allow'
$DOCKER exec "$PX" sh -c "cat >/etc/tinyproxy/tinyproxy.conf <<EOF
User tinyproxy
Group tinyproxy
Port 8888
Listen 0.0.0.0
Timeout 60
LogLevel Info
MaxClients 50
Allow 0.0.0.0/0
Filter \"/etc/tinyproxy/allow\"
FilterType ere
FilterDefaultDeny Yes
FilterURLs Off
ConnectPort 443
EOF
tinyproxy -c /etc/tinyproxy/tinyproxy.conf" || { echo "proxy start failed"; exit 1; }
$DOCKER network connect "$NET" "$PX" || exit 1
# the box: on the internal network only
$DOCKER run -d --name "$BOX" --network "$NET" "$IMAGE" sleep infinity >/dev/null || exit 1
# curl in the box comes from the proxy's package cache: the box itself has no way to apt
$DOCKER exec "$PX" sh -c 'rm -f /etc/apt/apt.conf.d/docker-clean; apt-get install -y -qq --download-only --reinstall curl ca-certificates openssl libcurl4t64 >/dev/null 2>&1; ls /var/cache/apt/archives/*.deb' >/dev/null
for f in $($DOCKER exec "$PX" sh -c 'ls /var/cache/apt/archives/*.deb'); do $DOCKER cp "$PX:$f" - | $DOCKER cp - "$BOX:/tmp/" ; done
$DOCKER exec "$BOX" sh -c 'dpkg -i /tmp/*.deb >/dev/null 2>&1; dpkg -i /tmp/*.deb >/dev/null 2>&1; command -v curl && test -s /etc/ssl/certs/ca-certificates.crt' >/dev/null || { echo "curl and CA certificates in the box failed"; exit 1; }
P=http://$PX:8888
HOST_IP=$($DOCKER network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')

echo "== out"
check "through the proxy: the Claude API answers ($ALLOW)" sh -c "$DOCKER exec $BOX curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P https://$ALLOW/v1/models | grep -qE '^[1-5][0-9][0-9]\$' && ! $DOCKER exec $BOX curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P https://$ALLOW/v1/models | grep -qx 000"
check "through the proxy: a site off the list is refused (example.com)" sh -c "! $DOCKER exec $BOX curl -sS -o /dev/null --max-time 20 --proxy $P https://example.com/ 2>/tmp/box-egress.err; grep -qiE '403|refused|tunnel failed' /tmp/box-egress.err"
check "...nor through plain http (github.com)" sh -c "[ \"\$($DOCKER exec $BOX curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P http://github.com/)\" = 403 ]"
check "without the proxy: nothing gets out (by name)" sh -c "! $DOCKER exec $BOX curl -s -o /dev/null --max-time 10 https://$ALLOW/"
check "without the proxy: nothing gets out (by address, 1.1.1.1)" sh -c "! $DOCKER exec $BOX curl -s -o /dev/null --max-time 10 https://1.1.1.1/"
echo "== in: the host"
check "the box can't reach the host's services (docker bridge $HOST_IP: names proxy 1355, VictoriaMetrics 8428)" sh -c "! $DOCKER exec $BOX curl -s -o /dev/null --max-time 5 http://$HOST_IP:1355/ && ! $DOCKER exec $BOX curl -s -o /dev/null --max-time 5 http://$HOST_IP:8428/"
check "...nor through the proxy (it isn't a way back in)" sh -c "[ \"\$($DOCKER exec $BOX curl -s -o /dev/null -w '%{http_code}' --max-time 10 --proxy $P http://$HOST_IP:8428/)\" = 403 ]"
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
