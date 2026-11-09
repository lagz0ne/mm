#!/usr/bin/env bash
# sy-wxzx: bin/artifact puts files on an item (artifacts/<item-id>/<name> in the root config repo, committed), and
# config-check --staged (the pre-commit hook) checks every staged artifact, however it was committed. Hermetic: a
# system-like board in a throwaway folder (the template's bin and the system profile's leads), its own git repo.
# Proves: the refusals (bad id, no actor, a type the viewer can't show, over 5 MB, a dot name, a name with other
# characters, a file in secrets/, a key or token shape, a symlinked artifacts/ or item folder: nothing copied, nothing
# committed); a good run copies and
# commits only those files (message, author = the caller's role, other staged work left alone) and prints the paths;
# the same files again change nothing; a refused commit (the hook) keeps nothing; config-check refuses a staged
# artifact with a token shape, a bad path or over 5 MB, and passes a clean one.
#   test/artifact.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_OBS_METRICS="" MM_PROJECT=sysqa GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 CLAUDE_MANAGED_DIR="$T/no-managed"
unset BEADS_ACTOR BD_ACTOR GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
mkdir -p "$HOME"
B="$T/sys"; mkdir -p "$B"
# a system-like board, as test/assist.sh makes one: the base bin, the system profile's bin, leads, setup, assistants
(cd "$SRC/template" && tar -cf - bin leads/START.md .gitignore glossary.yaml) | tar -xf - -C "$B"
(cd "$SRC/template/profiles/system" && tar -cf - bin leads setup assistants governance.json) | tar -xf - -C "$B"
printf 'project: sysqa\nclient: system\nname: qa\nprofile: system\n' >"$B/.mm-answers.yaml"; touch "$B/CLAUDE.md"
for f in $(find "$B" -name '*.md' -o -name '*.tmpl.json'); do sed -i "s|{{root}}|$B|g; s|{{project}}|sysqa|g; s|{{home}}|$HOME|g; s|{{brain}}|$HOME/brain|g; s|{{projects}}|$HOME/projects|g; s|{{mm}}|$HOME/.mm|g" "$f"; done
G() { git -C "$B" "$@"; }
G init -q -b main && G -c user.name=t -c user.email=t@x add -A && G -c user.name=t -c user.email=t@x commit -qm init
head0=$(G rev-parse HEAD)

# the files: a png, a note, a log, and the refused ones
node -e "
const z=require('zlib'),f=require('fs'),crc=(b)=>{let c=~0;for(const x of b){c^=x;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1}return ~c>>>0}
const ch=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c])}
const h=Buffer.alloc(13);h.writeUInt32BE(4,0);h.writeUInt32BE(3,4);h[8]=8;h[9]=2
const raw=Buffer.alloc(3*(1+12),0x80);for(let y=0;y<3;y++)raw[y*13]=0
f.writeFileSync('$T/shot.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch('IHDR',h),ch('IDAT',z.deflateSync(raw)),ch('IEND',Buffer.alloc(0))]))"
printf '# Result\n\n| test | pass |\n|---|---|\n| a | 3/3 |\n' >"$T/notes.md"
printf 'line one\nline two\n' >"$T/run.txt"; cp "$T/run.txt" "$T/run.log"; cp "$T/run.txt" "$T/tool.exe"
head -c $((5 * 1024 * 1024 + 1)) /dev/zero >"$T/big.png"
cp "$T/notes.md" "$T/.hidden.md"; cp "$T/notes.md" "$T/with space.md"
mkdir -p "$B/secrets"; cp "$T/notes.md" "$B/secrets/inside.md"
printf 'config\n-----BEGIN %s PRIVATE KEY-----\nAAAA\n' OPENSSH >"$T/key.txt"
printf 'auth: %s%s\n' 'ghp_' 'abcdefghijklmnopqrstuvwxyz0123456789AB' >"$T/token.md"

A="$B/bin/artifact"
refused() { # <what> <expected words> <args...>: exit 2, the words on stderr, nothing copied or committed
  local d=$1 want=$2; shift 2
  local out; out=$("$@" 2>&1); local rc=$?
  if [ "$rc" = 2 ] && grep -qi -- "$want" <<<"$out" && [ ! -e "$B/artifacts" ] && [ "$(G rev-parse HEAD)" = "$head0" ]; then ok "refused: $d"
  else bad "refused: $d (exit $rc: ${out:0:160})"; fi
}
echo '== refusals'
export BEADS_ACTOR=platform
refused "no file" "usage" "$A" ab-1
refused "a bad item id" "not an item id" "$A" 'AB-1' "$T/shot.png"
refused "an id with a path in it" "not an item id" "$A" '../ab-1' "$T/shot.png"
refused "no actor" "no actor" env -u BEADS_ACTOR "$A" ab-1 "$T/shot.png"
refused "a type the viewer can't show (.exe)" "cannot show" "$A" ab-1 "$T/tool.exe"
refused "a log not as .txt" "as .txt" "$A" ab-1 "$T/run.log"
refused "over 5 MB" "5 MB" "$A" ab-1 "$T/big.png"
refused "a leading dot" "leading dot" "$A" ab-1 "$T/.hidden.md"
refused "a space in the name" "only A-Z" "$A" ab-1 "$T/with space.md"
refused "a file in secrets/" "secrets folder" "$A" ab-1 "$B/secrets/inside.md"
refused "a private key in a file" "secret" "$A" ab-1 "$T/notes.md" "$T/key.txt"
refused "a token in a file (with a good one: nothing copied)" "secret" "$A" ab-1 "$T/shot.png" "$T/token.md"
refused "a folder" "no such file" "$A" ab-1 "$T"
refused "the same name twice" "named twice" "$A" ab-1 "$T/notes.md" "$T/notes.md"
out=$("$A" ab-1 "$T/key.txt" 2>&1); grep -q 'AAAA' <<<"$out" && bad "the scan printed what it found" || ok "the scan names the kind, never the value"

echo '== a good run'
printf 'x\n' >>"$B/CLAUDE.md"; G add CLAUDE.md  # someone else's staged work: it stays staged, out of the commit
out=$(BEADS_ACTOR=platform/artifacts "$A" ab-1.2 "$T/shot.png" "$T/notes.md" "$T/run.txt" 2>&1); rc=$?
check "exit 0" test "$rc" = 0
check "prints the path of each, to quote" test "$out" = "$(printf 'artifacts/ab-1.2/shot.png\nartifacts/ab-1.2/notes.md\nartifacts/ab-1.2/run.txt')"
check "copied, same bytes" cmp "$T/shot.png" "$B/artifacts/ab-1.2/shot.png"
check "one commit, the message names the item and the files" test "$(G log -1 --format=%s)" = "artifact ab-1.2: shot.png notes.md run.txt"
check "the author is the caller's role (not the worker's name)" test "$(G log -1 --format=%an)" = platform
check "the commit holds only those files" test "$(G show --name-only --format= HEAD | sort | tr '\n' ' ')" = "artifacts/ab-1.2/notes.md artifacts/ab-1.2/run.txt artifacts/ab-1.2/shot.png "
check "other staged work stays staged, not committed" test "$(G diff --cached --name-only)" = CLAUDE.md
G reset -q CLAUDE.md; G checkout -q CLAUDE.md
check "not ignored by the root repo's .gitignore" sh -c "test -z \"\$(git -C '$B' status --porcelain --ignored artifacts)\""
n=$(G rev-list --count HEAD)
out=$(BD_ACTOR=ops "$A" ab-1.2 "$T/notes.md" 2>&1); rc=$?
check "the same file again: exit 0, no new commit, the path printed" sh -c "[ $rc = 0 ] && [ \$(git -C '$B' rev-list --count HEAD) = $n ] && printf '%s' '$out' | grep -qx 'artifacts/ab-1.2/notes.md'"
printf '# Result, v2\n' >"$T/notes.md"
out=$(env -u BEADS_ACTOR BD_ACTOR=ops "$A" ab-1.2 "$T/notes.md" 2>&1)
check "a new version replaces it in place (BD_ACTOR works too)" sh -c "[ \"\$(git -C '$B' log -1 --format=%an/%s)\" = 'ops/artifact ab-1.2: notes.md' ] && grep -q v2 '$B/artifacts/ab-1.2/notes.md'"

echo '== a commit the hook refuses keeps nothing'
mkdir -p "$B/.git/hooks"; printf '#!/bin/sh\necho "hook: no" >&2\nexit 1\n' >"$B/.git/hooks/pre-commit"; chmod +x "$B/.git/hooks/pre-commit"
n=$(G rev-list --count HEAD)
printf '# Result, v3\n' >"$T/notes.md"; cp "$T/notes.md" "$T/new.md"
out=$("$A" ab-1.2 "$T/notes.md" "$T/new.md" 2>&1); rc=$?
check "exit 2, says so" sh -c "[ $rc = 2 ] && printf '%s' '$out' | grep -q 'refused'"
check "no commit, nothing staged, the old version back, the new file gone" sh -c "[ \$(git -C '$B' rev-list --count HEAD) = $n ] && [ -z \"\$(git -C '$B' status --porcelain)\" ] && grep -q v2 '$B/artifacts/ab-1.2/notes.md' && [ ! -e '$B/artifacts/ab-1.2/new.md' ]"
rm -f "$B/.git/hooks/pre-commit"

echo '== a symlinked artifact folder is refused, nothing written through it (sy-6zi5)'
mkdir -p "$T/outside"; ln -s "$T/outside" "$B/artifacts/ab-9"
out=$("$A" ab-9 "$T/run.txt" 2>&1); rc=$?
check "a symlinked item folder: exit 2, says so" sh -c "[ $rc = 2 ] && printf '%s' '$out' | grep -q 'symlink'"
check "...nothing written through it" sh -c "[ -z \"\$(ls -A '$T/outside')\" ]"
rm "$B/artifacts/ab-9"
mv "$B/artifacts" "$T/real-artifacts"; ln -s "$T/real-artifacts" "$B/artifacts"
n=$(G rev-list --count HEAD)
out=$("$A" ab-8 "$T/run.txt" 2>&1); rc=$?
check "a symlinked artifacts/: exit 2, says so" sh -c "[ $rc = 2 ] && printf '%s' '$out' | grep -q 'symlink'"
check "...nothing written through it, no commit" sh -c "[ ! -e '$T/real-artifacts/ab-8' ] && [ \$(git -C '$B' rev-list --count HEAD) = $n ]"
rm "$B/artifacts"; mv "$T/real-artifacts" "$B/artifacts"

echo '== config-check --staged checks every staged artifact (the pre-commit hook)'
cc() { (cd "$B" && node bin/config-check "$@"); }
check "config-check passes with the committed artifacts" cc --render
check "config-check --staged passes a clean staged artifact" sh -c "cp '$T/run.txt' '$B/artifacts/ab-1.2/more.txt' && git -C '$B' add artifacts && cd '$B' && node bin/config-check --staged"
G reset -q; rm -f "$B/artifacts/ab-1.2/more.txt"
staged_refused() { # <what> <expected words> <path in the repo> <source file>
  mkdir -p "$(dirname "$B/$3")"; cp "$4" "$B/$3"; G add -f "$3"
  local out; out=$(cc --staged 2>&1); local rc=$?
  if [ "$rc" != 0 ] && grep -q -- "$2" <<<"$out" && ! grep -q 'AAAA\|ghp_abc' <<<"$out"; then ok "config-check refuses $1"; else bad "config-check refuses $1 (exit $rc: ${out:0:200})"; fi
  G reset -q; rm -f "$B/$3"
}
staged_refused "a token shape, committed by hand" "looks like a GitHub token" artifacts/ab-1.2/token.md "$T/token.md"
staged_refused "a private key, committed by hand" "looks like a private key" artifacts/ab-1.2/key.txt "$T/key.txt"
staged_refused "an artifact outside an item's folder" "artifacts/<item-id>/<name>" artifacts/loose.md "$T/notes.md"
staged_refused "a type the viewer can't show" "artifacts/<item-id>/<name>" artifacts/ab-1.2/tool.exe "$T/tool.exe"
staged_refused "a dot name" "artifacts/<item-id>/<name>" artifacts/ab-1.2/.x.md "$T/notes.md"
staged_refused "over 5 MB" "at most 5 MB" artifacts/ab-1.2/big.png "$T/big.png"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
