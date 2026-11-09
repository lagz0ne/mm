#!/usr/bin/env bash
# bin/bd adds needs-you only with a valid owner card (sy-z5lz): label add (the label in any position), update
# --add-label / -l / --set-labels, create / q -l / --labels are refused (exit 1, the reasons, the format; bd itself
# never runs) when the item's description, or the one the call sets (-d, --description, --body-file), has no valid card;
# t2 on a go ask (You: Tap Approve) asks for If yes, If no, Risk, Head, and review's sign-off first (signed-off; sy-l9uc;
# a non-go ask, You: Reply:/Check:/Nothing, needs neither: sy-t9tg), also when t2 is added to an item
# that has needs-you; a card that names its Head needs review's signed-head for that head (sy-hzmu). Allowed: a valid card, removing the label, any other label, any other command (and
# those never read the item). bin/owner-card check <id> reads the item through bin/bd show. Hermetic: a copy of the
# template's bin/bd, bin/owner-card and its lib in a throwaway folder; a stand-in bd (it records its arguments and
# answers `show` from fixture files) and bin/trace (no span).
#   test/owner-card-bd.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }

mkdir -p "$T/bin/lib" "$T/tools" "$T/control" "$T/items"
cp "$SRC/template/bin/bd" "$SRC/template/bin/owner-card" "$SRC/template/bin/message" "$SRC/template/bin/task" "$T/bin/"
cp "$SRC/template/bin/lib/owner-card.mjs" "$SRC/template/bin/lib/message.mjs" "$SRC/template/bin/lib/writing.mjs" "$SRC/template/bin/lib/glossary.mjs" "$SRC/template/bin/lib/task.mjs" "$SRC/template/bin/lib/raci.mjs" "$SRC/template/bin/lib/structured.mjs" "$SRC/template/bin/lib/schema.mjs" "$SRC/template/bin/lib/schemas.mjs" "$T/bin/lib/"
cp -R "$SRC/template/bin/lib/schemas" "$T/bin/lib/"
printf '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n' >"$T/bin/trace"
# the stand-in bd: `show <id> --json` from items/<id>.json (shows are logged apart), everything else recorded in ran
cat >"$T/tools/bd" <<EOF
#!/bin/sh
if [ "\$1" = show ]; then echo "\$2" >>"$T/shows"; f="$T/items/\$2.json"; [ -f "\$f" ] && exec cat "\$f"; echo "no issue \$2" >&2; exit 1; fi
echo "\$*" >>"$T/ran"
EOF
chmod +x "$T/bin/bd" "$T/bin/owner-card" "$T/bin/trace" "$T/tools/bd"
unset BD_ACTOR MM_TRACE_SELF; export BEADS_ACTOR=ops

CARD='## Owner
- **What:** Every item that needs you shows a fixed short card at the top; the board checks it.
- **Why:** You see what is asked and why without reading the agents'"'"' threads.
- **You:** Nothing

The rest of the text.'
T2CARD='## Owner
- **What:** Open the mail port to the relay.
- **Why:** The alerts cannot leave the machine.
- **You:** Tap Approve
- **If yes:** Ops opens the port and tests one alert.
- **If no:** The alerts stay on the board only.
- **Risk:** medium, a wrong rule can close a port; the rollback is tested.
- **Head:** mm@0a1b2c3

## Task
- **Task:** Open the mail port to the relay.
- **Act:** t2-change
- **Done when:** one alert reaches the relay.
- **Verify:** the alert test → sent
- **Rollback:** close the port again with the plan'"'"'s rule.
- **Safeguard:** none, no access change'
# the same card, its Task without a Rollback / Safeguard / both (sy-w5az)
T2NOROLL=$(printf '%s' "$T2CARD" | grep -v '^- \*\*Rollback:')
T2NOSAFE=$(printf '%s' "$T2CARD" | grep -v '^- \*\*Safeguard:')
T2NOTASK=$(printf '%s' "$T2CARD" | sed '/^## Task$/,$d')
# a go ask (You: Tap Approve) without the t2 keys; a non-go ask (sy-t9tg: You: Check:) asks before any head exists
GOCARD=$(printf '%s' "$CARD" | sed 's/^- \*\*You:\*\* Nothing$/- **You:** Tap Approve/')
NGCARD='## Owner
- **What:** Check that the admin login works before the plan is written.
- **Why:** The plan depends on sudo working for that account.
- **You:** Check: run ssh admin@host, then sudo -v, and say if it worked

The rest of the text.'
item() { node -e 'process.stdout.write(JSON.stringify([{ id: process.argv[1], description: process.argv[2], labels: JSON.parse(process.argv[3]) }]))' "$1" "$2" "$3" >"$T/items/$1.json"; }
item sy-good "$CARD" '[]'
item sy-none "Just a text, no card." '[]'
item sy-late "Intro.

$CARD" '[]'
item sy-t2 "$GOCARD" '["t2"]'
item sy-ng "$NGCARD" '["t2"]'
item sy-ngny "$NGCARD" '["needs-you"]'
item sy-ngbad "$(printf '%s' "$NGCARD" | sed 's/^- \*\*You:\*\* \(.*\)$/- **You:** \1\n- **Risk:** maybe/')" '["t2"]'
item sy-t2ok "$T2CARD" '["t2","signed-off","signed-head:mm@0a1b2c3"]'
item sy-t2nohead "$(printf '%s' "$T2CARD" | grep -v '^- \*\*Head:')" '["t2","signed-off","signed-head:mm@0a1b2c3"]'
item sy-t2full "$T2CARD" '["t2"]'
item sy-nyfull "$T2CARD" '["needs-you"]'
item sy-wrongitem "$(printf '%s' "$CARD" | sed 's|^- \*\*You:\*\* Nothing$|- **You:** Nothing\n- **Item:** https://board-shop.example.org/?item=sy-other|')" '[]'
item sy-item "$(printf '%s' "$CARD" | sed 's|^- \*\*You:\*\* Nothing$|- **You:** Tap Approve in Telegram, or press Approve on this item\n- **Item:** https://board-shop.example.org/?item=sy-item|')" '[]'
printf '%s\n' "$CARD" >"$T/card.md"
printf 'no card here\n' >"$T/nocard.md"
printf '%s\n' "$T2CARD" >"$T/t2card.md"

call() { : >"$T/ran"; : >"$T/shows"; (cd "$T/control" && "$T/bin/bd" "$@") >/dev/null 2>"$T/err"; echo $? >"$T/code"; }
# as an actor other than ops (the default here): only review adds signed-off and signed-head:* (sy-9bss)
as() { local who=$1; shift; (export BEADS_ACTOR="$who"; call "$@"); }
refused() { [ "$(cat "$T/code")" = 1 ] && [ ! -s "$T/ran" ] && grep -q '^bd: refused: needs-you only with a valid owner card' "$T/err" && grep -q 'The format: the description starts with "## Owner"' "$T/err"; }
passed() { [ "$(cat "$T/code")" = 0 ] && [ -s "$T/ran" ]; }
noshow() { [ ! -s "$T/shows" ]; }
says() { grep -q -- "$1" "$T/err"; }

echo "== needs-you on an item with no valid card: refused, bd never runs"
call label add sy-none needs-you;                       check "label add (no card)" refused
check "...the reason" says "sy-none: it has no owner card"
check "...and how" says "no owner card: the description does not start with"
call label add sy-late needs-you;                       check "label add (card not at the top)" refused
check "...the reason" says "not at the top"
call label add needs-you sy-none;                       check "label add, the label first" refused
call label add sy-good sy-none needs-you;               check "label add on two items, one without" refused
call update sy-none --add-label needs-you;              check "update --add-label" refused
call update sy-none --add-label=needs-you;              check "update --add-label=needs-you" refused
call update sy-none --add-label t1,needs-you;           check "update --add-label t1,needs-you (any position)" refused
call update sy-none -l needs-you;                       check "update -l" refused
call update sy-none --set-labels x,needs-you;           check "update --set-labels" refused
call update sy-good -d "no card now" --add-label needs-you; check "update -d (no card) on an item with one: the new text counts" refused
call create "a title" -d "no card" -l needs-you;        check "create -d (no card) -l needs-you" refused
call create "a title" --labels=bug,needs-you;           check "create with no description, --labels=bug,needs-you" refused
call create "a title" --body-file "$T/nocard.md" -l needs-you; check "create --body-file (no card)" refused
call q "a title" -l needs-you;                          check "q -l needs-you" refused
call label add sy-t2 needs-you;                         check "t2 item, card without If yes/If no/Risk" refused
check "...the t2 reason" says "If yes is missing (required with t2)"
call create "a title" --description "$GOCARD" -l t2,needs-you; check "create t2 with a go card lacking the t2 keys" refused
call label add sy-missing needs-you;                    check "an item bd cannot show" refused
call --json update sy-none --add-label needs-you;       check "a global flag first" refused
call label add sy-wrongitem needs-you;                  check "an Item line to another item" refused
check "...the reason" says "Item points to sy-other, not to this item (sy-wrongitem)"

echo "== allowed"
call label add sy-good needs-you;                       check "label add on an item with a valid card" passed
check "...bd gets the arguments as they were" grep -qx 'label add sy-good needs-you' "$T/ran"
call update sy-good --add-label needs-you;              check "update --add-label (valid card)" passed
call update sy-none --body-file "$T/card.md" --add-label needs-you; check "update --body-file (the card) --add-label: the new text counts" passed
call create "a title" -d "$CARD" -l needs-you;          check "create -d <card> -l needs-you" passed
call create "a title" --body-file "$T/card.md" --labels needs-you; check "create --body-file <card>" passed
call label add sy-t2ok needs-you;                       check "t2 item with a full t2 card, signed off" passed
call label add sy-item needs-you;                       check "a You with where to act, and its own Item line" passed
call label remove sy-none needs-you;                    check "label remove needs-you" passed
check "...reads nothing" noshow
call update sy-none --remove-label needs-you;           check "update --remove-label needs-you" passed
check "...reads nothing" noshow
call label add sy-none t1;                              check "label add of another label" passed
check "...reads nothing" noshow
call update sy-none --claim;                            check "update --claim" passed
check "...reads nothing" noshow
call comments add sy-none "NOTE → ops
needs-you, says the text";   check "a comment that names needs-you" passed
check "...reads nothing" noshow
call show sy-none --json;                               check "a read" true

echo "== a t2 item waits on the owner only after review's sign-off (sy-l9uc)"
call label add sy-t2full needs-you;                     check "t2, a full card, no signed-off: label add needs-you refused" refused
check "...the reason: plan, sign-off, then needs-you" says "plan -> review's sign-off -> needs-you"
call update sy-t2full --add-label needs-you;            check "...update --add-label needs-you too" refused
call create "a title" -d "$T2CARD" -l t2,needs-you;     check "create t2,needs-you with a full card, no signed-off" refused
as review create "a title" -d "$T2CARD" -l t2,signed-off,signed-head:mm@0a1b2c3,needs-you; check "create t2,signed-off,signed-head,needs-you with a full card" passed
call label add sy-nyfull t2;                            check "adding t2 to an item with needs-you, no signed-off: refused" refused
call update sy-nyfull --add-label t2;                   check "...update --add-label t2 too" refused
call update sy-nyfull --add-label=t2;                   check "...--add-label=t2 too" refused
as review update sy-nyfull --add-label t2,signed-off,signed-head:mm@0a1b2c3; check "adding t2 with signed-off and its signed-head in the same call" passed
call label add sy-good t2;                              check "adding t2 to an item without needs-you" passed
call label add sy-t2x t1;                               check "an id with t2 inside it, another label: no gate" passed
check "...reads nothing" noshow
call update sy-nyfull --set-labels t2;                  check "--set-labels t2 (needs-you dropped by the set): allowed" passed

echo "== a t2 non-go ask (You: Reply:/Check:/Nothing) waits on the owner before any sign-off or head (sy-t9tg)"
call label add sy-ng needs-you;                         check "t2, a Check: card, no Head, no signed-off: label add needs-you passed" passed
call update sy-ng --add-label needs-you;                check "...update --add-label needs-you too" passed
call create "a title" -d "$NGCARD" -l t2,needs-you;     check "create t2,needs-you with a non-go card" passed
call label add sy-ngny t2;                              check "adding t2 to a non-go item with needs-you" passed
call create "a title" -d "$CARD" -l t2,needs-you;       check "create t2,needs-you with You: Nothing" passed
call label add sy-ngbad needs-you;                      check "a non-go card's optional keys are checked: a bad Risk refused" refused
check "...the reason" says "Risk does not start with low, medium or high"
call update sy-ng -d "$T2CARD" --add-label needs-you;   check "the same item, its card made a go ask in the call: refused (no signed-off)" refused
check "...the reason: plan, sign-off, then needs-you" says "plan -> review's sign-off -> needs-you"

echo "== a t2 card that names its head waits on the owner only when review signed off that head (sy-hzmu)"
HCARD=$T2CARD # it names its head: mm@0a1b2c3
call label add sy-t2nohead needs-you;                   check "a t2 card with no Head: refused (no fail-open, review sy-hzmu #3)" refused
check "...the reason" says "Head is missing (required with t2)"
item sy-hmoved "$(printf '%s' "$HCARD" | sed 's/0a1b2c3/9f8e7d6/')" '["t2","signed-off","signed-head:mm@0a1b2c3"]'
item sy-hmatch "$HCARD" '["t2","signed-off","signed-head:mm@0a1b2c3"]'
item sy-hnone "$HCARD" '["t2","signed-off"]'
call label add sy-hmoved needs-you;                     check "the head moved after the sign-off: label add needs-you refused" refused
check "...the reason names both heads" says "the head changed since review's sign-off (card: mm@9f8e7d6, signed: mm@0a1b2c3)"
call update sy-hmoved --add-label needs-you;            check "...update --add-label needs-you too" refused
call label add sy-hnone needs-you;                      check "signed off, but no signed-head: refused" refused
check "...the reason" says "review's sign-off names no head (card: mm@0a1b2c3)"
call update sy-hmatch -d "$(printf '%s' "$HCARD" | sed 's/0a1b2c3/9f8e7d6/')" --add-label needs-you; check "a new head in the call's own description: refused" refused
call label add sy-hmatch needs-you;                     check "the signed head is the card's head: passed" passed
as review update sy-hnone --add-label signed-head:mm@0a1b2c3,needs-you; check "signed-head added in the same call: passed" passed
as review create "a title" -d "$HCARD" -l t2,signed-off,signed-head:mm@0a1b2c3,needs-you; check "create with the matching signed-head: passed" passed

echo "== a t2 go ask waits on the owner only with a Rollback and a Safeguard in its Task (sy-w5az)"
SIGNED_T2='["t2","signed-off","signed-head:mm@0a1b2c3"]'
item sy-noroll "$T2NOROLL" "$SIGNED_T2"
item sy-nosafe "$T2NOSAFE" "$SIGNED_T2"
item sy-notask "$T2NOTASK" "$SIGNED_T2"
call label add sy-noroll needs-you;                     check "signed head, no Rollback: label add needs-you refused" refused
check "...the reason names the line" says "the item's Task has no Rollback line: a t2 go needs both"
check "...and the fix" grep -qF "or none, no access change). Write both lines in the item's Task (bd update <id> --body-file <file>); add needs-you after." "$T/err"
call update sy-nosafe --add-label needs-you;            check "signed head, no Safeguard: update --add-label needs-you refused" refused
check "...the reason names the line" says "the item's Task has no Safeguard line"
call label add sy-notask needs-you;                     check "signed head, no Task at all: refused" refused
check "...the reason names both" says "the item's Task has no Rollback and no Safeguard line"
call update sy-notask --body-file "$T/t2card.md" --add-label needs-you; check "...the call's own description adds both: passed" passed
call update sy-hmatch -d "$T2NOSAFE" --add-label needs-you; check "...the call's own description drops one: refused" refused
as review create "a title" -d "$T2NOTASK" -l t2,signed-off,signed-head:mm@0a1b2c3,needs-you; check "create with the signed head, no Task lines: refused" refused
item sy-ngnotask "$NGCARD" "$SIGNED_T2"
call label add sy-ngnotask needs-you;                   check "a t2 non-go ask needs neither: passed" passed

echo "== only review signs off: signed-off and signed-head:* (sy-9bss)"
sorefused() { [ "$(cat "$T/code")" = 1 ] && [ ! -s "$T/ran" ] && grep -q '^bd: refused: only review signs off (signed-off, signed-head:): ask review on the item' "$T/err"; }
item sy-so "Plan." '["t2","signed-off"]'
item sy-plain "Plan." '["t2"]'
call label add sy-plain signed-off;                     check "ops: label add signed-off refused, bd never runs" sorefused
check "...reads nothing" noshow
as platform label add sy-plain signed-head:mm@0a1b2c3;  check "platform: label add signed-head:* refused" sorefused
call label remove sy-so signed-off;                     check "ops: label remove signed-off refused" sorefused
call update sy-plain --add-label signed-off;            check "ops: update --add-label signed-off refused" sorefused
call update sy-plain --add-label=t1,signed-off;         check "ops: update --add-label=t1,signed-off refused" sorefused
call update sy-plain -l signed-head:mm@0a1b2c3;         check "ops: update -l signed-head:* refused" sorefused
call update sy-so --remove-label signed-off;            check "ops: update --remove-label signed-off refused" sorefused
call update sy-plain --set-labels t2,signed-off;        check "ops: --set-labels that adds signed-off refused" sorefused
call update sy-so --set-labels t2;                      check "ops: --set-labels that drops signed-off refused" sorefused
call create "a title" -l t2,signed-off;                 check "ops: create -l signed-off refused" sorefused
call q "a title" --labels=signed-head:mm@0a1b2c3;       check "ops: q --labels=signed-head:* refused" sorefused
call --actor platform/w1 label add sy-plain signed-off; check "--actor platform/w1 (over BEADS_ACTOR) refused" sorefused
(unset BEADS_ACTOR; export BD_ACTOR=platform; call label add sy-plain signed-off); check "BD_ACTOR=platform refused" sorefused
as reviewer label add sy-plain signed-off;              check "an actor named reviewer is not review: refused" sorefused
as review label add sy-plain signed-off;                check "review: label add signed-off passed" passed
check "...reads nothing" noshow
as review/w2 update sy-plain --add-label signed-head:mm@0a1b2c3; check "review/<worker>: passed" passed
as review update sy-so --remove-label signed-off;       check "review: remove passed" passed
call --actor review label add sy-plain signed-off;      check "--actor review (over BEADS_ACTOR=ops) passed" passed
call update sy-so --set-labels t2,signed-off,t1;        check "ops: --set-labels that keeps signed-off as it is passed" passed
check "...and read the item" grep -qx sy-so "$T/shows"
call update sy-plain --set-labels t2,t1;                check "ops: --set-labels on an item with no sign-off, none set: passed" passed
call update sy-plain -d "signed-off is review's" --add-label t1; check "ops: signed-off only in a text: passed" passed
check "...reads nothing" noshow
call comments add sy-plain "NOTE → review
signed-off, signed-head:mm@0a1b2c3"; check "ops: a comment naming them: passed" passed
check "...reads nothing" noshow
call label add sy-plain t1;                             check "ops: another label: passed" passed
check "...reads nothing" noshow
call label add sy-plain signed-offish;                  check "ops: signed-offish is not signed-off: passed" passed
call list -l signed-off;                                check "ops: a read with -l signed-off: passed" passed

echo "== the actor check still comes first"
(unset BEADS_ACTOR; call label add sy-good needs-you; grep -q 'needs an actor' "$T/err" && [ ! -s "$T/shows" ]); check "no actor: refused for the actor, no read" test $? = 0

echo "== bin/owner-card check <id>"
cc() { (cd "$T/control" && "$T/bin/owner-card" check "$@") >/dev/null 2>"$T/err"; echo $? >"$T/code"; }
cc sy-good;  check "a valid card: exit 0" test "$(cat "$T/code")" = 0
cc sy-none;  check "no card: exit 1" test "$(cat "$T/code")" = 1
check "...the reason" says "sy-none has no owner card"
cc sy-t2;    check "t2 without its keys: exit 1" test "$(cat "$T/code")" = 1
cc sy-missing; check "an item bd cannot show: exit 2" test "$(cat "$T/code")" = 2

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
