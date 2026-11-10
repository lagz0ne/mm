#!/usr/bin/env bash
# bin/bd refuses a board write with no actor (sy-28ev): comment(s add), update, close, create, reopen, label add|remove,
# dep add|remove ... with no --actor and no BEADS_ACTOR / BD_ACTOR exit 1 with a clear message, and bd itself is never
# run (it would record the machine user, `mm`, which reads as a person). With an actor they pass; reads need none; text
# after `--` is never taken for an actor. A HANDOFF to review, or to the item's V (sy-mv69.1), needs its gates file.
# Hermetic: a copy of the template's bin/bd in a throwaway folder, a stand-in
# for bd (it records its arguments) and for bin/trace (no span).
#   test/bd-actor.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }

mkdir -p "$T/bin/lib" "$T/tools" "$T/control" "$T/leads"
cp "$SRC/template/bin/bd" "$SRC/template/bin/message" "$SRC/template/bin/task" "$T/bin/"
cp "$SRC/template/bin/lib/message.mjs" "$SRC/template/bin/lib/owner-card.mjs" "$SRC/template/bin/lib/gates-file.mjs" "$SRC/template/bin/lib/writing.mjs" "$SRC/template/bin/lib/glossary.mjs" "$SRC/template/bin/lib/task.mjs" "$SRC/template/bin/lib/raci.mjs" "$SRC/template/bin/lib/structured.mjs" "$SRC/template/bin/lib/schema.mjs" "$SRC/template/bin/lib/schemas.mjs" "$T/bin/lib/"
cp -R "$SRC/template/bin/lib/schemas" "$T/bin/lib/"
printf '{"roles":[{"id":"ops"},{"id":"review"},{"id":"platform"}]}\n' >"$T/leads/roles.json"
printf '#!/bin/sh\n# stand-in for bin/trace: no span, just the command after --\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n' >"$T/bin/trace"
printf '#!/bin/sh\necho "$*" >>"%s"\n' "$T/ran" >"$T/tools/bd"
chmod +x "$T/bin/bd" "$T/bin/trace" "$T/tools/bd"
unset BEADS_ACTOR BD_ACTOR MM_TRACE_SELF

# one call: its exit code in code, its stderr in err; ran: what reached bd (empty: nothing)
call() { : >"$T/ran"; (cd "$T/control" && "$T/bin/bd" "$@") >/dev/null 2>"$T/err"; echo $? >"$T/code"; }
refused() { [ "$(cat "$T/code")" = 1 ] && [ ! -s "$T/ran" ] && grep -q '^bd: refused: a board write (bd .*) needs an actor: pass --actor <name> or set BEADS_ACTOR' "$T/err"; }
passed() { [ "$(cat "$T/code")" = 0 ] && [ -s "$T/ran" ]; }
notmsg() { [ "$(cat "$T/code")" = 1 ] && [ ! -s "$T/ran" ] && grep -qF "bd: refused: a lead's comment is one message" "$T/err"; }

echo "== a write with no actor: refused, bd never runs"
call comments add sy-1 "a comment";                 check "comments add" refused
call comment sy-1 "a comment";                      check "comment" refused
call update sy-1 --claim;                           check "update --claim" refused
call close sy-1 --reason done;                      check "close" refused
call label add sy-1 needs-you;                      check "label add" refused
call label remove sy-1 needs-you;                   check "label remove" refused
call create "a title" -d "text" -p 2;               check "create" refused
call reopen sy-1;                                   check "reopen" refused
call dep add sy-1 sy-2;                             check "dep add" refused
call dep remove sy-1 sy-2;                          check "dep remove" refused
call --json update sy-1 -s open;                    check "a global flag first (--json update)" refused
call update sy-1 -s open --actor "";                check "an empty --actor" refused
call comments add sy-1 -- "--actor someone";        check "text after -- is not an actor" refused
check "the message names the command" grep -qF '(bd comments add) needs an actor' "$T/err"

echo "== with an actor: passes"
call comments add sy-1 "x" --actor wake;            check "--actor wake" passed
check "...and bd gets the arguments as they were" grep -qx 'comments add sy-1 x --actor wake' "$T/ran"
call update sy-1 --claim --actor=platform;          check "--actor=platform" passed
(export BEADS_ACTOR=ops; call close sy-1);          check "BEADS_ACTOR=ops" passed
(export BD_ACTOR=review; call label add sy-1 x);    check "BD_ACTOR=review" passed
call comments add sy-1 --actor mm-upstream -- "text"; check "--actor before --, text after" passed

echo "== a lead's comment is one message (sy-0gsw); the system's and a person's pass unread"
call comments add sy-1 "done, have a look" --actor platform; check "platform: free text refused" notmsg
check "...nothing reached bd" test ! -s "$T/ran"
check "...the reason names the format" grep -qF "a lead's comment is one message" "$T/err"
call comments add sy-1 --actor ops/certs -- "free text";   check "ops/certs (a worker): free text refused" notmsg
call comments add sy-1 --actor platform -- "NOTE → ops
Claimed; plan in #2.";                                      check "platform: a valid NOTE passes" passed
call comment sy-1 "free text" --actor alex;                 check "alex (a person): passes" passed

echo "== a HANDOFF → review brings its head's gates file (sy-6avk)"
HO="HANDOFF → review
Head: mm@1122334
Expect: review: sign off or block this head.
Done when: the item has signed-head:mm@1122334, or a VERDICT blocked.
Verify: bd show sy-g --json → labels include signed-head:mm@1122334
By: next wake · Else: nothing rolls out
Ready: the check
Surfaces: none"
call comments add sy-g --actor platform/w -- "$HO";        check "no gates file: refused, bd never runs" test "$(cat "$T/code")" = 1 -a ! -s "$T/ran"
check "...the reason names the file to make" grep -qF "bd: refused (platform/w): HANDOFF → review needs the gates result for mm@1122334: no artifacts/sy-g/gates-1122334.txt. Run test/gates <base>..1122334 --item sy-g first" "$T/err"
mkdir -p "$T/artifacts/sy-g"
printf 'head: 1122334 a subject\nresult: passed: 1 passed, 0 failed, 0 skipped, of 1\n\ntest/a.sh   hermetic  passed   1 ok   1s  logs/a.log\n' >"$T/artifacts/sy-g/gates-1122334.txt"
call comments add sy-g --actor platform/w -- "$HO";        check "a passing gates file: passed" passed
call comments add sy-h --actor platform -- "${HO//review/ops}"; check "the same HANDOFF → ops: not checked, passed" passed
# sy-mv69.1: evidence before a handoff to V: a HANDOFF → the role that is V in the item's RACI row needs the file too
printf '{"activities":[{"id":"opsv","title":"Ops verifies","raci":{"platform":"R","ops":"V","review":"A"}}]}\n' >"$T/leads/raci.json"
printf '#!/bin/sh\ncase "$1" in show) case "$2" in sy-v) echo %s ;; *) echo %s ;; esac; exit 0 ;; esac\necho "$*" >>"%s"\n' \
  "'[{\"id\":\"sy-v\",\"labels\":[\"act:opsv\"]}]'" "'[{\"id\":\"sy-h\",\"labels\":[]}]'" "$T/ran" >"$T/tools/bd"
call comments add sy-v --actor platform -- "${HO//review/ops}"; check "a HANDOFF → ops, V in the item's row, no gates file: refused, bd never runs" test "$(cat "$T/code")" = 1 -a ! -s "$T/ran"
check "...the reason names the file to make" grep -qF "bd: refused (platform): HANDOFF → ops needs the gates result for mm@1122334: no artifacts/sy-v/gates-1122334.txt" "$T/err"
call comments add sy-h --actor platform -- "${HO//review/ops}"; check "...on an item with no activity: not checked, passed" passed
mkdir -p "$T/artifacts/sy-v"; cp "$T/artifacts/sy-g/gates-1122334.txt" "$T/artifacts/sy-v/"
call comments add sy-v --actor platform -- "${HO//review/ops}"; check "...with its passing gates file: passed" passed
rm -f "$T/leads/raci.json"; printf '#!/bin/sh\necho "$*" >>"%s"\n' "$T/ran" >"$T/tools/bd"

echo "== reads need no actor"
for r in "list --json" "show sy-1 --json" "ready --json" "comments sy-1 --json" "label list sy-1" "dep list sy-1" "dep tree sy-1" "config get no-hooks" "export --all"; do
  # shellcheck disable=SC2086
  call $r; check "bd $r" passed
done

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
