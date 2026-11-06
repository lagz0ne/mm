#!/usr/bin/env bash
# One mm update of a project at a time (sy-qpqd), hermetic: two runs on one project once shared the scratch render
# .git/mm-render, and one crashed (ENOENT) when the other removed it. Now each run takes a lock in mm's host folder
# ($MM_HOME/update/<project>.lock, never in the repo a box can write: sy-rjwg 3; its pid in it; a dead holder's lock is
# taken over), and renders into its own fresh folder, removed at the end.
# A throwaway HOME / MM_HOME and a project laid out as mm new lays it out (nothing started; only --dry-run, --drift,
# --reset -n and the refusals run).
#   test/update-lock.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); HP=; trap '[ -n "$HP" ] && kill -9 $HP 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME" "$T/bin"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
# git, slowed down on demand (SLOWGIT=1) just after the render, so a run holds the lock long enough to meet another
printf '#!/bin/sh\ncase " $* " in *" write-tree"*) [ -n "${SLOWGIT:-}" ] && sleep 3;; esac\nexec %s "$@"\n' "$(command -v git)" >"$T/bin/git"; chmod +x "$T/bin/git"
export PATH="$T/bin:$PATH"
ROOT="$MM_HOME/projects/acme/shop"; LOCK="$MM_HOME/update/acme-shop.lock"; OLD="$ROOT/.git/mm-update.lock"
G() { git -C "$ROOT" -c user.name=mm -c user.email=mm@acme-shop.local "$@"; }
waitfor() { for _ in $(seq 100); do [ -e "$1" ] && return 0; sleep 0.1; done; return 1; }
noscratch() { [ -z "$(find "$ROOT/.git" -maxdepth 1 -name 'mm-render*')" ]; }
dead() { sh -c 'exit 0' & local p=$!; wait $p; echo $p; }

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
# the template render committed, as mm update does it: prints the commit; with a broken git (argv[3]), it fails
cat >"$T/render.ts" <<EOF
import { template, templateCommit } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const root = process.argv[2]
console.log(templateCommit(root, templateVars(root), 'template x', undefined, template(), process.argv[3] ? { GIT_DIR: process.argv[3] } : {}))
EOF
# a run that holds the lock until it is killed
cat >"$T/hold.ts" <<EOF
import { lockUpdate } from '$SRC/src/updlock'
const r = lockUpdate(process.argv[2], 'acme-shop')
if (typeof r === 'string') { console.error(r); process.exit(1) }
setInterval(() => {}, 1000)
EOF

echo "== a project, as mm new leaves it"
check "laid out (template, config repo, mm-template)" bun "$T/stamp.ts" "$ROOT"
check "mm update --dry-run: nothing to merge" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'already at' '$T/u.out'"
check "...no lock and no scratch render left in .git/" sh -c "! test -e '$LOCK' && [ -z \"\$(find '$ROOT/.git' -maxdepth 1 -name 'mm-render*')\" ]"

echo "== the scratch render: a fresh folder per run"
bun "$T/render.ts" "$ROOT" >"$T/r1.out" 2>&1 & R1=$!
bun "$T/render.ts" "$ROOT" >"$T/r2.out" 2>&1 & R2=$!
wait $R1; RC1=$?; wait $R2; RC2=$?
check "two renders at once (no lock): both work, the same tree" sh -c "[ $RC1 = 0 ] && [ $RC2 = 0 ] && [ \"\$(git -C '$ROOT' rev-parse \"\$(cat '$T/r1.out')^{tree}\")\" = \"\$(git -C '$ROOT' rev-parse \"\$(cat '$T/r2.out')^{tree}\")\" ]"
check "a render that fails (git can't write): it says so" sh -c "! bun '$T/render.ts' '$ROOT' '$T/no-such-git' >'$T/r.out' 2>&1 && grep -q 'not a git repository' '$T/r.out'"
check "...and its folder is gone too" noscratch

echo "== two dry runs at once"
SLOWGIT=1 mm update acme/shop --dry-run >"$T/a.out" 2>&1 & A=$!
check "the first holds the lock, with its pid" sh -c "for i in \$(seq 100); do [ \"\$(cut -d' ' -f1 '$LOCK' 2>/dev/null)\" = $A ] && exit 0; sleep 0.1; done; exit 1"
mm update acme/shop --dry-run >"$T/b.out" 2>&1; RCB=$?
wait $A; RCA=$?
check "the second refuses: an update of acme-shop is running (pid $A)" sh -c "[ $RCB = 1 ] && grep -q 'an update of acme-shop is running (pid $A); try again' '$T/b.out'"
check "the first goes on and ends well" sh -c "[ $RCA = 0 ] && grep -q 'already at' '$T/a.out'"
check "neither crashed (no ENOENT, no stack)" sh -c "! grep -qE 'ENOENT|error:|at .*\\.ts:[0-9]' '$T/a.out' '$T/b.out'"
check "...the lock is given back, no scratch render left" sh -c "! test -e '$LOCK' && [ -z \"\$(find '$ROOT/.git' -maxdepth 1 -name 'mm-render*')\" ]"
for i in 1 2 3; do mm update acme/shop --dry-run >"$T/p$i-1.out" 2>&1 & mm update acme/shop --dry-run >"$T/p$i-2.out" 2>&1 & wait; done
check "3 more pairs at full speed: each works or refuses, none crashes" sh -c "for f in '$T'/p*.out; do grep -qE 'already at|is running \\(pid [0-9]+\\)' \"\$f\" && ! grep -qE 'ENOENT|error:' \"\$f\" || { cat \"\$f\"; exit 1; }; done"

echo "== every way into mm update takes the lock"
bun "$T/hold.ts" "$ROOT" & HP=$!
check "a run holds the lock" waitfor "$LOCK"
check "mm update: refused" sh -c "! mm update acme/shop >'$T/u.out' 2>&1 && grep -q 'is running (pid $HP)' '$T/u.out'"
check "--continue: refused (before it looks for a merge)" sh -c "! mm update acme/shop --continue >'$T/u.out' 2>&1 && grep -q 'is running (pid $HP)' '$T/u.out'"
check "--abort: refused" sh -c "! mm update acme/shop --abort >'$T/u.out' 2>&1 && grep -q 'is running (pid $HP)' '$T/u.out'"
check "--drift: refused, exit 1" sh -c "mm update acme/shop --drift >'$T/u.out' 2>&1; [ \$? = 1 ] && grep -q 'is running (pid $HP)' '$T/u.out'"
check "--reset -n: refused" sh -c "! mm update acme/shop --reset bin/lead -n >'$T/u.out' 2>&1 && grep -q 'is running (pid $HP)' '$T/u.out'"
check "...and the lock is still the holder's" sh -c "[ \"\$(cut -d' ' -f1 '$LOCK')\" = $HP ]"

echo "== a stale lock is taken over"
kill -9 $HP; wait $HP 2>/dev/null; HP=
check "the holder was killed: its lock is left" test -e "$LOCK"
check "mm update --dry-run takes it over and works" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'already at' '$T/u.out' && ! test -e '$LOCK'"
echo "$(dead) 1" >"$LOCK"
check "a lock of a pid that is gone: taken over" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && ! test -e '$LOCK'"
echo "$$ 1" >"$LOCK"
check "a lock of a pid in use again (another start time): taken over" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && ! test -e '$LOCK'"
: >"$LOCK"; touch -d '1 minute ago' "$LOCK"
check "an empty lock, a minute old (its maker died before it wrote): taken over" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && ! test -e '$LOCK'"
: >"$LOCK"
check "an empty lock just made (its maker is writing): refused" sh -c "! mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'is running (pid ?)' '$T/u.out'"
rm -f "$LOCK"; ln -s "$T/elsewhere" "$LOCK"
check "a symlink in place of the lock: taken over, the link removed, its target never made" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && ! test -e '$LOCK' && ! test -L '$LOCK' && ! test -e '$T/elsewhere'"
check "no aside file left behind" sh -c "[ -z \"\$(find '$MM_HOME/update' -maxdepth 1 -name 'acme-shop.lock?*')\" ]"
check "the lock's folder is the host's own, 0700" sh -c "[ \"\$(stat -c %a '$MM_HOME/update')\" = 700 ]"

echo "== a lock in the repo (a box can write its .git/) blocks nothing (review sy-rjwg 3)"
sleep 300 & SP=$!; HP=$SP
echo "$SP $(awk '{print $22}' /proc/$SP/stat)" >"$OLD"
check "a lock planted in .git/ naming a live pid (with its start time): mm update --dry-run still works" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && grep -q 'already at' '$T/u.out'"
check "...it is left alone while that pid lives (only ignored)" test -e "$OLD"
check "...--drift and --reset -n are not refused either" sh -c "mm update acme/shop --drift >'$T/u.out' 2>&1; ! grep -q 'is running' '$T/u.out' && mm update acme/shop --reset bin/lead -n >'$T/u.out' 2>&1; ! grep -q 'is running' '$T/u.out'"
kill $SP; wait $SP 2>/dev/null; HP=
echo "$(dead) 1" >"$OLD"
check "an old lock in .git/ whose holder is gone: removed by the next run" sh -c "mm update acme/shop --dry-run >'$T/u.out' 2>&1 && ! test -e '$OLD'"
mkdir -p "$T/far"; echo "$(dead) 1" >"$T/far/mm-update.lock"; mv "$ROOT/.git" "$T/realgit"; ln -s "$T/far" "$ROOT/.git"
check "...but not through a .git/ that is a link to elsewhere (the file there stays)" sh -c "bun -e \"import { lockUpdate } from '$SRC/src/updlock'; const r = lockUpdate('$ROOT', 'acme-shop'); if (typeof r === 'string') process.exit(1); r()\" && test -e '$T/far/mm-update.lock'"
rm "$ROOT/.git"; mv "$T/realgit" "$ROOT/.git"
check "a project id that is not one (from a box-written answers file): refused, nothing made" sh -c "bun -e \"import { lockUpdate } from '$SRC/src/updlock'; process.exit(typeof lockUpdate('$ROOT', '../x') === 'string' ? 0 : 1)\" && ! test -e '$MM_HOME/x.lock'"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
