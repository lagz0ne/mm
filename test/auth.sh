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
# acme-shop's Doop is on, behind the gateway on its own host (sy-3yz; its bin/doop-run has the public side)
DOOPH=doop-shop-acme.example.org
printf '  doop:\n    optional: true\n    command: "true"\n    port: http\n    public: { name: doop-shop-acme, auth: required }\n' >>"$T/proj/services.yaml"
echo 'services_on: [doop]' >>"$T/proj/.mm-answers.yaml"; mkdir -p "$T/proj/bin"; echo ': "${DOOP_PUBLIC_PORT:-}"' >"$T/proj/bin/doop-run"
# the projects' roles as the gateway knows them (leads/roles.json in each project's folder; the home card's role id)
mkdir -p "$T/proj/leads" "$T/proj2/leads"; echo '{"roles":[{"id":"ops"},{"id":"code"}]}' >"$T/proj/leads/roles.json"
echo '{"roles":[{"id":"review"},{"id":"platform"},{"id":"Bad Id"}]}' >"$T/proj2/leads/roles.json"
# the system board, a project like the others; only the owner holds a role on it (the home page: sy-ukbz)
fakeproj "$T/sys" system system; echo "# from $T/sys/services.yaml" >"$MM_HOME/pc/projects/system.yaml"; SYSB=system.example.org
# each board's public port, from the host's own copy (as for a box): the board's gated side listens there, and the
# gateway's home page asks it there, the same address the router gets
BP=$(( PORT + 1 )); FBP=$(( PORT + 4 )); SYP=$(( PORT + 5 ))
for pp in "acme-shop $BP" "acme-other $FBP" "system $SYP"; do read -r pj pn <<<"$pp"; mkdir -p "$MM_HOME/box/$pj"; printf '{"services":{"board":{"public_port":%s}}}' "$pn" >"$MM_HOME/box/$pj/ports.json"; done
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
# what a real browser sends with the Continue form's POST: our pages are no-referrer, so Origin is null, and the
# browser says same-origin in Sec-Fetch-Site (sy-9tbm)
open_link() { gw -D "$2" -o /dev/null -H 'origin: null' -H 'sec-fetch-site: same-origin' -d "t=$(qs "$1" token)&c=$(qs "$1" callbackURL)" "$G/s/l"; }
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
check "...Origin null with no Sec-Fetch-Site, or a cross-site or same-site one (even with this host's Origin): refused, the link stays unused (sy-9tbm)" bash -c "p='t=$(qs "$L" token)&c=/s/done'; [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: null' -d \"\$p\" $G/s/l)\" = 403 ] && [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: null' -H 'sec-fetch-site: cross-site' -d \"\$p\" $G/s/l)\" = 403 ] && [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: https://$AUTH' -H 'sec-fetch-site: same-site' -d \"\$p\" $G/s/l)\" = 403 ] && [ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: null' -H 'sec-fetch-site: none' -d \"\$p\" $G/s/l)\" = 403 ]"
check "...a foreign Origin is refused even with Sec-Fetch-Site same-origin (review sy-9tbm #1)" bash -c "[ \"\$(gw -o /dev/null -w '%{http_code}' -H 'origin: https://evil.example' -H 'sec-fetch-site: same-origin' -d 't=$(qs "$L" token)&c=/s/done' $G/s/l)\" = 403 ]"
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
check "/s/done lists the board (through the one-redirect flow)" bash -c "gw -H 'cookie: $S1' $G/s/done | grep -q '/s?b=$BOARD&amp;r=%2F'"
curl -s -c "$T/bj" -H "x-forwarded-host: $BOARD" -H 'sec-fetch-site: cross-site' -D "$T/h3" -o "$T/b3" "$G$CB"
check "the callback sets the board's own cookie (Strict, host-only)" bash -c "grep -i 'set-cookie: mm_board=' '$T/h3' | grep -qi 'SameSite=Strict' && ! grep -i 'set-cookie: mm_board=' '$T/h3' | grep -qi 'domain='"
# sy-wbdn: a sign-in begun by a tap in another app (Telegram) is a cross-site chain; a 302 from here would go back to
# /items without the Strict cookie and loop. So the callback answers 200 with a page on the board that moves on.
check "...and answers 200 with a page on the board, not a 302 (no cross-site redirect for the Strict cookie to miss)" bash -c "head -1 '$T/h3' | grep -q ' 200' && ! grep -qi '^location:' '$T/h3'"
check "...the page moves on to /items itself (meta refresh, no script) and has the link too" bash -c "grep -qF '<meta http-equiv=\"refresh\" content=\"0;url=/items\">' '$T/b3' && grep -qF '<a href=\"/items\">Open the board</a>' '$T/b3' && ! grep -qi '<script' '$T/b3'"
check "...with the same headers as before (CSP, no-store, nosniff, no referrer)" bash -c "grep -qi \"^content-security-policy: default-src 'self'\" '$T/h3' && grep -qi '^cache-control: no-store' '$T/h3' && grep -qi '^x-content-type-options: nosniff' '$T/h3' && grep -qi '^referrer-policy: no-referrer' '$T/h3'"
cbfor() { gw -D - -o /dev/null -H "cookie: $S1" "$G/s?b=$BOARD&r=$1" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip'; }
CBQ=$(cbfor '%2F%3Fq%3D%22%3E%3Cb%3Ex')
curl -s -H "x-forwarded-host: $BOARD" -o "$T/bq" "$G$CBQ"
check "...the way back stays text in the page (a quote and markup in it: encoded, never markup)" bash -c "grep -qF 'url=/?q=%22%3E%3Cb%3Ex\"' '$T/bq' && ! grep -qF '<b>x' '$T/bq'"
# review sy-ua5q: browsers read '\' as '/' and drop tab and newline, so these would leave the host after sign-in
backof() { curl -s -D - -o /dev/null -H "x-forwarded-host: $BOARD" -H "x-forwarded-uri: $1" "$G/verify" | sed -n 's/^location: .*[?&]r=\([^&[:space:]]*\).*/\1/ip'; }
export -f backof
check "the way back never leaves the host: /\\\\evil, /%5Cevil (as sent), /<tab>/evil, //evil, /\\\\/evil all become /" bash -c "for r in '/\\evil.example' '/\\\\evil.example' \$'/\\t/evil.example' '//evil.example' '/\\/evil.example'; do [ \"\$(backof \"\$r\")\" = '%2F' ] || { echo \"\$r -> \$(backof \"\$r\")\"; exit 1; }; done"
check "...a plain path with a query and a fragment stays as it is" bash -c "[ \"\$(backof '/items?x=1#top')\" = '%2Fitems%3Fx%3D1%23top' ]"
check "...dot segments that the parser turns into '//' (/.//evil, /..//evil, /x/..//evil, /%2e//evil): / (review sy-ua5q #2)" bash -c "for r in '/.//evil.example' '/..//evil.example' '/x/..//evil.example' '/%2e//evil.example'; do [ \"\$(backof \"\$r\")\" = '%2F' ] || { echo \"\$r -> \$(backof \"\$r\")\"; exit 1; }; done"
cat >"$T/back.ts" <<EOF
import { safeBack } from '$SRC/src/auth'
const bad = ['/\\\\evil.example', '/\\\\\\\\evil.example', '/\t/evil.example', '/\n/evil.example', '//evil.example', '/\\\\/evil.example',
  '/.//evil.example', '/..//evil.example', '/x/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example', 'evil.example', '', null]
const good: [string, string][] = [['/items?x=1#top', '/items?x=1#top'], ['/?item=sy-1', '/?item=sy-1'], ['/%5Cevil.example', '/%5Cevil.example'], ['/a/./b/../c', '/a/c']]
const wrong = [...bad.filter((r) => safeBack(r) !== '/').map((r) => JSON.stringify(r) + ' -> ' + safeBack(r)),
  ...good.filter(([r, w]) => safeBack(r) !== w).map(([r, w]) => JSON.stringify(r) + ' -> ' + safeBack(r) + ', want ' + w)]
if (wrong.length) { console.log(wrong.join('\n')); process.exit(1) }
EOF
check "safeBack on its own: every bad form (newline too) gives /, good paths stay (dot segments resolved)" bash -c "cd '$T' && PATH=\"$HOME/.bun/bin:\$PATH\" bun '$T/back.ts'"
echo '== a sign-in loop stops (sy-wbdn)'
# the sessions above count: after 3 board sessions in 10 s for this person and host, no new one is made
for i in 1 2 3; do curl -s -H "x-forwarded-host: $BOARD" -D "$T/hl$i" -o "$T/bl$i" "$G$(cbfor %2Fitems)"; done
check "a 3rd board session in 10 s for the same person and host: no new cookie, no refresh, the link only" bash -c "! grep -qi '^set-cookie: mm_board=' '$T/hl3' && head -1 '$T/hl3' | grep -q ' 200' && ! grep -qi 'http-equiv' '$T/bl3' && grep -qF '<a href=\"/items\">Open the board</a>' '$T/bl3'"
check "...and the gateway logs it (no cookie value in the log)" bash -c "grep -q 'board session loop stopped' '$T/gw.log'"
sleep 11 # out of the loop window again, for the callbacks below
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
CBD=$(gw -D - -o /dev/null -H "cookie: $S1" "$G/s?b=$DOOPH&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
curl -s -c "$T/bjd" -H "x-forwarded-host: $DOOPH" -o /dev/null "$G$CBD"
check "the project's Doop on its own host (sy-3yz): the same session opens it, and its assertion names that host, alex, designer" bash -c "node '$T/verify.mjs' \"\$(curl -s -D - -o /dev/null -b '$T/bjd' -H 'x-forwarded-host: $DOOPH' $G/verify | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' '$DOOPH' alex designer"
check "...the board's cookie does not open the Doop host (302: its own callback first)" bash -c "v $DOOPH | head -1 | grep -q 302"
mm grant alex acme-shop >/dev/null
check "...the role follows the grant: member on the Doop host too" bash -c "node '$T/verify.mjs' \"\$(curl -s -D - -o /dev/null -b '$T/bjd' -H 'x-forwarded-host: $DOOPH' $G/verify | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' '$DOOPH' alex member"
check "...and the home page has one card for acme-shop: its board's link, never its Doop's" bash -c "gw -H 'cookie: $S1' $G/s/done >'$T/hd'; grep -q '/s?b=$BOARD&amp;r=%2F' '$T/hd' && ! grep -q '$DOOPH' '$T/hd'"

echo '== the owner'
LB=$(link_of boss); open_link "$LB" "$T/hb"; SB=$(sess "$T/hb")
CBB=$(gw -D - -o /dev/null -H "cookie: $SB" "$G/s?b=$BOARD2&r=/" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
curl -s -c "$T/bjb" -H "x-forwarded-host: $BOARD2" -o /dev/null "$G$CBB"
check "the owner opens any board with no grant (acme-other), as owner" bash -c "node '$T/verify.mjs' \"\$(curl -s -D - -o /dev/null -b '$T/bjb' -H 'x-forwarded-host: $BOARD2' $G/verify | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' '$BOARD2' boss owner"
check "a grant to the owner is refused (owner everywhere already)" bash -c "! mm grant boss acme-shop"
# the system board: owner only, ever (sy-qq61): any role there can steer ops
check "a grant on the system board is refused in the terminal, and it says why" bash -c "! mm grant alex system >'$T/sg.out' 2>&1 && grep -q 'the system board' '$T/sg.out'"
check "...as designer or viewer too" bash -c "! mm grant alex system --as designer >/dev/null 2>&1 && ! mm grant alex system --as viewer >/dev/null 2>&1"
check "...and through the socket the bridge uses (403)" bash -c "[ \"\$(curl -s --unix-socket '$MM_HOME/run/auth.sock' -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{\"name\":\"alex\",\"project\":\"system\",\"by\":\"bridge\"}' http://mm/grant)\" = 403 ]"
check "...nothing was made for it (no system organization, alex's grants unchanged)" bash -c "mm user ls -o json | jq -e '.[] | select(.name==\"alex\") | (.grants | test(\"system\") | not)'"

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
# the machine's naming rule (sy-b15.3): under names: project a board is <project>.<domain>; the gate follows it
cp "$MM_HOME/config.yaml" "$T/config.legacy"; printf 'names: project\n' >>"$MM_HOME/config.yaml"; sleep 0.5
NB=acme-shop.example.org; NB2=acme-other.example.org
check "names: project: alex's token opens $NB, as member; the old host $BOARD is refused (401)" bash -c "node '$T/verify.mjs' \"\$(bv '$TK' $NB | sed -n 's/^x-mm-assertion: \\(.*\\)\\r\$/\\1/ip')\" '$MM_HOME/auth/signing.key' $NB alex member && bv '$TK' | head -1 | grep -q 401"
check "...bob's token opens $NB2, not $NB" bash -c "bv '$TKB' $NB2 | head -1 | grep -q 200 && bv '$TKB' $NB | head -1 | grep -q 401"
check "...no cookie on $NB: sent to sign in for that host" bash -c "curl -s -D - -o /dev/null -H 'x-forwarded-host: $NB' $G/verify | grep -qi '^location: https://$AUTH/s?b=$NB&'"
cp "$T/config.legacy" "$MM_HOME/config.yaml"; sleep 0.5
check "names back to legacy (the rollback): $BOARD again, $NB refused" bash -c "bv '$TK' | head -1 | grep -q 200 && bv '$TK' $NB | head -1 | grep -q 401"
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
// the open list (what /api/summary counts): an item title with a script in it, that must never leave the board
const LIST = [
  { id: 'it-1', title: '<script>alert(1)</script>', status: 'open', priority: 0, assignee: 'alex', labels: ['needs-you'], updated_at: '2026-11-05T09:00:00Z',
    description: '## Owner\n- **What:** Fix the page.\n- **Why:** It shows a script.\n- **You:** Check: the <i>page</i>, on the board\n\nThe thread.' },
  { id: 'it-2', title: 'b', status: 'blocked', priority: 2, assignee: 'ops', labels: [], updated_at: '2026-11-05T10:00:00Z' },
  { id: 'it-3', title: 'c', status: 'in_progress', priority: 0, assignee: 'alex', labels: ['t2', 'signed-off'], updated_at: '2026-11-04T10:00:00Z' },
  { id: 'it-4', title: 'd', status: 'open', priority: 3, assignee: 'bob', labels: ['t2', 'signed-off', 'approved'], updated_at: '2026-11-03T10:00:00Z' },
  { id: 'it-5', title: 'e', status: 'closed', priority: 0, assignee: 'alex', labels: ['needs-you'], updated_at: '2026-11-06T10:00:00Z' },
]
// bd ready (the queues, for the worst signal; sy-6h43): ops' head has waited 40 min, a person's item is no role's queue
const READY = [
  { id: 'it-6', title: '<b>queued</b>', status: 'open', priority: 1, assignee: 'ops', labels: [], updated_at: new Date(Date.now() - 40 * 60e3).toISOString() },
  { id: 'it-7', title: 'g', status: 'open', priority: 2, assignee: 'ops', labels: [], updated_at: new Date(Date.now() - 5 * 60e3).toISOString() },
  { id: 'it-8', title: 'h', status: 'open', priority: 1, assignee: 'alex', labels: [], updated_at: '2026-11-01T10:00:00Z' },
]
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  fs.appendFileSync(logf, JSON.stringify({ m: req.method, p: req.url, b: b ? JSON.parse(b) : null }) + '\n')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(req.method === 'GET' && /\/issues\/it-1(\?|$)/.test(req.url) ? { id: 'it-1', labels: ['t2', 'bug', 'signed-off'] }
    : req.method === 'GET' && /\/issues\/it-9(\?|$)/.test(req.url) ? { id: 'it-9', labels: ['t2', 'bug'] }
    : req.method === 'GET' && /\/issues\/it-10(\?|$)/.test(req.url) ? { id: 'it-10', labels: ['bug'] }
    : req.method === 'GET' && /\/issues\/it-3(\?|$)/.test(req.url) ? { id: 'it-3', status: 'in_progress', labels: ['t2', 'signed-off'] }
    : req.method === 'GET' && /^\/v0\/beads\/issues(\?|$)/.test(req.url) ? { items: LIST, has_more: false }
    : req.method === 'GET' && /^\/v0\/beads\/ready(\?|$)/.test(req.url) ? { items: READY, has_more: false } : { ok: true, items: [] }))
}) }).listen(Number(port), '127.0.0.1')
EOF
node "$T/fakebd.mjs" $BDP "$T/bd.jsonl" & FB=$!
mkdir -p "$T/board" && (cd "$SRC/template" && tar -cf - --exclude=node_modules --exclude=dist site bin leads) | tar -xf - -C "$T/board"   # a copy: the board writes .run/ where it runs
mkdir -p "$T/board/.run" && printf '{"owner_name": "dana"}\n' >"$T/board/.run/endpoints.json"   # mm writes it (the owner's name: reserved on the local side)
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
check "a member can add an ordinary label" test "$(w PATCH "$MA" /it-1 '{"patch":{"labels":["t2","bug","urgent","signed-off"]}}')" = 200
check "a member can assign and close (steering)" bash -c "[ \$(w PATCH '$MA' /it-1 '{\"patch\":{\"assignee\":\"ops\"}}') = 200 ] && [ \$(w POST '$MA' /it-1:close '{}') = 200 ]"
check "an unknown label field: refused (403)" test "$(w PATCH "$MA" /it-1 '{"patch":{"label_set":["approved"]}}')" = 403
check "a member can't fake the author role label (403)" test "$(w POST "$MA" '' '{"title":"x","labels":["by:owner"]}')" = 403
check "the owner gives the T2 go (add approved)" test "$(w PATCH "$OA" /it-1 '{"patch":{"add_labels":["approved"]}}')" = 200
# sy-l9uc (review's sy-16ml #2): the go comes after review's sign-off, on the board as on Telegram
check "...but not on a t2 item review has not signed off (403, says why)" bash -c "[ \$(w PATCH '$OA' /it-9 '{\"patch\":{\"add_labels\":[\"approved\"]}}') = 403 ] && jq -e '.title | test(\"review has not signed it off yet\")' '$T/wb'"
check "...nor by adding t2 and approved together to an item with no sign-off (403)" test "$(w PATCH "$OA" /it-10 '{"patch":{"add_labels":["t2","approved"]}}')" = 403
check "...nor on a new t2 item (403)" test "$(w POST "$OA" '' '{"title":"x","labels":["t2","approved"]}')" = 403
check "...an item with no tier may get approved (200)" test "$(w PATCH "$OA" /it-10 '{"patch":{"add_labels":["approved"]}}')" = 200
check "the owner changes a tier" test "$(w PATCH "$OA" /it-1 '{"patch":{"labels":["t1","bug","signed-off"]}}')" = 200
check "not even the owner signs off for review (403)" test "$(w PATCH "$OA" /it-1 '{"patch":{"add_labels":["signed-off"]}}')" = 403
check "a comment carries its author's role" bash -c "[ \$(w POST '$MA' /it-1/comments '{\"text\":\"looks good\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.text == \"[member] looks good\" and .b.author == \"alex\"'"
check "...and its author is the signed-in person, whatever the body says" bash -c "[ \$(w POST '$MA' /it-1/comments '{\"text\":\"x\",\"author\":\"owner\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.author == \"alex\"'"
check "the owner's approved on the public side goes to the board as the owner's signed name (what the Supervisor counts)" bash -c "[ \$(w PATCH '$OA' /it-1 '{\"patch\":{\"add_labels\":[\"approved\"]},\"actor\":\"bridge\"}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.actor == \"boss\" and .b.patch.add_labels == [\"approved\"]'"

echo "== the local side never changes approved (sy-h2yt: a self-chosen name says nothing signed)"
lw() { curl -s -o "$T/wb" -w '%{http_code}' -X "$1" -H 'content-type: application/json' -H "cookie: board_user=${4:-boss}" -d "$3" "http://127.0.0.1:$BL/api/v0/beads/issues$2"; }
export -f lw; export BL T
n0=$(wc -l <"$T/bd.jsonl")
check "local side: adding approved is refused (403), even under the owner's name" test "$(lw PATCH /it-1 '{"patch":{"add_labels":["approved"]}}')" = 403
check "...and it says where the owner approves" grep -q 'public address, or with the bridge' "$T/wb"
check "...by a full label set (403)" test "$(lw PATCH /it-1 '{"patch":{"labels":["t2","bug","approved"]}}')" = 403
check "...removing it (403)" test "$(lw PATCH /it-1 '{"patch":{"remove_labels":["approved"]}}')" = 403
check "...on a new item (403)" test "$(lw POST '' '{"title":"x","labels":["t2","approved"]}')" = 403
check "...through a label field it does not know (403)" test "$(lw PATCH /it-1 '{"patch":{"set_labels":["approved"]}}')" = 403
check "...nothing of it reached bd (only reads)" bash -c "tail -n +$((n0 + 1)) '$T/bd.jsonl' | jq -e -s 'length > 0 and all(.m == \"GET\")'"
check "...each refusal is logged" bash -c "grep -c 'refused on the local side' '$T/board/.run/logs/ops.log' | grep -qx 5"
check "local side: other labels as before (200, no author role label)" bash -c "[ \$(lw PATCH /it-1 '{\"patch\":{\"add_labels\":[\"urgent\"]}}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.patch.add_labels == [\"urgent\"] and .b.actor == \"boss\"'"
check "...a new item with a tier, a full label set without approved (200)" bash -c "[ \$(lw POST '' '{\"title\":\"x\",\"labels\":[\"t2\"]}') = 200 ] && [ \$(lw PATCH /it-1 '{\"patch\":{\"labels\":[\"t2\",\"bug\",\"urgent\"]}}') = 200 ]"
check "a self-chosen name can't be the bridge's (400)" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"name":"bridge"}' "http://127.0.0.1:$BL/api/whoami")" = 400
check "...nor the owner's, whose approved counts (400; sy-1jmi)" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"name":"dana"}' "http://127.0.0.1:$BL/api/whoami")" = 400
check "...and a board_user cookie with the owner's name is nobody (source default)" bash -c "curl -s -H 'cookie: board_user=dana' http://127.0.0.1:$BL/api/whoami | jq -e '.source == \"default\"'"

echo "== the owner's web Approve with the ledger on: sent to the bridge's socket, signs and writes nothing (sy-4py1)"
# a second board whose approval config is a test path (MM_APPROVE_CONF, honored by ledger.mjs only while
# /etc/mm-approve.conf is absent, as mm-approve.sh and the verifier tests use it); a stub bridge on a unix socket
# records each request. The board reads the config on every request, so the cases below rewrite it.
[ -e /etc/mm-approve.conf ] && echo "  (skip: /etc/mm-approve.conf exists, the test config would not be read)" || {
BAL=$(( PORT + 10 )); BAP=$(( PORT + 11 )); mkdir -p "$T/br"; SOCK="$T/br/bridge.sock"; ACONF="$T/aconf"
cat >"$T/fakebridge.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [sock, out, modef] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  fs.appendFileSync(out, JSON.stringify({ m: req.method, p: req.url, a: req.headers['x-mm-assertion'] || null, keys: Object.keys(req.headers).sort(), b }) + '\n')
  const mode = fs.existsSync(modef) ? fs.readFileSync(modef, 'utf8').trim() : 'ok'
  res.writeHead(mode === 'ok' ? 200 : 429, { 'content-type': 'application/json' })
  res.end(JSON.stringify(mode === 'ok' ? { ok: true } : { title: 'one live offer for this item: the same offer was sent again' }))
}) }).listen(sock)
EOF
node "$T/fakebridge.mjs" "$SOCK" "$T/br.jsonl" "$T/br.mode" & FBR=$!
aconf() { printf 'verifier = %s\nuser = %s\ndir = %s/al\npublic_key = %s/al.pub\n%s' "$1" "$(id -un)" "$T" "$T" "${2:+bridge_socket = $2
}" >"$ACONF"; }
aconf ledger "$SOCK"
(cd "$T/board" && PORT=$BAL BOARD_PUBLIC_PORT=$BAP BD_SERVE=http://127.0.0.1:$BDP MM_AUTH_PUBLIC_KEY="$PUB" MM_APPROVE_CONF="$ACONF" PASEO_NO_SDK=1 PASEO_BIN=false MM_PROJECT=acme-shop \
  exec node site/server.mjs >"$T/board-ledger.log" 2>&1) & BSL=$!
for _ in $(seq 1 150); do [ -S "$SOCK" ] && curl -s -o /dev/null "http://127.0.0.1:$BAL/api/whoami" && curl -s -o /dev/null "http://127.0.0.1:$BAP/" && break; sleep 0.2; done
# POST /api/approve on the ledger board's public side (or, with "local", its local side)
ap() { local u="http://127.0.0.1:$BAP/api/approve" h=(-H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $1" -H "origin: https://$BOARD" -H "sec-fetch-site: same-origin"); [ "$1" = local ] && { u="http://127.0.0.1:$BAL/api/approve"; h=(); }
  curl -s -o "$T/ab" -w '%{http_code}' -X POST -H 'content-type: application/json' "${h[@]}" -d "$2" "$u"; }
lpw() { curl -s -o "$T/ab" -w '%{http_code}' -X PATCH -H 'content-type: application/json' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $1" -d "$2" "http://127.0.0.1:$BAP/api/v0/beads/issues/it-1"; }
lwho() { curl -s -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $1" "http://127.0.0.1:$BAP/api/whoami"; }
brn() { [ -f "$T/br.jsonl" ] && wc -l <"$T/br.jsonl" || echo 0; }
nowrites() { tail -n +$(( $1 + 1 )) "$T/bd.jsonl" | jq -e -s 'all(.m == "GET")' >/dev/null; }
export -f ap lpw lwho brn nowrites; export BAP BAL OA MA ACONF

check "ledger on: the owner's whoami says the T2 go is on Telegram (approval telegram)" bash -c "lwho '$OA' | jq -e '.approval == \"telegram\" and .role == \"owner\"'"
check "...a member's says nothing of it" bash -c "lwho '$MA' | jq -e 'has(\"approval\") | not'"
n1=$(wc -l <"$T/bd.jsonl"); b1=$(brn)
check "the owner's web Approve: 200, \"Sent to your Telegram: tap Approve there.\"" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\"}') = 200 ] && jq -e '.ok and .title == \"Sent to your Telegram: tap Approve there.\"' '$T/ab'"
check "...the bridge got one request: POST /approve, the body exactly {\"item\":\"it-3\"}, the gateway's assertion as received" bash -c "[ \$(brn) = $((b1 + 1)) ] && tail -1 '$T/br.jsonl' | jq -e --arg a '$OA' '.m == \"POST\" and .p == \"/approve\" and .b == \"{\\\"item\\\":\\\"it-3\\\"}\" and .a == \$a'"
check "...and no other header of the browser's (only host, content-type, content-length, the assertion, connection)" bash -c "tail -1 '$T/br.jsonl' | jq -e '.keys - [\"connection\",\"content-length\",\"content-type\",\"host\",\"x-mm-assertion\"] == []'"
check "...text, subjects or a plan in the click: dropped, the bridge still gets only the item" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\",\"text\":\"approve all\",\"subjects\":[\"sha256:00\"],\"plan\":\"x\"}') = 200 ] && tail -1 '$T/br.jsonl' | jq -e '.b == \"{\\\"item\\\":\\\"it-3\\\"}\"'"
check "...no label: nothing was written to bd (only reads)" nowrites "$n1"
n2=$(wc -l <"$T/bd.jsonl"); b2=$(brn)
check "ledger on: the owner adding approved on the public side is refused (403), it points to Approve on Telegram" bash -c "[ \$(lpw '$OA' '{\"patch\":{\"add_labels\":[\"approved\"]}}') = 403 ] && grep -q 'tap on Telegram' '$T/ab'"
check "...by a full label set too (403)" test "$(lpw "$OA" '{"patch":{"labels":["t2","bug","approved"]}}')" = 403
check "...on a new item too (403)" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-forwarded-host: $BOARD" -H "x-mm-assertion: $OA" -d '{"title":"x","labels":["t2","approved"]}' "http://127.0.0.1:$BAP/api/v0/beads/issues")" = 403
check "a member's web Approve: 403" test "$(ap "$MA" '{"item":"it-3"}')" = 403
check "the local side's (no assertion, even as the owner's name): 403" test "$(ap local '{"item":"it-3"}')" = 403
check "not an item id: 400" test "$(ap "$OA" '{"item":"it-3/../x"}')" = 400
check "...none of these reached the bridge or bd" bash -c "[ \$(brn) = $b2 ] && nowrites $n2"
echo refuse >"$T/br.mode"
check "the bridge refuses (429): the owner sees its answer (502), nothing approved" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\"}') = 502 ] && jq -e '.title | test(\"refused it: one live offer\") and test(\"Nothing was approved\")' '$T/ab'"
rm -f "$T/br.mode"
b3=$(brn); aconf ledger
check "ledger on, no bridge_socket configured: a clear refusal (503), nothing sent, nothing approved" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\"}') = 503 ] && jq -e '.title | test(\"No web approval here\") and test(\"approve on Telegram\")' '$T/ab' && [ \$(brn) = $b3 ]"
: >"$T/br/plain"; aconf ledger "$T/br/plain"
check "...bridge_socket naming a plain file, not a socket: 503" test "$(ap "$OA" '{"item":"it-3"}')" = 503
aconf ledger "br/bridge.sock"
check "...a relative bridge_socket: 503" test "$(ap "$OA" '{"item":"it-3"}')" = 503
chmod 777 "$T/br"; aconf ledger "$SOCK"
check "...its folder writable by others (someone could stand in for the bridge): 503" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\"}') = 503 ] && [ \$(brn) = $b3 ]"
chmod 755 "$T/br"
check "...the refusal's reason is in the board's log" grep -q 'web approve of it-3 refused: .*can be changed by others' "$T/board/.run/logs/ops.log"
kill $FBR 2>/dev/null; wait $FBR 2>/dev/null
check "the bridge not running (its socket left behind): 502, nothing approved" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\"}') = 502 ] && jq -e '.title | test(\"not answering\")' '$T/ab'"
check "ledger on, the whole time: no write reached bd" nowrites "$n1"
aconf actor "$SOCK"
check "verifier actor (today): the owner's whoami says approval label" bash -c "lwho '$OA' | jq -e '.approval == \"label\"'"
check "...the owner's approved on the public side goes to bd as before (200, as boss)" bash -c "[ \$(lpw '$OA' '{\"patch\":{\"add_labels\":[\"approved\"]}}') = 200 ] && tail -1 '$T/bd.jsonl' | jq -e '.b.actor == \"boss\" and .b.patch.add_labels == [\"approved\"]'"
b4=$(brn)
check "...and /api/approve adds approved as the owner itself (200, as boss; sy-92sg), nothing to the bridge" bash -c "[ \$(ap '$OA' '{\"item\":\"it-3\"}') = 200 ] && jq -e '.approved' '$T/ab' && grep '\"PATCH\"' '$T/bd.jsonl' | tail -1 | jq -e '.p == \"/v0/beads/issues/it-3\" and .b.actor == \"boss\" and .b.patch.add_labels == [\"approved\"]' && [ \$(brn) = $b4 ]"
aconf ledger "$SOCK"
check "ledger on: a web Approve without the same-origin proof (a form from another site): 403, nothing sent" bash -c "[ \$(curl -s -o '$T/ab' -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-forwarded-host: $BOARD' -H 'x-mm-assertion: $OA' -H 'origin: https://evil.example' -d '{\"item\":\"it-3\"}' http://127.0.0.1:$BAP/api/approve) = 403 ] && [ \$(brn) = $b4 ]"
check "...an item without review's sign-off: 403, nothing sent" bash -c "[ \$(ap '$OA' '{\"item\":\"it-9\"}') = 403 ] && [ \$(brn) = $b4 ]"
rm -f "$ACONF"
check "the test config gone (ledger.mjs reads it as the strict side): the owner's approved is refused, not written" test "$(lpw "$OA" '{"patch":{"add_labels":["approved"]}}')" = 403
kill $BSL 2>/dev/null
}

echo "== the board's summary for the home page (/api/summary: counts only, read-only; sy-ukbz)"
sm() { curl -s -o "$T/sm" -w '%{http_code}' -H "x-forwarded-host: ${2:-$BOARD}" ${1:+-H "x-mm-assertion: $1"} "http://127.0.0.1:$BP/api/summary${3-?signal=1}"; }
export -f sm
check "a member: open, P0, blocked, needs-you, assigned to them, last activity (closed items not counted)" bash -c "[ \$(sm '$MA') = 200 ] && jq -e '{open,p0,blocked,needs_you,mine,last} == {open:4,p0:2,blocked:1,needs_you:1,mine:2,last:\"2026-11-05T10:00:00.000Z\"}' '$T/sm'"
check "...the worst signal (sy-6h43): ops' queue, 2 items, its head waits 40 min; the oldest needs-you in minutes; no approvals (not the owner)" bash -c "sm '$MA' >/dev/null && jq -e '.queue_role == \"ops\" and .queue == 2 and .queue_min >= 40 and .queue_min < 45 and .approvals == 0 and .needs_you_min > 1000' '$T/sm'"
check "...whole numbers and one time only: no item text (a title holds a script)" bash -c "sm '$MA' >/dev/null && ! grep -qi -e script -e alert -e title '$T/sm' && jq -e '([.[] | select(type == \"number\" and . == floor)] | length == 9) and ([to_entries[] | select(.value | type == \"string\") | .key] == [\"last\", \"queue_role\"])' '$T/sm'"
check "the owner: needs-you also counts the signed-off t2 items that wait for approved" bash -c "[ \$(sm '$OA') = 200 ] && jq -e '.needs_you == 2 and .mine == 0 and .open == 4' '$T/sm'"
check "...and says how many of them are approvals (1)" bash -c "sm '$OA' >/dev/null && jq -e '.approvals == 1' '$T/sm'"
check "without ?signal=1 (a gateway on an older mm): only the five counts and the time, as before" bash -c "[ \$(sm '$OA' '' '') = 200 ] && jq -e 'keys == [\"blocked\",\"last\",\"mine\",\"needs_you\",\"open\",\"p0\"]' '$T/sm'"
check "a viewer may read it (200)" test "$(sm "$(mk vic viewer "$BOARD" 60000)")" = 200
check "no assertion: 401; another board's: 401; an expired one: 401" bash -c "[ \$(sm '') = 401 ] && [ \$(sm '$(mk alex member "$BOARD2" 60000)') = 401 ] && [ \$(sm '$(mk alex member "$BOARD" -1000)') = 401 ]"

echo "== the board's \"Waiting for you\" list (/api/waiting: the asking person's items only; sy-vdi8, review sy-6h43 #5)"
wl() { curl -s -o "$T/wl" -w '%{http_code}' -H "x-forwarded-host: ${2:-$BOARD}" ${1:+-H "x-mm-assertion: $1"} "http://127.0.0.1:$BP/api/waiting"; }
export -f wl
check "the owner: the needs-you item and the signed-off t2 without approved, oldest first, only the labels the ask needs" bash -c "[ \$(wl '$OA') = 200 ] && jq -e '[.items[] | [.id, (.labels | join(\",\"))]] == [[\"it-3\",\"t2,signed-off\"],[\"it-1\",\"needs-you\"]] and .more == 0' '$T/wl'"
check "...each entry: id, title, age in whole minutes, labels, you (the owner card's You line, sy-z5lz); nothing else (no assignee, no link)" bash -c "wl '$OA' >/dev/null && jq -e '(keys == [\"items\",\"more\"]) and all(.items[]; (keys == [\"age_min\",\"id\",\"labels\",\"title\",\"you\"]) and (.age_min | type == \"number\" and . == floor and . > 1000))' '$T/wl'"
check "a member (alex): only the open items assigned to alex (not the closed one), with no needs-you label" bash -c "[ \$(wl '$MA') = 200 ] && jq -e '([.items[].id] == [\"it-3\",\"it-1\"]) and all(.items[]; .labels == [])' '$T/wl'"
check "a member with nothing assigned (carol) doesn't see the owner's needs-you items: an empty list" bash -c "[ \$(wl '$(mk carol member "$BOARD" 60000)') = 200 ] && jq -e '.items == [] and .more == 0' '$T/wl'"
check "a viewer may read it (200), and gets only their own (none)" bash -c "[ \$(wl '$(mk vic viewer "$BOARD" 60000)') = 200 ] && jq -e '.items == []' '$T/wl'"
check "no assertion: 401; another board's: 401" bash -c "[ \$(wl '') = 401 ] && [ \$(wl '$(mk boss owner "$BOARD2" 60000)') = 401 ]"

echo "== the home page on the gateway (sy-ukbz): the boards a person holds a role on, with their counts"
# fake boards for acme-other and the system board: they record what the gateway sends, and answer as the mode file says
cat >"$T/fakeboard.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, modef, logf] = process.argv.slice(2)
const GOOD = { open: 3, p0: 1, blocked: 0, needs_you: 2, mine: 1, last: '2026-11-05T10:00:00.000Z' }
http.createServer((req, res) => {
  res.on('error', () => {})
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  // the "Waiting for you" list (sy-vdi8): its own log (<log>.w.jsonl) and mode (<mode>.w); no mode: an older board (404)
  if (req.url.startsWith('/api/waiting')) {
    fs.appendFileSync(logf.replace(/\.jsonl$/, '.w.jsonl'), JSON.stringify({ p: req.url, h: req.headers['x-forwarded-host'] || '', a: req.headers['x-mm-assertion'] || '' }) + '\n')
    let wm = 'older'; try { wm = fs.readFileSync(modef + '.w', 'utf8').trim() } catch {}
    if (wm === 'older' || wm === 'forbid') { res.writeHead(wm === 'older' ? 404 : 403, { 'content-type': 'application/json' }); return res.end('{"title":"Not allowed from the board"}') }
    const nu = (id, title, age_min, labels = ['needs-you'], more = {}) => ({ id, title, age_min, labels, ...more })
    const LIST = [
      nu('ao-1', 'Fix the <script>alert(3)</script> page', 190, ['needs-you'], { you: 'Reply: <b>which</b> page?' }),
      nu('ao-2', 'Approve the push', 20, ['t2', 'signed-off'], { you: null }),
      nu('ao-3', 'plain work', 5, []),
      nu('AO-4', 'DROPCAPS', 5), nu('ao-5"><a href=x', 'DROPQUOTE', 5), nu('ao-6', 'L'.repeat(201), 5), nu('ao-7', 'DROPCTL\u0007bell', 5),
      nu('ao-8', 'DROPLINK', 5, ['needs-you'], { url: 'https://evil.example/x' }), nu('ao-9', 'DROPFRAC', 1.5), nu('ao-10', 'DROPAPPROVED', 5, ['approved']),
      nu('ao-11', 'DROPBIDI \u202e', 5), nu('ao-1', 'DROPDUP', 5), nu('ao-13', '', 5), nu('ao-14', 'DROPAGE', -1), nu('ao-15', 42, 5),
      nu('ao-12', 'T'.repeat(200), 1),
      nu('ao-16', 'DROPYOUBIDI', 5, ['needs-you'], { you: 'Tap \u202eApprove' }), nu('ao-17', 'DROPYOULONG', 5, ['needs-you'], { you: `Reply: ${'y'.repeat(154)}` }),
      nu('ao-18', 'DROPYOUNUM', 5, ['needs-you'], { you: 5 }), nu('ao-19', 'DROPYOUEMPTY', 5, ['needs-you'], { you: '' }),
    ]
    if (wm === 'list') return json({ items: LIST, more: 0 })
    if (wm === 'more') return json({ items: LIST.slice(0, 2), more: 7 })
    if (wm === 'empty') return json({ items: [] })
    if (wm === 'extra') return json({ items: LIST, link: 'https://evil.example/' })
    if (wm === 'big') return json({ items: Array.from({ length: 300 }, (_, k) => nu(`ao-${100 + k}`, `BIG ${'b'.repeat(150)}`, k)) }) // about 60 KB
    return json({ items: 'nope' })
  }
  fs.appendFileSync(logf, JSON.stringify({ p: req.url, h: req.headers['x-forwarded-host'] || '', a: req.headers['x-mm-assertion'] || '' }) + '\n')
  let mode = 'good'; try { mode = fs.readFileSync(modef, 'utf8').trim() } catch {}
  if (mode === 'hang') return
  if (mode === 'redirect') { res.writeHead(302, { location: `http://127.0.0.1:${port}/followed` }); return res.end() }
  if (mode === 'big') { // 10 MB, chunked (no length up front)
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"open":1,"pad":"'); let n = 0
    const more = () => { while (n < 160) { n++; if (!res.write(' '.repeat(65536))) return res.once('drain', more) } res.end('"}') }
    return more()
  }
  if (mode === 'script') return json({ ...GOOD, last: '<script>alert(1)</script>' })
  if (mode === 'extra') return json({ ...GOOD, title: '<script>alert(2)</script>' })
  if (mode === 'badnum') return json({ ...GOOD, open: 1e7, p0: 1.5 })
  if (mode === 'sys') return json({ open: 7, p0: 0, blocked: 0, needs_you: 0, mine: 0 })
  // the worst signal (sy-6h43): numbers and one role id
  const SIG = { ...GOOD, needs_you: 0, needs_you_min: 0, approvals: 0, queue: 3, queue_min: 40, queue_role: 'review' }
  if (mode === 'queue') return json(SIG)
  if (mode === 'hot') return json({ ...SIG, needs_you: 2, approvals: 1, needs_you_min: 190 })
  if (mode === 'approval') return json({ ...SIG, needs_you: 1, approvals: 1, needs_you_min: 20 })
  if (mode === 'clear') return json({ ...SIG, blocked: 0, queue: 0, queue_min: 0, queue_role: undefined })
  if (mode === 'badrole') return json({ ...SIG, queue_role: 'qa' })
  if (mode === 'oddrole') return json({ ...SIG, queue_role: 'Review' })
  if (mode === 'htmlrole') return json({ ...SIG, queue_role: '<b>review</b>' })
  if (mode === 'longrole') return json({ ...SIG, queue_role: 'r'.repeat(40) })
  if (mode === 'badsig') return json({ ...SIG, queue_min: 1.5 })
  json(GOOD)
}).listen(Number(port), '127.0.0.1')
EOF
echo good >"$T/fb2.mode"; echo sys >"$T/sys.mode"; : >"$T/fb2.jsonl"; : >"$T/sys.jsonl"
node "$T/fakeboard.mjs" $FBP "$T/fb2.mode" "$T/fb2.jsonl" & FB2=$!
node "$T/fakeboard.mjs" $SYP "$T/sys.mode" "$T/sys.jsonl" & FS=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$FBP/" && curl -s -o /dev/null "http://127.0.0.1:$SYP/" && break; sleep 0.1; done
: >"$T/fb2.jsonl"; : >"$T/sys.jsonl"
LA=$(link_of alex); open_link "$LA" "$T/ha"; SA=$(sess "$T/ha")
hp() { gw -D "$T/hh" -o "$T/hp" -w '%{time_total}' -H "cookie: $1" "$G/"; }
cardof() { tr '\n' ' ' <"$T/hp" | sed 's#</section>#\n#g' | grep -F "<h2>$1</h2>"; }
cards() { grep -c '<section class="card">' "$T/hp"; }
nreq() { cat "$T/fb2.jsonl" "$T/sys.jsonl" | wc -l; }
# the page without the "Waiting for you" list (sy-vdi8: item titles leave a board only there, escaped)
cardsonly() { sed '/<section class="waiting"/,/<\/section>/d' "$T/hp"; }
export -f hp cardof cards nreq cardsonly; export SA SB SYSB BOARD2
check "GET / with no session: the sign-in page (302 to /s)" bash -c "gw -D - -o /dev/null $G/ | grep -qiE '^location: /s[[:space:]]*\$'"
check "/s signed in, no board asked: to the home page" bash -c "gw -D - -o /dev/null -H 'cookie: $SA' $G/s | grep -qiE '^location: /[[:space:]]*\$'"
N0=$(nreq); hp "$SA" >/dev/null
check "a member of acme-shop sees one card: acme-shop, member, its board's counts and last activity" bash -c "[ \$(cards) = 1 ] && cardof acme-shop | grep -q 'You are <b>member</b>' && cardof acme-shop | grep -q '<dt>Open</dt><dd>4</dd>' && cardof acme-shop | grep -q '<dt>Needs you</dt><dd>1</dd>' && cardof acme-shop | grep -q '<dt>Mine</dt><dd>2</dd>' && cardof acme-shop | grep -q 'Last activity: 2026-11-05 10:00 UTC'"
check "...not even the name of what alex isn't granted (acme-other, system), and those boards were never asked" bash -c "! grep -q -e acme-other -e '$BOARD2' -e system '$T/hp' && [ \$(nreq) = '$N0' ]"
check "...no item text from the board in the cards (a title holds a script), no script on the page" bash -c "! grep -qi '<script' '$T/hp' && ! cardsonly | grep -qi alert"
check "...the board link goes through the one-redirect flow (straight to the board's callback)" bash -c "cardof acme-shop | grep -qF 'href=\"/s?b=$BOARD&amp;r=%2F\"' && gw -D - -o /dev/null -H 'cookie: $SA' '$G/s?b=$BOARD&r=%2F' | grep -qi '^location: https://$BOARD/_mm/auth/callback?c='"
check "the page's headers: CSP default-src 'self' + frame-ancestors 'none', no-store, no-referrer, nosniff" bash -c "grep -qi \"^content-security-policy: default-src 'self'; frame-ancestors 'none'\" '$T/hh' && grep -qi '^cache-control: no-store' '$T/hh' && grep -qi '^referrer-policy: no-referrer' '$T/hh' && grep -qi '^x-content-type-options: nosniff' '$T/hh'"
check "/s/done (where a link lands) is the same home page" bash -c "gw -H 'cookie: $SA' $G/s/done | grep -q '<h2>acme-shop</h2>'"
hp "$SB" >/dev/null
check "the owner sees every project and the system board, as owner" bash -c "[ \$(cards) = 3 ] && for p in acme-other acme-shop system; do cardof \$p | grep -q 'You are <b>owner</b>' || exit 1; done"
check "...each with its board's counts (the owner's needs-you counts the signed-off t2s)" bash -c "cardof acme-shop | grep -q '<dt>Needs you</dt><dd>2</dd>' && cardof acme-shop | grep -q '<dt>Mine</dt><dd>0</dd>' && cardof acme-other | grep -q '<dt>Open</dt><dd>3</dd>' && cardof system | grep -q '<dt>Open</dt><dd>7</dd>'"
check "...each board asked once, with its own fresh assertion: this person, this role, that board's host, 60 s" bash -c "[ \$(wc -l <'$T/fb2.jsonl') = 1 ] && [ \$(wc -l <'$T/sys.jsonl') = 1 ] && node '$T/verify.mjs' \"\$(jq -r .a '$T/fb2.jsonl')\" '$MM_HOME/auth/signing.key' '$BOARD2' boss owner && node '$T/verify.mjs' \"\$(jq -r .a '$T/sys.jsonl')\" '$MM_HOME/auth/signing.key' '$SYSB' boss owner && jq -e '.p == \"/api/summary?signal=1\" and .h == \"$BOARD2\"' '$T/fb2.jsonl'"
check "an assertion for one board (acme-other's) replayed to another (acme-shop's): 401" bash -c "[ \$(sm \"\$(tail -1 '$T/fb2.jsonl' | jq -r .a)\") = 401 ]"
check "the projects' .run/services.json (above: claiming each other's hosts and the gateway's) moved no card or link" bash -c "cardof acme-shop | grep -qF 'b=$BOARD&amp;' && cardof acme-other | grep -qF 'b=$BOARD2&amp;' && ! grep -q '$AUTH' '$T/hp'"
mm grant alex acme-other >/dev/null; hp "$SA" >/dev/null
check "alex granted acme-other too: two cards; that board asked as alex, member" bash -c "[ \$(cards) = 2 ] && cardof acme-other | grep -q 'You are <b>member</b>' && node '$T/verify.mjs' \"\$(tail -1 '$T/fb2.jsonl' | jq -r .a)\" '$MM_HOME/auth/signing.key' '$BOARD2' alex member"
mm revoke alex acme-other >/dev/null; N1=$(nreq); hp "$SA" >/dev/null
check "a revoke removes the card on the next load (no cache), and that board is no longer asked" bash -c "[ \$(cards) = 1 ] && ! grep -q acme-other '$T/hp' && [ \$(nreq) = \$(( $N1 + 0 )) ]"
mm user add vic >/dev/null; mm grant vic acme-shop --as viewer >/dev/null; LV=$(link_of vic); open_link "$LV" "$T/hv"; SV=$(sess "$T/hv"); hp "$SV" >/dev/null
check "a viewer: the card says read-only, shows the counts, and has no write link (only the read-only view)" bash -c "cardof acme-shop | grep -q 'You are <b>viewer</b> (read-only)' && cardof acme-shop | grep -q '<dt>Open</dt><dd>4</dd>' && cardof acme-shop | grep -q 'View the board (read-only)' && ! grep -q -e 'class=\"open\"' -e 'Open the board' '$T/hp'"
echo script >"$T/fb2.mode"; hp "$SB" >/dev/null
check "a board's answer with <script> in it fails the schema: its card is unavailable, nothing of it on the page" bash -c "cardof acme-other | grep -q 'Summary unavailable' && ! grep -qi '<script' '$T/hp' && ! cardsonly | grep -qi alert && cardof acme-shop | grep -q '<dt>Open</dt><dd>4</dd>'"
echo extra >"$T/fb2.mode"; hp "$SB" >/dev/null
check "...a field the schema doesn't know (an item title): unavailable, nothing of it on the page" bash -c "cardof acme-other | grep -q 'Summary unavailable' && ! grep -qi '<script' '$T/hp' && ! cardsonly | grep -qi alert"
echo badnum >"$T/fb2.mode"; hp "$SB" >/dev/null
check "...a count that isn't a whole number 0..1e6: unavailable" bash -c "cardof acme-other | grep -q 'Summary unavailable' && ! grep -q 10000000 '$T/hp'"
echo hang >"$T/fb2.mode"; TH=$(hp "$SB")
check "a board that hangs: only its own card fails; the page comes in about 3 s (took ${TH}s)" bash -c "cardof acme-other | grep -q 'Summary unavailable' && cardof acme-shop | grep -q '<dt>Open</dt><dd>4</dd>' && cardof system | grep -q '<dt>Open</dt><dd>7</dd>' && awk 'BEGIN{exit !($TH < 5)}'"
echo big >"$T/fb2.mode"; TB=$(hp "$SB")
check "a board that sends 10 MB: only its own card fails, cut at 16 KB (took ${TB}s)" bash -c "cardof acme-other | grep -q 'Summary unavailable' && cardof acme-shop | grep -q '<dt>Open</dt><dd>4</dd>' && cardof system | grep -q '<dt>Open</dt><dd>7</dd>' && awk 'BEGIN{exit !($TB < 2.5)}'"
echo redirect >"$T/fb2.mode"; hp "$SB" >/dev/null
check "a board that redirects: not followed; only its card fails" bash -c "sleep 0.3; cardof acme-other | grep -q 'Summary unavailable' && cardof system | grep -q '<dt>Open</dt><dd>7</dd>' && ! grep -q followed '$T/fb2.jsonl'"
check "the gateway logs each failed card, with no assertion in the log" bash -c "grep 'board summary unavailable' '$T/gw.log' | grep -q timeout && grep 'board summary unavailable' '$T/gw.log' | grep -q 'too big' && grep 'board summary unavailable' '$T/gw.log' | grep -q 'not a summary' && ! grep -qF \"\$(tail -1 '$T/fb2.jsonl' | jq -r .a | cut -d. -f2)\" '$T/gw.log'"
echo "== the home card's worst signal (sy-6h43): the gateway's own words from a board's numbers and a checked role id"
worst() { cardof "$1" | grep -o '<p class="worst[^"]*">[^<]*</p>'; }
export -f worst
echo queue >"$T/fb2.mode"; hp "$SB" >/dev/null
check "a queue: \"review queue 3, oldest 40 min\", not red" bash -c "[ \"\$(worst acme-other)\" = '<p class=\"worst\">review queue 3, oldest 40 min</p>' ]"
check "...the real board (acme-shop, the owner): needs you 2 (1 approval), oldest its age, red" bash -c "worst acme-shop | grep -qE '^<p class=\"worst hot\">needs you 2 \(1 approval\), oldest [0-9]+ (min|h|d)</p>\$'"
check "...a board on an older template (no signal, nothing waiting on a human): no line" bash -c "cardof system | grep -q '<dt>Open</dt><dd>7</dd>' && ! cardof system | grep -q 'class=\"worst'"
hp "$SA" >/dev/null
check "...a member of acme-shop: needs you 1, red (a needs-you item), from the board's numbers only" bash -c "worst acme-shop | grep -qE '^<p class=\"worst hot\">needs you 1, oldest [0-9]+ (min|h|d)</p>\$' && ! grep -qi -e queued -e '<b>queued' '$T/hp'"
echo hot >"$T/fb2.mode"; hp "$SB" >/dev/null
check "needs-you with an approval among them: \"needs you 2 (1 approval), oldest 3 h\", red" bash -c "[ \"\$(worst acme-other)\" = '<p class=\"worst hot\">needs you 2 (1 approval), oldest 3 h</p>' ]"
echo approval >"$T/fb2.mode"; hp "$SB" >/dev/null
check "only an approval wait: \"1 approval waits for you, oldest 20 min\", red" bash -c "[ \"\$(worst acme-other)\" = '<p class=\"worst hot\">1 approval waits for you, oldest 20 min</p>' ]"
echo clear >"$T/fb2.mode"; hp "$SB" >/dev/null
check "nothing waiting: \"nothing waiting\", not red" bash -c "[ \"\$(worst acme-other)\" = '<p class=\"worst\">nothing waiting</p>' ]"
check "red only when it needs the owner: no other card line is red" bash -c "! grep -q 'worst hot' <(cardof acme-other) && ! grep -q 'worst hot' <(cardof system)"
for m in badrole oddrole htmlrole longrole badsig; do echo $m >"$T/fb2.mode"; hp "$SB" >/dev/null; cp "$T/hp" "$T/hp-$m"; done
check "a role id that is not that project's (qa): the card fails (unavailable)" bash -c "tr '\n' ' ' <'$T/hp-badrole' | sed 's#</section>#\n#g' | grep -F '<h2>acme-other</h2>' | grep -q 'Summary unavailable'"
check "...an odd role id (capitals, HTML, 40 letters): the card fails, nothing of it on the page" bash -c "for m in oddrole htmlrole longrole; do tr '\n' ' ' <\"$T/hp-\$m\" | sed 's#</section>#\n#g' | grep -F '<h2>acme-other</h2>' | grep -q 'Summary unavailable' || exit 1; done; ! grep -qi -e '<b>review' -e rrrrrrrrrr -e 'Review queue' $T/hp-oddrole $T/hp-htmlrole $T/hp-longrole"
check "...a signal number that isn't whole: the card fails" bash -c "tr '\n' ' ' <'$T/hp-badsig' | sed 's#</section>#\n#g' | grep -F '<h2>acme-other</h2>' | grep -q 'Summary unavailable'"
check "...the other cards stay (acme-shop's line is there)" bash -c "grep -q 'needs you 2 (1 approval)' '$T/hp-badrole'"
# the project's roles file leads out of its folder (a link): the gateway reads none, so even a real role id fails
mv "$T/proj2/leads/roles.json" "$T/outside-roles.json"; ln -s "$T/outside-roles.json" "$T/proj2/leads/roles.json"; sleep 0.3
echo queue >"$T/fb2.mode"; hp "$SB" >/dev/null
check "a roles.json that is a link out of the project: not read; the card with a role id fails" bash -c "cardof acme-other | grep -q 'Summary unavailable'"
rm -f "$T/proj2/leads/roles.json"; mv "$T/outside-roles.json" "$T/proj2/leads/roles.json"; sleep 0.3; hp "$SB" >/dev/null
check "...the file back in the folder: the line is back" bash -c "worst acme-other | grep -q 'review queue 3'"
echo good >"$T/fb2.mode"
# a box (in its own services.yaml) claims acme-other's board host: the host is refused for both
fakeproj "$T/proj4" acme-fourth board-other-acme; echo "# from $T/proj4/services.yaml" >"$MM_HOME/pc/boxes/acme-fourth.yaml"; sleep 0.5
N2=$(nreq); hp "$SB" >/dev/null
check "a box claiming another board's host: no card for either, and no assertion goes to that host" bash -c "! grep -q -e acme-other -e acme-fourth -e '$BOARD2' '$T/hp' && [ \$(nreq) = \$(( $N2 + 1 )) ] && [ \"\$(tail -1 '$T/sys.jsonl' | jq -r .h)\" = '$SYSB' ]"
rm -f "$MM_HOME/pc/boxes/acme-fourth.yaml"; sleep 0.5; hp "$SB" >/dev/null
check "...the claim gone: acme-other's card is back" bash -c "cardof acme-other | grep -q '<dt>Open</dt><dd>3</dd>'"

echo "== \"Waiting for you\" on the home page (sy-vdi8; review sy-6h43 #5): checked items, the gateway's ask and link"
wsec() { sed -n '/<section class="waiting"/,/<\/section>/p' "$T/hp"; }
wids() { wsec | grep -o 'class="w-id">[^<]*' | sed 's/.*>//' | tr '\n' ' '; }
nw() { cat "$T/fb2.w.jsonl" 2>/dev/null | wc -l; }
export -f wsec wids nw
echo list >"$T/fb2.mode.w"; hp "$SB" >/dev/null
check "the owner: the list is the first thing on the page" bash -c "grep -q '<main class=\"wrap\"><section class=\"waiting\" aria-labelledby=\"waiting-h\"><h2 id=\"waiting-h\">Waiting for you <span class=\"w-n\">5</span></h2>' '$T/hp'"
check "...5 items from both boards, oldest first (it-3, it-1 from acme-shop; ao-1, ao-2, ao-12 from acme-other)" bash -c "[ \"\$(wids)\" = 'it-3 it-1 ao-1 ao-2 ao-12 ' ]"
check "...each row: the gateway's ask (needs you, red), the age, the title as text, the board, the id, the gateway's link" bash -c "wsec | grep -qF '<li><a href=\"/s?b=$BOARD2&amp;r=%2F%3Fitem%3Dao-1\"><span class=\"w-ask hot\">needs you</span><span class=\"w-age\">3 h</span><span class=\"w-title\">Fix the &#60;script&#62;alert(3)&#60;/script&#62; page</span><span class=\"w-you\">You: Reply: &#60;b&#62;which&#60;/b&#62; page?</span><span class=\"w-link\">https://$BOARD2/?item=ao-1</span><span class=\"w-where\"><span class=\"w-board\">acme-other</span><span class=\"w-id\">ao-1</span></span></a></li>'"
check "...a signed-off t2: \"approve (t2, signed off)\", red (from the labels, not from board text)" bash -c "wsec | grep -qF '<span class=\"w-ask hot\">approve (t2, signed off)</span><span class=\"w-age\">20 min</span><span class=\"w-title\">Approve the push</span>' && wsec | grep -qF 'r=%2F%3Fitem%3Dit-3\"><span class=\"w-ask hot\">approve (t2, signed off)</span>'"
check "...the owner card's You line (sy-z5lz): as text; null is \"card missing\"; none from the board: no line" bash -c "wsec | grep -qF '<span class=\"w-title\">Approve the push</span><span class=\"w-you none\">card missing</span>' && wsec | grep -qE '>T{200}</span><span class=\"w-link\">https://$BOARD2/\\?item=ao-12</span><span class=\"w-where\">' && [ \$(wsec | grep -o 'class=\"w-you' | wc -l) = 4 ] && wsec | grep -qF '<span class=\"w-you\">You: Check: the &#60;i&#62;page&#60;/i&#62;, on the board</span>'"
check "...a You line with a bidi character, over 160 characters, not text, or empty: the item is dropped" bash -c "! grep -q -e DROPYOU '$T/hp'"
check "a title with <script> shows as text (escaped), and no script is on the page" bash -c "wsec | grep -qF '&#60;script&#62;alert(1)&#60;/script&#62;' && ! grep -qi '<script' '$T/hp'"
check "a link is never taken from the board: each is /s?b=<the board's host>&r=/?item=<its checked id>; the board's url is nowhere" bash -c "[ \$(wsec | grep -o 'href=\"[^\"]*\"' | wc -l) = 5 ] && ! wsec | grep -o 'href=\"[^\"]*\"' | grep -vqE '^href=\"/s\\?b=(board-shop-acme|board-other-acme)\\.example\\.org&amp;r=%2F%3Fitem%3D[a-z]+-[a-z0-9]+\"\$' && ! grep -q evil.example '$T/hp'"
check "a bad id drops the item (capitals; a quote and markup)" bash -c "! grep -q -e DROPCAPS -e DROPQUOTE -e AO-4 '$T/hp'"
check "an over-long title (201) or one with a control or bidi character drops the item; one of exactly 200 stays" bash -c "! grep -qE 'L{201}' '$T/hp' && ! grep -q -e DROPCTL -e DROPBIDI '$T/hp' && grep -qE '>T{200}</span>' '$T/hp'"
check "...an unknown field (a url), a fraction or a negative age, an unknown label, a repeated id, an empty or non-text title: dropped" bash -c "! grep -q -e DROPLINK -e DROPFRAC -e DROPAGE -e DROPAPPROVED -e DROPDUP '$T/hp' && ! wids | grep -q -e ao-13 -e ao-15"
check "...an item with no ask for the owner (no label): not on the owner's list" bash -c "! wsec | grep -q 'plain work'"
check "each board asked for its list with that person's own fresh assertion (boss, owner, that board's host), the owner's with the cards (?card=1&head=1, sy-92sg, sy-hzmu)" bash -c "jq -e '.p == \"/api/waiting?card=1&head=1\" and .h == \"$BOARD2\"' <(tail -1 '$T/fb2.w.jsonl') && node '$T/verify.mjs' \"\$(tail -1 '$T/fb2.w.jsonl' | jq -r .a)\" '$MM_HOME/auth/signing.key' '$BOARD2' boss owner"
check "an older board (system: no such answer) adds nothing and is no error (no note, not logged)" bash -c "! wsec | grep -q -e system -e unavailable && ! grep 'board waiting list unavailable' '$T/gw.log' | grep -q '\"project\":\"system\"'"
CBI=$(gw -D - -o /dev/null -H "cookie: $SB" "$G/s?b=$BOARD&r=%2F%3Fitem%3Dit-1" | sed -n 's/^location: https:\/\/[^/]*\(.*\)\r$/\1/ip')
check "the link opens the item: the board's one-time callback, then /?item=it-1 on the board (its item view)" bash -c "echo '$CBI' | grep -q '^/_mm/auth/callback?c=' && curl -s -H 'x-forwarded-host: $BOARD' '$G$CBI' | grep -qF 'content=\"0;url=/?item=it-1\"'"
hp "$SA" >/dev/null
check "a member (alex): only their own items (it-3, it-1), each \"assigned to you\", none red" bash -c "[ \"\$(wids)\" = 'it-3 it-1 ' ] && [ \$(wsec | grep -o 'class=\"w-ask\">assigned to you<' | wc -l) = 2 ] && ! wsec | grep -q -e 'w-ask hot' -e 'approve (t2' -e '>needs you<'"
hp "$SV" >/dev/null
check "a viewer with nothing assigned: \"Nothing is waiting for you.\", none of the owner's items" bash -c "wsec | grep -q 'Nothing is waiting for you.' && ! grep -q -e it-1 -e it-3 '$T/hp'"
mm grant alex acme-other >/dev/null; hp "$SA" >/dev/null
check "alex granted acme-other: its items join alex's list (asked as alex, member), as \"assigned to you\"" bash -c "[ \"\$(wids)\" = 'it-3 it-1 ao-1 ao-2 ao-3 ao-12 ' ] && ! wsec | grep -q 'w-ask hot' && node '$T/verify.mjs' \"\$(tail -1 '$T/fb2.w.jsonl' | jq -r .a)\" '$MM_HOME/auth/signing.key' '$BOARD2' alex member"
mm revoke alex acme-other >/dev/null; NW=$(nw); hp "$SA" >/dev/null
check "a revoke shows at once (no cache): acme-other's items are gone on the next load, and its list is not asked" bash -c "[ \"\$(wids)\" = 'it-3 it-1 ' ] && ! grep -q -e acme-other -e ao-1 '$T/hp' && [ \$(nw) = '$NW' ]"
echo big >"$T/fb2.mode.w"; hp "$SB" >/dev/null
check "an answer over 32 KB drops that board's whole list (a note says so); its card and the other board's items stay" bash -c "wsec | grep -q 'acme-other: the list is unavailable right now.' && ! grep -q 'BIG bbb' '$T/hp' && [ \"\$(wids)\" = 'it-3 it-1 ' ] && cardof acme-other | grep -q '<dt>Open</dt><dd>3</dd>' && grep 'board waiting list unavailable' '$T/gw.log' | grep '\"project\":\"acme-other\"' | grep -q 'too big'"
echo extra >"$T/fb2.mode.w"; hp "$SB" >/dev/null
check "...an answer with a field it doesn't know (a link): the whole list is dropped" bash -c "wsec | grep -q 'acme-other: the list is unavailable right now.' && ! grep -q evil.example '$T/hp' && ! wids | grep -q ao-"
echo more >"$T/fb2.mode.w"; hp "$SB" >/dev/null
check "a board that kept some back (over its own 32 KB): \"7 more on the board\"" bash -c "wsec | grep -q 'acme-other: 7 more on the board.' && wids | grep -q 'ao-1 ao-2'"
mm user add eve >/dev/null; mm grant eve acme-other >/dev/null; LEV=$(link_of eve); open_link "$LEV" "$T/hev"; SE=$(sess "$T/hev")
for m in older forbid; do echo $m >"$T/fb2.mode.w"; hp "$SE" >/dev/null; cp "$T/hp" "$T/hp-w-$m"; done
check "boards on an older template only (404, or 403 from the board's proxy): no list at all and no error, the card as before" bash -c "for m in older forbid; do ! grep -q -e 'class=\"waiting\"' -e unavailable \"$T/hp-w-\$m\" && grep -q '<dt>Open</dt><dd>3</dd>' \"$T/hp-w-\$m\" || exit 1; done"
echo empty >"$T/fb2.mode.w"; hp "$SE" >/dev/null
check "...a board with the list and nothing on it: \"Nothing is waiting for you.\"" bash -c "wsec | grep -q 'Nothing is waiting for you.'"
mm user rm eve >/dev/null
echo list >"$T/fb2.mode.w"

echo "== the gateway's pages: one stylesheet, no inline style (the CSP blocks it; sy-vey6)"
pg() { gw -D "$T/pg-$1.h" -o "$T/pg-$1.html" "${@:2}"; }
pg code "$G/s?b=$BOARD&r=/items"; pg continue "$G/api/auth/magic-link/verify?token=x&callbackURL=/s/done"; pg expired "$G/s/done"
pg noaccess -H "cookie: $SA" "$G/s?b=$BOARD2"; pg home -H "cookie: $SA" "$G/"; pg owner -H "cookie: $SB" "$G/"
PAGES="code continue expired noaccess home owner"; export PAGES
check "the pages are what they should be (code, Continue, expired, no access, home, the owner's home)" bash -c "grep -q 'id=\"code\"' '$T/pg-code.html' && grep -q 'action=\"/s/l\"' '$T/pg-continue.html' && grep -q expired '$T/pg-expired.html' && grep -q 'no access' '$T/pg-noaccess.html' && grep -q '<h2>acme-shop</h2>' '$T/pg-home.html' && grep -q '<h2>system</h2>' '$T/pg-owner.html'"
check "no page has a style= attribute or a <style> tag" bash -c "for p in \$PAGES; do ! grep -qiE 'style=|<style' '$T'/pg-\$p.html || exit 1; done"
check "each page links the one stylesheet, /s/app.css, and nothing else" bash -c "for p in \$PAGES; do [ \$(grep -o '<link[^>]*>' '$T'/pg-\$p.html | wc -l) = 1 ] && grep -q '<link rel=\"stylesheet\" href=\"/s/app.css\">' '$T'/pg-\$p.html || exit 1; done"
check "no inline script anywhere; only the code page loads a script, /s/app.js (same origin)" bash -c "for p in \$PAGES; do n=\$(grep -o '<script[^>]*>' '$T'/pg-\$p.html | wc -l); if [ \$p = code ]; then [ \$n = 1 ] && grep -q '<script src=\"/s/app.js\"></script>' '$T'/pg-code.html || exit 1; else [ \$n = 0 ] || exit 1; fi; done"
check "every page keeps the CSP (default-src 'self'; frame-ancestors 'none'), no-store and no-referrer" bash -c "for p in \$PAGES; do grep -qi \"^content-security-policy: default-src 'self'; frame-ancestors 'none'\" '$T'/pg-\$p.h && grep -qi '^cache-control: no-store' '$T'/pg-\$p.h && grep -qi '^referrer-policy: no-referrer' '$T'/pg-\$p.h || exit 1; done"
check "each page has the board's header line and a phone viewport" bash -c "for p in \$PAGES; do grep -q '<header class=\"top\"><h1>' '$T'/pg-\$p.html && grep -q 'name=\"viewport\" content=\"width=device-width,initial-scale=1\"' '$T'/pg-\$p.html || exit 1; done"
gw -D "$T/css.h" -o "$T/app.css" "$G/s/app.css"
check "/s/app.css: 200, text/css, the same CSP, nosniff, no-referrer, cacheable" bash -c "head -1 '$T/css.h' | grep -q 200 && grep -qi '^content-type: text/css' '$T/css.h' && grep -qi \"^content-security-policy: default-src 'self'; frame-ancestors 'none'\" '$T/css.h' && grep -qi '^x-content-type-options: nosniff' '$T/css.h' && grep -qi '^referrer-policy: no-referrer' '$T/css.h' && grep -qi '^cache-control: public, max-age=' '$T/css.h'"
check "...the boards' style: their font stack, no rounded corners, no shadows, no font or file from elsewhere" bash -c "grep -qF \"font-family:'Inter Variable','Helvetica Neue',Helvetica,Arial\" '$T/app.css' && grep -q 'border-radius:0' '$T/app.css' && ! grep -qiE 'border-radius:[^0]|box-shadow|@import|url\\(|https?:' '$T/app.css'"
kill $BS $FB $FB2 $FS 2>/dev/null

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
