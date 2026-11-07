#!/usr/bin/env bash
# Tests for box/mm-approve and template/bin/lib/ledger.mjs (sy-1jmi; docs/approvals.md), hermetic: the signer in test
# mode (not root, its config from MM_APPROVE_CONF), its home a throwaway folder, the test's own user as "the signer's
# user", a stub plan command for the board. No real user, no sudo, no Telegram. Review's condition 9: a forged line,
# a line for another subject, a changed plan after the offer, callback data naming another item, an expired offer, an
# offer used twice, a ledger with the wrong mode: none counts; and the good path counts, in both verifiers.
#   test/mm-approve.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
A="$HERE/box/mm-approve"; LIB="$HERE/template/bin/lib/ledger.mjs"
T=$(mktemp -d); trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0; skip=0
ok() { pass=$((pass+1)); printf '  ok   %b\n' "$*"; }; bad() { fail=$((fail+1)); printf '  FAIL %b\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
step() { printf '\n== %b\n' "$*"; }
# the verifiers read /etc/mm-approve.conf when it exists, never a caller's config: then their cases can't run here
ETC=no; [ -e /etc/mm-approve.conf ] && ETC=yes

D="$T/signer"; P="$T/pub"; mkdir -p "$D" "$P" "$T/plans"; chmod 755 "$D" "$P"
cat >"$T/plan" <<EOF
#!/bin/sh
# the board's plan command (stub): an item's code-written plan text
[ -f "$T/plans/\$1" ] || { echo "no item \$1" >&2; exit 1; }
cat "$T/plans/\$1"
EOF
chmod 755 "$T/plan"
conf() { # conf <file> [key = value lines...]
  local f=$1; shift
  { echo "# test config (the installed one is /etc/mm-approve.conf, root's)"
    echo "verifier = ledger"; echo "user = $(id -un)"; echo "dir = $D"; echo "public_key = $P/key.pub"
    echo "plan_command = $T/plan"; echo "owner_telegram_id = 4242"; echo "expires_hours = 24"; printf '%s\n' "$@"; } >"$f"
}
conf "$T/conf"; export MM_APPROVE_CONF="$T/conf"
# plan <item> <text> [<block file>...]: the item's plan, its prose then its blocks (sy-4py1: the subjects come only
# from the blocks the plan shows)
plan() { local f="$T/plans/$1"; printf '%s' "$2" >"$f"; shift 2; [ $# = 0 ] || cat "$@" >>"$f"; }
printf '#!/bin/sh\necho one\n' >"$T/s1"; printf '#!/bin/sh\necho undo one\n' >"$T/r1"
printf '#!/bin/sh\necho two\n' >"$T/s2"; printf '#!/bin/sh\necho undo two\n' >"$T/r2"
"$A" block migration one "$T/s1" "$T/r1" >"$T/b1"; "$A" block migration two "$T/s2" "$T/r2" >"$T/b2"
S1=$("$A" subject migration "$T/s1" "$T/r1"); S2=$("$A" subject migration "$T/s2" "$T/r2")
HS=$(printf h | sha1sum | cut -c1-40); BASE=$(printf b | sha1sum | cut -c1-40); HEAD=git:$HS
"$A" block head "$HS" "$BASE" >"$T/bh"
js() { node -e "$1" "$LIB" "${@:2}"; }
# nodev <item> <subject>: the node verifier's answer (yes/no)
nodev() { js 'import(process.argv[1]).then((m) => { const l = m.readLedger(); console.log(l.has(process.argv[2], process.argv[3]) ? "yes" : "no") })' "$@"; }
verify_yes() { [ $ETC = no ] && "$A" verify "$1" "$2" | grep -q '^yes' && [ "$(nodev "$1" "$2")" = yes ]; }
verify_no() { ! "$A" verify "$1" "$2" >/dev/null 2>&1 && [ "$(nodev "$1" "$2")" = no ]; }
vyes() { if [ $ETC = yes ]; then skip=$((skip+1)); echo "  skip $1 (this machine has /etc/mm-approve.conf)"; else check "$1" verify_yes "$2" "$3"; fi; }
vno() { if [ $ETC = yes ]; then skip=$((skip+1)); echo "  skip $1 (this machine has /etc/mm-approve.conf)"; else check "$1" verify_no "$2" "$3"; fi; }
refused() { local want=$1; shift; out=$("$@" 2>&1); rc=$?; [ $rc -ne 0 ] && grep -q 'refused' <<<"$out" && { [ "$want" = - ] || [ $rc = "$want" ]; }; }
lines() { grep -c . "$D/ledger.jsonl"; }
offer() { "$A" offer "$@" | python3 -c 'import json,sys; print(json.load(sys.stdin)["offer"])'; }
mode() { stat -c %a "$1"; }

step 'keygen: the key pair and the ledger, in the signer\x27s folder'
check 'keygen runs' "$A" keygen
check 'the private folder is 0700, the key 0600' bash -c "[ $(mode "$D/private") = 700 ] && [ \$(stat -c %a '$D/private/key.pem') = 600 ]"
check 'the public key and the ledger are 0644' bash -c "[ \$(stat -c %a '$D/key.pub') = 644 ] && [ \$(stat -c %a '$D/ledger.jsonl') = 644 ]"
check 'a second keygen is refused (one key)' refused - "$A" keygen
install -m 0644 "$D/key.pub" "$P/key.pub" # ops' step: the public key where the config says (root's on the machine)
check 'check: no problems' "$A" check

step 'the good path: offer, the owner taps, a signed line, both verifiers say yes'
plan sy-a $'Plan for sy-a: open port 8443.\nRollback: close it.\n' "$T/b1" "$T/bh"
plan sy-n $'Plan for sy-n: prose only, no block.\n'
check 'a plan with no block: refused, no subjects (fail closed)' refused - "$A" offer sy-n
check '...and a --subject does not make one' refused - "$A" offer sy-n --subject "$S1"
check 'an offer for an item with no plan is refused' refused - "$A" offer sy-nope --subject "$S1"
check 'a plan given that is not the board\x27s is refused (the signer offers only what it read itself)' \
  bash -c "printf 'another plan' | '$A' offer sy-a --subject '$S1' --plan-stdin 2>&1 | grep -q refused"
OUT=$("$A" offer sy-a --subject "$S1" --subject "$HEAD")
OA=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["offer"])' "$OUT")
H=$(sha256sum "$T/plans/sy-a" | cut -c1-64)
check 'the offer\x27s hash is the plan\x27s raw text, and the message shows the plan, its hash and the subjects' \
  python3 -c 'import json,sys; o=json.loads(sys.argv[1]); assert o["plan"]==sys.argv[2] and "open port 8443" in o["text"] and sys.argv[2] in o["text"] and sys.argv[3] in o["text"] and o["complete"]' "$OUT" "$H" "$S1"
check 'the offers are in the private folder, 0600' bash -c "[ \$(stat -c %a '$D/private/offers.json') = 600 ]"
check 'a tap by someone who is not the owner is refused' refused - "$A" tap "$OA" 999
check 'a tap of an offer this signer never made is refused' refused - "$A" tap "$(printf 'f%.0s' $(seq 32))" 4242
check 'the owner\x27s tap signs one line' bash -c "'$A' tap '$OA' 4242 | grep -q '\"approver\": \"telegram:4242\"' && [ \$(grep -c . '$D/ledger.jsonl') = 1 ]"
vyes 'verify: yes for sy-a and its subject' sy-a "$S1"
vyes 'verify: yes for sy-a and the git head it also names' sy-a "$HEAD"

step 'none of these counts (review condition 9)'
check 'an offer used twice: refused (exit 4), no second line' bash -c "out=\$('$A' tap '$OA' 4242 2>&1); [ \$? = 4 ] && [ \$(grep -c . '$D/ledger.jsonl') = 1 ]"
vno 'a line for another subject: no' sy-a "$S2"
vno 'another item with the same subject: no' sy-b "$S1"
plan sy-b $'Plan for sy-b.\n' "$T/b2"
OB=$(offer sy-b --subject "$S2")
check 'callback data naming another item (sy-a) than the offer (sy-b): refused' refused - "$A" tap "$OB" 4242 --item sy-a
vno '...so sy-a has no line for sy-b\x27s subject' sy-a "$S2"
check '...and the offer is still the owner\x27s to tap, for sy-b only' bash -c "'$A' tap '$OB' 4242 --item sy-b | grep -q '\"item\": \"sy-b\"'"
vyes '...which counts for sy-b' sy-b "$S2"
plan sy-c $'Plan for sy-c: v1.\n' "$T/b1"
OC=$(offer sy-c --subject "$S1")
plan sy-c $'Plan for sy-c: v2, something else.\n' "$T/b1"
check 'the plan changed after the offer: refused (exit 3), asks for a new offer' bash -c "out=\$('$A' tap '$OC' 4242 2>&1); [ \$? = 3 ] && grep -q 'new offer' <<<\"\$out\""
plan sy-c $'Plan for sy-c: v1.\n' "$T/b1"
check '...and that offer stays void, even with the plan back' refused - "$A" tap "$OC" 4242
vno '...no line for sy-c' sy-c "$S1"
plan sy-d $'Plan for sy-d.\n' "$T/b1"
NOW=$(date +%s)
OD=$(MM_APPROVE_NOW=$NOW offer sy-d --subject "$S1")
check 'an expired offer (25 h later): refused (exit 5)' bash -c "out=\$(MM_APPROVE_NOW=$((NOW + 25 * 3600)) '$A' tap '$OD' 4242 2>&1); [ \$? = 5 ]"
check '...one within its 24 h still taps' bash -c "MM_APPROVE_NOW=$((NOW + 23 * 3600)) '$A' tap '$OD' 4242 >/dev/null"

step 'a forged line (another key), a line changed after signing'
D2="$T/forger"; mkdir -p "$D2"; chmod 755 "$D2"
conf "$T/conf2"; sed -i "s|^dir = .*|dir = $D2|; s|^public_key = .*|public_key = $D2/key.pub|" "$T/conf2"
plan sy-e $'Plan for sy-e.\n' "$T/b1"
MM_APPROVE_CONF="$T/conf2" "$A" keygen >/dev/null
OE=$(MM_APPROVE_CONF="$T/conf2" offer sy-e --subject "$S1")
MM_APPROVE_CONF="$T/conf2" "$A" tap "$OE" 4242 >/dev/null
forger_yes() { MM_APPROVE_CONF="$T/conf2" "$A" verify sy-e "$S1" | grep -q '^yes'; }
if [ $ETC = no ]; then check 'the forged line is well-formed: its own key verifies it' forger_yes; fi
cat "$D2/ledger.jsonl" >>"$D/ledger.jsonl" # the forger's well-formed line, signed by its own key, in the real ledger
vno 'a line signed by another key: no' sy-e "$S1"
grep '"item": "sy-a"' "$D/ledger.jsonl" | head -1 | sed "s/\"item\": \"sy-a\"/\"item\": \"sy-f\"/" >>"$D/ledger.jsonl"
vno 'a good line with its item changed (sy-a -> sy-f): no' sy-f "$S1"
grep '"item": "sy-a"' "$D/ledger.jsonl" | head -1 | sed "s/${S1#sha256:}/${S2#sha256:}/" >>"$D/ledger.jsonl"
vno 'a good line with its subject changed: no' sy-a "$S2"
echo 'not json' >>"$D/ledger.jsonl"
vyes 'the good lines still count around them' sy-a "$S1"

step 'the ledger\x27s owner and mode (condition 8): with any wrong, nothing counts'
chmod 666 "$D/ledger.jsonl"; vno 'the ledger world-writable: no' sy-a "$S1"; chmod 664 "$D/ledger.jsonl"; vno 'the ledger group-writable: no' sy-a "$S1"; chmod 644 "$D/ledger.jsonl"
check 'check names the problem' bash -c "chmod 666 '$D/ledger.jsonl'; '$A' check | grep -q writable; r=\$?; chmod 644 '$D/ledger.jsonl'; exit \$r"
chmod 775 "$D"; vno 'its folder group-writable: no' sy-a "$S1"; chmod 755 "$D"
chmod 664 "$P/key.pub"; vno 'the public key group-writable: no' sy-a "$S1"; chmod 644 "$P/key.pub"
ln "$D/ledger.jsonl" "$T/hardlink"; vno 'the ledger with a second link: no' sy-a "$S1"; rm "$T/hardlink"
mv "$D/ledger.jsonl" "$T/real.jsonl"; ln -s "$T/real.jsonl" "$D/ledger.jsonl"; vno 'the ledger a symlink: no' sy-a "$S1"; rm "$D/ledger.jsonl"; mv "$T/real.jsonl" "$D/ledger.jsonl"
conf "$T/conf3"; sed -i "s|^user = .*|user = nobody|" "$T/conf3"
vno_other() { ! MM_APPROVE_CONF="$T/conf3" "$A" verify sy-a "$S1" >/dev/null 2>&1 && [ "$(MM_APPROVE_CONF="$T/conf3" nodev sy-a "$S1")" = no ]; }
if [ $ETC = no ]; then check 'a ledger that is not the signer user\x27s (nobody): no' vno_other; fi
vyes 'all modes right again: yes' sy-a "$S1"
check 'the signer refuses to run as another user than its own' refused - env MM_APPROVE_CONF="$T/conf3" "$A" offer sy-a --subject "$S1"

step 'the switch, the subjects, a long plan'
conf "$T/conf4" 'verifier = actor'
sw() { ! MM_APPROVE_CONF="$T/conf4" "$A" verify sy-a "$S1" >/dev/null 2>&1 && [ "$(MM_APPROVE_CONF="$T/conf4" js 'import(process.argv[1]).then((m) => console.log(m.loadConf().verifier))')" = actor ]; }
if [ $ETC = no ]; then check 'verifier = actor: verify says no; ledger.mjs reads actor' sw; fi
check 'no config at all: actor (today\x27s behaviour)' bash -c "[ \"\$(MM_APPROVE_CONF= node -e 'import(process.argv[1]).then((m) => console.log(m.loadConf({ etc: \"/nonexistent\" }).verifier))' '$LIB')\" = actor ]"
check 'with /etc\x27s file present, the env\x27s config is ignored (the switch is root\x27s)' bash -c "[ \"\$(node -e 'import(process.argv[1]).then((m) => console.log(m.loadConf({ etc: process.argv[2], env: { MM_APPROVE_CONF: process.argv[3] } }).path))' '$LIB' '$T/conf' '$T/conf4')\" = '$T/conf' ]"
printf '#!/bin/sh\necho migrate\n' >"$T/m.sh"; printf '#!/bin/sh\necho undo\n' >"$T/m.rollback.sh"
SUBJ=$("$A" subject migration "$T/m.sh" "$T/m.rollback.sh")
check 'a migration\x27s subject: the same in mm-approve and ledger.mjs' bash -c "[ \"\$(node -e 'import(process.argv[1]).then((m) => { const f = require(\"fs\"); console.log(m.migrationSubject(f.readFileSync(process.argv[2]), f.readFileSync(process.argv[3]))) })' '$LIB' '$T/m.sh' '$T/m.rollback.sh')\" = '$SUBJ' ]"
printf '#!/bin/sh\necho undo something else\n' >"$T/m.rollback.sh"
check '...and a changed rollback is another subject' bash -c "[ \"\$('$A' subject migration '$T/m.sh' '$T/m.rollback.sh')\" != '$SUBJ' ]"
check 'a head\x27s subject is git:<sha>' bash -c "[ \"\$('$A' subject head $(printf a%.0s $(seq 40)))\" = git:$(printf a%.0s $(seq 40)) ]"
conf "$T/conf5" 'max_shown = 40'
printf 'Line %s of a long plan.\n' $(seq 50) >"$T/long"; plan sy-g "$(cat "$T/long")"$'\n' "$T/b1"
check 'a plan longer than the message: it says so, shows the plan\x27s hash, the block\x27s hashes and subject, and hashes the whole plan' \
  bash -c "out=\$(MM_APPROVE_CONF='$T/conf5' '$A' offer sy-g --subject '$S1'); python3 -c 'import json,sys; o=json.loads(sys.argv[1]); assert not o[\"complete\"] and \"longer than this message\" in o[\"text\"] and o[\"plan\"]==sys.argv[2] and sys.argv[2] in o[\"text\"] and \"Line 50\" not in o[\"text\"] and sys.argv[3] in o[\"text\"] and sys.argv[4] in o[\"text\"]' \"\$out\" \$(sha256sum '$T/plans/sy-g' | cut -c1-64) '$S1' \$(sha256sum '$T/s1' | cut -c1-64)"

step 'the subjects come only from the blocks the owner is shown (sy-4py1, review condition 1)'
check 'the block format, byte for byte: a header with the length, the bytes, a newline; the rollback at once after' \
  bash -c "printf '=== mm-approve migration one script %s bytes\n' \$(wc -c <'$T/s1') >'$T/hand'; cat '$T/s1' >>'$T/hand'; echo >>'$T/hand'
           printf '=== mm-approve migration one rollback %s bytes\n' \$(wc -c <'$T/r1') >>'$T/hand'; cat '$T/r1' >>'$T/hand'; echo >>'$T/hand'
           cmp -s '$T/hand' '$T/b1' && [ \"\$(cat '$T/bh')\" = '=== mm-approve head $HS range $BASE..$HS' ]"
OUT=$("$A" offer sy-a)
check 'an offer with no --subject: the subjects are the plan\x27s blocks, in order' \
  python3 -c 'import json,sys; o=json.loads(sys.argv[1]); assert o["subjects"]==[sys.argv[2], sys.argv[3]], o["subjects"]' "$OUT" "$S1" "$HEAD"
check '...and the message shows each block: its script\x27s and rollback\x27s hashes, its subject, the head and range' \
  python3 -c 'import json,sys; t=json.loads(sys.argv[1])["text"]; assert all(a in t for a in sys.argv[2:]), t' "$OUT" "$S1" \
  "$(sha256sum "$T/s1" | cut -c1-64)" "$(sha256sum "$T/r1" | cut -c1-64)" "$HEAD" "$BASE..$HS" 'echo undo one'
check 'a --subject that is not one of the plan\x27s blocks (sy-b\x27s): refused' refused - "$A" offer sy-a --subject "$S2"
printf '#!/bin/sh\necho one, and something else\n' >"$T/staged"
STAGED=$("$A" subject migration "$T/staged" "$T/r1")
plan sy-h $'Plan for sy-h: migration one.\n' "$T/b1"
n=$(lines)
check 'a staged script that differs from the plan\x27s block: its subject is refused, no offer' bash -c "! '$A' offer sy-h --subject '$STAGED' >/dev/null 2>&1 && ! grep -q '$STAGED' '$D/private/offers.json'"
OH=$(offer sy-h --subject "$S1")
check '...the owner\x27s tap of the plan as shown signs (the good path)' bash -c "'$A' tap '$OH' 4242 | grep -q '\"item\": \"sy-h\"'"
check '...one line, for the shown script only' bash -c "[ \$(grep -c . '$D/ledger.jsonl') = $((n + 1)) ] && tail -1 '$D/ledger.jsonl' | grep -q '${S1#sha256:}' && ! grep -q '${STAGED#sha256:}' '$D/ledger.jsonl'"
vno '...and the staged script gets no line' sy-h "$STAGED"
vyes '...the shown one does' sy-h "$S1"
printf '#!/bin/sh\necho one\n=== mm-approve head %s range %s..%s\n' "$HS" "$BASE" "$HS" >"$T/s3"
"$A" block migration three "$T/s3" "$T/r1" >"$T/b3"
plan sy-i $'Plan for sy-i.\n' "$T/b3"
check 'a block line inside a script\x27s bytes is the script, not a block' \
  bash -c "'$A' offer sy-i | python3 -c 'import json,sys; o=json.load(sys.stdin); assert o[\"subjects\"]==[sys.argv[1]]' \"\$('$A' subject migration '$T/s3' '$T/r1')\""
bad_plan() { plan sy-j "$1"; refused - "$A" offer sy-j; }
check 'a block cut short: refused' bad_plan $'=== mm-approve migration x script 999 bytes\necho x\n'
{ head -4 "$T/b1"; printf 'more prose\n'; } >"$T/norb"
check 'a script block without its rollback: refused' bash -c "$(declare -f plan refused); A='$A' T='$T'; plan sy-j '' '$T/norb'; refused - '$A' offer sy-j"
check 'a line that starts like a block and is not one: refused' bad_plan $'Plan.\n=== mm-approve migration x script many bytes\n'
check 'a head line whose range ends elsewhere: refused' bad_plan "=== mm-approve head $HS range $BASE..$BASE"$'\n'
check 'the same block twice: refused' bash -c "$(declare -f plan refused); A='$A' T='$T'; plan sy-j '' '$T/b1' '$T/b1'; refused - '$A' offer sy-j"
check 'block refuses a name with a space or a short head' bash -c "! '$A' block migration 'a b' '$T/s1' '$T/r1' 2>/dev/null && ! '$A' block head abc '$BASE' 2>/dev/null"

step 'mm doctor: the ledger\x27s and the key\x27s owners and modes, when the switch says ledger'
export BUN=${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")} T
cat >"$T/doc.ts" <<EOF
import { approvalChecks } from '$HERE/src/doctor'
console.log(JSON.stringify(approvalChecks()))
EOF
doc() { HOME="$T/home" MM_HOME="$T/home/.mm" MM_APPROVE_CONF="$1" "$BUN" "$T/doc.ts" 2>/dev/null | python3 -c 'import json,sys; c=json.load(sys.stdin); assert len(c)==1 and c[0]["item"]=="approval ledger"; print(c[0]["status"], c[0]["detail"])'; }
mkdir -p "$T/home/.mm"
if [ $ETC = yes ]; then skip=$((skip+1)); echo "  skip doctor (this machine has /etc/mm-approve.conf)"
else
  check 'all right: ok' bash -c "$(declare -f doc); doc '$T/conf' | grep -q '^ok '"
  check 'the ledger world-writable: fail, named' bash -c "$(declare -f doc); chmod 666 '$D/ledger.jsonl'; doc '$T/conf' | grep -q '^fail .*writable'; r=\$?; chmod 644 '$D/ledger.jsonl'; exit \$r"
  check 'the private folder not 0700: fail' bash -c "$(declare -f doc); chmod 750 '$D/private'; doc '$T/conf' | grep -q '^fail .*private'; r=\$?; chmod 700 '$D/private'; exit \$r"
  check 'the key group-writable: fail' bash -c "$(declare -f doc); chmod 664 '$P/key.pub'; doc '$T/conf' | grep -q '^fail .*public key'; r=\$?; chmod 644 '$P/key.pub'; exit \$r"
  check 'verifier = actor: skip (nothing to check)' bash -c "$(declare -f doc); doc '$T/conf4' | grep -q '^skip .*actor'"
fi

printf '\n%s passed, %s failed, %s skipped\n' "$pass" "$fail" "$skip"
[ "$fail" = 0 ]
