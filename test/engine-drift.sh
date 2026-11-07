#!/usr/bin/env bash
# Engine drift (sy-h5se), hermetic: a project adopted in place kept an engine file behind the template, because each
# three-way merge read "the base has it, the project doesn't" as the project's own removal. mm update --drift names
# such files; --reset puts back only those no project commit changed, in one mm commit. A throwaway HOME / MM_HOME and
# a project laid out as mm new lays it out (nothing started).
#   test/engine-drift.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME" "$T/bin"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
ROOT="$MM_HOME/projects/acme/shop"
G() { git -C "$ROOT" -c user.name=mm -c user.email=mm@acme-shop.local "$@"; }

cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template, templateCommit } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
import { run } from '$SRC/src/env'
const root = process.argv[2], t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'shop', project: 'acme-shop', short: 'sh', root, template_version: t.version, created: new Date().toISOString(), throwaway: true }, null, 2) + '\n')
const vars = templateVars(root)
renderTo(root, vars, t)
const git = (a: string[]) => { const r = run(['git', '-C', root, ...a]); if (!r.ok) throw new Error(a.join(' ') + ': ' + r.err); return r.out.trim() }
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'mm']); git(['config', 'user.email', 'mm@acme-shop.local'])
const base = templateCommit(root, vars, 'template ' + t.version, undefined, t)
git(['reset', '-q', base]); git(['branch', 'mm-template', base])
git(['add', '-A']); git(['commit', '-q', '-m', 'mm new acme/shop'])
EOF
echo "== a project, as mm new leaves it"
check "laid out (template, config repo, mm-template)" bun "$T/stamp.ts" "$ROOT"
check "mm update --drift: nothing (exit 0)" sh -c "mm update acme/shop --drift >'$T/d.out' 2>&1; [ \$? = 0 ] && ! grep -q 'bin/' '$T/d.out'"

echo "== drift as a real project got it: an mm update that kept a function out, and the project's own edit of another file"
SVC=bin/lib/svc.mjs
check "the template's svc.mjs has serviceLogs" grep -q 'export function serviceLogs' "$ROOT/$SVC"
sed -i '/^\/\*\* Recent log lines of one service/,/^}/d' "$ROOT/$SVC"
G commit -q -am 'mm update: template 0.1.1+aaaa -> 0.1.1+bbbb'
echo '# our own backup tweak' >>"$ROOT/bin/backup"; G commit -q -am 'backup: keep 30 days'
check "...svc.mjs lost it (as a real project's did)" sh -c "! grep -q 'export function serviceLogs' '$ROOT/$SVC'"
mm update acme/shop --drift >"$T/d.out" 2>&1; RC=$?
check "mm update --drift: exit 1 (mm has a file to put back)" [ "$RC" = 1 ]
check "...svc.mjs: baseline (mm update --reset puts it back)" grep -q "$SVC  *baseline" "$T/d.out"
check "...bin/backup: the project's own commit" sh -c "grep -q 'bin/backup  *project commit' '$T/d.out'"
check "...and no other file" sh -c "[ \$(grep -c 'acme-shop' '$T/d.out') = 2 ]"
check "mm update --drift -o json: the same, as data" sh -c "mm update acme/shop --drift -o json | jq -e 'length == 2 and (map(.path) | index(\"$SVC\")) != null'"

echo "== mm update --reset"
H0=$(G rev-parse HEAD)
check "--reset bin/backup: refused, the project's own commit changed it" sh -c "! mm update acme/shop --reset bin/backup >'$T/r.out' 2>&1 && grep -q \"the project's own commit\" '$T/r.out'"
check "--reset bin/lead (not drifted): refused" sh -c "! mm update acme/shop --reset bin/lead >'$T/r.out' 2>&1 && grep -q 'not drifted' '$T/r.out'"
check "--reset services.yaml (not an engine file): refused" sh -c "! mm update acme/shop --reset services.yaml >'$T/r.out' 2>&1 && grep -q 'only engine files' '$T/r.out'"
check "--reset with -n: says what it would do, changes nothing" sh -c "mm update acme/shop --reset $SVC -n >'$T/r.out' 2>&1 && grep -q 'would put back' '$T/r.out' && [ \"\$(git -C '$ROOT' rev-parse HEAD)\" = $H0 ] && ! grep -q 'export function serviceLogs' '$ROOT/$SVC'"
echo '# not committed' >>"$ROOT/bin/health"
check "--reset on a dirty tree: refused" sh -c "! mm update acme/shop --reset $SVC >'$T/r.out' 2>&1 && grep -q 'commit or discard' '$T/r.out'"
G checkout -q -- bin/health
check "--reset $SVC: ok, in one mm commit" sh -c "mm update acme/shop --reset $SVC >'$T/r.out' 2>&1 && grep -q 'as template' '$T/r.out'"
check "...the file is the template's again (serviceLogs back)" sh -c "grep -q 'export function serviceLogs' '$ROOT/$SVC' && git -C '$ROOT' diff --quiet refs/heads/mm-template HEAD -- $SVC"
check "...one commit, by mm, naming the file" sh -c "[ \"\$(git -C '$ROOT' rev-list --count $H0..HEAD)\" = 1 ] && git -C '$ROOT' log -1 --format=%s | grep -q '^mm: reset $SVC to template'"
check "...the project's own edit is kept" grep -q 'our own backup tweak' "$ROOT/bin/backup"
check "mm update --drift: only the project's file is left (exit 0)" sh -c "mm update acme/shop --drift >'$T/d.out' 2>&1; [ \$? = 0 ] && grep -q 'bin/backup' '$T/d.out' && ! grep -q '$SVC' '$T/d.out'"
check "--reset no project named: refused" sh -c "! mm update --reset $SVC >/dev/null 2>&1"

echo "== a box project: its engine comes from mm's seal, not from --reset"
sed -i 's/^throwaway: true$/throwaway: true\nbox: true/' "$ROOT/.mm-answers.yaml"; G commit -q -am 'box'
check "--reset on a box project: refused, and it says why" sh -c "! mm update acme/shop --reset $SVC >'$T/r.out' 2>&1 && grep -q 'box project' '$T/r.out'"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
