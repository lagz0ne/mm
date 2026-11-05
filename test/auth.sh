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
T=$(mktemp -d); GW=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_AUTH_LINK_S=600
unset PASEO_AGENT_ID PASEO_AGENT_CWD
mkdir -p "$MM_HOME/pc/projects" "$T/proj/.run" "$T/proj2/.run"
PORT=$(( 39100 + RANDOM % 800 )); BOARD=board-shop-acme.example.org; AUTH=auth.example.org; BOARD2=board-other-acme.example.org
printf 'domain: example.org\naccess: domain\nauth_port: %s\nbind_host: 127.0.0.1\nowner_name: boss\n' "$PORT" >"$MM_HOME/config.yaml"
echo "# from $T/proj/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"; echo "# from $T/proj2/services.yaml" >"$MM_HOME/pc/projects/acme-other.yaml"
echo "{\"project\":\"acme-shop\",\"services\":{\"board\":{\"public_url\":\"https://$BOARD\",\"public\":{\"name\":\"board-shop-acme\",\"auth\":\"required\"}}}}" >"$T/proj/.run/services.json"
echo "{\"project\":\"acme-other\",\"services\":{\"board\":{\"public_url\":\"https://$BOARD2\",\"public\":{\"name\":\"board-other-acme\",\"auth\":\"required\"}}}}" >"$T/proj2/.run/services.json"
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
export PATH="$T/bin:$PATH"   # every check, including those in sh -c, runs this mm
mm auth serve >"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/s" && break; sleep 0.2; done
G="http://127.0.0.1:$PORT"
# the browser on the gateway's host: the session cookie is __Secure- (https), so curl gets it by hand here
gw() { curl -s -H "x-forwarded-host: $AUTH" -H 'x-forwarded-proto: https' "$@"; }
sess() { sed -n 's/^set-cookie: \(__Secure-better-auth\.session_token=[^;]*\).*/\1/ip' "$1" | tail -1; }
link_of() { mm user link "$1" -o json | jq -r .link; }
open_link() { local p=${1#https://$AUTH}; gw -D "$2" -o /dev/null "$G$p"; }
export -f gw sess; export G AUTH BOARD BOARD2 T MM_HOME

echo '== people (no password)'
check "the owner: mm user add boss --owner" bash -c "mm user add boss --owner -o json | jq -e '.owner == true'"
check "a second owner: refused" bash -c "! mm user add carol --owner"
check "mm user add alex" bash -c "mm user add alex -o json | jq -e '.name == \"alex\" and .owner == false'"
check "the same name again: refused" bash -c "! mm user add alex"
check "reserved names are refused (the owner's name, steward, bridge, mm, root, ops)" bash -c "for n in boss steward bridge mm root ops sentinel assistant; do ! mm user add \$n || exit 1; done"
check "mm user ls: alex, no grants yet; boss the owner" bash -c "mm user ls -o json | jq -e '(.[] | select(.name==\"alex\") | .grants == \"\") and (.[] | select(.name==\"boss\") | .owner)'"

echo '== a link that works once'
L=$(link_of alex)
check "mm user link alex: a single-use link on the gateway's host" bash -c "echo '$L' | grep -q '^https://$AUTH/api/auth/magic-link/verify?token='"
open_link "$L" "$T/h1"; S1=$(sess "$T/h1")
check "opening it: a session (Secure, HttpOnly, host-only: no Domain=) and on to /s/done" bash -c "[ -n '$S1' ] && grep -i 'set-cookie: __Secure-better-auth.session_token' '$T/h1' | grep -qi httponly && ! grep -i 'set-cookie: __Secure-better-auth.session_token' '$T/h1' | grep -qi 'domain=' && grep -qi '^location: .*/s/done' '$T/h1'"
open_link "$L" "$T/h1b"
check "the same link again: no session" bash -c "[ -z \"\$(sess '$T/h1b')\" ]"
check "/s/done: signed in as alex, no board yet" bash -c "gw -H 'cookie: $S1' $G/s/done | grep -q 'Signed in as <b>alex</b>' && gw -H 'cookie: $S1' $G/s/done | grep -q 'no board yet'"
check "the board before a grant: no way in (the page says ask the owner)" bash -c "gw -D - -o '$T/p0' -H 'cookie: $S1' '$G/s?b=$BOARD&r=/items' | head -1 | grep -q 200 && grep -q 'no access' '$T/p0'"

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

echo '== a link expires'
kill $GW 2>/dev/null; wait $GW 2>/dev/null
MM_AUTH_LINK_S=2 mm auth serve >>"$T/gw.log" 2>&1 & GW=$!
for _ in $(seq 1 100); do [ -S "$MM_HOME/run/auth.sock" ] && curl -s -o /dev/null "$G/s" && break; sleep 0.2; done
LE=$(link_of alex); sleep 3; open_link "$LE" "$T/he"
check "a link opened after its lifetime: no session" bash -c "[ -z \"\$(sess '$T/he')\" ]"

echo '== the store, the logs'
check "auth/ 0700, files 0600 (accounts.db, secret, signing.key), the socket 0600" bash -c "[ \$(stat -c %a '$MM_HOME/auth') = 700 ] && [ -z \"\$(find '$MM_HOME/auth' -type f ! -perm 600)\" ] && [ \$(stat -c %a '$MM_HOME/run/auth.sock') = 600 ]"
TOK=$(echo "$L" | sed 's/.*token=\([^&]*\).*/\1/')
check "the log has no link token, no token, no cookie value" bash -c "! grep -qF '$TOK' '$T/gw.log' && ! grep -qF '$TK' '$T/gw.log' && ! grep -qE 'session_token=|mm_board=' '$T/gw.log'"
check "every sign-in by link and every grant is logged" bash -c "grep -q 'signed in by link' '$T/gw.log' && grep -q '\"granted\"' '$T/gw.log'"
[ "$fail" = 0 ] || { echo "--- gw.log"; tail -8 "$T/gw.log"; echo "--- board.log"; tail -8 "$T/board.log" 2>/dev/null; }
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
