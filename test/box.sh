#!/usr/bin/env bash
# A project box on this machine (plans/project-box.md, M1-A + B): `mm box build`, then a throwaway project made with
# `mm new --box`. Its services run in the box; the box is a normal user with no sudo and no capabilities; its root is
# read-only and so is everything that decides what it may do; its only way out is its own egress proxy, which lets
# through only its list. `mm archive` removes it all. Nothing outside the throwaway project and its containers changes.
#   MM_DOCKER="sudo -n docker" test/box.sh [client/name]
set -uo pipefail
REF=${1:-qa/boxt}; PROJECT=${REF/\//-}
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
export MM_DOCKER=${MM_DOCKER:-docker}
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/tmp/box-test.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/box-test.out | sed 's/^/       /'; fi; }
BOX=mm-box-$PROJECT; PX=mm-egress-$PROJECT; NET=mm-net-$PROJECT
D() { $MM_DOCKER "$@"; }
IN() { D exec "$BOX" sh -c "$*"; }
cleanup() { [ -n "${KEEP:-}" ] && return; mm archive "$REF" >/dev/null 2>&1; D rm -f "$BOX" "$PX" >/dev/null 2>&1; D network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
export -f D IN; export BOX PX NET MM_DOCKER

echo "== the images"
check "mm box build: the box image and the egress proxy image" mm box build
echo "== a box project"
mm new "$REF" --throwaway --box >/tmp/box-new.out 2>&1 || { tail -15 /tmp/box-new.out; exit 1; }
ROOT=$(mm ls -o json | jq -r --arg p "$PROJECT" '.[] | select(.project == $p) | .root' | sed "s|^~|$HOME|")
[ -n "$ROOT" ] || ROOT=$(sed -n 's/^root: //p' "$HOME/projects/$REF/.mm-answers.yaml" 2>/dev/null)
check "mm new --box: box: true in the answers" grep -qx 'box: true' "$ROOT/.mm-answers.yaml"
for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
check "the services run in the box (dolt, bd-serve, board ready)" sh -c "mm inspect '$REF' | grep -q 'dolt .*Ready' && mm inspect '$REF' | grep -q 'bd-serve .*Ready' && mm inspect '$REF' | grep -q 'board .*Ready'"
check "...and not on the host's process manager" sh -c "! process-compose -U -u $HOME/.mm/pc.sock process list -o json | jq -e '.[] | select(.name | startswith(\"$PROJECT.\"))'"
check "the board answers inside the box (by its name)" IN "curl -sf -o /dev/null http://board.$PROJECT.localhost:1355/api/whoami"
check "bd works in the box (an item, over Dolt's socket)" IN "cd $ROOT && bin/bd create 'made in the box' --json | grep -q '\"id\"'"

echo "== the box user"
check "a normal user (uid $(id -u)), not root" sh -c "[ \"\$(IN 'id -u')\" = '$(id -u)' ]"
check "no sudo" sh -c "! IN 'sudo -n true'"
check "no capabilities (CapEff all zero)" sh -c "IN 'grep CapEff /proc/self/status' | grep -q '0000000000000000'"
check "no new privileges" sh -c "IN 'grep NoNewPrivs /proc/self/status' | grep -q '1'"
check "no Docker socket" sh -c "! IN 'test -e /var/run/docker.sock'"

echo "== what the box may write"
check "the root file system is read-only" sh -c "! IN 'touch /usr/x'"
check "the project folder is writable (memory/, the board's data)" IN "touch $ROOT/memory/.box-probe && rm $ROOT/memory/.box-probe"
for f in services.yaml .mm-answers.yaml secrets.json bin/land .git/config .run/box/cfg/pc.yaml; do
  check "read-only in the box: $f" sh -c "! IN 'echo x >> $ROOT/$f' && ! grep -q '^x\$' '$ROOT/$f'"
done

echo "== the way out"
check "no direct way out (by name)" sh -c "! IN 'curl -s -o /dev/null --max-time 8 --noproxy \"*\" https://github.com/'"
check "no direct way out (by address)" sh -c "! IN 'curl -s -o /dev/null --max-time 8 --noproxy \"*\" https://1.1.1.1/'"
check "through its proxy: a site on its list (github.com)" IN "curl -s -o /dev/null --max-time 20 -x http://$PX:8888 https://github.com/"
check "through its proxy: a site off its list is refused (example.com)" sh -c "! IN 'curl -s -o /dev/null --max-time 20 -x http://$PX:8888 https://example.com/'"
check "the services get the proxy (HTTPS_PROXY in their environment)" sh -c "IN 'cat /proc/\$(pgrep -f \"site/server.mjs\" | head -1)/environ' | tr '\\0' '\\n' | grep -q '^HTTPS_PROXY=http://$PX:8888'"
check "the host's own services don't answer from the box (names proxy 1355, VictoriaMetrics 8428 on the docker bridge)" sh -c "! IN 'curl -s -o /dev/null --max-time 5 --noproxy \"*\" http://172.17.0.1:1355/' && ! IN 'curl -s -o /dev/null --max-time 5 --noproxy \"*\" http://172.17.0.1:8428/'"

echo "== archive"
check "mm archive: the box and its proxy are gone" sh -c "mm archive '$REF' >/dev/null && ! D inspect '$BOX' >/dev/null 2>&1 && ! D inspect '$PX' >/dev/null 2>&1"
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
