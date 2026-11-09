#!/usr/bin/env bash
# mm.api, hermetic (sy-b15.8): a throwaway HOME and MM_HOME, two registered boxes (their folders only, no container),
# a fake system board (bd), a fake docker and route tool, a fake Telegram, curl as each box. Proves: one socket per box,
# the project taken from the socket; only the four calls, each in its fixed format; each request files one item, the
# box's value in mm's frame; a label decides nothing; only the owner's socket (and mm api approve, refused in an
# agent's shell) applies a request, and only the one its hash names; egress needs review's sign-off and then the
# owner; a route only under the box's own project, behind the sign-in by default, never a host the gateway's map has;
# a release only from a real folder in release/; a secret only a new name, never a value; the rate and open limits;
# every call logged with the socket's project; undo.
#   test/api.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); SV=""; TG=""; trap '[ -n "$SV" ] && kill $SV 2>/dev/null; [ -n "$TG" ] && kill $TG 2>/dev/null; [ -n "${KEEP:-}" ] && echo "kept: $T" || rm -rf "$T"' EXIT
export T HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_API_SYNC_MS=300
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
mkdir -p "$MM_HOME/pc/boxes" "$HOME/brain/.keys" "$HOME/brain/system" "$T/bin" "$T/routes" "$T/labels"
# only this test's tools and the system's: never the machine's mm, process manager or route tool
export PATH="$T/bin:$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin"
TGP=$(( 39900 + RANDOM % 90 ))
printf 'access: domain\ndomain: example.test\nbind_host: 127.0.0.1\nauth:\n  enabled: true\napi:\n  enabled: true\ntelegram:\n  owner_id: "4242"\n' >"$MM_HOME/config.yaml"
printf 'test-bot-token-7731' >"$HOME/brain/.keys/.telebot"; chmod 600 "$HOME/brain/.keys/.telebot"
cat >"$T/tg.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { fs.appendFileSync(out, b + '\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) }).listen(Number(port), '127.0.0.1')
EOF
node "$T/tg.mjs" $TGP "$T/tg.jsonl" & TG=$!
export MM_TELEGRAM_API="http://127.0.0.1:$TGP"
# the fake system board: every call in bd.jsonl; create gives sy-t<n>; show gives the labels in labels/<id>
cat >"$T/bin/fakebd" <<'EOF'
#!/usr/bin/env node
const fs = require('fs'), T = process.env.T, a = process.argv.slice(2)
fs.appendFileSync(`${T}/bd.jsonl`, JSON.stringify(a) + '\n')
const lf = (id) => `${T}/labels/${id}`
if (a[0] === 'create') { const n = (fs.existsSync(`${T}/bd.n`) ? Number(fs.readFileSync(`${T}/bd.n`, 'utf8')) : 0) + 1; fs.writeFileSync(`${T}/bd.n`, String(n))
  const l = a[a.indexOf('-l') + 1] || ''; fs.writeFileSync(lf(`sy-t${n}`), l.split(',').join('\n') + '\n'); console.log(JSON.stringify({ id: `sy-t${n}` })) }
else if (a[0] === 'show') console.log(JSON.stringify([{ id: a[1], labels: fs.existsSync(lf(a[1])) ? fs.readFileSync(lf(a[1]), 'utf8').split('\n').filter(Boolean) : [] }]))
else if (a[0] === 'label' && a[1] === 'add') fs.appendFileSync(lf(a[2]), a[3] + '\n')
EOF
cat >"$T/bin/fakedocker" <<'EOF'
#!/bin/sh
echo "$*" >> "$T/docker.log"
last=""; for x in "$@"; do last=$x; done
case "$1" in
  inspect) grep -qx "$last" "$T/running" 2>/dev/null || exit 1
    case "$*" in *State.Running*) echo true ;; *IPAddress*) echo 10.231.5.10 ;; *) echo '[]' ;; esac ;;
  *) exit 0 ;;
esac
EOF
# the route tool: like the machine's `expose` (ls, rm, <name> <port> [--sso]); a route is a file in $T/routes
cat >"$T/bin/fakeexpose" <<'EOF'
#!/bin/bash
case "$1" in
  ls) for f in "$T"/routes/*; do [ -e "$f" ] || continue; echo "https://${f##*/}.example.test  $(cat "$f")"; done ;;
  rm) rm -f "$T/routes/$2" ;;
  *) echo "port=$2 ${3:-open}" > "$T/routes/$1" ;;
esac
EOF
chmod +x "$T/bin/fakebd" "$T/bin/fakedocker" "$T/bin/fakeexpose"
export MM_API_BD="$T/bin/fakebd" MM_DOCKER="$T/bin/fakedocker" MM_EXPOSE="$T/bin/fakeexpose"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
# two boxes, registered as mm up does it: acme-shop (an app slot, a build in release/v1, a link release/out) and
# acme-other (whose board claims web.acme-shop: a host in the gateway's map)
mkbox() { local c=$1 n=$2 board=$3 r="$HOME/projects/$1/$2"; mkdir -p "$r/release/v1"
  printf 'client: %s\nname: %s\nproject: %s-%s\nshort: xx\nroot: %s\ntemplate_version: test\ncreated: "2026-01-01"\nthrowaway: true\nbox: true\n' "$c" "$n" "$c" "$n" "$r" >"$r/.mm-answers.yaml"
  printf 'version: 1\nservices:\n  board:\n    command: "node x"\n    port: http\n    public: { name: "%s", auth: required }\n  app:\n    optional: true\n    command: "node server.js"\n    workdir: "{root}/release"\n    port: http\n    public: { name: "%s-%s", auth: none }\n' "$board" "$n" "$c" >"$r/services.yaml"
  printf '{"required":[{"name":"declared-key"}]}\n' >"$r/secrets.json"
  ln -s /etc "$r/release/out"
  echo "# from $r/services.yaml" >"$MM_HOME/pc/boxes/$c-$n.yaml"; }
mkbox acme shop board-shop-acme; mkbox acme other web.acme-shop; mkbox acme spare board-spare-acme
# this test's mm.api serves its own (throwaway) boxes: a machine's mm.api would skip them (src/boxreg.ts, sy-bpgq)
export MM_API_ONLY=acme-shop,acme-other,acme-spare
printf '#!/bin/sh\necho "[]"\n' >"$T/bin/process-compose"; chmod +x "$T/bin/process-compose"   # the host's process manager: a stand-in
mkdir -p "$MM_HOME/box/acme-shop"; printf '{"services":{"app":{"public_port":38555}}}\n' >"$MM_HOME/box/acme-shop/ports.json"
mkdir -p "$MM_HOME/vault"; : >"$MM_HOME/vault/acme-shop.old-key.age"   # a sealed name (an empty stand-in, no value)
S1="$MM_HOME/box/acme-shop/api/api.sock"; S2="$MM_HOME/box/acme-other/api/api.sock"; AS="$MM_HOME/api/approve.sock"
# the checks below make many calls: a high rate limit until the limits' own section, which starts it again with 10
serve() { [ -n "$SV" ] && kill $SV 2>/dev/null && wait $SV 2>/dev/null; rm -f "$S1" "$S2" "$AS"; MM_API_RATE=${1:-} mm api serve >>"$T/api.log" 2>&1 & SV=$!
  for _ in $(seq 1 100); do [ -S "$S1" ] && [ -S "$S2" ] && [ -S "$AS" ] && break; sleep 0.2; done; }
# person run files a killed mm left in the secrets folder's _run/ (sy-rjwg 6): this test's own folder, never the machine's
export MM_SECRETS_DIR="$T/secrets"; RUND="$MM_SECRETS_DIR/_run"; mkdir -p "$RUND"; chmod 700 "$RUND"
printf 'left' >"$RUND/oldrun"; touch -d '5 minutes ago' "$RUND/oldrun"; printf 'opening' >"$RUND/freshrun"
mkdir -p "$T/keepme"; : >"$T/keepme/x"; touch -d '5 minutes ago' "$T/keepme/x"; ln -s "$T/keepme" "$RUND/oldlink"; touch -h -d '5 minutes ago' "$RUND/oldlink"
serve 1000
# a box's call: POST <call> with a JSON body; the answer's body, or its HTTP code
call() { curl -s --unix-socket "$1" -X POST -H 'content-type: application/json' -d "$3" "http://api/$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' --unix-socket "$1" -X "${4:-POST}" -H 'content-type: application/json' -d "$3" "http://api/$2"; }
own() { curl -s --unix-socket "$AS" -H 'content-type: application/json' "$@"; }
st() { mm api show "$1" -o json | jq -r .status; }
items() { grep -c '"create"' "$T/bd.jsonl" 2>/dev/null || echo 0; }
# the one-time code mm.api sent the owner for a request: only the Telegram stand-in has it (sy-35f2)
codeof() { local c; for _ in $(seq 1 50); do c=$(grep -o "mmapi:allow:$1:[A-Z2-7]\{2,8\}" "$T/tg.jsonl" 2>/dev/null | tail -1 | cut -d: -f4); [ -n "$c" ] && { echo "$c"; return; }; sleep 0.1; done; }
export -f call code own st items codeof; export S1 S2 AS

echo '== the way in'
check "a socket for each registered box: 0660 in a 0750 folder (the box's user has the owner's group)" bash -c "[ \"\$(stat -c %a '$S1')\" = 660 ] && [ \"\$(stat -c %a \"\$(dirname '$S1')\")\" = 750 ] && [ -S '$S2' ]"
check "the owner's socket: 0600 in mm.api's 0700 folder" bash -c "[ \"\$(stat -c %a '$AS')\" = 600 ] && [ \"\$(stat -c %a '$MM_HOME/api')\" = 700 ]"
check "at its start, mm.api removed the person run file a killed mm left in _run/ (and said so in its log)" bash -c "! test -e '$RUND/oldrun' && grep -q 'person run files left by a killed mm' '$T/api.log'"
check "...not one just made (a run opening it now)" test -e "$RUND/freshrun"
check "...a link there goes, its target stays" bash -c "! test -L '$RUND/oldlink' && test -e '$T/keepme/x'"
check "no TCP port: mm.api listens on nothing else" bash -c "! /usr/sbin/ss -Hltnp 2>/dev/null | grep -q \"pid=$SV,\""

echo '== only the four calls, each in its fixed format (nothing filed for a refusal)'
check "another call (/exec), or a GET: refused (404, unknown-call)" bash -c "[ \"\$(code '$S1' exec '{}')\" = 404 ] && [ \"\$(code '$S1' route '{}' GET)\" = 404 ] && call '$S1' exec '{}' | jq -e '.status == \"refused\" and .why == \"unknown-call\"'"
for v in Shop -shop shop- 'a b' '' '../x' 'shop.acme-other' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; do
  check "route '$v': refused (format)" bash -c "call '$S1' route '{\"name\":\"$v\"}' | jq -e '.status == \"refused\" and .why == \"format\"'"
done
check "route: a name that is not a string (a list): refused (format)" bash -c "call '$S1' route '{\"name\":[\"shop\"]}' | jq -e '.why == \"format\"'"
for v in '*.example.com' 1.2.3.4 example.com:443 localhost http://x.com 'ex ample.com' Example.com; do
  check "egress '$v': refused (format)" bash -c "call '$S1' egress '{\"site\":\"$v\"}' | jq -e '.why == \"format\"'"
done
for v in .. .hidden a/b ../v1; do check "release '$v': refused (format)" bash -c "call '$S1' release '{\"build\":\"$v\"}' | jq -e '.why == \"format\"'"; done
check "release 'out' (a link in release/, to /etc): refused (no-build), nothing followed" bash -c "call '$S1' release '{\"build\":\"out\"}' | jq -e '.why == \"no-build\"'"
check "release 'nothere': refused (no-build)" bash -c "call '$S1' release '{\"build\":\"nothere\"}' | jq -e '.why == \"no-build\"'"
for v in Key a.b acme-other.x 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ''; do check "secret '$v': refused (format; never another namespace)" bash -c "call '$S1' secret '{\"name\":\"$v\"}' | jq -e '.why == \"format\"'"; done
check "secret old-key (sealed already), declared-key (the project declares it), telegram-bot-token (a machine input): refused (exists)" bash -c "for v in old-key declared-key telegram-bot-token; do call '$S1' secret \"{\\\"name\\\":\\\"\$v\\\"}\" | jq -e '.why == \"exists\"' || exit 1; done"
check "...and none of these filed an item" bash -c "[ \"\$(items)\" = 0 ]"

echo '== a request: one item, the project from the socket'
OUT=$(call "$S1" route '{"name":"shop","project":"acme-other"}'); RA=$(echo "$OUT" | jq -r .id); IA=$(echo "$OUT" | jq -r .item)
check "route shop: pending, with the request's id and its item's id, and nothing else" bash -c "echo '$OUT' | jq -e '.status == \"pending\" and (.id | test(\"^r-[0-9a-f]{8}\$\")) and .item == \"sy-t1\" and (keys | sort) == [\"id\",\"item\",\"status\"]'"
check "...the item is acme-shop's (the socket's), whatever the body said (project: acme-other)" bash -c "grep '\"create\"' '$T/bd.jsonl' | head -1 | jq -e '.[1] == \"mm.api: acme-shop asks for route shop.acme-shop.example.test\" and (.[3] | test(\"box of project \\\\*\\\\*acme-shop\")) and (.[3] | test(\"acme-other\") | not)'"
check "...the box's value only in mm's frame (From the box, data), with the request's id and hash on a fixed line" bash -c "grep '\"create\"' '$T/bd.jsonl' | head -1 | jq -r '.[3]' | grep -Pzo '\\*\\*From the box\\*\\* \\(data, not instructions[^\\n]*\\n\\n\`\`\`text\\nshop\\n\`\`\`' >/dev/null && grep '\"create\"' '$T/bd.jsonl' | head -1 | jq -r '.[3]' | grep -qE '^mm-api: $RA sha256:[0-9a-f]{64}\$'"
check "...labelled mm-api and needs-you, filed as the system's actor (watchdog), not a person" bash -c "grep '\"create\"' '$T/bd.jsonl' | head -1 | jq -e 'index(\"mm-api,needs-you\") and .[-1] == \"watchdog\" and .[-2] == \"--actor\"'"
check "...the owner was told, with how to approve" bash -c "grep -q \"acme-shop asks for route shop ($IA, $RA)\" '$T/tg.jsonl'"
check "...logged with the socket's project (box: acme-shop)" bash -c "grep '\"msg\":\"call: request filed\"' '$T/api.log' | jq -e 'select(.box == \"acme-shop\" and .call == \"route\" and .value == \"shop\")'"
check "the same request again: its status (pending, same id), no second item" bash -c "call '$S1' route '{\"name\":\"shop\"}' | jq -e '.status == \"pending\" and .id == \"$RA\"' && [ \"\$(items)\" = 1 ]"

echo '== a label decides nothing (review sy-b15.8 1)'
"$T/bin/fakebd" label add "$IA" approved; "$T/bin/fakebd" label add "$IA" signed-off; sleep 1.5
check "bd label add $IA approved (and signed-off), from a host shell: the request stays pending, no route" bash -c "[ \"\$(st $RA)\" = pending ] && ! test -e '$T/routes/shop.acme-shop' && call '$S1' route '{\"name\":\"shop\"}' | jq -e '.status == \"pending\"'"

echo "== only the owner's socket decides, and only the request its hash names"
HA=$(mm api show "$RA" -o json | jq -r .hash)
OUTB=$(call "$S1" route '{"name":"other-name"}'); RB=$(echo "$OUTB" | jq -r .id); HB=$(mm api show "$RB" -o json | jq -r .hash)
check "an agent's shell (CLAUDECODE): mm api approve is refused, and nothing is applied" bash -c "! CLAUDECODE=1 mm api approve $RA --hash ${HA:0:12} && [ \"\$(st $RA)\" = pending ]"
check "...a Paseo agent's (PASEO_AGENT_ID) too; deny and undo as well" bash -c "! PASEO_AGENT_ID=x mm api approve $RA --hash ${HA:0:12} && ! CLAUDECODE=1 mm api deny $RA && ! CLAUDECODE=1 mm api undo $RA && [ \"\$(st $RA)\" = pending ]"
check "...and every agent session is denied the owner's socket and mm api (the template's rendered denies)" bash -c "for r in \"'Bash(mm api*)'\" \"'Bash(*approve.sock*)'\" \"['auth', 'paseo', 'ai', 'api']\" 'Bash(*\${m}/api/*)'; do grep -qF -- \"\$r\" '$SRC/template/bin/config-check' || exit 1; done" # the store's denies name mm's folder as the host knows it (MMS, review sy-v92 2)
check "mm api approve with no terminal to ask in and no --hash: refused" bash -c "! mm api approve $RA </dev/null && [ \"\$(st $RA)\" = pending ]"
check "mm api approve $RA --hash <request B's>: refused, nothing applied (A and B pending)" bash -c "! mm api approve $RA --hash ${HB:0:12} && [ \"\$(st $RA)\" = pending ] && [ \"\$(st $RB)\" = pending ]"
check "the owner's socket: request A's id with request B's hash: refused (409), nothing applied" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RA\",\"hash\":\"$HB\"}' http://api/approve)\" = 409 ] && [ \"\$(st $RA)\" = pending ] && [ \"\$(st $RB)\" = pending ] && ! test -e '$T/routes/shop.acme-shop'"
check "...with no hash: refused" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RA\"}' http://api/approve)\" = 409 ]"
echo "== the one-time code (sy-35f2): only on the owner's Telegram, and required to approve"
serve 1000   # a fresh count of decisions for this section (the codes are in the store, so they hold)
CA=$(codeof "$RA"); CB=$(codeof "$RB")
check "each request's code: 8 base32 characters, sent to the owner once, in the text and the Allow buttons, with the mm-api line last" bash -c "[[ '$CA' =~ ^[A-Z2-7]{8}\$ ]] && [[ '$CB' =~ ^[A-Z2-7]{8}\$ ]] && [ '$CA' != '$CB' ] && [ \"\$(grep -c '$CA' '$T/tg.jsonl')\" = 1 ] && grep '$CA' '$T/tg.jsonl' | jq -e '.chat_id == \"4242\" and (.text | test(\"Code: $CA \")) and (.text | endswith(\"mm-api: $RA sha256:$HA\")) and .reply_markup.inline_keyboard[0] == [{text: \"Allow\", callback_data: \"mmapi:allow:$RA:$CA\"}, {text: \"Allow, no login\", callback_data: \"mmapi:open:$RA:$CA\"}, {text: \"Deny\", callback_data: \"mmapi:deny:$RA\"}]'"
check "mm api show: whether a code works now, never the code or its hash" bash -c "mm api show $RA -o json | jq -e '(.code | test(\"^valid until .*, 5 tries left\$\")) and (tostring | test(\"scrypt|$CA\") | not)'"
check "the owner's socket: A's id and hash, no code: refused (403), nothing applied" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RA\",\"hash\":\"$HA\"}' http://api/approve)\" = 403 ] && [ \"\$(st $RA)\" = pending ] && ! test -e '$T/routes/shop.acme-shop'"
check "...a wrong code: refused (403), nothing applied" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RA\",\"hash\":\"$HA\",\"code\":\"WRONG222\"}' http://api/approve)\" = 403 ] && [ \"\$(st $RA)\" = pending ] && ! test -e '$T/routes/shop.acme-shop'"
check "...request B's code on A: refused (403), nothing applied (A and B pending)" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RA\",\"hash\":\"$HA\",\"code\":\"$CB\"}' http://api/approve)\" = 403 ] && [ \"\$(st $RA)\" = pending ] && [ \"\$(st $RB)\" = pending ] && ! test -e '$T/routes/shop.acme-shop'"
check "...each logged at warn as a wrong code, without what was sent" bash -c "[ \"\$(grep '\"approval refused: wrong code\"' '$T/api.log' | jq -s 'map(select(.level == \"warn\" and .id == \"$RA\")) | length')\" = 3 ] && ! grep -qF -e WRONG222 -e '$CB' -e '$CA' '$T/api.log'"
check "mm api approve with the right hash and no code on stdin: refused, nothing applied" bash -c "! mm api approve $RA --hash ${HA:0:12} </dev/null && [ \"\$(st $RA)\" = pending ]"
check "mm api approve $RA --hash <its own>, the code on stdin: done; the route is behind the sign-in, to the app slot's port" bash -c "echo '$CA' | mm api approve $RA --hash ${HA:0:12} && [ \"\$(st $RA)\" = done ] && grep -qx 'port=38555 --sso' '$T/routes/shop.acme-shop' && ! test -e '$T/routes/other-name.acme-shop'"
check "...the item says what was done and the undo, is labelled approved (the state) and closed" bash -c "grep '\"comments\"' '$T/bd.jsonl' | jq -e 'select(.[2] == \"$IA\" and (.[3] | test(\"mm api undo $RA\")))' && grep -q \"\\\"label\\\",\\\"add\\\",\\\"$IA\\\",\\\"approved\\\"\" '$T/bd.jsonl' && grep -q \"\\\"close\\\",\\\"$IA\\\"\" '$T/bd.jsonl'"
check "...the box sees done" bash -c "call '$S1' route '{\"name\":\"shop\"}' | jq -e '.status == \"done\" and .id == \"$RA\"'"
check "...the gateway's host map has it for acme-shop (forward-auth), and it is no board (no card)" bash -c "cd '$SRC' && bun -e \"import { hostClaims } from './src/auth.ts'; const c = hostClaims(); process.exit([...(c.routes['shop.acme-shop.example.test'] || [])].join() === 'acme-shop' && !c.claims['shop.acme-shop.example.test'] ? 0 : 1)\""
check "a second approval of the same request, its used code again: refused (409, it is done)" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RA\",\"hash\":\"$HA\",\"code\":\"$CA\"}' http://api/approve)\" = 409 ] && [ \"\$(grep -c '\"msg\":\"request applied\".*\"id\":\"$RA\"' '$T/api.log')\" = 1 ]"
check "...A's used code on B: refused (403), B pending" bash -c "[ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RB\",\"hash\":\"$HB\",\"code\":\"$CA\"}' http://api/approve)\" = 403 ] && [ \"\$(st $RB)\" = pending ] && ! test -e '$T/routes/other-name.acme-shop'"
RC=$(call "$S1" route '{"name":"code-test"}' | jq -r .id); HC=$(mm api show "$RC" -o json | jq -r .hash); CC=$(codeof "$RC")
check "5 wrong codes: the code is void, and then even the right one applies nothing (409)" bash -c "for i in 1 2 3 4 5; do [ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RC\",\"hash\":\"$HC\",\"code\":\"WRONG222\"}' http://api/approve)\" = 403 ] || exit 1; done; [ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RC\",\"hash\":\"$HC\",\"code\":\"$CC\"}' http://api/approve)\" = 409 ] && [ \"\$(st $RC)\" = pending ] && ! test -e '$T/routes/code-test.acme-shop' && mm api show $RC -o json | jq -e '.code | test(\"^none valid\")'"
check "mm api code: a new code, to the owner only (an agent's shell can't ask for one)" bash -c "! CLAUDECODE=1 mm api code $RC && mm api code $RC -o json | jq -e '.ok and (tostring | test(\"[A-Z2-7]{8}\") | not)' && for i in \$(seq 1 50); do [ \"\$(grep -o 'mmapi:allow:$RC:[A-Z2-7]*' '$T/tg.jsonl' | sort -u | wc -l)\" = 2 ] && exit 0; sleep 0.1; done; exit 1"
CC2=$(codeof "$RC"); CC2D=$(echo "${CC2:0:4}-${CC2:4}" | tr A-Z a-z)
check "...the old code (reused): refused (403), nothing applied" bash -c "[ '$CC2' != '$CC' ] && [ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RC\",\"hash\":\"$HC\",\"code\":\"$CC\"}' http://api/approve)\" = 403 ] && [ \"\$(st $RC)\" = pending ]"
check "...the new one (typed in lower case, with a dash): applied once; the same code again: refused (409)" bash -c "own -d '{\"id\":\"$RC\",\"hash\":\"$HC\",\"code\":\"$CC2D\"}' http://api/approve | jq -e .ok && grep -qx 'port=38555 --sso' '$T/routes/code-test.acme-shop' && [ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RC\",\"hash\":\"$HC\",\"code\":\"$CC2\"}' http://api/approve)\" = 409 ] && [ \"\$(grep -c '\"msg\":\"request applied\".*\"id\":\"$RC\"' '$T/api.log')\" = 1 ]"

echo '== a route only under its own project, never a host someone has'
check "a name under another project (shop.acme-other) can't even be asked: format" bash -c "call '$S1' route '{\"name\":\"shop.acme-other\"}' | jq -e '.why == \"format\"'"
check "web: web.acme-shop.example.test is acme-other's board (the gateway's host map): refused (taken), no item" bash -c "n=\$(items); call '$S1' route '{\"name\":\"web\"}' | jq -e '.why == \"taken\"' && [ \"\$(items)\" = \$n ]"
check "acme-other's own route shop is its own host (shop.acme-other.example.test): pending" bash -c "call '$S2' route '{\"name\":\"shop\"}' | jq -e '.status == \"pending\"' && grep '\"create\"' '$T/bd.jsonl' | tail -1 | jq -e '.[1] == \"mm.api: acme-other asks for route shop.acme-other.example.test\"'"
RO=$(call "$S1" route '{"name":"open-one"}' | jq -r .id); HO=$(mm api show "$RO" -o json | jq -r .hash)
check "no login only when the owner chooses it on approval: the route has no gate, and the gateway's map leaves it out" bash -c "own -d '{\"id\":\"$RO\",\"hash\":\"$HO\",\"code\":\"$(codeof "$RO")\",\"open\":true}' http://api/approve | jq -e .ok && grep -qx 'port=38555 open' '$T/routes/open-one.acme-shop' && cd '$SRC' && bun -e \"import { hostClaims } from './src/auth.ts'; process.exit(hostClaims().routes['open-one.acme-shop.example.test'] ? 1 : 0)\""

echo '== egress: review signs off on the item, then the owner'
OUT=$(call "$S1" egress '{"site":"api.stripe.com"}'); RE=$(echo "$OUT" | jq -r .id); IE=$(echo "$OUT" | jq -r .item); HE=$(mm api show "$RE" -o json | jq -r .hash)
echo mm-egress-acme-shop >"$T/running"
check "egress api.stripe.com: pending; the item is review's, labelled t2" bash -c "echo '$OUT' | jq -e '.status == \"pending\"' && grep '\"create\"' '$T/bd.jsonl' | tail -1 | jq -e 'index(\"mm-api,t2\") and index(\"review\")'"
check "the owner approves before review signed off: refused, nothing applied" bash -c "! codeof $RE | mm api approve $RE --hash ${HE:0:12} && [ \"\$(st $RE)\" = pending ] && ! grep -q stripe '$MM_HOME/egress/acme-shop/allow' 2>/dev/null"
"$T/bin/fakebd" label add "$IE" signed-off; sleep 1
check "review's signed-off label alone decides nothing: still pending" bash -c "[ \"\$(st $RE)\" = pending ]"
check "...then the owner approves (the same code: the refusal for the sign-off didn't use it): done; the exact site on the list; the proxy restarted to read it" bash -c "codeof $RE | mm api approve $RE --hash ${HE:0:12} && [ \"\$(st $RE)\" = done ] && grep -qxF '^api\\.stripe\\.com(:443)?\$' '$MM_HOME/egress/acme-shop/allow' && grep -qx 'restart -t 2 mm-egress-acme-shop' '$T/docker.log'"
check "...only for acme-shop (acme-other's list doesn't have it)" bash -c "cd '$SRC' && bun -e \"import { egressList } from './src/box.ts'; process.exit(egressList('$HOME/projects/acme/other').includes('api.stripe.com') || !egressList('$HOME/projects/acme/shop').includes('api.stripe.com') ? 1 : 0)\""
check "a site on the list already (github.com): done, nothing filed" bash -c "n=\$(items); call '$S1' egress '{\"site\":\"github.com\"}' | jq -e '.status == \"done\"' && [ \"\$(items)\" = \$n ]"
check "mm api undo: the site goes, the proxy restarted again" bash -c "mm api undo $RE && [ \"\$(st $RE)\" = undone ] && ! grep -q stripe '$MM_HOME/egress/acme-shop/allow' && [ \"\$(grep -cx 'restart -t 2 mm-egress-acme-shop' '$T/docker.log')\" = 2 ]"

echo '== release: a real folder in release/, run in the box'
echo mm-box-acme-shop >>"$T/running"
check "with the API on and no release granted: the box has no app slot (what it put in release/ runs nowhere)" bash -c "cd '$SRC' && bun -e \"import { resolve } from './src/project.ts'; process.exit(resolve('$HOME/projects/acme/shop').services.app ? 1 : 0)\""
OUT=$(call "$S1" release '{"build":"v1"}'); RR=$(echo "$OUT" | jq -r .id); HR=$(mm api show "$RR" -o json | jq -r .hash)
check "release v1: pending" bash -c "echo '$OUT' | jq -e '.status == \"pending\"'"
check "...approved: the app slot runs release/v1, loaded by the box's own process manager (docker exec), never on the host" bash -c "codeof $RR | mm api approve $RR --hash ${HR:0:12} && [ \"\$(st $RR)\" = done ] && grep -qx 'exec mm-box-acme-shop process-compose -U -u /run/mm/sock/pc.sock project update -f /run/mm/cfg/pc.yaml' '$T/docker.log' && grep -q 'working_dir: $HOME/projects/acme/shop/release/v1' '$MM_HOME/box/acme-shop/cfg/pc.yaml'"
check "...and the granted routes go to it (mm up writes them again)" bash -c "test -e '$T/routes/shop.acme-shop'"
check "acme-other still has no app slot" bash -c "cd '$SRC' && bun -e \"import { resolve } from './src/project.ts'; process.exit(resolve('$HOME/projects/acme/other').services.app ? 1 : 0)\""

echo '== secret: a new name, never a value'
OUT=$(call "$S1" secret '{"name":"stripe-key"}'); RS=$(echo "$OUT" | jq -r .id); HS=$(mm api show "$RS" -o json | jq -r .hash)
check "secret stripe-key: pending; the item names acme-shop.stripe-key and says no value goes through the API" bash -c "echo '$OUT' | jq -e '.status == \"pending\"' && grep '\"create\"' '$T/bd.jsonl' | tail -1 | jq -e '(.[1] | test(\"acme-shop.stripe-key\")) and (.[3] | test(\"No value goes through the API\"))'"
check "...approved: the owner is told how to fill it in their own terminal; mm needs lists it for acme-shop" bash -c "codeof $RS | mm api approve $RS --hash ${HS:0:12} && grep '\"comments\"' '$T/bd.jsonl' | tail -1 | grep -q 'mm fill acme-shop:stripe-key' && mm needs -p acme-shop -o json | jq -e '.[] | select(.name == \"stripe-key\" and .status == \"missing\")'"
check "...with no vault on this machine, it can't be filled into the project's folder (the box's to read)" bash -c "! printf x | mm fill acme-shop:stripe-key && ! test -e '$HOME/projects/acme/shop/secrets/stripe-key'"
check "...asked again: done" bash -c "call '$S1' secret '{\"name\":\"stripe-key\"}' | jq -e '.status == \"done\"'"

echo "== the items pass the system board's gates (sy-jycr): an owner card for needs-you, then a Task"
# the description of the first item filed for a call (bd create's -d), checked by the template's own checks: the card
# by bin/owner-card check -, the Task by task.mjs with the activities of the system board's RACI
cat >"$T/taskcheck.mjs" <<'EOF'
import fs from 'node:fs'
const [lib, raci] = process.argv.slice(2), { parseTask } = await import(lib)
const acts = JSON.parse(fs.readFileSync(raci, 'utf8')).activities.map((a) => a.id)
const r = parseTask(fs.readFileSync(0, 'utf8'), { acts }); if (!r.ok) console.error(r.errors.join('\n')); process.exit(r.ok ? 0 : 1)
EOF
for c in route release secret; do
  grep '"create"' "$T/bd.jsonl" | jq -c --arg c "$c" 'select(.[1] | test("asks for " + $c + " ")) | .[3]' | head -1 | jq -r . >"$T/desc-$c"
  check "$c: the item's description has a valid owner card (bin/owner-card check -), no t2 go ask" bash -c "node '$SRC/template/bin/owner-card' check - <'$T/desc-$c' && head -5 '$T/desc-$c' | grep -q '^- \\*\\*You:\\*\\* Tap Approve: the Allow button' && ! grep -q '^- \\*\\*\\(If yes\\|If no\\|Risk\\|Head\\):' '$T/desc-$c'"
  check "...then a valid Task (task.mjs; Act t2-change, an activity of the system board's RACI)" bash -c "node '$T/taskcheck.mjs' '$SRC/template/bin/lib/task.mjs' '$SRC/template/profiles/system/leads/raci.json' <'$T/desc-$c' && grep -qx -- '- \\*\\*Act:\\*\\* t2-change' '$T/desc-$c'"
  check "...then the text as before (the request's line, the box's value in mm's frame)" bash -c "grep -q '^A request from the box of project \\*\\*acme-shop\\*\\*' '$T/desc-$c' && grep -q '^\\*\\*From the box\\*\\*' '$T/desc-$c'"
done
grep '"create"' "$T/bd.jsonl" | jq -c 'select(.[1] | test("asks for egress api.stripe.com")) | .[3]' | head -1 | jq -r . >"$T/desc-egress"
check "egress (t2, review's, no needs-you): unchanged, no owner card and no Task" bash -c "head -1 '$T/desc-egress' | grep -q '^A request from the box of project' && ! grep -q '^## \\(Owner\\|Task\\)' '$T/desc-egress'"

echo '== deny'
OUT=$(call "$S2" egress '{"site":"evil.example.com"}'); RD=$(echo "$OUT" | jq -r .id)
check "mm api deny: refused; the box sees refused; the item closed" bash -c "mm api deny $RD --why 'not needed' && [ \"\$(st $RD)\" = refused ] && call '$S2' egress '{\"site\":\"evil.example.com\"}' | jq -e '.status == \"refused\"'"

echo '== limits: 5 open requests, 10 calls an hour, per box'
serve   # the real limit (10); the calls so far are in the store, so they count
for i in 1 2 3 4; do call "$S2" egress "{\"site\":\"a$i.example.com\"}" >/dev/null; done
check "acme-other has 5 open requests: a 6th is refused (open-limit)" bash -c "call '$S2' egress '{\"site\":\"a6.example.com\"}' | jq -e '.why == \"open-limit\"'"
# acme-other's calls this hour: route shop, egress evil, a1..a4, a6 (asking again for evil was a repeat): 7; 3 more
for i in 1 2 3; do call "$S2" route '{"name":"BAD"}' >/dev/null; done
check "its 10 calls this hour are used: the next is refused (429, rate), even a good one" bash -c "[ \"\$(code '$S2' route '{\"name\":\"fine\"}')\" = 429 ] && call '$S2' route '{\"name\":\"fine\"}' | jq -e '.why == \"rate\"'"
check "...another box is not held up by it (acme-spare)" bash -c "call '$MM_HOME/box/acme-spare/api/api.sock' route '{\"name\":\"third\"}' | jq -e '.status == \"pending\"'"

echo '== undo, logs'
check "mm api undo a route: it goes from the router and the gateway's map" bash -c "mm api undo $RA && [ \"\$(st $RA)\" = undone ] && ! test -e '$T/routes/shop.acme-shop' && cd '$SRC' && bun -e \"import { hostClaims } from './src/auth.ts'; process.exit(hostClaims().routes['shop.acme-shop.example.test'] ? 1 : 0)\""
check "every call is logged with the socket's project (format refusals without the value)" bash -c "[ \$(grep -c '\"box\":\"acme-other\"' '$T/api.log') -ge 10 ] && grep '\"why\"\\|format' '$T/api.log' | grep -q value_len && ! grep -q 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' '$T/api.log'"
check "the store: 0600 in a 0700 folder" bash -c "[ \"\$(stat -c %a '$MM_HOME/api/api.db')\" = 600 ] && [ \"\$(stat -c %a '$MM_HOME/api/granted/acme-shop.json')\" = 600 ]"
echo '== the codes: only on the Telegram stand-in'
check "every code sent: in exactly one Telegram message, and in no item or board text, log line, or file of mm's or the projects'" bash -c "codes=\$(grep -o 'mmapi:allow:r-[0-9a-f]*:[A-Z2-7]*' '$T/tg.jsonl' | cut -d: -f4 | sort -u); [ \$(echo \"\$codes\" | wc -l) -ge 10 ] && for c in \$codes; do [ \"\$(grep -c \$c '$T/tg.jsonl')\" = 1 ] || exit 1; ! grep -raF \$c '$T/bd.jsonl' '$T/api.log' '$T/labels' '$T/routes' '$MM_HOME' '$HOME/projects' || exit 1; done"
check "...one code message for each request filed, and one more for mm api code" bash -c "[ \"\$(grep -o 'mmapi:allow:r-[0-9a-f]*' '$T/tg.jsonl' | sort -u | wc -l)\" = \"\$(items)\" ] && [ \"\$(grep -o 'mmapi:allow:r-[0-9a-f]*' '$T/tg.jsonl' | sort | uniq -c | awk '\$1 != 1 {print \$2}')\" = 'mmapi:allow:$RC' ]"
check "...the store keeps a code only as a slow hash (scrypt), and none for a decided request" bash -c "cd '$SRC' && bun -e \"import { Database } from 'bun:sqlite'; const d = new Database('$MM_HOME/api/api.db', { readonly: true }); const r = d.query('SELECT status, code FROM request').all(); process.exit(r.every((x) => x.code === null || (x.status === 'pending' && /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}\$/.test(x.code))) && r.some((x) => x.code) ? 0 : 1)\""
echo '== the code length: api.code_length (sy-64e7), on acme-spare'
S3="$MM_HOME/box/acme-spare/api/api.sock"; export S3
mkdir -p "$MM_HOME/box/acme-spare"; printf '{"services":{"app":{"public_port":38556}}}\n' >"$MM_HOME/box/acme-spare/ports.json"
# a wrong code of the same length: never the right one
other() { [ "$1" = "${1//A/B}" ] && echo "${1:0:-1}A" || echo "${1//A/B}"; }; export -f other
R8=$(call "$S3" route '{"name":"len-eight"}' | jq -r .id); H8=$(mm api show "$R8" -o json | jq -r .hash); C8=$(codeof "$R8")
check "the default (no setting): 8 characters" bash -c "[[ '$C8' =~ ^[A-Z2-7]{8}\$ ]]"
mm config set api.code_length 2
R2=$(call "$S3" route '{"name":"len-two"}' | jq -r .id); H2=$(mm api show "$R2" -o json | jq -r .hash); C2=$(codeof "$R2")
check "api.code_length 2: a new request's code has 2 characters, in the text and the Allow button" bash -c "[[ '$C2' =~ ^[A-Z2-7]{2}\$ ]] && grep 'mmapi:allow:$R2:$C2\"' '$T/tg.jsonl' | jq -e '.text | test(\"Code: $C2 \")'"
check "...a code sent before the change keeps its 8 characters, and works" bash -c "own -d '{\"id\":\"$R8\",\"hash\":\"$H8\",\"code\":\"$C8\"}' http://api/approve | jq -e .ok && [ \"\$(st $R8)\" = done ]"
check "...the 2-character code, typed in lower case through the owner's command: done" bash -c "echo '$C2' | tr A-Z a-z | mm api approve $R2 --hash ${H2:0:12} && [ \"\$(st $R2)\" = done ] && grep -qx 'port=38556 --sso' '$T/routes/len-two.acme-spare'"
RW=$(call "$S3" route '{"name":"len-wrong"}' | jq -r .id); HW=$(mm api show "$RW" -o json | jq -r .hash); CW=$(codeof "$RW"); XW=$(other "$CW")
check "...5 wrong 2-character codes: the code is void, and then even the right one applies nothing (409)" bash -c "[[ '$CW' =~ ^[A-Z2-7]{2}\$ ]] && [ '$XW' != '$CW' ] && for i in 1 2 3 4 5; do [ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RW\",\"hash\":\"$HW\",\"code\":\"$XW\"}' http://api/approve)\" = 403 ] || exit 1; done; [ \"\$(own -o /dev/null -w '%{http_code}' -d '{\"id\":\"$RW\",\"hash\":\"$HW\",\"code\":\"$CW\"}' http://api/approve)\" = 409 ] && [ \"\$(st $RW)\" = pending ] && ! test -e '$T/routes/len-wrong.acme-spare'"
for bad in 1 9 x; do
  mm config set api.code_length "$bad"
  RB_=$(call "$S3" route "{\"name\":\"len-bad-$bad\"}" | jq -r .id); CB_=$(codeof "$RB_")
  check "api.code_length $bad: the default (8 characters), and a warning in mm.api's log" bash -c "[[ '$CB_' =~ ^[A-Z2-7]{8}\$ ]] && grep '\"api.code_length is not 2..8' '$T/api.log' | jq -e 'select(.level == \"warn\" and .code_length == \"$bad\")' | grep -q ."
  mm api deny "$RB_" --why test >/dev/null
done
mm config unset api.code_length
rm "$MM_HOME/pc/boxes/acme-other.yaml"; sleep 1
check "a box gone from the registry: its socket goes" bash -c "! test -e '$S2'"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
