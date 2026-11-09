#!/usr/bin/env bash
# bin/wt in a box (sy-jzl8): the box mounts code/.git/config read-only, so wt must not write a setting that is already
# there. A git wrapper on PATH stands for the mount: it refuses any write of extensions.worktreeConfig.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  ok   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$*"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org
P="$T/proj"; mkdir -p "$P/bin/lib" "$P/worktrees"
cp "$HERE/template/bin/wt" "$P/bin/wt"; chmod +x "$P/bin/wt"
printf '#!/bin/sh\nshift; [ "$1" = "--" ] && shift; exec "$@"\n' >"$P/bin/trace"; chmod +x "$P/bin/trace"   # no tracing here
printf 'process.exit(0)\n' >"$P/bin/lib/claude.mjs"                                                     # no Claude folders here
git init -q -b main "$P/code"; git -C "$P/code" commit -q --allow-empty -m base
REAL=$(command -v git); mkdir -p "$T/stub"
cat >"$T/stub/git" <<EOF
#!/bin/sh
for a in "\$@"; do case "\$a" in extensions.worktreeConfig) for b in "\$@"; do [ "\$b" = true ] && { echo "error: could not write config file .git/config: Device or resource busy" >&2; exit 4; }; done;; esac; done
exec "$REAL" "\$@"
EOF
chmod +x "$T/stub/git"

echo "== the setting is already there (as in a box)"
"$REAL" -C "$P/code" config extensions.worktreeConfig true
out=$(PATH="$T/stub:$PATH" "$P/bin/wt" w-pg-1 2>&1); rc=$?
[ $rc -eq 0 ] && ok "wt w-pg-1 exits 0 with a read-only config" || bad "wt w-pg-1 exits $rc: $out"
[ -d "$P/worktrees/w-pg-1" ] && ok "...the worktree is there" || bad "...no worktree"
[ -f "$P/worktrees/w-pg-1/.claude/settings.local.json" ] && ok "...with the worker's sandbox settings" || bad "...no sandbox settings"
[ "$("$REAL" -C "$P/worktrees/w-pg-1" config user.name)" = code-worker ] && ok "...its commits show code-worker" || bad "...user.name not code-worker"

echo "== the setting is not there yet (a new project): wt writes it"
P2="$T/proj2"; mkdir -p "$P2/bin/lib" "$P2/worktrees"; cp "$P/bin/wt" "$P/bin/trace" "$P2/bin/"; cp "$P/bin/lib/claude.mjs" "$P2/bin/lib/"
git init -q -b main "$P2/code"; git -C "$P2/code" commit -q --allow-empty -m base
"$P2/bin/wt" lead-qa >/dev/null 2>&1 && ok "wt lead-qa exits 0" || bad "wt lead-qa failed"
[ "$("$REAL" -C "$P2/code" config --bool --get extensions.worktreeConfig)" = true ] && ok "...and sets extensions.worktreeConfig" || bad "...the setting is missing"

echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
