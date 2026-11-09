#!/usr/bin/env bash
# A project's Doop container on its own (review sy-d2t #8): bin/doop-run straight from this checkout, in a throwaway
# project folder, without mm or the process manager. Its own uid (not the host owner's, not root); no way out (no
# address, no name, none of the host's ports); the board reaches it on loopback; data an older Doop wrote as the host
# owner still opens, and the host owner can still back it up and remove it. And a box project's Doop as mm runs it on
# the host (sy-wo7y: DOOP_HOME, the box's socket, the key's copy). Throwaway containers and networks only.
# Through mm's Docker wrapper (test/lib/docker.sh: the installed one; MM_DOCKER_BIN for this checkout's copy). The older
# Doop (as the host owner's own uid, which the wrapper refuses) needs plain docker: MM_DOCKER_RAW, else it is skipped.
#   MM_DOOP_IMAGE=<name@sha256:… or sha256:…> [MM_DOCKER_RAW="sudo -n docker"] test/doop-container.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
. "$HERE/test/lib/docker.sh"
IMAGE=${MM_DOOP_IMAGE:?the Doop image, by digest}; RAW=${MM_DOCKER_RAW:-}
D() { $DOCKER "$@"; }; R() { $RAW "$@"; }
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mm_test_dir doopc); OUT="$T/check.out"   # the tests' area: its name is the throwaway project
check() { local d=$1; shift; if "$@" >"$OUT" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$OUT" | sed 's/^/       /'; fi; }
PROJECT=$(basename "$T"); P="$T/$PROJECT"; C="mm-doop-$PROJECT"; NET="mm-doop-net-$PROJECT"; OLDNET="mm-doopc-old-$$"; OLDC="mm-doopc-old-$$"
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
PORT=$(free_port); URL="http://doop.$PROJECT.localhost:1355"; B="http://127.0.0.1:$PORT"
RUN=""
cleanup() { [ -n "$RUN" ] && kill "$RUN" 2>/dev/null; sleep 1; D kill "$C" >/dev/null 2>&1; D rm -f "$C" >/dev/null 2>&1; D network rm "$NET" >/dev/null 2>&1
  [ -z "$RAW" ] || { R kill "$OLDC" >/dev/null 2>&1; R rm -f "$OLDC" >/dev/null 2>&1; R network rm "$OLDNET" >/dev/null 2>&1; }
  kill "${OLDFWD:-}" "${BOXFWD:-}" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
up() { for _ in $(seq 1 "${2:-150}"); do curl -sf -o /dev/null "$1/healthz" && return 0; sleep 1; done; return 1; }

# the project, as mm stamps it (only what doop-run reads)
mkdir -p "$P/bin/lib" "$P/.run" "$P/secrets" "$P/data/doop"; chmod 700 "$P/secrets"
cp "$HERE/template/bin/doop-run" "$P/bin/"; cp "$HERE/template/bin/lib/doop-init.mjs" "$P/bin/lib/"
echo "project: $PROJECT" >"$P/.mm-answers.yaml"
printf '{"containers":{"docker":"%s","doop_image":"%s"}}\n' "$DOCKER" "$IMAGE" >"$P/.run/endpoints.json"
# a probe from inside the container: connect, or look a name up; prints what happened, exits 0 only if it got through
cat >"$T/probe.js" <<'EOF'
const [kind, a, b] = process.argv.slice(1)
const done = (ok, m) => { console.log(m); process.exit(ok ? 0 : 1) }
if (kind === 'dns') require('dns').lookup(a, (e, ip) => done(!e, e ? e.code : ip))
else { const s = require('net').connect({ host: a, port: +b, timeout: 4000 }); s.on('connect', () => done(true, `${a}:${b} open`)); s.on('timeout', () => done(false, `${a}:${b} timeout`)); s.on('error', (e) => done(false, `${a}:${b} ${e.code}`)) }
EOF
probe() { D exec -i "$C" node - "$@" <"$T/probe.js"; }
nprobe() { ! probe "$@"; }
export -f D; export DOCKER
# sign in with the account doop-init made, and make a key (a write to Doop's database)
cat >"$T/write.mjs" <<'EOF'
import fs from 'node:fs'
const [base, origin, S] = process.argv.slice(2), rd = (n) => fs.readFileSync(`${S}/${n}`, 'utf8').trim()
const post = (p, body, cookie) => fetch(`${base}${p}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
const r = await post('/api/auth/sign-in/email', { email: `designer@${rd('doop-signup-domain')}`, password: rd('doop-password') })
if (!r.ok) { console.log(`sign-in HTTP ${r.status}`); process.exit(1) }
const k = await post('/api/agent-keys', { name: 'qa' }, (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; '))
console.log(`new key HTTP ${k.status}`); process.exit(k.ok ? 0 : 1)
EOF
# the MCP's tools with a key from its file (never printed)
cat >"$T/mcp-tools.mjs" <<'EOF'
import fs from 'node:fs'
const [url, keyFile] = process.argv.slice(2), key = fs.readFileSync(keyFile, 'utf8').trim()
const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const call = async (body, extra = {}) => { const r = await fetch(url, { method: 'POST', headers: { ...h, ...extra }, body: JSON.stringify(body) }); const t = await r.text(), m = /^data: (.*)$/m.exec(t)
  return { status: r.status, session: r.headers.get('mcp-session-id'), json: (() => { try { return JSON.parse(m ? m[1] : t) } catch { return null } })() } }
const i = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mm-qa', version: '1' } } })
if (i.status !== 200) { console.log(`HTTP ${i.status}`); process.exit(1) }
const s = i.session ? { 'mcp-session-id': i.session } : {}
await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, s)
const l = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, s), n = l.json?.result?.tools?.length || 0
console.log(`${n} tools`); process.exit(n ? 0 : 1)
EOF

if [ -n "$RAW" ]; then
echo "== an older Doop: as the host owner (umask 022), its account and agent key (plain docker: $RAW)"
R network create --internal "$OLDNET" >/dev/null
SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"); DOM="old$$.doop.invalid"
printf '%s' "$SECRET" >"$P/secrets/doop-auth-secret"; printf '%s' "$DOM" >"$P/secrets/doop-signup-domain"; chmod 600 "$P/secrets/"*
printf 'NODE_ENV=production\nPORT=4400\nHOME=/tmp\nBETTER_AUTH_URL=%s\nTRUSTED_ORIGINS=%s\nBETTER_AUTH_SECRET=%s\nSIGNUP_EMAIL_DOMAINS=%s\n' "$URL" "$URL" "$SECRET" "$DOM" >"$T/old.env"
R run -d --rm --name "$OLDC" --network "$OLDNET" --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp --cap-drop ALL -v "$P/data/doop:/app/data" --env-file "$T/old.env" "$IMAGE" >/dev/null
OIP=$(R inspect -f "{{(index .NetworkSettings.Networks \"$OLDNET\").IPAddress}}" "$OLDC"); OP=$(free_port)
socat "TCP-LISTEN:$OP,bind=127.0.0.1,fork,reuseaddr" "TCP:$OIP:4400" 2>/dev/null & OLDFWD=$!
check "the older Doop answers" up "http://127.0.0.1:$OP"
check "...its first start: the account and the agent key" node "$P/bin/lib/doop-init.mjs" "http://127.0.0.1:$OP" "$URL" "$P/secrets"
cp "$P/secrets/doop-agent-key" "$T/old-key"
R stop -t 10 "$OLDC" >/dev/null; kill "$OLDFWD" 2>/dev/null; R network rm "$OLDNET" >/dev/null
check "its data is the host owner's" bash -c "[ \"\$(stat -c %u '$P/data/doop/pg')\" = '$(id -u)' ]"
else echo "  skip the older Doop as the host owner's uid (needs MM_DOCKER_RAW: the wrapper runs no container as a real account)"; fi

echo "== the new Doop (bin/doop-run)"
PORT=$PORT DOOP_URL=$URL "$P/bin/doop-run" >"$T/run.log" 2>&1 & RUN=$!
check "the board reaches it on loopback ($B)" up "$B"
if [ -z "$RAW" ]; then  # no older Doop: its own first start made the account and the key, which stand for the older ones
  check "...its first start: the account and the agent key" bash -c "for i in \$(seq 1 60); do [ -s '$P/secrets/doop-agent-key' ] && exit 0; sleep 1; done; exit 1"
  cp "$P/secrets/doop-agent-key" "$T/old-key"
fi
DU=$(D inspect -f '{{.Config.User}}' "$C" 2>/dev/null)
check "its own uid ($DU): 210000 + n, not the host owner's, not root" bash -c "u=\${1%%:*}; [ \"\$u\" -ge 210010 ] && [ \"\$u\" -le 210249 ] && [ \"\$u\" != '$(id -u)' ] && [ \"\$(D exec '$C' id -u)\" = \"\$u\" ] && [ \"\${1#*:}\" = '$(id -g)' ]" _ "$DU"
check "...and its uid matches its network (10.232.<n>.0/24 -> 210000 + n)" bash -c "s=\$(D network inspect -f '{{(index .IPAM.Config 0).Subnet}}' '$NET'); n=\${s#10.232.}; [ \"210000\" -lt \"\${1%%:*}\" ] && [ \$((210000 + \${n%%.*})) = \"\${1%%:*}\" ]" _ "$DU"
check "its only network is internal: $NET" bash -c "[ \"\$(D inspect -f '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' '$C')\" = '$NET ' ] && [ \"\$(D network inspect -f '{{.Internal}}' '$NET')\" = true ]"
check "nothing published: no port of the container on any host address" bash -c "[ -z \"\$(D port '$C')\" ] && [ \"\$(D inspect -f '{{json .HostConfig.PortBindings}}' '$C')\" = '{}' ]"
check "loopback only: $PORT listens on 127.0.0.1 and nowhere else" bash -c "/usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$PORT' && ! /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -v '^127.0.0.1:' | grep -qE ':$PORT\$'"
check "kept: a read-only root, no capabilities, no new privileges, secrets by env file" bash -c "[ \"\$(D inspect -f '{{.HostConfig.ReadonlyRootfs}}' '$C')\" = true ] && D inspect -f '{{.HostConfig.CapDrop}}' '$C' | grep -q ALL && [ \"\$(D inspect -f '{{.HostConfig.CapAdd}}' '$C')\" = '[]' ] && D inspect -f '{{.HostConfig.SecurityOpt}}' '$C' | grep -q no-new-privileges && ! D inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}}' '$C' | grep -qE 'SECRET|DOMAINS='"
check "kept: the image by digest" bash -c "[ \"\$(D inspect -f '{{.Config.Image}}' '$C')\" = '$IMAGE' ]"

echo "== no way out"
check "no outside address (1.1.1.1:443)" nprobe tcp 1.1.1.1 443
check "no outside address (8.8.8.8:53)" nprobe tcp 8.8.8.8 53
check "no outside name (example.com)" nprobe dns example.com
GW=$(D network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$NET"); BR=$(D network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
HOSTIP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'); HOSTIP=${HOSTIP:-$(hostname -I 2>/dev/null | awk '{print $1}')}
# the host's ports that listen on every address (e.g. ssh), at each address of the host the container could try
PORTS=$(/usr/sbin/ss -Hltn | awk '{print $4}' | sed -nE 's/^(0\.0\.0\.0|\*|\[::\]):([0-9]+)$/\2/p' | sort -un | head -6 | tr '\n' ' ')
for h in $GW $BR $HOSTIP; do for p in ${PORTS:-22}; do check "not the host's ports: $h:$p" nprobe tcp $h $p; done; done
check "...nor its loopback forwarder from inside ($GW:$PORT)" nprobe tcp $GW $PORT

echo "== the older data opens, and stays the host's to back up and remove"
check "the older agent key still lists the MCP's tools (the same account, the same database)" node "$T/mcp-tools.mjs" "$B/mcp" "$T/old-key"
check "the older account signs in and makes a new key (a write)" node "$T/write.mjs" "$B" "$URL" "$P/secrets"
check "doop-init did not run again (the agent key is the older one)" cmp -s "$T/old-key" "$P/secrets/doop-agent-key"
check "the key file stays 0600, the secrets folder 0700" bash -c "[ \"\$(stat -c %a '$P/secrets/doop-agent-key')\" = 600 ] && [ \"\$(stat -c %a '$P/secrets')\" = 700 ]"
U=${DU%%:*}
check "Doop writes files of its own uid ($U), in the host owner's group" bash -c "[ -n \"\$(find '$P/data/doop' -user $U -print -quit)\" ] && [ -z \"\$(find '$P/data/doop' ! -group $(id -g) -print -quit)\" ]"
check "the backup while it runs (doop-run backup, as bin/backup): all of it, its 0600 database files too" bash -c "'$P/bin/doop-run' backup '$T/doop.tar.gz' && tar -tzf '$T/doop.tar.gz' >'$T/list' && grep -qx 'doop/pg/global/pg_control' '$T/list' && [ \"\$(grep -c '^doop/pg/base/' '$T/list')\" -gt 100 ] && ! grep -qv '^doop/' '$T/list'"

echo "== stop"
t0=$(date +%s%N); kill -TERM "$RUN"; for _ in $(seq 1 200); do [ -d "/proc/$RUN" ] || break; sleep 0.2; done; dt=$(( ($(date +%s%N) - t0) / 100000000 ))
check "TERM: doop-run ends (in $((dt / 10)).$((dt % 10))s; the process manager waits 30s)" bash -c "! [ -d /proc/$RUN ] && [ $dt -lt 300 ]"; RUN=""
check "...its container and its network go, the loopback port is free" bash -c "! D inspect '$C' >/dev/null 2>&1 && ! D network inspect '$NET' >/dev/null 2>&1 && ! /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$PORT'"
check "...and Doop left its files group-readable and -writable, folders setgid" bash -c "[ -z \"\$(find '$P/data/doop' ! -type l ! -perm -060 -print -quit)\" ] && [ -z \"\$(find '$P/data/doop' -type d ! -perm -2070 -print -quit)\" ]"
check "the backup while it is stopped: the host owner's own tar" bash -c "'$P/bin/doop-run' backup '$T/doop2.tar.gz' && tar -tzf '$T/doop2.tar.gz' | grep -qx 'doop/pg/global/pg_control'"
check "a second start: the same uid, the older key still works" bash -c "PORT=$PORT DOOP_URL=$URL '$P/bin/doop-run' >'$T/run2.log' 2>&1 & echo \$! >'$T/run2.pid'; for i in \$(seq 1 150); do curl -sf -o /dev/null '$B/healthz' && break; sleep 1; done; [ \"\$(D inspect -f '{{.Config.User}}' '$C')\" = '$DU' ] && node '$T/mcp-tools.mjs' '$B/mcp' '$T/old-key'"
RUN=$(cat "$T/run2.pid" 2>/dev/null)

echo "== killed (no clean stop), then mm archive's release"
node "$T/write.mjs" "$B" "$URL" "$P/secrets" >/dev/null 2>&1   # something new, 0600, made by this run
kill -KILL "$RUN"; sleep 1; D kill "$C" >/dev/null 2>&1; sleep 2; RUN=""
check "killed: its forwarder went with it (the port is free)" bash -c "! /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$PORT'"
check "...and it left files only its uid can read" bash -c "[ -n \"\$(find '$P/data/doop' -user ${DU%%:*} ! -perm -040 -print -quit)\" ]"
check "doop-run release: they are back in the host owner's group, its network is gone" bash -c "'$P/bin/doop-run' release && [ -z \"\$(find '$P/data/doop' ! -type l ! -perm -060 -print -quit)\" ] && ! D network inspect '$NET' >/dev/null 2>&1"
check "the host owner can pack and remove all of it (as mm archive does)" bash -c "tar -czf '$T/all.tar.gz' -C '$P' data && rm -rf '$P/data/doop'"

echo "== a box project's Doop, on the host (sy-wo7y): DOOP_HOME, the box's socket, the key's copy for the box"
DH="$T/boxdoop"; SD="$T/boxsock"; KT="$T/boxsecrets"; mkdir -p "$DH" "$SD" "$KT"; chmod 750 "$SD"
printf '{"containers":{"docker":"%s","doop_image":"%s"}}\n' "$DOCKER" "$IMAGE" >"$DH/endpoints.json"
printf '{"containers":{"docker":"/bin/false","doop_image":"sha256:%064d"}}\n' 0 >"$P/.run/endpoints.json" # what a box could write: never read
HP=$(free_port); B3="http://127.0.0.1:$HP"; BP=$(free_port); B4="http://127.0.0.1:$BP"
# exec: run in the background, the subshell becomes doop-run itself, so $! is doop-run's and a TERM reaches it
hostrun() { DOOP_HOME="$DH" DOOP_PROJECT="$PROJECT" DOOP_BOX_SOCKET="$SD/doop.sock" DOOP_AGENT_KEY_TO="$KT/doop-agent-key" PORT=$HP DOOP_URL=$URL exec "$P/bin/doop-run" "$@"; }
hostrun >"$T/run3.log" 2>&1 & RUN=$!
check "it answers on the host's loopback, with what DOOP_HOME names (the project's .run/ names /bin/false)" up "$B3"
check "...through the box's socket (0660, the owner's group), to Doop's own listener" bash -c "for i in \$(seq 1 30); do [ -S '$SD/doop.sock' ] && break; sleep 1; done; [ \"\$(stat -c '%a %g' '$SD/doop.sock')\" = '660 $(id -g)' ] && curl -sf --unix-socket '$SD/doop.sock' -o /dev/null 'http://doop.$PROJECT.localhost/healthz'"
# the box's side: its portless name to the socket (src/box.ts), here a loopback port
socat "TCP-LISTEN:$BP,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$SD/doop.sock" 2>/dev/null & BOXFWD=$!
check "...its data and secrets in DOOP_HOME, a new auth secret (never the project's)" bash -c "for i in \$(seq 1 60); do [ -s '$DH/secrets/doop-agent-key' ] && break; sleep 1; done; [ -d '$DH/data/pg' ] && [ -s '$DH/secrets/doop-auth-secret' ] && ! cmp -s '$DH/secrets/doop-auth-secret' '$P/secrets/doop-auth-secret'"
check "...the agent key copied for the box (0640), as Doop's own" bash -c "for i in \$(seq 1 30); do [ -s '$KT/doop-agent-key' ] && break; sleep 1; done; [ \"\$(stat -c %a '$KT/doop-agent-key')\" = 640 ] && cmp -s '$KT/doop-agent-key' '$DH/secrets/doop-agent-key'"
check "the design lead's MCP through the box's way in, with the box's copy of the key" node "$T/mcp-tools.mjs" "$B4/mcp" "$KT/doop-agent-key"
DU3=$(D inspect -f '{{.Config.User}}' "$C" 2>/dev/null)
check "its own uid ($DU3): 210000 + n, never the host owner's; its only network internal" bash -c "u=\${1%%:*}; [ \"\$u\" -ge 210010 ] && [ \"\$u\" -le 210249 ] && [ \"\$(D inspect -f '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' '$C')\" = '$NET ' ] && [ \"\$(D network inspect -f '{{.Internal}}' '$NET')\" = true ]" _ "$DU3"
check "its data mount is DOOP_HOME/data, nothing of the project" bash -c "[ \"\$(D inspect -f '{{range .Mounts}}{{.Source}} {{end}}' '$C')\" = '$DH/data ' ]"
check "the backup while it runs (doop-run backup with DOOP_HOME, as mm's landBackup)" bash -c "DOOP_HOME='$DH' DOOP_PROJECT='$PROJECT' '$P/bin/doop-run' backup '$T/doop3.tar.gz' && tar -tzf '$T/doop3.tar.gz' | grep -qx 'doop/pg/global/pg_control'"
kill -TERM "$RUN"; for _ in $(seq 1 200); do [ -d "/proc/$RUN" ] || break; sleep 0.2; done; RUN=""; kill "$BOXFWD" 2>/dev/null
check "TERM: its container goes" bash -c "! D inspect '$C' >/dev/null 2>&1"
check "...its network goes" bash -c "! D network inspect '$NET' >/dev/null 2>&1"
check "...the box's socket goes" bash -c "! [ -e '$SD/doop.sock' ]"
check "the backup while it is stopped: the host owner's tar of DOOP_HOME/data, as doop/" bash -c "DOOP_HOME='$DH' DOOP_PROJECT='$PROJECT' '$P/bin/doop-run' backup '$T/doop4.tar.gz' && tar -tzf '$T/doop4.tar.gz' | grep -qx 'doop/pg/global/pg_control' && ! tar -tzf '$T/doop4.tar.gz' | grep -qv '^doop'"
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
