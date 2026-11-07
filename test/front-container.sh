#!/usr/bin/env bash
# test/front.sh in a throwaway container (sockets first, sy-onx), through mm's Docker wrapper only (test/lib/docker.sh):
# this checkout's copy in the tests' area, the box image (it has bun, node, curl and jq), on a throwaway internal
# network, as a box uid, read-only root, no capabilities. There the front's listeners are checked in a network with an
# address other than loopback (the container's own on its network: nothing answers there), and front.enabled on and
# off runs against this build. Removed at the end: the container, the network, the copy. Nothing of the machine's mm.
#   test/front-container.sh                  the installed wrapper
#   MM_FRONT_IMAGE=<image> test/front-container.sh     another image with bun, node, curl, jq, bash
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
. "$HERE/test/lib/docker.sh"
W=$DOCKER
IMG=${MM_FRONT_IMAGE:-$($W images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^mm-box:' | grep -v '<none>' | sort -V | tail -1)}
[ -n "$IMG" ] || { echo "no mm-box image here (mm box build), and no MM_FRONT_IMAGE"; exit 2; }
T=$(mm_test_dir front); P=$(basename "$T"); NET="mm-net-$P"; BOX="mm-box-$P"; G=$(id -g)
cleanup() { $W rm -f "$BOX" >/dev/null 2>&1; $W network rm "$NET" >/dev/null 2>&1
  [ -n "${BUID:-}" ] && $W run --rm --name "$BOX" --label "mm.project=$P" --network none --user "$BUID:$G" --cap-drop ALL -v "$T:$T" "$IMG" sh -c "rm -rf '$T'/* '$T'/.[!.]*" >/dev/null 2>&1
  rm -rf "$T"; }
trap cleanup EXIT
echo "== $IMG, the tests' area: $T"
# the checkout as it is (its working tree, without .git), readable by the box's uid through the owner's group
tar -C "$HERE" --exclude=.git -cf - . | tar -C "$T" -xf - && mkdir -p "$T/tmp" && chmod -R g+rX "$T" && chmod 2775 "$T/tmp"
for n in $(seq 248 -1 10); do
  if $W network create --internal --subnet "10.231.$n.0/24" --gateway "10.231.$n.1" --label "mm.project=$P" "$NET" >/dev/null 2>"$T/err"; then break; fi
  grep -qiE 'overlap|in use' "$T/err" || { cat "$T/err"; exit 1; }
done
BUID=$((200000 + n))
$W run --rm --name "$BOX" --hostname "$P" --label "mm.project=$P" --network "$NET" --ip "10.231.$n.10" \
  --user "$BUID:$G" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 -v "$T:$T" -w "$T" -e TMPDIR=/tmp "$IMG" bash "$T/test/front.sh"
