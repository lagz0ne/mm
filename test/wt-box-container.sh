#!/usr/bin/env bash
# A code worker in a box (sy-fk51): the box image this repo builds (box/Dockerfile, mm-box), run the way mm runs a box
# (src/box.ts: its own uid with the owner's group, read-only root, cap-drop ALL, no-new-privileges, tmpfs /tmp and
# home, the project mounted at its own path). Proves: the image has the marker /etc/mm-box, root's, 0644, and the box
# can't change it; wt w-<item> in the box writes the worker's settings with no sandbox block (bwrap can't start in a
# box) and the permissions; git status and node --test run in that worktree. Throwaway image, container and folders.
# Through mm's Docker wrapper only (test/lib/docker.sh; MM_DOCKER_BIN for this checkout's copy).
#   test/wt-box-container.sh  [--keep]        BOX_IMAGE=<mm-box:tag> to skip the image's build
set -uo pipefail
KEEP=""; [ "${1:-}" = --keep ] && KEEP=1
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/test/lib/docker.sh"
D() { $DOCKER "$@"; }
ID=$$
TMP=$(mm_test_dir wtbox); PROJ=$(basename "$TMP"); BOX=mm-box-$PROJ
BUILT=""; IMG=${BOX_IMAGE:-}
cleanup() {
  [ -n "$KEEP" ] && { echo "kept: $BOX $BUILT $TMP"; return; }
  D rm -f "$BOX" >/dev/null 2>&1
  [ -n "$BUILT" ] && D rmi -f $BUILT >/dev/null 2>&1
  rm -rf "$TMP" 2>/dev/null || chmod -R u+rwX "$TMP" 2>/dev/null; rm -rf "$TMP"
}
trap cleanup EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >"$TMP/out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$TMP/out" | sed 's/^/       /'; fi; }

echo "== the box image (through $DOCKER)"
if [ -z "$IMG" ]; then
  # a folder as mm-docker builds them (mm-box-build-*: the owner's, 0700), with what src/box.ts build() puts there
  IMG=mm-box:wttest-$ID; BB="$TMP/mm-box-build-wt$ID"; mkdir -p "$BB"; chmod 700 "$BB"
  cp "$ROOT/box/Dockerfile" "$BB/Dockerfile"; cp -r "$ROOT/box/npm" "$BB/npm"
  D build -q -t "$IMG" -f "$BB/Dockerfile" "$BB" >"$TMP/build" 2>&1 || { tail -20 "$TMP/build"; echo "box image build failed"; exit 1; }
  BUILT="$IMG"; rm -rf "$BB"
fi
echo "  $IMG"

echo "== a project and its box"
# the project as mm lays it out: bin/wt (the template's), code/ on main with a node test; the box's uid writes it
# through the owner's group, as in a real box (umask 002)
P="$TMP/p"; mkdir -p "$P/bin" "$P/code/test"; cp "$ROOT/template/bin/wt" "$P/bin/wt"
printf "import test from 'node:test'\nimport assert from 'node:assert'\ntest('adds', () => assert.equal(1 + 1, 2))\n" >"$P/code/test/a.test.mjs"
git -C "$P/code" init -q -b main && git -C "$P/code" add -A && git -C "$P/code" -c user.name=t -c user.email=t@t commit -q -m init
chmod -R g+rwX,o+rX "$P"; find "$P" -type d -exec chmod g+s {} +
BUID=$((200000 + ID % 50000))
getent passwd "$BUID" >/dev/null && { echo "uid $BUID is an account here"; exit 1; }
D run -d --name "$BOX" --label "mm.project=$PROJ" --network none --user "$BUID:$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 \
  --tmpfs "/home/box:rw,nosuid,nodev,size=64m,uid=$BUID,gid=$(id -g),mode=0700" -e HOME=/home/box \
  -v "$P:$P" -w "$P" "$IMG" sleep infinity >/dev/null || { echo "box start failed"; exit 1; }
IN() { D exec "$BOX" sh -c "umask 002; $1"; }

echo "== the marker"
check "/etc/mm-box is in the image, root's, 0644" sh -c "[ \"\$($DOCKER exec $BOX stat -c '%u %a' /etc/mm-box)\" = '0 644' ]"
check "the box can't change it" sh -c "! $DOCKER exec $BOX sh -c 'echo x >/etc/mm-box' 2>/dev/null && ! $DOCKER exec $BOX rm -f /etc/mm-box 2>/dev/null"
# why (not a check: it depends on the host's Docker and kernel): bwrap in a box
if IN 'bwrap --ro-bind / / true' >/dev/null 2>&1; then echo "  note bwrap starts in this test box (here; a box's seccomp refuses it on the machine)"
else echo "  note bwrap can't start in the box: $(IN 'bwrap --ro-bind / / true' 2>&1 | head -1)"; fi

echo "== a code worker in the box"
check "wt w-b1 makes its worktree" IN "MM_TRACE_SELF=$P/bin/wt $P/bin/wt w-b1"
S="$P/worktrees/w-b1/.claude/settings.local.json"
check "its settings: no sandbox block" IN "node -e 'const s = JSON.parse(require(\"fs\").readFileSync(\"$S\", \"utf8\")); process.exit(\"sandbox\" in s ? 1 : 0)'"
check "...and the permissions (no edits of .claude, no git push, no *SANDBOX*)" IN "node -e '
  const d = JSON.parse(require(\"fs\").readFileSync(\"$S\", \"utf8\")).permissions.deny, w = \"$P/worktrees/w-b1\"
  const want = [\`Edit(/\${w}/.claude/**)\`, \`Write(/\${w}/.claude/**)\`, \"Bash(git push*)\", \"Bash(*SANDBOX*)\"]
  process.exit(want.every((x) => d.includes(x)) ? 0 : 1)'"
check "git status runs in the worktree (clean: the settings are excluded)" IN "cd $P/worktrees/w-b1 && [ -z \"\$(git status --porcelain)\" ]"
check "node --test runs there" IN "cd $P/worktrees/w-b1 && node --test"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
