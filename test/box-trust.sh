#!/usr/bin/env bash
# sy-vsh5: a box's Claude folder trusts the project's own folders before its Paseo starts an agent (src/box.ts
# seedTrust). Hermetic: a scratch project and Claude folder in a temp dir; no box, no Docker, no live mm.
#   test/box-trust.sh
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/tmp/box-trust.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/box-trust.out | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
R=$T/proj; C=$T/claude; O=$T/outside
mkdir -p "$R/leads/qa" "$R/leads/dev" "$R/leads/.hidden" "$R/setup" "$C" "$O"
ln -s "$O" "$R/leads/evil"; echo x > "$R/leads/CLAUDE.md"
trusted() { jq -e --arg p "$1" '.projects[$p].hasTrustDialogAccepted == true' "$C/.claude.json" >/dev/null; }
export -f trusted; export C R O

echo "== a fresh Claude folder"
check "seedTrust: ok, 4 folders (root, leads/dev, leads/qa, setup)" sh -c "cd '$PWD' && bun -e \"import { seedTrust } from './src/box.ts'; const s = seedTrust('$C', '$R'); if (s.status !== 'ok' || !s.detail.startsWith('4 project folder')) { console.log(s); process.exit(1) }\""
check "...the root, each lead folder and setup are trusted" sh -c "trusted '$R' && trusted '$R/leads/qa' && trusted '$R/leads/dev' && trusted '$R/setup'"
check "...not a link out of the project, a hidden folder or a file" sh -c "! trusted '$R/leads/evil' && ! trusted '$R/leads/.hidden' && ! trusted '$R/leads/CLAUDE.md' && ! trusted '$O'"
check "...the file is not world-readable" sh -c "[ \$(( 0\$(stat -c %a '$C/.claude.json') & 7 )) -eq 0 ]"

echo "== an existing config keeps what it had"
jq '.projects["/elsewhere"] = {hasTrustDialogAccepted: true, allowedTools: ["x"]} | .projects["'"$R"'/leads/qa"].allowedTools = ["y"] | .theme = "dark"' "$C/.claude.json" > "$T/j" && cp "$T/j" "$C/.claude.json"
check "seedTrust again: ok, nothing new" sh -c "cd '$PWD' && bun -e \"import { seedTrust } from './src/box.ts'; const s = seedTrust('$C', '$R'); if (s.status !== 'ok' || s.detail.includes('new')) process.exit(1)\""
check "...other projects, other keys and a folder's own settings stay" sh -c "jq -e '.theme == \"dark\" and .projects[\"/elsewhere\"].allowedTools == [\"x\"] and .projects[\"$R/leads/qa\"].allowedTools == [\"y\"]' '$C/.claude.json'"

echo "== what the box may plant in its Claude folder"
rm -f "$C/.claude.json"; echo '{"keep":1}' > "$O/target.json"; ln -s "$O/target.json" "$C/.claude.json"
check "a link at .claude.json: replaced by a file, its target untouched" sh -c "cd '$PWD' && bun -e \"import { seedTrust } from './src/box.ts'; if (seedTrust('$C', '$R').status !== 'ok') process.exit(1)\" && [ ! -L '$C/.claude.json' ] && [ \"\$(cat '$O/target.json')\" = '{\"keep\":1}' ] && trusted '$R'"
rm -f "$C/.claude.json"; echo 'not json' > "$C/.claude.json"
check "a broken .claude.json: replaced, with the trust" sh -c "cd '$PWD' && bun -e \"import { seedTrust } from './src/box.ts'; if (seedTrust('$C', '$R').status !== 'ok') process.exit(1)\" && trusted '$R/setup'"
echo '[1,2]' > "$C/.claude.json"
check "a JSON array: replaced by an object" sh -c "cd '$PWD' && bun -e \"import { seedTrust } from './src/box.ts'; if (seedTrust('$C', '$R').status !== 'ok') process.exit(1)\" && jq -e 'type == \"object\"' '$C/.claude.json'"

echo '{"box":"state"}' > "$C/.claude.json"; chmod 000 "$C/.claude.json"
check "the box's own file, unreadable by the host: skipped, left as it is" sh -c "cd '$PWD' && bun -e \"import { seedTrust } from './src/box.ts'; const s = seedTrust('$C', '$R'); if (s.status !== 'skip') { console.log(s); process.exit(1) }\" && [ \"\$(stat -c %a '$C/.claude.json')\" = 0 ] && chmod 600 '$C/.claude.json' && [ \"\$(cat '$C/.claude.json')\" = '{\"box\":\"state\"}' ]"

echo "== the box's Paseo gives its agents that folder"
check "src/box.ts: the box's Paseo process has CLAUDE_CONFIG_DIR = mm's claude/<project>" grep -q "CLAUDE_CONFIG_DIR: join(DIRS.mm, 'claude', a.project)" src/box.ts
check "...and mm up seeds the trust before the box starts" grep -q "steps.push(seedTrust(claude, root))" src/box.ts

echo; echo "box-trust: $pass passed, $fail failed"; [ $fail -eq 0 ]
