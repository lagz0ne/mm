#!/usr/bin/env bash
# bd msg, bd task, bd card (sy-rfup, step 1; bin/structured): a good call builds one structured block (```mm-message v1,
# ```mm-task v1, ```mm-card v1), checks it, and posts it through bin/bd, whose gates of today pass it; each wrong call
# is refused with the reason (and the flag), and nothing reaches bd. bd task set and bd card set replace their block in
# place and keep the rest of the description. Today's key/value text still passes the gates.
# Hermetic: a copy of the template's bin/ in a throwaway folder, a stand-in for bd (it records its arguments and the
# file it is given; `show` prints a fixture) and for bin/trace (no span).
#   test/structured.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; sed 's/^/        /' "$T/err" 2>/dev/null | head -12; fail=$((fail+1)); fi; }

mkdir -p "$T/bin" "$T/tools" "$T/control" "$T/leads"
cp "$SRC/template/bin/bd" "$SRC/template/bin/message" "$SRC/template/bin/task" "$SRC/template/bin/owner-card" "$SRC/template/bin/structured" "$T/bin/"
cp -R "$SRC/template/bin/lib" "$T/bin/"
printf '{"roles":[{"id":"ops"},{"id":"review"},{"id":"platform"}]}\n' >"$T/leads/roles.json"
printf '{"activities":[{"id":"build","R":"platform"},{"id":"incident","R":"ops"},{"id":"mm-template","R":"platform"}]}\n' >"$T/leads/raci.json"
printf '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n' >"$T/bin/trace"
# the stand-in for bd: show prints the fixture; anything else is recorded, with the file after -f / --body-file
cat >"$T/tools/bd" <<EOF
#!/bin/sh
[ "\$1" = show ] && { cat "$T/show.json"; exit 0; }
echo "\$*" >>"$T/ran"
prev=''
for a in "\$@"; do case "\$prev" in -f|--body-file) cp "\$a" "$T/body" ;; esac; prev=\$a; done
EOF
chmod +x "$T/bin/bd" "$T/bin/trace" "$T/tools/bd" "$T/bin/structured"
unset BEADS_ACTOR BD_ACTOR MM_TRACE_SELF
show() { node -e 'process.stdout.write(JSON.stringify([{ id: "sy-1", description: process.argv[1], labels: JSON.parse(process.argv[2] || "[]") }]))' "$1" "${2:-[]}" >"$T/show.json"; }
show ''

call() { : >"$T/ran"; rm -f "$T/body"; (cd "$T/control" && "$T/bin/bd" "$@") >"$T/out" 2>"$T/err"; echo $? >"$T/code"; }
posted() { [ "$(cat "$T/code")" = 0 ] && [ -s "$T/ran" ]; }
refused() { [ "$(cat "$T/code")" = 1 ] && [ ! -s "$T/ran" ] && grep -qF -- "${1:-refused}" "$T/err"; }
ran() { grep -qE "$1" "$T/ran"; }
body_has() { grep -qF -- "$1" "$T/body"; }
json() { node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const m=/^```mm-[a-z]+ v1\n([\s\S]*?)\n```/m.exec(t);const d=JSON.parse(m[1]);process.exit(eval(process.argv[2])?0:1)' "$T/body" "$1"; }

ASK=(msg ASK sy-1 --to review --expect-role review --expect review --expect-on mm@abcdef1 --need review --done signed-off
  --verify-check 'bd show sy-1 --json' --verify-expect 'labels has signed-off' --by today --else escalate --else-to ops --actor platform)

echo "== bd msg: a good call posts one valid block through bd's gate"
call "${ASK[@]}" --text 'Read the three schemas first.' --mermaid 'graph LR; a-->b'
check "ASK: exit 0, bd ran" posted
check "...as bd comments add <item> -f <file> --actor platform" ran '^comments add sy-1 -f .*/body\.md --actor platform$'
check "...the body is one mm-message v1 block" grep -qx '```mm-message v1' "$T/body"
check "...its JSON: intent, to, expect, by, else, misc in order" json 'd.intent==="ASK"&&d.to==="review"&&d.expect.role==="review"&&d.expect.do==="review"&&d.expect.on==="mm@abcdef1"&&d.by==="today"&&d.else.do==="escalate"&&d.misc.length===2&&d.misc[1].type==="mermaid"'
check "...message check - reads it as a valid ASK" sh -c "'$T/bin/message' check - <'$T/body' | grep -qF 'message ok (ASK → review)'"
check "...the temp file is gone" sh -c "! ls '${TMPDIR:-/tmp}'/bd-structured-* >/dev/null 2>&1 || ! grep -l 'Read the three schemas first' '${TMPDIR:-/tmp}'/bd-structured-*/body.md"
HO=(msg HANDOFF sy-1 --to review --expect-role review --expect sign-off --expect-on mm@abcdef1 --head mm@abcdef1 --done signed-off
  --verify-check 'bash test/structured.sh' --verify-expect '0 failed' --by next-wake --else block --ready mm@abcdef1 --surface bin --actor platform/sy-1)
call "${HO[@]}"; check "HANDOFF → review with no gates file for its head: refused, the file named (sy-6avk)" refused 'no artifacts/sy-1/gates-abcdef1.txt. Run test/gates <base>..abcdef1 --item sy-1 first'
mkdir -p "$T/artifacts/sy-1"
printf 'head: abcdef1 a subject\nresult: passed: 1 passed, 0 failed, 0 skipped, of 1\n\ntest/a.sh   hermetic  passed   1 ok   1s  logs/a.log\n' >"$T/artifacts/sy-1/gates-abcdef1.txt"
call msg HANDOFF sy-1 --to review --expect-role review --expect sign-off --expect-on mm@abcdef1 --head mm@abcdef1 --done signed-off \
  --verify-check 'bash test/structured.sh' --verify-expect '0 failed' --by next-wake --else block --ready mm@abcdef1 --ready artifacts/sy-1/plan.md \
  --surface bin --surface site:board --tests-artifact artifacts/sy-1/tests.txt --tests-passed 40 --tests-failed 0 --actor platform/sy-1 \
  --part '{"type":"table","columns":["file","tests"],"rows":[["schema.mjs",12],["structured.sh",40]]}'
check "HANDOFF by a worker, with a table part: posted" posted
check "...tests is an object of numbers" json 'd.tests.passed===40&&d.tests.failed===0&&d.surfaces[1]==="site:board"'
call msg VERDICT sy-1 --to platform --expect-role platform --expect land --head mm@abcdef1 --result signed-off --done landed \
  --verify-check 'git log -1' --verify-expect 'mm@abcdef1' --by today --else proceed --actor review
check "VERDICT by review: posted" posted
call msg ANSWER sy-1 --to platform --re 3 --answer yes --expect-none --verify-check 'bd show sy-1' --verify-expect 'approved' --actor ops
check "ANSWER with --expect-none and --re: posted" posted
call msg DONE sy-1 --to ops --result done --expect-none --verify-check 'bd show sy-1' --verify-expect 'closed' --follow-up sy-2 --actor ops
check "DONE: posted" posted
call msg NOTE sy-1 --to ops --text 'I claim this item.' --actor ops
check "NOTE with one text part: posted" posted
call msg note sy-1 --to ops --markdown '**ok**' --actor ops
check "the intent in lower case is read as upper case" posted
call "${ASK[@]}" --print
check "--print: exit 0, nothing reached bd" sh -c "[ \"\$(cat '$T/code')\" = 0 ] && [ ! -s '$T/ran' ] && grep -qx '\`\`\`mm-message v1' '$T/out'"
call msg --help
check "--help: exit 0, the flags of each intent" sh -c "[ \"\$(cat '$T/code')\" = 0 ] && grep -q 'VERDICT (review only)' '$T/out'"

echo "== bd msg: each wrong call is refused with the reason; nothing reaches bd"
B=("${ASK[@]}") # the valid ASK of above: each call below changes one thing
call "${B[@]}" --to boss;                   check "--to a person: not a role" refused 'to: boss is not a role (ops, review, platform)'
call "${B[@]}" --expect reviews;            check "--expect not an action: says the flag" refused 'expect.do: "reviews" is not one of answer, apply, build'
check "...and names the flag" grep -qF '(--expect)' "$T/err"
call "${B[@]}" --by tomorrow;               check "--by tomorrow" refused 'by: "tomorrow" does not match (next-wake, today, hh:mm (UTC)'
call "${B[@]}" --by 25:00;                  check "--by 25:00" refused 'by: "25:00" does not match'
call "${B[@]}" --else later;                check "--else later" refused 'else.do: "later" is not one of proceed, block, escalate'
call "${B[@]}" --need nothing;              check "--need not a need" refused 'need: "nothing" is not one of decision, info'
call "${B[@]}" --expect-on 'not a ref';     check "--expect-on with a space" refused 'expect.on'
call "${B[@]}" --re x;                      check "--re x: a whole number" refused '--re "x": a whole number'
call "${B[@]}" --bogus 1;                   check "an unknown flag" refused '--bogus is not a flag of bd msg'
call "${B[@]}" --ready mm@abcdef1;          check "ready on an ASK: not allowed" refused 'ready: not allowed (with intent ASK)'
call "${B[@]}" --part '{"type":"text"}';    check "a text part with no text" refused 'misc[0].text: is missing (with type text)'
call "${B[@]}" --part '{"type":"html"}';    check "an html part with neither artifact nor html" refused 'misc[0]: needs one of artifact, html'
call "${B[@]}" --part '{"type":"html","artifact":"../x.html"}'; check "an artifact path with .." refused 'misc[0].artifact'
call "${B[@]}" --part '{"type":"table","columns":["a","b"],"rows":[["x"]]}'; check "a table row shorter than its columns" refused 'misc[0].rows[0]: has 1 cells (the columns: 2)'
call "${B[@]}" --part '{"type":"video"}';   check "an unknown part type" refused 'misc[0].type: "video" is not one of text, markdown'
call "${B[@]}" --part 'nope';               check "--part not JSON" refused '--part: not JSON'
call "${B[@]}" --text "$(head -c 700 /dev/zero | tr '\0' a)"; check "a text part over 600 characters" refused 'misc[0].text: is too long (700 characters; at most 600)'
call msg ASK sy-1 --to review --expect-role review --expect review --need review --actor platform
check "an Expect with a role and no Done, Verify, By, Else" refused 'done: is missing (with expect an object)'
check "...all four named" sh -c "grep -c 'is missing (with expect an object)' '$T/err' | grep -qx 4"
call msg VERDICT sy-1 --to platform --expect-role platform --expect land --head mm@abcdef1 --result signed-off --done landed \
  --verify-check 'git log -1' --verify-expect x --by today --else proceed --actor platform
check "a VERDICT by platform" refused 'only review writes a VERDICT'
call msg VERDICT sy-1 --to platform --expect-role platform --expect land --head mm@abcdef1 --result done --done landed \
  --verify-check 'git log -1' --verify-expect x --by today --else proceed --actor review
check "a VERDICT's result done" refused 'result: "done" is not one of signed-off, blocked (with intent VERDICT)'
call msg ANSWER sy-1 --to platform --answer yes --expect-none --verify-check a --verify-expect b --actor ops
check "an ANSWER with no --re" refused 're: is missing (with intent ANSWER)'
call msg DONE sy-1 --to ops --result done --expect-role ops --expect check --verify-check a --verify-expect b --actor ops
check "a DONE that expects a role" refused 'expect: is'
call msg NOTE sy-1 --to ops --actor ops;    check "a NOTE with no part" refused 'misc: is missing (with intent NOTE)'
call msg NOTE sy-1 --to ops --text hi --by today --actor ops; check "a NOTE with a By" refused 'by: not allowed (with intent NOTE)'
call msg SHOUT sy-1 --to ops --text hi --actor ops; check "an unknown intent" refused 'intent: "SHOUT" is not one of ASK, HANDOFF'
call msg ASK --to ops --actor ops;          check "no item" refused 'bd msg <INTENT> <item>: both are needed'
call msg NOTE sy-1 extra --to ops --text hi --actor ops; check "a stray word" refused 'more words than <INTENT> <item>'
call msg NOTE sy-1 --to ops --text hi
check "no actor: bd's own refusal (a write needs an actor)" sh -c "[ \"\$(cat '$T/code')\" = 1 ] && [ ! -s '$T/ran' ] && grep -qF 'needs an actor' '$T/err'"
F="$T/from.json"; printf '{"intent":"NOTE","to":"ops","misc":[{"type":"text","text":"From a file."}]}\n' >"$F"
call msg NOTE sy-1 --from "$F" --actor ops
check "--from <file.json>: posted" posted
check "...its parts kept" body_has 'From a file.'

echo "== the gate reads both forms (step 1): a block written by hand is checked by the schema; the old text still passes"
printf '```mm-message v1\n{"intent":"NOTE","to":"ops"}\n```\n' >"$T/hand.md"
call comments add sy-1 -f "$T/hand.md" --actor ops
check "a hand-written invalid block: refused by the message gate" refused 'misc: is missing (with intent NOTE)'
printf '```mm-message v1\n{"intent":"NOTE","to":"ops","misc":[{"type":"text","text":"ok"}]}\n```\nand more words\n' >"$T/hand.md"
call comments add sy-1 -f "$T/hand.md" --actor ops
check "text after the block: refused" refused 'nothing goes after the block'
printf '```mm-message v1\n{"intent":"NOTE",}\n```\n' >"$T/hand.md"
call comments add sy-1 -f "$T/hand.md" --actor ops
check "a block that is not JSON: refused" refused 'the block is not JSON'
call comments add sy-1 --actor ops -- "NOTE → ops
Claimed; plan in #2."
check "the key/value text of today: still passes" posted

echo "== bd task"
call task new --title 'Add the schemas' -p 2 -l t1 --act build --do build --on sy-1 --done closed --verify-check 'bash test/structured.sh' \
  --verify-expect '0 failed' --rollback-run 'git revert HEAD' --text 'Three schemas and a validator.' --actor platform
check "task new: posted as bd create, its flags kept, --body-file" ran '^create --title Add the schemas -p 2 -l t1 --body-file .*body\.md --actor platform$'
check "...the description is one mm-task v1 block" sh -c "head -1 '$T/body' | grep -qx '\`\`\`mm-task v1'"
check "...task check - reads it" sh -c "'$T/bin/task' check - <'$T/body' | grep -qF 'task ok (act:build)'"
call task new --title x --act deploy --do build --done closed --verify-check a --verify-expect b --actor platform
check "task new: act not in leads/raci.json" refused 'act: deploy is not an activity of leads/raci.json (build, incident, mm-template)'
call task new --act build --do build --done closed --verify-check a --verify-expect b --actor platform
check "task new with no --title" refused 'bd task new needs --title'
call task new --title x --act build --do make --verify-check a --verify-expect b --actor platform
check "task new: a wrong --do and no --done" refused 'do: "make" is not one of'
check "...done: is missing (--done ...)" grep -qF 'done: is missing (--done, --done-item, --done-check, --done-expect)' "$T/err"
show '## Owner
- **What:** Approve the new port.
- **Why:** The board needs it.
- **You:** Tap Approve

## Task
- **Task:** Open the port
- **Act:** incident
- **Done when:** the port is open
- **Verify:** curl → 200

## Notes
Keep this.'
call task set sy-1 --act incident --do apply --on migrations/port.sh --done applied --verify-check 'curl -sI x' --verify-expect 200 --actor ops
check "task set: posted as bd update <item> --body-file" ran '^update sy-1 --body-file .*body\.md --actor ops$'
check "...the card stays first" sh -c "head -1 '$T/body' | grep -qx '## Owner'"
check "...the old Task is gone" sh -c "! grep -qF '**Task:** Open the port' '$T/body'"
check "...the rest stays" body_has 'Keep this.'
check "...task check - reads the new one" sh -c "'$T/bin/task' check - <'$T/body' | grep -qF 'task ok (act:incident)'"

echo "== bd card"
show '## Task
- **Task:** Open the port
- **Act:** incident
- **Done when:** the port is open
- **Verify:** curl → 200

More.' '["t2","signed-off"]'
call card set sy-1 --what apply --what-on migrations/port.sh --why access --you approve --if-yes apply --if-yes-role ops --if-yes-on migrations/port.sh \
  --if-no nothing --risk medium --risk-of lockout --head brain@abcdef1 --text 'The port opens for the board.' --actor ops
check "card set (t2, a go ask): posted as bd update --body-file" ran '^update sy-1 --body-file .*body\.md --actor ops$'
check "...the card block is first" sh -c "head -1 '$T/body' | grep -qx '\`\`\`mm-card v1'"
check "...the Task after it stays" body_has '- **Task:** Open the port'
check "...owner-card check - --t2 reads it" sh -c "'$T/bin/owner-card' check - --t2 <'$T/body'"
call card set sy-1 --what apply --why access --you approve --actor ops
check "card set on a t2 item, a go ask with no ifYes, ifNo, risk, head" refused 'head: is missing (required with t2 on a go ask'
call card set sy-1 --what apply --why access --you reply --actor ops
check "card set: you reply with no question (text part)" refused 'you.kind reply: the question is the first text part'
call card set sy-1 --what apply --why access --you check --actor ops
check "card set: you check with no --you-at" refused 'you.at: is missing (with kind check)'
call card set sy-1 --what apply --why because --you nothing --actor ops
check "card set: --why not a reason" refused 'why: "because" is not one of security'

echo "== the leads' brief's examples (\"Structured messages (step 1)\") pass, in both copies"
show ''
for brief in template/profiles/system/leads/CLAUDE.md template/leads/CLAUDE.md; do
  # the fenced example of the section, its continuation lines joined; each line one call, with --print
  sed -n '/^## Structured messages (step 1)/,/^## /p' "$SRC/$brief" | sed -n '/^```$/,/^```$/p' | grep -v '^```' | sed -e ':a' -e '/\\$/N; s/\\\n *//; ta' >"$T/examples"
  check "$brief: three examples" test "$(wc -l <"$T/examples")" = 3
  while IFS= read -r line; do
    eval "set -- ${line#bd }"
    call "$@" --print --actor platform
    check "$brief: bd $1 ${2:-} passes (--print)" sh -c "[ \"\$(cat '$T/code')\" = 0 ]"
  done <"$T/examples"
done

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
