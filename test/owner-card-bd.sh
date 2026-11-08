#!/usr/bin/env bash
# bin/bd adds needs-you only with a valid owner card (sy-z5lz): label add (the label in any position), update
# --add-label / -l / --set-labels, create / q -l / --labels are refused (exit 1, the reasons, the format; bd itself
# never runs) when the item's description, or the one the call sets (-d, --description, --body-file), has no valid card;
# t2 asks for If yes, If no, Risk. Allowed: a valid card, removing the label, any other label, any other command (and
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
cp "$SRC/template/bin/bd" "$SRC/template/bin/owner-card" "$T/bin/"
cp "$SRC/template/bin/lib/owner-card.mjs" "$T/bin/lib/"
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
- **Risk:** medium, a wrong rule can close a port; the rollback is tested.'
item() { node -e 'process.stdout.write(JSON.stringify([{ id: process.argv[1], description: process.argv[2], labels: JSON.parse(process.argv[3]) }]))' "$1" "$2" "$3" >"$T/items/$1.json"; }
item sy-good "$CARD" '[]'
item sy-none "Just a text, no card." '[]'
item sy-late "Intro.

$CARD" '[]'
item sy-t2 "$CARD" '["t2"]'
item sy-t2ok "$T2CARD" '["t2"]'
item sy-wrongitem "$(printf '%s' "$CARD" | sed 's|^- \*\*You:\*\* Nothing$|- **You:** Nothing\n- **Item:** https://board-shop.example.org/?item=sy-other|')" '[]'
item sy-item "$(printf '%s' "$CARD" | sed 's|^- \*\*You:\*\* Nothing$|- **You:** Tap Approve in Telegram, or press Approve on this item\n- **Item:** https://board-shop.example.org/?item=sy-item|')" '[]'
printf '%s\n' "$CARD" >"$T/card.md"
printf 'no card here\n' >"$T/nocard.md"

call() { : >"$T/ran"; : >"$T/shows"; (cd "$T/control" && "$T/bin/bd" "$@") >/dev/null 2>"$T/err"; echo $? >"$T/code"; }
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
call create "a title" --description "$CARD" -l t2,needs-you; check "create t2 with a card lacking the t2 keys" refused
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
call label add sy-t2ok needs-you;                       check "t2 item with a full t2 card" passed
call label add sy-item needs-you;                       check "a You with where to act, and its own Item line" passed
call label remove sy-none needs-you;                    check "label remove needs-you" passed
check "...reads nothing" noshow
call update sy-none --remove-label needs-you;           check "update --remove-label needs-you" passed
check "...reads nothing" noshow
call label add sy-none t1;                              check "label add of another label" passed
check "...reads nothing" noshow
call update sy-none --claim;                            check "update --claim" passed
check "...reads nothing" noshow
call comments add sy-none "needs-you, says the text";   check "a comment that names needs-you" passed
check "...reads nothing" noshow
call show sy-none --json;                               check "a read" true

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
