#!/usr/bin/env bash
# What config-check denies about the brain (review sy-qlkl), hermetic: a throwaway HOME / MM_HOME, two boards rendered
# from mm's template as mm new lays them out (nothing started): one with the system profile, one a project. Proves: the
# system board's leads may read the brain (review audits it, ops runs it) but never its keys; a project's leads may not
# read the brain at all; a board that says it is the system profile but is a box gets the project's rule; and every
# board, the system one too, is denied the vault and the opened-secrets folder (sy-uvgq).
#   test/brain-deny.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME"
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const [root, profile, box] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'b', project: 'acme-b', short: 'ab', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, ...(profile === 'system' ? { profile } : {}), ...(box === 'box' ? { box: true } : {}) }, null, 2) + '\n')
renderTo(root, { ...templateVars(root), profile }, t)
EOF
stamp() { PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$@" >/dev/null && (cd "$1" && node bin/config-check --render >/dev/null 2>&1) ; }
SYS="$T/sys"; PROJ="$T/proj"; SBOX="$T/sbox"
stamp "$SYS" system; stamp "$PROJ" project; stamp "$SBOX" system box
deny() { jq -r '.permissions.deny[]' "$1"; }
has()  { deny "$1" | grep -xF -- "$2" >/dev/null; } # not grep -q: under pipefail, an early exit makes jq's SIGPIPE a failure
H=$HOME; WHOLE="Read(/$H/.mm/brain/**)"; KEYS="Read(/$H/.mm/brain/.keys/**)"; VAULT="Read(/$H/.mm/vault/**)"; RUN="Read(//run/user/$(id -u)/mm/secrets/**)"

echo "== the system board: the brain is open to its leads, its keys are not"
for f in "$SYS"/leads/*/.claude/settings.json; do
  r=$(basename "$(dirname "$(dirname "$f")")")
  if ! has "$f" "$WHOLE" && ! has "$f" "Bash(*~/.mm/brain*)" && has "$f" "$KEYS" && has "$f" "Bash(*~/.mm/brain/.keys*)"; then ok "system $r: the brain readable, its keys denied"; else bad "system $r: the brain readable, its keys denied"; fi
done
if jq -e '.permissions.allow | map(test("brain log")) | any' "$SYS/leads/review/.claude/settings.json" >/dev/null; then ok "system review keeps its allows for the brain's git log/show/diff"; else bad "system review keeps its allows for the brain's git log/show/diff"; fi

echo "== a project: the whole brain is denied"
for f in "$PROJ"/leads/*/.claude/settings.json; do
  r=$(basename "$(dirname "$(dirname "$f")")")
  if has "$f" "$WHOLE" && has "$f" "Bash(*~/.mm/brain*)"; then ok "project $r: the whole brain denied"; else bad "project $r: the whole brain denied"; fi
done

echo "== a box that says it is the system profile: the project's rule"
f=$(ls "$SBOX"/leads/*/.claude/settings.json | head -1)
if [ -n "$f" ] && has "$f" "$WHOLE"; then ok "a box with profile: system still has the whole brain denied"; else bad "a box with profile: system still has the whole brain denied"; fi

echo "== every board: the vault and the opened secrets (sy-uvgq)"
for f in "$SYS"/leads/*/.claude/settings.json "$SYS/setup/.claude/settings.json" "$PROJ"/leads/*/.claude/settings.json "$PROJ/setup/.claude/settings.json"; do
  [ -f "$f" ] || continue
  if has "$f" "$VAULT" && has "$f" "$RUN" && has "$f" "Bash(*vault/key*)"; then :; else bad "vault denied in ${f#$T/}"; continue; fi
done
[ "$fail" = 0 ] && ok "all rendered settings of both boards deny the vault, the opened secrets and the key by name"

echo "== the vault's opener and key maker are the owner's (review sy-uvgq)"
n=0; for f in "$SYS"/leads/*/.claude/settings.json "$SYS/setup/.claude/settings.json" "$PROJ"/leads/*/.claude/settings.json "$PROJ/setup/.claude/settings.json"; do
  [ -f "$f" ] || continue
  if has "$f" 'Bash(*mm vault run*)' && has "$f" 'Bash(*mm vault init*)'; then n=$((n+1)); else bad "vault run/init not denied in ${f#$T/}"; fi
done
[ "$n" -gt 0 ] && ok "every role and setup on both boards denies the vault's run and init ($n settings)"
if ! deny "$SYS/leads/review/.claude/settings.json" | grep -E '^Bash\(\*?mm vault (ls|check)' >/dev/null; then ok "...and leaves vault ls and check free"; else bad "...and leaves vault ls and check free"; fi
MMC="bun $SRC/src/cli.ts"
o=$(CLAUDECODE=1 PATH="$HOME/.bun/bin:$PATH" $MMC vault run acme-b x -- true 2>&1); rc=$?
if [ $rc != 0 ] && grep -q "refused in an agent's shell" <<<"$o"; then ok "the CLI refuses vault run in an agent's shell (CLAUDECODE)"; else bad "the CLI refuses vault run in an agent's shell (CLAUDECODE): rc $rc"; fi
o=$(PASEO_AGENT_ID=x PATH="$HOME/.bun/bin:$PATH" $MMC vault init --recovery age1x 2>&1); rc=$?
if [ $rc != 0 ] && grep -q "refused in an agent's shell" <<<"$o"; then ok "...and vault init (PASEO_AGENT_ID)"; else bad "...and vault init (PASEO_AGENT_ID): rc $rc"; fi
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
