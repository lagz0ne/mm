#!/usr/bin/env bash
# The system board's own Doop (sy-0iwr), hermetic: a throwaway HOME / MM_HOME, a system board rendered from mm's
# template as mm new lays it out (nothing started, no process manager, no container), and mm's sign-in gateway on a
# free port. Proves: as shipped (doop off) the board's services and public names are as before (dolt, bd-serve,
# board, wake; nothing public), and the platform lead has no Doop MCP; with `services_on: [doop]` (what
# `mm doop on <board>` writes) the doop service is in the process list (bin/doop-run, its gated public side), its
# public name is doop-<board>.<domain> behind the sign-in, the platform lead gets the doop MCP (and only it), the
# backup takes data/doop/; the gateway sends a request with no session to the sign-in (302, never open), lets the owner
# in with an assertion for that host, and nobody else; off again, the name is gone.
#   test/system-doop.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); GW=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_OBS_METRICS="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE MM_PROJECT MM_SERVICE MM_DOOP_IMAGE MM_BRAIN MM_PROJECTS
mkdir -p "$MM_HOME/pc/projects"
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
PORT=$(free_port); AUTH=auth.example.org; DOOPH=doop-system.example.org
printf 'domain: example.org\naccess: domain\nauth_port: %s\nbind_host: 127.0.0.1\nowner_name: boss\n' "$PORT" >"$MM_HOME/config.yaml"

# the system board, as mm new lays it out (profile system, project id system), and registered as the process manager has it
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const [root] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'mm', name: 'system', project: 'system', short: 'sy', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, profile: 'system' }, null, 2) + '\n')
renderTo(root, { ...templateVars(root), profile: 'system' }, t)
EOF
SYS="$T/sys"
bun "$T/stamp.ts" "$SYS" >/dev/null || { echo "stamp failed"; exit 1; }
echo "# from $SYS/services.yaml" >"$MM_HOME/pc/projects/system.yaml"
# what mm up computes, without starting anything: the processes (as up() names them) and the run files
cat >"$T/plan.ts" <<EOF
import { resolve, serviceProcess, writeRunFiles } from '$SRC/src/project'
import { hostClaims } from '$SRC/src/auth'
const [root, out] = process.argv.slice(2)
const r = resolve(root), procs: Record<string, any> = {}
for (const [n, s] of Object.entries(r.services)) {
  procs[\`\${r.answers.project}.\${n}\`] = serviceProcess(root, r.answers.project, n, s, r.services, { env: {}, socket: r.socket, pdeath: '', claim: '' })
  if (s.public_port && s.public_bind && !/^(127\\.|localhost\$|::1\$)/.test(s.public_bind)) procs[\`\${r.answers.project}.\${n}-public\`] = {}
}
writeRunFiles(root, '/nonexistent/pc.sock')
const { claims, hosts } = hostClaims()
await Bun.write(out, JSON.stringify({ services: r.services, procs, claims: Object.fromEntries(Object.entries(claims).map(([h, m]) => [h, Object.fromEntries(m)])),
  hosts: Object.fromEntries(Object.entries(hosts).map(([h, s]) => [h, [...s]])) }, null, 2))
EOF
plan() { bun "$T/plan.ts" "$SYS" "$T/plan.json"; }
J() { jq -e "$1" "$T/plan.json"; }
cc() { (cd "$SYS" && node bin/config-check "$@" 2>&1); }
export -f J; export T

echo "== as shipped: doop off, the board as before"
plan || { echo "plan failed"; exit 1; }
cc --render >/dev/null
check "the system profile declares doop as an optional service (off until switched on)" bash -c "grep -q '^  doop:' '$SYS/services.yaml' && ! grep -q services_on '$SYS/.mm-answers.yaml'"
check "its services are dolt, bd-serve, board, wake (no doop)" J '(.services | keys) == ["bd-serve","board","dolt","wake"]'
check "...and the process list is those four" J '(.procs | keys) == ["system.bd-serve","system.board","system.dolt","system.wake"]'
check "...nothing public: no public name, no gateway claim, no host" J '([.services[] | select(.public_url)] | length) == 0 and (.claims | length) == 0 and (.hosts | length) == 0'
check "the platform lead has no .mcp.json (no Doop MCP while Doop is off)" test ! -e "$SYS/leads/platform/.mcp.json"
check "config-check passes" bash -c "cd '$SYS' && node bin/config-check"

echo "== switched on (what mm doop on <board> writes: services_on: [doop])"
echo 'services_on: [doop]' >>"$SYS/.mm-answers.yaml"
plan || { echo "plan failed"; exit 1; }
cc --render >/dev/null
check "doop is in the process list, next to the four" J '(.procs | keys) == ["system.bd-serve","system.board","system.dolt","system.doop","system.wake"]'
check "...it runs bin/doop-run with DOOP_URL and its gated public side's port (DOOP_PUBLIC_PORT)" bash -c "J '.procs[\"system.doop\"].command | test(\"/bin/doop-run\")' && J '.procs[\"system.doop\"].environment | any(test(\"^DOOP_URL=http://doop.system.localhost:\"))' && J '.procs[\"system.doop\"].environment | any(test(\"^DOOP_PUBLIC_PORT=[0-9]+\$\"))'"
check "...its stop time (30 s) and its health check (/healthz)" bash -c "J '.procs[\"system.doop\"].shutdown.timeout_seconds == 30' && J '.procs[\"system.doop\"].readiness_probe.exec.command | test(\"/healthz\")'"
check "its public name is doop-system.example.org, behind the sign-in (auth: required)" J '.services.doop.public_url == "https://doop-system.example.org" and .services.doop.public.auth == "required"'
check "...the gateway claims that host for the system board, and it is the board's only public host" J '(.claims | keys) == ["doop-system.example.org"] and (.claims["doop-system.example.org"] | keys) == ["system"] and (.hosts | keys) == ["doop-system.example.org"]'
check "...the board itself and its other services stay off the public side" J '([.services | to_entries[] | select(.value.public_url) | .key]) == ["doop"]'
check "endpoints.json names Doop's local and public address, and the pinned image" bash -c "jq -e '.services.doop.url and .services.doop.public == \"https://doop-system.example.org\" and (.containers.doop_image | test(\"sha256:[0-9a-f]{64}\$\"))' '$SYS/.run/endpoints.json'"
MCP="$SYS/leads/platform/.mcp.json"
check "the platform lead gets the doop MCP: loopback URL /mcp, the key from bin/doop-mcp-headers" bash -c "jq -e '.mcpServers | keys == [\"doop\"]' '$MCP' && jq -e '.mcpServers.doop.url | test(\"^http://doop.system.localhost:[0-9]+/mcp\$\")' '$MCP' && jq -e '.mcpServers.doop.headersHelper == \"$SYS/bin/doop-mcp-headers\"' '$MCP'"
check "...approved in its local settings, allowed in its settings" bash -c "jq -e '.enabledMcpjsonServers == [\"doop\"]' '$SYS/leads/platform/.claude/settings.local.json' && jq -e '.permissions.allow | index(\"mcp__doop\")' '$SYS/leads/platform/.claude/settings.json'"
check "...no other lead gets it (ops, review)" bash -c "[ ! -e '$SYS/leads/ops/.mcp.json' ] && [ ! -e '$SYS/leads/review/.mcp.json' ]"
check "...it may not run the key's helper or read secrets/ (the guard's and config-check's denies hold)" bash -c "jq -e '.permissions.deny | index(\"Bash(*doop-mcp-headers*)\")' '$SYS/leads/platform/.claude/settings.json' && jq -e '.permissions.deny | any(test(\"secrets\"))' '$SYS/leads/platform/.claude/settings.json'"
check "git ignores what the switch makes (the MCP files, .run/, data/, secrets/)" bash -c "cd '$SYS' && git init -q && mkdir -p data/doop secrets && touch data/doop/x secrets/doop-agent-key && [ -z \"\$(git status --porcelain --ignored=no -- leads/platform/.mcp.json leads/platform/.claude/settings.local.json .run data secrets)\" ]"
check "config-check passes with it on" bash -c "cd '$SYS' && node bin/config-check"
# the backup takes data/doop/ through bin/doop-run backup (stubbed here: no container); its archive is named doop.tar.gz
check "bin/backup takes data/doop/ (doop-run backup) when the board has it" bash -c "grep -q 'data/doop' '$SYS/bin/backup' && grep -q 'doop-run\" backup' '$SYS/bin/backup' && [ -x '$SYS/bin/doop-run' ] && [ -f '$SYS/bin/lib/doop-init.mjs' ] && [ -x '$SYS/bin/doop-mcp-headers' ]"

echo "== the gateway: doop-system only after the sign-in"
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
export PATH="$T/bin:$PATH"
MM_AUTH_HOST_CACHE_MS=200 mm auth serve >"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/s" && break; sleep 0.2; done
G="http://127.0.0.1:$PORT"
gw() { curl -s -H "x-forwarded-host: $AUTH" -H 'x-forwarded-proto: https' "$@"; }
sess() { sed -n 's/^set-cookie: \(__Secure-better-auth\.session_token=[^;]*\).*/\1/ip' "$1" | tail -1; }
qs() { printf '%s' "${1#*\?}" | tr '&' '\n' | sed -n "s/^$2=//p"; }
open_link() { gw -D "$2" -o /dev/null -H 'origin: null' -H 'sec-fetch-site: same-origin' -d "t=$(qs "$1" token)&c=$(qs "$1" callbackURL)" "$G/s/l"; }
vf() { curl -s -D - -o /dev/null ${2:+-b "$2"} -H "x-forwarded-host: $1" -H 'x-forwarded-uri: /c/x' -H 'x-forwarded-proto: https' "$G/verify"; }
asr() { vf "$@" | sed -n 's/^x-mm-assertion: \(.*\)\r$/\1/ip' | grep -vx -- -; }
cat >"$T/verify.mjs" <<'EOF'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
const [a, keyFile, host, user, role] = process.argv.slice(2), [body, sig] = String(a).split('.')
const pub = createPublicKey(createPrivateKey(readFileSync(keyFile, 'utf8')))
const c = JSON.parse(Buffer.from(body, 'base64url').toString())
process.exit(verify(null, Buffer.from(body), pub, Buffer.from(sig, 'base64url')) && c.u === user && c.r === role && c.h === host ? 0 : 1)
EOF
export -f gw vf asr; export G AUTH DOOPH MM_HOME
check "the gateway runs" bash -c "curl -s -o /dev/null $G/s"
check "no session: 302 to the sign-in for doop-system, back to the same path (never open)" bash -c "vf $DOOPH | head -1 | grep -q 302 && vf $DOOPH | grep -qi '^location: https://$AUTH/s?b=$DOOPH&r=%2Fc%2Fx' && [ -z \"\$(asr $DOOPH)\" ]"
check "...the identity headers are '-' on that refusal (a client's copy can't pass)" bash -c "vf $DOOPH | grep -qiE '^x-mm-assertion: -[[:space:]]*\$'"
mm user add boss --owner >/dev/null 2>&1; mm user add alex >/dev/null 2>&1
LB=$(mm user link boss -o json | jq -r .link); open_link "$LB" "$T/hb"; SB=$(sess "$T/hb")
CBB=$(gw -D - -o /dev/null -H "cookie: $SB" "$G/s?b=$DOOPH&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
curl -s -c "$T/jb" -H "x-forwarded-host: $DOOPH" -o /dev/null "$G$CBB"
check "the owner, signed in: the host's callback, then an assertion for doop-system as owner" bash -c "echo '$CBB' | grep -q '^/_mm/auth/callback?c=' && node '$T/verify.mjs' \"\$(asr $DOOPH '$T/jb')\" '$MM_HOME/auth/signing.key' '$DOOPH' boss owner"
check "a grant on the system board is refused (nobody but the owner holds a role there)" bash -c "! mm grant alex system --as designer"
LA=$(mm user link alex -o json | jq -r .link); open_link "$LA" "$T/ha"; SA=$(sess "$T/ha")
check "another person, signed in: no callback for doop-system (no access), no assertion" bash -c "gw -D '$T/ah' -o '$T/ab' -H 'cookie: $SA' '$G/s?b=$DOOPH&r=/'; ! grep -qi '^location: .*/_mm/auth/callback' '$T/ah' && [ -z \"\$(asr $DOOPH)\" ]"
check "...a forged x-mm-assertion from the client counts for nothing (302)" bash -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $DOOPH' -H 'x-mm-assertion: e30.x' $G/verify | head -1 | grep -q 302"

echo "== switched off again: the name is gone"
sed -i '/^services_on:/d' "$SYS/.mm-answers.yaml"
plan || { echo "plan failed"; exit 1; }
cc --render >/dev/null
check "no doop process, no public host, no claim" J '(.procs | keys) == ["system.bd-serve","system.board","system.dolt","system.wake"] and (.claims | length) == 0 and (.hosts | length) == 0'
check "the platform lead's doop MCP is gone" bash -c "[ ! -e '$SYS/leads/platform/.mcp.json' ] && [ ! -e '$SYS/leads/platform/.claude/settings.local.json' ]"
sleep 0.5
check "the gateway gives the owner's cookie no assertion for doop-system any more" bash -c "[ -z \"\$(asr $DOOPH '$T/jb')\" ]"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
