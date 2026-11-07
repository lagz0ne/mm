#!/usr/bin/env bash
# The install kind npm-lock (sy-nli), hermetic: a throwaway HOME / MM_HOME, a stub npm first on PATH (no network, no
# machine npm). Proves:
#  1. the lock mm ships (deps/paseo): lockfileVersion 3, @getpaseo/cli exactly the manifest's tested version, every
#     package with its integrity; the manifest's paseo installs from it, portless stays on the npm kind
#  2. install: package.json and package-lock.json copied byte for byte into MM_HOME/npm/paseo, `npm ci --no-audit
#     --no-fund --ignore-scripts` with npm's cache in MM_HOME, no folder left half-made, only the direct dependency's
#     bin linked into MM_HOME/bin (not every bin of the tree); again: replaced in place
#  3. who finds Paseo still finds it: the process manager's mm.paseo runs the lock's bin; paseo.mjs sdkPath() walks
#     from the linked binary to the client package of the same tree
#  4. doctor's paseo row: ok when installed from the lock; fail (fix mm onboard) for another @getpaseo/cli version,
#     another lock, a binary run from elsewhere, nothing installed; the old npm -g copy: its own warn row, the tool ok
#  5. a lock without integrity (or not v3, or a range): refused, npm never called, nothing written
#  6. the compiled binary carries the lock (given as $1: e.g. dist/mm)
#   test/npm-lock.sh [compiled mm]
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
has()  { printf '%s' "$1" | grep -qE -- "$2"; }            # has <text> <regex>
jqok() { printf '%s' "$1" | jq -e "$2" >/dev/null 2>&1; }  # jqok <json> <filter>
T=$(mktemp -d)
cleanup() { rm -rf "$T"; }
trap cleanup EXIT
[ -n "${KEEP:-}" ] && trap - EXIT && echo "kept: $T"
command -v jq >/dev/null || { echo 'needs jq'; exit 2; }
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 MM_OBS_TRACES="" XDG_RUNTIME_DIR="$T/run" HOME="$T/home" MM_HOME="$T/home/.mm"
unset npm_config_cache npm_config_prefix
mkdir -p "$T/bin" "$T/run" "$HOME"
ln -s "$BUN" "$T/bin/bun"
ln -s "$(command -v jq)" "$T/bin/jq"
# the stub npm: logs its argv and cache; `ci --prefix P` makes the tree a real npm ci of the lock makes, in miniature:
# node_modules/@getpaseo/cli (bin/paseo, the lock's version), @getpaseo/client, and a second package's bin (tsc)
cat >"$T/bin/npm" <<EOF
#!/bin/sh
echo "cache=\$npm_config_cache notifier=\$npm_config_update_notifier args=\$*" >>"$T/npm.calls"
[ "\$1" = ci ] || exit 0
p=\$3
[ -f "\$p/package-lock.json" ] || { echo "no lock in \$p" >&2; exit 1; }
v=\$(jq -r '.packages["node_modules/@getpaseo/cli"].version' "\$p/package-lock.json")
m=\$p/node_modules
mkdir -p "\$m/@getpaseo/cli/bin" "\$m/@getpaseo/client/dist" "\$m/typescript/bin" "\$m/.bin"
printf '{"name":"@getpaseo/cli","version":"%s","bin":{"paseo":"bin/paseo"}}\n' "\$v" >"\$m/@getpaseo/cli/package.json"
printf '#!/bin/sh\necho "%s"\n' "\$v" >"\$m/@getpaseo/cli/bin/paseo"; chmod +x "\$m/@getpaseo/cli/bin/paseo"
echo 'export const createPaseoClient = () => null' >"\$m/@getpaseo/client/dist/index.js"
printf '#!/bin/sh\n' >"\$m/typescript/bin/tsc"; chmod +x "\$m/typescript/bin/tsc"
ln -s ../@getpaseo/cli/bin/paseo "\$m/.bin/paseo"; ln -s ../typescript/bin/tsc "\$m/.bin/tsc"
EOF
chmod +x "$T/bin/npm"
export PATH="$MM_HOME/bin:$T/bin:/usr/bin:/bin"
ev() { (cd "$SRC" && "$BUN" -e "$1"); }
LOCK="$SRC/deps/paseo/package-lock.json" PKG="$SRC/deps/paseo/package.json"
D="$MM_HOME/npm/paseo"

echo "== 1. the lock mm ships"
is "lockfileVersion 3" [ "$(jq .lockfileVersion "$LOCK")" = 3 ]
tested=$(ev "import { manifest } from './src/manifest'; console.log(manifest.machine.tools.paseo.tested)")
is "package.json depends on exactly @getpaseo/cli@$tested (the manifest's tested one), nothing else" \
  [ "$(jq -c .dependencies "$PKG")" = "{\"@getpaseo/cli\":\"$tested\"}" ]
is "the lock's top entry is @getpaseo/cli $tested" [ "$(jq -r '.packages["node_modules/@getpaseo/cli"].version' "$LOCK")" = "$tested" ]
n=$(jq '[.packages | to_entries[] | select(.key != "")] | length' "$LOCK")
is "every one of its $n packages has a resolved URL and a sha512 integrity" \
  [ "$(jq '[.packages | to_entries[] | select(.key != "" and (.value.integrity // "" | startswith("sha512-")) and (.value.resolved // "" | startswith("https://registry.npmjs.org/")))] | length' "$LOCK")" = "$n" ]
is "lockProblems: none" [ "$(ev "import { LOCKS, lockProblems } from './src/npmlock'; console.log(JSON.stringify(lockProblems(LOCKS.paseo)))")" = "[]" ]
is "the manifest: paseo from the lock, portless still npm" \
  [ "$(ev "import { manifest as m } from './src/manifest'; const t = m.machine.tools; console.log(t.paseo.install.kind, t.paseo.install.lock, t.portless.install.kind)")" = "npm-lock paseo npm" ]

echo "== 2. install"
out=$(ev "import { npmLock } from './src/install'; console.log(npmLock('paseo'))" 2>&1)
is "installed ($out)" has "$out" "^@getpaseo/cli@$tested \($n packages from mm's lock\) -> ~/.mm/npm/paseo; bin: paseo$"
is "package.json and package-lock.json copied byte for byte" bash -c "cmp -s '$PKG' '$D/package.json' && cmp -s '$LOCK' '$D/package-lock.json'"
call=$(grep 'args=ci' "$T/npm.calls")
is "npm ci --no-audit --no-fund --ignore-scripts, into the new folder (got: $call)" \
  has "$call" "args=ci --prefix $MM_HOME/npm/paseo\.new-[0-9]+ --no-audit --no-fund --ignore-scripts$"
is "...with npm's cache in MM_HOME and no update check" has "$call" "^cache=$MM_HOME/npm/\.cache notifier=false "
is "only one npm call (no install -g)" [ "$(wc -l <"$T/npm.calls")" = 1 ]
is "no new or old folder left next to it" bash -c "! ls -d '$MM_HOME'/npm/paseo.* 2>/dev/null | grep -q ."
is "MM_HOME/bin/paseo -> the lock's node_modules/.bin/paseo" [ "$(readlink "$MM_HOME/bin/paseo")" = "$D/node_modules/.bin/paseo" ]
is "...and runs it" [ "$(paseo)" = "$tested" ]
is "the tree's other bins are not linked (tsc)" bash -c "! [ -e '$MM_HOME/bin/tsc' ]"
echo stale >"$D/stale"; : >"$T/npm.calls"
ev "import { npmLock } from './src/install'; npmLock('paseo')" >/dev/null 2>&1
is "again: the tree is replaced (nothing of the old one left), one npm ci" bash -c "! [ -e '$D/stale' ] && [ -x '$D/node_modules/.bin/paseo' ] && [ \$(wc -l <'$T/npm.calls') = 1 ]"
is "a failed npm ci leaves the installed tree as it was" bash -c "
  printf '#!/bin/sh\nexit 1\n' >'$T/npm-fail'; chmod +x '$T/npm-fail'; mkdir -p '$T/failbin'; ln -sf '$T/npm-fail' '$T/failbin/npm'
  cd '$SRC' && PATH='$T/failbin:$PATH' '$BUN' -e \"import { npmLock } from './src/install'; try { npmLock('paseo'); process.exit(1) } catch {}\" &&
  [ -x '$D/node_modules/.bin/paseo' ] && ! ls -d '$MM_HOME'/npm/paseo.* 2>/dev/null | grep -q ."

echo "== 3. who finds Paseo"
is "the process manager's mm.paseo runs the lock's bin" \
  [ "$(ev "import { lockBin } from './src/npmlock'; console.log(lockBin('paseo', 'paseo'))")" = "$D/node_modules/.bin/paseo" ]
is "pc.ts uses it (not npm/bin/paseo)" bash -c "grep -q \"bin = lockBin('paseo', 'paseo')\" '$SRC/src/pc.ts' && ! grep -q \"DIRS.npm, 'bin', 'paseo'\" '$SRC/src/pc.ts'"
sdk=$(cd "$T" && PASEO_URL=ws://127.0.0.1:1/ws PASEO_SDK= "$BUN" -e "import { sdkPath } from '$SRC/template/bin/lib/paseo.mjs'; console.log(sdkPath())" 2>&1)
is "paseo.mjs sdkPath(): the client package of the same tree (got: $sdk)" [ "$sdk" = "$(realpath "$D")/node_modules/@getpaseo/client/dist/index.js" ]

echo "== 4. doctor's paseo row"
doc() { ev "import { checkTool, oldNpmCopy } from './src/doctor'; import { manifest } from './src/manifest'; import { loadConfig } from './src/config';
  const t = manifest.machine.tools.paseo, r = checkTool('paseo', t, loadConfig()), o = oldNpmCopy('paseo', t)
  console.log(JSON.stringify({ status: r.status, detail: r.detail, fix: r.fix ?? '', old: o ? o.status + ' ' + o.detail + ' | ' + o.fix : '' }))" 2>/dev/null; }
r=$(doc)
is "installed from the lock: ok, no old-copy row ($r)" jqok "$r" '.status == "ok" and .old == ""'
cp "$D/node_modules/@getpaseo/cli/package.json" "$T/cli.json"
jq '.version = "0.12.9"' "$T/cli.json" >"$D/node_modules/@getpaseo/cli/package.json"
r=$(doc)
is "another @getpaseo/cli version: fail, fix mm onboard ($r)" jqok "$r" '.status == "fail" and (.detail | test("0.12.9")) and (.fix | test("^mm onboard"))'
cp "$T/cli.json" "$D/node_modules/@getpaseo/cli/package.json"
cp "$D/package-lock.json" "$T/lock.json"; echo ' ' >>"$D/package-lock.json"
r=$(doc)
is "another lock than this mm's: fail ($r)" jqok "$r" '.status == "fail" and (.detail | test("another lock"))'
cp "$T/lock.json" "$D/package-lock.json"
mkdir -p "$MM_HOME/npm/bin"; printf '#!/bin/sh\necho %s\n' "$tested" >"$MM_HOME/npm/bin/paseo"; chmod +x "$MM_HOME/npm/bin/paseo"
r=$(doc)
is "the old npm -g copy still there: its own warn row with the uninstall, the tool row ok ($r)" \
  jqok "$r" '.status == "ok" and (.old | test("^warn ~/.mm/npm/bin/paseo .*npm uninstall -g --prefix ~/.mm/npm @getpaseo/cli$"))'
ln -sfn "$MM_HOME/npm/bin/paseo" "$MM_HOME/bin/paseo"
r=$(doc)
is "MM_HOME/bin/paseo still the old copy: fail, it runs from elsewhere ($r)" jqok "$r" '.status == "fail" and (.detail | test("not the one in ~/.mm/npm/paseo"))'
rm -rf "$D"
r=$(doc)
is "nothing installed from the lock: fail, fix mm onboard ($r)" jqok "$r" '.status == "fail" and (.detail | test("not installed from mm.s lock")) and (.fix | test("^mm onboard"))'

echo "== 5. an unfit lock is refused"
rm -rf "$MM_HOME/npm" "$MM_HOME/bin"; : >"$T/npm.calls"
refuse() { ev "import { LOCKS } from './src/npmlock'; import { npmLock } from './src/install'
  const l = JSON.parse(LOCKS.paseo.lock), p = JSON.parse(LOCKS.paseo.pkg); ($1)(l, p)
  LOCKS.paseo = { pkg: JSON.stringify(p), lock: JSON.stringify(l) }
  try { npmLock('paseo'); console.log('installed') } catch (e) { console.log(e.message) }" 2>&1; }
m=$(refuse "(l) => { delete l.packages['node_modules/@getpaseo/client'].integrity }")
is "a package without integrity: refused, named ($m)" has "$m" "refused: node_modules/@getpaseo/client: no integrity$"
m=$(refuse "(l) => { l.packages['node_modules/commander'].integrity = 'md5-abc' }")
is "an integrity that is not sha256/384/512: refused ($m)" has "$m" 'refused: node_modules/commander: no integrity$'
m=$(refuse "(l) => { l.lockfileVersion = 2 }")
is "lockfileVersion 2: refused ($m)" has "$m" 'refused: lockfileVersion 2, not 3$'
m=$(refuse "(l, p) => { p.dependencies['@getpaseo/cli'] = '^0.13.0' }")
is "a range in package.json: refused ($m)" has "$m" 'refused: @getpaseo/cli@\^0\.13\.0: not an exact version'
m=$(refuse "(l) => { l.packages['node_modules/@getpaseo/cli'].version = '0.13.1' }")
is "the lock's cli not package.json's: refused ($m)" has "$m" 'refused: @getpaseo/cli: the lock has 0\.13\.1, package\.json 0\.13\.0'
is "...npm never called, nothing written in MM_HOME" bash -c "! [ -s '$T/npm.calls' ] && ! [ -e '$MM_HOME/npm' ] && ! [ -e '$MM_HOME/bin' ]"

if [ -n "${1:-}" ]; then
  echo "== 6. the compiled binary carries the lock"
  integ=$(jq -r '.packages["node_modules/@getpaseo/cli"].integrity' "$LOCK")
  is "$1 has @getpaseo/cli's integrity and the package.json's description" bash -c "grep -qF '$integ' '$1' && grep -qF \"$(jq -r .description "$PKG")\" '$1'"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
