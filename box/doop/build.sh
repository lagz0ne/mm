#!/bin/sh
# build.sh — the mm fork of Doop as an image (sy-3yz): the pinned upstream image's own source, the patch on it
# (0001-gateway-assertion.patch, with git apply), and the result built on that image (Dockerfile here). Nothing is
# pulled or pushed. Prints the new image's id (sha256:<64 hex>), which doop.image takes.
#   DOCKER="sudo -n docker" box/doop/build.sh <tag> [base image]      (base: mm-doop:0.12.0)
# The base must be the image the patch was made against (BASE_ID): a tag can be moved to another image, the id can't.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TAG=${1:?usage: build.sh <tag> [base image]}; BASE=${2:-mm-doop:0.12.0}
BASE_ID=sha256:4062eea59e91507d2a1a64df6da0764fcdb7f69d87e1a046a31fcd90e5b83c68 # Doop 0.12.0 as pinned (sy-d2t)
DOCKER=${DOCKER:-docker}
command -v git >/dev/null || { echo "build.sh: git is missing (git apply)" >&2; exit 1; }
id=$($DOCKER image inspect -f '{{.Id}}' "$BASE" 2>/dev/null) || { echo "build.sh: no image $BASE here" >&2; exit 1; }
[ "$id" = "$BASE_ID" ] || { echo "build.sh: refused: $BASE is $id, not the image the patch is for ($BASE_ID)" >&2; exit 1; }
W=$(mktemp -d); C=""
trap '[ -z "$C" ] || $DOCKER rm -f "$C" >/dev/null 2>&1; rm -rf "$W"' EXIT
# the source as the image has it (no node_modules), copied out of a stopped container, as this user's files
mkdir -p "$W/src"; C=$($DOCKER create "$BASE_ID")
for d in package.json server shared; do $DOCKER cp "$C:/app/$d" - | tar -x -C "$W/src"; done
$DOCKER rm -f "$C" >/dev/null; C=""
git -C "$W/src" apply --whitespace=nowarn "$HERE/0001-gateway-assertion.patch"
$DOCKER build -q -t "$TAG" --build-arg BASE="$BASE" -f "$HERE/Dockerfile" "$W/src" >/dev/null
$DOCKER image inspect -f '{{.Id}}' "$TAG"
