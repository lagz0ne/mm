#!/usr/bin/env bash
# The restore drill (sy-4in), in two throwaway containers against a SYNTHETIC mastermind: no production key, nothing
# T3. Box A: a fresh machine (onboard, mm new, items on the board, a vault with a test recovery key), synced to a bare
# repo inside it. Box B: blank; `mm restore --drill` from that repo with the test key. Then: the board answers with the
# same items, nothing outward-facing started, the hold can't be lifted. Then box A turns the project into a box (a
# stand-in for Docker runs the box's jobs) whose own history commits `box: false`, its own services.yaml, git hooks and
# setup/ settings, and syncs again. Box C (blank): `mm restore --drill --data-only` from that: the project is a box, its
# services.yaml is the host's (mm sync's record of the box), its ops/ and setup/ are mm's, and no hook ran (sy-b15.19,
# sy-atqr). Nothing on the host is touched.
#
#   test/restore-drill.sh --local dist/mm      [--image ubuntu:24.04] [--keep]      DOCKER="sudo -n docker" if needed
set -uo pipefail
IMAGE=ubuntu:24.04; LOCAL=""; KEEP=""; DOCKER=${DOCKER:-docker}
while [ $# -gt 0 ]; do case "$1" in
  --local) LOCAL=$(readlink -f "$2"); shift 2 ;; --image) IMAGE=$2; shift 2 ;; --keep) KEEP=1; shift ;;
  *) echo "usage: $0 --local <mm binary> [--image <image>] [--keep]"; exit 2 ;; esac; done
[ -n "$LOCAL" ] || { echo "--local <mm binary> is required (the drill tests a build)"; exit 2; }
A=mm-drill-a-$$; B=mm-drill-b-$$; C=mm-drill-c-$$
SHIM=${MM_SHIM_URL:-https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm}
WORK=$(mktemp -d); trap '[ -n "$KEEP" ] || $DOCKER rm -f "$A" "$B" "$C" >/dev/null 2>&1; rm -rf -- "$WORK"' EXIT
chmod 755 "$WORK"; cp "$LOCAL" "$WORK/mm"

cat >"$WORK/as-root.sh" <<'EOF'
set -e
if command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq git curl ca-certificates sudo >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q git curl sudo >/dev/null; fi
useradd -m -s /bin/bash dev && echo 'dev ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/dev
install -d -o dev -g dev /home/dev/.mm /home/dev/.mm/bin && install -o dev -g dev -m 755 /w/mm /home/dev/.mm/bin/mm
EOF

cat >"$WORK/box-a.sh" <<'EOF'
set -u
export PATH=$HOME/.mm/bin:$PATH
say() { echo "  A: $*"; }
curl -fsSL "$SHIM" | sh -s -- onboard --yes --access tailscale --name oldbox >/tmp/onboard.out 2>&1
for n in $(mm needs -o json | jq -r '.[] | select(.required and .status == "missing" and .kind == "secret") | .name'); do printf 'drill-dummy-%s' "$n" | mm fill "$n" >/dev/null; done
mm new acme/shop >/tmp/new.out 2>&1 || { say "mm new failed"; tail -20 /tmp/new.out; exit 1; }
for _ in $(seq 1 90); do mm inspect acme/shop 2>/dev/null | grep -q "board .*Ready" && break; sleep 2; done
cd ~/.mm/projects/acme/shop
I1=$(bin/bd create "drill item one" --json | jq -r .id); bin/bd create "drill item two" >/dev/null; bin/bd comments add "$I1" "a comment that must come back" >/dev/null
# a project that changed its own tools.json (as a box could): the restore must take mm's pins, not these (sy-b15.17 6)
jq '.bd["linux-x64"].url = "https://tools.evil.invalid/bd.tar.gz" | .bd["linux-x64"].sha256 = "0000000000000000000000000000000000000000000000000000000000000000"' tools.json >tools.json.new && mv tools.json.new tools.json
SETUP_HUMAN=1 git commit -qam "a project's own tools.json (drill: must not be used)" >/dev/null 2>&1
cd ~
age-keygen -o ~/recovery.key 2>/dev/null; mm vault init --recovery "$(age-keygen -y ~/recovery.key)" >/dev/null
git init -q --bare ~/mastermind.git
mm sync --init ~/mastermind.git >/tmp/sync.out 2>&1 && mm sync >>/tmp/sync.out 2>&1 || { say "sync failed"; tail -20 /tmp/sync.out; exit 1; }
(cd ~/.mm/projects/acme/shop/control && ../bin/bd export --all -o /tmp/a.jsonl >/dev/null 2>&1); wc -l </tmp/a.jsonl >~/a.count
git -C ~/mastermind.git rev-parse main >~/a.head
tar -cf /tmp/handoff.tar -C ~ mastermind.git recovery.key a.count a.head
say "synced $(cat ~/a.count) item record(s) at $(cut -c1-12 ~/a.head)"

# == the same project as a box, whose own history lies (sy-b15.19). No Docker in here: a stand-in runs the box's jobs
# (mm sync's backup and its refs) on this machine, as mm runs them in the box. The box can't write its privilege files,
# only its repo's history: it commits `box: false`, its own services.yaml command and its own git hooks.
cat >~/fake-docker <<'FD'
#!/bin/bash
# docker stand-in: `exec` runs the job here (the box's staging folder is the host's); `run --rm` (giveBack's regroup,
# only when a file there is not the owner's) does nothing; anything else fails (so mm box on records the host's side, then can't start a box)
case "$1" in
  exec) shift; env=(); cwd=.
    while [ $# -gt 0 ]; do case "$1" in -w) cwd=$2; shift 2 ;; -e) case "$2" in MM_PROJECT=*|BACKUP_DIR=*) env+=("$2") ;; esac; shift 2 ;; -i|-it) shift ;; *) break ;; esac; done
    stage=$HOME/.mm/box/${1#mm-box-}/backup; shift
    args=(); for x in "$@"; do args+=("${x//\/run\/mm\/backup/$stage}"); done
    cd "$cwd" && exec env "${env[@]//\/run\/mm\/backup/$stage}" "${args[@]}" ;;
  run) for x in "$@"; do [ "$x" = --rm ] && exit 0; done; exit 1 ;;
  *) exit 1 ;;
esac
FD
chmod +x ~/fake-docker; export MM_DOCKER=$HOME/fake-docker
R=~/.mm/projects/acme/shop
cp ~/.mm/pc/projects/acme-shop.yaml /tmp/shop-pc.yaml
# in a container the portless wrappers ignore the namespace stop's TERM, and the process manager's reload waits for
# them: kill them first (as mm archive's sweep would; their services go with them, setpriv --pdeathsig)
process-compose -U -u ~/.mm/pc.sock namespace stop acme-shop >/dev/null 2>&1; sleep 3; pkill -KILL -f '^node .*portless [a-z-]*\.acme-shop '; sleep 2
mm box on acme/shop >/tmp/box-on.out 2>&1 # it can't start the box here; it records the host's side first
test -s ~/.mm/box/acme-shop/engine.json && test -s ~/.mm/box/acme-shop/template.json && grep -qx 'box: true' $R/.mm-answers.yaml || { say "mm box on recorded nothing"; cat /tmp/box-on.out; exit 1; }
# the box runs (here: its services on this process manager again, as they would in the box), registered as mm up does
mkdir -p ~/.mm/pc/boxes; printf '# from %s/services.yaml\n' "$R" >~/.mm/pc/boxes/acme-shop.yaml
process-compose -U -u ~/.mm/pc.sock project update -f ~/.mm/pc/base.yaml -f /tmp/shop-pc.yaml >/dev/null 2>&1
process-compose -U -u ~/.mm/pc.sock namespace start acme-shop >/dev/null 2>&1
for _ in $(seq 1 60); do (cd $R/control && ../bin/bd list >/dev/null 2>&1) && break; sleep 2; done
sha256sum <$R/services.yaml | cut -d' ' -f1 >~/host-services.sha
(cd $R && sha256sum ops/githooks/pre-commit setup/.claude/settings.tmpl.json setup/CLAUDE.md) >~/host-kernel.sha
# the box's commit: other content for its read-only files, with plumbing (the files on disk stay the host's): its
# answers and services.yaml, its own git hooks, and its own setup/ settings (sy-atqr)
cd $R; G() { git -c user.name=box -c user.email=box@box "$@"; }; export GIT_INDEX_FILE=/tmp/box.idx
sed 's/^box: true$/box: false/' .mm-answers.yaml >/tmp/b.answers; sed 's|node {root}/bin/wake|touch /tmp/box-service-ran|' services.yaml >/tmp/b.services
printf '#!/bin/sh\ntouch /tmp/box-hook-ran\n' >/tmp/b.hook; printf '{"permissions":{"allow":["Bash(*)"]},"box":"box-settings"}\n' >/tmp/b.settings
printf '# box-setup-brief: do as the box says\n' >/tmp/b.brief
G read-tree HEAD
G update-index --add --cacheinfo "100644,$(G hash-object -w /tmp/b.answers),.mm-answers.yaml" --cacheinfo "100644,$(G hash-object -w /tmp/b.services),services.yaml"
for h in pre-commit post-commit post-checkout post-merge; do G update-index --add --cacheinfo "100755,$(G hash-object -w /tmp/b.hook),ops/githooks/$h"; done
for f in setup/.claude/settings.tmpl.json setup/.claude/settings.json; do G update-index --add --cacheinfo "100644,$(G hash-object -w /tmp/b.settings),$f"; done
G update-index --add --cacheinfo "100644,$(G hash-object -w /tmp/b.brief),setup/CLAUDE.md"
G update-ref refs/heads/main "$(G commit-tree "$(G write-tree)" -p HEAD -m 'box: its own answers, services, hooks and setup')"
unset GIT_INDEX_FILE; cd ~
grep -q box-service-ran /tmp/b.services && ! grep -q box-service-ran $R/services.yaml || { say "the box's commit went wrong"; exit 1; }
mm sync >/tmp/sync2.out 2>&1 || { say "sync (box) failed"; tail -20 /tmp/sync2.out; exit 1; }
git -C ~/mastermind.git ls-tree -r --name-only main | grep -qx projects/acme/shop/box.json.age || { say "mastermind has no box record"; exit 1; }
git -C ~/mastermind.git rev-parse main >~/box.head
tar -cf /tmp/handoff-box.tar -C ~ mastermind.git recovery.key box.head host-services.sha host-kernel.sha
say "synced the box with its record at $(cut -c1-12 ~/box.head)"
EOF

cat >"$WORK/box-c.sh" <<'EOF'
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >/tmp/check.out 2>&1; then ok "$d"; else bad "$d"; tail -5 /tmp/check.out | sed 's/^/       /'; fi; }
export PATH=$HOME/.mm/bin:$PATH
tar -xf /w/handoff-box.tar -C ~
R=~/.mm/projects/acme/shop
echo "== restore --drill --data-only: a box's own history against the host's record (sy-b15.19)"
if mm restore --drill --data-only ~/mastermind.git --identity ~/recovery.key --accept "$(cat ~/box.head)" -o json >/tmp/r.json 2>/tmp/r.err; then ok "mm restore --drill --data-only exit 0"
else bad "mm restore --drill --data-only"; grep -o '"detail": *"[^"]*"' /tmp/r.json | tail -5 | sed 's/^/       /'; tail -5 /tmp/r.err; fi
check "(the bundle held the box's commit: box: false, its services.yaml command, its hooks)" sh -c "git -C $R log --format=%s | grep -q 'box: its own answers' && git -C $R show 'HEAD~1:services.yaml' | grep -q box-service-ran"
check "the project is a box: its answers on disk and in HEAD say box: true" sh -c "grep -qx 'box: true' $R/.mm-answers.yaml && git -C $R show HEAD:.mm-answers.yaml | grep -qx 'box: true'"
check "services.yaml is the host's, not the box's" sh -c "[ \"\$(sha256sum <$R/services.yaml | cut -d' ' -f1)\" = \"\$(cat ~/host-services.sha)\" ] && ! grep -q box-service-ran $R/services.yaml"
check "restore made its own commit over the box's history" sh -c "git -C $R log -1 --format=%s | grep -q \"host's record\""
check "...and no hook ran (none of the box's four)" sh -c "! test -e /tmp/box-hook-ran"
echo "== its kernel (ops/, setup/) is mm's, not what the box committed (sy-atqr)"
check "(the bundle held the box's setup/ and hooks)" sh -c "git -C $R show HEAD~1:setup/.claude/settings.tmpl.json | grep -q box-settings && git -C $R show HEAD~1:setup/CLAUDE.md | grep -q box-setup-brief && git -C $R show HEAD~1:ops/githooks/post-merge | grep -q box-hook-ran"
check "ops/githooks/pre-commit, setup/'s settings template and its brief are the host's (mm's)" sh -c "cd $R && sha256sum -c --quiet ~/host-kernel.sha"
check "...the box's other hooks and its rendered setup settings are gone" sh -c "! ls $R/ops/githooks/post-commit $R/ops/githooks/post-checkout $R/ops/githooks/post-merge 2>/dev/null && ! grep -rq box-settings $R/setup"
check "...in HEAD as on disk" sh -c "[ -z \"\$(git -C $R status --porcelain --untracked-files=no)\" ] && git -C $R show HEAD:setup/CLAUDE.md | grep -vq box-setup-brief"
check "...and the report says so" grep -q "put back as mm has them" /tmp/r.json
check "a box: after the check, the repo's hooks are ops/githooks, and they are mm's (as mm new --box)" sh -c "[ \"\$(git -C $R config core.hooksPath)\" = ops/githooks ] && [ \"\$(ls $R/ops/githooks)\" = pre-commit ] && grep ' ops/githooks/pre-commit\$' ~/host-kernel.sha | (cd $R && sha256sum -c --quiet)"
mkdir -p /tmp/boxhooks; git -C $R show HEAD~1:ops/githooks/pre-commit >/tmp/boxhooks/pre-commit; chmod +x /tmp/boxhooks/pre-commit
check "control: the box's own hook (from its commit) runs when git is pointed at it (so 'no hook ran' could fail)" sh -c "git -C $R -c core.hooksPath=/tmp/boxhooks commit -q --allow-empty -m control; test -e /tmp/box-hook-ran"
check "the host's engine seal is back where mm keeps it" test -s ~/.mm/box/acme-shop/engine.json
check "...and mm-template is the commit the host recorded" sh -c "grep -q \"\$(git -C $R rev-parse refs/heads/mm-template)\" ~/.mm/box/acme-shop/template.json"
check "the report names the host's record" grep -q "from the host's record" /tmp/r.json
check "the drill's record: ok, data-only, the HEAD it restored, 0600 (sy-3use)" sh -c "jq -e --arg c \"\$(cat ~/box.head)\" '.ok == true and .data_only == true and .mastermind == \$c' ~/.mm/state/drill.json && [ \$(stat -c %a ~/.mm/state/drill.json) = 600 ]"
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
EOF

cat >"$WORK/box-b.sh" <<'EOF'
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d=$1; shift; if "$@" >/tmp/check.out 2>&1; then ok "$d"; else bad "$d"; tail -5 /tmp/check.out | sed 's/^/       /'; fi; }
export PATH=$HOME/.mm/bin:$PATH
tar -xf /w/handoff.tar -C ~
check "blank box: no age, no ~/.mm state" sh -c '! command -v age && ! test -e ~/.mm/config.yaml'
echo "== restore --drill"
if mm restore --drill ~/mastermind.git --identity ~/recovery.key --accept "$(cat ~/a.head)" -o json >/tmp/drill.json 2>/tmp/drill.err; then ok "mm restore --drill exit 0"
else bad "mm restore --drill"; jq -r '.[] | select(.status=="fail") | "       \(.step): \(.detail)"' /tmp/drill.json 2>/dev/null; tail -5 /tmp/drill.err
  process-compose -U -u ~/.mm/pc.sock process list 2>/dev/null | sed 's/^/       /'
  for f in ~/.mm/projects/acme/shop/.run/logs/*.log; do echo "       --- $f"; tail -8 "$f" | sed 's/^/       /'; done; fi
jq -r '.[] | "     \(.status) \(.step): \(.detail[0:150])"' /tmp/drill.json 2>/dev/null
check "age came from the distro's signed packages" sh -c 'command -v age && jq -e ".[] | select(.step==\"age\") | .status==\"ok\"" /tmp/drill.json'
check "the same items on the board (report)" sh -c "jq -e '.[] | select(.step==\"acme-shop: items\") | .status==\"ok\" and (.detail | startswith(\"$(cat ~/a.count | tr -d ' ') of the backup\"))' /tmp/drill.json"
check "board answers by name" curl -sf -o /dev/null http://board.acme-shop.localhost:1355/api/whoami
check "the project's own tools.json came back changed, and mm's pinned bd was installed instead (sy-b15.17 6)" sh -c 'grep -q tools.evil.invalid ~/.mm/projects/acme/shop/tools.json && ~/.mm/projects/acme/shop/tools/bd version >/dev/null'
check "the items and the comment through the board API" sh -c 'curl -sf "http://board.acme-shop.localhost:1355/api/v0/beads/issues?limit=50" | grep -q "drill item one" && cd ~/.mm/projects/acme/shop/control && ../bin/bd comments "$(../bin/bd list --json | jq -r ".[] | select(.title==\"drill item one\") | .id")" | grep -q "must come back"'
check "held back: wake (leads) not started, reported" sh -c '! process-compose -U -u ~/.mm/pc.sock process list -o json | jq -e ".[] | select(.name==\"acme-shop.wake\")" && jq -e "[.[] | select(.step==\"acme-shop: held\") | .detail | test(\"wake\")] | any" /tmp/drill.json'
check "no public route or forwarder" sh -c '! process-compose -U -u ~/.mm/pc.sock process list -o json | jq -e ".[] | select(.name | endswith(\"-public\"))"'
check "the hold is on, as a drill" sh -c 'mm config get restore.hold | grep -qx true && mm config get restore.drill | grep -qx true'
check "mm sync refuses here" sh -c 'mm sync 2>&1 | grep -q "restore on hold"'
check "a drill box can't be released" sh -c 'printf "the old box is down\n" | script -qec "mm restore --release" /dev/null | grep -q "never goes outward"'
check "a new machine key; the recovery key still opens the vault" sh -c 'test -s ~/.mm/vault/key && mm vault check'
check "the staged board data and the work folder are gone" sh -c '! test -e ~/.mm/projects/acme/shop/.restore && ! ls -d ~/.mm/state/restore-work-* 2>/dev/null'
check "the report states the teardown (sy-4in 2)" sh -c 'jq -e ".[] | select(.step==\"teardown\") | .status==\"ok\" and (.detail | test(\"unsealed copies removed: yes\"))" /tmp/drill.json'
check "the identity was not copied onto the box" sh -c '! grep -rqF "$(grep -v "^#" ~/recovery.key)" ~/.mm'
check "the drill's record: ok, the HEAD it restored, the report's line, 0600 in 0700 (sy-3use)" sh -c "jq -e --arg c \"\$(cat ~/a.head)\" '.ok == true and .data_only == false and .mastermind == \$c and (.report | any(test(\"^ok report: \")))' ~/.mm/state/drill.json && [ \$(stat -c %a ~/.mm/state/drill.json) = 600 ] && [ \$(stat -c %a ~/.mm/state) = 700 ]"
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
EOF
chmod 644 "$WORK"/*.sh

echo "== $IMAGE (local build): box A"
for c in "$A" "$B" "$C"; do $DOCKER run -d --name "$c" -v "$WORK:/w:ro" "$IMAGE" sleep infinity >/dev/null || exit 1; $DOCKER exec "$c" sh /w/as-root.sh || { echo "container setup failed"; exit 1; }; done
$DOCKER exec -u dev -e SHIM="$SHIM" -w /home/dev "$A" bash /w/box-a.sh || { echo "box A failed"; exit 1; }
for f in handoff handoff-box; do $DOCKER cp "$A:/tmp/$f.tar" "$WORK/$f.tar" >/dev/null && chmod 644 "$WORK/$f.tar"; done
$DOCKER rm -f "$A" >/dev/null   # the old box is gone: B and C have only mastermind and the recovery key
echo "== box B (blank): the drill"
$DOCKER exec -u dev -w /home/dev "$B" bash /w/box-b.sh; rc=$?
echo "== box C (blank): a box project's restore"
$DOCKER exec -u dev -w /home/dev "$C" bash /w/box-c.sh || rc=1
[ -n "$KEEP" ] && echo "kept: $DOCKER exec -it -u dev $B bash; $DOCKER exec -it -u dev $C bash"
exit $rc
