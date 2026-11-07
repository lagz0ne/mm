#!/usr/bin/env bash
# The rendered denies of every role, hermetic: a throwaway HOME / MM_HOME and projects laid out as mm new lays them out
# (the template rendered, the run files written), nothing started. Proves: the machine's secret paths come from mm's own
# folder, never from a run file the project (or a box) can write, with the fixed list as the floor (review sy-v92 2);
# the design lead, a worker and another project's lead can't run the Doop headers helper or read a project's Doop
# secrets in any spelling (cat, cp to /tmp, Read; review sy-7452 2); no role can write into a folder ahead of /usr/bin
# in its PATH (review sy-jm5 2); bin/doop-run takes an image by digest only (sy-7452 1).
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
# in a box, setup/ is read-only (the host renders it at mm up): a lead's start renders the rest and checks setup's as it is
check "setup/.claude read-only (a box's kernel): --render passes, and leaves setup's settings as the host rendered them (sy-7870)" bash -c "s='$A/setup/.claude/settings.json'; before=\$(md5sum < \"\$s\"); chmod a-w '$A/setup/.claude' \"\$s\"; (cd '$A' && node bin/config-check --render); rc=\$?; chmod u+w '$A/setup/.claude' \"\$s\"; [ \$rc = 0 ] && [ \"\$(md5sum < \"\$s\")\" = \"\$before\" ]"
check "...but a missing setup settings file there still fails the check" bash -c "s='$A/setup/.claude/settings.json'; cp \"\$s\" '$T/setup-settings.bak'; rm \"\$s\"; chmod a-w '$A/setup/.claude'; (cd '$A' && node bin/config-check --render) >/dev/null 2>&1; rc=\$?; chmod u+w '$A/setup/.claude'; cp '$T/setup-settings.bak' \"\$s\"; [ \$rc != 0 ]"
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

# Claude Code's deny rules, as a real session applies them (sy-v92 3 checked it in one): a Bash rule is text, `*` any
# run of characters, matched against the whole command and each part of a compound one; a Read/Edit rule is a path
# glob on the resolved path (`**` any depth, `*` one name). Exit 0: the call is denied.
cat >"$T/denied.mjs" <<'EOF'
import fs from 'node:fs'; import path from 'node:path'
const [settings, cwd, tool, arg] = process.argv.slice(2)
const deny = JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.deny
const re = (g, any) => new RegExp('^' + g.split(/(\*\*|\*)/).map((x) => x === '**' ? '.*' : x === '*' ? any : x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 's')
let hit
if (tool === 'Bash') {
  const parts = [arg, ...arg.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean)]
  hit = deny.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5, -1)).find((p) => parts.some((c) => p.endsWith(':*') ? c.startsWith(p.slice(0, -2)) : re(p, '.*').test(c)))
} else {
  const f = path.resolve(cwd, arg)
  hit = deny.filter((r) => r.startsWith(`${tool}(//`)).map((r) => r.slice(tool.length + 2, -1)).find((g) => re(g, '[^/]*').test(f) || (g.endsWith('/**') && re(g.slice(0, -3), '[^/]*').test(f)))
}
if (hit) { console.log(`denied by ${hit}`); process.exit(0) }
console.log('NOT denied'); process.exit(1)
EOF
# denied <project> <role> <cwd> <tool> <command or path>
denied() { local s="$1/leads/$2/.claude/settings.json"; node "$T/denied.mjs" "$s" "$3" "$4" "$5"; }
export -f denied; export T

echo "== the Doop agent key stays with its helper: the design lead, and a lead of another project (review sy-7452 2)"
B="$MM_HOME/projects/acme/other"; AR=${A#$HOME/}
check "a second project renders" bash -c "bun '$T/stamp.ts' '$B' acme other && render '$B' && render '$A'"
mkdir -p "$A/worktrees/w1"
D="$A/leads/design"; Q="$B/leads/qa"; W="$A/worktrees/w1"
n=0; miss=()
try() { n=$((n+1)); denied "$@" >"$T/d.out" 2>&1 || miss+=("$2 in ${3#$MM_HOME/projects/}: $4 $5"); }
for who in "$A design $D" "$A code $W" "$B qa $Q"; do
  set -- $who; P=$1 role=$2 cwd=$3
  # the headers helper, however it is called
  for c in "$A/bin/doop-mcp-headers" "sh $A/bin/doop-mcp-headers" "~/$AR/bin/doop-mcp-headers" "cd $A/bin && ./doop-mcp-headers"; do try "$P" $role "$cwd" Bash "$c"; done
  # each of Doop's secret files, and the folder: cat, cp to /tmp, the Read tool; absolute, ~ and $HOME
  for f in doop-agent-key doop-password doop-auth-secret doop.env doop-signup-domain '*'; do
    for p in "$A/secrets/$f" "~/$AR/secrets/$f" "\$HOME/$AR/secrets/$f"; do
      try "$P" $role "$cwd" Bash "cat $p"; try "$P" $role "$cwd" Bash "cp $p /tmp/k"
    done
    [ "$f" = '*' ] || try "$P" $role "$cwd" Read "$A/secrets/$f"
  done
  for c in "cp -r $A/secrets /tmp/s" "cp -r ~/$AR/secrets /tmp/s" "tar czf /tmp/s.tgz $A/secrets"; do try "$P" $role "$cwd" Bash "$c"; done
done
# ...and relative to where the project's own leads and workers are (their folder, a worktree, the project root)
for who in "design $D" "code $W"; do
  set -- $who; role=$1 cwd=$2
  for f in doop-agent-key doop-password doop.env '*'; do
    for p in "../../secrets/$f" "./../../secrets/$f"; do try "$A" $role "$cwd" Bash "cat $p"; try "$A" $role "$cwd" Bash "cp $p /tmp/k"; done
    [ "$f" = '*' ] || try "$A" $role "$cwd" Read "../../secrets/$f"
    try "$A" $role "$cwd" Bash "cd ../.. && cat secrets/$f"; try "$A" $role "$cwd" Bash "cd $A && cp secrets/$f /tmp/k"
  done
  for c in "../../bin/doop-mcp-headers" "cp -r ../../secrets /tmp/s" "cd ../.. && cp -r ./secrets /tmp/s"; do try "$A" $role "$cwd" Bash "$c"; done
done
check "each of $n spellings is denied by the rendered denies (cat, cp to /tmp, Read, the helper)" test ${#miss[@]} = 0
[ ${#miss[@]} = 0 ] || { echo "       ${#miss[@]} not denied:"; printf '       %s\n' "${miss[@]}"; }
check "...while the project's own files stay readable (the denies name secrets/, not the project)" bash -c "! denied '$A' design '$D' Bash 'cat ../../services.yaml' && ! denied '$A' design '$D' Read '$A/leads/design/CLAUDE.md' && ! denied '$A' code '$W' Bash 'cat src/config/secrets.ts'"

echo "== each person's own Claude token: no role reaches it, starts a run on it, or changes it (sy-8n4w)"
TV="$MM_HOME/vault/claude_token.alice.age"; UIDN=$(id -u); n=0; miss=()
for who in "$A qa $A/leads/qa" "$A design $D" "$A code $W" "$B qa $Q"; do
  set -- $who; P=$1 role=$2 cwd=$3
  try "$P" $role "$cwd" Read "$TV"; try "$P" $role "$cwd" Edit "$TV"
  for c in "cat $TV" "cat ~/.mm/vault/claude_token.alice.age" "cd ~/.mm && age -d -i vault/key vault/claude_token.alice.age" "cp \$MM_HOME/vault/claude_token.bob.age /tmp/x" \
    "cat /run/user/$UIDN/mm/secrets/_run/0a1b" "cd /run/user/$UIDN/mm && ls secrets/_run" \
    "mm run-as alice acme-shop qa" "~/.mm/bin/mm run-as alice acme-shop qa" "mm user claude-token --remove" "env mm user claude-token" \
    "bin/lead start qa --as alice" "$A/bin/lead start qa --model x --as alice"; do try "$P" $role "$cwd" Bash "$c"; done
done
check "each of $n spellings is denied by the rendered denies (Read, Edit, cat, age, cp, the run folder, run-as, claude-token, lead --as)" test ${#miss[@]} = 0
[ ${#miss[@]} = 0 ] || { echo "       ${#miss[@]} not denied:"; printf '       %s\n' "${miss[@]}"; }
check "...and the setup agent's settings carry the same denies" bash -c "f='$A/setup/.claude/settings.json'; jq -e --arg m '$MM_HOME' '.permissions.deny | index(\"Read(/\" + \$m + \"/vault/**)\") and index(\"Bash(*claude_token.*)\") and index(\"Bash(*mm run-as*)\") and index(\"Bash(*mm user claude-token*)\") and index(\"Bash(*lead start*--as*)\") and index(\"Bash(*secrets/_run*)\")' \"\$f\""
check "...while a plain lead start stays free (the setup agent restarts leads)" bash -c "! denied '$A' qa '$A/leads/qa' Bash 'bin/lead start qa'"

echo "== nothing ahead of /usr/bin in a lead's PATH can be written by a role (review sy-jm5 2)"
ROLES=$(jq -r '.roles[].id' "$A/leads/roles.json" | tr '\n' ' ')
PATH_WANT="$A/bin:$MM_HOME/bin:$MM_HOME/npm/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
check "every role ($ROLES): its PATH is the project's bin/, mm's, ~/.local/bin, ~/.npm-global/bin, ~/.bun/bin, then the system's" bash -c "for r in $ROLES; do jq -e --arg p '$PATH_WANT' '.env.PATH == \$p' '$A/leads/'\$r'/.claude/settings.json' || exit 1; done"
check "...and no role may Edit or Write a file into any of those first six (bin/git, bin/bd, mm's bin/, ~/.local/bin)" bash -c "for r in $ROLES; do for t in Edit Write; do for f in '$A/bin/git' '$A/bin/bd' '$A/bin/lib/x.mjs' '$MM_HOME/bin/git' '$MM_HOME/npm/bin/bd' '$HOME/.local/bin/git' '$HOME/.npm-global/bin/git' '$HOME/.bun/bin/git'; do denied '$A' \$r '$A/leads/'\$r \$t \$f >/dev/null || { echo \"not denied: \$r \$t \$f\"; exit 1; }; done; done; done"
check "...nor by a path relative to its folder or a worktree (../../bin/git)" bash -c "denied '$A' qa '$A/leads/qa' Edit ../../bin/git && denied '$A' code '$W' Write ../../bin/bd"
# the run file names another mm folder, one the project can write
jq --arg m "$A/code/fake-mm" '.dirs.mm = $m' "$A/.run/endpoints.json" >"$T/ep" && cp "$T/ep" "$A/.run/endpoints.json"
check "a run file that names another mm folder (one the project can write): it is not put on the PATH" bash -c "render '$A' && jq -e --arg p '$PATH_WANT' '.env.PATH == \$p' '$A/leads/code/.claude/settings.json'"
check "settings that lost one of these denies: config-check says so" bash -c "cd '$A' && jq --arg d 'Edit(/$A/bin/**)' '.permissions.deny -= [\$d]' leads/qa/.claude/settings.json >'$T/s' && cp '$T/s' leads/qa/.claude/settings.json && ! node bin/config-check 2>'$T/cc' && grep -qF 'qa: settings.json lost the safety deny Edit(/$A/bin/**)' '$T/cc'"
render "$A" >/dev/null

echo "== bin/doop-run runs Doop's image by digest only (review sy-7452 1)"
# docker: a stub that records what it is asked, and starts nothing (it names a Doop network and an image command, so
# doop-run gets as far as its run)
# `container inspect`: the old container is "still there" while $T/alive holds a count above 0 (sy-ig1f), else gone
printf '#!/bin/sh\necho "$*" >>"%s/docker.log"\ncase "$1 $2" in "network inspect") echo 10.232.50.0/24 ;; "image inspect") echo "docker-entrypoint.sh node server.js" ;;\n "container inspect") n=$(cat "%s/alive" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || exit 1; echo $((n - 1)) >"%s/alive"; exit 0 ;; esac\n' "$T" "$T" "$T" >"$T/docker"; chmod +x "$T/docker"
DIG=sha256:$(printf '%064d' 0 | tr 0 a)
doop() { jq --arg i "$1" --arg d "$T/docker" '.containers = {docker: $d, doop_image: $i}' "$A/.run/endpoints.json" >"$T/ep" && cp "$T/ep" "$A/.run/endpoints.json"
  rm -f "$T/docker.log"; PORT=1 DOOP_URL=http://doop.invalid timeout 20 "$A/bin/doop-run" >"$T/doop.out" 2>&1; }
export -f doop; export A DIG
for img in mm-doop:0.12.0 mm-doop sha256:abc "${DIG^^}" "mm-doop:0.12.0 @$DIG" "$DIG;x" "mm-doop:0.12.0
$DIG"; do
  check "a tag or anything not a digest ('$img'): refused, it says why, and docker is never run" bash -c "! doop '$img' && grep -q 'not a digest' '$T/doop.out' && grep -q 'docker tag' '$T/doop.out' && ! test -e '$T/docker.log'"
done
for img in "$DIG" "mm-doop@$DIG" "registry.local:5000/mm/doop:0.12.0@$DIG"; do
  check "a digest ('${img:0:40}...'): docker runs exactly that image" bash -c "doop '$img'; grep -q -- '^run .* $img -c ' '$T/docker.log'"
done
echo "== the old container still being removed: doop-run waits for its name (sy-ig1f)"
echo 3 >"$T/alive"
check "docker run --name comes only after the old container is gone (3 inspects that still find it, then none)" bash -c "doop '$DIG'; [ \$(grep -c '^container inspect' '$T/docker.log') -ge 4 ] && awk '/^container inspect/{c=NR} /^run --rm --name/{r=NR} END{exit !(r>c && c>0)}' '$T/docker.log'"
rm -f "$T/alive"

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
