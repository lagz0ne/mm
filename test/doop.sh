#!/usr/bin/env bash
# A project's own Doop (plans/doop.md, sy-d2t), on this machine: a throwaway project, `mm doop on`, and the design
# lead's MCP the way bin/lead starts it. Needs the pinned Doop image (MM_DOOP_IMAGE or `mm config set doop.image`) and
# docker (MM_DOCKER or box.docker). Nothing outside the throwaway project, its container and its Claude folder changes.
#   MM_DOCKER="sudo -n docker" MM_DOOP_IMAGE=<image> test/doop.sh [client/name]
set -uo pipefail
REF=${1:-qa/doopt}; PROJECT=${REF/\//-}; ROOT="$HOME/projects/$REF"
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
D() { ${MM_DOCKER:-docker} "$@"; }
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/tmp/doop-test.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/doop-test.out | sed 's/^/       /'; fi; }
T=$(mktemp -d); C="mm-doop-$PROJECT"; URL="http://doop.$PROJECT.localhost:1355"
cleanup() { [ -n "${KEEP:-}" ] && return; mm archive "$REF" >/dev/null 2>&1; D rm -f "$C" >/dev/null 2>&1; rm -rf "$T"; }
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
HP=$(D port "$C" 4400/tcp 2>/dev/null | head -1)
check "loopback only: the container's port is on 127.0.0.1 ($HP), nothing on every interface" sh -c "echo '$HP' | grep -q '^127.0.0.1:' && ! ss -Hltn | awk '{print \$4}' | grep -qE '^(0[.]0[.]0[.]0|[*]|[[]::[]]):${HP##*:}$'"
check "the container: the owner's uid, a read-only root, no capabilities, no new privileges" sh -c "[ \"\$(D inspect -f '{{.Config.User}}' '$C')\" = '$(id -u):$(id -g)' ] && [ \"\$(D inspect -f '{{.HostConfig.ReadonlyRootfs}}' '$C')\" = true ] && D inspect -f '{{.HostConfig.CapDrop}}' '$C' | grep -q ALL && D inspect -f '{{.HostConfig.SecurityOpt}}' '$C' | grep -q no-new-privileges"
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
check "the backup has the project's Doop (doop.tar.gz)" sh -c "mm cron --run '$PROJECT/backup' && ls -1d \"\$(jq -r .dirs.backups '$ROOT/.run/endpoints.json')/$PROJECT\"/20*/ | tail -1 | xargs -I{} test -s {}doop.tar.gz"
check "mm doop off: the container goes, the design lead's MCP goes, the data stays" sh -c "mm doop off '$REF' >/dev/null && sleep 5 && ! D inspect '$C' >/dev/null 2>&1 && ! test -e '$ROOT/leads/design/.mcp.json' && ! test -e '$ROOT/leads/design/.claude/settings.local.json' && test -d '$ROOT/data/doop/pg'"
check "mm doop on again: the same account (the key still works)" sh -c "mm doop on '$REF' >/dev/null && for i in \$(seq 1 120); do curl -sf -o /dev/null '$URL/healthz' && break; sleep 1; done; node '$T/mcp-tools.mjs' '$URL/mcp' '$ROOT/secrets/doop-agent-key'"

echo "== archive"
check "mm archive: its Doop container is gone too" sh -c "mm archive '$REF' >/dev/null && sleep 5 && ! D inspect '$C' >/dev/null 2>&1"
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
