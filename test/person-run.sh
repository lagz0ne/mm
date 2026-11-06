#!/usr/bin/env bash
# Each person's own long-term Claude token (sy-8n4w), hermetic: a throwaway HOME / MM_HOME (one-root), a test vault with
# a test recovery key, a memory-backed secrets folder (/dev/shm), the gateway on loopback with curl as the browser, a
# fake project and a stand-in for Paseo's client library (no agent starts). The tokens are test stand-ins.
# Proves: "Your Claude token" on the gateway's own host: set, replace, remove; signed in only; its own form only (CSRF);
# one person can't touch another's; CSP and no-store; the owner the same from the terminal (refused in an agent's
# shell); the stored form is sealed (the recovery key opens it); mm user ls shows set/none only; the token is in no
# log, no page, no file outside the vault. mm run-as: a person's run gets their token only (as CLAUDE_CODE_OAUTH_TOKEN,
# nothing else signs its calls), labelled with the Paseo daemon's worker (no worker said: no run); a person with none is
# refused, and the owner's token is never used for them; a viewer, a stranger and an agent's shell are refused; the
# opened file is gone. In a box (a stand-in for docker; sy-otxx 2): the run goes over docker exec -i with no token at
# all, only an mm.ai key of its own (kind person, bound to the project and the person, ending by the host's clock, its
# label run-expires); mm.ai off: no run; the box's egress never gets the model's host; the host's record goes when the
# key ends (the host's clock, never the box's word); a run that does not start has its key revoked at once.
#   test/person-run.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "age is not installed"; exit 2; }
# the test plays the owner in a throwaway HOME: these steps refuse in an agent's shell, so not one here (one check sets it)
unset CLAUDECODE PASEO_AGENT_ID PASEO_AGENT_CWD PASEO_WORKSPACE_ID MM_SECRETS_DIR MM_PROJECTS MM_BRAIN MM_SYSTEM
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); SHM=$(mktemp -d /dev/shm/mmp.XXXX); GW=""; WK=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; [ -n "$WK" ] && kill $WK 2>/dev/null; rm -rf "$T" "$SHM"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_LAYOUT=one-root MM_OBS_TRACES="" XDG_RUNTIME_DIR="$SHM"
# this machine's swap is not this test's: a stand-in /proc/swaps with none on (vault: opened secrets only where swap cannot reach, sy-rjwg 6)
printf 'Filename\tType\tSize\tUsed\tPriority\n' >"$T/swaps"; export MM_PROC_SWAPS="$T/swaps"
mkdir -p "$MM_HOME/pc/projects" "$T/bin"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
PORT=$(( 41100 + RANDOM % 800 )); AUTH=auth.example.org
printf 'domain: example.org\nlayout: one-root\nauth_port: %s\nbind_host: 127.0.0.1\nowner_name: boss\n' "$PORT" >"$MM_HOME/config.yaml"
tok() { printf 'sk-ant-oat01-%s' "$(head -c 72 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')"; }
TA=$(tok); TA2=$(tok); TB=$(tok); TO=$(tok); BADV="not-a-token-$RANDOM$RANDOM"
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
age-keygen -o "$T/recovery.key" 2>/dev/null; REC=$(age-keygen -y "$T/recovery.key")
mm vault init --recovery "$REC" >"$T/init.out" 2>&1 || { echo "vault init failed"; cat "$T/init.out"; exit 1; }
V="$MM_HOME/vault"

mm auth serve >"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/s" && break; sleep 0.2; done
G="http://127.0.0.1:$PORT"
gw() { curl -s -H "x-forwarded-host: $AUTH" -H 'x-forwarded-proto: https' "$@"; }
sess() { sed -n 's/^set-cookie: \(__Secure-better-auth\.session_token=[^;]*\).*/\1/ip' "$1" | tail -1; }
qs() { printf '%s' "${1#*\?}" | tr '&' '\n' | sed -n "s/^$2=//p"; }
signin() { local L; L=$(mm user link "$1" -o json | jq -r .link); gw -D "$T/h-$1" -o /dev/null -H 'origin: null' -H 'sec-fetch-site: same-origin' -d "t=$(qs "$L" token)&c=$(qs "$L" callbackURL)" "$G/s/l"; sess "$T/h-$1"; }
# what a browser sends with the page's own form (no-referrer: Origin null, Sec-Fetch-Site same-origin)
post() { gw -o "$T/page" -w '%{http_code}' -H "cookie: $1" -H 'origin: null' -H 'sec-fetch-site: same-origin' --data-urlencode "a=$2" ${3:+--data-urlencode "v=$3"} "$G/s/token"; }
ls_of() { mm user ls -o json | jq -r ".[] | select(.name==\"$1\") | .claude_token"; }
export -f gw post ls_of sha; export G AUTH T

mm user add boss --owner >/dev/null; mm user add alice >/dev/null; mm user add bob >/dev/null; mm user add carol >/dev/null; mm user add vic >/dev/null
mm grant alice acme-shop >/dev/null; mm grant carol acme-shop >/dev/null; mm grant vic acme-shop --as viewer >/dev/null; mm grant bob acme-shop >/dev/null
SA=$(signin alice); SB=$(signin bob)
[ -n "$SA" ] && [ -n "$SB" ] || { echo "sign-in failed"; tail -5 "$T/gw.log"; exit 1; }

echo '== "Your Claude token": the page'
check "not signed in: the page sends you to sign in; a POST is refused and nothing is sealed" bash -c "[ \"\$(gw -o /dev/null -w '%{http_code} %{redirect_url}' $G/s/token)\" = '302 http://127.0.0.1:$PORT/s' ] && [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: null' -H 'sec-fetch-site: same-origin' -d 'a=set&v=$TA' $G/s/token)\" = 403 ] && ! ls '$V' | grep -q claude_token"
gw -D "$T/ph" -o "$T/p1" -H "cookie: $SA" "$G/s/token"
check "signed in: the page, status None, a password field, with CSP and no-store" bash -c "head -1 '$T/ph' | grep -q 200 && grep -q 'Your Claude token' '$T/p1' && grep -q '<b>None</b>' '$T/p1' && grep -q 'type=\"password\"' '$T/p1' && grep -qi \"^content-security-policy: default-src 'self'\" '$T/ph' && grep -qi '^cache-control: no-store' '$T/ph'"
check "the home page links it" bash -c "gw -H 'cookie: $SA' $G/ | grep -q 'href=\"/s/token\"'"
check "only on the gateway's own host (a board host: not found)" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'x-forwarded-host: board-shop-acme.example.org' -H 'cookie: $SA' $G/s/token)\" = 404 ]"
check "a POST from another site (a foreign Origin, cross-site, none, or no Sec-Fetch-Site with Origin null): refused, nothing sealed" bash -c "for h in 'origin: https://evil.example' 'sec-fetch-site: cross-site' 'sec-fetch-site: none'; do [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'cookie: $SA' -H \"\$h\" -d 'a=set&v=$TA' $G/s/token)\" = 403 ] || exit 1; done; [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'cookie: $SA' -H 'origin: null' -d 'a=set&v=$TA' $G/s/token)\" = 403 ] && [ ! -e '$V/claude_token.alice.age' ]"
check "a value not in a token's shape: refused (400), nothing sealed, the page never repeats it" bash -c "[ \"\$(post '$SA' set '$BADV')\" = 400 ] && grep -q 'sk-ant-oat01-' '$T/page' && ! grep -q '$BADV' '$T/page' && [ ! -e '$V/claude_token.alice.age' ]"
check "too long: refused (413)" bash -c "[ \"\$(post '$SA' set \"sk-ant-oat01-\$(head -c 6000 /dev/zero | tr '\\0' a)\")\" = 413 ] && [ ! -e '$V/claude_token.alice.age' ]"
check "set: Saved, and the answer does not hold it" bash -c "[ \"\$(post '$SA' set '$TA')\" = 200 ] && grep -q 'Saved' '$T/page' && ! grep -qF '$TA' '$T/page'"
check "the stored form is sealed: 0600 in the vault, not the value in the clear, and the recovery key opens it" bash -c "[ \$(stat -c %a '$V/claude_token.alice.age') = 600 ] && ! grep -qF '$TA' '$V/claude_token.alice.age' && [ \"\$(age -d -i '$T/recovery.key' '$V/claude_token.alice.age')\" = '$TA' ] && mm vault ls -o json | jq -e '.[] | select(.name==\"claude_token.alice\") | .intact'"
check "the page again: Set, since a time, never the value" bash -c "gw -H 'cookie: $SA' $G/s/token >'$T/p2'; grep -q '<b>Set</b> since' '$T/p2' && ! grep -qF '$TA' '$T/p2' && grep -q 'Remove my token' '$T/p2'"
check "mm user ls: alice set, bob none (nothing more)" bash -c "[ \"\$(ls_of alice)\" = set ] && [ \"\$(ls_of bob)\" = none ] && ! mm user ls -o json | grep -qF 'sk-ant-'"
check "replace: Replaced, and the sealed value is the new one" bash -c "[ \"\$(post '$SA' set '$TA2')\" = 200 ] && grep -q 'Replaced' '$T/page' && [ \"\$(age -d -i '$T/recovery.key' '$V/claude_token.alice.age')\" = '$TA2' ]"
check "one person can't touch another's: bob's remove and set act on bob's own only" bash -c "[ \"\$(post '$SB' remove)\" = 200 ] && grep -q 'No token was set' '$T/page' && [ -e '$V/claude_token.alice.age' ] && [ \"\$(post '$SB' set '$TB')\" = 200 ] && [ \"\$(age -d -i '$T/recovery.key' '$V/claude_token.alice.age')\" = '$TA2' ] && [ \"\$(age -d -i '$T/recovery.key' '$V/claude_token.bob.age')\" = '$TB' ]"
check "...a name in the form is not read (the person is the session's)" bash -c "gw -o /dev/null -H 'cookie: $SB' -H 'origin: null' -H 'sec-fetch-site: same-origin' --data-urlencode 'a=remove' --data-urlencode 'name=alice' $G/s/token; [ -e '$V/claude_token.alice.age' ] && [ ! -e '$V/claude_token.bob.age' ]"
check "remove: Removed, the sealed file and its digest are gone, mm user ls says none" bash -c "[ \"\$(post '$SA' remove)\" = 200 ] && grep -q 'Removed' '$T/page' && [ ! -e '$V/claude_token.alice.age' ] && ! grep -q '^claude_token.alice ' '$V/digests.txt' && [ \"\$(ls_of alice)\" = none ]"
post "$SA" set "$TA" >/dev/null; post "$SB" set "$TB" >/dev/null

echo '== the owner, in their own terminal'
check "mm user claude-token (from a pipe): the owner's own is sealed" bash -c "printf '%s\n' '$TO' | mm user claude-token >/dev/null && [ \"\$(age -d -i '$T/recovery.key' '$V/claude_token.boss.age')\" = '$TO' ] && [ \"\$(ls_of boss)\" = set ]"
check "...not in a token's shape: refused, nothing changed" bash -c "! printf '%s\n' '$BADV' | mm user claude-token && [ \"\$(age -d -i '$T/recovery.key' '$V/claude_token.boss.age')\" = '$TO' ]"
check "...in an agent's shell: refused, nothing changed" bash -c "! printf '%s\n' '$TB' | CLAUDECODE=1 mm user claude-token 2>'$T/ag' && grep -q 'your own terminal' '$T/ag' && ! CLAUDECODE=1 mm user claude-token --remove && [ -e '$V/claude_token.boss.age' ]"
check "...--remove, then set again" bash -c "mm user claude-token --remove >/dev/null && [ ! -e '$V/claude_token.boss.age' ] && printf '%s\n' '$TO' | mm user claude-token >/dev/null && [ -e '$V/claude_token.boss.age' ]"

echo '== mm run-as: a run for one person, on their own token'
# a project as mm makes it (only what bin/lead needs), and a stand-in for Paseo's CLI package and its client library
P="$MM_HOME/projects/acme/shop"; ST="$T/st"; mkdir -p "$P/bin/lib" "$P/leads/qa" "$ST" "$T/pcli/bin" "$T/pcli/dist/utils" "$T/pcli/dist/commands/agent"
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: sh\nroot: %s\ntemplate_version: test\ncreated: test\n' "$P" >"$P/.mm-answers.yaml"
printf 'services: {}\n' >"$P/services.yaml"
cp "$SRC/template/bin/lead" "$P/bin/lead"; for f in run-as paseo svc; do cp "$SRC/template/bin/lib/$f.mjs" "$P/bin/lib/$f.mjs"; done; chmod +x "$P/bin/lead"
printf 'Hello, you are the {role} lead of {project}.\n' >"$P/leads/START.md"; printf '{"roles":[{"id":"qa"}]}\n' >"$P/leads/roles.json"
for f in config-check wt; do printf '#!/bin/sh\nexit 0\n' >"$P/bin/$f"; chmod +x "$P/bin/$f"; done
printf '#!/bin/sh\necho "[]"\n' >"$P/bin/bd"; chmod +x "$P/bin/bd"
printf 'console.log("%s/claude")\n' "$T" >"$P/bin/lib/claude.mjs"; printf 'console.log("ws-1")\n' >"$P/bin/lib/lead-workspace.mjs"
echo '{"name":"@getpaseo/cli","type":"module"}' >"$T/pcli/package.json"
# the daemon's worker: a real process (its start time is read from /proc); `ls`: the run is there while $ST/live is
sleep 100000 & WK=$!; echo "$WK" >"$ST/worker.pid"; WID="$WK.$(cut -d' ' -f22 /proc/$WK/stat)"
cat >"$T/pcli/bin/paseo" <<EOF
#!/bin/sh
case "\$1" in
  run) echo plain >>"$ST/plain" ;;
  daemon) [ -s "$ST/worker.pid" ] && printf '{"workerPid": %s}\n' "\$(cat "$ST/worker.pid")" || exit 1 ;;
  ls) case "\$*" in *" -q"*) exit 0 ;; esac  # bin/lead's own look: no lead to archive
      echo "\$*" >>"$ST/ls.log"; [ -e "$ST/live" ] && echo '[{"id":"agent-1"}]' || echo '[]' ;;
esac
exit 0
EOF
chmod +x "$T/pcli/bin/paseo"
echo 'export function selectDaemonTarget() { return { kind: "instance", home: "stub" } }' >"$T/pcli/dist/utils/daemon-target.js"
cat >"$T/pcli/dist/commands/agent/run.js" <<'EOF'
// what the run would get: the environment's names, and the token only as its sha256 (never the value)
import fs from 'node:fs'; import { createHash } from 'node:crypto'
export async function runRunCommand(prompt, o) {
  const env = Object.fromEntries(o.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
  const t = env.CLAUDE_CODE_OAUTH_TOKEN
  fs.appendFileSync(process.env.STUB_DIR + '/runs.jsonl', JSON.stringify({ title: o.title, labels: o.label, wait: o.wait, keys: Object.keys(env).sort(),
    token_sha: t ? createHash('sha256').update(t).digest('hex') : null, api_key: env.ANTHROPIC_API_KEY, auth_token: env.ANTHROPIC_AUTH_TOKEN, base_url: env.ANTHROPIC_BASE_URL,
    scrub: env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, person: env.MM_PERSON, prompt_has_role: prompt.includes('qa lead'),
    prompt_for_alice: prompt.includes('This run is for alice'), prompt_has_s1: prompt.includes('s-1 (in_progress)'), prompt_has_s2: prompt.includes('s-2 (') }) + '\n')
  return { type: 'single', data: { agentId: 'agent-1' } }
}
EOF
export PASEO_BIN="$T/pcli/bin/paseo" STUB_DIR="$ST" MM_TRACE_SELF="$P/bin/lead" LEAD_ARCHIVE_WAIT=1
last() { tail -1 "$ST/runs.jsonl"; }
runs() { [ -e "$ST/runs.jsonl" ] && wc -l <"$ST/runs.jsonl" || echo 0; }
export -f last runs; export ST

check "alice (a member, her token set): the run starts" bash -c "mm run-as alice acme-shop qa >'$T/ra' 2>&1 && grep -q 'agent-1' '$T/ra'"
check "...with her own token only, as CLAUDE_CODE_OAUTH_TOKEN" bash -c "last | jq -e --arg s \"\$(sha '$TA')\" '.token_sha == \$s'"
check "...nothing else signs its calls (no API key, auth token or other base URL), its shells get no credentials, and it is hers" bash -c "last | jq -e '.api_key == \"\" and .auth_token == \"\" and .base_url == \"\" and .scrub == \"1\" and .person == \"alice\" and (.labels | index(\"person=alice\")) and (.labels | index(\"role=qa\")) and (.title | test(\"for alice\")) and .wait == false and .prompt_has_role'"
check "...the lead's own environment is kept (its Claude folder, its actor)" bash -c "last | jq -e '(.keys | index(\"CLAUDE_CONFIG_DIR\")) and (.keys | index(\"BEADS_ACTOR\"))'"
check "...labelled with the Paseo daemon's worker (its pid and start), so a daemon restart archives it" bash -c "last | jq -e --arg w 'paseo-worker=$WID' '.labels | index(\$w)'"
cp "$P/bin/bd" "$T/bd.empty"; printf '#!/bin/sh\ncat %s\n' "$T/handover.json" >"$P/bin/bd"
echo '[{"id":"s-1","status":"in_progress","title":"hers"},{"id":"s-2","status":"blocked","title":"his"}]' >"$T/handover.json"
check "...its first prompt says whose run it is, and its handover is only the items LEAD_ITEMS names" bash -c "LEAD_ITEMS=s-1 mm run-as alice acme-shop qa >/dev/null 2>&1 && last | jq -e '.prompt_for_alice and .prompt_has_s1 and (.prompt_has_s2 | not)'"
cp "$T/bd.empty" "$P/bin/bd"
mv "$ST/worker.pid" "$ST/worker.off"; n0=$(runs)
check "the daemon does not say its worker: no run" bash -c "! mm run-as alice acme-shop qa 2>'$T/rw' && grep -q 'did not say which worker' '$T/rw' && [ \$(runs) = $n0 ]"
mv "$ST/worker.off" "$ST/worker.pid"
check "...the opened file is gone from the secrets tmpfs" bash -c "[ -d '$SHM/mm/secrets/_run' ] && [ -z \"\$(ls -A '$SHM/mm/secrets/_run')\" ] && [ \$(stat -c %a '$SHM/mm/secrets/_run') = 700 ]"
check "the owner (token set): the owner's own token" bash -c "mm run-as boss acme-shop qa >/dev/null 2>&1 && last | jq -e --arg s \"\$(sha '$TO')\" '.token_sha == \$s and .person == \"boss\"'"
n=$(runs)
check "carol (a member, no token): refused, it says to set it on the home page, and no run (the owner's token is never used for her)" bash -c "! mm run-as carol acme-shop qa 2>'$T/rc' && grep -q 'set your Claude token on the home page' '$T/rc' && grep -q 'https://$AUTH/s/token' '$T/rc' && [ \$(runs) = $n ] && [ ! -e '$ST/plain' ]"
check "a viewer, a person with no grant there, and no such person: refused, no run" bash -c "! mm run-as vic acme-shop qa && mm user add dave >/dev/null && ! mm run-as dave acme-shop qa && ! mm run-as nobody acme-shop qa && [ \$(runs) = $n ] && [ ! -e '$ST/plain' ]"
check "a role or a name that is not one: refused" bash -c "! mm run-as alice acme-shop 'qa;x' && ! mm run-as 'Alice' acme-shop qa && [ \$(runs) = $n ]"
check "in an agent's shell: refused (mm run-as, and bin/lead --as itself, even with a token on stdin)" bash -c "! CLAUDECODE=1 mm run-as alice acme-shop qa && ! (printf '%s\n' '$TA' | PASEO_AGENT_ID=x '$P/bin/lead' start qa --as alice) && ! (printf '%s\n' '$TA' | CLAUDECODE=1 '$P/bin/lead' start qa --as alice) && [ \$(runs) = $n ]"
check "bin/lead --as with no token on stdin: no run" bash -c "! '$P/bin/lead' start qa --as alice </dev/null && [ \$(runs) = $n ]"
check "a plain bin/lead start (no person) is unchanged: paseo run, no token" bash -c "'$P/bin/lead' start qa >/dev/null 2>&1 && grep -q plain '$ST/plain' && [ \$(runs) = $n ]"
rm -f "$V/claude_token.boss.age"
check "the owner with no personal token: the machine's own (the owner's), with a note, never another's" bash -c "mm run-as boss acme-shop qa 2>'$T/rb' >/dev/null && grep -q \"machine's own token\" '$T/rb' && [ \$(runs) = $n ] && [ \$(grep -c plain '$ST/plain') = 2 ]"
printf '%s\n' "$TO" | mm user claude-token >/dev/null
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: sh\nroot: %s\ntemplate_version: test\ncreated: test\nbox: true\n' "$P" >"$P/.mm-answers.yaml"
# a stand-in for docker: the box and its proxy are "running" (while $T/box.up is); exec runs the command here (the
# box's sh -c ...) with the environment its -e flags name, so bin/lead --as and the box's `paseo ls` are the stand-ins
# above; a proxy restart is logged
cat >"$T/dock" <<EOF
#!/bin/bash
echo "\$*" >>"$T/dock.log"
case "\$1" in
  inspect) [ -e "$T/box.up" ] && echo true || echo false ;;
  container) exit 0 ;;
  restart) echo "RESTART \$4" >>"$T/proxy.log" ;;
  exec) shift; while [ \$# -gt 0 ] && ! { [ "\$1" = sh ] && [ "\$2" = -c ]; }; do case "\$1" in -e) export "\$2"; shift ;; -w) shift ;; esac; shift; done; exec "\$@" ;;
esac
exit 0
EOF
chmod +x "$T/dock"; ln -sf "$T/pcli/bin/paseo" "$T/bin/paseo"; touch "$T/box.up"
export MM_DOCKER="$T/dock" MM_AI_DIR="$T/ai"
ALLOW="$MM_HOME/egress/acme-shop/allow"; REC="$MM_HOME/person-runs/acme-shop.json"
cat >"$T/sweep.ts" <<EOF
import { sweep } from '$SRC/src/runas'
console.log(JSON.stringify(sweep('$P')))
EOF
# the run's key as mm.ai keeps it (its sha256 only): kind, person, project, expires, revoked
cat >"$T/key.ts" <<EOF
import { Database } from 'bun:sqlite'
const d = new Database('$T/ai/ai.db', { readonly: true })
const q = 'SELECT project, person, kind, expires, revoked FROM ai_key'
console.log(JSON.stringify((process.argv[2] === 'latest' ? d.query(q + ' ORDER BY created DESC LIMIT 1').get() : d.query(q + ' WHERE hash = ?').get(process.argv[2])) ?? null))
EOF
restarts() { [ -e "$T/proxy.log" ] && wc -l <"$T/proxy.log" || echo 0; }
keyof() { bun "$T/key.ts" "$(last | jq -r .api_key | tr -d '\n' | sha256sum | cut -d' ' -f1)"; }
export -f restarts keyof; export ALLOW REC
n=$(runs)
check "a box, mm.ai off: a person's run is refused (it reaches the model through mm.ai only), no run" bash -c "! mm run-as alice acme-shop qa 2>'$T/roff' && grep -q 'through mm.ai only' '$T/roff' && [ \$(runs) = $n ] && [ ! -e '$REC' ]"
export MM_AI_ENABLED=1
check "a box, no monthly mm.ai budget of hers for the project: refused, the owner must set one first; no run, no key (sy-otxx condition 3)" bash -c "! mm run-as alice acme-shop qa 2>'$T/rnob' && grep -q 'alice has no monthly AI budget for acme-shop' '$T/rnob' && grep -q 'the owner must set one first' '$T/rnob' && [ \$(runs) = $n ] && [ ! -e '$REC' ] && [ \"\$(bun '$T/key.ts' latest)\" = null ]"
mm ai budget acme-shop 0.000001 --person alice >/dev/null
bun -e "import { Database } from 'bun:sqlite'; const d = new Database('$T/ai/ai.db'); d.query('INSERT INTO ai_usage VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)').run(Date.now(), 'acme-shop', 'alice', 'm', 1)"
check "...a budget of hers that is used up this month: refused too (the owner can raise it), no run" bash -c "! mm run-as alice acme-shop qa 2>'$T/rnob' && grep -q 'AI budget of alice in acme-shop is used up' '$T/rnob' && [ \$(runs) = $n ] && [ ! -e '$REC' ]"
mm ai budget acme-shop 5 --person alice >/dev/null
check "a box: the run starts (over docker exec -i, stdin, no TTY), with no token at all: its own mm.ai key, to the box's mm.ai address" bash -c "mm run-as alice acme-shop qa >'$T/rbox' 2>'$T/rbox.err' && grep -q agent-1 '$T/rbox' && [ \$(runs) = \$(( $n + 1 )) ] && last | jq -e '.token_sha == null and (.api_key | test(\"^mmk_[A-Za-z0-9_-]{32}\$\")) and (.base_url | test(\"^http://[a-z0-9.-]+:4000\$\")) and .auth_token == \"\" and .person == \"alice\"' && grep -q '^exec -i -w $P ' '$T/dock.log' && ! grep -q -- '-it' '$T/dock.log'"
check "...mm.ai keeps its key (sha256 only): kind person, alice, acme-shop, ending by the host's clock (as the run's label says)" bash -c "keyof | jq -e '.kind == \"person\" and .person == \"alice\" and .project == \"acme-shop\" and .revoked == 0' && e=\$(keyof | jq .expires) && last | jq -e --arg e \"run-expires=\$(( e / 1000 ))\" '.labels | index(\$e)' && [ \$(( e - \$(date +%s%3N) )) -gt \$(( 3 * 3600000 )) ]"
check "...the box's egress never gets the model's host (no proxy restart), and no token went into docker's command line" bash -c "! grep -qF 'anthropic' '$ALLOW' 2>/dev/null && [ \$(restarts) = 0 ] && ! grep -q 'sk-ant' '$T/dock.log'"
check "...the host's record has her run (its agent id, when its key ends), no token or key in it, 0600" bash -c "jq -e '.runs | length == 1 and .[0].person == \"alice\" and .[0].agent == \"agent-1\" and .[0].role == \"qa\" and (.[0].expires > 0)' '$REC' && ! grep -q 'sk-ant\|mmk_' '$REC' && [ \$(stat -c %a '$REC') = 600 ]"
check "the sweep before the key ends: the run stays (the box is not asked)" bash -c "bun '$T/sweep.ts' | jq -e '.dropped == 0 and .left == 1' && ! grep -qs -- '--label project=acme-shop' '$ST/ls.log'"
jq '.runs[0].expires = 1000' "$REC" >"$REC.x" && mv "$REC.x" "$REC"
check "the sweep once its key has ended (the host's clock): the record goes, no proxy restart" bash -c "bun '$T/sweep.ts' | jq -e '.dropped == 1 and .left == 0' && [ ! -e '$REC' ] && [ \$(restarts) = 0 ]"
mv "$ST/worker.pid" "$ST/worker.off"
check "a run in the box that does not start: nothing recorded, and its key is revoked at once" bash -c "! mm run-as alice acme-shop qa 2>'$T/rbad' && [ ! -e '$REC' ] && [ \$(restarts) = 0 ] && bun '$T/key.ts' latest | jq -e '.kind == \"person\" and .revoked == 1'"
mv "$ST/worker.off" "$ST/worker.pid"
printf '{"runs":[{"person":"alice","role":"qa","agent":"agent-0","at":1000}]}\n' >"$REC"
check "a record from before (no expiry): the sweep drops it and reloads the box's egress once" bash -c "bun '$T/sweep.ts' | jq -e '.dropped == 1 and .left == 0 and (.egress | test(\"off\"))' && [ ! -e '$REC' ] && [ \$(restarts) = 1 ]"
unset MM_AI_ENABLED MM_AI_DIR
printf 'services: {}\n' >"$P/services.yaml"; unset MM_DOCKER
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: sh\nroot: %s\ntemplate_version: test\ncreated: test\n' "$P" >"$P/.mm-answers.yaml"
check "mm user rm alice: her token goes with her account" bash -c "mm user rm alice >/dev/null && [ ! -e '$V/claude_token.alice.age' ]"

echo '== no token anywhere outside the vault'
sleep 0.3
check "the gateway logs it changed, and who, never the value" bash -c "grep -q 'claude token set' '$T/gw.log' && grep -q 'claude token replaced' '$T/gw.log' && grep -q 'claude token removed' '$T/gw.log'"
check "no token in any log, page, output or file in the test's folders, the home, or the secrets tmpfs" bash -c "for t in '$TA' '$TA2' '$TB' '$TO'; do ! grep -rqF \"\$t\" '$T' '$SHM' || { grep -rlF \"\$t\" '$T' '$SHM'; exit 1; }; done"
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
