#!/usr/bin/env bash
# The rendered denies of every role, hermetic: a throwaway HOME / MM_HOME and projects laid out as mm new lays them out
# (the template rendered, the run files written), nothing started. Proves: the machine's secret paths come from mm's own
# folder, never from a run file the project (or a box) can write, with the fixed list as the floor (review sy-v92 2).
#   test/denies.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_TEMPLATE_DIR="$SRC/template" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset MM_BRAIN MM_PROJECTS MM_SYSTEM MM_BACKUPS
mkdir -p "$HOME"
A="$MM_HOME/projects/acme/shop"; SP="$MM_HOME/secret-paths.json"

# a project, as mm new makes it (the template rendered, the run files written; no tools, nothing started)
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars, writeRunFiles } from '$SRC/src/project'
const [root, client, name] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client, name, project: client + '-' + name, short: name.slice(0, 2), root, template_version: t.version, created: new Date().toISOString(), throwaway: true }, null, 2) + '\n')
renderTo(root, templateVars(root), t)
writeRunFiles(root, join(process.env.MM_HOME!, 'pc.sock'))
EOF
render() { (cd "$1" && node bin/config-check --render); }
denies() { jq -r '.permissions.deny[]' "$1/leads/${2:-qa}/.claude/settings.json"; }
has() { denies "$1" "${3:-qa}" | grep -qxF -- "$2"; }
export -f render denies has

echo "== the machine's secret paths: mm's own file, not the run file (review sy-v92 2)"
check "a project, as mm new makes it, renders" bash -c "bun '$T/stamp.ts' '$A' acme shop && cd '$A' && node bin/config-check --render"
check "mm keeps the list in its own folder (secret-paths.json: the manifest's secret files and their folders)" bash -c "jq -e --arg h '$HOME' '(.files | index(\$h + \"/.mm/brain/.keys/.telebot\")) and (.files | index(\$h + \"/brain/.keys/.cf\")) and (.dirs | index(\$h + \"/.config/secrets\"))' '$SP'"
check "...and the run file has none (a box can write it)" bash -c "jq -e 'has(\"machine_secrets\") | not' '$A/.run/endpoints.json'"
check "every role is denied each listed file: Read, Edit, and Bash naming it (absolute, ~, \$HOME)" bash -c "for r in qa design code setup; do f=\"$A/leads/\$r/.claude/settings.json\"; [ \$r = setup ] && f='$A/setup/.claude/settings.json'; jq -e --arg h '$HOME' '.permissions.deny | index(\"Read(/\" + \$h + \"/.mm/brain/.keys/.telebot)\") and index(\"Edit(/\" + \$h + \"/.mm/brain/.keys/.telebot)\") and index(\"Bash(*\" + \$h + \"/.mm/brain/.keys/.telebot*)\") and index(\"Bash(*~/.mm/brain/.keys/.telebot*)\") and index(\"Bash(*\$HOME/.mm/brain/.keys/.telebot*)\")' \"\$f\" || exit 1; done"
check "...and a change to mm's list (Edit, Write, a Bash command naming it)" bash -c "has '$A' 'Edit(/$SP)' && has '$A' 'Write(/$SP)' && has '$A' 'Bash(*~/.mm/secret-paths.json*)'"
# a new secret input, outside every fixed folder: it comes only from mm's list
jq --arg f "$HOME/.vault-x/key" '.files += [$f] | .dirs += [$f | sub("/key$"; "")]' "$SP" >"$T/sp" && cp "$T/sp" "$SP"
check "a path only mm's list names (a new input) is denied at the next render" bash -c "render '$A' && has '$A' 'Read(/$HOME/.vault-x/key)' && has '$A' 'Read(/$HOME/.vault-x/**)' && has '$A' 'Bash(*~/.vault-x*)'"
# the project (or its box) writes its run file: no secrets in it, mm's folder elsewhere, a list of its own there
mkdir -p "$T/fake-mm"; echo '{"files":[],"dirs":[]}' >"$T/fake-mm/secret-paths.json"
jq --arg m "$T/fake-mm" '.machine_secrets = {files: [], dirs: []} | .dirs.mm = $m' "$A/.run/endpoints.json" >"$T/ep" && cp "$T/ep" "$A/.run/endpoints.json"
check "a run file that lists none and points mm's folder elsewhere takes nothing away: mm's list still renders" bash -c "render '$A' && has '$A' 'Read(/$HOME/.vault-x/key)' && has '$A' 'Read(/$HOME/.mm/brain/.keys/.telebot)'"
check "...nor the gateway's and Paseo's stores, in mm's real folder" bash -c "has '$A' 'Read(/$MM_HOME/auth/**)' && has '$A' 'Read(/$MM_HOME/ai/**)' && has '$A' 'Edit(/$MM_HOME/paseo/**)'"
mv "$SP" "$T/sp.gone"
check "no list at all (mm not run yet): the fixed list still renders" bash -c "render '$A' && has '$A' 'Read(/$HOME/.mm/brain/.keys/**)' && has '$A' 'Read(/$HOME/brain/.keys/**)' && has '$A' 'Read(/$HOME/.config/secrets/**)' && has '$A' 'Read(/$HOME/.paseo/**)' && has '$A' 'Read(/$HOME/.claude/.credentials.json)' && ! has '$A' 'Read(/$HOME/.vault-x/key)'"
check "...the vault and the opened-secrets tmpfs among them, in mm's real folder, whatever the run file says (sy-uvgq)" bash -c "has '$A' 'Read(/$MM_HOME/vault/**)' && has '$A' 'Edit(/$MM_HOME/vault/**)' && has '$A' \"Read(//run/user/\$(id -u)/mm/secrets/**)\" && has '$A' 'Bash(*vault/key*)'"
mv "$T/sp.gone" "$SP"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
