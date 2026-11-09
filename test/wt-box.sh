#!/usr/bin/env bash
# A code worker's settings in a box and outside one (sy-fk51), hermetic: a throwaway project, no Docker. Proves: outside
# a box, wt w-<item> writes the bubblewrap sandbox (enabled, failIfUnavailable, no unsandboxed commands) and the
# permissions; in a box (the image's /etc/mm-box, owned by root) only the permissions, no sandbox block; a marker that is
# not root's keeps the sandbox (only root can make the real one, so a lead can't fake it on the host); a lead's own
# worktree gets no settings. wt has no override for the marker: the test runs copies of it whose marker path is a file
# of its own (not root's) or /etc/passwd (root's). test/wt-box-container.sh checks the real image.
#   test/wt-box.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
skip() { printf '  skip %s\n' "$*"; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_OBS_TRACES=""; mkdir -p "$HOME"

# a project: bin/wt (and copies whose marker is elsewhere), code/ on main
P="$T/p"; mkdir -p "$P/bin" "$P/code"
cp "$SRC/template/bin/wt" "$P/bin/wt"
echo mine >"$T/marker"
sed "s|/etc/mm-box|$T/marker|g" "$SRC/template/bin/wt" >"$P/bin/wt-mine"
sed "s|/etc/mm-box|/etc/passwd|g" "$SRC/template/bin/wt" >"$P/bin/wt-root"
chmod +x "$P/bin/"wt*
git -C "$P/code" init -q -b main && git -C "$P/code" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
wt() { local b=$1; shift; MM_TRACE_SELF="$P/bin/$b" "$P/bin/$b" "$@"; }
# what the settings say: sandbox on? failIfUnavailable? the four denies?
read_s() { node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), d = s.permissions?.deny || [], w = process.argv[2]
  const want = [`Edit(/${w}/.claude/**)`, `Write(/${w}/.claude/**)`, "Bash(git push*)", "Bash(*SANDBOX*)"]
  console.log([s.sandbox ? `sandbox ${s.sandbox.enabled} ${s.sandbox.failIfUnavailable} ${s.sandbox.allowUnsandboxedCommands}` : "no-sandbox",
    want.every((x) => d.includes(x)) ? "denies" : "denies-missing:" + JSON.stringify(d)].join(" "))' "$1/.claude/settings.local.json" "$1" 2>&1; }
is() { local d=$1 want=$2 got=$3; [ "$got" = "$want" ] && ok "$d" || bad "$d: want '$want', got '$got'"; }

echo "== outside a box (the host)"
if [ -e /etc/mm-box ]; then skip "this machine has /etc/mm-box (run it on the host, not in a box)"
else
  W=$(wt wt w-a1); is "wt prints the worktree" "$P/worktrees/w-a1" "$W"
  is "the sandbox, on and failIfUnavailable, and the permissions" "sandbox true true false denies" "$(read_s "$W")"
  is "the settings stay out of the worker's commits (git status: clean)" "" "$(git -C "$W" status --porcelain --untracked-files=all)"
fi

echo "== code/.git/info/exclude read-only (a box mounts it so, sy-r069)"
mkdir -p "$P/code/.git/info"; touch "$P/code/.git/info/exclude"; chmod 444 "$P/code/.git/info/exclude"
before=$(cat "$P/code/.git/info/exclude")
W=$(wt wt-root w-a5 2>"$T/err"); rc=$?
is "wt w-<item> still makes the worktree (exit 0)" "0 $P/worktrees/w-a5" "$rc $W"
is "...its settings, out of git status" "" "$(git -C "$W" status --porcelain --untracked-files=all 2>&1)"
is "...and info/exclude is not touched" "$before" "$(cat "$P/code/.git/info/exclude")"
chmod 644 "$P/code/.git/info/exclude"

echo "== a marker that is not root's"
if [ "$(id -u)" = 0 ]; then skip "running as root: the test's own file is root's"
else
  W=$(wt wt-mine w-a2); is "keeps the sandbox (only root makes the real marker)" "sandbox true true false denies" "$(read_s "$W")"
fi

echo "== in a box (a root-owned marker)"
W=$(wt wt-root w-a3); is "no sandbox block, the permissions stay" "no-sandbox denies" "$(read_s "$W")"
W=$(wt wt-root lead-dev); [ -e "$W/.claude/settings.local.json" ] && bad "a lead's worktree got worker settings" || ok "a lead's own worktree: no worker settings"

echo "== an environment can't fake it"
if [ -e /etc/mm-box ]; then skip "this machine has /etc/mm-box"
else
  W=$(MM_BOX=1 MM_BOX_MARKER=/etc/passwd MM_IN_BOX=1 wt wt w-a4); is "box-like variables change nothing" "sandbox true true false denies" "$(read_s "$W")"
fi

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
