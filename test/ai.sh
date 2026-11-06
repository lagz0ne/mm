#!/usr/bin/env bash
# mm.ai, hermetic (sy-b15.10): a throwaway HOME and MM_HOME, a fake upstream (Anthropic's Messages API shape), a fake
# Telegram, curl as the box. Proves: one socket per registered box; a key works only on its own project's socket, and
# not when revoked or expired; the upstream gets the machine's key, never the box's; streams pass through and their
# usage is counted at the model's price; only the Messages API is served; budgets per project and per person stop new
# calls at 100 % and tell the owner at 80 % and 100 %; the cap on parallel calls; the machine's Claude token as the
# upstream credential (ai.upstream_key_input, ai.upstream_auth: oauth), and only the two allowed inputs; no key in any log.
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
  fs.appendFileSync(out, JSON.stringify({ path: req.url, key: req.headers['x-api-key'] || '', auth: req.headers.authorization || '', version: req.headers['anthropic-version'] || '', beta: req.headers['anthropic-beta'] || '', server_tool: b.includes('web_search') }) + '\n')
  // the machine's key as x-api-key; or (ai.upstream_auth: oauth) its Claude token as a Bearer, which, like the real API,
  // needs the oauth beta and no x-api-key
  const oauth = req.headers.authorization === 'Bearer oauth-standin-7' && (req.headers['anthropic-beta'] || '').split(',').includes('oauth-2025-04-20') && !req.headers['x-api-key']
  if (req.headers['x-api-key'] !== 'upstream-secret-1' && !oauth) { res.writeHead(401); return res.end('{"type":"error"}') }
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
check "a socket for each registered box (acme-shop, acme-other): 0660 in a 0750 folder (the owner and its group; review sy-b15.18)" bash -c "[ \"\$(stat -c %a '$S1')\" = 660 ] && [ \"\$(stat -c %a \"\$(dirname '$S1')\")\" = 750 ] && [ -S '$S2' ]"
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

echo "== the model's own way out: server-side tools (review sy-b15.18)"
# a request with one extra field, in a file (no shell quoting in the checks)
body() { printf '{"model":"claude-haiku-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}],%s}' "$2" >"$T/b-$1.json"; }
for t in web_search_20260209 web_fetch_20260209 code_execution_20260521 mcp_toolset; do body "$t" "\"tools\":[{\"type\":\"$t\",\"name\":\"x\"}]"; done
body mcp '"mcp_servers":[{"type":"url","url":"https://evil.example/mcp","name":"x"}]'; body container '"container":{"skills":[]}'
body local '"tools":[{"name":"mine","input_schema":{"type":"object"}},{"type":"custom","name":"c","input_schema":{"type":"object"}},{"type":"bash_20250124","name":"bash"},{"type":"text_editor_20250728","name":"str_replace_based_edit_tool"},{"type":"memory_20250818","name":"memory"}]'
printf 'not json' >"$T/b-bad.json"
N=$(wc -l <"$T/up.jsonl")
for t in web_search_20260209 web_fetch_20260209 code_execution_20260521 mcp_toolset; do
  check "a server tool, $t: 400, and it says how the owner allows it" bash -c "call '$S1' '$K1' -d @'$T/b-$t.json' http://ai/v1/messages | grep -q 'ai.server_tools'"
done
check "...mcp_servers and a container: 400; and a server tool on count_tokens too" bash -c "call '$S1' '$K1' -d @'$T/b-mcp.json' http://ai/v1/messages | grep -q mcp_servers && call '$S1' '$K1' -d @'$T/b-container.json' http://ai/v1/messages | grep -q container && call '$S1' '$K1' -d @'$T/b-web_search_20260209.json' http://ai/v1/messages/count_tokens | grep -q invalid_request_error"
check "...and none of them reached the upstream" bash -c "[ \$(wc -l <'$T/up.jsonl') = $N ]"
# "tools" twice: JS keeps the last (none), a provider may read the first (web search). The upstream gets what mm checked
printf '{"model":"claude-haiku-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20260209","name":"x"}],"tools":[]}' >"$T/b-twice.json"
check "a key twice (tools: a server tool, then none): the upstream gets the body mm checked, without the server tool (review sy-jm5 1)" bash -c "[ \"\$(code '$S1' '$K1' -d @'$T/b-twice.json' http://ai/v1/messages)\" = 200 ] && tail -1 '$T/up.jsonl' | grep -q '\"server_tool\":false'"
check "...and a body that is JSON but not an object: 400, never sent" bash -c "N=\$(wc -l <'$T/up.jsonl'); [ \"\$(code '$S1' '$K1' -d '[1,2]' http://ai/v1/messages)\" = 400 ] && [ \"\$(code '$S1' '$K1' -d '\"x\"' http://ai/v1/messages)\" = 400 ] && [ \$(wc -l <'$T/up.jsonl') = \$N ]"
check "tools that run in the box pass: the caller's own, custom, bash, text editor, memory" bash -c "[ \"\$(code '$S1' '$K1' -d @'$T/b-local.json' http://ai/v1/messages)\" = 200 ]"
check "a beta that turns on provider-side egress is dropped; the others pass" bash -c "call '$S1' '$K1' -H 'anthropic-beta: interleaved-thinking-2025-05-14,mcp-client-2025-11-20,code-execution-2025-08-25,files-api-2025-04-14' -d '$MSG' http://ai/v1/messages >/dev/null && tail -1 '$T/up.jsonl' | grep -q '\"beta\":\"interleaved-thinking-2025-05-14\"'"
printf 'ai:\n  enabled: true\n  upstream: http://127.0.0.1:%s\n  max_parallel: 2\n  server_tools:\n    acme-shop: [web_search]\ntelegram:\n  owner_id: "4242"\n' "$UPP" >"$MM_HOME/config.yaml"
check "the owner allows web_search for acme-shop (ai.server_tools): it passes there; web_fetch still doesn't; nor does web_search elsewhere" bash -c "[ \"\$(code '$S1' '$K1' -d @'$T/b-web_search_20260209.json' http://ai/v1/messages)\" = 200 ] && [ \"\$(code '$S1' '$K1' -d @'$T/b-web_fetch_20260209.json' http://ai/v1/messages)\" = 400 ] && [ \"\$(code '$S2' '$K2' -d @'$T/b-web_search_20260209.json' http://ai/v1/messages)\" = 400 ]"
check "a body that isn't JSON: 400" bash -c "[ \"\$(code '$S1' '$K1' -d @'$T/b-bad.json' http://ai/v1/messages)\" = 400 ]"

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

echo "== the machine's Claude token upstream, for now (ai.upstream_key_input: claude-oauth-token, ai.upstream_auth: oauth)"
cfg() { printf 'ai:\n  enabled: true\n  upstream: http://127.0.0.1:%s\n  max_parallel: 2\n%btelegram:\n  owner_id: "4242"\n' "$UPP" "$1" >"$MM_HOME/config.yaml"; }
last() { tail -1 "$T/up.jsonl" | jq -e "$1" >/dev/null; }
sonnet_calls() { mm ai usage -o json | jq '[.[0].rows[] | select(.project=="acme-shop" and .model=="claude-sonnet-5-5") | .calls] | add // 0'; }
TOK="$HOME/.config/secrets/claude-oauth.token"; printf 'oauth-standin-7' >"$TOK"; chmod 600 "$TOK"
need_na() { bun -e "import { needs } from '$SRC/src/inputs.ts'; import { loadConfig } from '$SRC/src/config.ts'; process.exit(needs([], loadConfig()).find((n) => n.name === 'ai-upstream-key')?.status === 'n/a' ? 0 : 1)"; }
needed() { ! need_na; }
check "by default the upstream key is a needed input (ai.enabled)" needed
C0=$(sonnet_calls)
cfg '  upstream_key_input: claude-oauth-token\n  upstream_auth: oauth\n'
check "...not when mm.ai uses the machine's Claude token (the manifest's when)" need_na
check "a call with the box's key: 200 (the stand-in takes the token only as a Bearer, with the oauth beta)" bash -c "[ \"\$(code '$S1' '$K1' -d '$MSG' http://ai/v1/messages)\" = 200 ]"
check "...the upstream saw: Bearer <the stand-in token>, no x-api-key" last '.auth == "Bearer oauth-standin-7" and .key == ""'
check "...and anthropic-beta: oauth-2025-04-20 (the API needs it for this kind of token)" last '.beta == "oauth-2025-04-20"'
call "$S1" "$K1" -H 'anthropic-beta: interleaved-thinking-2025-05-14, oauth-2025-04-20,mcp-client-2025-11-20' -d "$MSG" http://ai/v1/messages >/dev/null
check "the client's own betas: kept (the egress ones still dropped), oauth-2025-04-20 there once" last '(.beta | split(",")) as $b | ($b | map(select(. == "oauth-2025-04-20")) | length) == 1 and ($b | index("interleaved-thinking-2025-05-14")) != null and ($b | index("mcp-client-2025-11-20")) == null'
call "$S1" "$K1" -H 'anthropic-beta: interleaved-thinking-2025-05-14' -d "$MSG" http://ai/v1/messages >/dev/null
check "...and added to the client's betas when it sent none of its own" last '.beta == "interleaved-thinking-2025-05-14,oauth-2025-04-20"'
check "the box's key as a Bearer (ANTHROPIC_AUTH_TOKEN): the upstream still gets only the machine's token" bash -c "[ \"\$(curl -s --unix-socket '$S1' -H 'authorization: Bearer $K1' -H 'x-api-key: $K1' -o /dev/null -w '%{http_code}' -d '$MSG' http://ai/v1/messages)\" = 200 ] && tail -1 '$T/up.jsonl' | jq -e '.auth == \"Bearer oauth-standin-7\" and .key == \"\"' && ! grep -q mmk_ '$T/up.jsonl'"
check "a stream passes, and the calls show in mm usage as before" bash -c "call '$S1' '$K1' -N -d '$STREAM' http://ai/v1/messages | grep -q 'hello from upstream' && sleep 0.3 && [ \"\$(mm ai usage -o json | jq '[.[0].rows[] | select(.project==\"acme-shop\" and .model==\"claude-sonnet-5-5\") | .calls] | add')\" = $((C0 + 4)) ]"
mv "$TOK" "$T/tok"
check "no Claude token on the machine: 503, it names claude-oauth-token" bash -c "call '$S1' '$K1' -d '$MSG' http://ai/v1/messages | grep -q 'mm fill claude-oauth-token'"
mv "$T/tok" "$TOK"
N=$(wc -l <"$T/up.jsonl")
cfg '  upstream_key_input: telegram-bot-token\n  upstream_auth: oauth\n'
check "another machine input (telegram-bot-token) as ai.upstream_key_input: refused (503, says which are allowed), nothing sent" bash -c "call '$S1' '$K1' -d '$MSG' http://ai/v1/messages | grep -q 'may only be ai-upstream-key or claude-oauth-token' && [ \$(wc -l <'$T/up.jsonl') = $N ]"
mkdir -p "$T/bad/pc/boxes"; echo "# x" >"$T/bad/pc/boxes/acme-bad.yaml"
printf 'ai:\n  enabled: true\n  upstream_key_input: /some/free/path\n' >"$T/bad/config.yaml"
MM_HOME="$T/bad" timeout 20 mm ai serve >"$T/bad.log" 2>&1; BADRC=$?
check "a free path as ai.upstream_key_input: mm.ai refuses to start, with a clear log line (and no socket, no store)" bash -c "[ $BADRC != 0 ] && [ $BADRC != 124 ] && grep -q 'refused to start' '$T/bad.log' && grep -q 'may only be' '$T/bad.log' && ! grep -q /some/free/path '$T/bad.log' && ! test -e '$T/bad/box' && ! test -e '$T/bad/ai'"
cfg ''
check "back to the default: the upstream gets the machine's key as x-api-key, no Authorization, no oauth beta" bash -c "[ \"\$(code '$S1' '$K1' -d '$MSG' http://ai/v1/messages)\" = 200 ] && tail -1 '$T/up.jsonl' | jq -e '.key == \"upstream-secret-1\" and .auth == \"\" and .beta == \"\"'"
cfg '  upstream_auth: bearer\n'
check "...and ai.upstream_auth: bearer is as before (Bearer <the machine's key>, no oauth beta)" bash -c "call '$S1' '$K1' -d '$MSG' http://ai/v1/messages >/dev/null; tail -1 '$T/up.jsonl' | jq -e '.auth == \"Bearer upstream-secret-1\" and .key == \"\" and .beta == \"\"'"
cfg ''

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
check "no key in the gateway's log (box keys, the upstream key)" bash -c "! grep -qE 'mmk_|upstream-secret-1|oauth-standin-7' '$T/ai.log' && grep -q '\"msg\":\"call\"' '$T/ai.log'"
check "the store is 0600 in a 0700 folder" bash -c "[ \"\$(stat -c %a '$MM_HOME/ai')\" = 700 ] && [ \"\$(stat -c %a '$MM_HOME/ai/ai.db')\" = 600 ]"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
