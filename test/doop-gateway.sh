#!/usr/bin/env bash
# Doop behind the sign-in gateway (sy-3yz), in containers only: the mm fork (box/doop/0001-gateway-assertion.patch)
# applied to the pinned Doop image's own source and built as a throwaway image (box/doop/build.sh), then run by
# bin/doop-run straight from this checkout in a throwaway project folder (no mm, no process manager), with a test key
# in the gateway's place. Proves: on the public side only the gateway's signed assertion lets anyone in (a forged,
# expired, other-host or unknown-role one is refused); a person's Doop account is made on their first visit with no
# second login and no cookie; owner and designer edit, member and viewer only look; Doop's own login is off there and
# a client's cookie or agent key counts for nothing; the loopback side (the design lead's account, its agent key, the
# MCP) is unchanged; without the gateway's key there is no public side. Every page of the public side has a "Source"
# link to the fork at the tag mm pins (sy-9a30), or to its own page about the source when no repository is configured;
# the loopback side's pages have none. Throwaway image, containers and networks only.
# Through mm's Docker wrapper only (test/lib/docker.sh: the installed one; MM_DOCKER_BIN for this checkout's copy).
#   test/doop-gateway.sh [base image]        (base: mm-doop:0.12.0, the pinned one)
#   MM_DOOP_GW_IMAGE=sha256:<id> test/doop-gateway.sh    an image built already (ops' publish step), instead of a
#                                                        throwaway build
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
. "$HERE/test/lib/docker.sh"
BASE=${1:-mm-doop:0.12.0}
D() { $DOCKER "$@"; }; export -f D; export DOCKER
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mm_test_dir doopgw); OUT="$T/check.out"   # the tests' area: its name is the throwaway project
check() { local d=$1; shift; if "$@" >"$OUT" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$OUT" | sed 's/^/       /'; fi; }
PROJECT=$(basename "$T"); P="$T/$PROJECT"; C="mm-doop-$PROJECT"; NET="mm-doop-net-$PROJECT"; TAG="mm-doop:gwqa-$$"
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
PORT=$(free_port); PUB=$(free_port); URL="http://doop.$PROJECT.localhost:1355"; HOST="doop.$PROJECT.example.test"
B="http://127.0.0.1:$PORT"; PB="http://127.0.0.1:$PUB"
RUN=""
stoprun() { [ -n "$RUN" ] && kill -TERM "$RUN" 2>/dev/null; for _ in $(seq 1 150); do [ -n "$RUN" ] && [ -d "/proc/$RUN" ] || break; sleep 0.2; done; RUN=""; }
cleanup() { stoprun; D rm -f "$C" >/dev/null 2>&1; D network rm "$NET" >/dev/null 2>&1; D rmi -f "$TAG" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT
upl() { for _ in $(seq 1 180); do curl -sf -o /dev/null "$B/healthz" && return 0; sleep 1; done; return 1; }
code() { curl -s -o "$T/body" -w '%{http_code}' "$@"; }

if [ -n "${MM_DOOP_GW_IMAGE:-}" ]; then
echo "== the fork's image: $MM_DOOP_GW_IMAGE (built already)"
IMAGE=$MM_DOOP_GW_IMAGE
check "it is here, by id or digest" bash -c "echo '$IMAGE' | grep -Eq '^([a-z0-9][a-z0-9._/:-]*@)?sha256:[0-9a-f]{64}\$' && D image inspect '$IMAGE' >/dev/null"
else
echo "== the fork's image: the pinned image's source, the patch, built on it"
IMAGE=$(DOCKER=$DOCKER "$HERE/box/doop/build.sh" "$TAG" "$BASE" 2>"$T/build.err")
check "box/doop/build.sh: the patch applies to the pinned image's own source and builds ($IMAGE)" bash -c "echo '$IMAGE' | grep -Eq '^sha256:[0-9a-f]{64}\$' || { cat '$T/build.err'; exit 1; }"
check "...a moved tag is refused (the base must be the image the patch is for)" bash -c "! DOCKER='$DOCKER' '$HERE/box/doop/build.sh' '$TAG-x' '$TAG' 2>&1 | grep -q '^sha256:'"
# the patches' own unit tests (tests/ is not in the image), run in the image against its patched server/
# readable by the container's uid whatever the caller's umask (077 left them 0600: vitest found no test files)
mkdir -p "$T/src"; for p in "$HERE"/box/doop/[0-9][0-9][0-9][0-9]-*.patch; do git -C "$T/src" apply --include='tests/*' "$p"; done; chmod -R a+rX "$T/src"
check "the fork's own unit tests pass in it (vitest, no network: the assertion, the source link)" bash -c "D run --rm --network none --user 210000:$(id -g) --cap-drop ALL --read-only --tmpfs /tmp -e HOME=/tmp -e NO_COLOR=1 -v '$T/src/tests:/app/tests:ro' --entrypoint sh '$IMAGE' -c 'cd /app && node_modules/.bin/vitest run tests/mmGateway.test.ts tests/mmSource.test.ts --cache=false' >'$T/unit.out' 2>&1; grep -E 'Tests +[0-9]+ passed' '$T/unit.out' && ! grep -q failed '$T/unit.out'"
grep -E 'Tests +[0-9]+ passed' "$T/unit.out" >/dev/null && ! grep -q failed "$T/unit.out" || tail -25 "$T/unit.out" | sed 's/^/       unit.out: /'
fi

# the project, as mm stamps it (only what doop-run reads), with a test key in the gateway's place
mkdir -p "$P/bin/lib" "$P/.run" "$P/secrets" "$P/data/doop"; chmod 700 "$P/secrets"
cp "$HERE/template/bin/doop-run" "$P/bin/"; cp "$HERE/template/bin/lib/doop-init.mjs" "$P/bin/lib/"
echo "project: $PROJECT" >"$P/.mm-answers.yaml"
cat >"$T/keys.mjs" <<'EOF'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
const [dir] = process.argv.slice(2)
for (const n of ['gw', 'other']) { const k = generateKeyPairSync('ed25519'); fs.writeFileSync(`${dir}/${n}.key`, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); fs.writeFileSync(`${dir}/${n}.pub`, k.publicKey.export({ type: 'spki', format: 'pem' })) }
EOF
node "$T/keys.mjs" "$T"
# the fork's source (sy-9a30): the tag mm pins (src/project.ts DOOP_TAG), and its URL as mm makes it from a repository
# in its config (doopSource; a throwaway HOME, so no machine config is read)
DTAG=$(sed -n "s/^export const DOOP_TAG = '\([^']*\)'.*/\1/p" "$HERE/src/project.ts")
srcurl() { HOME="$T/home" MM_HOME="$T/home/mm" bun -e "import { doopSource } from '$HERE/src/project.ts'; process.stdout.write(doopSource(process.argv[1]))" "$@"; }
SRC=$(srcurl "https://git.example.test/someone/doop.git")
ep() { node -e "const [f,d,i,s,t,k,u]=process.argv.slice(1);require('fs').writeFileSync(f,JSON.stringify({containers:{docker:d,doop_image:i,doop_tag:t,doop_source:s},...(k?{auth:{public_key:require('fs').readFileSync(k,'utf8')}}:{}),services:{doop:{url:'$URL',public:u}}}))" "$P/.run/endpoints.json" "$DOCKER" "$IMAGE" "$SRCURL" "$DTAG" "$@"; }
SRCURL=$SRC; ep "$T/gw.pub" "https://$HOST"
# an assertion as mm's gateway signs it (src/auth.ts signAssertion): base64url(JSON {u, r, h, exp, n}) "." Ed25519
cat >"$T/sign.mjs" <<'EOF'
import { createPrivateKey, randomBytes, sign } from 'node:crypto'
import fs from 'node:fs'
const [key, u, r, h, ms] = process.argv.slice(2)
const body = Buffer.from(JSON.stringify({ u, r, h, exp: Date.now() + Number(ms || 60000), n: randomBytes(6).toString('hex') })).toString('base64url')
process.stdout.write(`${body}.${sign(null, Buffer.from(body), createPrivateKey(fs.readFileSync(key, 'utf8'))).toString('base64url')}`)
EOF
as() { node "$T/sign.mjs" "$T/gw.key" "$1" "$2" "${3:-$HOST}" "${4:-60000}"; }
A() { printf 'x-mm-assertion: %s' "$(as "$@")"; }
# the design lead's own account on the loopback side (doop-init made it): a sign-in, its cookie
cat >"$T/lead.mjs" <<'EOF'
import fs from 'node:fs'
const [base, origin, S, out] = process.argv.slice(2), rd = (n) => fs.readFileSync(`${S}/${n}`, 'utf8').trim()
const r = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: `designer@${rd('doop-signup-domain')}`, password: rd('doop-password') }) })
if (!r.ok) { console.log(`sign-in HTTP ${r.status}`); process.exit(1) }
fs.writeFileSync(out, (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; '), { mode: 0o600 })
EOF
# the MCP's first call with an agent key (from its file, never printed), and any extra header
cat >"$T/mcp.mjs" <<'EOF'
import fs from 'node:fs'
const [url, keyFile, extra] = process.argv.slice(2), key = fs.readFileSync(keyFile, 'utf8').trim()
const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(extra ? { 'x-mm-assertion': extra } : {}) }
const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mm-qa', version: '1' } } }) })
console.log(r.status); process.exit(0)
EOF
# a WebSocket upgrade to /ws: prints 101, or the refusal's status
cat >"$T/ws.mjs" <<'EOF'
import http from 'node:http'
const [port, assertion] = process.argv.slice(2)
const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(assertion ? { 'x-mm-assertion': assertion } : {}) } })
req.on('upgrade', (res, sock) => { console.log(res.statusCode); sock.destroy(); process.exit(0) })
req.on('response', (res) => { console.log(res.statusCode); process.exit(0) })
req.on('error', (e) => { console.log(e.code); process.exit(0) })
req.setTimeout(10000, () => { console.log('timeout'); process.exit(0) })
req.end()
EOF
export -f D code as A; export DOCKER T HOST PB B

echo "== bin/doop-run with the gateway's key: the public side"
PORT=$PORT DOOP_URL=$URL DOOP_PUBLIC_PORT=$PUB "$P/bin/doop-run" >"$T/run.log" 2>&1 & RUN=$!
check "the loopback side answers ($B)" upl
curl -sf -o /dev/null "$B/healthz" || tail -15 "$T/run.log" | sed 's/^/       run.log: /'
check "the public side listens on loopback only ($PUB)" bash -c "for i in \$(seq 1 30); do /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$PUB' && break; sleep 1; done; /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$PUB' && ! /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -v '^127.0.0.1:' | grep -qE ':$PUB\$'"
check "...the key went in read-only, the env names the host (no key in the env)" bash -c "D inspect -f '{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}' '$C' | grep -q '/run/mm-gateway.pem:false' && grep -qx 'MM_GATEWAY_HOST=$HOST' '$P/secrets/doop.env' && ! grep -q 'BEGIN' '$P/secrets/doop.env'"
check "the design lead's account and agent key (the first start, as before)" bash -c "for i in \$(seq 1 60); do [ -s '$P/secrets/doop-agent-key' ] && break; sleep 1; done; [ -s '$P/secrets/doop-agent-key' ]"
check "...its agent key opens the MCP on the loopback side" bash -c "[ \"\$(node '$T/mcp.mjs' '$B/mcp' '$P/secrets/doop-agent-key')\" = 200 ]"
node "$T/lead.mjs" "$B" "$URL" "$P/secrets" "$T/lead.cookie" >/dev/null
CID=$(curl -s -X POST -H "cookie: $(cat "$T/lead.cookie")" -H "origin: $URL" -H 'content-type: application/json' -d '{"name":"Lead canvas"}' "$B/api/canvases" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).id||'')}catch{}})")
check "the design lead makes a canvas on the loopback side ($CID)" test -n "$CID"

echo "== no valid assertion: nothing"
check "none: 401, and the page says to sign in through the gateway" bash -c "[ \"\$(code $PB/)\" = 401 ] && grep -q 'gateway' '$T/body' && [ \"\$(code $PB/api/me)\" = 401 ] && [ \"\$(code $PB/healthz)\" = 401 ]"
check "another key's signature: 401" bash -c "[ \"\$(code -H \"x-mm-assertion: \$(node '$T/sign.mjs' '$T/other.key' alice designer '$HOST')\" $PB/api/me)\" = 401 ]"
check "a changed body (viewer -> owner) with the old signature: 401" bash -c "a=\$(as alice viewer); f=\$(node -e \"const [b,s]=process.argv[1].split('.');const c=JSON.parse(Buffer.from(b,'base64url'));c.r='owner';process.stdout.write(Buffer.from(JSON.stringify(c)).toString('base64url')+'.'+s)\" \"\$a\"); [ \"\$(code -H \"x-mm-assertion: \$f\" $PB/api/me)\" = 401 ] && [ \"\$(code -H \"x-mm-assertion: \$a\" $PB/api/me)\" = 200 ]"
check "expired: 401" bash -c "[ \"\$(code -H \"\$(A alice designer $HOST -1000)\" $PB/api/me)\" = 401 ]"
check "for another host (a board's): 401" bash -c "[ \"\$(code -H \"\$(A alice designer board.example.test)\" $PB/api/me)\" = 401 ]"
check "an unknown role, a bad name: 401" bash -c "[ \"\$(code -H \"\$(A alice admin)\" $PB/api/me)\" = 401 ] && [ \"\$(code -H \"\$(A Alice designer)\" $PB/api/me)\" = 401 ]"
check "a WebSocket without one: 401" bash -c "[ \"\$(node '$T/ws.mjs' $PUB)\" = 401 ]"

echo "== a valid assertion: the person, no second login"
check "alice (designer), first visit: signed in as alice, a new Doop account" bash -c "[ \"\$(code -D '$T/h1' -H \"\$(A alice designer)\" $PB/api/me)\" = 200 ] && node -e \"const m=JSON.parse(require('fs').readFileSync('$T/body','utf8'));process.exit(m.name==='alice'&&m.email==='alice@gateway.mm.invalid'&&!m.admin?0:1)\" && cp '$T/body' '$T/alice1'"
check "...no Set-Cookie leaves (the session is the server's, per request)" bash -c "! grep -qi '^set-cookie' '$T/h1' && code -D '$T/h2' -H \"\$(A alice designer)\" $PB/api/auth/get-session >/dev/null && ! grep -qi '^set-cookie' '$T/h2'"
check "...Doop's own session check says alice (the page's sign-in gate passes)" bash -c "[ \"\$(code -H \"\$(A alice designer)\" $PB/api/auth/get-session)\" = 200 ] && grep -q '\"name\":\"alice\"' '$T/body'"
check "...the same account on the next visit (made once)" bash -c "code -H \"\$(A alice designer)\" $PB/api/me >/dev/null; node -e \"const f=(p)=>JSON.parse(require('fs').readFileSync(p,'utf8')).id;process.exit(f('$T/body')===f('$T/alice1')?0:1)\""
check "...many requests at once on a first visit (carol): one account" bash -c "for i in 1 2 3 4 5 6; do curl -s -H \"\$(A carol member)\" $PB/api/me >'$T/c'\$i & done; wait; [ \"\$(cat '$T'/c[1-6] | grep -o '\"id\":\"[^\"]*\"' | sort -u | wc -l)\" = 1 ]"
check "the page itself (the app shell) for alice" bash -c "[ \"\$(code -H \"\$(A alice designer)\" $PB/)\" = 200 ] && grep -qi '<html' '$T/body'"
check "a WebSocket with alice's assertion: 101" bash -c "[ \"\$(node '$T/ws.mjs' $PUB \"\$(as alice designer)\")\" = 101 ]"

echo "== the source link (AGPL section 13): on the gateway side's pages, to the fork at the pinned tag"
H='accept: text/html,application/xhtml+xml,*/*;q=0.8'
href() { grep -o '<a id="mm-source" href="[^"]*"' "$1" | sed 's/.*href="//; s/"$//'; }
export -f href; export H SRC DTAG
check "mm makes the URL from the fork's repository (config) and the pinned tag ($DTAG)" bash -c "[ -n '$DTAG' ] && [ '$SRC' = 'https://git.example.test/someone/doop/tree/$DTAG' ]"
check "...a repository with {tag} in it, and nothing for no repository or one that is not https" bash -c "[ \"\$(HOME='$T/home' MM_HOME='$T/home/mm' bun -e \"import { doopSource } from '$HERE/src/project.ts'; console.log([doopSource('https://git.example.test/x/doop/-/tree/{tag}'), doopSource(''), doopSource(undefined), doopSource('http://git.example.test/x'), doopSource('https://git.example.test/x y')].join('|'))\")\" = 'https://git.example.test/x/doop/-/tree/$DTAG||||' ]"
check "doop-run gives Doop the tag and the URL" bash -c "grep -qx 'DOOP_SOURCE_TAG=$DTAG' '$P/secrets/doop.env' && grep -qx 'DOOP_SOURCE_URL=$SRC' '$P/secrets/doop.env'"
check "the page (alice): one Source link, to the fork's source, its URL ends with the pinned tag" bash -c "[ \"\$(code -D '$T/hs' -H \"\$H\" -H \"\$(A alice designer)\" $PB/)\" = 200 ] && [ \"\$(grep -c 'id=\"mm-source\"' '$T/body')\" = 1 ] && [ \"\$(href '$T/body')\" = '$SRC' ] && case \"\$(href '$T/body')\" in */'$DTAG') ;; *) exit 1 ;; esac && grep -q '>Source</a>' '$T/body' && cp '$T/body' '$T/page.gw'"
check "...its length is the page's, no ETag (a page cached without the link is not reused)" bash -c "[ \"\$(tr -d '\r' <'$T/hs' | sed -n 's/^content-length: *//Ip')\" = \"\$(wc -c <'$T/body' | tr -d ' ')\" ] && ! grep -qi '^etag:' '$T/hs'"
check "...on every page: a canvas's address, a browser asking gzip, a revalidation (If-None-Match)" bash -c "for p in /c/$CID '/?x=1'; do [ \"\$(code -H \"\$H\" -H \"\$(A alice designer)\" $PB\$p)\" = 200 ] && [ \"\$(href '$T/body')\" = '$SRC' ] || { echo \$p; exit 1; }; done; [ \"\$(code -H \"\$H\" -H 'accept-encoding: gzip, deflate, br' -H \"\$(A alice designer)\" $PB/)\" = 200 ] && [ \"\$(href '$T/body')\" = '$SRC' ] && [ \"\$(code -H \"\$H\" -H 'if-none-match: *' -H \"\$(A alice designer)\" $PB/)\" = 200 ] && [ \"\$(href '$T/body')\" = '$SRC' ]"
check "...for a viewer too (bob)" bash -c "[ \"\$(code -H \"\$H\" -H \"\$(A bob viewer)\" $PB/)\" = 200 ] && [ \"\$(href '$T/body')\" = '$SRC' ]"
check "...an API answer is unchanged (no link in JSON)" bash -c "[ \"\$(code -H \"\$H\" -H \"\$(A alice designer)\" $PB/api/me)\" = 200 ] && ! grep -q mm-source '$T/body' && node -e \"JSON.parse(require('fs').readFileSync('$T/body','utf8'))\""
check "the loopback side's page is unchanged: no link, the same page as the gateway side's without it" bash -c "[ \"\$(code -H \"\$H\" $B/)\" = 200 ] && ! grep -q mm-source '$T/body' && sed 's|<a id=\"mm-source\"[^>]*>Source</a>||' '$T/page.gw' | cmp -s - '$T/body'"

echo "== the role, as the gateway says"
check "designer alice sees the project's canvas (the design lead's) and edits it" bash -c "[ \"\$(code -H \"\$(A alice designer)\" $PB/api/canvases)\" = 200 ] && grep -q '$CID' '$T/body' && [ \"\$(code -X PATCH -H \"\$(A alice designer)\" -H 'content-type: application/json' -d '{\"name\":\"Renamed by alice\"}' $PB/api/canvases/$CID)\" = 200 ] && code -H \"\$(A alice designer)\" $PB/api/canvases/$CID >/dev/null && grep -q 'Renamed by alice' '$T/body' && grep -q '\"role\":\"edit\"' '$T/body'"
check "...and makes a canvas" bash -c "[ \"\$(code -X POST -H \"\$(A alice designer)\" -H 'content-type: application/json' -d '{\"name\":\"Alice canvas\"}' $PB/api/canvases)\" = 200 ]"
check "the owner (boss) edits too" bash -c "[ \"\$(code -X PATCH -H \"\$(A boss owner)\" -H 'content-type: application/json' -d '{\"name\":\"Renamed by boss\"}' $PB/api/canvases/$CID)\" = 200 ]"
check "viewer bob: signed in, sees the canvas, read-only (role view)" bash -c "[ \"\$(code -H \"\$(A bob viewer)\" $PB/api/canvases/$CID)\" = 200 ] && grep -q '\"role\":\"view\"' '$T/body' && [ \"\$(code -H \"\$(A bob viewer)\" $PB/api/canvases)\" = 200 ] && grep -q '$CID' '$T/body'"
check "...no change: a rename, a new canvas, a comment are refused (403)" bash -c "[ \"\$(code -X PATCH -H \"\$(A bob viewer)\" -H 'content-type: application/json' -d '{\"name\":\"x\"}' $PB/api/canvases/$CID)\" = 403 ] && [ \"\$(code -X POST -H \"\$(A bob viewer)\" -H 'content-type: application/json' -d '{}' $PB/api/canvases)\" = 403 ] && [ \"\$(code -X POST -H \"\$(A bob viewer)\" -H 'content-type: application/json' -d '{}' $PB/api/canvases/$CID/comments)\" = 403 ]"
check "member carol: read-only too (Doop: read, as mm's roles say)" bash -c "[ \"\$(code -X PATCH -H \"\$(A carol member)\" -H 'content-type: application/json' -d '{\"name\":\"x\"}' $PB/api/canvases/$CID)\" = 403 ] && [ \"\$(code -H \"\$(A carol member)\" $PB/api/canvases/$CID)\" = 200 ] && grep -q '\"role\":\"view\"' '$T/body'"
check "a role changes with the next assertion: bob as designer edits" bash -c "[ \"\$(code -X PATCH -H \"\$(A bob designer)\" -H 'content-type: application/json' -d '{\"name\":\"Renamed by bob\"}' $PB/api/canvases/$CID)\" = 200 ] && code -H \"\$(A bob viewer)\" $PB/api/canvases/$CID >/dev/null && grep -q '\"role\":\"view\"' '$T/body'"

echo "== Doop's own login is off on the public side; a client's credentials count for nothing"
check "sign-in and sign-up with a valid assertion: 403" bash -c "for p in sign-in/email sign-up/email; do [ \"\$(code -X POST -H \"\$(A alice designer)\" -H 'content-type: application/json' -d '{\"email\":\"x@y.z\",\"password\":\"xxxxxxxxxx\",\"name\":\"x\"}' $PB/api/auth/\$p)\" = 403 ] || exit 1; done"
check "...also spelled otherwise (upper case, %-encoded, //, ..)" bash -c "for p in /API/AUTH/sign-up/email /api/auth/%73ign-up/email //api/auth/sign-up/email /api/x/../auth/sign-up/email /api/account-exists; do [ \"\$(code --path-as-is -X POST -H \"\$(A alice designer)\" -H 'content-type: application/json' -d '{}' $PB\$p)\" = 403 ] || { echo \$p; exit 1; }; done"
check "...and any other Doop account route (GET list-sessions, the OAuth authorize)" bash -c "[ \"\$(code -H \"\$(A alice designer)\" $PB/api/auth/list-sessions)\" = 403 ] && [ \"\$(code -H \"\$(A alice designer)\" '$PB/api/auth/mcp/authorize?client_id=x')\" = 403 ]"
check "the design lead's cookie, alone: 401; with bob's assertion: bob (the cookie is dropped)" bash -c "[ \"\$(code -H \"cookie: \$(cat '$T/lead.cookie')\" $PB/api/me)\" = 401 ] && [ \"\$(code -H \"cookie: \$(cat '$T/lead.cookie')\" -H \"\$(A bob viewer)\" $PB/api/me)\" = 200 ] && grep -q '\"name\":\"bob\"' '$T/body'"
check "the design lead's agent key with alice's assertion: refused on the public side (the key is dropped)" bash -c "[ \"\$(node '$T/mcp.mjs' '$PB/mcp' '$P/secrets/doop-agent-key' \"\$(as alice designer)\")\" = 401 ]"

echo "== the loopback side is as before"
check "an assertion means nothing there (no gateway on loopback): 401" bash -c "[ \"\$(code -H \"\$(A alice designer)\" $B/api/me)\" = 401 ]"
check "the design lead's cookie works there" bash -c "[ \"\$(code -H \"cookie: \$(cat '$T/lead.cookie')\" $B/api/me)\" = 200 ] && grep -q 'Design lead' '$T/body'"
check "Doop's own sign-up refuses the gateway's domain there (nobody takes a gateway name's account)" bash -c "[ \"\$(code -X POST -H 'origin: $URL' -H 'content-type: application/json' -d '{\"email\":\"dave@gateway.mm.invalid\",\"password\":\"long-enough-password\",\"name\":\"dave\"}' $B/api/auth/sign-up/email)\" != 200 ]"
check "the log names who got an account, never a key or a cookie" bash -c "D logs '$C' 2>&1 | grep -q 'new account for alice' && ! D logs '$C' 2>&1 | grep -qE 'BEGIN|session_token|dpk_'"

echo "== no repository configured: the link goes to the gateway side's own page about the source"
stoprun
SRCURL=""; ep "$T/gw.pub" "https://$HOST"
PORT=$PORT DOOP_URL=$URL DOOP_PUBLIC_PORT=$PUB "$P/bin/doop-run" >"$T/run3.log" 2>&1 & RUN=$!
check "the loopback side answers" upl
check "...doop-run gives Doop the tag, no URL" bash -c "grep -qx 'DOOP_SOURCE_TAG=$DTAG' '$P/secrets/doop.env' && ! grep -q DOOP_SOURCE_URL '$P/secrets/doop.env'"
check "the page's Source link: /.mm-source/<the pinned tag>" bash -c "for i in \$(seq 1 30); do [ \"\$(code -H \"\$H\" -H \"\$(A alice designer)\" $PB/)\" = 200 ] && break; sleep 1; done; [ \"\$(href '$T/body')\" = '/.mm-source/$DTAG' ]"
check "...that page names the tag, upstream's version and mm's patches; no account, no host" bash -c "[ \"\$(code -H \"\$H\" -H \"\$(A bob viewer)\" $PB/.mm-source/$DTAG)\" = 200 ] && grep -q '<code>$DTAG</code>' '$T/body' && grep -q 'box/doop/0001-gateway-assertion.patch' '$T/body' && grep -q 'box/doop/0002-source-link.patch' '$T/body' && ! grep -qiE 'github|$HOST' '$T/body'"
check "...and it needs the gateway's assertion like any other (401 without)" bash -c "[ \"\$(code $PB/.mm-source/$DTAG)\" = 401 ]"

echo "== without the gateway's key: no public side"
stoprun
ep "" "https://$HOST"
PORT=$PORT DOOP_URL=$URL DOOP_PUBLIC_PORT=$PUB "$P/bin/doop-run" >"$T/run2.log" 2>&1 & RUN=$!
check "the loopback side answers" upl
check "...nothing listens on the public port, doop-run says why, Doop has no gateway env" bash -c "sleep 3; ! /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qx '127.0.0.1:$PUB' && grep -q 'no public side' '$T/run2.log' && ! grep -q MM_GATEWAY '$P/secrets/doop.env' && [ ! -e '$P/.run/doop-gateway.pem' ]"
stoprun
check "stopped: its container, its network and both ports are gone" bash -c "! D inspect '$C' >/dev/null 2>&1 && ! D network inspect '$NET' >/dev/null 2>&1 && ! /usr/sbin/ss -Hltn | awk '{print \$4}' | grep -qxE '127.0.0.1:($PORT|$PUB)'"
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
