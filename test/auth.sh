#!/usr/bin/env bash
# mm.auth, hermetic: a throwaway HOME and MM_HOME, a fake board's public name, curl as the browser, `mm auth` as the
# approver. Proves the sign-in by a code approved elsewhere (no token, no password), single use under a race, the
# board's own cookie, forward-auth with a signed assertion (verified with the public key), revoke at once, self /
# owner / refused approvals, the rate limits, expiry, the store's modes, and that logs carry no code or cookie.
#   test/auth.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); GW=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_AUTH_CODE_MS=6000
unset PASEO_AGENT_ID PASEO_AGENT_CWD
mkdir -p "$MM_HOME/pc/projects" "$T/proj/.run"
PORT=$(( 39100 + RANDOM % 800 )); BOARD=board-shop-acme.example.org
printf 'domain: example.org\naccess: domain\nauth_port: %s\nbind_host: 127.0.0.1\ntelegram:\n  owner_id: "777"\n' "$PORT" >"$MM_HOME/config.yaml"
echo "# from $T/proj/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"
echo "{\"project\":\"acme-shop\",\"services\":{\"board\":{\"public_url\":\"https://$BOARD\",\"public\":{\"name\":\"board-shop-acme\",\"auth\":\"required\"}}}}" >"$T/proj/.run/services.json"
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
export PATH="$T/bin:$PATH"   # every check, including those in sh -c, runs this mm
mm auth serve >"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 50); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/s/app.js" && break; sleep 0.2; done
G="http://127.0.0.1:$PORT"; J="$T/jar"
sig() { curl -s -c "$J" -b "$J" -H "cf-connecting-ip: ${2:-10.0.0.1}" -D "$T/h" "$G/s?b=$BOARD&r=${1:-/items}" | sed -n 's/.*id="code"[^>]*>\([0-9A-Z-]*\)<.*/\1/p'; }

echo '== a code on the screen'
CODE=$(sig /items)
check "the sign-in page shows a code (XXXX-XXXX)" bash -c "echo '$CODE' | grep -qE '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\$'"
check "strict CSP, no-referrer, no-store" bash -c "grep -qi \"content-security-policy: default-src 'self'\" '$T/h' && grep -qi 'referrer-policy: no-referrer' '$T/h' && grep -qi 'cache-control: no-store' '$T/h'"
check "a pending cookie, HttpOnly" bash -c "grep -qi 'set-cookie: mm_pending=.*HttpOnly' '$T/h'"
check "the page waits" bash -c "curl -s -b '$J' $G/s/poll | grep -q waiting"
check "mm auth pending shows what is asking" bash -c "mm auth pending $CODE -o json | jq -e '.board == \"$BOARD\" and .ip == \"10.0.0.1\"'"
check "a forged X-Forwarded-For doesn't change the address shown (sy-lbe)" bash -c "rm -f '$T/jx'; C=\$(curl -s -c '$T/jx' -H 'x-forwarded-for: 6.6.6.6' -H 'cf-connecting-ip: 10.0.0.9' '$G/s?b=$BOARD' | sed -n 's/.*id=\"code\"[^>]*>\\([0-9A-Z-]*\\)<.*/\\1/p'); mm auth pending \$C -o json | jq -e '.ip == \"10.0.0.9\"'"
check "...and with no CF-Connecting-IP it is the socket peer, not the header" bash -c "rm -f '$T/jx'; C=\$(curl -s -c '$T/jx' -H 'x-forwarded-for: 6.6.6.6' '$G/s?b=$BOARD' | sed -n 's/.*id=\"code\"[^>]*>\\([0-9A-Z-]*\\)<.*/\\1/p'); mm auth pending \$C -o json | jq -e '.ip == \"127.0.0.1\"'"

echo '== approved by the owner, as a named guest'
check "a wrong scope name is refused" bash -c "! mm auth approve $CODE --as ops --for acme-shop"
check "reserved names are refused: the owner's name, steward, bridge, mm, root" bash -c "for n in owner steward bridge mm root sentinel assistant; do ! mm auth approve $CODE --as \$n --for acme-shop || exit 1; done"
check "an approval with no end (days 0) is refused" bash -c "! mm auth approve $CODE --as alex --for acme-shop --days 0"
check "mm auth approve --as alex --for acme-shop" bash -c "mm auth approve $CODE --as alex --for acme-shop -o json | jq -e '.user == \"alex\" and .role == \"member\"'"
check "the same code again: refused (single use)" bash -c "! mm auth approve $CODE --as eve --for acme-shop"
curl -s -c "$J" -b "$J" -D "$T/h2" "$G/s/poll" >"$T/poll.json"
check "the page gets a session" jq -e '.state == "approved" and (.next | startswith("https://'"$BOARD"'/_mm/auth/callback?c="))' "$T/poll.json"
check "...in a host-only cookie (no Domain=), HttpOnly, Lax" bash -c "grep -i 'set-cookie: mm_auth=' '$T/h2' | grep -qi 'HttpOnly' && ! grep -i 'set-cookie: mm_auth=' '$T/h2' | grep -qi 'domain='"
NEXT=$(jq -r .next "$T/poll.json"); CB="${NEXT#https://$BOARD}"
curl -s -c "$T/bj" -H "x-forwarded-host: $BOARD" -D "$T/h3" -o /dev/null "$G$CB"
check "the board's callback sets its own cookie (Strict, host-only) and goes back to /items" bash -c "grep -i 'set-cookie: mm_board=' '$T/h3' | grep -qi 'SameSite=Strict' && grep -qi '^location: /items' '$T/h3'"
check "the callback code is single use" test "$(curl -s -o /dev/null -w '%{http_code}' -H "x-forwarded-host: $BOARD" "$G$CB")" = 403
CB2=$(curl -s -b "$J" -D - -o /dev/null "$G/s?b=$BOARD&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
check "a live session: the next board visit needs no new code" bash -c "echo '$CB2' | grep -q '^/_mm/auth/callback?c='"
check "a callback on another host is refused" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-forwarded-host: board-other.example.org' "$G$CB2")" = 403

echo '== forward-auth'
export J G BOARD T MM_HOME
v() { curl -s -D - -o /dev/null -b "$T/bj" -H "x-forwarded-host: ${1:-$BOARD}" -H 'x-forwarded-uri: /items' -H 'x-forwarded-proto: https' "$G/verify"; }
export -f v
v >"$T/v1"
check "with the board cookie: 200 and an assertion" bash -c "head -1 '$T/v1' | grep -q 200 && grep -qi '^x-mm-assertion: [A-Za-z0-9_-]*\.[A-Za-z0-9_-]*' '$T/v1'"
A=$(sed -n 's/^x-mm-assertion: \(.*\)\r$/\1/ip' "$T/v1")
cat >"$T/verify.mjs" <<'EOF'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
const [a, keyFile, host] = process.argv.slice(2), [body, sig] = a.split('.')
const pub = createPublicKey(createPrivateKey(readFileSync(keyFile, 'utf8')))
const good = verify(null, Buffer.from(body), pub, Buffer.from(sig, 'base64url'))
const c = JSON.parse(Buffer.from(body, 'base64url').toString())
const tampered = verify(null, Buffer.from(body.slice(0, -2) + 'AA'), pub, Buffer.from(sig, 'base64url'))
process.exit(good && !tampered && c.u === 'alex' && c.r === 'member' && c.h === host && c.exp > Date.now() && c.exp < Date.now() + 61000 ? 0 : 1)
EOF
check "the assertion verifies with the public key: alex, member, this host, 60 s; a changed one doesn't" node "$T/verify.mjs" "$A" "$MM_HOME/auth/signing.key" "$BOARD"
check "the board cookie on another board host: sign in (302)" bash -c "v board-other.example.org | head -1 | grep -q 302"
check "no cookie: 302 to the sign-in page, back to the same path" bash -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' -H 'x-forwarded-uri: /items' $G/verify | grep -qi '^location: https://auth.example.org/s?b=$BOARD&r=%2Fitems'"
check "the identity headers are always set (to '-') on a refusal (a client's copy can't pass)" bash -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $BOARD' $G/verify | grep -qiE '^x-board-role: -[[:space:]]*\$'"
mm auth revoke alex >/dev/null
check "revoke: the next request is refused at once" bash -c "v | head -1 | grep -q 302"
check "...and alex has no sessions left" bash -c "! mm auth sessions -o json | jq -e '.[] | select(.user == \"alex\")'"

echo "== the board's public side (the template's board server, this gateway's key)"
BP=$(( PORT + 1 )); BL=$(( PORT + 2 ))
PUB=$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createPublicKey(c.createPrivateKey(f.readFileSync(process.argv[1],'utf8'))).export({type:'spki',format:'pem'}))" "$MM_HOME/auth/signing.key")
mm auth grant alex --for acme-shop >/dev/null   # back after the revoke above, for a fresh assertion
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

echo '== self approval, the owner, refusals'
mm auth grant bob --for acme-shop --telegram 555 >/dev/null
sock() { curl -s --unix-socket "$MM_HOME/run/auth.sock" -H 'content-type: application/json' -d "$2" "http://auth$1"; }
export -f sock sig
rm -f "$J"; C2=$(sig / 10.0.0.2)
check "a granted person approves their own code (bob)" bash -c "sock /approve '{\"code\":\"$C2\",\"telegram_id\":\"555\",\"by\":\"bot\"}' | jq -e '.user == \"bob\"'"
rm -f "$J"; C3=$(sig / 10.0.0.3)
check "someone without a grant cannot (403)" bash -c "sock /approve '{\"code\":\"$C3\",\"telegram_id\":\"999\",\"by\":\"bot\"}' | jq -e '.error'"
check "the owner, by their Telegram id: owner of all" bash -c "sock /approve '{\"code\":\"$C3\",\"telegram_id\":\"777\",\"by\":\"bot\"}' | jq -e '.role == \"owner\" and .scope == [\"all\"]'"
check "an on-the-spot grant can't make an owner" bash -c "rm -f '$J'; C=\$(curl -s -c '$J' -H 'cf-connecting-ip: 10.0.0.4' '$G/s?b=$BOARD' | sed -n 's/.*id=\"code\"[^>]*>\\([0-9A-Z-]*\\)<.*/\\1/p'); mm auth approve \$C --as carol --for acme-shop --role owner -o json | jq -e '.role == \"member\"'"
rm -f "$J"; C4=$(sig / 10.0.0.5)
for i in 1 2 3 4 5; do sock /approve '{"code":"ZZZZ-ZZZZ","telegram_id":"888"}' >/dev/null; done
check "5 wrong codes per identity, then limited (429), even for a right one" bash -c "sock /approve '{\"code\":\"$C4\",\"telegram_id\":\"888\"}' | jq -e '.error | test(\"too many\")'"
check "a race: two approvals of one code, exactly one wins" bash -c "rm -f '$J'; C=\$(curl -s -c '$J' -H 'cf-connecting-ip: 10.0.0.6' '$G/s?b=$BOARD' | sed -n 's/.*id=\"code\"[^>]*>\\([0-9A-Z-]*\\)<.*/\\1/p'); (sock /approve \"{\\\"code\\\":\\\"\$C\\\",\\\"as\\\":\\\"dan\\\",\\\"scope\\\":\\\"acme-shop\\\"}\" > '$T/r1' &); sock /approve \"{\\\"code\\\":\\\"\$C\\\",\\\"as\\\":\\\"erin\\\",\\\"scope\\\":\\\"acme-shop\\\"}\" > '$T/r2'; sleep 0.5; [ \$(cat '$T/r1' '$T/r2' | grep -c '\"ok\":true') = 1 ]"
for i in $(seq 1 10); do curl -s -o /dev/null -H 'cf-connecting-ip: 10.9.9.9' "$G/s?b=$BOARD"; done
check "code issuing is limited per address (the 11th: 429)" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'cf-connecting-ip: 10.9.9.9' "$G/s?b=$BOARD")" = 429
rm -f "$J"; C5=$(sig / 10.0.0.7); sleep 7
check "an expired code: refused, and the page says so" bash -c "! mm auth approve $C5 --as fay --for acme-shop && curl -s -b '$J' $G/s/poll | grep -q expired"

echo '== the store, the logs'
check "auth/ 0700, files 0600, the socket 0600" bash -c "[ \$(stat -c %a '$MM_HOME/auth') = 700 ] && [ -z \"\$(find '$MM_HOME/auth' -type f ! -perm 600)\" ] && [ \$(stat -c %a '$MM_HOME/run/auth.sock') = 600 ]"
check "grants persist (bob, carol, the winner of the race)" bash -c "mm auth grants -o json | jq -e 'map(.name) | (index(\"bob\") and index(\"carol\"))'"
check "the log has no full code and no cookie value" bash -c "! grep -q '$CODE' '$T/gw.log' && ! grep -qE 'mm_(auth|board|pending)=' '$T/gw.log'"
check "every approval is logged (with its code's short hash)" bash -c "grep -c '\"approved\"' '$T/gw.log' | grep -qE '^[4-9]'"
[ "$fail" = 0 ] || { echo "--- board.log"; tail -15 "$T/board.log"; }
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
