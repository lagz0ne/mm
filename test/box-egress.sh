#!/usr/bin/env bash
# Project box, the network (sy-9il step 0 (c); sy-59m8): a box on a Docker network with `internal: true` gets out only
# through its egress proxy, the image this repo builds (box/egress.Dockerfile, mm-egress), run the way mm runs it
# (src/box.ts: read-only, started as its own uid (190000 + n, no account, never root) with the owner's group and no
# capabilities at all (sy-58fo), the log appended to a host file, the AI forwarder to a stand-in socket on the host).
# Throwaway image, containers, networks and folders only; the host's services and the live Traefik are not touched.
# Proves: an allowed site works; a site off the list, plain http and port 80 are refused; an allowed name that
# resolves to loopback, a private address, the metadata address, a docker bridge, or a network mm names is refused
# and logged with the name and the address, also when the name changes after it was allowed (rebinding); without the
# proxy nothing gets out (no route, no DNS); the box can't reach the host's services. With egress mode open (sy-cpyo:
# the allow file one any-host pattern) a public site off the list works, and the host, private, metadata, loopback
# and docker addresses, port 80 and plain http are still refused; the list again refuses it again.
# Through mm's Docker wrapper only (sy-e6t3; test/lib/docker.sh: the installed one, MM_DOCKER_BIN for this checkout's
# copy), shaped as mm runs them: mm's names and labels, the project's own network (10.231.<n>.0/24), its own uids, the
# folders in the tests' area. The box is an image built here with curl (BOX_IMAGE=<mm-box:tag> to skip that build).
#   test/box-egress.sh        [--keep]        EGRESS_IMAGE=<mm-egress:tag> to skip the proxy's build
set -uo pipefail
KEEP=""; [ "${1:-}" = --keep ] && KEEP=1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/test/lib/docker.sh"
D() { $DOCKER "$@"; }
ID=$$; BASE=${BASE:-ubuntu:24.04}
TMP=$(mm_test_dir egress); PROJ=$(basename "$TMP"); NET=mm-net-$PROJ; PX=mm-egress-$PROJ; BOX=mm-box-$PROJ
ALLOW=${ALLOW:-github.com}
LOGD=$TMP/log; ELOG=$LOGD/egress.log; AID=$TMP/ai; AIPID=""
BUILT=""; IMG=${EGRESS_IMAGE:-}; BOXIMG=${BOX_IMAGE:-}
cleanup() {
  [ -n "$AIPID" ] && kill "$AIPID" 2>/dev/null
  [ -n "$KEEP" ] && { echo "kept: $BOX $PX $NET $BUILT $TMP"; return; }
  D rm -f "$BOX" "$PX" >/dev/null 2>&1; D network rm "$NET" >/dev/null 2>&1
  [ -n "$BUILT" ] && D rmi -f $BUILT >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >"$TMP/out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$TMP/out" | sed 's/^/       /'; fi; }

echo "== the images (through $DOCKER)"
# folders as mm-docker builds them (mm-box-build-*: the owner's, copied as checked)
if [ -z "$IMG" ]; then
  IMG=mm-egress:test-$ID; EB="$TMP/mm-box-build-eg$ID"; mkdir -p "$EB"; chmod 700 "$EB"
  cp -r "$ROOT/box/egress" "$EB/egress"; cp "$ROOT/box/egress.Dockerfile" "$EB/Dockerfile"
  D build -q -t "$IMG" -f "$EB/Dockerfile" "$EB" >/dev/null || { echo "image build failed"; exit 1; }
  BUILT="$BUILT $IMG"
fi
if [ -z "$BOXIMG" ]; then
  # the box: curl and the CA certificates (the box itself has no way to apt; the build does)
  BOXIMG=mm-box:egtest-$ID; BB="$TMP/mm-box-build-box$ID"; mkdir -p "$BB"; chmod 700 "$BB"
  printf 'FROM %s\nRUN export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*\n' "$BASE" >"$BB/Dockerfile"
  D build -q -t "$BOXIMG" -f "$BB/Dockerfile" "$BB" >/dev/null || { echo "box image build failed"; exit 1; }
  BUILT="$BUILT $BOXIMG"
fi
echo "  $IMG $BOXIMG"

echo "== the network, the proxy, the box"
PUB=$(getent ahostsv4 "$ALLOW" | awk 'NR==1{print $1}')
[ -n "$PUB" ] || { echo "can't resolve $ALLOW"; exit 1; }
for n in $(seq 249 -1 10); do
  if D network create --internal --subnet "10.231.$n.0/24" --gateway "10.231.$n.1" --label "mm.project=$PROJ" "$NET" >/dev/null 2>"$TMP/err"; then break; fi
  grep -qiE 'overlap|in use' "$TMP/err" || { cat "$TMP/err"; exit 1; }
done
SUBNET=$(D network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$NET")
HOST_IP=$(D network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
EUID_PX=$((190000 + n)); BUID=$((200000 + n)) # the proxy's and the box's own uids, as mm gives them: no account here
for u in $EUID_PX $BUID; do getent passwd "$u" >/dev/null && { echo "uid $u is an account here"; exit 1; }; done
# the allow list as mm writes it (src/box.ts allowPatterns): one anchored, escaped pattern per name. The test names
# point where an attacker's DNS would: a hosts file the proxy's resolver reads before DNS, mounted read-only from
# here, so the test can move a name later (rebinding) the way a DNS answer would change.
NAMES="$ALLOW loop.mm-test ten.mm-test meta.mm-test bridge.mm-test pooled.mm-test rebind.mm-test"
mkdir -p "$LOGD"; chmod 0770 "$LOGD"; : >"$ELOG"; chmod 0660 "$ELOG"
for h in $NAMES; do printf '^%s(:443)?$\n' "$(printf %s "$h" | sed 's/\./\\./g')"; done >"$TMP/allow"; chmod 0644 "$TMP/allow"
hosts() { printf '%s\n' '127.0.0.1 localhost' '::1 localhost' '127.0.0.1 loop.mm-test' '10.20.30.40 ten.mm-test' \
  '169.254.169.254 meta.mm-test' "$HOST_IP bridge.mm-test" '203.0.114.7 pooled.mm-test' "$1 rebind.mm-test"; }
hosts "$PUB" >"$TMP/hosts"; chmod 0644 "$TMP/hosts"
# the box's own socket of mm's AI gateway, as mm makes it (src/box.ts: its folder 0750, the socket 0660, the owner's
# group): a stand-in here that answers one HTTP line
mkdir -p "$AID"; chmod 0750 "$AID"
/usr/bin/python3 -I -c 'import os, socket, sys
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1], 0o660); s.listen(8)
while True:
    c, _ = s.accept(); c.recv(4096); c.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nai-ok"); c.close()' "$AID/ai.sock" &
AIPID=$!
for i in $(seq 1 20); do [ -S "$AID/ai.sock" ] && break; sleep 0.2; done
# 203.0.114.0/24 stands for a docker network on public addresses: mm passes every docker subnet (MM_EGRESS_DENY)
D run -d --name "$PX" --label "mm.project=$PROJ" --init --read-only --tmpfs /run:size=8m --user "$EUID_PX:$(id -g)" --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 256m \
  -e "MM_EGRESS_DENY=203.0.114.0/24,$SUBNET" \
  -v "$TMP/hosts:/etc/hosts:ro" -v "$TMP/allow:/etc/mm/allow:ro" -v "$AID:/run/mm/ai" -v "$LOGD:/run/mm/log" "$IMG" \
  sh -c 'while :; do socat TCP-LISTEN:4000,fork,reuseaddr UNIX-CONNECT:/run/mm/ai/ai.sock 2>/dev/null; sleep 1; done & exec /usr/local/bin/mm-egress >>/run/mm/log/egress.log 2>&1' >/dev/null || { echo "proxy start failed"; exit 1; }
D network connect "$NET" "$PX" || exit 1
D run -d --name "$BOX" --label "mm.project=$PROJ" --network "$NET" --user "$BUID:$(id -g)" --cap-drop ALL "$BOXIMG" sleep infinity >/dev/null || exit 1
D exec "$BOX" sh -c 'command -v curl && test -s /etc/ssl/certs/ca-certificates.crt' >/dev/null || { echo "curl and CA certificates in the box failed"; exit 1; }
P=http://$PX:8888
IN() { $DOCKER exec "$BOX" sh -c "$1"; }
# the proxy's answer to a CONNECT: curl prints it (and fails) when the tunnel is refused
code() { IN "curl -s -o /dev/null -w '%{http_connect}' --max-time 20 --proxy $P https://$1/" 2>/dev/null; }
logged() { grep -F "$1" "$ELOG" | grep -qF "$2"; }
for i in $(seq 1 20); do grep -q ' start ' "$ELOG" && break; sleep 0.5; done

echo "== the proxy"
# the proxy process's status: the one whose command is the proxy itself (not the init or the shell that started it)
# the proxy's processes, read on the host from the container's cgroup (mm-docker never execs into an egress proxy)
pxpids() { local pid cg; pid=$(D inspect -f '{{.State.Pid}}' "$PX"); cg=$(sed -n 's/^0:://p' "/proc/$pid/cgroup"); cat "/sys/fs/cgroup$cg/cgroup.procs"; }
pxstatus() { for p in $(pxpids); do [ "$(cat "/proc/$p/comm" 2>/dev/null)" = mm-egress ] && cat "/proc/$p/status"; done; }
check "it runs as its own uid ($EUID_PX, not root), with no capabilities" eval "s=\$(pxstatus); echo \"\$s\" | grep -E '^(Uid|CapEff)'; echo \"\$s\" | grep -qE '^Uid:[[:space:]]+$EUID_PX[[:space:]]+$EUID_PX[[:space:]]+$EUID_PX[[:space:]]+$EUID_PX\$' && echo \"\$s\" | grep -qE '^CapEff:[[:space:]]+0+\$'"
# every process in it (the init, the shell, socat, the proxy): its uid from the start (no root step), no capabilities
allstatus() { for p in $(pxpids); do [ -r "/proc/$p/status" ] && grep -E "^(Uid|CapPrm|CapEff|CapBnd):" "/proc/$p/status" | tr -s "\t\n" "  " && echo; done; }
check "every process in it starts as $EUID_PX, with all capabilities 0" eval "a=\$(allstatus); echo \"\$a\"; [ \$(echo \"\$a\" | grep -c .) -ge 4 ] && ! echo \"\$a\" | grep . | grep -vE '^Uid: $EUID_PX $EUID_PX $EUID_PX $EUID_PX CapPrm: 0+ CapEff: 0+ CapBnd: 0+ \$'"
check "the AI forwarder (its uid, the owner's group) reaches the box's socket on the host" eval "[ \"\$(IN \"curl -s --noproxy '*' --max-time 10 http://$PX:4000/\")\" = ai-ok ]"
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
echo "== egress mode open (sy-cpyo): the allow file is one any-host pattern; the proxy's own checks still refuse what is inside"
# as src/box.ts writeAllow writes it with egress.open.<project> set (src/egressopen.ts ANY_HOST; test/box-slot.sh checks
# mm writes exactly this), in place (the mount keeps the file), then the proxy restarted as mm.api's egressReload does
cp "$TMP/allow" "$TMP/allow.list"; printf '%s\n' '^[^/]+(:443)?$' >"$TMP/allow.new"; cat "$TMP/allow.new" >"$TMP/allow"
D restart -t 2 "$PX" >/dev/null; for i in $(seq 1 20); do [ "$(grep -c ' start ' "$ELOG")" -ge 2 ] && break; sleep 0.5; done
check "a public site off the list works now (example.com), and is logged as allowed" eval "c=\$($DOCKER exec $BOX curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P https://example.com/); echo \$c; [ \"\$c\" -ge 200 ] && [ \"\$c\" -lt 400 ] && grep -E ' allowed .*name=example.com port=443 address=' '$ELOG'"
check "...a private address by name (10.20.30.40): still refused" eval "[ \"\$(code ten.mm-test)\" = 403 ]"
check "...the metadata address, by name and as a literal (169.254.169.254): still refused" eval "[ \"\$(code meta.mm-test)\" = 403 ] && [ \"\$(code 169.254.169.254)\" = 403 ]"
check "...the host (the docker bridge $HOST_IP), by name and as a literal: still refused" eval "[ \"\$(code bridge.mm-test)\" = 403 ] && [ \"\$(code $HOST_IP)\" = 403 ]"
check "...loopback, a docker network mm names, the box's own network: still refused" eval "[ \"\$(code loop.mm-test)\" = 403 ] && [ \"\$(code pooled.mm-test)\" = 403 ] && [ \"\$(code ${SUBNET%.0/*}.1)\" = 403 ]"
check "...port 80 and plain http: still refused" eval "[ \"\$(IN \"curl -s -o /dev/null -w '%{http_connect}' -p --max-time 20 --proxy $P http://example.com:80/\")\" = 403 ] && [ \"\$(IN \"curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy $P http://example.com/\")\" = 403 ]"
cat "$TMP/allow.list" >"$TMP/allow"; D restart -t 2 "$PX" >/dev/null; for i in $(seq 1 20); do [ "$(grep -c ' start ' "$ELOG")" -ge 3 ] && break; sleep 0.5; done
check "the mode off (the list again, the proxy restarted): example.com is refused again" eval "[ \"\$(code example.com)\" = 403 ]"
echo "== the log"
check "one line per decision, every refusal with a reason" eval "n=\$(grep -c ' refused ' '$ELOG'); echo \$n refusals; [ \"\$n\" -ge 10 ] && ! grep ' refused ' '$ELOG' | grep -vq ' why='"
{ [ -n "$KEEP" ] || [ "$fail" != 0 ] || [ -n "${SHOW_LOG:-}" ]; } && { echo "== the egress log"; cat "$ELOG"; }
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
