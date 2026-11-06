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
# a fresh box lacks only what a human gives it (inputs): onboard installs everything else, then says so
mm doctor -o json >/tmp/doctor.json 2>/dev/null
jq -e '[.[] | select(.status == "fail")] | length > 0 and all(.layer == "var" or .layer == "secret" or .layer == "account")' /tmp/doctor.json >/dev/null \
  && ok "onboard: only inputs left ($(jq -r '[.[] | select(.status == "fail") | .item] | join(", ")' /tmp/doctor.json))" || { bad "onboard"; tail -20 /tmp/onboard.out; }
echo "     mm $(mm --version)"
# zero side effects (sy-8w1): mm's tools and state under ~/.mm; outside it only the boot unit and the PATH lines
check "nothing of mm's outside ~/.mm (doctor: outside rows all ok)" jq -e '[.[] | select(.layer == "outside" and .status != "ok")] | length == 0' /tmp/doctor.json
check "no ~/.portless, ~/.config/process-compose, ~/.npm, ~/.local/bin/claude, ~/.local/share/claude" \
  sh -c '! test -e ~/.portless && ! test -e ~/.config/process-compose && ! test -e ~/.npm && ! test -e ~/.local/bin/claude && ! test -e ~/.local/share/claude'
check "claude runs from ~/.mm/tools/claude" sh -c 'readlink -f "$(command -v claude)" | grep -q "^$HOME/.mm/tools/claude/" && claude --version'
echo "     outside ~/.mm after onboard: $(cd ~ && find . -path ./.mm -prune -o ! -type d -print | sed 's|^\./||' | sort | tr '\n' ' ')"
sleep 3; check "process manager outlives mm" process-compose -U -u "$HOME/.mm/pc.sock" project state
check "mm needs: exit 1 while a required input is missing" sh -c '! mm needs'
check "fill the required inputs (dummy values, from a pipe)" sh -c 'for n in $(mm needs -o json | jq -r ".[] | select(.required and .status == \"missing\" and .kind == \"secret\") | .name"); do printf "cleanbox-dummy-%s" "$n" | mm fill "$n" || exit 1; done'
check "mm needs exit 0" mm needs
check "doctor exit 0" mm doctor
echo "== new"
check "mm new acme/shop" mm new acme/shop
# a fresh box gets the one-root layout: everything mm manages under ~/.mm, nothing in ~/projects or ~/brain
check "layout one-root (config.yaml)" sh -c 'mm config get layout | grep -qx one-root'
check "project under ~/.mm/projects" test -f ~/.mm/projects/acme/shop/.mm-answers.yaml
check "no ~/projects, no ~/brain" sh -c '! test -e ~/projects && ! test -e ~/brain'
check "the board's engine knows the folders (endpoints.json dirs)" sh -c 'jq -e ".dirs.projects == \"$HOME/.mm/projects\" and .dirs.backups == \"$HOME/.mm/backups\"" ~/.mm/projects/acme/shop/.run/endpoints.json'
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
check "board ready" sh -c 'mm inspect acme/shop | grep -q "board .*Ready"'
check "board answers by name" curl -sf -o /dev/null http://board.acme-shop.localhost:1355/api/whoami
check "the names proxy keeps its state in ~/.mm/portless (no ~/.portless)" sh -c 'test -d ~/.mm/portless && ! test -e ~/.portless'
check "with the board running: no ~/.npm (board build), ~/.portless, ~/.config/process-compose, ~/.local" \
  sh -c '! test -e ~/.npm && ! test -e ~/.portless && ! test -e ~/.config/process-compose && ! test -e ~/.local'
# what is still outside (bd's ~/.beads and ~/.config/bd are a known one, sy-8w1's follow-up; the filled secret is an input's path)
echo "     outside ~/.mm with the board running: $(cd ~ && find . -path ./.mm -prune -o ! -type d -print | sed 's|^\./||' | sed 's|^\(\.beads\)/.*|\1/...|' | sort -u | tr '\n' ' ')"
check "item on the board" sh -c 'cd ~/.mm/projects/acme/shop && bin/bd create "hello from a clean box" --json | grep -q "\"id\""'
check "item through the board API" sh -c 'curl -sf http://board.acme-shop.localhost:1355/api/v0/beads/issues?limit=10 | grep -q "hello from a clean box"'
check "bd stays quiet on a fresh board: no-hooks, metrics off, no hook (sy-8s1)" sh -c 'cd ~/.mm/projects/acme/shop/control && [ "$(../bin/bd config get no-hooks | tail -1)" = true ] && [ "$(../bin/bd config get metrics.disabled | tail -1)" = true ] && mm doctor -o json | jq -e ".[] | select(.item == \"bd quiet acme/shop\") | .status == \"ok\""'
check "update is a no-op" sh -c 'mm update acme/shop | grep -q "already at"'
check "backup lands in ~/.mm/backups" sh -c 'cd ~/.mm/projects/acme/shop && timeout 300 bin/backup >/dev/null 2>&1; ls -d ~/.mm/backups/acme-shop/*/ >/dev/null'
check "logs reach VictoriaLogs" sh -c 'mm obs status | grep -q acme-shop'
echo "== archive"
check "mm archive" mm archive acme/shop
check "project gone" test ! -e ~/.mm/projects/acme/shop
check "tarball in ~/.mm/archive" sh -c 'ls ~/.mm/archive/acme-shop-*.tar.gz >/dev/null' 
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
