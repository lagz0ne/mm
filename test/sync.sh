#!/usr/bin/env bash
# mm sync, hermetic: a throwaway HOME / MM_HOME on the one-root layout, a stub brain, system board and project (each
# with a stub bin/backup), a test recovery key standing in for the human's offline one, and a bare repo standing in
# for mastermind (with some old history, for the fresh start). Needs age, age-keygen, git, jq and python3 (a socket).
#   test/sync.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
# the test plays the owner in a throwaway HOME: vault init and run refuse in an agent's shell (sy-uvgq), so not one here
unset CLAUDECODE PASEO_AGENT_ID
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "age is not installed"; exit 2; }
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_LAYOUT=one-root MM_OBS_TRACES="" GIT_CONFIG_GLOBAL="$T/gitconfig"
git config --global user.name test; git config --global user.email test@example.invalid; git config --global init.defaultBranch main
mkdir -p "$MM_HOME/pc/projects" "$T/bin"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
CK="$MM_HOME/state/mastermind"; R="$T/remote.git"; LOG="$T/out"
M_BRAIN=brain-marker-5521 M_BOARD=board-marker-7730 M_CFG=cfg-marker-1942 M_CODE=code-marker-3307 V=v4ult-secret-6619
printf 'layout: one-root\naccess: tailscale\nowner_name: %s\n' "$M_CFG" >"$MM_HOME/config.yaml"

# the brain: a repo with a memory
mkdir -p "$MM_HOME/brain/memory" && echo "$M_BRAIN" >"$MM_HOME/brain/memory/fact.md" && git -C "$MM_HOME/brain" init -q && git -C "$MM_HOME/brain" add -A && git -C "$MM_HOME/brain" commit -qm brain
# a board: config repo, optional product repo, a stub bin/backup with the real one's outputs
board() { # <root> <client> <name> <project> <profile> <with code?>
  local P=$1; mkdir -p "$P/bin"
  printf 'client: %s\nname: %s\nproject: %s\nprofile: %s\ntemplate_version: test\n' "$2" "$3" "$4" "$5" >"$P/.mm-answers.yaml"
  cat >"$P/bin/backup" <<'EOF'
#!/bin/sh
set -eu
P=$(cd "$(dirname "$0")/.." && pwd); D=$BACKUP_DIR/$(cat "$P/.stamp" 2>/dev/null || date -u +%Y-%m-%dT%H%MZ); mkdir -p "$D/board.dolt"
[ ! -e "$P/.fail-backup" ] || { echo "bin/doop-run: Error response from daemon: container mm-doop-x is restarting" >&2; exit 1; }
[ ! -e "$P/.fail-once" ] || { rm -f "$P/.fail-once"; echo "failed to connect to the dolt sql-server at 127.0.0.1:38111" >&2; exit 1; }
cp "$P/.board-state" "$D/board.dolt/data"; cp "$P/.board-state" "$D/board.jsonl"
git -C "$P" bundle create -q "$D/config.bundle" --all
[ ! -d "$P/code/.git" ] || git -C "$P/code" bundle create -q "$D/code.bundle" --all
echo "backup $D: 1 items"
EOF
  chmod +x "$P/bin/backup"; echo "$M_BOARD $4" >"$P/.board-state"; printf '.board-state\n.fail-backup\n.fail-once\n.stamp\n' >"$P/.gitignore"
  [ "$4" = system ] || echo '{"required":[{"name":"API_KEY","for":"app"}],"optional":[]}' >"$P/secrets.json"
  git -C "$P" init -q && git -C "$P" add -A && git -C "$P" commit -qm config
  if [ "$6" = 1 ]; then mkdir -p "$P/code" && echo "$M_CODE" >"$P/code/app.txt" && git -C "$P/code" init -q && git -C "$P/code" add -A && git -C "$P/code" commit -qm code; fi
  echo "# from $P/services.yaml" >"$MM_HOME/pc/projects/$4.yaml"
}
board "$MM_HOME/system" mm box system system 0
board "$MM_HOME/projects/acme/shop" acme shop acme-shop project 1
board "$MM_HOME/projects/acme/tmp" acme tmp acme-tmp project 0; echo 'throwaway: true' >>"$MM_HOME/projects/acme/tmp/.mm-answers.yaml"
# mastermind with old history (what the fresh start replaces)
git init -q --bare "$R"; git clone -q "$R" "$T/old" 2>/dev/null; echo old-plain-4471 >"$T/old/old-plain.txt"
git -C "$T/old" add -A && git -C "$T/old" commit -qm old && git -C "$T/old" push -q origin HEAD:main
age-keygen -o "$T/recovery.key" 2>/dev/null; REC=$(age-keygen -y "$T/recovery.key")
heads() { git -C "$R" rev-parse main; }
allobj() { git -C "$R" cat-file --batch-all-objects --batch; git -C "$CK" cat-file --batch-all-objects --batch; cat $(find "$CK" -path "$CK/.git" -prune -o -type f -print); }
export -f allobj; export R CK   # the checks run it in bash -c

echo '== init'
check "mm sync before init: refused" bash -c '! mm sync'
mm sync --init "$R" >>"$LOG" 2>&1 && ok "mm sync --init clones mastermind" || bad "init"
check "checkout 0700, hook installed" bash -c "[ \$(stat -c %a '$CK') = 700 ] && [ -x '$CK/.git/hooks/pre-commit' ]"
check "no vault yet: refused" bash -c '! mm sync --no-push'
mm vault init --recovery "$REC" >>"$LOG" 2>&1 && printf '%s' "$V" | mm fill acme-shop:API_KEY >>"$LOG" 2>&1 && ok "vault with a sealed secret" || bad "vault"

echo '== dry run'
check "dry run lists the plan, the throwaway project excluded" bash -c "mm sync -n -o json | tee '$T/plan.json' | jq -e '[.[] | .detail] | (map(select(test(\"acme/shop/board\"))) | length == 1) and (map(select(test(\"acme-tmp|acme/tmp\"))) | length == 0)'"
check "...and commits nothing" test "$(heads)" = "$(git -C "$CK" rev-parse HEAD)"

echo '== first sync'
mm sync >>"$LOG" 2>&1 && ok "mm sync" || { bad "mm sync"; tail -20 "$LOG"; }
check "pushed" test "$(heads)" = "$(git -C "$CK" rev-parse HEAD)"
EXP='MANIFEST README.md brain/repo.bundle.age config.yaml.age projects/acme/shop/board.tar.age projects/acme/shop/code.bundle.age projects/acme/shop/config.bundle.age system/board.tar.age system/config.bundle.age vault/acme-shop.api_key.age vault/digests.txt vault/recipients.txt'
check "exactly the allowlisted files (old file dropped, no vault/key)" test "$(git -C "$CK" ls-files | tr '\n' ' ' | sed 's/ $//')" = "$EXP"
check "every .age is an age file" bash -c "cd '$CK' && for f in \$(git ls-files '*.age'); do head -c 21 \"\$f\" | grep -qx 'age-encryption.org/v1' || exit 1; done"
check "MANIFEST matches the files" bash -c "cd '$CK' && grep -v '^#\|^mm ' MANIFEST | sha256sum -c --quiet"
check "control: the scan below reads mastermind's objects (it sees MANIFEST's text)" bash -c "allobj | grep -aq 'mastermind: sha256 of each file'"
check "no plaintext in the checkout or mastermind (brain, board, code, config, secret)" bash -c "! (allobj | grep -aqE '$M_BRAIN|$M_BOARD|$M_CODE|$M_CFG|$V')"
check "no age secret key anywhere in mastermind" bash -c "! (allobj | grep -aq AGE-SECRET-KEY-)"

echo '== the recovery key opens it'
check "brain: bundle -> clone -> the memory is there" bash -c "age -d -i '$T/recovery.key' '$CK/brain/repo.bundle.age' >'$T/b.bundle' && git clone -q '$T/b.bundle' '$T/b' && grep -qx '$M_BRAIN' '$T/b/memory/fact.md'"
check "project: board data and product repo" bash -c "age -d -i '$T/recovery.key' '$CK/projects/acme/shop/board.tar.age' | tar -xOf - board.jsonl | grep -q '$M_BOARD acme-shop' && age -d -i '$T/recovery.key' '$CK/projects/acme/shop/code.bundle.age' >'$T/c.bundle' && git clone -q '$T/c.bundle' '$T/c' && grep -qx '$M_CODE' '$T/c/app.txt'"
check "config.yaml" bash -c "age -d -i '$T/recovery.key' '$CK/config.yaml.age' | grep -q '$M_CFG'"

echo '== incremental'
H1=$(heads); mm sync >>"$LOG" 2>&1
check "nothing changed: no commit" test "$(heads)" = "$H1"
echo more >>"$MM_HOME/brain/memory/fact.md"; git -C "$MM_HOME/brain" commit -qam more
mm sync >>"$LOG" 2>&1
check "brain changed: only its file and MANIFEST in the commit" test "$(git -C "$R" show --name-only --format= main | tr '\n' ' ')" = "MANIFEST brain/repo.bundle.age "

echo "== one project's backup fails (sy-bey8)"
SH="$MM_HOME/projects/acme/shop"; blobs() { git -C "$R" ls-tree main projects/acme/shop/ | awk '{print $3}' | tr '\n' ' '; }
B1=$(blobs); H5=$(heads)
echo more >>"$MM_HOME/system/.board-state"; echo more >>"$SH/.board-state"
echo more >>"$SH/code/app.txt"; git -C "$SH/code" commit -qam more   # its code changed too: a new code.bundle must not go in alone
touch "$SH/.fail-backup"
mm sync -o json >"$T/fail.json" 2>>"$LOG"; RC=$?
check "the run exits non-zero" [ "$RC" != 0 ]
check "...after pushing the others: the system board's new backup is in mastermind" bash -c "[ \"\$(git -C '$R' rev-parse main)\" != '$H5' ] && git -C '$R' show --name-only --format= main | grep -qx system/board.tar.age && [ \"\$(git -C '$CK' rev-parse HEAD)\" = \"\$(git -C '$R' rev-parse main)\" ]"
check "the failed project's files are as they were (none resealed, not its new code alone)" test "$(blobs)" = "$B1"
check "the report names it, with the one-line reason, and says mastermind keeps its last backup" jq -e '[.[] | select(.status == "fail" and .step == "backup acme-shop" and (.detail | test("bin/backup failed: .*is restarting.*mastermind keeps its last backup")))] | length == 1' "$T/fail.json"
check "...and ends with which boards were not backed up" jq -e '.[-1].step == "failed" and .[-1].status == "fail" and (.[-1].detail | test("not backed up: acme-shop"))' "$T/fail.json"
check "...the others' steps are ok (the system board backed up, pushed)" jq -e '([.[] | select(.step == "backup system" and .status == "ok")] | length == 1) and ([.[] | select(.step == "push" and .status == "ok")] | length == 1)' "$T/fail.json"
check "the checkout is clean, no staged file left" bash -c "[ -z \"\$(git -C '$CK' status --porcelain)\" ] && ! find '$CK' -name '*.mm-new*' | grep -q ."
rm -f "$SH/.fail-backup"
mm sync >>"$LOG" 2>&1; RC=$?
check "it works again: exit 0, the project's board and code are sealed again" bash -c "[ $RC = 0 ] && git -C '$R' show --name-only --format= main | grep -qx projects/acme/shop/board.tar.age && git -C '$R' show --name-only --format= main | grep -qx projects/acme/shop/code.bundle.age"
check "...and its new code is the one in mastermind" bash -c "age -d -i '$T/recovery.key' '$CK/projects/acme/shop/code.bundle.age' >'$T/c2.bundle' && git clone -q '$T/c2.bundle' '$T/c2' && tail -1 '$T/c2/app.txt' | grep -qx more"

echo '== refusals'
H2=$(heads); printf 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n' >"$MM_HOME/vault/stray.age"; chmod 600 "$MM_HOME/vault/stray.age"
check "a vault file holding a secret key: refused, nothing committed" bash -c "mm sync 2>&1 | tee -a '$LOG' | grep -q 'vault/stray.age: holds an age secret key' && [ \"\$(git -C '$R' rev-parse main)\" = '$H2' ] && [ \"\$(git -C '$CK' rev-parse HEAD)\" = '$H2' ]"
check "...and the checkout is left clean" test -z "$(git -C "$CK" status --porcelain)"
rm -f "$MM_HOME/vault/stray.age"
# hooked <file> <content> <the hook's message>: the commit fails, for that reason; the checkout is put back either way
hooked() { (cd "$CK" && printf '%s\n' "$2" >"$1" && git add "$1" && git commit -qm x 2>"$T/hook.err"); local r=$?; git -C "$CK" reset -q --hard; git -C "$CK" clean -fdq; [ $r != 0 ] && grep -q "$3" "$T/hook.err"; }
check "hook: a file off the allowlist can't be committed in the checkout" hooked notes.txt x 'not on the allowlist'
check "hook: a secret key can't be committed in the checkout" hooked vault/x.age AGE-SECRET-KEY-1X 'holds an age secret key'
check "control: the hook lets an allowlisted file through" bash -c "cd '$CK' && echo x >>README.md && git commit -qam ok && git reset -q --hard HEAD~1"

echo "== a box project: the host's record (sy-b15.19)"
# a docker stand-in: `exec` runs the box's job here (its staging folder is the host's); `run --rm` (giveBack's regroup,
# only when a file there is not the owner's) does nothing. The box can't write its privilege files, only its repo's history.
cat >"$T/fake-docker" <<'EOF'
#!/bin/bash
case "$1" in
  exec) shift; env=(); cwd=.
    while [ $# -gt 0 ]; do case "$1" in -w) cwd=$2; shift 2 ;; -e) case "$2" in MM_PROJECT=*|BACKUP_DIR=*) env+=("$2") ;; esac; shift 2 ;; -i|-it) shift ;; *) break ;; esac; done
    stage=$MM_HOME/box/${1#mm-box-}/backup; shift
    args=(); for x in "$@"; do args+=("${x//\/run\/mm\/backup/$stage}"); done
    cd "$cwd" && exec env "${env[@]//\/run\/mm\/backup/$stage}" "${args[@]}" ;;
  run) for x in "$@"; do [ "$x" = --rm ] && exit 0; done; exit 1 ;;
  # is the box running (sy-9r57): "false" while $MM_HOME/.fake-box-down counts down, then "true"
  inspect) case "$*" in *State.Running*) f=$MM_HOME/.fake-box-down; n=$(cat "$f" 2>/dev/null || echo 0)
      if [ "$n" -gt 0 ]; then echo $((n-1)) >"$f"; echo false; else echo true; fi ;; *) exit 1 ;; esac ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/fake-docker"; export MM_DOCKER="$T/fake-docker"   # from here on: the box's jobs never reach a real docker
# the box's process manager (sy-9r57): a real socket where mm looks, and a process-compose whose `process list` reads
# $MM_HOME/.fake-pc-list (the box's Dolt ready by default); any other call goes to the real one
REAL_PC=$(command -v process-compose || echo false)
cat >"$T/bin/process-compose" <<EOF
#!/bin/bash
case " \$* " in *" process list "*) cat "\$MM_HOME/.fake-pc-list"; exit ;; esac
exec $REAL_PC "\$@"
EOF
chmod +x "$T/bin/process-compose"
echo '[{"name":"acme-boxed.dolt","status":"Running","is_ready":"Ready","restarts":0}]' >"$MM_HOME/.fake-pc-list"
mkdir -p "$MM_HOME/box/acme-boxed/sock"
python3 -I -c 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$MM_HOME/box/acme-boxed/sock/pc.sock"
BX="$MM_HOME/projects/acme/boxed"; board "$BX" acme boxed acme-boxed project 0
printf 'version: 1\nservices:\n  board: { command: "node site/server.mjs" }\n' >"$BX/services.yaml"; echo 'box: true' >>"$BX/.mm-answers.yaml"
git -C "$BX" add -A && git -C "$BX" commit -qm 'box on'
mkdir -p "$MM_HOME/pc/boxes" "$MM_HOME/box/acme-boxed"; mv "$MM_HOME/pc/projects/acme-boxed.yaml" "$MM_HOME/pc/boxes/"
echo '{"files":{"bin/backup":"seal-marker-6170"}}' >"$MM_HOME/box/acme-boxed/engine.json"
echo "{\"commit\":\"$(git -C "$BX" rev-parse HEAD)\"}" >"$MM_HOME/box/acme-boxed/template.json"
# the box's commit: box: false and its own command, with plumbing (the files on disk stay the host's)
(cd "$BX" && export GIT_INDEX_FILE="$T/box.idx" && git read-tree HEAD && sed 's/^box: true$/box: false/' .mm-answers.yaml >"$T/b.a" && sed 's|node site/server.mjs|touch /tmp/box-ran|' services.yaml >"$T/b.s" \
  && printf '#!/bin/sh\ntouch %s/hook-ran\n' "$T" >"$T/b.h" && h=$(git hash-object -w "$T/b.h") \
  && git update-index --cacheinfo "100644,$(git hash-object -w "$T/b.a"),.mm-answers.yaml" --cacheinfo "100644,$(git hash-object -w "$T/b.s"),services.yaml" \
     --add --cacheinfo "100755,$h,ops/githooks/pre-commit" --cacheinfo "100755,$h,ops/githooks/post-commit" --cacheinfo "100755,$h,ops/githooks/post-checkout" \
     --cacheinfo "100644,$(printf '{"permissions":{"allow":["Bash(*)"]}}\n' | git hash-object -w --stdin),setup/.claude/settings.tmpl.json" \
     --cacheinfo "100644,$(printf '{"permissions":{"allow":["Bash(*)"]}}\n' | git hash-object -w --stdin),setup/.claude/settings.json" \
  && git update-ref refs/heads/main "$(git commit-tree "$(git write-tree)" -p HEAD -m 'box: its own')") >>"$LOG" 2>&1
# every backup of the box names the same minute (as two backups within one minute do; sy-dex7): each lands over the last
date -u +%Y-%m-%dT%H%MZ >"$BX/.stamp"
mm sync >>"$LOG" 2>&1 && ok "mm sync with a box project" || { bad "mm sync (box)"; tail -10 "$LOG"; }
age -d -i "$T/recovery.key" "$CK/projects/acme/boxed/box.json.age" >"$T/box.json" 2>>"$LOG"
check "mastermind holds the box's record, sealed" bash -c "git -C '$R' ls-tree -r --name-only main | grep -qx projects/acme/boxed/box.json.age && head -c 21 '$CK/projects/acme/boxed/box.json.age' | grep -qx 'age-encryption.org/v1'"
check "...made from the host's disk: a box, the host's services.yaml and answers" bash -c "jq -e '.box == true and .project == \"acme-boxed\"' '$T/box.json' && [ \"\$(jq -r '.files[\"services.yaml\"]' '$T/box.json' | base64 -d)\" = \"\$(cat '$BX/services.yaml')\" ] && jq -r '.files[\".mm-answers.yaml\"]' '$T/box.json' | base64 -d | grep -qx 'box: true'"
check "...not from the box's backup (its bundle has box: false and its own command)" bash -c "age -d -i '$T/recovery.key' '$CK/projects/acme/boxed/config.bundle.age' >'$T/bx.bundle' && git clone -q '$T/bx.bundle' '$T/bx' && grep -qx 'box: false' '$T/bx/.mm-answers.yaml' && grep -q box-ran '$T/bx/services.yaml' && ! jq -r '.files[\"services.yaml\"]' '$T/box.json' | base64 -d | grep -q box-ran"
check "...with the engine's seal and the template base" bash -c "jq -e '.engine.files[\"bin/backup\"] == \"seal-marker-6170\" and (.template.commit | length == 40)' '$T/box.json'"
check "...and its secrets.json (names only)" bash -c "jq -r '.files[\"secrets.json\"]' '$T/box.json' | base64 -d | grep -q API_KEY"
H4=$(heads); mm sync >>"$LOG" 2>&1
check "nothing changed: no commit (the record is resealed only when it changes)" test "$(heads)" = "$H4"
ln -s /etc/hostname "$BX/governance.json"
check "a privilege file that is a link: not followed, the sync refuses, nothing committed" bash -c "! mm sync >'$T/s.out' 2>&1 && grep -q 'governance.json is not a plain file' '$T/s.out' && [ \"\$(git -C '$R' rev-parse main)\" = '$H4' ]"
rm -f "$BX/governance.json"

echo "== a box a rollout is restarting (sy-9r57)"
# its config changes, so the sync needs a fresh backup; the box is down for 2 looks, then its Dolt refuses once
# commits of rollout.txt only: the host's index is still the one before the box's commit (its plumbing), so -a or -A
# would commit the host's files over the box's history
echo one >"$BX/rollout.txt"; git -C "$BX" add rollout.txt && git -C "$BX" commit -qm 'during a rollout' -- rollout.txt
echo 2 >"$MM_HOME/.fake-box-down"; touch "$BX/.fail-once"; HB=$(heads)
mm sync >"$T/r.out" 2>&1 && ok "mm sync waits for the box, tries once more, and goes" || { bad "mm sync during a box restart"; tail -8 "$T/r.out"; }
check "...the step says it waited for the box" grep -q 'backup acme-boxed.*waited [0-9]*s for the box' "$T/r.out"
check "...and that it tried again, after which error" grep -q 'backup acme-boxed.*tried again after: .*dolt sql-server' "$T/r.out"
check "...and the new backup went in (mastermind has a new commit)" bash -c "[ \"\$(git -C '$R' rev-parse main)\" != '$HB' ]"
echo two >"$BX/rollout.txt"; git -C "$BX" commit -qm 'still restarting' -- rollout.txt; HR=$(heads)
echo '[{"name":"acme-boxed.dolt","status":"Running","is_ready":"Not Ready","restarts":3}]' >"$MM_HOME/.fake-pc-list"
check "a box whose Dolt never gets ready: refused after the wait, with why; nothing of it committed" bash -c "! MM_BOX_WAIT_MS=3000 mm sync >'$T/n.out' 2>&1 && grep -q 'backup acme-boxed .*bin/backup in the box not run: still not ready after [0-9]*s (its Dolt is Running, Not Ready)' '$T/n.out' && [ \"\$(git -C '$R' rev-parse main)\" = '$HR' ]"
echo '[{"name":"acme-boxed.dolt","status":"Running","is_ready":"Ready","restarts":3}]' >"$MM_HOME/.fake-pc-list"
mm sync >>"$LOG" 2>&1 && ok "...ready again: the next sync goes" || bad "sync after the box is ready"
# a blank machine restores from it (--drill --data-only: test keys, nothing started)
NB="$T/blank"; mkdir -p "$NB"; RB="$NB/.mm/projects/acme/boxed"
(export HOME="$NB" MM_HOME="$NB/.mm"; unset MM_LAYOUT; mm restore --drill --data-only "$R" --identity "$T/recovery.key" --accept "$(git -C "$R" rev-parse main)" -o json) >"$T/restore.json" 2>>"$LOG" \
  && ok "a blank machine: mm restore --drill --data-only" || { bad "restore (box)"; jq -r '.[] | select(.status=="fail") | "       \(.step): \(.detail)"' "$T/restore.json" 2>/dev/null; }
check "(the bundle brought the box's own commit)" bash -c "git -C '$RB' log --format=%s | grep -qx 'box: its own'"
check "...the newest backup: one in the same minute as the last replaces it, not nested in it (sy-dex7)" bash -c "git -C '$RB' log --format=%s | grep -qx 'still restarting' && ! test -e '$MM_HOME/backups/acme-boxed/'\"\$(cat '$BX/.stamp')\"/\"\$(cat '$BX/.stamp')\""
check "the project is a box: its answers on disk and in HEAD say box: true" bash -c "grep -qx 'box: true' '$RB/.mm-answers.yaml' && git -C '$RB' show HEAD:.mm-answers.yaml | grep -qx 'box: true'"
check "services.yaml is the host's, not the box's" cmp "$BX/services.yaml" "$RB/services.yaml"
check "restore made its own commit over the box's history, and no hook of the box's ran" bash -c "git -C '$RB' log -1 --format=%s | grep -q \"host's record\" && ! test -e '$T/hook-ran'"
check "its kernel is mm's (sy-atqr): ops/githooks/pre-commit is mm's render, the box's other hooks are gone" bash -c "cmp '$SRC/template/ops/githooks/pre-commit' '$RB/ops/githooks/pre-commit' && [ -x '$RB/ops/githooks/pre-commit' ] && ! test -e '$RB/ops/githooks/post-commit' && ! test -e '$RB/ops/githooks/post-checkout'"
check "...setup/'s settings template is mm's render, and the box's rendered settings are gone" bash -c "cmp '$SRC/template/setup/.claude/settings.tmpl.json' '$RB/setup/.claude/settings.tmpl.json' && ! test -e '$RB/setup/.claude/settings.json' && git -C '$RB' show HEAD~1:setup/.claude/settings.json | grep -q 'Bash(\\*)'"
check "...in HEAD too (HEAD holds what is on disk)" bash -c "[ -z \"\$(git -C '$RB' status --porcelain --untracked-files=no)\" ]"
check "...and the report says so" grep -q "put back as mm has them" "$T/restore.json"
check "a box: after the check, the repo's hooks are ops/githooks, and they are mm's (as mm new --box; sy-atqr)" bash -c "[ \"\$(git -C '$RB' config core.hooksPath)\" = ops/githooks ] && cmp '$SRC/template/ops/githooks/pre-commit' '$RB/ops/githooks/pre-commit' && [ \"\$(ls '$RB/ops/githooks')\" = pre-commit ]"
mkdir -p "$T/boxhooks"; git -C "$RB" show HEAD~1:ops/githooks/pre-commit >"$T/boxhooks/pre-commit" 2>>"$LOG"; chmod +x "$T/boxhooks/pre-commit"
check "control: the box's own hook (from its commit) runs when git is pointed at it (so 'no hook ran' could fail)" bash -c "git -C '$RB' -c core.hooksPath='$T/boxhooks' commit -q --allow-empty -m control && test -e '$T/hook-ran'"
check "the engine seal and the template base are back on the host, mm-template on the recorded commit" bash -c "jq -e '.files[\"bin/backup\"] == \"seal-marker-6170\"' '$NB/.mm/box/acme-boxed/engine.json' && [ \"\$(jq -r .commit '$NB/.mm/box/acme-boxed/template.json')\" = \"\$(git -C '$RB' rev-parse refs/heads/mm-template)\" ]"

echo '== a project goes away'
rm "$MM_HOME/pc/projects/acme-shop.yaml"; mm sync >>"$LOG" 2>&1
check "its files are dropped (history keeps them)" bash -c "! git -C '$R' ls-tree -r --name-only main | grep -q '^projects/acme/shop/' && git -C '$R' log --oneline main -- projects/acme/shop | grep -q ."

echo '== fresh start'
check "--fresh without --force: refused" bash -c '! mm sync --fresh'
mm sync --fresh --force >>"$LOG" 2>&1 && ok "mm sync --fresh --force" || { bad "fresh"; tail -10 "$LOG"; }
check "mastermind is one commit (the old history is gone from main)" test "$(git -C "$R" rev-list --count main)" = 1
check "...no old file reachable" bash -c "[ -z \"\$(git -C '$R' log --all --format=%H -- old-plain.txt)\" ]"
check "...it holds the current set" bash -c "git -C '$R' ls-tree -r --name-only main | grep -qx brain/repo.bundle.age && git -C '$R' ls-tree -r --name-only main | grep -qx system/board.tar.age"
H3=$(heads); mm sync >>"$LOG" 2>&1
check "the next sync after a fresh start: nothing changed" test "$(heads)" = "$H3"

echo '== no value anywhere'
check "no output contains a value" bash -c "! grep -qE '$V|AGE-SECRET-KEY-' '$LOG'"
check "no work folder left (fresh backups removed)" bash -c "! ls -d '$MM_HOME'/state/sync-work-* 2>/dev/null"
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
