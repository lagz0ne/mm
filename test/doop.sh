#!/usr/bin/env bash
# A project's own Doop (plans/doop.md, sy-d2t), on this machine: a throwaway project, `mm doop on`, and the design
# lead's MCP the way bin/lead starts it. Needs the Doop image pinned by digest, sha256:<64 hex> (MM_DOOP_IMAGE or doop.image in the config; sy-7452) and
# docker (MM_DOCKER or box.docker). Nothing outside the throwaway project, its container and its Claude folder changes.
#   MM_DOOP_IMAGE=<image> test/doop.sh [client/name]     (MM_DOCKER: mm's Docker wrapper, through sudo, by default)
set -uo pipefail
PROJECTS_DIR=$(grep -qsE '^layout: *.?one-root' "${MM_HOME:-$HOME/.mm}/config.yaml" && echo "${MM_HOME:-$HOME/.mm}/projects" || echo "$HOME/projects")   # where mm keeps projects (its layout)
REF=${1:-qa/doopt}; PROJECT=${REF/\//-}; ROOT="$PROJECTS_DIR/$REF"
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
. "$(dirname "$0")/lib/routes.sh"   # this run's routes in its own folder, never in the live web proxy (review sy-uzh)
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
D() { ${MM_DOCKER:-sudo -n /usr/local/libexec/mm-docker} "$@"; }
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/tmp/doop-test.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/doop-test.out | sed 's/^/       /'; fi; }
T=$(mktemp -d); C="mm-doop-$PROJECT"; URL="http://doop.$PROJECT.localhost:1355"
cleanup() { [ -n "${KEEP:-}" ] && return; mm archive "$REF" >/dev/null 2>&1; D rm -f "$C" >/dev/null 2>&1; D network rm "mm-doop-net-$PROJECT" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT
export -f D; export MM_DOCKER
# the MCP's tools with the key from its file (never printed)
cat >"$T/mcp-tools.mjs" <<'EOF'
import fs from 'node:fs'
const [url, keyFile] = process.argv.slice(2), key = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : ''
const h = { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const call = async (body, extra = {}) => { const r = await fetch(url, { method: 'POST', headers: { ...h, ...extra }, body: JSON.stringify(body) }); const t = await r.text(), m = /^data: (.*)$/m.exec(t)
  return { status: r.status, session: r.headers.get('mcp-session-id'), json: (() => { try { return JSON.parse(m ? m[1] : t) } catch { return null } })() } }
const i = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mm-qa', version: '1' } } })
if (i.status !== 200) { console.log(`HTTP ${i.status}`); process.exit(1) }
const s = i.session ? { 'mcp-session-id': i.session } : {}
await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, s)
const l = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, s), n = l.json?.result?.tools?.length || 0
console.log(`${n} tools`); process.exit(n ? 0 : 1)
EOF

echo "== a project, Doop off by default"
mm new "$REF" --throwaway >/tmp/doop-new.out 2>&1 || { tail -15 /tmp/doop-new.out; exit 1; }
check "mm new: no doop service, and the design lead has no Doop MCP" sh -c "! mm inspect '$REF' | grep -q '^doop ' && ! test -e '$ROOT/leads/design/.mcp.json'"

echo "== mm doop on"
check "mm doop on $REF" mm doop on "$REF"
for _ in $(seq 1 180); do curl -sf -o /dev/null "$URL/healthz" && break; sleep 1; done
check "Doop answers by its name ($URL)" curl -sf -o /dev/null "$URL/healthz"
# its way in: a loopback forwarder (socat) to its address on its own network; nothing published (review sy-d2t #8 2)
NET="mm-doop-net-$PROJECT"; CIP=$(D inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$C" 2>/dev/null)
HP=$(ps -eo args | grep -v grep | sed -n "s/.*socat TCP-LISTEN:\([0-9]*\),bind=127[.]0[.]0[.]1,.* TCP:$CIP:4400\$/\1/p" | head -1)
check "loopback only: a forwarder on 127.0.0.1:$HP to Doop ($CIP), nothing published, the port on no other address" bash -c "[ -n '$HP' ] && [ -z \"\$(D port '$C')\" ] && ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$HP' && ! ss -Hltn | awk '{print \$4}' | grep -v '^127[.]0[.]0[.]1:' | grep -qE ':$HP\$'"
DU=$(D inspect -f '{{.Config.User}}' "$C" 2>/dev/null)
check "the container: its own uid ($DU: 210000 + its subnet's n; not the owner's, not root), the owner's group, a read-only root, no capabilities, no new privileges" bash -c "u=\${1%%:*}; [ \"\$u\" -ge 210010 ] && [ \"\$u\" -le 210249 ] && [ \"\$(D exec '$C' id -u)\" = \"\$u\" ] && [ \"\${1#*:}\" = '$(id -g)' ] && [ \"\$(D inspect -f '{{.HostConfig.ReadonlyRootfs}}' '$C')\" = true ] && D inspect -f '{{.HostConfig.CapDrop}}' '$C' | grep -q ALL && D inspect -f '{{.HostConfig.SecurityOpt}}' '$C' | grep -q no-new-privileges" _ "$DU"
check "its only network is $NET, internal (no route out)" bash -c "[ \"\$(D inspect -f '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' '$C')\" = '$NET ' ] && [ \"\$(D network inspect -f '{{.Internal}}' '$NET')\" = true ]"
cat >"$T/probe.js" <<'PROBE'
const [kind, a, b] = process.argv.slice(1)
const done = (ok, m) => { console.log(m); process.exit(ok ? 0 : 1) }
if (kind === 'dns') require('dns').lookup(a, (e, ip) => done(!e, e ? e.code : ip))
else { const s = require('net').connect({ host: a, port: +b, timeout: 4000 }); s.on('connect', () => done(true, `${a}:${b} open`)); s.on('timeout', () => done(false, `${a}:${b} timeout`)); s.on('error', (e) => done(false, `${a}:${b} ${e.code}`)) }
PROBE
nprobe() { ! D exec -i "$C" node - "$@" <"$T/probe.js"; }
GW=$(D network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NET" 2>/dev/null); BR=$(D network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)
check "no way out: not 1.1.1.1:443" nprobe tcp 1.1.1.1 443
check "...no outside name (example.com)" nprobe dns example.com
check "...not the host's ssh, by its network's gateway ($GW:22) or the docker bridge ($BR:22)" bash -c "! D exec -i '$C' node - tcp '$GW' 22 <'$T/probe.js' && ! D exec -i '$C' node - tcp '$BR' 22 <'$T/probe.js'"
check "its data in the project (data/doop/pg)" test -d "$ROOT/data/doop/pg"
for _ in $(seq 1 60); do [ -s "$ROOT/secrets/doop-agent-key" ] && break; sleep 1; done
check "first start: its own account and the design lead's agent key, in secrets/ (0600, the folder 0700)" sh -c "[ \"\$(stat -c %a '$ROOT/secrets/doop-agent-key')\" = 600 ] && [ \"\$(stat -c %a '$ROOT/secrets')\" = 700 ] && test -s '$ROOT/secrets/doop-password'"
check "...and no secret on a command line: docker run gets an env file" sh -c "a=\$(ps -eo args | grep -F 'run --rm --name $C' | grep -v grep); echo \"\$a\" | grep -q -- '--env-file' && ! echo \"\$a\" | grep -qE 'BETTER_AUTH_SECRET=|SIGNUP_EMAIL_DOMAINS='"
check "Doop's MCP with the key: its tools" node "$T/mcp-tools.mjs" "$URL/mcp" "$ROOT/secrets/doop-agent-key"
check "...without a key: refused" sh -c "! node '$T/mcp-tools.mjs' '$URL/mcp'"
check "sign-up is closed to anyone else (another email domain)" sh -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'origin: $URL' -H 'content-type: application/json' -d '{\"email\":\"x@example.com\",\"password\":\"Xx-12345678-long\",\"name\":\"x\"}' '$URL/api/auth/sign-up/email')\" != 200 ]"

echo "== the design lead's MCP (as bin/lead starts it)"
check "rendered: leads/design/.mcp.json (the project's Doop) and its approval in settings.local.json" sh -c "jq -e --arg u '$URL/mcp' '.mcpServers.doop.url == \$u' '$ROOT/leads/design/.mcp.json' && jq -e '.enabledMcpjsonServers == [\"doop\"]' '$ROOT/leads/design/.claude/settings.local.json'"
CDIR=$(cd "$ROOT" && MM_PROJECT="$PROJECT" node bin/lib/claude.mjs trust "$ROOT/leads/design" "$ROOT")   # as bin/lead start does
check "Claude Code connects (claude mcp list: Connected), with the key from the headersHelper" sh -c "cd '$ROOT/leads/design' && CLAUDE_CONFIG_DIR='$CDIR' timeout 90 claude mcp list 2>&1 | grep -q 'doop: .*Connected'"
check "a lead may not run the headers helper, nor name the project's secrets in a command" sh -c "jq -e --arg r '$ROOT' '.permissions.deny | index(\"Bash(*doop-mcp-headers*)\") and index(\"Bash(*\(\$r)/secrets*)\") and index(\"Read(/\(\$r)/secrets/**)\")' '$ROOT/leads/design/.claude/settings.json'"

echo "== backup, off, on again"
check "the backup has the project's Doop, its 0600 database files too (doop.tar.gz, by Doop's own tar while it runs)" sh -c "mm cron --run '$PROJECT/backup' && ls -1d \"\$(jq -r .dirs.backups '$ROOT/.run/endpoints.json')/$PROJECT\"/20*/ | tail -1 | xargs -I{} tar -tzf {}doop.tar.gz | grep -qx doop/pg/global/pg_control"
# Doop has up to 30 s to stop now (services.yaml stop_seconds; its database closes cleanly), so wait for it, up to 40 s
check "mm doop off: the container and its network go, the design lead's MCP goes, the data stays" sh -c "mm doop off '$REF' >/dev/null && for i in \$(seq 1 40); do ! D inspect '$C' >/dev/null 2>&1 && ! D network inspect '$NET' >/dev/null 2>&1 && break; sleep 1; done; ! D inspect '$C' >/dev/null 2>&1 && ! D network inspect '$NET' >/dev/null 2>&1 && ! test -e '$ROOT/leads/design/.mcp.json' && ! test -e '$ROOT/leads/design/.claude/settings.local.json' && test -d '$ROOT/data/doop/pg'"
check "mm doop on again: the same account (the key still works)" sh -c "mm doop on '$REF' >/dev/null && for i in \$(seq 1 120); do curl -sf -o /dev/null '$URL/healthz' && break; sleep 1; done; node '$T/mcp-tools.mjs' '$URL/mcp' '$ROOT/secrets/doop-agent-key'"

echo "== archive"
check "mm archive: its Doop container and its network are gone too (the pack read Doop's files)" bash -c "mm archive '$REF' >/dev/null && sleep 5 && ! D inspect '$C' >/dev/null 2>&1 && ! D network inspect '$NET' >/dev/null 2>&1"
check "no route written into the live web proxy (review sy-uzh)" live_routes_same
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
