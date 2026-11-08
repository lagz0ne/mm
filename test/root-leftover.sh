#!/usr/bin/env bash
# sy-4jc6: a folder this user can't remove (Docker makes a missing mount source as root) never stops mm archive or a
# box's clean-up: it is named, with the one command that removes it; and mm new --box refuses early when an old box under
# that name left such folders (it used to fail later with EACCES and leave a half-made project). Hermetic: a throwaway
# MM_HOME; "another user's" is played by giving the bun process another uid (process.getuid), and "can't remove" by a
# folder with mode 0555 holding a file. No root, no Docker, no live mm.
#   test/root-leftover.sh
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=$PWD
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset MM_BRAIN MM_PROJECTS MM_SYSTEM MM_BACKUPS
mkdir -p "$MM_HOME"
cat >"$T/t.ts" <<EOF
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { notMine, removeAll, newProject } = await import('$SRC/src/project')
const M = process.env.MM_HOME!, out: Record<string, unknown> = {}
// a box's folders as a stopped run left them: box/<p>/{ai,egress}, egress/<p>/allow
for (const d of ['box/qa-boxt/ai', 'box/qa-boxt/egress', 'egress/qa-boxt/allow']) mkdirSync(join(M, d), { recursive: true })
writeFileSync(join(M, 'box/qa-boxt/ai/f'), 'x')
const real = process.getuid!
// 1. this user's: nothing listed
out.mine = notMine([join(M, 'box/qa-boxt'), join(M, 'egress/qa-boxt')])
// 2. as if all of it were another user's: only the top-most entries, not what is inside them
process.getuid = () => 4242424
out.other = notMine([join(M, 'box/qa-boxt'), join(M, 'egress/qa-boxt'), join(M, 'paseo/qa-boxt')])
// 3. mm new --box under that name: refused before anything is written
try { await newProject('qa/boxt', { box: true, throwaway: true }); out.newRefused = '' } catch (e) { out.newRefused = (e as Error).message }
out.newWroteNothing = !existsSync(join(M, 'projects/qa/boxt'))
process.getuid = real
// 4. a folder this user can't remove (0555 with a file in it): reported with the command, the others still removed
mkdirSync(join(M, 'stuck'), { recursive: true }); writeFileSync(join(M, 'stuck/f'), 'x'); chmodSync(join(M, 'stuck'), 0o555)
mkdirSync(join(M, 'fine/sub'), { recursive: true })
const r = removeAll([join(M, 'stuck'), join(M, 'fine'), join(M, 'not-there')])
out.removed = r.removed.map((p) => p.slice(M.length)); out.left = r.left.map((p) => p.slice(M.length)); out.fix = r.fix
chmodSync(join(M, 'stuck'), 0o755)
console.log(JSON.stringify(out))
EOF
J=$(bun "$T/t.ts" 2>"$T/err") || { echo "the script failed:"; tail -5 "$T/err"; exit 1; }
q() { echo "$J" | jq -e "$1" >/dev/null; }
echo "== what is not this user's"
q '.mine == []' && ok "this user's folders: nothing listed" || bad "this user's folders listed: $(echo "$J" | jq -c .mine)"
q '(.other | map(sub(".*/\\.mm/"; ""))) == ["box/qa-boxt", "egress/qa-boxt"]' && ok "another user's: the top-most entries only (box/qa-boxt, egress/qa-boxt), a missing one skipped" || bad "notMine: $(echo "$J" | jq -c .other)"
echo "== mm new --box under a name with such leftovers"
q '.newRefused | test("left folders that are not yours: .*box/qa-boxt.*egress/qa-boxt.*sudo rm -rf .*then run mm new again")' && ok "refused, naming them and the command" || bad "mm new: $(echo "$J" | jq -r .newRefused)"
q '.newWroteNothing' && ok "...and nothing of the project was written" || bad "a half-made project was left"
echo "== removing what can't be removed"
q '.removed == ["/fine"] and .left == ["/stuck"]' && ok "the removable one goes, the stuck one is left, a missing one is skipped" || bad "removeAll: removed $(echo "$J" | jq -c .removed), left $(echo "$J" | jq -c .left)"
q ".fix | test(\"left \\\\(another user's: .*stuck; remove as root: sudo rm -rf '.*/stuck'\")" && ok "...and the step names it, with the command to remove it" || bad "fix text: $(echo "$J" | jq -r .fix)"
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
