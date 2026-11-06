# The docker a container test uses (sy-e6t3): mm's wrapper (box/mm-docker), never plain `sudo docker`.
#   (default)              the installed wrapper, through sudo: DOCKER="sudo -n /usr/local/libexec/mm-docker". Its
#                          config (/etc/mm-docker.conf, root's) names the tests' area: test_root, test_prefix.
#   MM_DOCKER_BIN=<copy>   that copy (e.g. box/mm-docker) in test mode, as you (not root), with a config this file
#                          writes; its docker is MM_DOCKER_RAW (default: docker). For a wrapper not installed yet.
#   DOCKER=<command>       as given (e.g. plain docker, where you may).
# Each test's folders go in the area, one folder per run: `T=$(mm_test_dir <name>)` makes <area>/<prefix><name>-<pid>;
# its name is the throwaway project the wrapper lets the test's containers mount (the folder and all in it).
#   . "$HERE/test/lib/docker.sh"
MM_DOCKER_TEST_ROOT=${MM_DOCKER_TEST_ROOT:-$HOME/.cache/mm-docker-test}
MM_DOCKER_TEST_PREFIX=${MM_DOCKER_TEST_PREFIX:-mmt-}
mkdir -p "$MM_DOCKER_TEST_ROOT" && chmod 755 "$MM_DOCKER_TEST_ROOT"
MM_DOCKER_TEST_ROOT=$(cd "$MM_DOCKER_TEST_ROOT" && pwd -P)
if [ -z "${DOCKER:-}" ] && [ -n "${MM_DOCKER_BIN:-}" ]; then
  # mm's home, the projects and the secrets: none (the test area is all a test needs); never inside the area
  # env_file = path: its docker may be `sudo -n docker`, which closes the open file the wrapper would hand over
  printf 'docker = %s\nmm_home = %s\nprojects = %s\nsecrets = %s\nroot_containers = no\ntest_root = %s\ntest_prefix = %s\nenv_file = path\n' \
    "${MM_DOCKER_RAW:-docker}" /nonexistent/mm /nonexistent/mm/projects /nonexistent/secrets \
    "$MM_DOCKER_TEST_ROOT" "$MM_DOCKER_TEST_PREFIX" >"$MM_DOCKER_TEST_ROOT/test-mode.conf"
  export MM_DOCKER_CONF="$MM_DOCKER_TEST_ROOT/test-mode.conf"
  DOCKER=$(realpath "$MM_DOCKER_BIN")
fi
DOCKER=${DOCKER:-sudo -n /usr/local/libexec/mm-docker}
export DOCKER
# mm_test_dir <name>: the test's own folder in the area (made, 0755), printed
mm_test_dir() { local d="$MM_DOCKER_TEST_ROOT/$MM_DOCKER_TEST_PREFIX$1-$$"; mkdir -p "$d" && chmod 755 "$d" && echo "$d"; }
