#!/usr/bin/env bash
# Sentinel QA (profile system, bin/sentinel) on a real machine: a throwaway board from `mm new`, the sentinel run
# against it with stub sources (a fake brain, a fake mm, fake cron logs), step by step through open / no duplicate /
# hourly change comments / drift / clear / mute / source failure / state loss. Nothing else is touched; the board is
# archived at the end.
#
#   test/sentinel.sh [client/name]          default qa/sentinel
#   MM_REAL=dist/mm test/sentinel.sh        also checks the real `mm obs errors --by service -o json` shape
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
REF=${1:-qa/sentinel}; CLIENT=${REF%/*}; NAME=${REF#*/}; PROJECT="$CLIENT-$NAME"; ROOT="$HOME/projects/$REF"
export PATH="$HOME/.mm/bin:$HOME/.mm/npm/bin:$HOME/.local/bin:$PATH"
pass=0; fail=0; T0=$(date +%s)
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
step() { printf '\n\e[1m== %s\e[0m (%ss)\n' "$*" $(( $(date +%s) - T0 )); }

[ -e "$ROOT" ] && { echo "$ROOT exists; pick another name"; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
ARCH_BEFORE=$(ls "$HOME/.local/share/mm/archive" 2>/dev/null)

step "a throwaway board"
MM_TEMPLATE_DIR="$SRC/template" mm new "$REF" --short qs --throwaway >"$W/new.log" 2>&1 && ok "mm new" || { bad "mm new"; tail -20 "$W/new.log"; exit 1; }
export SVC_URL_BD_SERVE="http://bd-serve.$PROJECT.localhost:1355"
for _ in $(seq 1 60); do curl -sf -o /dev/null "$SVC_URL_BD_SERVE/healthz" && break; sleep 1; done
check "bd-serve answers" curl -sf -o /dev/null "$SVC_URL_BD_SERVE/healthz"

# the sentinel as the system profile lays it out: <sys>/bin/sentinel + bin/lib; the stub brain is handed over like mm does (MM_BRAIN)
SYS="$W/brain/system"; mkdir -p "$SYS/bin" "$W/brain/bin" "$W/p1/.run/logs"
cp "$SRC/template/profiles/system/bin/sentinel" "$SYS/bin/"; cp -r "$SRC/template/bin/lib" "$SYS/bin/"
cat >"$W/brain/bin/brain" <<EOF
#!/bin/sh
[ -f "$W/brain.fail" ] && { echo "brain broke" >&2; exit 3; }
cat "$W/status.txt"
EOF
cat >"$W/mm" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "ls -o") [ -f "$W/ls.fail" ] && { echo "ls broke" >&2; exit 1; }; cat "$W/ls.json" ;;
  "obs errors") cat "$W/errors.json" ;;
  "obs status") exit \$(cat "$W/obs.rc") ;;
  *) echo "fake mm: \$*" >&2; exit 9 ;;
esac
EOF
chmod +x "$W/brain/bin/brain" "$W/mm"
mkdir -p "$W/p2/.run/logs"   # p2: a throwaway test project whose backup fails; it must raise nothing
printf '{"time":"%s","msg":"backup failed (exit 1)","job":"backup","exit_code":1}\n' "$(date -u +%FT%TZ)" >"$W/p2/.run/logs/cron.log"
echo "[{\"project\":\"p1\",\"root\":\"$W/p1\"},{\"project\":\"p2\",\"root\":\"$W/p2\",\"throwaway\":true},{\"project\":\"sysqa\",\"root\":\"$SYS\"}]" >"$W/ls.json"
echo 0 >"$W/obs.rc"
export MM_BIN="$W/mm" MM_PROJECT=sysqa MM_OBS_TRACES="" MM_OBS_METRICS="" MM_BRAIN="$W/brain"   # mm tells engine scripts where the brain is
sentinel() { node "$SYS/bin/sentinel" >>"$W/run.log" 2>&1; }
status() { printf '[brain] score 3\n' >"$W/status.txt"; for l in "$@"; do printf '[brain] %s\n' "$l" >>"$W/status.txt"; done; }
cronlog() { printf '{"time":"%s","msg":"%s","job":"%s","exit_code":%s}\n' "$(date -u +%FT%TZ)" "$3" "$1" "$2" >>"$W/p1/.run/logs/cron.log"; }
errs() { local t; t=$(date -u -d "@$(( $(date +%s) - ${1:-0} ))" +%FT%T.000Z)
  echo "[{\"kind\":\"log\",\"project\":\"p1\",\"service\":\"board\",\"n\":4,\"last\":\"$t\",\"sample\":[\"Error: request 4f1a2b3c-1111-2222 failed after 120ms\"]},{\"kind\":\"log\",\"project\":\"p1\",\"service\":\"cron\",\"n\":1,\"last\":\"$t\",\"sample\":[\"backup failed\"]},{\"kind\":\"log\",\"project\":\"p2\",\"service\":\"board\",\"n\":9,\"last\":\"$t\",\"sample\":[\"Error: throwaway\"]},{\"kind\":\"log\",\"project\":\"gone\",\"service\":\"dolt\",\"n\":9,\"last\":\"$t\",\"sample\":[\"Error: archived\"]}]" >"$W/errors.json"; }
items() { curl -sf "$SVC_URL_BD_SERVE/v0/beads/issues?label=sentinel&limit=500" | jq -r '.items[] | .description | capture("sentinel key: `(?<k>[^`]+)`").k' | sort | tr '\n' ' '; }
has() { [ "$(items)" = "$1" ]; }
idof() { curl -sf "$SVC_URL_BD_SERVE/v0/beads/issues?label=sentinel&limit=500" | jq -r --arg k "$1" '.items[] | select(.description | contains("sentinel key: `" + $k + "`")) | .id'; }
comments() { curl -sf "$SVC_URL_BD_SERVE/v0/beads/issues/$1?include_comments=true" | jq '.comments | length'; }

step "run 1: an alert, a failed backup, errors once, drift (baseline)"
status "ALERT disk / 91% full" "last drift (2026-11-04T01:00:00+00:00): + services_system: a.service"
cronlog health 0 "health ok"; cronlog backup 1 "backup failed (exit 1): disk full"
errs 30
check "exit 0" sentinel
check "alert + cron items, no drift on first run, no errors item yet" has "alert:disk / #% full cron:p1/backup "
A=$(idof "alert:disk / #% full"); C=$(idof cron:p1/backup)
check "items are for ops, labelled incident act:incident sentinel" sh -c "curl -sf '$SVC_URL_BD_SERVE/v0/beads/issues/$A' | jq -e '.assignee==\"ops\" and (.labels|index(\"incident\")) and (.labels|index(\"act:incident\"))'"
check "cron errors in the logs are not doubled as errors:p1/cron" sh -c "! grep -q 'errors:p1/cron' '$W/run.log'"

step "run 2: same problems, numbers changed"
status "ALERT disk / 92% full" "last drift (2026-11-04T01:00:00+00:00): + services_system: a.service"
errs 20
check "exit 0" sentinel
check "no duplicates" has "alert:disk / #% full cron:p1/backup "
check "no change comment within the hour" test "$(comments "$A")" = 0

step "run 3: errors a third time in a row, new drift"
status "ALERT disk / 92% full" "last drift (2026-11-04T02:00:00+00:00): + services_system: b.service"
errs 10
check "exit 0" sentinel
check "errors item + drift item opened" has "alert:disk / #% full cron:p1/backup drift errors:p1/board "
E=$(idof errors:p1/board); D=$(idof drift)
check "errors item shows the normalised message" sh -c "curl -sf '$SVC_URL_BD_SERVE/v0/beads/issues/$E' | jq -r .description | grep -q 'request <id> failed after #ms'"

step "run 4: alert gone, backup ok, more drift"
status "last drift (2026-11-04T03:00:00+00:00): - services_system: b.service"
cronlog backup 0 "backup ok"
errs 5
check "exit 0" sentinel
check "alert and cron items closed" has "drift errors:p1/board "
check "closing comment on the alert" test "$(comments "$A")" = 1
check "more drift is a comment, not a new item" test "$(comments "$D")" = 1

step "run 5: ops closes the errors item while errors go on (mute)"
curl -sf -X POST -H 'content-type: application/json' -d '{"actor":"qa","reason":"known, accepted"}' "$SVC_URL_BD_SERVE/v0/beads/issues/$E:close" >/dev/null
errs 1
check "exit 0" sentinel
check "not reopened while still there" has "drift "
check "muted in state" jq -e '.muted["errors:p1/board"]' "$SYS/.sentinel.json"

step "run 6: errors stop for 30 min (mute lifted), then come back (a new item)"
errs 3600
for _ in 1 2 3 4 5 6; do sentinel; done
check "mute lifted after the errors stopped" sh -c "! jq -e '.muted[\"errors:p1/board\"]' '$SYS/.sentinel.json'"
check "drift item stays until someone closes it" has "drift "
for ago in 30 20 10; do errs $ago; sentinel; done
check "recurrence opens a new errors item" has "drift errors:p1/board "
check "a new id, not the closed one" test "$(idof errors:p1/board)" != "$E"

step "run 7: a source fails"
touch "$W/ls.fail"
check "exit 0 (the failure is on the board)" sentinel
check "sentinel:cron item opened" has "drift errors:p1/board sentinel:cron "
rm -f "$W/ls.fail"; cronlog health 1 "health failed (exit 1): board down"
check "exit 0" sentinel
check "source back: sentinel:cron closed; new cron failure opened" has "cron:p1/health drift errors:p1/board "

step "run 8: state lost; obs down"
rm -f "$SYS/.sentinel.json"; echo 1 >"$W/obs.rc"
check "exit 0" sentinel
check "no duplicates after state loss; open errors item kept; obs:stack opened" has "cron:p1/health drift errors:p1/board obs:stack "
check "no comments made up after state loss" sh -c "grep 'obs:stack: opened' -A1 '$W/run.log' | grep -q ' 0 updated'"
echo 0 >"$W/obs.rc"; cronlog health 0 "health ok"
check "exit 0" sentinel
check "obs back, health ok: closed" has "drift errors:p1/board "

if [ -n "${MM_REAL:-}" ]; then
  step "contract: the real mm obs errors --by service"
  check "array of {kind, project, service, n, last, sample[]}" sh -c "'$MM_REAL' obs errors --by service --since 1h -o json | jq -e 'type==\"array\" and all(.[]; has(\"kind\") and has(\"project\") and has(\"service\") and (.n|type==\"number\") and (.sample|type==\"array\"))'"
fi

step "cleanup"
mm archive "$REF" >/dev/null 2>&1 && ok "archived" || bad "archive"
rm -rf "$HOME/.local/share/backups/$PROJECT"
for f in $(ls "$HOME/.local/share/mm/archive" 2>/dev/null); do grep -qxF "$f" <<<"$ARCH_BEFORE" || rm -f "$HOME/.local/share/mm/archive/$f"; done
rmdir "$HOME/projects/$CLIENT" 2>/dev/null || true
check "nothing left" test ! -e "$ROOT"
[ "$fail" = 0 ] || { echo; echo "--- sentinel output"; cat "$W/run.log"; }
printf '\n%s passed, %s failed in %ss\n' "$pass" "$fail" $(( $(date +%s) - T0 ))
[ "$fail" = 0 ]
