#!/usr/bin/env bash
# mm restore <mastermind>, hermetic: box A (stub brain, system board, project; a vault with a test recovery key) syncs
# to a bare repo standing in for mastermind, with a tag signed by a test "human" ssh key. Then blank boxes restore from
# it: trust (signed tag, typed hash, bad signature), MANIFEST, the wrong identity, and what lands where. Nothing starts.
# Needs age, age-keygen, git, ssh-keygen and jq.
#   test/restore.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
for c in age age-keygen ssh-keygen jq; do command -v $c >/dev/null || { echo "$c is not installed"; exit 2; }; done
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); SHM=$(mktemp -d /dev/shm/mmr.XXXX); trap 'rm -rf "$T" "$SHM"' EXIT
export MM_OBS_TRACES="" GIT_CONFIG_GLOBAL="$T/gitconfig" XDG_RUNTIME_DIR="$SHM"
git config --global user.name test; git config --global user.email test@example.invalid; git config --global init.defaultBranch main
mkdir -p "$T/bin"; printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
R="$T/remote.git"; LOG="$T/out"; M_BRAIN=brain-marker-5521 M_BOARD=board-marker-7730 M_CFG=cfg-marker-1942 M_CODE=code-marker-3307 V=v4ult-secret-6619
box() { export HOME="$T/$1" MM_HOME="$T/$1/.mm"; unset MM_LAYOUT; mkdir -p "$HOME"; }   # switch to a box (a HOME)

echo '== box A: a machine, synced'
box a; export MM_LAYOUT=one-root; mkdir -p "$MM_HOME/pc/projects"
printf 'layout: one-root\naccess: tailscale\nowner_name: %s\n' "$M_CFG" >"$MM_HOME/config.yaml"
mkdir -p "$MM_HOME/brain/memory" && echo "$M_BRAIN" >"$MM_HOME/brain/memory/fact.md" && git -C "$MM_HOME/brain" init -q && git -C "$MM_HOME/brain" add -A && git -C "$MM_HOME/brain" commit -qm brain
board() { # <root> <client> <name> <project> <profile> <with code?>
  local P=$1; mkdir -p "$P/bin"
  printf 'client: %s\nname: %s\nproject: %s\nroot: %s\nprofile: %s\ntemplate_version: test\n' "$2" "$3" "$4" "/old/box/$4" "$5" >"$P/.mm-answers.yaml"
  cat >"$P/bin/backup" <<'EOF'
#!/bin/sh
set -eu
P=$(cd "$(dirname "$0")/.." && pwd); D=$BACKUP_DIR/$(date -u +%Y-%m-%dT%H%MZ); mkdir -p "$D/board.dolt"
cp "$P/.board-state" "$D/board.dolt/data"; cp "$P/.board-state" "$D/board.jsonl"
git -C "$P" bundle create -q "$D/config.bundle" --all
[ ! -d "$P/code/.git" ] || git -C "$P/code" bundle create -q "$D/code.bundle" --all
echo "backup $D: 1 items"
EOF
  chmod +x "$P/bin/backup"; printf '%s 1\n%s 2\n' "$M_BOARD" "$M_BOARD" >"$P/.board-state"; printf '.board-state\n' >"$P/.gitignore"
  [ "$4" = system ] || echo '{"required":[{"name":"API_KEY","for":"app"}],"optional":[]}' >"$P/secrets.json"
  git -C "$P" init -q && git -C "$P" add -A && git -C "$P" commit -qm config && git -C "$P" branch mm-template
  if [ "$6" = 1 ]; then mkdir -p "$P/code" && echo "$M_CODE" >"$P/code/app.txt" && git -C "$P/code" init -q && git -C "$P/code" add -A && git -C "$P/code" commit -qm code; fi
  echo "# from $P/services.yaml" >"$MM_HOME/pc/projects/$4.yaml"
}
board "$MM_HOME/system" mm box system system 0
board "$MM_HOME/projects/acme/shop" acme shop acme-shop project 1
git init -q --bare --initial-branch=master "$R"   # its HEAD names a branch mm sync never pushes (seen on a real box)
age-keygen -o "$T/recovery.key" 2>/dev/null; REC=$(age-keygen -y "$T/recovery.key"); age-keygen -o "$T/other.key" 2>/dev/null
ssh-keygen -q -t ed25519 -N '' -C human -f "$T/human"; ssh-keygen -q -t ed25519 -N '' -C mallory -f "$T/mallory"
echo "human namespaces=\"git\" $(cat "$T/human.pub")" >"$T/allowed_signers"
{ mm sync --init "$R" && mm vault init --recovery "$REC" && printf '%s' "$V" | mm fill acme-shop:API_KEY && mm sync; } >>"$LOG" 2>&1 && ok "box A synced" || { bad "box A"; tail -20 "$LOG"; }
CK="$MM_HOME/state/mastermind"; MACHINE_A=$(sed -n 2p "$MM_HOME/vault/recipients.txt")
git -C "$CK" -c gpg.format=ssh -c user.signingkey="$T/human" tag -s drill-1 -m "drilled" HEAD && C1=$(git -C "$CK" rev-parse HEAD)
echo "more" >>"$MM_HOME/brain/memory/fact.md" && git -C "$MM_HOME/brain" commit -qam more && mm sync >>"$LOG" 2>&1; C2=$(git -C "$CK" rev-parse HEAD)
git -C "$CK" -c gpg.format=ssh -c user.signingkey="$T/mallory" tag -s drill-2 -m "not the human" HEAD
git -C "$CK" push -q origin --tags 2>>"$LOG"
check "mastermind: a tag signed by the human on c1, one signed by someone else on c2" bash -c "[ '$C1' != '$C2' ] && git -C '$R' tag | grep -qx drill-1 && git -C '$R' tag | grep -qx drill-2"
unset MM_LAYOUT

echo '== trust'
box b
check "no identity: refused" bash -c "! mm restore '$R'"
check "no signed tag known, no typed hash: refused, nothing written" bash -c "! mm restore '$R' --identity '$T/recovery.key' >>'$LOG' 2>&1 && ! test -e '$MM_HOME/config.yaml'"
check "...the refusal shows HEAD's hash to type" bash -c "mm restore '$R' --identity '$T/recovery.key' 2>&1 | grep -q '$C2'"
check "a wrong typed hash: refused" bash -c "! mm restore '$R' --identity '$T/recovery.key' --accept 0123456789ab && ! test -e '$MM_HOME/config.yaml'"
check "a short typed hash (under 12): refused" bash -c "! mm restore '$R' --identity '$T/recovery.key' --accept '${C2:0:8}'"
check "the wrong identity: refused, nothing written" bash -c "mm restore '$R' --identity '$T/other.key' --accept '$C2' 2>&1 | tee -a '$LOG' | grep -q 'not the recovery key' && ! test -e '$MM_HOME/vault/key' && ! test -e '$MM_HOME/config.yaml'"
box b2
mm restore --data-only "$R" --identity "$T/recovery.key" --allowed-signers "$T/allowed_signers" -o json >"$T/b2.json" 2>>"$LOG" && ok "with the human's allowed signers: restored" || { bad "restore (signed)"; tail -5 "$LOG"; cat "$T/b2.json" | tail -5; }
check "...the human's signed tag, not the newer one signed by someone else" bash -c "jq -e '[.[] | .detail] | (map(select(test(\"drill-2: no valid signature\"))) | length == 1) and (map(select(test(\"signed tag drill-1\"))) | length == 1)' '$T/b2.json'"
check "...c1's content (the unsigned c2 listed, not applied)" bash -c "! grep -q more '$MM_HOME/brain/memory/fact.md' && jq -e '[.[] | .detail] | map(select(test(\"unsigned commit.*not applied\"))) | length == 1' '$T/b2.json'"
box c
mm restore --data-only "$R" --identity "$T/recovery.key" --accept "$C2" -o json >"$T/c.json" 2>>"$LOG" && ok "with the typed HEAD hash: restored" || { bad "restore (typed)"; tail -5 "$LOG"; tail -5 "$T/c.json"; }
check "...HEAD's content" grep -q more "$MM_HOME/brain/memory/fact.md"

echo '== what landed (box c)'
check "config.yaml, one-root" bash -c "grep -q '$M_CFG' '$MM_HOME/config.yaml' && grep -qx 'layout: one-root' '$MM_HOME/config.yaml'"
check "vault: a new machine key, the same recovery key" bash -c "[ \$(stat -c %a '$MM_HOME/vault/key') = 600 ] && [ \"\$(sed -n 2p '$MM_HOME/vault/recipients.txt')\" != '$MACHINE_A' ] && grep -qx '$REC' '$MM_HOME/vault/recipients.txt'"
OUT=$(mm vault run acme-shop API_KEY -- sh -c 'cat "$API_KEY_FILE"' 2>>"$LOG")
check "the secret opens with the new machine key" test "$OUT" = "$V"
check "...and still with the recovery key" bash -c "[ \"\$(age -d -i '$T/recovery.key' '$MM_HOME/vault/acme-shop.api_key.age')\" = '$V' ] && mm vault check"
check "brain: a repo with no remote left" bash -c "git -C '$MM_HOME/brain' log --oneline | grep -q more && [ -z \"\$(git -C '$MM_HOME/brain' remote)\" ]"
check "system board: config repo, every branch" bash -c "git -C '$MM_HOME/system' rev-parse -q --verify mm-template && [ \"\$(git -C '$MM_HOME/system' branch --show-current)\" = main ] && test -x '$MM_HOME/system/bin/backup'"
check "project: config repo under projects/, root pointed here" bash -c "grep -qx 'root: $MM_HOME/projects/acme/shop' '$MM_HOME/projects/acme/shop/.mm-answers.yaml' && [ -z \"\$(git -C '$MM_HOME/projects/acme/shop' status --porcelain --untracked-files=no)\" ]"
check "project: product repo" grep -qx "$M_CODE" "$MM_HOME/projects/acme/shop/code/app.txt"
check "project: board data staged for its first start (0700)" bash -c "[ \$(stat -c %a '$MM_HOME/projects/acme/shop/.restore') = 700 ] && grep -q '$M_BOARD' '$MM_HOME/projects/acme/shop/.restore/board.jsonl' && test -d '$MM_HOME/projects/acme/shop/.restore/board.dolt'"
check "the report lists both boards and says nothing started" bash -c "jq -e '[.[] | .step] | (index(\"board system\") != null) and (index(\"board acme-shop\") != null)' '$T/c.json' && jq -e '.[] | select(.step==\"start\") | .status==\"skip\"' '$T/c.json'"
check "a second restore on this box: refused (not blank)" bash -c "! mm restore '$R' --identity '$T/recovery.key' --accept '$C2'"
check "no work folder left (unsealed copies removed)" bash -c "! ls -d '$MM_HOME'/state/restore-work-* 2>/dev/null"
check "the identity is not copied anywhere on the box" bash -c "! grep -rqF \"\$(grep -v '^#' '$T/recovery.key')\" '$HOME'"
check "no value in any output" bash -c "! grep -qF '$V' '$LOG' '$T/c.json' '$T/b2.json'"

echo '== the hold (box c)'
check "the restored box is on hold" bash -c "mm config get restore.hold | grep -qx true"
check "mm sync refuses on a held box (the old box may still be up)" bash -c "mm sync 2>&1 | grep -q 'restore on hold'"
check "--release needs a terminal: a pipe is not enough, the hold stays" bash -c "echo 'the old box is down' | mm restore --release; mm config get restore.hold | grep -qx true"
if command -v script >/dev/null; then
  check "--release with the wrong words: the hold stays" bash -c "printf 'yes\n' | script -qec 'mm restore --release' /dev/null; mm config get restore.hold | grep -qx true"
  box e; mm restore --data-only --drill "$R" --identity "$T/recovery.key" --accept "$C2" >>"$LOG" 2>&1
  check "a drill box can never be released, even with the right words" bash -c "printf 'the old box is down\n' | script -qec 'mm restore --release' /dev/null | grep -q 'never goes outward' && mm config get restore.hold | grep -qx true"
fi

echo '== who may run it, and the hidden prompt'
box f
check "inside an agent: refused, nothing written" bash -c "CLAUDECODE=1 mm restore '$R' --identity '$T/recovery.key' --accept '$C2' 2>&1 | grep -q 'not from an agent' && ! test -e '$MM_HOME/config.yaml'"
box g
check "inside an agent: a --drill (test keys) may run" bash -c "CLAUDECODE=1 mm restore --data-only --drill '$R' --identity '$T/recovery.key' --accept '$C2' >>'$LOG' 2>&1 && test -s '$MM_HOME/vault/key'"
if command -v script >/dev/null; then
  box h   # the input comes after a pause, so the terminal's echo is already off when it arrives
  (sleep 3; grep -v '^#' "$T/recovery.key") | script -qec "mm restore --data-only '$R' --accept '$C2'" /dev/null >"$T/prompt.out" 2>&1
  check "the hidden prompt: restored from the typed identity" bash -c "grep -q more '$MM_HOME/brain/memory/fact.md' && test -s '$MM_HOME/vault/key'"
  check "...nothing of it shown on the terminal" bash -c "grep -q 'nothing shows' '$T/prompt.out' && ! grep -qF \"\$(grep -v '^#' '$T/recovery.key')\" '$T/prompt.out'"
  check "...its memory-backed file removed, nothing left on the box" bash -c "! ls '$SHM'/mm/secrets/.restore-identity-* 2>/dev/null && ! grep -rqF \"\$(grep -v '^#' '$T/recovery.key')\" '$HOME' '$SHM'"
  box i
  check "the prompt refuses a line that isn't an age identity" bash -c "(sleep 3; echo not-a-key) | script -qec \"mm restore --data-only '$R' --accept '$C2'\" /dev/null 2>&1 | grep -q 'not an age identity line' && ! test -e '$MM_HOME/config.yaml'"
fi

echo '== a tampered mastermind'
git clone -q -b main "$R" "$T/evil" && printf 'x' >>"$T/evil/brain/repo.bundle.age" && git -C "$T/evil" commit -qam evil --no-verify && E=$(git -C "$T/evil" rev-parse HEAD)
box d
check "a sealed file changed after MANIFEST: refused, even with the typed hash" bash -c "mm restore '$T/evil' --identity '$T/recovery.key' --accept '$E' 2>&1 | grep -q 'sha256 differs from MANIFEST' && ! test -e '$MM_HOME/config.yaml'"
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
