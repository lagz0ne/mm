#!/usr/bin/env bash
# template/bin/lead, hermetic (sy-8n1): a fake paseo and a fake board in a throwaway folder; no agent starts.
# Proves: a busy old lead is waited for, then interrupted; a lead that can't be archived stops the start (never two
# leads of one role), with paseo's reason; `stop` fails the same way; the new lead's first prompt carries the role's
# open items (in progress, blocked), and nothing when there are none; and the queue head wake hands it (LEAD_NEXT).
#   test/lead.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
P=$T/proj; mkdir -p "$P/bin/lib" "$P/leads/qa" "$T/st"
cp "$SRC/template/bin/lead" "$P/bin/lead"; chmod +x "$P/bin/lead"
printf 'project: acme-shop\n' >"$P/.mm-answers.yaml"
printf 'Hello {name}, you are the {role} lead of {project}.\n' >"$P/leads/START.md"
printf '{"roles":[{"id":"qa"}]}\n' >"$P/leads/roles.json"
printf '#!/bin/sh\nexit 0\n' >"$P/bin/config-check"; printf '#!/bin/sh\nexit 0\n' >"$P/bin/wt"
printf 'console.log(process.argv[1] ? "%s/claude" : "")\n' "$T" >"$P/bin/lib/claude.mjs"
# the board: the items in $T/st/items.json
printf '#!/bin/sh\ncat "%s/st/items.json" 2>/dev/null || echo "[]"\n' "$T" >"$P/bin/bd"
chmod +x "$P/bin/config-check" "$P/bin/wt" "$P/bin/bd"
# paseo: the role's agents in $T/st/agents; a plain archive fails while $T/st/busy counts down (-1: always busy);
# --force fails if $T/st/stuck exists; run records its prompt
cat >"$T/paseo" <<EOF
#!/bin/sh
S=$T/st
case "\$1" in
  ls) cat "\$S/agents" 2>/dev/null ;;
  archive) force=""; [ "\$2" = --force ] && { force=1; shift; }
    id=\$2; b=\$(cat "\$S/busy" 2>/dev/null || echo 0)
    if [ -n "\$force" ]; then [ -e "\$S/stuck" ] && { echo "daemon refused: agent \$id is locked" >&2; exit 1; }
    elif [ "\$b" != 0 ]; then [ "\$b" -gt 0 ] && echo \$((b - 1)) >"\$S/busy"; echo "agent \$id is running (use --force)" >&2; exit 1; fi
    grep -vx "\$id" "\$S/agents" >"\$S/a.tmp"; mv "\$S/a.tmp" "\$S/agents"; echo "\$id" >>"\$S/archived" ;;
  run) for a in "\$@"; do last=\$a; done; printf '%s' "\$last" >"\$S/prompt"; echo new-agent ;;
esac
EOF
chmod +x "$T/paseo"
export PASEO_BIN=$T/paseo MM_TRACE_SELF=$P/bin/lead LEAD_ARCHIVE_WAIT=3
reset() { rm -f "$T/st/"*; echo "${1:-old-1}" >"$T/st/agents"; echo "${2:-0}" >"$T/st/busy"; }
L() { "$P/bin/lead" "$@" >"$T/out" 2>&1; }

echo '== start: the old lead goes first'
reset old-1 0; echo '[{"id":"sy-1","status":"in_progress","title":"build the thing"},{"id":"sy-2","status":"blocked","title":"wait for review"}]' >"$T/st/items.json"
check "an idle old lead: archived, the new one starts" bash -c "'$P/bin/lead' start qa >'$T/out' 2>&1 && grep -q 'archived previous qa lead old-1' '$T/out' && test -s '$T/st/prompt'"
check "...its first prompt has the brief and the open items (in progress, blocked)" bash -c "grep -q 'you are the qa lead of acme-shop' '$T/st/prompt' && grep -q 'Handover' '$T/st/prompt' && grep -q -- '- sy-1 (in_progress): build the thing' '$T/st/prompt' && grep -q -- '- sy-2 (blocked): wait for review' '$T/st/prompt'"
reset old-1 1
check "an old lead busy for a moment: waited for, archived without interrupting it" bash -c "'$P/bin/lead' start qa >'$T/out' 2>&1 && grep -qx 'archived previous qa lead old-1' '$T/out' && test -s '$T/st/prompt'"
reset old-1 -1
check "an old lead that stays busy: interrupted (--force) after the wait, and it says so" bash -c "'$P/bin/lead' start qa >'$T/out' 2>&1 && grep -q 'archived previous qa lead old-1 (interrupted' '$T/out' && test -s '$T/st/prompt'"
reset old-1 -1; touch "$T/st/stuck"
check "an old lead that can't be archived: no second lead starts, exit 1, paseo's reason shown" bash -c "! '$P/bin/lead' start qa >'$T/out' 2>&1 && ! test -e '$T/st/prompt' && grep -q 'could not archive qa lead old-1: daemon refused' '$T/out' && grep -q 'not starting a second qa lead' '$T/out'"
reset old-1 0; rm -f "$T/st/items.json"
check "no open items: no handover in the prompt" bash -c "'$P/bin/lead' start qa >'$T/out' 2>&1 && test -s '$T/st/prompt' && ! grep -q Handover '$T/st/prompt'"
reset old-1 0
check "the queue head from wake (LEAD_NEXT): in the first prompt, with how to claim it" bash -c "LEAD_NEXT='- sy-3 (P1): the next thing' '$P/bin/lead' start qa >'$T/out' 2>&1 && grep -q 'Next in your queue' '$T/st/prompt' && grep -q -- '- sy-3 (P1): the next thing' '$T/st/prompt' && grep -q 'bd update <id> --claim' '$T/st/prompt'"
check "...and nothing of it without LEAD_NEXT" bash -c "'$P/bin/lead' start qa >'$T/out' 2>&1 && ! grep -q 'Next in your queue' '$T/st/prompt'"
printf 'old-1\nold-2\n' >"$T/st/agents"
check "two old leads of the role (the sy-8n1 state): both archived, then one starts" bash -c "'$P/bin/lead' start qa >'$T/out' 2>&1 && [ \"\$(grep -c 'archived previous qa lead' '$T/out')\" = 2 ] && ! test -s '$T/st/agents'"

echo '== stop'
reset old-1 0
check "stop: archived" bash -c "'$P/bin/lead' stop qa >'$T/out' 2>&1 && grep -q 'archived qa lead old-1' '$T/out'"
reset old-1 -1; touch "$T/st/stuck"
check "stop, and it can't be archived: exit 1, it says which lead is still there" bash -c "! '$P/bin/lead' stop qa >'$T/out' 2>&1 && grep -q 'qa lead(s) still there: old-1' '$T/out'"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
