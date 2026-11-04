#!/usr/bin/env bash
# The system board's machine panel (template site, BOARD_PANELS=machine) on a real machine: a scratch system-like board
# (this checkout's site + bin, built in a temp folder) reads the machine (brain status/score, mm ls, mm obs status) and
# files an item on a throwaway project's board. Only GETs touch the real machine; the one write goes to the throwaway.
#
#   test/machine-panel.sh [client/name]      default qa/panel; needs a built site's node_modules: SITE_NODE_MODULES=<dir>
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
REF=${1:-qa/panel}; CLIENT=${REF%/*}; NAME=${REF#*/}; PROJECT="$CLIENT-$NAME"
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$PATH"
unset PASEO_AGENT_ID PASEO_AGENT_CWD
NM=${SITE_NODE_MODULES:?set SITE_NODE_MODULES to a site node_modules folder (e.g. the site/node_modules of a board)}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
W=$(mktemp -d); SRV=""; trap '[ -n "$SRV" ] && kill $SRV 2>/dev/null; rm -rf "$W"' EXIT

echo "== a throwaway project to file on"
MM_TEMPLATE_DIR="$SRC/template" mm new "$REF" --short qp >"$W/new.log" 2>&1 && ok "mm new $REF" || { bad "mm new"; tail -20 "$W/new.log"; exit 1; }
ROOTP=$(mm inspect "$REF" -o json | jq -r '.[0].root')

echo "== a scratch system board with the machine panel"
S="$W/sys"; mkdir -p "$S"
(cd "$SRC/template" && tar -cf - --exclude=node_modules --exclude=dist site bin leads) | tar -xf - -C "$S"
cp "$SRC/template/profiles/system/bin/project-item" "$S/bin/"
ln -s "$NM" "$S/site/node_modules"
(cd "$S/site" && npm run build --silent >"$W/build.log" 2>&1) && ok "site builds" || { bad "site build"; tail -20 "$W/build.log"; }
PORT=$(( 39000 + RANDOM % 900 ))
BD_SERVE=$(mm inspect "$REF" -o json | jq -r '.[0].services["bd-serve"].url // empty')
[ -n "$BD_SERVE" ] || BD_SERVE="http://bd-serve.$PROJECT.localhost:1355"
(cd "$S" && PORT=$PORT HOST=127.0.0.1 BD_SERVE=$BD_SERVE BOARD_PROJECT=sysqa BOARD_PANELS=machine MM_OBS_TRACES= MM_OBS_METRICS= \
  exec node site/server.mjs >"$W/server.log" 2>&1) & SRV=$!
B="http://127.0.0.1:$PORT"
for _ in $(seq 1 40); do curl -sf -o /dev/null "$B/api/whoami" && break; sleep 0.5; done
check "board answers" curl -sf -o /dev/null "$B/api/whoami"
check "meta lists the panel" sh -c "curl -sf '$B/api/meta' | jq -e '.panels | index(\"machine\")'"

echo "== the machine (read-only)"
curl -sf "$B/api/machine" >"$W/machine.json"
check "projects listed, the throwaway among them" jq -e --arg p "$PROJECT" '.projects | map(.project) | index($p)' "$W/machine.json"
check "observability stores reported" jq -e '.obs.stores | length == 3' "$W/machine.json"
if [ -x "${MM_BRAIN:-$HOME/brain}/bin/brain" ]; then
  check "brain status lines and score" jq -e '(.brain.lines | length > 0) and (.brain.score.total | type == "number")' "$W/machine.json"
fi
check "a second call is served from the cache (<1s)" sh -c "s=\$(date +%s%N); curl -sf -o /dev/null '$B/api/machine'; [ \$(( (\$(date +%s%N) - s) / 1000000 )) -lt 1000 ]"

echo "== filing on a project's board: refused when it should be"
post() { curl -s -o "$W/post.json" -w '%{http_code}' -X POST "$B/api/project-item" "$@"; }
check "a guest is refused (401)" test "$(post -H 'content-type: application/json' -d "{\"project\":\"$PROJECT\",\"title\":\"x\"}")" = 401
check "not JSON is refused (415)" test "$(post -b board_user=alex -H 'content-type: text/plain' -d x)" = 415
check "an unknown project is refused (400)" test "$(post -b board_user=alex -H 'content-type: application/json' -d '{"project":"no-such","title":"x"}')" = 400
check "this board itself is refused (400)" test "$(post -b board_user=alex -H 'content-type: application/json' -d '{"project":"sysqa","title":"x"}')" = 400
LONG=$(printf 'x%.0s' $(seq 1 300)); LONGBODY="{\"project\":\"$PROJECT\",\"title\":\"$LONG\"}"
check "an overlong title is refused (400)" test "$(post -b board_user=alex -H 'content-type: application/json' -d "$LONGBODY")" = 400

echo "== filing on a project's board"
code=$(post -b board_user=alex -H 'content-type: application/json' -d "{\"project\":\"$PROJECT\",\"title\":\"panel probe\",\"description\":\"from the machine panel\",\"assignee\":\"setup\"}")
[ "$code" = 200 ] && ok "filed (200)" || { bad "file: $code $(cat "$W/post.json")"; }
ID=$(jq -r '.id // empty' "$W/post.json")
check "on the project's own board, for setup" sh -c "cd '$ROOTP' && bin/bd show '$ID' --json | jq -e '.[0].title == \"panel probe\" and .[0].assignee == \"setup\"'"
check "labelled from-system, authored by system/alex" sh -c "cd '$ROOTP' && bin/bd show '$ID' --json | jq -e '(.[0].labels | index(\"from-system\")) and .[0].created_by == \"system/alex\"'"

echo "== a board without the panel does not have it"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
(cd "$S" && PORT=$PORT HOST=127.0.0.1 BD_SERVE=$BD_SERVE BOARD_PROJECT=sysqa MM_OBS_TRACES= MM_OBS_METRICS= exec node site/server.mjs >>"$W/server.log" 2>&1) & SRV=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "$B/api/whoami" && break; sleep 0.5; done
check "no panel in meta" sh -c "curl -sf '$B/api/meta' | jq -e '(.panels // []) | length == 0'"
check "no /api/machine" sh -c "! curl -sf -o /dev/null '$B/api/machine' || curl -s '$B/api/machine' | jq -e '.leads == null and .projects == null'"
check "no filing endpoint" test "$(post -b board_user=alex -H 'content-type: application/json' -d "{\"project\":\"$PROJECT\",\"title\":\"x\"}")" != 200

echo "== cleanup"
kill $SRV 2>/dev/null; SRV=""
mm archive "$REF" >/dev/null 2>&1 && ok "archived $REF" || bad "archive"
rm -rf "$HOME/.local/share/backups/$PROJECT"; rmdir "$HOME/projects/$CLIENT" 2>/dev/null || true
[ "$fail" = 0 ] || { echo "--- server log"; tail -20 "$W/server.log"; }
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
