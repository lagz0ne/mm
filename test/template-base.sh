#!/usr/bin/env bash
# The base of a box project's mm update (review sy-055t), hermetic: a throwaway HOME / MM_HOME and a box project laid
# out as mm new --box lays it out (the template rendered, its config repo, mm-template, the engine's seal and the
# template record on the host), but nothing started. A box can write its config repo's refs, so mm update merges only
# from the mm-template commit mm recorded on the host. Only the paths that start nothing are run (--dry-run, and an
# update that has nothing to merge); test/box.sh runs the same with a real box.
#   test/template-base.sh [mm command]       default: bun <repo>/src/cli.ts
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
ROOT="$MM_HOME/projects/acme/shop"; REC="$MM_HOME/box/acme-shop/template.json"
G() { git -C "$ROOT" -c user.name=box -c user.email=box@box "$@"; }

# the project, as mm new --box makes it (steps 1-2 and the seals; no tools, no board, nothing started)
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template, templateCommit } from '$SRC/src/template'
import { recordTemplate, sealEngine, templateVars } from '$SRC/src/project'
import { run } from '$SRC/src/env'
const root = process.argv[2], t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'shop', project: 'acme-shop', short: 'sh', root, template_version: t.version, created: new Date().toISOString(), throwaway: true, box: true }, null, 2) + '\n')
const vars = templateVars(root)
renderTo(root, vars, t)
const git = (a: string[]) => { const r = run(['git', '-C', root, ...a]); if (!r.ok) throw new Error(a.join(' ') + ': ' + r.err); return r.out.trim() }
git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'mm']); git(['config', 'user.email', 'mm@acme-shop.local'])
const base = templateCommit(root, vars, 'template ' + t.version, undefined, t)
git(['reset', '-q', base]); git(['branch', 'mm-template', base]); recordTemplate(root, base)
git(['add', '-A']); git(['commit', '-q', '-m', 'mm new acme/shop'])
sealEngine(root)
EOF
echo "== a box project, as mm new --box leaves it"
check "laid out (template, config repo, mm-template, seal)" bun "$T/stamp.ts" "$ROOT"
MT=$(G rev-parse refs/heads/mm-template); MAIN=$(G rev-parse HEAD)
check "the mm-template commit is recorded on the host" sh -c "grep -q '\"commit\": \"$MT\"' '$REC'"
check "mm update --dry-run: nothing to merge" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'already at' '$T/u.out'"

echo "== the box moves mm-template (its own base: main's tree, on top of mm's commit)"
EVIL=$(G commit-tree "HEAD^{tree}" -p "$MT" -m 'template 0.0.0'); G update-ref refs/heads/mm-template "$EVIL"
check "mm update: refused, and it says why" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q 'mm-template is ${EVIL:0:12}, not ${MT:0:12}' '$T/u.out' && grep -q 'sy-055t' '$T/u.out'"
check "mm update --dry-run: refused too" sh -c "! mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'sy-055t' '$T/u.out'"
check "...and the record is still mm's" sh -c "grep -q '\"commit\": \"$MT\"' '$REC'"
G update-ref refs/heads/mm-template "$MT"
check "put back: mm update works" sh -c "mm update acme/shop >'$T/u.out' 2>&1 || { cat '$T/u.out'; false; }"

echo "== the box deletes mm-template"
G update-ref -d refs/heads/mm-template
check "mm update: refused (no new base for a box project)" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q 'no mm-template branch' '$T/u.out'"
check "...mm update --adopt too" sh -c "! mm update acme/shop --adopt >'$T/u.out' 2>&1 && grep -q 'no mm-template branch' '$T/u.out'"
G update-ref refs/heads/mm-template "$MT"

echo "== the box rewrites main without mm-template (the same tree), so git would take another base"
ORPH=$(G commit-tree "HEAD^{tree}" -m 'main, without mm-template'); G update-ref refs/heads/main "$ORPH"
check "mm update: refused, and it says why" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q \"not in main's history\" '$T/u.out'"
G update-ref refs/heads/main "$MAIN"
check "main back: mm update works" sh -c "mm update acme/shop >'$T/u.out' 2>&1"

echo "== ops/ and setup/ are sealed and checked like bin/ and site/ (review sy-atqr)"
check "the engine seal names ops/ and setup/" sh -c "grep -q '\"ops/githooks/pre-commit\"' '$MM_HOME/box/acme-shop/engine.json' && grep -q '\"setup/.claude/settings.tmpl.json\"' '$MM_HOME/box/acme-shop/engine.json'"
printf '#!/bin/sh\nexit 0\n' >"$ROOT/ops/githooks/pre-commit"; G commit -qam 'its own pre-commit'
check "a pre-commit that is not mm's: mm update refuses, and says why" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q 'ops/githooks/pre-commit' '$T/u.out' && grep -q 'sy-atqr' '$T/u.out'"
G reset -q --hard "$MAIN"
echo x >"$ROOT/setup/extra.md"
check "an extra file in setup/: refused too" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q 'setup/extra.md' '$T/u.out'"
rm -f "$ROOT/setup/extra.md"; mkdir -p "$ROOT/setup/.claude"; echo '{}' >"$ROOT/setup/.claude/settings.json"
check "...but not what config-check renders there (setup/.claude/settings.json)" sh -c "mm update acme/shop >'$T/u.out' 2>&1"
rm -f "$ROOT/setup/.claude/settings.json"

echo "== a box made before mm kept the record"
rm -f "$REC"
G update-ref refs/heads/mm-template "$MAIN" # in main's history, but not a render of the template
check "no record, and mm-template is not mm's render: refused, and it says what to do" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q 'no record' '$T/u.out' && grep -q 'MM_TEMPLATE_DIR' '$T/u.out' && ! test -e '$REC'"
G update-ref refs/heads/mm-template "$MT"
check "no record, mm-template is exactly mm's render: --dry-run works and records nothing" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'would record' '$T/u.out' && ! test -e '$REC'"
check "...an update records it" sh -c "mm update acme/shop >'$T/u.out' 2>&1 && grep -q '\"commit\": \"$MT\"' '$REC'"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
