#!/usr/bin/env bash
# template bin/deploy and bin/app-run (sy-plpv), hermetic: a throwaway project whose product repo has an npm release,
# Bun releases (bun.lock) and one whose build fails; stand-ins on PATH for bun, npm and curl (each records its calls),
# and for bin/svc. No server, no port: the health check's curl answers 200 only for the path the release names.
#   test/deploy.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
P="$T/acme/shop"; S="$T/stub"; mkdir -p "$P/bin" "$P/.run" "$P/code" "$S"
cp "$SRC/template/bin/deploy" "$SRC/template/bin/app-run" "$P/bin/"
printf '{"processes": {"app": {}}}\n' >"$P/.run/services.json"
cat >"$P/bin/svc" <<EOF
#!/bin/sh
case "\$1" in url) echo http://app.test ;; restart) echo "restart \$2 \$(git -C "$P/release" log -1 --format=%s)" >>"$T/svc.log" ;; esac
EOF
# bun: records "<folder> <args>" (and DATA_DIR/HOST when it runs the app); `run build` fails where the release has BREAK
cat >"$S/bun" <<EOF
#!/bin/sh
echo "\$(basename "\$PWD") \$*" >>"$T/bun.log"
case "\$1" in
  install) mkdir -p node_modules ;;
  run) [ ! -e BREAK ] || { echo "error: vite build failed: cannot resolve ./missing" >&2; exit 1; }
       rm -rf .output; mkdir -p .output/server; echo "built from \$(cat version)" >.output/server/index.mjs ;;
  .output/server/index.mjs) echo "app DATA_DIR=\$DATA_DIR HOST=\$HOST" >>"$T/bun.log" ;;
esac
EOF
printf '#!/bin/sh\necho "$(basename "$PWD") $*" >>"%s/npm.log"\n' "$T" >"$S/npm"
# curl: the last argument is the URL; 200 only at the path in $T/ok-path
printf '#!/bin/sh\nfor u; do :; done; echo "$u" >>"%s/curl.log"; [ "${u#http://app.test}" = "$(cat %s/ok-path)" ] && printf 200 || printf 404\n' "$T" "$T" >"$S/curl"
chmod +x "$P/bin/"* "$S/"*
export PATH="$S:$PATH" MM_TRACE_SELF="$P/bin/deploy"
unset DEPLOY_HEALTH_PATH

# the product repo: c-npm, c-bun, c-break (build fails), c-nobuild (bun.lock, no build script)
C="$P/code"; git -C "$C" init -q -b main
commit() { git -C "$C" add -A && git -C "$C" commit -q -m "$1"; }
echo '{"name":"shop","dependencies":{"x":"1"}}' >"$C/package.json"; echo npm >"$C/version"; commit c-npm
echo '{"name":"shop","scripts":{"build":"vite build"},"mm":{"app":{"command":"bun .output/server/index.mjs","health":"/api/health"}}}' >"$C/package.json"
echo '{}' >"$C/bun.lock"; echo bun >"$C/version"; commit c-bun
touch "$C/BREAK"; echo broken >"$C/version"; commit c-break
rm "$C/BREAK"; echo '{"name":"shop","mm":{"app":{"health":"/up"}}}' >"$C/package.json"; echo nobuild >"$C/version"; commit c-nobuild
rev() { git -C "$C" log --format=%h --grep="^$1\$"; }
dep() { : >"$T/bun.log"; : >"$T/npm.log"; : >"$T/curl.log"; : >"$T/svc.log"; OUT=$("$P/bin/deploy" "$@" 2>"$T/err"); RC=$?; }

echo "== an npm release (no bun.lock): as before"
echo / >"$T/ok-path"; dep "$(rev c-npm)"
check "it deploys (exit 0), healthy at /" sh -c "[ $RC = 0 ] && echo '$OUT' | grep -q 'healthy at http://app.test/)'"
check "npm ci --omit=dev in release/, no bun at all" sh -c "grep -qx 'release ci --omit=dev --silent --no-audit --no-fund' '$T/npm.log' && [ ! -s '$T/bun.log' ]"
check "the app restarted on it" grep -qx 'restart app c-npm' "$T/svc.log"
check "its start command: none of its own (app-run conf prints nothing: node server.js)" sh -c "[ -z \"\$('$P/bin/app-run' conf command '$P/release')\" ]"
check "DATA_DIR's folder (data/app) is made, 0700" sh -c "[ \$(stat -c %a '$P/data/app') = 700 ]"

echo "== a Bun release (bun.lock, a build script, its own command and health path)"
echo /api/health >"$T/ok-path"; dep "$(rev c-bun)"
check "it deploys (exit 0), healthy at its health path" sh -c "[ $RC = 0 ] && echo '$OUT' | grep -q 'healthy at http://app.test/api/health)'"
check "built apart first: bun install --frozen-lockfile, then bun run build, in .deploy-build/" sh -c "sed -n 1,2p '$T/bun.log' | tr '\n' '|' | grep -qx '.deploy-build install --frozen-lockfile|.deploy-build run build|'"
check "...then the same in release/ (dev deps: no --production), then the restart" sh -c "sed -n 3,4p '$T/bun.log' | tr '\n' '|' | grep -qx 'release install --frozen-lockfile|release run build|' && grep -qx 'restart app c-bun' '$T/svc.log'"
check "no npm" test ! -s "$T/npm.log"
check "release/ has the build output" grep -qx 'built from bun' "$P/release/.output/server/index.mjs"
check "the health check asked its path, /api/health" grep -qx 'http://app.test/api/health' "$T/curl.log"
check "app-run conf: command and health from package.json's mm.app" sh -c "[ \"\$('$P/bin/app-run' conf command '$P/release')\" = 'bun .output/server/index.mjs' ] && [ \"\$('$P/bin/app-run' conf health '$P/release')\" = /api/health ]"
rm -rf "$T/dd"; : >"$T/bun.log"
(cd "$P/release" && DATA_DIR="$T/dd/app" HOST=127.0.0.1 "$P/bin/app-run")
check "app-run (the app slot's command) runs it in release/, DATA_DIR made 0700 and passed, HOST as given" sh -c "grep -qx 'release .output/server/index.mjs' '$T/bun.log' && grep -qx 'app DATA_DIR=$T/dd/app HOST=127.0.0.1' '$T/bun.log' && [ \$(stat -c %a '$T/dd/app') = 700 ]"
echo 'secret-ish' >"$P/data/app/keep.db"

echo "== a Bun release whose build fails: production stays"
dep "$(rev c-break)"
check "deploy fails (exit 1) and says why: the build's own error, and that production stays on c-bun" sh -c "[ $RC = 1 ] && grep -q 'vite build failed: cannot resolve' '$T/err' && grep -q \"not deployed: its build failed; production stays on $(rev c-bun)\" '$T/err'"
check "release/ untouched: still c-bun, its build output there, no install or build in it" sh -c "[ \"\$(git -C '$P/release' log -1 --format=%s)\" = c-bun ] && grep -qx 'built from bun' '$P/release/.output/server/index.mjs' && ! grep -q '^release ' '$T/bun.log'"
check "no restart, no health check" sh -c "[ ! -s '$T/svc.log' ] && [ ! -s '$T/curl.log' ]"
check "the release log says build-failed (rollback skips it)" sh -c "tail -1 '$P/.releases' | grep -q \" $(rev c-break) build-failed \""
check "DATA_DIR's files stay" test -f "$P/data/app/keep.db"

echo "== bun.lock with no build script: install only; DEPLOY_HEALTH_PATH wins over the release's"
echo /healthz >"$T/ok-path"; DEPLOY_HEALTH_PATH=/healthz dep "$(rev c-nobuild)"
check "it deploys at DEPLOY_HEALTH_PATH" sh -c "[ $RC = 0 ] && grep -qx 'http://app.test/healthz' '$T/curl.log'"
check "bun install only (twice: apart, then release/), no bun run build" sh -c "[ \$(grep -c ' install --frozen-lockfile\$' '$T/bun.log') = 2 ] && ! grep -q ' run build' '$T/bun.log'"

echo "== deploy rollback: back to the previous ok release (c-bun), rebuilt"
echo /api/health >"$T/ok-path"; dep rollback
check "it deploys c-bun again, built apart and in release/" sh -c "[ $RC = 0 ] && [ \"\$(git -C '$P/release' log -1 --format=%s)\" = c-bun ] && [ \$(grep -c ' run build\$' '$T/bun.log') = 2 ]"

echo "== the template's app slot"
check "services.yaml: the app runs bin/app-run, DATA_DIR is data/app" sh -c "grep -q 'command: \"HOST=\$\${MM_BIND:-\$\$HOST} exec {root}/bin/app-run\"' '$SRC/template/services.yaml' && grep -q 'DATA_DIR: \"{root}/data/app\"' '$SRC/template/services.yaml'"

echo; echo "deploy: $pass passed, $fail failed"
[ "$fail" = 0 ]
