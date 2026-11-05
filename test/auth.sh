#!/usr/bin/env bash
# mm.auth on Better Auth, hermetic: a throwaway HOME and MM_HOME, a fake board's public name, curl as the browser,
# `mm user|grant|revoke|token` as the owner. Proves: people with no password; a sign-in link that works once and
# expires; one session that opens every board granted (each board its own host-only cookie, no parent-domain cookie);
# the role from the project (designer/member/viewer; the owner everywhere); bearer tokens bound to one project;
# sign-out, revoke and `mm user rm` end everything at once; forward-auth with a signed assertion; the board's public
# side and its rails; the store's modes; logs with no link token and no cookie.
#   test/auth.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); GW=""; TG=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; [ -n "$TG" ] && kill $TG 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
# this test plays the owner on a throwaway store, so it lifts the agent brake (CLAUDECODE); one check sets it again
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
mkdir -p "$MM_HOME/pc/projects" "$T/proj/.run" "$T/proj2/.run"
PORT=$(( 39100 + RANDOM % 800 )); BOARD=board-shop-acme.example.org; AUTH=auth.example.org; BOARD2=board-other-acme.example.org
printf 'domain: example.org\naccess: domain\nauth_port: %s\nbind_host: 127.0.0.1\nowner_name: boss\ntelegram:\n  owner_id: "4242"\n' "$PORT" >"$MM_HOME/config.yaml"
# a fake Telegram: records what the gateway tells the owner (the bot token is a test value, at the input's path)
TGP=$(( PORT + 7 )); mkdir -p "$HOME/brain/.keys"; printf 'test-bot-token-9911' >"$HOME/brain/.keys/.telebot"; chmod 600 "$HOME/brain/.keys/.telebot"
cat >"$T/faketg.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { fs.appendFileSync(out, JSON.stringify({ path: req.url, body: JSON.parse(b || '{}') }) + '\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) }).listen(Number(port), '127.0.0.1')
EOF
node "$T/faketg.mjs" $TGP "$T/tg.jsonl" & TG=$!
export MM_TELEGRAM_API="http://127.0.0.1:$TGP"
told() { sleep 0.5; grep -F "$1" "$T/tg.jsonl" | grep -q '"chat_id":"4242"'; }
echo "# from $T/proj/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"; echo "# from $T/proj2/services.yaml" >"$MM_HOME/pc/projects/acme-other.yaml"
# a project as the gateway reads it (review sy-b15.17): its answers and its services.yaml, never its .run/
fakeproj() { mkdir -p "$1/.run"; printf 'client: acme\nname: %s\nproject: %s\nshort: x\nroot: %s\ntemplate_version: test\ncreated: test\n' "${2#acme-}" "$2" "$1" >"$1/.mm-answers.yaml"
  printf 'services:\n  board:\n    command: "true"\n    port: http\n    public: { name: %s, auth: required }\n' "$3" >"$1/services.yaml"; }
fakeproj "$T/proj" acme-shop board-shop-acme; fakeproj "$T/proj2" acme-other board-other-acme
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
export PATH="$T/bin:$PATH"   # every check, including those in sh -c, runs this mm
MM_AUTH_HOST_CACHE_MS=200 mm auth serve >"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/s" && break; sleep 0.2; done
G="http://127.0.0.1:$PORT"
# the browser on the gateway's host: the session cookie is __Secure- (https), so curl gets it by hand here
gw() { curl -s -H "x-forwarded-host: $AUTH" -H 'x-forwarded-proto: https' "$@"; }
sess() { sed -n 's/^set-cookie: \(__Secure-better-auth\.session_token=[^;]*\).*/\1/ip' "$1" | tail -1; }
link_of() { mm user link "$1" -o json | jq -r .link; }
# a link opens a Continue page; its button POSTs the link's token from the gateway's own page (review sy-g8v 2)
qs() { printf '%s' "${1#*\?}" | tr '&' '\n' | sed -n "s/^$2=//p"; }
open_link() { gw -D "$2" -o /dev/null -H "origin: https://$AUTH" -d "t=$(qs "$1" token)&c=$(qs "$1" callbackURL)" "$G/s/l"; }
export -f gw sess; export G AUTH BOARD BOARD2 T MM_HOME

echo '== people (no password)'
check "the owner: mm user add boss --owner" bash -c "mm user add boss --owner -o json | jq -e '.owner == true'"
check "a second owner: refused" bash -c "! mm user add carol --owner"
check "mm user add alex" bash -c "mm user add alex -o json | jq -e '.name == \"alex\" and .owner == false'"
check "the same name again: refused" bash -c "! mm user add alex"
check "reserved names are refused (the owner's name, steward, bridge, mm, root, ops)" bash -c "for n in boss steward bridge mm root ops sentinel assistant; do ! mm user add \$n || exit 1; done"
check "mm user ls: alex, no grants yet; boss the owner" bash -c "mm user ls -o json | jq -e '(.[] | select(.name==\"alex\") | .grants == \"\") and (.[] | select(.name==\"boss\") | .owner)'"

echo '== a link that works once'
check "a link lives 1 h by default (review sy-b15.14)" bash -c "E=\$(mm user link alex -o json | jq -r .expires); d=\$(( \$(date -d \"\$E\" +%s) - \$(date +%s) )); [ \$d -gt 3500 ] && [ \$d -le 3600 ]"
check "...--ttl 10m: a 10-minute link (for the bridge)" bash -c "E=\$(mm user link alex --ttl 10m -o json | jq -r .expires); d=\$(( \$(date -d \"\$E\" +%s) - \$(date +%s) )); [ \$d -gt 580 ] && [ \$d -le 600 ]"
check "...--ttl 2h for more; more than 7 days is refused" bash -c "E=\$(mm user link alex --ttl 2h -o json | jq -r .expires); d=\$(( \$(date -d \"\$E\" +%s) - \$(date +%s) )); [ \$d -gt 7100 ] && ! mm user link alex --ttl 8d"
L=$(link_of alex)
check "mm user link alex: a single-use link on the gateway's host" bash -c "echo '$L' | grep -q '^https://$AUTH/api/auth/magic-link/verify?token='"
LP=${L#https://$AUTH}
check "opening the link (as a chat preview or a mail scanner does): a Continue page, no session, nothing used" bash -c "gw -D '$T/pv' -o '$T/pvb' '$G$LP'; head -1 '$T/pv' | grep -q 200 && ! grep -qi 'set-cookie' '$T/pv' && grep -q 'action=\"/s/l\"' '$T/pvb' && gw -o /dev/null -w '%{http_code}' '$G$LP' | grep -q 200"
check "...its POST from another site (no Origin, or a foreign one): refused, and the link stays unused" bash -c "[ \"\$(gw -o /dev/null -w '%{http_code}' -d 't=$(qs "$L" token)&c=/s/done' $G/s/l)\" = 403 ] && [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: https://evil.example' -d 't=$(qs "$L" token)&c=/s/done' $G/s/l)\" = 403 ]"
open_link "$L" "$T/h1"; S1=$(sess "$T/h1")
check "opening it: a session (Secure, HttpOnly, host-only: no Domain=) and on to /s/done" bash -c "[ -n '$S1' ] && grep -i 'set-cookie: __Secure-better-auth.session_token' '$T/h1' | grep -qi httponly && ! grep -i 'set-cookie: __Secure-better-auth.session_token' '$T/h1' | grep -qi 'domain=' && grep -qi '^location: .*/s/done' '$T/h1'"
open_link "$L" "$T/h1b"
check "the same link again: no session" bash -c "[ -z \"\$(sess '$T/h1b')\" ]"
check "/s/done: signed in as alex, no board yet" bash -c "gw -H 'cookie: $S1' $G/s/done | grep -q 'Signed in as <b>alex</b>' && gw -H 'cookie: $S1' $G/s/done | grep -q 'no board yet'"
check "the board before a grant: no way in (the page says ask the owner)" bash -c "gw -D '$T/p0h' -o '$T/p0' -H 'cookie: $S1' '$G/s?b=$BOARD&r=/items'; head -1 '$T/p0h' | grep -q 200 && grep -q 'no access' '$T/p0'"

echo '== a grant: one session opens the board'
check "mm grant alex acme-shop (member)" bash -c "mm grant alex acme-shop -o json | jq -e '.role == \"member\"'"
CB=$(gw -D - -o /dev/null -H "cookie: $S1" "$G/s?b=$BOARD&r=/items" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
check "the same session, the board: straight to its one-time callback, no new link" bash -c "echo '$CB' | grep -q '^/_mm/auth/callback?c='"
check "/s/done lists the board" bash -c "gw -H 'cookie: $S1' $G/s/done | grep -q 'https://$BOARD/'"
curl -s -c "$T/bj" -H "x-forwarded-host: $BOARD" -D "$T/h3" -o /dev/null "$G$CB"
check "the callback sets the board's own cookie (Strict, host-only) and goes back to /items" bash -c "grep -i 'set-cookie: mm_board=' '$T/h3' | grep -qi 'SameSite=Strict' && ! grep -i 'set-cookie: mm_board=' '$T/h3' | grep -qi 'domain=' && grep -qi '^location: /items' '$T/h3'"
check "the callback code is single use" test "$(curl -s -o /dev/null -w '%{http_code}' -H "x-forwarded-host: $BOARD" "$G$CB")" = 403
CBX=$(gw -D - -o /dev/null -H "cookie: $S1" "$G/s?b=$BOARD&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
check "a callback on another host is refused" test "$(curl -s -o /dev/null -w '%{http_code}' -H "x-forwarded-host: $BOARD2" "$G$CBX")" = 403
check "a board with no grant (acme-other): no callback for it" bash -c "gw -D - -o /dev/null -H 'cookie: $S1' '$G/s?b=$BOARD2' | head -1 | grep -q 200"

echo '== forward-auth'
v() { curl -s -D - -o /dev/null -b "$T/bj" -H "x-forwarded-host: ${1:-$BOARD}" -H 'x-forwarded-uri: /items' -H 'x-forwarded-proto: https' "$G/verify"; }
export -f v
v >"$T/v1"
check "with the board cookie: 200 and an assertion" bash -c "head -1 '$T/v1' | grep -q 200 && grep -qi '^x-mm-assertion: [A-Za-z0-9_-]*\.[A-Za-z0-9_-]*' '$T/v1'"
A=$(sed -n 's/^x-mm-assertion: \(.*\)\r$/\1/ip' "$T/v1")
cat >"$T/verify.mjs" <<'EOF'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
const [a, keyFile, host, user, role] = process.argv.slice(2), [body, sig] = a.split('.')
const pub = createPublicKey(createPrivateKey(readFileSync(keyFile, 'utf8')))
const good = verify(null, Buffer.from(body), pub, Buffer.from(sig, 'base64url'))
const c = JSON.parse(Buffer.from(body, 'base64url').toString())
const tampered = verify(null, Buffer.from(body.slice(0, -2) + 'AA'), pub, Buffer.from(sig, 'base64url'))
process.exit(good && !tampered && c.u === user && c.r === role && c.h === host && c.exp > Date.now() && c.exp < Date.now() + 61000 ? 0 : 1)
EOF
check "the assertion verifies with the public key: alex, member, this host, 60 s; a changed one doesn't" node "$T/verify.mjs" "$A" "$MM_HOME/auth/signing.key" "$BOARD" alex member
check "the board cookie on another board host: sign in (302)" bash -c "v $BOARD2 | head -1 | grep -q 302"
check "no cookie: 302 to the sign-in page, back to the same path" bash -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' -H 'x-forwarded-uri: /items' $G/verify | grep -qi '^location: https://$AUTH/s?b=$BOARD&r=%2Fitems'"
check "only the exact callback path skips forward-auth: /_mm/auth/../api/items, %2e%2e, ..%2f need a session (302)" bash -c "for u in '/_mm/auth/../api/items' '/_mm/auth/%2e%2e/api/items' '/_mm/auth/..%2fapi/items' '/_mm/auth/x'; do curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' -H \"x-forwarded-uri: \$u\" $G/verify | head -1 | grep -q 302 || exit 1; done; curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' -H 'x-forwarded-uri: /_mm/auth/callback?c=x' $G/verify | head -1 | grep -q 200"
check "the identity headers are always set (to '-') on a refusal (a client's copy can't pass)" bash -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' $G/verify | grep -qiE '^x-board-role: -[[:space:]]*\$'"
mm grant alex acme-shop --as designer >/dev/null
check "mm grant --as designer: the next assertion says designer" bash -c "node '$T/verify.mjs' \"\$(v | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' '$BOARD' alex designer"
mm grant alex acme-shop >/dev/null

echo '== the owner'
LB=$(link_of boss); open_link "$LB" "$T/hb"; SB=$(sess "$T/hb")
CBB=$(gw -D - -o /dev/null -H "cookie: $SB" "$G/s?b=$BOARD2&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
curl -s -c "$T/bjb" -H "x-forwarded-host: $BOARD2" -o /dev/null "$G$CBB"
check "the owner opens any board with no grant (acme-other), as owner" bash -c "node '$T/verify.mjs' \"\$(curl -s -D - -o /dev/null -b '$T/bjb' -H 'x-forwarded-host: $BOARD2' $G/verify | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' '$BOARD2' boss owner"
check "a grant to the owner is refused (owner everywhere already)" bash -c "! mm grant boss acme-shop"

echo '== tokens for tools'
TK=$(mm token alex acme-shop -o json | jq -r .token)
bv() { curl -s -D - -o /dev/null -H "x-forwarded-host: ${2:-$BOARD}" -H "authorization: Bearer $1" "$G/verify"; }
export -f bv
check "mm token alex acme-shop: shown once (mmt_…)" bash -c "echo '$TK' | grep -q '^mmt_'"
check "Bearer: 200, an assertion for alex as member" bash -c "node '$T/verify.mjs' \"\$(bv '$TK' | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' '$BOARD' alex member"
check "...the same token on another project's board: 401" bash -c "bv '$TK' $BOARD2 | head -1 | grep -q 401"
check "...a wrong token: 401, no sign-in redirect" bash -c "bv mmt_nope | head -1 | grep -q 401"
check "a token for a project with no grant: refused" bash -c "! mm token alex acme-other"

echo "== board hosts: from what the host owns, never from a project's .run/ (review sy-b15.17)"
mm user add bob >/dev/null; mm grant bob acme-other >/dev/null; TKB=$(mm token bob acme-other -o json | jq -r .token)
check "bob's token (acme-other) opens acme-other's board, not acme-shop's" bash -c "bv '$TKB' $BOARD2 | head -1 | grep -q 200 && bv '$TKB' | head -1 | grep -q 401"
# acme-other (a box can write its .run/) claims acme-shop's host and the gateway's; acme-shop's file claims acme-other's
echo "{\"project\":\"acme-other\",\"services\":{\"board\":{\"public_url\":\"https://$BOARD\",\"public\":{\"name\":\"board-shop-acme\",\"auth\":\"required\"}},\"b2\":{\"public_url\":\"https://$AUTH\",\"public\":{\"name\":\"auth\",\"auth\":\"required\"}}}}" >"$T/proj2/.run/services.json"
echo "{\"project\":\"acme-shop\",\"services\":{\"board\":{\"public_url\":\"https://$BOARD2\",\"public\":{\"name\":\"board-other-acme\",\"auth\":\"required\"}}}}" >"$T/proj/.run/services.json"
sleep 0.5
check "...a project's .run/services.json claims another board's host: nothing changes (bob 401 there, alex still 200)" bash -c "bv '$TKB' | head -1 | grep -q 401 && bv '$TK' | head -1 | grep -q 200 && bv '$TKB' $BOARD2 | head -1 | grep -q 200 && bv '$TK' $BOARD2 | head -1 | grep -q 401"
# a registry file whose name isn't the project its answers name: no host from it
mkdir -p "$MM_HOME/pc/boxes"; echo "# from $T/proj2/services.yaml" >"$MM_HOME/pc/boxes/acme-evil.yaml"; sleep 0.5
check "a registry file named for another project: skipped and logged; acme-other still works" bash -c "bv '$TKB' $BOARD2 | head -1 | grep -q 200 && grep 'board hosts refused' '$T/gw.log' | grep -q 'acme-evil.yaml: the project.s answers name acme-other'"
rm -f "$MM_HOME/pc/boxes/acme-evil.yaml"
# two projects claim one host (in their own services.yaml): neither gets it, and the gateway says so
fakeproj "$T/proj3" acme-third board-shop-acme; echo "# from $T/proj3/services.yaml" >"$MM_HOME/pc/boxes/acme-third.yaml"; sleep 0.5
check "two projects claim one host: refused for both (alex 401), logged" bash -c "bv '$TK' | head -1 | grep -q 401 && grep 'board hosts refused' '$T/gw.log' | grep -q 'claimed by acme-shop, acme-third'"
rm -f "$MM_HOME/pc/boxes/acme-third.yaml"; sleep 0.5
check "...the second claim gone: acme-shop's board is its own again" bash -c "bv '$TK' | head -1 | grep -q 200"
mm user rm bob >/dev/null

echo '== ending it'
TK2=$(mm token alex acme-shop -o json | jq -r .token)
mm revoke alex acme-shop >/dev/null
check "mm revoke alex acme-shop: the board cookie gets no assertion at once" bash -c "v | head -1 | grep -q 302"
check "...and the project's tokens end with it" bash -c "bv '$TK2' | head -1 | grep -q 401"
mm grant alex acme-shop >/dev/null
CB3=$(gw -D - -o /dev/null -H "cookie: $S1" "$G/s?b=$BOARD&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip'); curl -s -c "$T/bj" -H "x-forwarded-host: $BOARD" -o /dev/null "$G$CB3"
check "granted again: the same session gets back in (no new link)" bash -c "v | head -1 | grep -q 200"
gw -X POST -H "cookie: $S1" -H 'content-type: application/json' -d '{}' "$G/s/out" >/dev/null
check "sign out: the session and its board sessions end at once" bash -c "v | head -1 | grep -q 302 && gw -H 'cookie: $S1' $G/s/done | grep -q 'expired'"
L3=$(link_of alex); open_link "$L3" "$T/h5"; S5=$(sess "$T/h5")
CB5=$(gw -D - -o /dev/null -H "cookie: $S5" "$G/s?b=$BOARD&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip'); curl -s -c "$T/bj" -H "x-forwarded-host: $BOARD" -o /dev/null "$G$CB5"
TK3=$(mm token alex acme-shop -o json | jq -r .token)
mm user rm alex >/dev/null
check "mm user rm alex: the board cookie, the session and the token are dead at once" bash -c "v | head -1 | grep -q 302 && bv '$TK3' | head -1 | grep -q 401 && gw -H 'cookie: $S5' $G/s/done | grep -q expired"
check "...and alex is gone from mm user ls" bash -c "! mm user ls -o json | jq -e '.[] | select(.name==\"alex\")'"
mm user add alex >/dev/null; mm grant alex acme-shop >/dev/null   # back, for the board's public side below

echo "== the board's public side (the template's board server, this gateway's key)"
BP=$(( PORT + 1 )); BL=$(( PORT + 2 ))
PUB=$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createPublicKey(c.createPrivateKey(f.readFileSync(process.argv[1],'utf8'))).export({type:'spki',format:'pem'}))" "$MM_HOME/auth/signing.key")
# a fake bd-serve: records what the board forwards; serves item it-1 with labels [t2]
BDP=$(( PORT + 3 ))
cat >"$T/fakebd.mjs" <<'EOF'
import http from 'node:http'
import fs from 'node:fs'
const [port, logf] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  fs.appendFileSync(logf, JSON.stringify({ m: req.method, p: req.url, b: b ? JSON.parse(b) : null }) + '\n')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(req.method === 'GET' && /\/issues\/it-1/.test(req.url) ? { id: 'it-1', labels: ['t2', 'bug'] } : { ok: true, items: [] }))
}) }).listen(Number(port), '127.0.0.1')
EOF
node "$T/fakebd.mjs" $BDP "$T/bd.jsonl" & FB=$!
mkdir -p "$T/board" && (cd "$SRC/template" && tar -cf - --exclude=node_modules --exclude=dist site bin leads) | tar -xf - -C "$T/board"   # a copy: the board writes .run/ where it runs
(cd "$T/board" && PORT=$BL BOARD_PUBLIC_PORT=$BP BD_SERVE=http://127.0.0.1:$BDP MM_AUTH_PUBLIC_KEY="$PUB" PASEO_NO_SDK=1 PASEO_BIN=false MM_PROJECT=acme-shop \
  exec node site/server.mjs >"$T/board.log" 2>&1) & BS=$!
for _ in $(seq 1 150); do curl -s -o /dev/null "http://127.0.0.1:$BL/api/whoami" && curl -s -o /dev/null "http://127.0.0.1:$BP/" && break; sleep 0.2; done
pub() { curl -s -o "$T/pb" -w '%{http_code}' -H "x-forwarded-host: ${2:-$BOARD}" ${1:+-H "x-mm-assertion: $1"} "${@:3}" "http://127.0.0.1:$BP/api/whoami"; }
mk() { node -e "const c=require('crypto'),f=require('fs');const [k,u,r,h,ms]=process.argv.slice(1);const b=Buffer.from(JSON.stringify({u,r,h,exp:Date.now()+Number(ms),n:'t'})).toString('base64url');process.stdout.write(b+'.'+c.sign(null,Buffer.from(b),c.createPrivateKey(f.readFileSync(k,'utf8'))).toString('base64url'))" "$MM_HOME/auth/signing.key" "$@"; }
check "public side, no assertion: 401, nothing else" test "$(pub '')" = 401
check "a forged X-Board-User without an assertion: 401" test "$(curl -s -o /dev/null -w '%{http_code}' -H "x-forwarded-host: $BOARD" -H 'x-board-user: owner' -H 'x-board-role: owner' http://127.0.0.1:$BP/api/whoami)" = 401
AL=$(mk alex member "$BOARD" 60000)   # signed with the gateway's key, as /verify does (checked above with verify.mjs)
check "the gateway's assertion: the board knows alex (source gateway)" sh -c "[ \$(curl -s -o '$T/pb' -w '%{http_code}' -H 'x-forwarded-host: $BOARD' -H 'x-mm-assertion: $AL' http://127.0.0.1:$BP/api/whoami) = 200 ] && jq -e '.actor == \"alex\" and .source == \"gateway\"' '$T/pb'"
check "another board's assertion: 401" test "$(pub "$(mk alex member board-other.example.org 60000)")" = 401
check "an expired assertion: 401" test "$(pub "$(mk alex member "$BOARD" -1000)")" = 401
TA=$(mk alex owner "$BOARD" 60000); check "a changed assertion (role edited): 401" test "$(pub "$(echo "$TA" | sed 's/^\(.\{10\}\)./\1Z/')")" = 401
check "a viewer can't change anything (POST: 403)" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $(mk vic viewer "$BOARD" 60000)" http://127.0.0.1:$BP/api/v0/beads/issues)" = 403
check "no self-chosen name on the public side (403)" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"name":"owner"}' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $AL" http://127.0.0.1:$BP/api/whoami)" = 403
check "the local side is unchanged (whoami answers)" curl -sf -o /dev/null "http://127.0.0.1:$BL/api/whoami"

echo "== the rails on the public side (members steer; the T2 go and tiers are the owner's; sign-off is the leads')"
MA=$(mk alex member "$BOARD" 60000); OA=$(mk boss owner "$BOARD" 60000)
w() { curl -s -o "$T/wb" -w '%{http_code}' -X "$1" -H 'content-type: application/json' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $2" -d "$4" "http://127.0.0.1:$BP/api/v0/beads/issues$3"; }
last() { tail -1 "$T/bd.jsonl"; }
export -f w; export BP BOARD
check "a member creates an item: forwarded, with by:member" bash -c "[ \$(w POST '$MA' '' '{\"title\":\"x\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.labels | index(\"by:member\")'"
check "a designer (a member who also edits Doop) steers the board like a member: by:designer" bash -c "[ \$(w POST '$(mk dee designer "$BOARD" 60000)' '' '{\"title\":\"d\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.labels | index(\"by:designer\")'"
check "...but can't give the T2 go (approved stays the owner's)" test "$(w POST "$(mk dee designer "$BOARD" 60000)" '' '{"title":"d","labels":["approved"]}')" = 403
check "mm grant --as designer: kept as designer" bash -c "mm user add dee >/dev/null && mm grant dee acme-shop --as designer >/dev/null && mm auth grants -o json | jq -e '.[] | select(.name==\"dee\" and .project==\"acme-shop\") | .role == \"designer\"'"
check "a member can't create an item labelled approved (403)" test "$(w POST "$MA" '' '{"title":"x","labels":["approved"]}')" = 403
check "a member can't add approved by a PATCH (403)" test "$(w PATCH "$MA" /it-1 '{"patch":{"labels":["t2","bug","approved"]}}')" = 403
check "a member can't drop a tier (t2 -> none) (403)" test "$(w PATCH "$MA" /it-1 '{"patch":{"labels":["bug"]}}')" = 403
check "a member can add an ordinary label" test "$(w PATCH "$MA" /it-1 '{"patch":{"labels":["t2","bug","urgent"]}}')" = 200
check "a member can assign and close (steering)" bash -c "[ \$(w PATCH '$MA' /it-1 '{\"patch\":{\"assignee\":\"ops\"}}') = 200 ] && [ \$(w POST '$MA' /it-1:close '{}') = 200 ]"
check "an unknown label field: refused (403)" test "$(w PATCH "$MA" /it-1 '{"patch":{"label_set":["approved"]}}')" = 403
check "a member can't fake the author role label (403)" test "$(w POST "$MA" '' '{"title":"x","labels":["by:owner"]}')" = 403
check "the owner gives the T2 go (add approved)" test "$(w PATCH "$OA" /it-1 '{"patch":{"add_labels":["approved"]}}')" = 200
check "the owner changes a tier" test "$(w PATCH "$OA" /it-1 '{"patch":{"labels":["t1","bug"]}}')" = 200
check "not even the owner signs off for review (403)" test "$(w PATCH "$OA" /it-1 '{"patch":{"add_labels":["signed-off"]}}')" = 403
check "a comment carries its author's role" bash -c "[ \$(w POST '$MA' /it-1/comments '{\"text\":\"looks good\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.text == \"[member] looks good\" and .b.author == \"alex\"'"
check "...and its author is the signed-in person, whatever the body says" bash -c "[ \$(w POST '$MA' /it-1/comments '{\"text\":\"x\",\"author\":\"owner\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.author == \"alex\"'"
kill $BS $FB 2>/dev/null

LF=$(link_of alex); gw -o /dev/null -H 'cf-connecting-ip: 6.6.6.6' -H "origin: https://$AUTH" -d "t=$(qs "$LF" token)&c=$(qs "$LF" callbackURL)" "$G/s/l"
check "a CF-Connecting-IP from an untrusted peer is ignored: the sign-in is logged from the real peer (review sy-b15.14 4)" bash -c "grep 'signed in by link' '$T/gw.log' | tail -1 | grep -q '\"ip\":\"127.0.0.1\"' && ! grep -q '6.6.6.6' '$T/gw.log'"
check "mm user ls shows the last sign-in" bash -c "mm user ls -o json | jq -e '.[] | select(.name==\"alex\") | .last_signin != null'"

echo '== a link expires'
kill $GW 2>/dev/null; wait $GW 2>/dev/null
MM_AUTH_LINK_S=2 mm auth serve >>"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "$G/s" && break; sleep 0.2; done
LE=$(link_of alex); sleep 3; open_link "$LE" "$T/he"
check "a link opened after its lifetime: no session" bash -c "[ -z \"\$(sess '$T/he')\" ]"

echo '== sign-in by code (for the bridge: /login and Allow)'
JC="$T/jarc"; rm -f "$JC"
CODE=$(gw -c "$JC" -b "$JC" "$G/s?b=$BOARD&r=/items" | sed -n 's/.*id="code"[^>]*>\([0-9A-Z-]*\)<.*/\1/p')
check "no session: the page shows a code (XXXX-XXXX), bound to this browser (pending cookie)" bash -c "echo '$CODE' | grep -qE '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\$' && grep -q mm_pending '$JC'"
check "the page waits" bash -c "gw -b '$JC' $G/s/poll | grep -q waiting"
check "mm auth pending <code>: what is asking (board, age)" bash -c "mm auth pending $CODE -o json | jq -e '.board == \"$BOARD\" and .age_s >= 0'"
check "approve for a person who doesn't exist: refused" bash -c "! mm auth approve $CODE --as nobody"
check "mm auth approve <code> --as alex" bash -c "mm auth approve $CODE --as alex -o json | jq -e '.ok and .name == \"alex\"'"
check "the same code again: refused (single use)" bash -c "! mm auth approve $CODE --as alex"
check "another browser's poll gets nothing" bash -c "gw $G/s/poll | grep -q expired"
NEXT=$(gw -b "$JC" -c "$JC" "$G/s/poll" | jq -r .next)
check "the waiting browser gets a short single-use link, once" bash -c "echo '$NEXT' | grep -q '^https://$AUTH/api/auth/magic-link/verify?token=' && gw -b '$JC' $G/s/poll | grep -q expired"
open_link "$NEXT" "$T/hc"; SC=$(sess "$T/hc")
check "opening it: a session, and on to the board it asked for" bash -c "[ -n '$SC' ] && grep -qi '^location: .*/s?b=$BOARD' '$T/hc'"
CBC=$(gw -D - -o /dev/null -H "cookie: $SC" "$G/s?b=$BOARD&r=/items" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
check "...its one-time callback (no new code, no new link)" bash -c "echo '$CBC' | grep -q '^/_mm/auth/callback?c='"
check "the owner was told (who, where, approved by whom)" told 'alex was signed in by code'
check "CLAUDECODE=1: mm auth approve is refused" bash -c "C2=\$(gw '$G/s?b=$BOARD' | sed -n 's/.*id=\"code\"[^>]*>\\([0-9A-Z-]*\\)<.*/\\1/p'); CLAUDECODE=1 mm auth approve \$C2 --as alex 2>&1 | grep -q \"the owner's to make\""

echo '== the owner hears every access change (review sy-b15.13)'
check "a person added: told, with the undo" told 'a person added: alex. Undo: mm user rm alex'
check "a link made: told (who, how long, the undo)" told 'a sign-in link was made for alex'
check "a link used: told (who, from where)" told 'alex signed in with a link, from 127.0.0.1'
check "a grant: told, with the undo" told 'alex was granted acme-shop as member. Undo: mm revoke alex acme-shop'
check "a token: told, with the undo" told 'a token for tools was made for alex on acme-shop'
check "a revoke and a removal: told" bash -c "grep -q \"alex's access to acme-shop was revoked\" '$T/tg.jsonl' && grep -q 'alex was removed' '$T/tg.jsonl'"
check "to the owner's chat only, through the bot's API" bash -c "jq -e -s 'all(.body.chat_id == \"4242\" and (.path | startswith(\"/bot\")))' '$T/tg.jsonl'"
check "the bot token is never in the gateway's log" bash -c "! grep -q 'test-bot-token-9911' '$T/gw.log'"
echo '== from an agent'"'"'s shell: refused (review sy-b15.13 3)'
N0=$(grep -c 'a sign-in link was made' "$T/tg.jsonl")
check "CLAUDECODE=1: mm user link, mm token, mm grant, mm user add are refused" bash -c "for c in 'user link alex' 'token alex acme-shop' 'grant alex acme-other' 'user add zed'; do CLAUDECODE=1 mm \$c 2>&1 | grep -q \"the owner's to make\" || exit 1; done"
check "...and nothing was made (no new link, no zed)" bash -c "sleep 0.5; [ \$(grep -c 'a sign-in link was made' '$T/tg.jsonl') = '$N0' ] && ! mm user ls -o json | jq -e '.[] | select(.name==\"zed\")'"
check "...mm revoke stays free (it only takes access away)" bash -c "CLAUDECODE=1 mm revoke dee acme-shop"
kill $TG 2>/dev/null

echo '== the store, the logs'
check "auth/ 0700, files 0600 (accounts.db, secret, signing.key), the socket 0600" bash -c "[ \$(stat -c %a '$MM_HOME/auth') = 700 ] && [ -z \"\$(find '$MM_HOME/auth' -type f ! -perm 600)\" ] && [ \$(stat -c %a '$MM_HOME/run/auth.sock') = 600 ]"
TOK=$(echo "$L" | sed 's/.*token=\([^&]*\).*/\1/')
check "the log has no link token, no token, no cookie value" bash -c "! grep -qF '$TOK' '$T/gw.log' && ! grep -qF '$TK' '$T/gw.log' && ! grep -qE 'session_token=|mm_board=' '$T/gw.log'"
check "every sign-in by link and every grant is logged" bash -c "grep -q 'signed in by link' '$T/gw.log' && grep -q '\"granted\"' '$T/gw.log'"
[ "$fail" = 0 ] || { echo "--- gw.log"; tail -8 "$T/gw.log"; echo "--- board.log"; tail -8 "$T/board.log" 2>/dev/null; }
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
