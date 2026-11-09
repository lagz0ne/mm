#!/bin/sh
# build.sh — the mm fork of Doop as an image (sy-3yz): the pinned upstream image's own source, the patches on it
# (0001-gateway-assertion.patch, 0002-source-link.patch, in order, with git apply), and the result built on that image
# (Dockerfile here). Nothing is pulled or pushed. Prints the new image's id (sha256:<64 hex>), which doop.image takes.
#   box/doop/build.sh <tag> [base image]      (tag: mm-doop:<version>; base: mm-doop:0.12.0)
# Through mm's Docker wrapper (sy-e6t3; DOCKER, default "sudo -n /usr/local/libexec/mm-docker"): the source comes out
# of a stopped, labelled container with no mounts as a tar stream (cp ... -), and the build's folder is named as the
# wrapper builds them (mm-box-build-*, the owner's, 0700).
# The base must be the image the patch was made against (BASE_ID): a tag can be moved to another image, the id can't.
set -eu
# the image's files are root's and Doop runs as its own uid (210000 + n), so all it reads must be world-readable. A
# caller's umask 077 would make tar -x and git apply write them 0600 (and folders 0700), and COPY keeps those modes:
# Doop would stop at boot with EACCES on /app/server/index.ts. So: 022 here, and the copied trees made readable anyway.
umask 022
HERE=$(cd "$(dirname "$0")" && pwd)
TAG=${1:?usage: build.sh <tag> [base image]}; BASE=${2:-mm-doop:0.12.0}
BASE_ID=sha256:4062eea59e91507d2a1a64df6da0764fcdb7f69d87e1a046a31fcd90e5b83c68 # Doop 0.12.0 as pinned (sy-d2t)
DOCKER=${DOCKER:-sudo -n /usr/local/libexec/mm-docker}
command -v git >/dev/null || { echo "build.sh: git is missing (git apply)" >&2; exit 1; }
id=$($DOCKER image inspect -f '{{.Id}}' "$BASE" 2>/dev/null) || { echo "build.sh: no image $BASE here" >&2; exit 1; }
[ "$id" = "$BASE_ID" ] || { echo "build.sh: refused: $BASE is $id, not the image the patch is for ($BASE_ID)" >&2; exit 1; }
W=$(mktemp -d -t mm-box-build-XXXXXXXX); C=""
trap '[ -z "$C" ] || $DOCKER rm -f "$C" >/dev/null 2>&1; rm -rf "$W"' EXIT
# the source as the image has it (no node_modules), copied out of a stopped container, as this user's files
C="mm-doop-dbuild-$$"
$DOCKER create --name "$C" --label "mm.project=dbuild-$$" --network none --user "210000:$(id -g)" --cap-drop ALL "$BASE_ID" >/dev/null
for d in package.json server shared; do $DOCKER cp "$C:/app/$d" - | tar -x -C "$W"; done
$DOCKER rm -f "$C" >/dev/null; C=""
# the fork's commits, in order (0001-gateway-assertion, 0002-source-link, ...)
for p in "$HERE"/[0-9][0-9][0-9][0-9]-*.patch; do git -C "$W" apply --whitespace=nowarn "$p"; done
chmod -R a+rX,go-w "$W/server" "$W/shared"
cp "$HERE/Dockerfile" "$W/Dockerfile"
$DOCKER build -q -t "$TAG" --build-arg BASE="$BASE" -f "$W/Dockerfile" "$W" >/dev/null
$DOCKER image inspect -f '{{.Id}}' "$TAG"
