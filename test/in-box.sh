#!/usr/bin/env bash
# Run hermetic tests (vault.sh, sync.sh, ...) in a throwaway container that has age, git and jq, against a local build.
# For a box without age, or to check on another distro. Nothing on the host is touched except the container.
#   test/in-box.sh dist/mm vault.sh sync.sh       options: --image ubuntu:24.04 (default)   DOCKER="sudo -n docker"
set -uo pipefail
IMAGE=ubuntu:24.04; DOCKER=${DOCKER:-docker}
[ "${1:-}" = --image ] && { IMAGE=$2; shift 2; }
[ $# -ge 2 ] || { echo "usage: $0 [--image <image>] <mm binary> <test.sh>..."; exit 2; }
BIN=$(readlink -f "$1"); shift; HERE=$(cd "$(dirname "$0")" && pwd)
NAME=mm-inbox-$$; WORK=$(mktemp -d); trap '$DOCKER rm -f "$NAME" >/dev/null 2>&1; rm -rf -- "$WORK"' EXIT
cp "$BIN" "$WORK/mm"; for t in "$@"; do cp "$HERE/$t" "$WORK/"; done; chmod -R a+rX "$WORK"
$DOCKER run -d --name "$NAME" -v "$WORK:/w:ro" "$IMAGE" sleep infinity >/dev/null || exit 1
$DOCKER exec "$NAME" sh -c 'if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq age jq git openssh-client >/dev/null 2>&1; else dnf install -y -q epel-release >/dev/null 2>&1; dnf install -y -q age jq git openssh >/dev/null; fi && useradd -m dev' || { echo "container setup failed"; exit 1; }
echo "== $IMAGE: age $($DOCKER exec "$NAME" age --version)"
rc=0
for t in "$@"; do echo "== $t"; $DOCKER exec -u dev -w /home/dev "$NAME" bash "/w/$t" /w/mm || rc=1; done
exit $rc
