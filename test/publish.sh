#!/usr/bin/env bash
# mm publish (sy-yzai), hermetic: mm's main goes to its public remote only as a fast-forward, only when the secret and
# private-word scans pass, and a refusal names the pattern, never the text. A throwaway HOME / MM_HOME, a bare repo as
# the remote, and a git shim that logs every git call (to assert the push's arguments: never a force).
#   test/publish.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_DIR GIT_WORK_TREE
mkdir -p "$HOME" "$MM_HOME" "$T/bin"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
REALGIT=$(command -v git)
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s"\nexec %s "$@"\n' "$T/git.log" "$REALGIT" >"$T/bin/git"; chmod +x "$T/bin/git"
export PATH="$T/bin:$PATH"
REPO="$T/repo" REMOTE="$T/remote.git"
G() { git -C "$REPO" -c user.name=dev -c user.email=dev@example.org "$@"; }
remote_main() { git -C "$REMOTE" rev-parse -q --verify refs/heads/main; }
main_sha() { git -C "$REPO" rev-parse main; }
conf() { cat >"$MM_HOME/config.yaml" <<EOF
layout: one-root
publish:
  repo: $REPO
  remote: $REMOTE
  auto: ${1:-false}
  private_words:
    host: Zorblax
    owner_mail: secret.person@example.net
EOF
}
commit() { local f=$1 text=$2 msg=${3:-"change $1"}; printf '%s\n' "$text" >>"$REPO/$f"; G add -A; G commit -q -m "$msg"; }

git init -q --bare -b main "$REMOTE"
git init -q -b main "$REPO"
commit README.md "hello" "first"
G push -q "$REMOTE" main:main
G config remote.origin.url "$T/elsewhere.git"   # what the repo's own config says never counts
conf false

echo "== not configured: refused, nothing pushed"
mv "$MM_HOME/config.yaml" "$T/conf.bak"
commit a.txt "plain"
mm publish >"$T/o" 2>&1; RC=$?
check "no publish config: exit 1, says what is missing" sh -c "[ $RC = 1 ] && grep -q 'publish.repo is not set' '$T/o'"
mv "$T/conf.bak" "$MM_HOME/config.yaml"

echo "== a clean fast-forward pushes"
: >"$T/git.log"
mm publish >"$T/o" 2>&1; RC=$?; cp "$T/git.log" "$T/git.pub"
check "exit 0, 'published'" sh -c "[ $RC = 0 ] && grep -q '^published main' '$T/o'"
check "the remote's main is main" [ "$(remote_main)" = "$(main_sha)" ]
check "the push: <sha>:refs/heads/main to the configured remote" grep -q "push --no-verify --no-follow-tags --porcelain $REMOTE $(main_sha):refs/heads/main" "$T/git.pub"
check "never --force, -f, --force-with-lease, --mirror or a + refspec" sh -c "! grep -E '(^| )push( |\$)' '$T/git.pub' | grep -qE -- ' (--force[^ ]*|-f|--mirror|--delete|\+[^ ]*)( |\$)'"
check "every git call without hooks (core.hooksPath=/dev/null)" sh -c "! grep -v 'core.hooksPath=/dev/null' '$T/git.pub'"
check "the repo's own remote.origin.url was never used" sh -c "! grep -q elsewhere '$T/git.pub'"
mm publish >"$T/o" 2>&1; RC=$?
check "again: up to date, exit 0" sh -c "[ $RC = 0 ] && grep -q '^up to date' '$T/o'"

refused() {   # refused <desc> <expected name>: a refusal, the name printed, the text not, nothing pushed
  local before; before=$(remote_main)
  mm publish >"$T/o" 2>&1; local rc=$?
  check "$1: exit 1" [ "$rc" = 1 ]
  check "...names '$2'" grep -qF "$2" "$T/o"
  check "...never prints the text" sh -c "! grep -qiE 'zorblax|secret\.person|AKIA|BEGIN .*PRIVATE' '$T/o'"
  check "...nothing pushed" [ "$(remote_main)" = "$before" ]
}
undo() { G reset -q --hard "$(remote_main)"; }

echo "== a private word refuses (any case), wherever it is"
commit b.txt "we run on zORBLAX today"; refused "in an added line" "private word host"
check "...where: the file and line" grep -qE 'b\.txt:1: private word host' "$T/o"; undo
commit c.txt "plain" "deploy to ZORBLAX"; refused "in a message" "private word host"
check "...where: the message" grep -qE ' message: private word host' "$T/o"; undo
printf 'plain\n' >"$REPO/d.txt"; G add -A; git -C "$REPO" -c user.name=Someone -c user.email=Secret.Person@example.net commit -q -m d
refused "in the author" "private word owner_mail"
check "...where: author" grep -qE ' author: private word owner_mail' "$T/o"; undo
mkdir -p "$REPO/zorblax"; printf 'plain\n' >"$REPO/zorblax/e.txt"; G add -A; G commit -q -m e
refused "in a path" "private word host"
check "...the path is not printed" sh -c "grep -q '(a path with a hit)' '$T/o'"; undo
commit f.txt "one"; commit g.txt "the zorblax box"; commit g.txt "gone again" ; sed -i '/zorblax/d' "$REPO/g.txt"; G commit -q -am h
refused "in a commit in the middle (the net diff is clean)" "private word host"; undo
printf 'bin\0\x01zorblax\0\n' >"$REPO/i.bin"; G add -A; G commit -q -m i
refused "in a binary file" "private word host"; undo

echo "== a secret shape refuses"
commit j.txt "key = AKIAABCDEFGHIJKLMNOP"; refused "an AWS key" "an AWS access key"; undo
commit k.txt "-----BEGIN OPENSSH PRIVATE KEY-----"; refused "a private key" "a private key"; undo

echo "== auto: a refusal stays refused until main moves"
conf true
commit l.txt "zorblax"
mm publish --auto >"$T/o" 2>&1; RC=$?
check "--auto refuses (exit 1)" [ "$RC" = 1 ]
: >"$T/git.log"
mm publish --auto >"$T/o" 2>&1; RC=$?
check "--auto again: held, exit 0, no fetch" sh -c "[ $RC = 0 ] && grep -q '^held' '$T/o' && ! grep -q fetch '$T/git.log'"
undo; commit l.txt "fixed"
mm publish --auto >"$T/o" 2>&1; RC=$?
check "main moved: --auto pushes" sh -c "[ $RC = 0 ] && [ \"\$(git -C '$REMOTE' rev-parse main)\" = \"\$(git -C '$REPO' rev-parse main)\" ]"

echo "== not a fast-forward: refused, nothing pushed"
W="$T/other"; git clone -q "$REMOTE" "$W"; printf 'x\n' >>"$W/o.txt"; git -C "$W" add -A; git -C "$W" -c user.name=o -c user.email=o@example.org commit -q -m other; git -C "$W" push -q origin main
commit m.txt "local"
before=$(remote_main)
mm publish >"$T/o" 2>&1; RC=$?
check "exit 1, 'not a fast-forward'" sh -c "[ $RC = 1 ] && grep -q 'not a fast-forward' '$T/o'"
check "...the remote's main unchanged" [ "$(remote_main)" = "$before" ]

echo "== a url.insteadOf rule that rewrites the remote: refused"
G reset -q --hard "$before"; commit n.txt "ok"
G config "url.$T/evil.git.insteadOf" "$REMOTE"
mm publish >"$T/o" 2>&1; RC=$?
check "exit 1, names the rewrite, nothing pushed" sh -c "[ $RC = 1 ] && grep -q insteadOf '$T/o' && [ \"\$(git -C '$REMOTE' rev-parse main)\" = '$before' ]"
G config --unset "url.$T/evil.git.insteadOf"

echo "== publish.auto off: cron's run does nothing"
conf false
: >"$T/git.log"
mm publish --auto >"$T/o" 2>&1; RC=$?
check "exit 0, 'publish.auto is off'" sh -c "[ $RC = 0 ] && grep -q 'publish.auto is off' '$T/o'"
check "...no git call at all, nothing pushed" sh -c "[ ! -s '$T/git.log' ] && [ \"\$(git -C '$REMOTE' rev-parse main)\" = '$before' ]"
cat >"$T/cron.ts" <<EOF
import { cronPublish } from '$SRC/src/publish'
console.log(JSON.stringify(cronPublish()))
EOF
check "cron's hook: null (no line) with auto off" sh -c "[ \"\$(bun '$T/cron.ts')\" = null ]"
check "cron.ts calls the hook every 5 minutes" sh -c "grep -q 'cronPublish()' '$SRC/src/cron.ts' && grep -q 'PUBLISH_EVERY_MS = \\|EVERY_MS = 5 \\* 60e3' '$SRC/src/publish.ts'"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
