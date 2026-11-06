#!/usr/bin/env bash
# A project box on this machine (plans/project-box.md, M1-A + B): `mm box build`, then a throwaway project made with
# `mm new --box`. Its services run in the box; the box is a normal user with no sudo and no capabilities; its root is
# read-only and so is everything that decides what it may do; its only way out is its own egress proxy, which lets
# through only its list. `mm archive` removes it all. Nothing outside the throwaway project and its containers changes.
#   MM_DOCKER="sudo -n docker" test/box.sh [client/name]
set -uo pipefail
REF=${1:-qa/boxt}; PROJECT=${REF/\//-}
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
. "$(dirname "$0")/lib/routes.sh"   # this run's routes in its own folder, never in the live web proxy (review sy-uzh)
export MM_DOCKER=${MM_DOCKER:-docker}
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/tmp/box-test.out 2>&1; then ok "$d"; else bad "$d"; tail -3 /tmp/box-test.out | sed 's/^/       /'; fi; }
BOX=mm-box-$PROJECT; PX=mm-egress-$PROJECT; NET=mm-net-$PROJECT; MM_HOME_DIR=${MM_HOME:-$HOME/.mm}
D() { $MM_DOCKER "$@"; }
IN() { D exec "$BOX" sh -c "umask 002; $*"; }   # as mm shell does
cleanup() { [ -n "${AIGW:-}" ] && kill $AIGW 2>/dev/null; [ -n "${APIGW:-}" ] && kill $APIGW 2>/dev/null; [ -n "${TGPID:-}" ] && kill $TGPID 2>/dev/null; [ -n "${SYSPID:-}" ] && kill $SYSPID 2>/dev/null; [ -n "${AIUP:-}" ] && kill $AIUP 2>/dev/null; [ -n "${AIT:-}" ] && rm -rf "$AIT"
  [ -n "${KEEP:-}" ] && return; mm archive "$REF" >/dev/null 2>&1; [ -n "${BKP:-}" ] && rm -rf "$BKP"; [ -n "${CAN:-}" ] && rm -rf "$CAN"; D rm -f "$BOX" "$PX" >/dev/null 2>&1; D network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
export -f D IN; export BOX PX NET MM_DOCKER
# mm's AI gateway for this test only (sy-b15.10): its own store, a fake upstream that answers like the Messages API,
# and the machine's config untouched (MM_AI_*: src/ai.ts). The box gets its key at mm up.
AIT=$(mktemp -d); AIUPP=$(( 39100 + RANDOM % 800 ))
export MM_AI_ENABLED=1 MM_AI_DIR="$AIT/store" MM_AI_UPSTREAM="http://127.0.0.1:$AIUPP" MM_AI_UPSTREAM_KEY_FILE="$AIT/upstream.key"
printf 'upstream-secret-qa' >"$AIT/upstream.key"; chmod 600 "$AIT/upstream.key"
cat >"$AIT/up.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  fs.appendFileSync(out, JSON.stringify({ path: req.url, key: req.headers['x-api-key'] || '' }) + '\n')
  if (req.headers['x-api-key'] !== 'upstream-secret-qa') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}') }
  if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}') }
  let j = {}; try { j = JSON.parse(b) } catch {}
  const model = j.model || 'claude-opus-5-5', text = 'QA-GATEWAY-ANSWER'
  const msg = { id: 'msg_qa', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } }
  if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 5 } })) }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`)
  ev('message_start', { message: msg }); ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }); ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }); ev('message_stop', {}); res.end()
}) }).listen(Number(port), '127.0.0.1')
EOF
node "$AIT/up.mjs" $AIUPP "$AIT/up.jsonl" & AIUP=$!
mm ai serve >"$AIT/ai.log" 2>&1 & AIGW=$!
# mm's project API for this test only (sy-b15.8): its own store and owner socket, a stand-in for the system board (no
# item on the live one), the owner's notices to a Telegram stand-in that keeps only the message bodies (each request's
# one-time code, sy-35f2: this test approves with it), and this test's box only (MM_API_*: src/api.ts).
# The box gets its socket at mm up; its app slot runs only a build approved here.
TGP=$(( AIUPP + 11 ))
cat >"$AIT/tg.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs'
const [port, out] = process.argv.slice(2)
http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { fs.appendFileSync(out, b + '\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) }).listen(Number(port), '127.0.0.1')
EOF
node "$AIT/tg.mjs" $TGP "$AIT/tg.jsonl" & TGPID=$!
export MM_API_ENABLED=1 MM_API_DIR="$AIT/api" MM_API_BD="$AIT/fakebd" MM_API_FAKE_DIR="$AIT" MM_API_ONLY="$PROJECT" MM_API_SYNC_MS=500 MM_TELEGRAM_API=http://127.0.0.1:$TGP
# a request's code, as the owner got it (the stand-in); `CODE <id> | mm api approve <id> --hash <hash>` approves with it
CODE() { for _ in $(seq 1 50); do c=$(grep -o "mmapi:allow:$1:[A-Z2-7]\{8\}" "$AIT/tg.jsonl" 2>/dev/null | tail -1 | cut -d: -f4); [ -n "$c" ] && { echo "$c"; return; }; sleep 0.2; done; }
export -f CODE; export AIT
cat >"$AIT/fakebd" <<'EOF'
#!/usr/bin/env node
const fs = require('fs'), T = process.env.MM_API_FAKE_DIR, a = process.argv.slice(2)
fs.appendFileSync(`${T}/bd.jsonl`, JSON.stringify(a) + '\n')
const lf = (id) => `${T}/labels-${id}`
if (a[0] === 'create') { const n = (fs.existsSync(`${T}/bd.n`) ? Number(fs.readFileSync(`${T}/bd.n`, 'utf8')) : 0) + 1; fs.writeFileSync(`${T}/bd.n`, String(n)); console.log(JSON.stringify({ id: `qa-${n}` })) }
else if (a[0] === 'show') console.log(JSON.stringify([{ id: a[1], labels: fs.existsSync(lf(a[1])) ? fs.readFileSync(lf(a[1]), 'utf8').split('\n').filter(Boolean) : [] }]))
else if (a[0] === 'label' && a[1] === 'add') fs.appendFileSync(lf(a[2]), a[3] + '\n')
EOF
chmod +x "$AIT/fakebd"
mm api serve >"$AIT/api.log" 2>&1 & APIGW=$!
# a call from the box on its own socket (the box's user, docker exec with no shell in between)
APICALL() { D exec "$BOX" curl -s --unix-socket /run/mm/api/api.sock -X POST -H 'content-type: application/json' -d "$2" "http://api/$1"; }
export -f APICALL
# a throwaway machine Paseo (the live one is never touched): mm up joins the box to it (sy-9q1)
SYSP=$(( AIUPP + 7 )); export MM_PASEO_JOIN_HOME="$AIT/sys"; mkdir -p "$MM_PASEO_JOIN_HOME"
PASEO_HOME="$MM_PASEO_JOIN_HOME" PASEO_LISTEN="127.0.0.1:$SYSP" PASEO_RELAY_ENABLED=false PASEO_WEB_UI_ENABLED=false paseo daemon run >"$AIT/sys.log" 2>&1 & SYSPID=$!
SP() { paseo --home "$MM_PASEO_JOIN_HOME" "$@"; }
for _ in $(seq 1 60); do SP ls --json >/dev/null 2>&1 && break; sleep 1; done
joined() { SP host ls --json 2>/dev/null | jq -r --arg p "$PROJECT" '.[] | select(.label == $p) | .status' | head -1; }
export -f SP joined; export PROJECT

echo "== the images"
check "mm box build: the box image and the egress proxy image" mm box build
echo "== a box project"
mm new "$REF" --throwaway --box >/tmp/box-new.out 2>&1 || { tail -15 /tmp/box-new.out; exit 1; }
ROOT=$(mm ls -o json | jq -r --arg p "$PROJECT" '.[] | select(.project == $p) | .root' | sed "s|^~|$HOME|")
[ -n "$ROOT" ] || ROOT=$(sed -n 's/^root: //p' "$HOME/projects/$REF/.mm-answers.yaml" 2>/dev/null)
check "mm new --box: box: true in the answers" grep -qx 'box: true' "$ROOT/.mm-answers.yaml"
for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
check "the services run in the box (dolt, bd-serve, board ready)" sh -c "mm inspect '$REF' | grep -q 'dolt .*Ready' && mm inspect '$REF' | grep -q 'bd-serve .*Ready' && mm inspect '$REF' | grep -q 'board .*Ready'"
check "...and not on the host's process manager" sh -c "! process-compose -U -u $HOME/.mm/pc.sock process list -o json | jq -e '.[] | select(.name | startswith(\"$PROJECT.\"))'"
check "the board answers inside the box (by its name)" IN "curl -sf -o /dev/null http://board.$PROJECT.localhost:1355/api/whoami"
check "...and every program resolves those names, not only curl (Node: bd-serve.$PROJECT.localhost is 127.0.0.1)" IN "node -e \"require('dns').lookup('bd-serve.$PROJECT.localhost',{family:4},(e,a)=>process.exit(e||a!=='127.0.0.1'?1:0))\""
sleep 10   # wake's first board call comes a few seconds after the board is ready
check "wake runs in the box (Running, no restarts)" sh -c "mm inspect '$REF' | awk '\$1==\"wake\"' | grep -qE 'Running +[^ ]+ +0( |\$)'"
check "bd works in the box (an item, over Dolt's socket)" IN "cd $ROOT && bin/bd create 'made in the box' --json | grep -q '\"id\"'"

echo "== the box user"
check "its own uid (200000+), not root and not the host's owner (uid $(id -u), who has sudo) (review sy-b15.15 1)" sh -c "u=\$(IN 'id -u'); [ \"\$u\" -ge 200000 ] && [ \"\$u\" != '$(id -u)' ]"
check "...a named user in the box (its own passwd: bd and Node can look it up)" sh -c "IN 'id -un' | grep -qx box && IN 'node -e \"console.log(require(\\\"os\\\").userInfo().homedir)\"' | grep -qx '$HOME'"
check "a file the box makes: the box's uid, the host's group, group-writable; the host can still change and remove it" sh -c "IN 'touch $ROOT/memory/.own-probe' && [ \"\$(stat -c %u '$ROOT/memory/.own-probe')\" -ge 200000 ] && [ \"\$(stat -c %g '$ROOT/memory/.own-probe')\" = '$(id -g)' ] && stat -c %A '$ROOT/memory/.own-probe' | grep -q '^-...rw' && echo x >> '$ROOT/memory/.own-probe' && rm '$ROOT/memory/.own-probe'"
check "no sudo" sh -c "! IN 'sudo -n true'"
check "no capabilities (CapEff all zero)" sh -c "IN 'grep CapEff /proc/self/status' | grep -q '0000000000000000'"
check "no new privileges" sh -c "IN 'grep NoNewPrivs /proc/self/status' | grep -q '1'"
check "no Docker socket" sh -c "! IN 'test -e /var/run/docker.sock'"

echo "== mm shell (a command, or a shell, in the box as the box user)"
check "mm shell $REF id -u: the box user, not the host's owner" sh -c "u=\$(mm shell '$REF' id -u </dev/null); [ \"\$u\" -ge 200000 ] && [ \"\$u\" != '$(id -u)' ]"
check "...in the project folder, with umask 002" sh -c "[ \"\$(mm shell '$REF' pwd </dev/null)\" = '$ROOT' ] && [ \"\$(mm shell '$REF' sh -c umask </dev/null)\" = 0002 ]"
check "...with the services' environment (project, Paseo, the box's proxy)" sh -c "o=\$(mm shell '$REF' env </dev/null); echo \"\$o\" | grep -qx 'MM_PROJECT=$PROJECT' && echo \"\$o\" | grep -qx 'PASEO_HOME=$MM_HOME_DIR/paseo/$PROJECT' && echo \"\$o\" | grep -qx 'HTTPS_PROXY=http://$PX:8888'"
check "...bd works from it (the board's items)" sh -c "mm shell '$REF' bin/bd list --json </dev/null | grep -q 'made in the box'"
check "...its options are the command's, even the names mm uses itself (-q, -o, --json)" sh -c "[ \"\$(mm shell '$REF' printf '%s|' -q -o json --json </dev/null)\" = '-q|-o|json|--json|' ]"
check "...and its exit code comes back" sh -c "mm shell '$REF' sh -c 'exit 7' </dev/null; [ \$? = 7 ]"

echo "== what the box may write"
check "the root file system is read-only" sh -c "! IN 'touch /usr/x'"
check "the project folder is writable (memory/, the board's data)" IN "touch $ROOT/memory/.box-probe && rm $ROOT/memory/.box-probe"
for f in services.yaml .mm-answers.yaml secrets.json tools.json bin/land site/package.json .git/config; do
  check "read-only in the box: $f" sh -c "! IN 'echo x >> $ROOT/$f' && ! grep -q '^x\$' '$ROOT/$f'"
done
HD="$MM_HOME_DIR/box/$PROJECT"
check "read-only in the box: its process-compose file (/run/mm/cfg, kept by mm outside the project)" sh -c "! IN 'echo x >> /run/mm/cfg/pc.yaml' && ! grep -q '^x\$' '$HD/cfg/pc.yaml'"

echo "== what the box can't change around its read-only files (review sy-b15.6 2)"
CAN=$(mktemp -d /tmp/mm-canary.XXXXXX); echo "canary-$$-text" > "$CAN/config"; mkdir "$CAN/hooks"; chmod 755 "$CAN"; chmod 644 "$CAN/config"
check "the project's top level is the host's: the box can't add to it, or rename .git or bin away" sh -c "! IN 'touch $ROOT/.new-top' && ! IN 'mv $ROOT/.git $ROOT/.git-moved' && ! IN 'mv $ROOT/bin $ROOT/bin-moved' && ! IN 'ln -s $CAN/config $ROOT/governance2.json' && test -d '$ROOT/.git' && test -d '$ROOT/bin'"
if [ -d "$ROOT/code/.git" ]; then
  # code/ is the box's (its product repo): it can move code/.git away, around its read-only hooks and config
  IN "mv $ROOT/code/.git $ROOT/code/.git-real && ln -s $CAN $ROOT/code/.git" >/dev/null 2>&1
  check "a symlink the box planted on the way to a read-only file: the next mm up refuses it, and mounts nothing of it" sh -c "! mm up '$REF' >/tmp/box-up-link.out 2>&1 && grep -q 'goes through a symlink' /tmp/box-up-link.out && ! D inspect '$BOX' >/dev/null 2>&1"
  { rm "$ROOT/code/.git" && mv "$ROOT/code/.git-real" "$ROOT/code/.git"; } || bad "put code/.git back"
  mm up "$REF" >/tmp/box-up-again.out 2>&1 || { bad "mm up again"; tail -5 /tmp/box-up-again.out; }
  for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
fi
IN "rm -f $ROOT/.run/services.json && ln -s $CAN/config $ROOT/.run/services.json && ln -s $CAN/config $ROOT/.run/logs/leak.log" >/dev/null 2>&1
IN "printf '%s\n' '{\"project\":\"another-project\",\"level\":\"error\",\"msg\":\"forged-$$\"}' >> $ROOT/.run/logs/forge.log" >/dev/null 2>&1
check "a run file the box made a symlink: mm up writes the file itself, not through the link" sh -c "mm up '$REF' >/tmp/box-up-run.out 2>&1; grep -qx 'canary-$$-text' '$CAN/config' && [ ! -L '$ROOT/.run/services.json' ] && jq -e .services '$ROOT/.run/services.json' >/dev/null"
for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
mm ship --dry-run > /tmp/box-ship.out 2>&1
check "the shipper: a box's log that is a symlink is not read (the canary's text is not shipped)" sh -c "! grep -q 'canary-$$-text' /tmp/box-ship.out"
check "...and a box's line naming another project is shipped as the box's own" sh -c "grep 'forged-$$' /tmp/box-ship.out | jq -e 'select(.project == \"$PROJECT\")' >/dev/null && ! grep 'forged-$$' /tmp/box-ship.out | jq -e 'select(.project == \"another-project\")' >/dev/null"
IN "rm -f $ROOT/.run/logs/leak.log $ROOT/.run/logs/forge.log" >/dev/null 2>&1

echo "== what the box can't make the host's git see (review sy-b15.6 2)"
check "the box can't write .git/info (grafts) or .git/objects/info (alternates)" sh -c "! IN 'echo x > $ROOT/.git/info/grafts' && ! IN 'echo /tmp > $ROOT/.git/objects/info/alternates' && ! test -e '$ROOT/.git/info/grafts'"
IN "mkdir -p $ROOT/.git/refs/replace && git -C $ROOT rev-parse HEAD > $ROOT/.git/refs/replace/\$(git -C $ROOT rev-parse HEAD)" >/dev/null 2>&1
check "a replace ref the box planted: mm up refuses, and says why" sh -c "! mm up '$REF' >/tmp/box-up-replace.out 2>&1 && grep -q 'refs/replace' /tmp/box-up-replace.out"
IN "rm -rf $ROOT/.git/refs/replace" >/dev/null 2>&1
check "...gone again: mm up works" sh -c "mm up '$REF' >/dev/null 2>&1"
for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
IN "cd $ROOT && h=\$(git -c safe.directory='*' rev-parse HEAD) && echo \"\$h refs/replace/\$h\" >> .git/packed-refs" >/dev/null 2>&1
check "a replace ref the box packed into .git/packed-refs: mm up refuses, and says why (review sy-b15.6 follow-up 1)" sh -c "! mm up '$REF' >/tmp/box-up-packed.out 2>&1 && grep -q 'packed-refs' /tmp/box-up-packed.out"
IN "cd $ROOT && grep -v ' refs/replace/' .git/packed-refs > .git/packed-refs.new; mv .git/packed-refs.new .git/packed-refs" >/dev/null 2>&1
check "...gone again: mm up works" sh -c "mm up '$REF' >/dev/null 2>&1"
for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done

echo "== what a box's history can't make the host run (review sy-b15.6 follow-up 2)"
check "mm new --box sealed the engine (bin/, site/) on the host, out of the box's sight" sh -c "jq -e '.files[\"bin/config-check\"]' '$HD/engine.json' >/dev/null && ! IN 'test -e $HD/engine.json'"
PWN=/tmp/mm-pwned-$$; rm -f "$PWN"; ORIG=$(git -C "$ROOT" rev-parse HEAD)
# the box commits its own bin/config-check (it can write the repo's history, not the file), points main at it, writes a
# MERGE_HEAD (as if an update were in progress), and an index that hides the change from git status
IN "cd $ROOT && G='git -c safe.directory=*' && export GIT_AUTHOR_NAME=box GIT_AUTHOR_EMAIL=box@box GIT_COMMITTER_NAME=box GIT_COMMITTER_EMAIL=box@box && b=\$(printf '%s\n' '#!/bin/sh' 'touch $PWN; exit 0' | \$G hash-object -w --stdin) && GIT_INDEX_FILE=/tmp/evil.idx \$G read-tree HEAD && GIT_INDEX_FILE=/tmp/evil.idx \$G update-index --cacheinfo 100755,\$b,bin/config-check && t=\$(GIT_INDEX_FILE=/tmp/evil.idx \$G write-tree) && c=\$(\$G commit-tree \$t -p HEAD -m 'box: its own config-check') && \$G update-ref refs/heads/main \$c && \$G read-tree \$c && \$G update-index --assume-unchanged bin/config-check && echo \$c > .git/MERGE_HEAD" >/tmp/box-evil.out 2>&1
check "(the box made its commit: main is not mm's any more, and git status shows nothing)" sh -c "[ \"\$(git -C '$ROOT' rev-parse HEAD)\" != '$ORIG' ] && [ -z \"\$(git -C '$ROOT' status --porcelain --untracked-files=no)\" ]"
check "mm update --abort with the box's MERGE_HEAD: refused (mm began no update), and nothing of the box's runs" sh -c "! mm update '$REF' --abort >/tmp/box-abort.out 2>&1 && grep -q 'no record' /tmp/box-abort.out && ! test -e '$PWN' && git -C '$ROOT' show '$ORIG:bin/config-check' | cmp -s - '$ROOT/bin/config-check'"
IN "rm -f $ROOT/.git/MERGE_HEAD" >/dev/null 2>&1
check "mm update: refused, HEAD's bin/config-check is not what is on disk (git status is fooled, mm is not)" sh -c "! mm update '$REF' >/tmp/box-upd.out 2>&1 && grep -q 'bin/config-check in HEAD' /tmp/box-upd.out && ! test -e '$PWN'"
# as a host git step that resets toward HEAD would do (merge --abort, reset): the box's file on disk
git -C "$ROOT" show HEAD:bin/config-check > "$ROOT/bin/config-check"
check "the box's bin/config-check on disk: mm update refuses to run it, and says why" sh -c "! mm update '$REF' >/tmp/box-upd2.out 2>&1 && grep -q 'not as mm' /tmp/box-upd2.out && ! test -e '$PWN'"
check "...mm doctor doesn't run the box's bin/ either" sh -c "mm doctor >/tmp/box-doctor.out 2>&1; grep -q 'not checked' /tmp/box-doctor.out && ! test -e '$PWN'"
git -C "$ROOT" update-index --no-assume-unchanged bin/config-check; git -C "$ROOT" reset -q --hard "$ORIG"
check "...back to mm's: mm update works again" sh -c "mm update '$REF' >/tmp/box-upd3.out 2>&1 || { cat /tmp/box-upd3.out; false; }"

echo "== the update's merge base is mm's, not the box's (review sy-055t)"
MT=$(git -C "$ROOT" rev-parse refs/heads/mm-template); MAIN=$(git -C "$ROOT" rev-parse HEAD)
check "mm recorded the mm-template commit on the host, out of the box's sight" sh -c "[ \"\$(jq -r .commit '$HD/template.json')\" = '$MT' ] && ! IN 'test -e $HD/template.json'"
# the box makes its own "template" commit (main's tree: every project line would look like the template's) on top of
# mm's, and points mm-template at it
IN "cd $ROOT && G='git -c safe.directory=*' && export GIT_AUTHOR_NAME=box GIT_AUTHOR_EMAIL=box@box GIT_COMMITTER_NAME=box GIT_COMMITTER_EMAIL=box@box && c=\$(\$G commit-tree HEAD^{tree} -p $MT -m 'template 0.0.0') && \$G update-ref refs/heads/mm-template \$c" >/tmp/box-mt-evil.out 2>&1
check "(the box moved mm-template)" sh -c "[ \"\$(git -C '$ROOT' rev-parse refs/heads/mm-template)\" != '$MT' ]"
check "mm update: refused, mm-template is not the commit mm recorded, and it says why" sh -c "! mm update '$REF' >/tmp/box-mt.out 2>&1 && grep -q 'mm-template is' /tmp/box-mt.out && grep -q 'sy-055t' /tmp/box-mt.out"
check "...mm update --dry-run too" sh -c "! mm update '$REF' --dry-run >/tmp/box-mt.out 2>&1 && grep -q 'sy-055t' /tmp/box-mt.out"
IN "git -c safe.directory='*' -C $ROOT update-ref refs/heads/mm-template $MT" >/dev/null 2>&1
check "...put back: mm update works" sh -c "mm update '$REF' >/tmp/box-mt2.out 2>&1 || { cat /tmp/box-mt2.out; false; }"
# the box leaves mm-template alone and rewrites main without it (the same tree: what is on disk), so git would take
# another base
IN "cd $ROOT && G='git -c safe.directory=*' && export GIT_AUTHOR_NAME=box GIT_AUTHOR_EMAIL=box@box GIT_COMMITTER_NAME=box GIT_COMMITTER_EMAIL=box@box && c=\$(\$G commit-tree HEAD^{tree} -m 'main, without mm-template') && \$G update-ref refs/heads/main \$c" >/tmp/box-mt-evil.out 2>&1
check "mm update: refused, the recorded mm-template is not in main's history, and it says why" sh -c "! mm update '$REF' >/tmp/box-mt3.out 2>&1 && grep -q \"not in main's history\" /tmp/box-mt3.out"
IN "git -c safe.directory='*' -C $ROOT update-ref refs/heads/main $MAIN" >/dev/null 2>&1
check "...main back: mm update works" sh -c "mm update '$REF' >/tmp/box-mt4.out 2>&1 || { cat /tmp/box-mt4.out; false; }"
rm -f "$PWN"

echo "== the way out"
check "no DNS for an outside name in the box (getent example.com fails)" sh -c "! IN 'getent hosts example.com'"
check "...but its own proxy's name resolves" IN "getent hosts $PX"
check "no direct way out (by name)" sh -c "! IN 'curl -s -o /dev/null --max-time 8 --noproxy \"*\" https://github.com/'"
check "no direct way out (by address)" sh -c "! IN 'curl -s -o /dev/null --max-time 8 --noproxy \"*\" https://1.1.1.1/'"
check "through its proxy: a site on its list (github.com)" IN "curl -s -o /dev/null --max-time 20 -x http://$PX:8888 https://github.com/"
check "through its proxy: a site off its list is refused (example.com)" sh -c "! IN 'curl -s -o /dev/null --max-time 20 -x http://$PX:8888 https://example.com/'"
check "the services get the proxy (HTTPS_PROXY in their environment)" sh -c "IN 'cat /proc/\$(pgrep -f \"site/server.mjs\" | head -1)/environ' | tr '\\0' '\\n' | grep -q '^HTTPS_PROXY=http://$PX:8888'"
check "the host's own services don't answer from the box (names proxy 1355, VictoriaMetrics 8428 on the docker bridge)" sh -c "! IN 'curl -s -o /dev/null --max-time 5 --noproxy \"*\" http://172.17.0.1:1355/' && ! IN 'curl -s -o /dev/null --max-time 5 --noproxy \"*\" http://172.17.0.1:8428/'"
ELOG="$MM_HOME_DIR/box/$PROJECT/egress/egress.log"
check "every connection is logged on the host, for this project (the site on the list, and the one refused)" sh -c "grep -q 'github.com' '$ELOG' && grep -qi 'example.com' '$ELOG' && ! IN 'test -e $MM_HOME_DIR/box/$PROJECT/egress'"
check "...and the shipper takes that log, stamped with the box's project" sh -c "mm ship --dry-run 2>/dev/null | grep 'example.com' | jq -e 'select(.project == \"$PROJECT\")' >/dev/null"

echo "== the box's own Paseo (M1-C)"
PSOCK="$HD/sock/pc.sock"; PW="$MM_HOME_DIR/paseo/$PROJECT.password"
BIP=$(D inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$BOX")
for _ in $(seq 1 60); do process-compose -U -u "$PSOCK" process list -o json 2>/dev/null | jq -e ".[] | select(.name==\"$PROJECT.paseo\") | .is_ready == \"Ready\"" >/dev/null && break; sleep 2; done
check "the box's Paseo daemon runs and is ready (as the box user)" sh -c "process-compose -U -u '$PSOCK' process list -o json | jq -e '.[] | select(.name==\"$PROJECT.paseo\") | .is_ready == \"Ready\"' && [ \"\$(IN 'ps -o user= -C node | sort -u | head -1')\" != root ]"
check "the box has a fixed address on its network (10.231.<n>.10)" sh -c "echo '$BIP' | grep -qE '^10\.231\.[0-9]+\.10$'"
check "its password: on the host only (0600); the box sees it read-only" sh -c "[ \"\$(stat -c %a '$PW')\" = 600 ] && ! IN 'echo x >> /run/mm/secrets/paseo.password'"
check "the host reaches the box's Paseo with the password (paseo ls)" sh -c "PASEO_PASSWORD=\"\$(cat '$PW')\" paseo --host 'tcp://$BIP:6767' ls --json | jq -e 'type == \"array\"'"
check "...and is refused with a wrong one" sh -c "! PASEO_PASSWORD=wrong-password paseo --host 'tcp://$BIP:6767' ls --json"
# what the box's Paseo starts (a terminal here; an agent's tools the same way) runs as the box user, inside the box's
# walls (sy-b15.2 2, the part that needs no model: an agent itself waits for B2's gateway)
BP() { PASEO_PASSWORD="$(cat "$PW")" paseo --host "tcp://$BIP:6767" "$@"; }
TID=$(BP terminal create --cwd "$ROOT" --name qa-walls --json 2>/dev/null | jq -r '.id // .terminalId // .terminal.id // empty')
[ -n "$TID" ] && BP terminal send-keys "$TID" 'echo "uid=$(id -u)"; sudo -n true 2>/dev/null || echo NO-"SUDO"; touch /usr/x 2>/dev/null || echo RO-"ROOT"; curl -s --max-time 5 --noproxy "*" https://example.com >/dev/null || echo NO-"WAY-OUT"' Enter >/dev/null 2>&1
sleep 8; TOUT=$( [ -n "$TID" ] && BP terminal capture "$TID" 2>/dev/null)
check "a terminal the box's Paseo starts: the box user, no sudo, read-only root, no way out but the proxy" sh -c "echo \"\$0\" | grep -qE 'uid=2[0-9]{5}' && echo \"\$0\" | grep -q NO-SUDO && echo \"\$0\" | grep -q RO-ROOT && echo \"\$0\" | grep -q NO-WAY-OUT" "$TOUT"
[ -n "$TID" ] && BP terminal kill "$TID" >/dev/null 2>&1
GW=$(echo "$BIP" | sed 's/\.10$/.1/')
check "the box can't reach the system Paseo (6767 on its network's gateway, the host)" sh -c "! IN 'curl -s -o /dev/null --max-time 5 --noproxy \"*\" http://$GW:6767/'"
# another box: a stand-in on its own internal network (as mm makes them), listening on Paseo's port (review sy-b15.8 4)
ONET=mm-net-qa-other-$$; OBOX=mm-qa-other-$$
D network create --internal --subnet 10.231.250.0/24 "$ONET" >/dev/null 2>&1 && D run -d --name "$OBOX" --network "$ONET" --ip 10.231.250.10 --user 200250 --cap-drop ALL "$(D inspect -f '{{.Config.Image}}' "$BOX")" socat TCP-LISTEN:6767,fork,reuseaddr SYSTEM:'echo other-box' >/dev/null 2>&1
check "...nor another box's daemon (6767 on its network), directly or through its own egress proxy" sh -c "D exec '$OBOX' curl --http0.9 -s --max-time 5 http://10.231.250.10:6767/ | grep -q other-box && ! IN 'curl --http0.9 -s --max-time 5 --noproxy \"*\" http://10.231.250.10:6767/ | grep -q other-box' && ! IN 'curl --http0.9 -s --max-time 10 -x http://$PX:8888 http://10.231.250.10:6767/ | grep -q other-box'"
D rm -f "$OBOX" >/dev/null 2>&1; D network rm "$ONET" >/dev/null 2>&1
# the machine's Paseo has the box as a host (sy-9q1): mm up joined it, through Paseo's client library
for _ in $(seq 1 30); do [ -n "$(joined)" ] && break; sleep 1; done
check "mm up joined the box to the machine's Paseo (one host entry, labelled $PROJECT; now: $(joined))" sh -c "[ \"\$(SP host ls --json | jq --arg p '$PROJECT' '[.[] | select(.label == \$p)] | length')\" = 1 ]"
for _ in $(seq 1 30); do joined | grep -qiE 'connect|online|ready|ok' && ! joined | grep -qi 'connecting' && break; sleep 1; done
check "...and the machine's Paseo reaches it (status: $(joined))" sh -c "joined | grep -qiE 'connected|online|ready|^ok'"
check "...the box's password went through no command line (mm runs Paseo's client library with the file's path only)" sh -c "! grep -rq \"\$(cat '$PW')\" /proc/[0-9]*/cmdline 2>/dev/null"
# ...and the join goes one way (review sy-jm5 3): the machine's Paseo reaches the box's, never the other way round, so
# a box can't start agents on the machine's Paseo or act on its agents. A terminal on the machine's Paseo stands in for
# its work (as above: an agent's tools start the same way, and no model is needed)
MTID=$(SP terminal create --cwd "$AIT" --name qa-machine --json 2>/dev/null | jq -r '.id // .terminalId // .terminal.id // empty')
mterms() { SP terminal ls --json 2>/dev/null | jq -c '[.[] | .name // empty] | sort'; }
magents() { SP ls -a --json 2>/dev/null | jq -c '[.[] | .id] | sort'; }
export -f BP mterms magents; export PW BIP
MT0=$(mterms); MA0=$(magents)
check "the box's Paseo has no host of its own: the join gave it no way to the machine's" sh -c "[ -n '$MTID' ] && BP host ls --json | jq -e 'length == 0'"
check "...and doesn't see the machine's work (its terminal qa-machine)" sh -c "BP terminal ls --json >/dev/null && ! BP terminal ls --json | grep -q qa-machine"
check "the box holds nothing of the machine's Paseo (its home: keypair, credential)" sh -c "! IN 'test -e $MM_PASEO_JOIN_HOME' && ! IN 'ls -A \$HOME/.paseo 2>/dev/null | grep -q .'"
check "from inside the box, the machine's Paseo takes no terminal and no agent (by the gateway, by the host's name)" sh -c "! IN 'paseo --host tcp://$GW:6767 terminal create --cwd /tmp --name qa-evil' && ! IN 'paseo --host tcp://host.docker.internal:6767 run --no-wait qa-evil' && [ \"\$(mterms)\" = '$MT0' ] && [ \"\$(magents)\" = '$MA0' ]"
[ -n "$MTID" ] && SP terminal kill "$MTID" >/dev/null 2>&1

echo "== models only through mm's AI gateway (sy-b15.10)"
AIS="$MM_HOME_DIR/box/$PROJECT/ai/ai.sock"
for _ in $(seq 1 30); do [ -S "$AIS" ] && break; sleep 1; done
check "the box has its AI key (read-only, tmpfs) and the gateway's address; no provider key" sh -c "IN 'test -s /run/mm/secrets/ai.key' && ! IN 'echo x >> /run/mm/secrets/ai.key' && mm shell '$REF' env </dev/null | grep -qx 'ANTHROPIC_BASE_URL=http://$PX:4000' && ! IN 'grep -rq upstream-secret-qa /run/mm 2>/dev/null'"
check "...its Paseo daemon has the key for its agents" IN "tr '\\0' '\\n' </proc/\$(pgrep -f 'paseo daemon' | head -1)/environ | grep -q '^ANTHROPIC_API_KEY=mmk_'"
check "the box can't see the gateway's socket (only its proxy mounts it)" sh -c "[ -S '$AIS' ] && ! IN 'test -e /run/mm/ai'"
check "a call from the box with its key: the upstream's answer, through its proxy and the gateway" IN "curl -s --noproxy '*' \$(printenv ANTHROPIC_BASE_URL 2>/dev/null || echo http://$PX:4000)/v1/messages -H \"x-api-key: \$(cat /run/mm/secrets/ai.key)\" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{\"model\":\"claude-opus-5-5\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' | grep -q QA-GATEWAY-ANSWER"
check "...without its key: refused (401)" sh -c "[ \"\$(IN \"curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://$PX:4000/v1/messages -H 'x-api-key: mmk_nope' -d '{}'\")\" = 401 ]"
PXB=$(D inspect -f '{{range $n, $c := .NetworkSettings.Networks}}{{if ne $n "'"$NET"'"}}{{$c.IPAddress}}{{end}}{{end}}' "$PX")
check "the gateway's port is on the box's network only (not on the proxy's way out, $PXB)" sh -c "[ -n '$PXB' ] && ! curl -s --max-time 3 -o /dev/null http://$PXB:4000/"
check "Claude Code in the box answers through the gateway (claude -p, the box's key)" sh -c "mm shell '$REF' sh -c 'ANTHROPIC_API_KEY=\$(cat /run/mm/secrets/ai.key) DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 timeout 120 claude -p \"say hi\" --output-format text' </dev/null | grep -q QA-GATEWAY-ANSWER"
check "...the upstream saw only the machine's key, never the box's" sh -c "grep -q 'upstream-secret-qa' '$AIT/up.jsonl' && ! grep -q mmk_ '$AIT/up.jsonl'"
check "...and mm usage counts it for this project" sh -c "mm ai usage -o json | jq -e --arg p '$PROJECT' '.[0].rows[] | select(.project == \$p) | .calls >= 2'"

echo "== the project API (sy-b15.8): the box asks on its own socket; only the owner decides, on the host"
APS="$MM_HOME_DIR/box/$PROJECT/api/api.sock"
for _ in $(seq 1 30); do [ -S "$APS" ] && IN 'test -S /run/mm/api/api.sock' && break; sleep 1; done
check "the box has its socket (/run/mm/api/api.sock), in a folder it can't change" sh -c "IN 'test -S /run/mm/api/api.sock' && ! IN 'touch /run/mm/api/x' && ! IN 'rm -f /run/mm/api/api.sock' && [ -S '$APS' ]"
check "...only its own: no owner socket, no other box's, nothing of mm.api's store in the box" sh -c "[ \"\$(IN 'ls -A /run/mm/api')\" = api.sock ] && ! IN 'grep -q approve.sock /proc/self/mountinfo' && ! IN 'test -e $MM_HOME_DIR/box' && ! IN 'test -e $MM_HOME_DIR/api'"
OUT=$(APICALL egress '{"site":"example.com","project":"someone-else"}'); QE=$(echo "$OUT" | jq -r .id); QI=$(echo "$OUT" | jq -r .item)
check "from the box: egress example.com is pending (a status, a request id, an item id: nothing else)" sh -c "echo '$OUT' | jq -e '.status == \"pending\" and (keys | sort) == [\"id\",\"item\",\"status\"]'"
check "...the item is for this box's project, whatever the call said" sh -c "grep '\"create\"' '$AIT/bd.jsonl' | tail -1 | jq -e '.[1] == \"mm.api: $PROJECT asks for egress example.com\"'"
check "...the box can't decide it: no approve call on its socket (404)" sh -c "[ \"\$(D exec '$BOX' curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/mm/api/api.sock -X POST -d '{}' http://api/approve)\" = 404 ]"
"$AIT/fakebd" label add "$QI" approved >/dev/null; "$AIT/fakebd" label add "$QI" signed-off >/dev/null; sleep 2
check "...labels decide nothing (approved, signed-off): still pending, example.com still refused by the proxy" sh -c "[ \"\$(mm api show '$QE' -o json | jq -r .status)\" = pending ] && ! IN 'curl -s -o /dev/null --max-time 20 -x http://$PX:8888 https://example.com/'"
check "...an agent's shell can't approve it (CLAUDECODE)" sh -c "! CLAUDECODE=1 mm api approve '$QE' --hash \$(mm api show '$QE' -o json | jq -r .hash | cut -c1-12) && [ \"\$(mm api show '$QE' -o json | jq -r .status)\" = pending ]"
QH=$(mm api show "$QE" -o json | jq -r .hash)
check "...its id and hash without the one-time code: nothing applied (the code went to the owner's Telegram only)" sh -c "! mm api approve '$QE' --hash ${QH:0:12} </dev/null && [ \"\$(mm api show '$QE' -o json | jq -r .status)\" = pending ] && ! grep -qF \"\$(CODE '$QE')\" '$AIT/bd.jsonl' '$AIT/api.log'"
check "the owner approves (review signed off), with the code: example.com goes through the box's proxy" sh -c "CODE '$QE' | mm api approve '$QE' --hash ${QH:0:12} >/dev/null && for i in \$(seq 1 20); do IN 'curl -s -o /dev/null --max-time 10 -x http://$PX:8888 https://example.com/' && exit 0; sleep 1; done; exit 1"
check "...the box's AI gateway port still answers after the proxy's restart" sh -c "for i in \$(seq 1 20); do [ \"\$(IN \"curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://$PX:4000/v1/messages -H 'x-api-key: mmk_nope' -d '{}'\")\" = 401 ] && exit 0; sleep 1; done; exit 1"
check "...mm api undo: example.com is refused again" sh -c "mm api undo '$QE' >/dev/null && sleep 3 && ! IN 'curl -s -o /dev/null --max-time 20 -x http://$PX:8888 https://example.com/'"
# a build the box made in release/ (the host made release/ for it): it runs nowhere until the owner approves it
D exec "$BOX" sh -c 'umask 002 && mkdir -p "$1/release/qa1" && echo "require(\"http\").createServer((q, s) => s.end(\"QA-APP-OK\")).listen(process.env.PORT)" > "$1/release/qa1/server.js"' sh "$ROOT"
check "a build in release/qa1 runs nowhere by itself (no app slot)" sh -c "! mm inspect '$REF' | grep -q '^app '"
OUT=$(APICALL release '{"build":"qa1"}'); QR=$(echo "$OUT" | jq -r .id); QRH=$(mm api show "$QR" -o json | jq -r .hash)
check "release qa1: pending" sh -c "echo '$OUT' | jq -e '.status == \"pending\"'"
check "...approved: the box's app slot runs it, in the box (its own process manager loads it; the box keeps running)" sh -c "CODE '$QR' | mm api approve '$QR' --hash ${QRH:0:12} >/dev/null && for i in \$(seq 1 40); do IN 'curl -sf --max-time 3 http://app.$PROJECT.localhost:1355/' | grep -q QA-APP-OK && exit 0; sleep 2; done; exit 1"
check "...as the box user, and not on the host's process manager" sh -c "[ \"\$(IN 'ps -o uid= -p \$(pgrep -f \"node server.js\" | head -1)' | tr -d ' ')\" -ge 200000 ] && ! process-compose -U -u $HOME/.mm/pc.sock process list -o json | jq -e '.[] | select(.name == \"$PROJECT.app\")'"
check "...mm api undo: the build leaves the app slot" sh -c "mm api undo '$QR' >/dev/null && for i in \$(seq 1 30); do IN 'curl -sf --max-time 3 http://app.$PROJECT.localhost:1355/' 2>/dev/null | grep -q QA-APP-OK || exit 0; sleep 2; done; exit 1"
OUT=$(APICALL secret '{"name":"qa-secret"}'); QS=$(echo "$OUT" | jq -r .id); QSH=$(mm api show "$QS" -o json | jq -r .hash)
check "secret qa-secret: pending; approved: mm needs lists $PROJECT:qa-secret for the owner to fill (no value went anywhere)" sh -c "echo '$OUT' | jq -e '.status == \"pending\"' && CODE '$QS' | mm api approve '$QS' --hash ${QSH:0:12} >/dev/null && mm needs -p '$PROJECT' -o json | jq -e '.[] | select(.name == \"qa-secret\" and .status == \"missing\")'"
check "a call in no format, or not one of the four: refused" sh -c "APICALL route '{\"name\":\"Bad Name\"}' | jq -e '.why == \"format\"' && [ \"\$(D exec '$BOX' curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/mm/api/api.sock -X POST -d '{}' http://api/shell)\" = 404 ]"
check "every call is logged on the host with the box's project (from its socket)" sh -c "[ \$(grep -c '\"box\":\"$PROJECT\"' '$AIT/api.log') -ge 6 ] && ! grep -q someone-else '$AIT/api.log'"

echo "== its public board: from the host to the box, Traefik never on the box's network (review sy-b15.7 2)"
PUBPORT=$(jq -r '.services.board.public_port // empty' "$ROOT/.run/services.json"); PUBBIND=$(jq -r '.services.board.public_bind // empty' "$ROOT/.run/services.json")
PUBNAME=$(jq -r '.services.board.public.name // empty' "$ROOT/.run/services.json")
if [ -n "$PUBPORT" ] && [ -n "$PUBBIND" ]; then
  for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$PUBBIND:$PUBPORT/api/whoami")" != 000 ] && break; sleep 1; done
  check "the host's bind_host ($PUBBIND:$PUBPORT) reaches the box board's public side, which serves nothing without the gateway's assertion" sh -c "c=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://$PUBBIND:$PUBPORT/api/whoami'); [ \"\$c\" != 000 ] && [ \"\$c\" != 200 ]"
  check "...its route is listed ($PUBNAME), and no Traefik (no other container) is on the box's network" sh -c "$MM_EXPOSE ls | grep -q '$PUBNAME' && [ \"\$(D network inspect -f '{{range .Containers}}{{.Name}} {{end}}' '$NET' | wc -w)\" = 2 ]"
  check "...the host's forwarder is in pc/box-public, not among the projects" sh -c "test -f '$MM_HOME_DIR/pc/box-public/$PROJECT.yaml' && ! test -e '$MM_HOME_DIR/pc/projects/$PROJECT.yaml'"
else ok "no public board on this machine (not domain mode): skipped"; fi

echo "== mm finds the box (its registration)"
check "mm ls lists it as a box, with its processes" sh -c "mm ls -o json | jq -e --arg p '$PROJECT' '.[] | select(.project == \$p) | .box == true'"
check "the run files the engine scripts read (.run/services.json, endpoints.json)" sh -c "jq -e .services.board '$ROOT/.run/services.json' >/dev/null && test -s '$ROOT/.run/endpoints.json'"

echo "== the box's schedules (the host's mm cron runs them in the box), its backup out of its reach (sy-8gv)"
BK=$(jq -r .dirs.backups "$ROOT/.run/endpoints.json"); BKP="$BK/$PROJECT"
check "mm cron --run $PROJECT/health: runs in the box, and finds no problem (the box's Paseo answers too)" sh -c "o=\$(mm cron --run '$PROJECT/health' 2>&1) && echo \"\$o\" && ! echo \"\$o\" | grep -q FAILED"
check "mm cron --run $PROJECT/backup: ok" mm cron --run "$PROJECT/backup"
LAST=$(ls -1d "$BKP"/20*/ 2>/dev/null | tail -1)
check "...a backup on the host ($BKP/<date>), with the board's items in it" sh -c "[ -n '$LAST' ] && grep -q 'made in the box' '$LAST/board.jsonl' && test -d '$LAST/board.dolt' && test -s '$LAST/config.bundle'"
check "...owned by the host's owner, and nothing of it left in the box's staging folder" sh -c "[ -z \"\$(find '$LAST' ! -uid $(id -u) -print -quit)\" ] && [ -z \"\$(ls -A '$HD/backup')\" ]"
check "the box can't see the backups folder" sh -c "! IN 'ls $BK' && ! IN 'test -e $BKP'"

echo "== mm box off, mm box on (a project moves between the host and its box)"
# the box rewrites its .run/services.json (it may): the ports mm gives out come from the host's copy (review sy-b15.17 4)
PORTS="$HD/ports.json"; DP=$(jq -r .dolt_port "$PORTS" 2>/dev/null)
IN "jq '.dolt_port = 40001 | .services.board.public_port = 40002' $ROOT/.run/services.json >$ROOT/.run/x.json && mv $ROOT/.run/x.json $ROOT/.run/services.json"
check "the host keeps the box's ports ($PORTS, out of the box's sight), and the box rewrote its own copy" sh -c "[ -n '$DP' ] && [ '$DP' != null ] && ! IN 'test -e $PORTS' && [ \"\$(jq .dolt_port '$ROOT/.run/services.json')\" = 40001 ]"
check "mm box off: the box stops; box: true leaves the answers (committed)" sh -c "mm box off '$REF' >/tmp/box-off.out 2>&1 && ! D inspect '$BOX' >/dev/null 2>&1 && ! grep -qx 'box: true' '$ROOT/.mm-answers.yaml' && git -C '$ROOT' diff --quiet -- .mm-answers.yaml"
check "...the box's public forwarder goes from the host (the host project's own takes over)" sh -c "! test -e '$MM_HOME_DIR/pc/box-public/$PROJECT.yaml'"
for _ in $(seq 1 60); do process-compose -U -u "$HOME/.mm/pc.sock" process list -o json 2>/dev/null | jq -e ".[] | select(.name==\"$PROJECT.board\") | .is_ready == \"Ready\"" >/dev/null && break; sleep 2; done
check "...its services run on the host again (board ready), and no file stays the box's" sh -c "process-compose -U -u $HOME/.mm/pc.sock process list -o json | jq -e '.[] | select(.name==\"$PROJECT.board\") | .is_ready == \"Ready\"' >/dev/null && [ -z \"\$(find '$ROOT' -uid +199999 -print -quit)\" ]"
check "...on the host, its ports are the host's copy, not what the box wrote" sh -c "[ \"\$(jq .dolt_port '$ROOT/.run/services.json')\" = '$DP' ] && [ \"\$(jq .services.board.public_port '$ROOT/.run/services.json')\" != 40002 ]"
check "...and mm shell refuses it (not a box project now)" sh -c "mm shell '$REF' true </dev/null; [ \$? = 2 ]"
check "...and it left the machine's Paseo (on the host, its agents are that Paseo's own)" sh -c "[ -z \"\$(joined)\" ]"
check "mm box on: back in the box; nothing of it on the host's process manager" sh -c "mm box on '$REF' >/tmp/box-on.out 2>&1 && grep -qx 'box: true' '$ROOT/.mm-answers.yaml' && D inspect '$BOX' >/dev/null && ! process-compose -U -u $HOME/.mm/pc.sock process list -o json | jq -e '.[] | select(.name | startswith(\"$PROJECT.\"))'"
for _ in $(seq 1 90); do mm inspect "$REF" 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
check "...its board is ready in the box, and the item made there before is still there" sh -c "mm inspect '$REF' | grep -q 'board .*Ready' && IN \"cd $ROOT && bin/bd list --json\" | grep -q 'made in the box'"
check "...and it joined the machine's Paseo again (one entry)" sh -c "[ \"\$(SP host ls --json | jq --arg p '$PROJECT' '[.[] | select(.label == \$p)] | length')\" = 1 ]"

echo "== which records mm obs errors leaves out (review sy-cwh)"
MLOG="$MM_HOME_DIR/pc/mm.log"
mm inspect "$REF" >/dev/null 2>&1
check "a command on this throwaway project: mm marks its own record (mm_throwaway), from the project's answers" sh -c "grep '\"op\":\"mm inspect\"' '$MLOG' | tail -1 | jq -e '.mm_throwaway == \"$PROJECT\"' >/dev/null"
MM_TEST=box mm ls >/dev/null 2>&1
check "...an environment variable marks nothing (MM_TEST=box mm ls: no mark, no test field)" sh -c "grep '\"op\":\"mm ls\"' '$MLOG' | tail -1 | jq -e '(has(\"mm_throwaway\") or has(\"test\")) | not' >/dev/null"
# the box writes an error line that names the mark and the word test, and claims to be mm's: still shown, as the box's.
# In the shape a box service's lines have (process-compose's {level, process, message}, the service's JSON in message):
# a bare top-level JSON line gets its level from its text, as a process-compose stderr line does
IN "printf '%s\n' '{\"level\":\"error\",\"process\":\"board\",\"message\":\"{\\\"level\\\":\\\"error\\\",\\\"msg\\\":\\\"cwh-$$ a test line\\\",\\\"test\\\":\\\"box\\\",\\\"mm_throwaway\\\":\\\"x\\\",\\\"project\\\":\\\"mm\\\",\\\"service\\\":\\\"mm\\\"}\"}' >> $ROOT/.run/logs/cwh.log" >/dev/null 2>&1
for _ in $(seq 1 45); do mm obs errors -p "$PROJECT" --since 10m -o json 2>/dev/null | grep -q "cwh-$$" && break; sleep 2; done
check "...a box's error line with the mark and the word test still reaches mm obs errors, as the box's own" sh -c "mm obs errors -p '$PROJECT' --since 10m -o json | grep -q 'cwh-$$'"
IN "rm -f $ROOT/.run/logs/cwh.log" >/dev/null 2>&1

echo "== archive"
check "mm archive: the box and its proxy are gone, and what mm kept for it" sh -c "mm archive '$REF' >/dev/null && ! D inspect '$BOX' >/dev/null 2>&1 && ! D inspect '$PX' >/dev/null 2>&1 && ! D network inspect '$NET' >/dev/null 2>&1 && ! test -e '$HD' && ! test -e '$PW' && ! test -e '$MM_HOME_DIR/paseo/$PROJECT' && ! test -e '$MM_HOME_DIR/egress/$PROJECT'"
check "...and it left the machine's Paseo" sh -c "[ -z \"\$(joined)\" ]"
check "...and what the owner granted it through the project API (its requests stay, for the audit)" sh -c "! test -e '$AIT/api/granted/$PROJECT.json' && mm api show '$QE' -o json | jq -e '.status == \"undone\"'"
check "...its public forwarder and its route are gone" sh -c "! test -e '$MM_HOME_DIR/pc/box-public/$PROJECT.yaml' && { [ -z '$PUBNAME' ] || ! $MM_EXPOSE ls | grep -q '$PUBNAME'; }"
check "no route written into the live web proxy (review sy-uzh)" live_routes_same
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
