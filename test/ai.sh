#!/usr/bin/env bash
# mm.ai, hermetic (sy-b15.10): a throwaway HOME and MM_HOME, a fake upstream (Anthropic's Messages API shape), a fake
# Telegram, curl as the box. Proves: one socket per registered box; a key works only on its own project's socket, and
# not when revoked or expired; the upstream gets the machine's key, never the box's; streams pass through and their
# usage is counted at the model's price; only the Messages API is served; budgets per project and per person stop new
# calls at 100 % and tell the owner at 80 % and 100 %; the cap on parallel calls; no key in any log.
#   test/ai.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); GW=""; UP=""; TG=""; trap '[ -n "$GW" ] && kill $GW 2>/dev/null; [ -n "$UP" ] && kill $UP 2>/dev/null; [ -n "$TG" ] && kill $TG 2>/dev/null; rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
mkdir -p "$MM_HOME/pc/boxes" "$HOME/.config/secrets" "$HOME/brain/.keys"
UPP=$(( 39100 + RANDOM % 800 )); TGP=$(( UPP + 3 ))
printf 'ai:\n  enabled: true\n  upstream: http://127.0.0.1:%s\n  max_parallel: 2\ntelegram:\n  owner_id: "4242"\n' "$UPP" >"$MM_HOME/config.yaml"
printf 'upstream-secret-1' >"$HOME/.config/secrets/ai-upstream.key"; chmod 600 "$HOME/.config/secrets/ai-upstream.key"
printf 'test-bot-token-9911' >"$HOME/brain/.keys/.telebot"; chmod 600 "$HOME/brain/.keys/.telebot"
# the fake upstream: records each request's path and auth headers; streams when asked; model "slow" answers after 3 s
cat >"$T/up.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', async () => {
  fs.appendFileSync(out, JSON.stringify({ path: req.url, key: req.headers['x-api-key'] || '', auth: req.headers.authorization || '', version: req.headers['anthropic-version'] || '' }) + '\n')
  if (req.headers['x-api-key'] !== 'upstream-secret-1') { res.writeHead(401); return res.end('{"type":"error"}') }
  const j = b ? JSON.parse(b) : {}
  if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":42}') }
  if (j.model === 'slow') await new Promise((r) => setTimeout(r, 3000))
  if (j.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`)
    ev('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100, output_tokens: 1 } } })
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello from upstream' } })
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } })
    ev('message_stop', { type: 'message_stop' }); return res.end()
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: 'msg_2', model: j.model === 'slow' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 10 } }))
}) }).listen(Number(port), '127.0.0.1')
EOF
cat >"$T/tg.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { fs.appendFileSync(out, b + '\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) }).listen(Number(port), '127.0.0.1')
EOF
node "$T/up.mjs" $UPP "$T/up.jsonl" & UP=$!
node "$T/tg.mjs" $TGP "$T/tg.jsonl" & TG=$!
export MM_TELEGRAM_API="http://127.0.0.1:$TGP"
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
# two boxes, registered as mm up does it
for p in acme-shop acme-other; do echo "# from $T/$p/services.yaml" >"$MM_HOME/pc/boxes/$p.yaml"; done
mm ai serve >"$T/ai.log" 2>&1 & GW=$!
S1="$MM_HOME/box/acme-shop/ai/ai.sock"; S2="$MM_HOME/box/acme-other/ai/ai.sock"
for _ in $(seq 1 100); do [ -S "$S1" ] && [ -S "$S2" ] && break; sleep 0.2; done
# keys, as mm up makes them (the CLI never prints one)
key() { bun -e "import { store, mintKey } from '$SRC/src/ai.ts'; const d = store(); console.log(mintKey(d, '$1', { person: '${2:-}' }).key)"; }
K1=$(key acme-shop); K2=$(key acme-other); KA=$(key acme-other alex)
call() { local s=$1 k=$2; shift 2; curl -s --unix-socket "$s" -H "x-api-key: $k" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' "$@"; }
code() { local s=$1 k=$2; shift 2; call "$s" "$k" -o /dev/null -w '%{http_code}' "$@"; }
MSG='{"model":"claude-sonnet-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
STREAM='{"model":"claude-opus-5-5","max_tokens":10,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
usage_json() { mm ai usage -o json; }
export -f call code; export S1 S2 K1 K2 KA MSG STREAM T

echo '== one socket per box'
check "a socket for each registered box (acme-shop, acme-other), 0666 in the box's own folder" bash -c "[ \"\$(stat -c %a '$S1')\" = 666 ] && [ -S '$S2' ]"
check "...and no TCP port: the gateway listens on nothing else" bash -c "! ss -Hltnp 2>/dev/null | grep -q \"pid=$GW,\""

echo '== keys'
check "no key: 401" bash -c "[ \"\$(curl -s --unix-socket '$S1' -o /dev/null -w '%{http_code}' -d '$MSG' http://ai/v1/messages)\" = 401 ]"
check "a wrong key: 401" bash -c "[ \"\$(code '$S1' mmk_wrong -d '$MSG' http://ai/v1/messages)\" = 401 ]"
check "acme-other's key on acme-shop's socket: 401 (the socket names the project, not the key)" bash -c "[ \"\$(code '$S1' '$K2' -d '$MSG' http://ai/v1/messages)\" = 401 ]"
check "the box's own key: 200, the upstream's answer" bash -c "call '$S1' '$K1' -d '$MSG' http://ai/v1/messages | grep -q '\"text\":\"hi\"'"
check "...a Bearer header works too (ANTHROPIC_AUTH_TOKEN)" bash -c "[ \"\$(curl -s --unix-socket '$S1' -H 'authorization: Bearer $K1' -o /dev/null -w '%{http_code}' -d '$MSG' http://ai/v1/messages)\" = 200 ]"
check "the upstream got the machine's key and the API version, never a box's key" bash -c "tail -1 '$T/up.jsonl' | grep -q '\"key\":\"upstream-secret-1\"' && grep -q '\"version\":\"2023-06-01\"' '$T/up.jsonl' && ! grep -q mmk_ '$T/up.jsonl'"

echo '== what is served'
check "a stream passes through as it comes (SSE, the text)" bash -c "call '$S1' '$K1' -N -d '$STREAM' http://ai/v1/messages | grep -q 'hello from upstream'"
check "count_tokens passes (and is not counted as use)" bash -c "call '$S1' '$K1' -d '$MSG' http://ai/v1/messages/count_tokens | grep -q '\"input_tokens\":42'"
N=$(wc -l <"$T/up.jsonl")
check "anything else (batches, the old completions API, files): 404, and never reaches the upstream" bash -c "for u in /v1/messages/batches /v1/complete /v1/files /admin; do [ \"\$(code '$S1' '$K1' -d '{}' http://ai\$u)\" = 404 ] || exit 1; done; [ \$(wc -l <'$T/up.jsonl') = $N ]"

echo '== use and cost'
sleep 0.3
check "the stream's use is counted at Opus 5.5's price (1000 in, 500 out, 2000 cache read, 100 cache write = \$0.0149)" bash -c "mm ai usage -o json | jq -e '.[0].rows[] | select(.project==\"acme-shop\" and .model==\"claude-opus-5-5\") | .input==1000 and .output==500 and .cache_read==2000 and .cache_write==100 and .usd==0.0149'"
check "...and the plain answers at Sonnet 5.5's (2 calls: 200 in, 20 out = \$0.0006)" bash -c "mm ai usage -o json | jq -e '.[0].rows[] | select(.project==\"acme-shop\" and .model==\"claude-sonnet-5-5\") | .calls==2 and .usd==0.0006'"
check "a model with no price is counted at the dearest (never under-counted)" bash -c "bun -e \"import { cost } from '$SRC/src/ai.ts'; process.exit(cost('some-new-model', { input: 1e6, output: 0, cache_read: 0, cache_write: 0 }) === 10 ? 0 : 1)\""

echo '== budgets'
check "an agent may not set a budget (the owner's to allow)" bash -c "! CLAUDECODE=1 mm ai budget acme-shop 100"
check "mm ai budget acme-other 1 --person alex 0.001" bash -c "mm ai budget acme-other 1 && mm ai budget acme-other 0.001 --person alex"
check "alex's first call goes through, the next is refused: his budget is used up (403, says so)" bash -c "[ \"\$(code '$S2' '$KA' -d '$STREAM' http://ai/v1/messages)\" = 200 ] && sleep 0.3 && call '$S2' '$KA' -d '$MSG' http://ai/v1/messages | grep -q 'budget of alex in acme-other is used up'"
check "...while the project's own work still goes through (its budget isn't used up)" bash -c "[ \"\$(code '$S2' '$K2' -d '$MSG' http://ai/v1/messages)\" = 200 ]"
check "...and the owner was told, once, that alex reached his" bash -c "[ \$(grep -c 'AI budget reached: alex in acme-other' '$T/tg.jsonl') = 1 ] && grep -q '\"chat_id\":\"4242\"' '$T/tg.jsonl'"
mm ai budget acme-shop 0.02 >/dev/null
call "$S1" "$K1" -N -d "$STREAM" http://ai/v1/messages >/dev/null; sleep 0.3
check "acme-shop over its \$0.02: the owner hears 100 % (one notice, the higher one), and the next call is refused" bash -c "grep -q 'AI budget reached: acme-shop used' '$T/tg.jsonl' && [ \"\$(code '$S1' '$K1' -d '$MSG' http://ai/v1/messages)\" = 403 ]"
check "mm usage: the month, with each budget and what is spent" bash -c "mm usage -o json | jq -e '.[0].budgets[] | select(.project==\"acme-shop\" and .person==\"\") | .usd==0.02 and .spent>0.02'"
mm ai budget acme-shop 0 >/dev/null
check "the budget removed: calls go through again" bash -c "[ \"\$(code '$S1' '$K1' -d '$MSG' http://ai/v1/messages)\" = 200 ]"

echo '== the cap on parallel calls (ai.max_parallel 2)'
SLOW='{"model":"slow","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
SP=""; for i in 1 2; do code "$S1" "$K1" -d "$SLOW" http://ai/v1/messages >"$T/slow$i" & SP="$SP $!"; done; sleep 0.8
check "a third call while two run: 429 with retry-after (Claude Code waits and tries again)" bash -c "curl -s --unix-socket '$S1' -H 'x-api-key: $K1' -D - -o /dev/null -d '$SLOW' http://ai/v1/messages | grep -qi '^retry-after: 5'"
check "...another project isn't held up by it" bash -c "[ \"\$(code '$S2' '$K2' -d '$MSG' http://ai/v1/messages)\" = 200 ]"
wait $SP; check "...and the two slow ones finish" bash -c "[ \"\$(cat '$T/slow1')\" = 200 ] && [ \"\$(cat '$T/slow2')\" = 200 ]"

echo '== keys end'
check "mm ai revoke acme-shop: its keys stop at once" bash -c "mm ai revoke acme-shop | grep -q 'key(s) ended' && [ \"\$(code '$S1' '$K1' -d '$MSG' http://ai/v1/messages)\" = 401 ]"
bun -e "import { store } from '$SRC/src/ai.ts'; store().run('UPDATE ai_key SET expires = 1 WHERE project = ? AND person = ?', ['acme-other', ''])"
check "an expired key: 401" bash -c "[ \"\$(code '$S2' '$K2' -d '$MSG' http://ai/v1/messages)\" = 401 ]"
K3=$(key acme-shop); mv "$HOME/.config/secrets/ai-upstream.key" "$T/upkey"
check "no upstream key on the machine: 503, it says what to fill" bash -c "call '$S1' '$K3' -d '$MSG' http://ai/v1/messages | grep -q 'mm fill ai-upstream-key'"
mv "$T/upkey" "$HOME/.config/secrets/ai-upstream.key"
rm "$MM_HOME/pc/boxes/acme-other.yaml"; sleep 6
check "a box gone from the registry: its socket goes" bash -c "! test -e '$S2'"

echo '== logs'
check "no key in the gateway's log (box keys, the upstream key)" bash -c "! grep -qE 'mmk_|upstream-secret-1' '$T/ai.log' && grep -q '\"msg\":\"call\"' '$T/ai.log'"
check "the store is 0600 in a 0700 folder" bash -c "[ \"\$(stat -c %a '$MM_HOME/ai')\" = 700 ] && [ \"\$(stat -c %a '$MM_HOME/ai/ai.db')\" = 600 ]"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
