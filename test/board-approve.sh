#!/usr/bin/env bash
# The owner's Approve on the board, and the gateway's Waiting list as the owner's place to act (sy-92sg). Hermetic: a
# throwaway HOME and MM_HOME, the gateway (`mm auth serve`), the template's board server against a fake bd serve that
# keeps its items' labels and comments, curl as the browser. Proves:
#   - POST /api/approve (the public side, the owner, same-origin JSON, a signed-off t2 without approved): verifier actor:
#     approved as the owner's signed name and a comment; verifier ledger: the item goes to the bridge, nothing written;
#   - refused, nothing written: the local side, a member, a viewer, no sign-off, not t2, already approved (also after
#     the bridge's label: whichever comes first counts), a closed item, no same-origin proof, a form's content type;
#   - POST /api/not-now: a comment and needs-you removed;
#   - the Waiting list (the gateway's home): the owner card's fields as escaped text, one action per row from its You
#     line (Approve + Not now, Reply, Done, or the link only), each done server to server through the gateway, refused
#     for a member and from another origin; a bad card field drops the item; a member's list as before;
#   - sy-hzmu: a card that names its Head gets the T2 go (Approve, Not now, the label rail) only when review's
#     signed-head:<repo>@<sha> names that head; the reason otherwise, nothing written; signed-head:* is the leads';
#     the Waiting list shows Head and the reason instead of Approve;
#   - the logs: each action on the board and the gateway's relay, never an assertion or a cookie.
# The ledger cases run only where /etc/mm-approve.conf is absent (the board then reads the test's config); the actor
# cases only where the verifier in force is actor.
#   test/board-approve.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); PIDS=()
trap 'for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE   # this test plays the owner on a throwaway store
mkdir -p "$MM_HOME/pc/projects" "$T/proj/.run" "$T/bin"
busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for _ in $(seq 1 20); do PORT=$(( 41000 + RANDOM % 800 )); busy $PORT || busy $((PORT+1)) || busy $((PORT+2)) || busy $((PORT+3)) || break; done
BOARD=board-shop-acme.example.org; AUTH=auth.example.org
BP=$(( PORT + 1 )); BL=$(( PORT + 2 )); BDP=$(( PORT + 3 ))
printf 'domain: example.org\naccess: domain\nauth_port: %s\nbind_host: 127.0.0.1\nowner_name: boss\n' "$PORT" >"$MM_HOME/config.yaml"
echo "# from $T/proj/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: x\nroot: %s\ntemplate_version: test\ncreated: test\n' "$T/proj" >"$T/proj/.mm-answers.yaml"
printf 'services:\n  board:\n    command: "true"\n    port: http\n    public: { name: board-shop-acme, auth: required }\n' >"$T/proj/services.yaml"
mkdir -p "$T/proj/leads" "$MM_HOME/box/acme-shop"; echo '{"roles":[{"id":"ops"},{"id":"review"}]}' >"$T/proj/leads/roles.json"
printf '{"services":{"board":{"public_port":%s}}}' "$BP" >"$MM_HOME/box/acme-shop/ports.json"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"

# the approval mode the board will read: the test's config only where /etc's is absent (ledger.mjs)
ETC=/etc/mm-approve.conf; ACONF="$T/aconf"
if [ -e "$ETC" ]; then MODE=$(sed -n 's/^[[:space:]]*verifier[[:space:]]*=[[:space:]]*\([a-z]*\).*/\1/p' "$ETC" | tail -1); MODE=${MODE:-actor}; OWNCONF=0
else MODE=actor; OWNCONF=1; fi
aconf() { printf 'verifier = %s\nuser = %s\ndir = %s/al\npublic_key = %s/al.pub\n%s' "$1" "$(id -un)" "$T" "$T" "${2:+bridge_socket = $2
}" >"$ACONF"; }
mkdir -p "$T/br"; SOCK="$T/br/bridge.sock"
[ "$OWNCONF" = 1 ] && aconf actor "$SOCK"

# ---------- the gateway ----------
MM_AUTH_HOST_CACHE_MS=200 mm auth serve >"$T/gw.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 300); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/s" && break; sleep 0.2; done
G="http://127.0.0.1:$PORT"
gw() { curl -s -H "x-forwarded-host: $AUTH" -H 'x-forwarded-proto: https' "$@"; }
sess() { sed -n 's/^set-cookie: \(__Secure-better-auth\.session_token=[^;]*\).*/\1/ip' "$1" | tail -1; }
qs() { printf '%s' "${1#*\?}" | tr '&' '\n' | sed -n "s/^$2=//p"; }
signin() { local L; L=$(mm user link "$1" -o json | jq -r .link)
  gw -D "$T/h-$1" -o /dev/null -H 'origin: null' -H 'sec-fetch-site: same-origin' -d "t=$(qs "$L" token)&c=$(qs "$L" callbackURL)" "$G/s/l"; sess "$T/h-$1"; }
mm user add boss --owner >/dev/null; mm user add alex >/dev/null; mm grant alex acme-shop >/dev/null
SB=$(signin boss); SA=$(signin alex)

# ---------- a fake bd serve that keeps labels and comments ----------
cat >"$T/fakebd.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, logf] = process.argv.slice(2)
const card = (you, more = '') => `## Owner\n- **What:** Rotate the key for <script>alert(1)</script> the shop.\n- **Why:** The old one leaked in a log.\n- **You:** ${you}\n- **If yes:** Ops rotates it tonight.\n- **If no:** The old key stays.\n- **Risk:** medium, a minute without sign-in${more}\n\nThe thread.`
const at = '2026-11-07T10:00:00Z'
const I = (id, labels, f = {}) => ({ id, title: `title ${id}`, status: 'open', priority: 2, assignee: 'ops', labels, updated_at: at, ...f })
const items = [
  I('ap-1', ['t2', 'signed-off', 'needs-you'], { description: card('Tap Approve on the board, or in Telegram') }),
  I('ap-2', ['t2', 'needs-you'], { description: card('Tap Approve') }),
  I('ap-3', ['needs-you'], { description: card('Nothing') }),
  I('ap-4', ['t2', 'signed-off']),
  I('ap-5', ['t2', 'signed-off', 'needs-you']),
  I('ap-6', ['t2', 'signed-off']),
  I('ap-7', ['t2', 'signed-off'], { status: 'closed' }),
  I('ap-10', ['t2', 'signed-off', 'needs-you'], { description: card('Tap Approve here or in Telegram') }),
  I('ap-11', ['needs-you'], { assignee: 'alex', description: card('Reply: which name do we use?') }),
  I('ap-12', ['needs-you'], { description: card('Check: the page, on the board') }),
  I('ap-13', ['needs-you'], { description: card('Nothing, this is for your information') }),
  I('ap-14', ['needs-you']),
  I('ap-15', ['t2', 'signed-off'], { description: card('Tap Approve') }),
  I('ap-16', ['t2', 'signed-off', 'needs-you'], { description: card('Tap Approve') }),
  // sy-hzmu: the card names its head; review signed off mm@0a1b2c3
  I('ap-20', ['t2', 'signed-off', 'needs-you', 'signed-head:mm@0a1b2c3'], { description: card('Tap Approve', '\n- **Head:** mm@9f8e7d6') }),
  I('ap-21', ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], { description: card('Tap Approve', '\n- **Head:** mm@0a1b2c3') }),
  I('ap-22', ['t2', 'signed-off', 'needs-you'], { description: card('Tap Approve', '\n- **Head:** mm@0a1b2c3') }),
  I('ap-23', ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], { description: card('Tap Approve', '\n- **Head:** mm@9f8e7d6') }),
  I('ap-24', ['t2', 'signed-off', 'needs-you', 'signed-head:mm@0a1b2c3'], { description: card('Tap Approve', '\n- **Head:** mm@0a1b2c3') }),
  I('ap-25', ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], { description: card('Tap Approve', '\n- **Head:** mm@0a1b2c3') }),
]
const byId = new Map(items.map((i) => [i.id, i]))
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  const body = b ? JSON.parse(b) : null, u = new URL(req.url, 'http://x')
  fs.appendFileSync(logf, JSON.stringify({ m: req.method, p: u.pathname, b: body }) + '\n')
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (req.method === 'GET' && u.pathname === '/v0/beads/issues') return json({ items, has_more: false })
  if (req.method === 'GET' && u.pathname === '/v0/beads/ready') return json({ items: [], has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)(\/comments)?$/.exec(u.pathname), it = m && byId.get(m[1])
  if (!it) return json({ error: 'not found' }, 404)
  if (req.method === 'GET' && !m[2]) return json(it)
  if (req.method === 'PATCH' && !m[2]) {
    const p = body.patch || {}
    it.labels = [...new Set([...it.labels, ...(p.add_labels || [])])].filter((l) => !(p.remove_labels || []).includes(l))
    return json({ issue: it })
  }
  if (req.method === 'POST' && m[2]) return json({ id: 1, text: body.text, author: body.author })
  json({ ok: true })
}) }).listen(Number(port), '127.0.0.1')
EOF
node "$T/fakebd.mjs" $BDP "$T/bd.jsonl" & PIDS+=($!)

# ---------- a stub bridge (the ledger cases) ----------
cat >"$T/fakebridge.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [sock, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  fs.appendFileSync(out, JSON.stringify({ m: req.method, p: req.url, b }) + '\n')
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
}) }).listen(sock)
EOF
[ "$OWNCONF" = 1 ] && { node "$T/fakebridge.mjs" "$SOCK" "$T/br.jsonl" & PIDS+=($!); }

# ---------- the board (a copy of the template's: it writes .run/ where it runs) ----------
PUB=$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createPublicKey(c.createPrivateKey(f.readFileSync(process.argv[1],'utf8'))).export({type:'spki',format:'pem'}))" "$MM_HOME/auth/signing.key")
mkdir -p "$T/board" && (cd "$SRC/template" && tar -cf - --exclude=node_modules --exclude=dist site bin leads) | tar -xf - -C "$T/board"
mkdir -p "$T/board/.run" && printf '{"owner_name": "boss"}\n' >"$T/board/.run/endpoints.json"
(cd "$T/board" && PORT=$BL BOARD_PUBLIC_PORT=$BP BD_SERVE=http://127.0.0.1:$BDP MM_AUTH_PUBLIC_KEY="$PUB" MM_APPROVE_CONF="$ACONF" PASEO_NO_SDK=1 PASEO_BIN=false MM_PROJECT=acme-shop \
  exec node site/server.mjs >"$T/board.log" 2>&1) & PIDS+=($!)
for _ in $(seq 1 300); do curl -s -o /dev/null "http://127.0.0.1:$BL/api/whoami" && curl -s -o /dev/null "http://127.0.0.1:$BP/" && break; sleep 0.2; done
BLOG="$T/board/.run/logs/ops.log"
up() { curl -s -o /dev/null "$G/s" && curl -s -o /dev/null "http://127.0.0.1:$BP/" && curl -s -o /dev/null "http://127.0.0.1:$BDP/v0/beads/ready"; }
if ! up || [ -z "$SB" ] || [ -z "$SA" ]; then echo "setup failed: the gateway, the board or bd is not up, or a sign-in failed (ports $PORT..$((PORT+3)))"; echo "gw: $(curl -s -o /dev/null -w "%{http_code}" "$G/s") board: $(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$BP/") bd: $(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$BDP/v0/beads/ready") SB=${SB:+set} SA=${SA:+set}"; tail -n 5 "$T/gw.log" "$T/board.log"; exit 2; fi

# an assertion as the gateway's /verify makes it (the gateway's key, this board's host)
mk() { node -e "const c=require('crypto'),f=require('fs');const [k,u,r,h,ms]=process.argv.slice(1);const b=Buffer.from(JSON.stringify({u,r,h,exp:Date.now()+Number(ms),n:'t'})).toString('base64url');process.stdout.write(b+'.'+c.sign(null,Buffer.from(b),c.createPrivateKey(f.readFileSync(k,'utf8'))).toString('base64url'))" "$MM_HOME/auth/signing.key" "$@"; }
OA=$(mk boss owner "$BOARD" 600000); MA=$(mk alex member "$BOARD" 600000); VA=$(mk vic viewer "$BOARD" 600000)
# POST /api/<action> on the board's public side as the board's own page sends it; extra curl args after the body
act() { local a=$1 who=$2 body=$3; shift 3
  curl -s -o "$T/ab" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $who" \
    -H "origin: https://$BOARD" -H 'sec-fetch-site: same-origin' "$@" -d "$body" "http://127.0.0.1:$BP/api/$a"; }
# the same, with only the headers given (no Origin, no Sec-Fetch-Site of ours)
rawact() { local a=$1 who=$2 body=$3; shift 3
  curl -s -o "$T/ab" -w '%{http_code}' -X POST -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $who" "$@" -d "$body" "http://127.0.0.1:$BP/api/$a"; }
labels() { curl -s "http://127.0.0.1:$BDP/v0/beads/issues/$1" | jq -c '.labels'; }
has() { labels "$1" | jq -e --arg l "$2" 'index($l) != null' >/dev/null; }
writes() { jq -s -c "[.[] | select(.m != \"GET\" and (.p | test(\"/$1(/|\$)\")))] | length" "$T/bd.jsonl"; }
lastw() { jq -s -c "[.[] | select(.m == \"$2\" and (.p | test(\"/$1(/|\$)\")))] | last" "$T/bd.jsonl"; }
title() { jq -r '.title' "$T/ab"; }
is() { [ "$1" = "$2" ]; }
says() { title | grep -qF "$1"; }

if [ "$MODE" = actor ]; then
echo "== the owner's Approve on the board (verifier actor): approved as the owner, said on the item"
check "a signed-off t2 without approved: 200, \"Approved on the board by boss.\"" eval '[ "$(act approve "$OA" "{\"item\":\"ap-1\"}")" = 200 ] && says "Approved on the board by boss."'
check "...approved written as the owner's signed name (the journal's actor, what the Supervisor counts)" eval 'jq -s -e "[.[] | select(.m == \"PATCH\" and (.p | test(\"/ap-1\$\")) and .b.patch == {add_labels: [\"approved\"]})] | length == 1 and (.[0].b.actor == \"boss\")" "$T/bd.jsonl" && has ap-1 approved'
check "...and needs-you removed, as the owner: the item no longer waits on them" eval 'lastw ap-1 PATCH | jq -e ".b.actor == \"boss\" and .b.patch == {remove_labels: [\"needs-you\"]}" && ! has ap-1 needs-you'
check "...and a comment by boss: \"[owner] Approved on the board by boss.\" (no address in it)" eval 'lastw ap-1/comments POST | jq -e ".b.author == \"boss\" and .b.text == \"[owner] Approved on the board by boss.\""'
check "...the board's log says who, what, which item (and from where)" eval 'grep "\"op\":\"owner-action\"" "$BLOG" | grep "\"action\":\"approve\"" | grep "\"item\":\"ap-1\"" | grep -q "\"actor\":\"boss\""'
n=$(writes ap-1)
check "twice: 409 \"already approved\", no second comment, nothing written" eval '[ "$(act approve "$OA" "{\"item\":\"ap-1\"}")" = 409 ] && says "already approved" && [ "$(writes ap-1)" = "$n" ]'
# whichever comes first counts: the bridge's tap adds approved as bridge (ops' bridge); then the board's says so
curl -s -o /dev/null -X PATCH -H 'content-type: application/json' -d '{"patch":{"add_labels":["approved"]},"actor":"bridge"}' "http://127.0.0.1:$BDP/v0/beads/issues/ap-6"
n=$(writes ap-6)
check "the Telegram tap first (approved by bridge), the board's Approve second: 409 already approved, nothing written" eval '[ "$(act approve "$OA" "{\"item\":\"ap-6\"}")" = 409 ] && says "already approved" && [ "$(writes ap-6)" = "$n" ]'
fi

echo "== refused, with the reason, nothing written"
n=$(writes ap-4)
check "the local side (no assertion, even with the owner's name as cookie): 403" eval '[ "$(curl -s -o "$T/ab" -w "%{http_code}" -X POST -H "content-type: application/json" -H "cookie: board_user=boss" -H "origin: http://127.0.0.1:$BL" -d "{\"item\":\"ap-4\"}" http://127.0.0.1:$BL/api/approve)" = 403 ]'
check "a member: 403 (only the owner)" eval '[ "$(act approve "$MA" "{\"item\":\"ap-4\"}")" = 403 ] && says "only the owner"'
check "a viewer: 403" eval '[ "$(act approve "$VA" "{\"item\":\"ap-4\"}")" = 403 ]'
check "no assertion on the public side: 401" eval '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "content-type: application/json" -H "x-forwarded-host: $BOARD" -H "origin: https://$BOARD" -d "{\"item\":\"ap-4\"}" http://127.0.0.1:$BP/api/approve)" = 401 ]'
check "CSRF: an Origin of another site (a form from elsewhere): 403" eval '[ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json" -H "origin: https://evil.example")" = 403 ] && says "board'"'"'s own page"'
check "...another site's Origin even with Sec-Fetch-Site same-origin: 403" eval '[ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json" -H "origin: https://evil.example" -H "sec-fetch-site: same-origin")" = 403 ]'
check "...no Origin and no Sec-Fetch-Site (no same-origin proof): 403" eval '[ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json")" = 403 ]'
check "...Sec-Fetch-Site cross-site or same-site, even with this board's Origin: 403" eval '[ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json" -H "origin: https://$BOARD" -H "sec-fetch-site: cross-site")" = 403 ] && [ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json" -H "origin: https://$BOARD" -H "sec-fetch-site: same-site")" = 403 ]'
check "...a form's content type (what another site's form can send), from this board's origin: 415" eval '[ "$(rawact approve "$OA" "item=ap-4" -H "content-type: application/x-www-form-urlencoded" -H "origin: https://$BOARD" -H "sec-fetch-site: same-origin")" = 415 ]'
check "...a text/plain body (a form's other type): 415" eval '[ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: text/plain" -H "origin: https://$BOARD")" = 415 ]'
check "...the board's origin alone (an older browser, no Sec-Fetch-Site) passes the check (then 200 or the item's state)" eval 'c=$(rawact approve "$OA" "{\"item\":\"ap-2\"}" -H "content-type: application/json" -H "origin: https://$BOARD"); [ "$c" = 403 ] && says "review has not signed it off"'
check "...Origin null with Sec-Fetch-Site same-origin (the board's no-referrer pages) passes the check too" eval 'c=$(rawact approve "$OA" "{\"item\":\"ap-2\"}" -H "content-type: application/json" -H "origin: null" -H "sec-fetch-site: same-origin"); [ "$c" = 403 ] && says "review has not signed it off"'
check "none of these wrote anything to ap-4" eval '[ "$(writes ap-4)" = "$n" ] && ! has ap-4 approved'
check "no sign-off (t2 only): 403, says review has not signed it off (the rail's check, sy-l9uc)" eval '[ "$(act approve "$OA" "{\"item\":\"ap-2\"}")" = 403 ] && says "review has not signed it off" && [ "$(writes ap-2)" = 0 ]'
check "not t2: 403, says so" eval '[ "$(act approve "$OA" "{\"item\":\"ap-3\"}")" = 403 ] && says "not a t2 item" && [ "$(writes ap-3)" = 0 ]'
check "a closed item: 409" eval '[ "$(act approve "$OA" "{\"item\":\"ap-7\"}")" = 409 ] && [ "$(writes ap-7)" = 0 ]'
check "not an item id: 400; an item the board doesn't have: 404" eval '[ "$(act approve "$OA" "{\"item\":\"ap-4/../x\"}")" = 400 ] && [ "$(act approve "$OA" "{\"item\":\"ap-99\"}")" = 404 ]'
check "...each refusal is in the board's log" eval 'grep "\"op\":\"owner-action\"" "$BLOG" | grep -q "approve refused: not same-origin"'

echo "== the head review signed off (sy-hzmu): a moved head gets no go, with the reason, nothing written"
MOVED="the head changed since review's sign-off (card: mm@9f8e7d6, signed: mm@0a1b2c3)"
check "Approve, the card's head moved after the sign-off: 403, the reason" eval '[ "$(act approve "$OA" "{\"item\":\"ap-20\"}")" = 403 ] && says "$MOVED" && [ "$(writes ap-20)" = 0 ] && ! has ap-20 approved'
check "Not now, the same: 403, the reason, nothing written" eval '[ "$(act not-now "$OA" "{\"item\":\"ap-20\"}")" = 403 ] && says "$MOVED" && [ "$(writes ap-20)" = 0 ]'
check "Approve, signed off with no signed-head: 403, \"review's sign-off names no head (card: mm@0a1b2c3)\"" eval '[ "$(act approve "$OA" "{\"item\":\"ap-22\"}")" = 403 ] && says "review'"'"'s sign-off names no head (card: mm@0a1b2c3)" && [ "$(writes ap-22)" = 0 ]'
# the label rail: the owner adds approved through the board's API (the public side)
lab() { curl -s -o "$T/ab" -w '%{http_code}' -X PATCH -H 'content-type: application/json' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $1" \
  -H "origin: https://$BOARD" -H 'sec-fetch-site: same-origin' -d "{\"patch\":{\"add_labels\":[\"$3\"]}}" "http://127.0.0.1:$BP/api/v0/beads/issues/$2"; }
if [ "$MODE" = actor ]; then
check "the label rail: the owner adds approved to a moved head: 403, the reason, nothing written" eval '[ "$(lab "$OA" ap-23 approved)" = 403 ] && says "$MOVED" && [ "$(writes ap-23)" = 0 ] && ! has ap-23 approved'
check "...a matching head: the owner's approved label goes through" eval '[ "$(lab "$OA" ap-21 approved)" = 200 ] && has ap-21 approved'
check "Approve, the card's head is the signed head: 200, approved" eval '[ "$(act approve "$OA" "{\"item\":\"ap-24\"}")" = 200 ] && has ap-24 approved'
else
check "the label rail: approved is refused (the ledger's tap), nothing written" eval '[ "$(lab "$OA" ap-23 approved)" = 403 ] && [ "$(writes ap-23)" = 0 ]'
fi
check "signed-head:* is the leads': a member may not add it (403), nothing written" eval '[ "$(lab "$MA" ap-22 signed-head:mm@0a1b2c3)" = 403 ] && says "only the leads change \"signed-head:mm@0a1b2c3\"" && [ "$(writes ap-22)" = 0 ]'
check "...nor the owner" eval '[ "$(lab "$OA" ap-22 signed-head:mm@0a1b2c3)" = 403 ] && says "only the leads change" && [ "$(writes ap-22)" = 0 ]'
check "...nor remove it" eval 'curl -s -o "$T/ab" -X PATCH -H "content-type: application/json" -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $OA" -H "origin: https://$BOARD" -H "sec-fetch-site: same-origin" -d "{\"patch\":{\"remove_labels\":[\"signed-head:mm@0a1b2c3\"]}}" "http://127.0.0.1:$BP/api/v0/beads/issues/ap-20" && says "only the leads change" && has ap-20 signed-head:mm@0a1b2c3'

echo "== Not now (POST /api/not-now): a comment and needs-you removed"
check "the owner: 200; \"[owner] Not now, said boss on the board.\"; needs-you gone, no approved" eval '[ "$(act not-now "$OA" "{\"item\":\"ap-5\"}")" = 200 ] && lastw ap-5/comments POST | jq -e ".b.text == \"[owner] Not now, said boss on the board.\" and .b.author == \"boss\"" && ! has ap-5 needs-you && ! has ap-5 approved && has ap-5 t2'
check "...the same checks: a member 403, another origin 403, no sign-off 403" eval '[ "$(act not-now "$MA" "{\"item\":\"ap-4\"}")" = 403 ] && [ "$(rawact not-now "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json" -H "origin: https://evil.example")" = 403 ] && [ "$(act not-now "$OA" "{\"item\":\"ap-2\"}")" = 403 ]'

if [ "$OWNCONF" = 1 ]; then
echo "== verifier ledger: the board's Approve goes to the bridge; the tap signs (no change in what counts)"
aconf ledger "$SOCK"; n=$(writes ap-4)
check "the owner's Approve: 200 \"Sent to your Telegram\", the bridge got exactly {item}" eval '[ "$(act approve "$OA" "{\"item\":\"ap-4\"}")" = 200 ] && says "Sent to your Telegram" && tail -1 "$T/br.jsonl" | jq -e ".p == \"/approve\" and .b == \"{\\\"item\\\":\\\"ap-4\\\"}\""'
check "...nothing written on the board (no label, no comment)" eval '[ "$(writes ap-4)" = "$n" ] && ! has ap-4 approved'
b=$(wc -l <"$T/br.jsonl")
check "...refused before the bridge: a member, another origin, no sign-off" eval '[ "$(act approve "$MA" "{\"item\":\"ap-4\"}")" = 403 ] && [ "$(rawact approve "$OA" "{\"item\":\"ap-4\"}" -H "content-type: application/json" -H "origin: https://evil.example")" = 403 ] && [ "$(act approve "$OA" "{\"item\":\"ap-2\"}")" = 403 ] && [ "$(wc -l <"$T/br.jsonl")" = "$b" ]'
aconf actor "$SOCK"
else echo "  (skip the ledger cases: $ETC exists, the board reads it, not the test's config)"; fi

echo "== the gateway's Waiting list: the owner card's fields, escaped, and one action per row (sy-92sg)"
home() { gw -H "cookie: $1" "$G/" >"$T/hp"; }
row() { tr '\n' ' ' <"$T/hp" | sed 's#</li>#</li>\n#g' | grep -F "class=\"w-id\">$1<"; }
home "$SB"
check "the owner's list was asked with the cards (?card=1&head=1)" eval 'grep -q "<span class=\"w-id\">ap-10<" "$T/hp" && grep -q "<dt>Head</dt>" "$T/hp"'
check "a card's What with a <script> in it stays text (escaped), its other lines shown" eval 'row ap-10 | grep -qF "<dt>What</dt><dd>Rotate the key for &#60;script&#62;alert(1)&#60;/script&#62; the shop.</dd>" && row ap-10 | grep -qF "<dt>If no</dt><dd>The old key stays.</dd>" && row ap-10 | grep -qF "<dt>Risk</dt><dd>medium, a minute without sign-in</dd>" && ! grep -q "<script>alert" "$T/hp"'
check "\"Tap Approve…\" on a signed-off t2: Approve and Not now, a POST form to /s/act" eval 'row ap-10 | grep -qF "<form method=\"post\" action=\"/s/act\" class=\"w-act\"><input type=\"hidden\" name=\"b\" value=\"acme-shop\"><input type=\"hidden\" name=\"i\" value=\"ap-10\"><button type=\"submit\" name=\"a\" value=\"approve\">Approve</button><button type=\"submit\" name=\"a\" value=\"not-now\" class=\"alt\">Not now</button></form>"'
check "\"Tap Approve\" on a t2 without sign-off (ap-2 is not on the list: needs-you only, ask 'needs you'): no Approve" eval '! row ap-2 | grep -q "value=\"approve\""'
check "\"Reply: …\": a text box (at most 1000) and Send" eval 'row ap-11 | grep -q "<textarea id=\"r-acme-shop-ap-11\" name=\"t\" rows=\"3\" maxlength=\"1000\" required></textarea><button type=\"submit\">Send</button>"'
check "\"Check: …\": a Done button" eval 'row ap-12 | grep -qF "<input type=\"hidden\" name=\"a\" value=\"done\"><button type=\"submit\">Done</button>"'
check "\"Nothing…\", or no card: the link only (no form)" eval '! row ap-13 | grep -q "<form" && ! row ap-14 | grep -q "<form" && row ap-14 | grep -q "card missing" && row ap-13 | grep -q "/s?b=$BOARD&amp;r=%2F%3Fitem%3Dap-13"'
check "a card that names its head: \"Head\" on the row (sy-hzmu)" eval 'row ap-20 | grep -qF "<dt>Head</dt><dd>mm@9f8e7d6</dd>"'
check "...a moved head: the board's reason instead of Approve and Not now" eval 'row ap-20 | grep -qF "<p class=\"w-refused\" role=\"note\">No go yet: the head changed since review&#39;s sign-off (card: mm@9f8e7d6, signed: mm@0a1b2c3).</p>" && ! row ap-20 | grep -q "value=\"approve\""' 
check "...no signed-head: the reason too" eval 'row ap-22 | grep -qF "No go yet: review&#39;s sign-off names no head (card: mm@0a1b2c3)." && ! row ap-22 | grep -q "value=\"approve\""'
check "...the signed head: Head and Approve, no reason" eval 'row ap-25 | grep -qF "<dt>Head</dt><dd>mm@0a1b2c3</dd>" && row ap-25 | grep -q "value=\"approve\"" && ! row ap-25 | grep -q "w-refused"'
check "the page has no inline script or style (CSP default-src 'self')" eval '! grep -qi -e "<script" -e "style=" "$T/hp"'

post() { local who=$1; shift; gw -o "$T/hp" -w '%{http_code}' -H "cookie: $who" "$@" "$G/s/act"; }
same=(-H 'origin: null' -H 'sec-fetch-site: same-origin')
msg() { grep -o '<p class="msg" role="status">[^<]*' "$T/hp" | sed 's/.*>//'; }
if [ "$MODE" = actor ]; then
check "Approve through the gateway: the board's answer on the page; approved as boss" eval '[ "$(post "$SB" "${same[@]}" -d "a=approve&b=acme-shop&i=ap-10")" = 200 ] && msg | grep -qF "acme-shop ap-10: Approved on the board by boss." && has ap-10 approved && lastw ap-10 PATCH | jq -e ".b.actor == \"boss\""'
check "...the board checked it as a browser's: the gateway sent a fresh owner assertion and the board's origin" eval 'grep "\"action\":\"approve\"" "$BLOG" | grep -q "\"item\":\"ap-10\""'
check "...and twice: the board's \"already approved\" on the page (409)" eval '[ "$(post "$SB" "${same[@]}" -d "a=approve&b=acme-shop&i=ap-10")" = 409 ] && msg | grep -q "already approved"'
check "...approved, it no longer waits for the owner: needs-you is gone and so is its row" eval 'home "$SB"; ! has ap-10 needs-you && [ -z "$(row ap-10)" ]'
fi
check "Not now through the gateway: a comment, needs-you removed" eval '[ "$(post "$SB" "${same[@]}" -d "a=not-now&b=acme-shop&i=ap-16")" = 200 ] && lastw ap-16/comments POST | jq -e ".b.text == \"[owner] Not now, said boss on the board.\"" && ! has ap-16 needs-you'
check "Reply through the gateway: a comment as the owner, the text as typed (line breaks kept)" eval '[ "$(post "$SB" "${same[@]}" --data-urlencode "a=reply" --data-urlencode "b=acme-shop" --data-urlencode "i=ap-11" --data-urlencode "t=Use acme.
Thanks.")" = 200 ] && lastw ap-11/comments POST | jq -e ".b.text == \"[owner] Use acme.\nThanks.\" and .b.author == \"boss\"" && has ap-11 needs-you'
check "...a reply over 1000 characters: 400, nothing written" eval 'n=$(writes ap-11); [ "$(post "$SB" "${same[@]}" -d "a=reply&b=acme-shop&i=ap-11&t=$(printf "x%.0s" $(seq 1 1001))")" = 400 ] && [ "$(writes ap-11)" = "$n" ]'
check "Done through the gateway: \"Checked: done, said boss.\", needs-you removed" eval '[ "$(post "$SB" "${same[@]}" -d "a=done&b=acme-shop&i=ap-12")" = 200 ] && lastw ap-12/comments POST | jq -e ".b.text == \"[owner] Checked: done, said boss.\"" && ! has ap-12 needs-you'
n=$(writes ap-15)
check "a member's POST to /s/act (Approve, Reply, Done): 403, nothing reaches the board" eval '[ "$(post "$SA" "${same[@]}" -d "a=approve&b=acme-shop&i=ap-15")" = 403 ] && msg | grep -q "Only the owner" && [ "$(post "$SA" "${same[@]}" -d "a=reply&b=acme-shop&i=ap-11&t=hi")" = 403 ] && [ "$(post "$SA" "${same[@]}" -d "a=done&b=acme-shop&i=ap-13")" = 403 ] && [ "$(writes ap-15)" = "$n" ] && [ "$(writes ap-13)" = 0 ]'
check "the owner's POST from another origin (Approve, Reply, Done): 403, nothing reaches the board" eval '[ "$(post "$SB" -H "origin: https://evil.example" -d "a=approve&b=acme-shop&i=ap-15")" = 403 ] && [ "$(post "$SB" -H "origin: null" -H "sec-fetch-site: cross-site" -d "a=reply&b=acme-shop&i=ap-11&t=hi")" = 403 ] && [ "$(post "$SB" -d "a=done&b=acme-shop&i=ap-13")" = 403 ] && [ "$(writes ap-15)" = "$n" ] && [ "$(writes ap-13)" = 0 ]'
check "no session: 403; a GET: back home" eval '[ "$(gw -o /dev/null -w "%{http_code}" "${same[@]}" -d "a=done&b=acme-shop&i=ap-13" "$G/s/act")" = 403 ] && [ "$(gw -o /dev/null -w "%{http_code}" -H "cookie: $SB" "$G/s/act")" = 302 ]'
check "an odd action, project or id: 400" eval '[ "$(post "$SB" "${same[@]}" -d "a=close&b=acme-shop&i=ap-13")" = 400 ] && [ "$(post "$SB" "${same[@]}" -d "a=done&b=../x&i=ap-13")" = 400 ] && [ "$(post "$SB" "${same[@]}" -d "a=done&b=acme-shop&i=AP-13")" = 400 ]'
check "the gateway's relay is logged (who, board, item, action, the board's status)" eval 'grep "\"msg\":\"owner action relayed\"" "$T/gw.log" | grep "\"user\":\"boss\"" | grep "\"item\":\"ap-12\"" | grep "\"action\":\"done\"" | grep -q "\"status\":200"'
check "...the refusals too" eval 'grep -q "owner action refused (not from the home page)" "$T/gw.log" && grep -q "owner action refused: not the owner" "$T/gw.log"'
sigs=$(printf '%s\n%s\n' "${OA#*.}" "${SB#*=}")
check "no assertion, no signature and no session cookie in either log" eval '! grep -q -e "eyJ1Ijoi" -e "x-mm-assertion" "$T/gw.log" "$BLOG" && ! grep -qF -e "${OA#*.}" -e "${SB#*=}" "$T/gw.log" "$BLOG"'

echo "== a member's list stays as it is"
home "$SA"
check "alex: their own item, \"assigned to you\", no card lines, no form" eval 'row ap-11 | grep -q "assigned to you" && ! grep -q -e "class=\"w-card\"" -e "action=\"/s/act\"" "$T/hp"'

echo "== the gateway reads a board's card strictly (waitingOf; review sy-6h43 rules)"
cat >"$T/wo.ts" <<EOF
import { waitingOf } from '$SRC/src/auth.ts'
const it = (card: unknown, more = {}) => ({ id: 'ap-1', title: 't', age_min: 1, labels: ['t2', 'signed-off'], you: 'Tap Approve', card, ...more })
const one = (card: unknown, owner = true) => waitingOf({ items: [it(card)] }, owner)!.items
const bidi = String.fromCharCode(0x202e), bell = String.fromCharCode(7)
const r = {
  good: one({ what: '<script>x</script>', why: 'w', you: 'Tap Approve', if_yes: 'y', if_no: 'n', risk: 'low' }),
  nocard: one(null), bidi: one({ what: 'a' + bidi + 'b' }), bell: one({ why: 'a' + bell }), long: one({ what: 'w'.repeat(121) }),
  risk: one({ risk: 'r'.repeat(101) }), empty: one({ what: '' }), key: one({ link: 'https://evil.example/' }), num: one({ what: 5 }),
  arr: one([]), str: one('card'), member: one({ what: 'w' }, false), memberNull: one(null, false),
  head: one({ head: 'mm@0a1b2c3' }), headBad: one({ head: 'mm@main' }), headUp: one({ head: 'mm@0A1B2C3' }),
  refused: waitingOf({ items: [it({ head: 'mm@0a1b2c3' }, { refused: 'the head changed' })] }, true)!.items,
  refusedMember: waitingOf({ items: [it(undefined, { refused: 'x' })] }, false)!.items,
  refusedLong: waitingOf({ items: [it(null, { refused: 'r'.repeat(201) })] }, true)!.items,
  refusedBidi: waitingOf({ items: [it(null, { refused: 'a' + bidi })] }, true)!.items,
}
console.log(JSON.stringify(r))
EOF
WO=$(cd "$T" && HOME="$T/home" bun "$T/wo.ts" 2>"$T/wo.err")
check "a good card: kept as given (the page escapes it), the action approve" eval 'echo "$WO" | jq -e ".good | length == 1 and .[0].card.what == \"<script>x</script>\" and .[0].act == \"approve\""'
check "no card (null): kept, the link only" eval 'echo "$WO" | jq -e ".nocard | length == 1 and .[0].card == null and .[0].act == \"approve\""'
check "a bidi or control character, a field over its limit, an empty one, an unknown key, a number, a list, a string: the item is dropped" eval 'echo "$WO" | jq -e "[.bidi, .bell, .long, .risk, .empty, .key, .num, .arr, .str] | all(length == 0)"'
check "a card in a member's list: dropped (only the owner's entries carry one); null passes" eval 'echo "$WO" | jq -e ".member | length == 0" && echo "$WO" | jq -e ".memberNull | length == 1"'

check "a card's head: <repo>@<sha> kept; anything else drops the item (sy-hzmu)" eval 'echo "$WO" | jq -e ".head[0].card.head == \"mm@0a1b2c3\" and (.headBad | length == 0) and (.headUp | length == 0)"'
check "refused: kept for the owner; a member's, one over 200 or with a bidi character: dropped" eval 'echo "$WO" | jq -e ".refused[0].refused == \"the head changed\" and (.refusedMember | length == 0) and (.refusedLong | length == 0) and (.refusedBidi | length == 0)"'

if [ "$fail" -gt 0 ]; then echo "--- gw.log"; tail -20 "$T/gw.log"; echo "--- board log"; tail -20 "$BLOG" 2>/dev/null; tail -5 "$T/board.log"; cat "$T/wo.err" 2>/dev/null; fi
echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
