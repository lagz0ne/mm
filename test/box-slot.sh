#!/usr/bin/env bash
# A box's app slot, whoever writes the box's process file (sy-jm5), hermetic: a throwaway HOME / MM_HOME, a registered
# box project (its folder only, no container), stand-ins for Docker (the box runs, at an address) and the host's process
# manager. The project API is on only through a test's environment (MM_API_ENABLED + MM_API_DIR, as test/box.sh runs
# it; the machine's config has it off). Proves: the mm with that environment puts the approved build on the slot; an mm
# without it (another mm up, mm update, box on on the machine) keeps the slot on that build too, and the granted sites
# on the egress list, never release/; after an undo, both write no app; the test's store gone, or only the machine's
# own store noted (the owner turned the API off): the app slot runs release/ as before the API.
#   test/box-slot.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept: $T" || rm -rf "$T"' EXIT
export T HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE MM_API_ENABLED MM_API_DIR
mkdir -p "$MM_HOME/pc/boxes" "$T/bin"
# only this test's stand-ins: never the machine's Docker or process manager
export PATH="$T/bin:$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin"
cat >"$T/bin/fakedocker" <<'EOF'
#!/bin/sh
echo "$*" >> "$T/docker.log"
case "$1" in
  inspect) case "$*" in *State.Running*) echo true ;; *IPAddress*) echo 10.231.5.10 ;; *) echo '[]' ;; esac ;;
esac
exit 0
EOF
printf '#!/bin/sh\necho "$*" >>"$T/pc.log"\necho "[]"\n' >"$T/bin/process-compose"
chmod +x "$T/bin/fakedocker" "$T/bin/process-compose"; export MM_DOCKER="$T/bin/fakedocker"
R="$HOME/projects/acme/shop"; mkdir -p "$R/release/v1"
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: as\nroot: %s\ntemplate_version: test\ncreated: "2026-01-01"\nthrowaway: true\nbox: true\n' "$R" >"$R/.mm-answers.yaml"
printf 'version: 1\nservices:\n  board:\n    command: "node x"\n    port: http\n  app:\n    optional: true\n    command: "node server.js"\n    workdir: "{root}/release"\n    port: http\n' >"$R/services.yaml"
echo "# from $R/services.yaml" >"$MM_HOME/pc/boxes/acme-shop.yaml"
PCY="$MM_HOME/box/acme-shop/cfg/pc.yaml"
# one step, as an mm process: grant <build|-> [site], reload (mm.api's apply: the box's file again), slot (what resolve
# gives the app slot: its workdir, or "none"), egress (the box's list)
cat >"$T/w.ts" <<EOF
import { saveGranted } from '$SRC/src/apistate'
import { appReload, carryHostApp, egressList, uncarryHostApp } from '$SRC/src/box'
import { resolve } from '$SRC/src/project'
const [what, x, y] = process.argv.slice(2), root = '$R'
if (what === 'carry' || what === 'uncarry') { const st = what === 'carry' ? carryHostApp(root) : uncarryHostApp(root); console.log(JSON.stringify(st)); if (st.some((s) => s.status === 'fail')) process.exit(1) }
if (what === 'grant') saveGranted('acme-shop', { routes: [], egress: y ? [{ site: y, id: 'r-2' }] : [], release: x === '-' ? null : { build: x, id: 'r-1' }, secrets: [] })
if (what === 'reload') { const st = appReload(root); if (st.some((s) => s.status === 'fail')) { console.error(JSON.stringify(st)); process.exit(1) } }
if (what === 'slot') console.log(resolve(root).services.app?.workdir ?? 'none')
if (what === 'egress') console.log(egressList(root).join('\n'))
EOF
TESTAPI() { MM_API_ENABLED=1 MM_API_DIR="$T/store" bun "$T/w.ts" "$@"; }   # the test's mm (its own mm.api's environment)
OTHER() { bun "$T/w.ts" "$@"; }                                              # another mm on the machine: no such environment
appdir() { awk '/^  acme-shop\.app:/ { a = 1; next } /^  [^ ]/ { a = 0 } a && /working_dir:/ { print $2 }' "$PCY"; }
export -f TESTAPI OTHER appdir; export R PCY

echo "== the API on through the test's environment: the approved build on the app slot"
check "with nothing granted: no app slot (release/ runs nowhere)" sh -c "[ \"\$(TESTAPI slot)\" = none ]"
check "release v1 and the site api.example.org granted, the box's file again: the slot runs release/v1, by the box's own process manager" sh -c "TESTAPI grant v1 api.example.org && TESTAPI reload && [ \"\$(appdir)\" = '$R/release/v1' ] && grep -q 'exec mm-box-acme-shop process-compose -U -u /run/mm/sock/pc.sock project update' '$T/docker.log'"
check "...mm noted the store it wrote from, in the host's folder for the box (no box mounts it)" sh -c "jq -e --arg d '$T/store' '.dir == \$d' '$MM_HOME/box/acme-shop/api-store.json'"

echo "== another mm, without that environment, writes the box's file"
check "it gives the app slot release/v1 too (not release/)" sh -c "[ \"\$(OTHER slot)\" = '$R/release/v1' ]"
check "...and its file keeps the slot on release/v1" sh -c "OTHER reload && [ \"\$(appdir)\" = '$R/release/v1' ]"
check "...and the granted site stays on the box's egress list" sh -c "OTHER egress | grep -qx api.example.org"
check "undone (no build granted) by the test's mm: no app slot in the file, from either mm" sh -c "TESTAPI grant - && TESTAPI reload && [ -z \"\$(appdir)\" ] && [ \"\$(OTHER slot)\" = none ] && OTHER reload && [ -z \"\$(appdir)\" ]"

echo "== when that API is gone"
check "the test's store removed: the app slot runs release/ again (as before the API)" sh -c "rm -rf '$T/store' && [ \"\$(OTHER slot)\" = '$R/release' ]"
check "the machine's own store noted (its config had the API on), the API off now: release/ again (the owner turned it off)" sh -c "MM_API_ENABLED=1 bun '$T/w.ts' reload && jq -e --arg d '$MM_HOME/api' '.dir == \$d' '$MM_HOME/box/acme-shop/api-store.json' && [ \"\$(OTHER slot)\" = '$R/release' ]"
check "nothing of the box on the host's process manager" sh -c "! grep -q 'acme-shop\\.' '$T/pc.log' 2>/dev/null"

echo "== the app the host ran, into the box at box on and back at box off (sy-im89)"
rm -rf "$T/store" "$R/release"; mkdir -p "$R/release/lib"; echo 'srv' >"$R/release/server.js"; echo 'x' >"$R/release/lib/x.js"
check "box on with the API on: the host's app moves to release/host-<time>/, recorded as the box's build (id box-on)" sh -c "TESTAPI carry >'$T/carry.out' && b=\$(jq -r '.release.build' '$T/store/granted/acme-shop.json') && echo \"\$b\" | grep -Eq '^host-[0-9]{8}t[0-9]{6}\$' && jq -e '.release.id == \"box-on\"' '$T/store/granted/acme-shop.json' && [ -f '$R/release/'\$b/server.js ] && [ -f '$R/release/'\$b/lib/x.js ] && [ ! -e '$R/release/server.js' ]"
check "...the box's app slot runs it" sh -c "b=\$(jq -r '.release.build' '$T/store/granted/acme-shop.json'); [ \"\$(TESTAPI slot)\" = '$R/release/'\$b ]"
check "...a second box on carries nothing more (a build is granted already)" sh -c "TESTAPI carry | grep -qx '\\[\\]'"
check "box off: the app is back in release/, its record gone, and the host runs release/ again" sh -c "TESTAPI uncarry >/dev/null && [ -f '$R/release/server.js' ] && [ -f '$R/release/lib/x.js' ] && ! ls '$R/release' | grep -q '^host-' && jq -e '.release == null' '$T/store/granted/acme-shop.json'"
check "...a build the owner approved through the API (not carried) stays where it is at box off" sh -c "TESTAPI grant v9 && mkdir -p '$R/release/v9' && TESTAPI uncarry | grep -qx '\\[\\]' && [ -d '$R/release/v9' ] && jq -e '.release.build == \"v9\"' '$T/store/granted/acme-shop.json'"
check "with the API off: nothing is carried (the slot runs release/ as on the host)" sh -c "rm -rf '$T/store' && OTHER carry | grep -qx '\\[\\]' && [ -f '$R/release/server.js' ]"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
