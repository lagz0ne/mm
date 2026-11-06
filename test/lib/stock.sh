# The engine for the tests that run a stock OS image as root (clean-box, auth-e2e, in-box, restore-drill, box-gateway).
# They never go through mm's wrapper (test/lib/docker.sh): it refuses a stock image as root, on purpose.
#   (default)              rootless podman: root in the container is the owner's uid in a user namespace; no sudo.
#   DOCKER=<command>       as given, e.g. DOCKER="sudo -n docker" or DOCKER=docker.
#   . "$(dirname "$0")/lib/stock.sh"
DOCKER=${DOCKER:-podman}
# stock_image <name>: the name fully qualified, as podman needs with no terminal (its short-name mode is enforcing):
# ubuntu:24.04 -> docker.io/library/ubuntu:24.04, org/img -> docker.io/org/img, a registry's name as given. Docker
# reads both forms as the same image.
stock_image() {
  case "$1" in
    */*) case "${1%%/*}" in *.*|*:*|localhost) echo "$1" ;; *) echo "docker.io/$1" ;; esac ;;
    *) echo "docker.io/library/$1" ;;
  esac
}
# STOCK_RO: the options of the tests' read-only bind of their work folder. z: a label all of a test's containers share,
# for a host with SELinux on (restore-drill's three containers read the same folder); a no-op without it.
STOCK_RO=ro,z
