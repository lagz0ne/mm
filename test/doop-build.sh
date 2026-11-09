#!/usr/bin/env bash
# box/doop/build.sh, hermetic (no Docker: a stub in its place): the build context it hands to `docker build` is
# readable by Doop's own uid whatever the caller's umask. The image's files are root's (COPY) and Doop runs as
# 210000 + n, so a file left 0600 by tar -x or git apply under umask 077 stopped Doop at boot (EACCES on
# /app/server/index.ts) and left the fork's unit tests unreadable. Also: the base is checked by id, the patches apply
# in order, the image's id is printed.
#   test/doop-build.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'chmod -R u+rwX "$T" 2>/dev/null; rm -rf "$T"' EXIT
OUT="$T/check.out"
check() { local d=$1; shift; if "$@" >"$OUT" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$OUT" | sed 's/^/       /'; fi; }
BASE_ID=$(sed -n 's/^BASE_ID=\(sha256:[0-9a-f]\{64\}\).*/\1/p' "$HERE/box/doop/build.sh")
NEW_ID=sha256:$(printf '%064d' 7)

# a box/doop of its own: this build.sh and Dockerfile, a small patch (a changed file, a new one) in place of the fork's
mkdir -p "$T/box/doop" "$T/up/server/lib" "$T/up/shared" "$T/log"
cp "$HERE/box/doop/build.sh" "$HERE/box/doop/Dockerfile" "$T/box/doop/"
printf '{"name":"doop"}\n' >"$T/up/package.json"
printf 'export const a = 1\n' >"$T/up/server/index.ts"; printf 'export const b = 2\n' >"$T/up/server/lib/b.ts"
printf 'export const s = 3\n' >"$T/up/shared/s.ts"
chmod -R a+rX,go-w "$T/up"
cp -r "$T/up" "$T/fork"; printf 'export const a = 1\nexport const gw = true\n' >"$T/fork/server/index.ts"
printf 'export const n = 4\n' >"$T/fork/server/lib/new.ts"
(cd "$T" && git diff --no-index --src-prefix=a/ --dst-prefix=b/ up fork | sed -e 's#a/up/#a/#g; s#b/fork/#b/#g' >"$T/box/doop/0001-test.patch")
# the stub docker: the base's id, the source as a tar stream (cp ... -), and a build that records what in its context
# server/ and shared/ another uid could not read (a file not o+r, a folder not o+rx)
cat >"$T/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$T/log/calls"
case "\$1 \$2" in
  "image inspect") case "\${@: -1}" in mm-doop:0.12.0) echo "$BASE_ID" ;; mm-doop:moved) echo sha256:$(printf '%064d' 9) ;; mm-doop:gwqa-*) echo "$NEW_ID" ;; *) exit 1 ;; esac ;;
  "create "*|"rm "*) ;;
  "cp "*) d=\${2#*:/app/}; tar -c -C "$T/up" "\$d" ;;
  "build "*) ctx=\${@: -1}; { find "\$ctx/server" "\$ctx/shared" -type f ! -perm -o+r; find "\$ctx/server" "\$ctx/shared" -type d ! -perm -o+rx; } >"$T/log/unreadable"
             cp -r "\$ctx/server" "$T/log/server" ;;
  *) echo "stub docker: \$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$T/docker"
build() { (umask "$1"; shift; DOCKER="$T/docker" "$T/box/doop/build.sh" "$@"); }
export -f build; export T

echo "== box/doop/build.sh under umask 077 (the gates' and the leads' shells)"
check "it builds and prints the new image's id" bash -c "[ \"\$(build 077 mm-doop:gwqa-1)\" = '$NEW_ID' ]"
check "...the patch is in the context (a changed file, a new one)" bash -c "grep -q 'gw = true' '$T/log/server/index.ts' && [ -f '$T/log/server/lib/new.ts' ]"
check "...every file of server/ and shared/ is world-readable, every folder world-searchable (Doop's uid reads them)" bash -c "[ -f '$T/log/unreadable' ] && [ ! -s '$T/log/unreadable' ] || { cat '$T/log/unreadable'; exit 1; }"
check "...nothing in it is group- or world-writable" bash -c "[ -z \"\$(find '$T/log/server' -perm /022 -type f)\" ]"
rm -rf "$T/log/server" "$T/log/unreadable"
check "under umask 022 the same" bash -c "[ \"\$(build 022 mm-doop:gwqa-2)\" = '$NEW_ID' ] && [ -f '$T/log/unreadable' ] && [ ! -s '$T/log/unreadable' ]"
check "a base that is not the pinned image is refused, nothing built" bash -c ": >'$T/log/calls'; ! build 077 mm-doop:gwqa-3 mm-doop:moved 2>'$T/err' && grep -q refused '$T/err' && ! grep -q '^build' '$T/log/calls'"
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
