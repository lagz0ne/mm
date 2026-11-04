#!/usr/bin/env bash
# Clean-box test in a throwaway container: a fresh distro with only git, curl and a sudo user, then exactly what the
# README says: the curl install line, mm onboard, mm new. Then the project's life: board up, an item, update,
# archive. Nothing on the host is touched except the container.
#
#   test/clean-box.sh                      the published release (latest), via the shim from main
#   test/clean-box.sh --local dist/mm      a local build instead (the shim keeps an existing binary)
#   options: --image ubuntu:24.04 (default) | debian:12 | ...   --keep (leave the container for docker exec)
#   DOCKER="sudo -n docker" if docker needs sudo here.
set -uo pipefail
IMAGE=ubuntu:24.04; LOCAL=""; KEEP=""; DOCKER=${DOCKER:-docker}
while [ $# -gt 0 ]; do case "$1" in
  --local) LOCAL=$(readlink -f "$2"); shift 2 ;; --image) IMAGE=$2; shift 2 ;; --keep) KEEP=1; shift ;;
  *) echo "usage: $0 [--local <mm binary>] [--image <image>] [--keep]"; exit 2 ;; esac; done
NAME=mm-cleanbox-$$
SHIM=${MM_SHIM_URL:-https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm}
WORK=$(mktemp -d); trap 'rm -rf "$WORK"; [ -n "$KEEP" ] || $DOCKER rm -f "$NAME" >/dev/null 2>&1' EXIT
chmod 755 "$WORK"
[ -n "$LOCAL" ] && cp "$LOCAL" "$WORK/mm"

cat >"$WORK/as-root.sh" <<'EOF'
set -e
if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq git curl ca-certificates sudo >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q git curl sudo >/dev/null; fi
useradd -m -s /bin/bash dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
if [ -f /w/mm ]; then install -d -o dev -g dev /home/dev/.mm /home/dev/.mm/bin && install -o dev -g dev -m 755 /w/mm /home/dev/.mm/bin/mm; fi
EOF

cat >"$WORK/as-dev.sh" <<'EOF'
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >/tmp/check.out 2>&1; then ok "$d"; else bad "$d"; tail -5 /tmp/check.out | sed 's/^/       /'; fi; }
export PATH=$HOME/.mm/bin:$PATH
echo "== install line + onboard"
curl -fsSL "$SHIM" | sh -s -- onboard --yes --access tailscale --name cleanbox >/tmp/onboard.out 2>&1
grep -q "0 failing" /tmp/onboard.out && ok "onboard: doctor 0 failing" || { bad "onboard"; tail -20 /tmp/onboard.out; }
echo "     mm $(mm --version)"
sleep 3; check "process manager outlives mm" process-compose -U -u "$HOME/.mm/pc.sock" project state
check "doctor exit 0" mm doctor
echo "== new"
check "mm new acme/shop" mm new acme/shop
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
check "board ready" sh -c 'mm inspect acme/shop | grep -q "board .*Ready"'
check "board answers by name" curl -sf -o /dev/null http://board.acme-shop.localhost:1355/api/whoami
check "item on the board" sh -c 'cd ~/projects/acme/shop && bin/bd create "hello from a clean box" --json | grep -q "\"id\""'
check "item through the board API" sh -c 'curl -sf http://board.acme-shop.localhost:1355/api/v0/beads/issues?limit=10 | grep -q "hello from a clean box"'
check "update is a no-op" sh -c 'mm update acme/shop | grep -q "already at"'
check "logs reach VictoriaLogs" sh -c 'mm obs status | grep -q acme-shop'
echo "== archive"
check "mm archive" mm archive acme/shop
check "project gone" test ! -e ~/projects/acme/shop
check "no processes left" sh -c '! grep -lsa "acme/sho[p]" /proc/[0-9]*/cmdline'
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
EOF

chmod 644 "$WORK"/*.sh
echo "== $IMAGE${LOCAL:+ (local build)}"
$DOCKER run -d --name "$NAME" -v "$WORK:/w:ro" "$IMAGE" sleep infinity >/dev/null || exit 1
$DOCKER exec "$NAME" sh /w/as-root.sh || { echo "container setup failed"; exit 1; }
$DOCKER exec -u dev -e SHIM="$SHIM" -w /home/dev "$NAME" bash /w/as-dev.sh; rc=$?
[ -n "$KEEP" ] && echo "kept: $DOCKER exec -it -u dev $NAME bash"
exit $rc
