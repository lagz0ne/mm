#!/usr/bin/env bash
# The restore drill (sy-4in), in two throwaway containers against a SYNTHETIC mastermind: no production key, nothing
# T3. Box A: a fresh machine (onboard, mm new, items on the board, a vault with a test recovery key), synced to a bare
# repo inside it. Box B: blank; `mm restore --drill` from that repo with the test key. Then: the board answers with the
# same items, nothing outward-facing started, the hold can't be lifted. Nothing on the host is touched.
#
#   test/restore-drill.sh --local dist/mm      [--image ubuntu:24.04] [--keep]      DOCKER="sudo -n docker" if needed
set -uo pipefail
IMAGE=ubuntu:24.04; LOCAL=""; KEEP=""; DOCKER=${DOCKER:-docker}
while [ $# -gt 0 ]; do case "$1" in
  --local) LOCAL=$(readlink -f "$2"); shift 2 ;; --image) IMAGE=$2; shift 2 ;; --keep) KEEP=1; shift ;;
  *) echo "usage: $0 --local <mm binary> [--image <image>] [--keep]"; exit 2 ;; esac; done
[ -n "$LOCAL" ] || { echo "--local <mm binary> is required (the drill tests a build)"; exit 2; }
A=mm-drill-a-$$; B=mm-drill-b-$$
SHIM=${MM_SHIM_URL:-https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm}
WORK=$(mktemp -d); trap '[ -n "$KEEP" ] || $DOCKER rm -f "$A" "$B" >/dev/null 2>&1; rm -rf -- "$WORK"' EXIT
chmod 755 "$WORK"; cp "$LOCAL" "$WORK/mm"

cat >"$WORK/as-root.sh" <<'EOF'
set -e
if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq git curl ca-certificates sudo >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q git curl sudo >/dev/null; fi
useradd -m -s /bin/bash dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
install -d -o dev -g dev /home/dev/.mm /home/dev/.mm/bin && install -o dev -g dev -m 755 /w/mm /home/dev/.mm/bin/mm
EOF

cat >"$WORK/box-a.sh" <<'EOF'
set -u
export PATH=$HOME/.mm/bin:$PATH
say() { echo "  A: $*"; }
curl -fsSL "$SHIM" | sh -s -- onboard --yes --access tailscale --name oldbox >/tmp/onboard.out 2>&1
for n in $(mm needs -o json | jq -r '.[] | select(.required and .status == "missing" and .kind == "secret") | .name'); do printf 'drill-dummy-%s' "$n" | mm fill "$n" >/dev/null; done
mm new acme/shop >/tmp/new.out 2>&1 || { say "mm new failed"; tail -20 /tmp/new.out; exit 1; }
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
cd ~/.mm/projects/acme/shop
I1=$(bin/bd create "drill item one" --json | jq -r .id); bin/bd create "drill item two" >/dev/null; bin/bd comments add "$I1" "a comment that must come back" >/dev/null
# a project that changed its own tools.json (as a box could): the restore must take mm's pins, not these (sy-b15.17 6)
jq '.bd["linux-x64"].url = "https://tools.evil.invalid/bd.tar.gz" | .bd["linux-x64"].sha256 = "0000000000000000000000000000000000000000000000000000000000000000"' tools.json >tools.json.new && mv tools.json.new tools.json
SETUP_HUMAN=1 git commit -qam "a project's own tools.json (drill: must not be used)" >/dev/null 2>&1
cd ~
age-keygen -o ~/recovery.key 2>/dev/null; mm vault init --recovery "$(age-keygen -y ~/recovery.key)" >/dev/null
git init -q --bare ~/mastermind.git
mm sync --init ~/mastermind.git >/tmp/sync.out 2>&1 && mm sync >>/tmp/sync.out 2>&1 || { say "sync failed"; tail -20 /tmp/sync.out; exit 1; }
(cd ~/.mm/projects/acme/shop/control && ../bin/bd export --all -o /tmp/a.jsonl >/dev/null 2>&1); wc -l </tmp/a.jsonl >~/a.count
git -C ~/mastermind.git rev-parse main >~/a.head
tar -cf /tmp/handoff.tar -C ~ mastermind.git recovery.key a.count a.head
say "synced $(cat ~/a.count) item record(s) at $(cut -c1-12 ~/a.head)"
EOF

cat >"$WORK/box-b.sh" <<'EOF'
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >/tmp/check.out 2>&1; then ok "$d"; else bad "$d"; tail -5 /tmp/check.out | sed 's/^/       /'; fi; }
export PATH=$HOME/.mm/bin:$PATH
tar -xf /w/handoff.tar -C ~
check "blank box: no age, no ~/.mm state" sh -c '! command -v age && ! test -e ~/.mm/config.yaml'
echo "== restore --drill"
if mm restore --drill ~/mastermind.git --identity ~/recovery.key --accept "$(cat ~/a.head)" -o json >/tmp/drill.json 2>/tmp/drill.err; then ok "mm restore --drill exit 0"
else bad "mm restore --drill"; jq -r '.[] | select(.status=="fail") | "       \(.step): \(.detail)"' /tmp/drill.json 2>/dev/null; tail -5 /tmp/drill.err
  process-compose -U -u ~/.mm/pc.sock process list 2>/dev/null | sed 's/^/       /'
  for f in ~/.mm/projects/acme/shop/.run/logs/*.log; do echo "       --- $f"; tail -8 "$f" | sed 's/^/       /'; done; fi
jq -r '.[] | "     \(.status) \(.step): \(.detail[0:150])"' /tmp/drill.json 2>/dev/null
check "age came from the distro's signed packages" sh -c 'command -v age && jq -e ".[] | select(.step==\"age\") | .status==\"ok\"" /tmp/drill.json'
check "the same items on the board (report)" sh -c "jq -e '.[] | select(.step==\"acme-shop: items\") | .status==\"ok\" and (.detail | startswith(\"$(cat ~/a.count | tr -d ' ') of the backup\"))' /tmp/drill.json"
check "board answers by name" curl -sf -o /dev/null http://board.acme-shop.localhost:1355/api/whoami
check "the project's own tools.json came back changed, and mm's pinned bd was installed instead (sy-b15.17 6)" sh -c 'grep -q tools.evil.invalid ~/.mm/projects/acme/shop/tools.json && ~/.mm/projects/acme/shop/tools/bd version >/dev/null'
check "the items and the comment through the board API" sh -c 'curl -sf "http://board.acme-shop.localhost:1355/api/v0/beads/issues?limit=50" | grep -q "drill item one" && cd ~/.mm/projects/acme/shop/control && ../bin/bd comments "$(../bin/bd list --json | jq -r ".[] | select(.title==\"drill item one\") | .id")" | grep -q "must come back"'
check "held back: wake (leads) not started, reported" sh -c '! process-compose -U -u ~/.mm/pc.sock process list -o json | jq -e ".[] | select(.name==\"acme-shop.wake\")" && jq -e "[.[] | select(.step==\"acme-shop: held\") | .detail | test(\"wake\")] | any" /tmp/drill.json'
check "no public route or forwarder" sh -c '! process-compose -U -u ~/.mm/pc.sock process list -o json | jq -e ".[] | select(.name | endswith(\"-public\"))"'
check "the hold is on, as a drill" sh -c 'mm config get restore.hold | grep -qx true && mm config get restore.drill | grep -qx true'
check "mm sync refuses here" sh -c 'mm sync 2>&1 | grep -q "restore on hold"'
check "a drill box can't be released" sh -c 'printf "the old box is down\n" | script -qec "mm restore --release" /dev/null | grep -q "never goes outward"'
check "a new machine key; the recovery key still opens the vault" sh -c 'test -s ~/.mm/vault/key && mm vault check'
check "the staged board data and the work folder are gone" sh -c '! test -e ~/.mm/projects/acme/shop/.restore && ! ls -d ~/.mm/state/restore-work-* 2>/dev/null'
check "the report states the teardown (sy-4in 2)" sh -c 'jq -e ".[] | select(.step==\"teardown\") | .status==\"ok\" and (.detail | test(\"unsealed copies removed: yes\"))" /tmp/drill.json'
check "the identity was not copied onto the box" sh -c '! grep -rqF "$(grep -v "^#" ~/recovery.key)" ~/.mm'
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
EOF
chmod 644 "$WORK"/*.sh

echo "== $IMAGE (local build): box A"
for c in "$A" "$B"; do $DOCKER run -d --name "$c" -v "$WORK:/w:ro" "$IMAGE" sleep infinity >/dev/null || exit 1; $DOCKER exec "$c" sh /w/as-root.sh || { echo "container setup failed"; exit 1; }; done
$DOCKER exec -u dev -e SHIM="$SHIM" -w /home/dev "$A" bash /w/box-a.sh || { echo "box A failed"; exit 1; }
$DOCKER cp "$A:/tmp/handoff.tar" "$WORK/handoff.tar" >/dev/null && chmod 644 "$WORK/handoff.tar"
$DOCKER rm -f "$A" >/dev/null   # the old box is gone: B has only mastermind and the recovery key
echo "== box B (blank): the drill"
$DOCKER exec -u dev -w /home/dev "$B" bash /w/box-b.sh; rc=$?
[ -n "$KEEP" ] && echo "kept: $DOCKER exec -it -u dev $B bash"
exit $rc
