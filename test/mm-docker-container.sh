#!/usr/bin/env bash
# box/mm-docker against the real Docker (sy-78dy): the wrapper in test mode (not root; its config names
# `sudo -n docker` as its docker) builds a small image, makes a project network, runs a box-like container and execs
# into it, gives the box's files back with mm's own giveBack and take (src/box.ts: a regroup as the box's uid, then the
# owner's copies; no root container, root_containers = no), and refuses root, a privileged container, a host mount and
# an exec into a container that is not mm's (made directly, unlabelled). Only throwaway containers, a throwaway network
# and image, all removed at the end. Nothing of the machine's mm is used.
#   DOCKER="sudo -n docker" test/mm-docker-container.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
W="$HERE/box/mm-docker"
DOCKER=${DOCKER:-docker}
BASE=${MM_DOCKER_TEST_BASE:-ubuntu:24.04}   # a local image the test builds on (no pull here)
P="mmdt-$$"; IMG="mm-box:test-$$"; NET="mm-net-$P"; BOX="mm-box-$P"; FAKE="mm-box-${P}x"
T=$(mktemp -d); chmod 755 "$T"
cleanup() {
  $DOCKER rm -f "$BOX" "$FAKE" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1
  # what the box's uid may have left: removed by a throwaway container, then the image
  $DOCKER run --rm --network none -v "$T:/t" "$IMG" sh -c 'rm -rf /t/* /t/.[!.]*' >/dev/null 2>&1
  $DOCKER rmi -f "$IMG" >/dev/null 2>&1; rm -rf "$T"
}
trap cleanup EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
U=$(id -u); G=$(id -g)
$DOCKER image inspect "$BASE" >/dev/null 2>&1 || { echo "no local $BASE (MM_DOCKER_TEST_BASE names another)"; exit 2; }

MM="$T/mm"; PR="$MM/projects/acme/$P"
mkdir -p "$PR" "$MM/box/$P/cfg" "$T/secrets"; printf 'project: %s\n' "$P" >"$PR/.mm-answers.yaml"
echo hello >"$PR/hello"; chmod 2775 "$PR"
cat >"$T/conf" <<EOF
docker = $DOCKER
mm_home = $MM
projects = $MM/projects
secrets = $T/secrets
root_containers = no
EOF
export MM_DOCKER_CONF="$T/conf"
w() { "$W" "$@"; }

echo "== build, network, run, exec through the wrapper"
B="$T/mm-box-build-ct$$"; mkdir -p "$B"; chmod 700 "$B"; printf 'FROM %s\nRUN echo built >/built\n' "$BASE" >"$B/Dockerfile"
if w build -q -t "$IMG" -f "$B/Dockerfile" "$B" >/dev/null 2>"$T/err"; then ok "build $IMG"; else bad "build"; tail -3 "$T/err"; fi
for n in $(seq 249 -1 10); do
  if w network create --internal --subnet "10.231.$n.0/24" --gateway "10.231.$n.1" --label "mm.project=$P" "$NET" >/dev/null 2>"$T/err"; then break; fi
  grep -qiE 'overlap|in use' "$T/err" || break
done
[ "$($DOCKER network inspect -f '{{.Internal}}' "$NET" 2>/dev/null)" = true ] && ok "network $NET (internal, 10.231.$n.0/24)" || { bad "network"; cat "$T/err"; }
BUID=$((200000 + n))
if w run -d --name "$BOX" --hostname "$P" --label "mm.project=$P" --network "$NET" --ip "10.231.$n.10" --restart unless-stopped --dns 127.0.0.1 \
    --user "$BUID:$G" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 64m --cpus 1 \
    --tmpfs /tmp:rw,nosuid,nodev,size=8m,mode=1777 -v "$PR:$PR" -v "$MM/box/$P/cfg:/run/mm/cfg:ro" -w "$PR" "$IMG" sh -c 'sleep 600' >/dev/null 2>"$T/err"
then ok "run a box-like container"; else bad "run"; cat "$T/err"; fi
f=$($DOCKER inspect -f '{{.HostConfig.Privileged}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.NetworkMode}} {{.Config.User}} {{index .Config.Labels "mm.project"}} {{range .Mounts}}{{.Source}} {{end}}' "$BOX" 2>/dev/null)
[[ $f == "false [ALL] [no-new-privileges] $NET $BUID:$G $P "* && $f == *"$PR "* && $f == *"$MM/box/$P/cfg "* ]] && ok "it is what was checked ($f)" || bad "inspect: $f"
[ "$(w exec "$BOX" id -u 2>/dev/null)" = "$BUID" ] && ok "exec into it: the box's uid $BUID" || bad "exec id"
[ "$(w exec -w "$PR" "$BOX" cat hello 2>/dev/null)" = hello ] && ok "exec: the project is mounted at its own path" || bad "exec cat"
# what a box's programs leave (umask 002, as in the box; some make their files 0600 and folders 0700 themselves)
w exec "$BOX" sh -c "umask 002 && echo from-box >$PR/made && chmod 600 $PR/made && mkdir $PR/priv && echo deep >$PR/priv/deep && chmod 600 $PR/priv/deep && chmod 700 $PR/priv && echo open >$PR/open && ln $PR/made $PR/hl && ln -s made $PR/ln && mkdir -p $PR/keep/sub && echo k >$PR/keep/sub/f && chmod 600 $PR/keep/sub/f && chmod 700 $PR/keep/sub $PR/keep && mkfifo -m 600 $PR/fifo" 2>/dev/null
[ "$(stat -c %u:%a "$PR/made" 2>/dev/null)" = "$BUID:600" ] && [ "$(stat -c %u:%a "$PR/priv" 2>/dev/null)" = "$BUID:2700" ] && ok "the box made files as its uid (a 0600 file, a 0700 folder with a 0600 file)" || bad "box files"
! cat "$PR/made" >/dev/null 2>&1 && ! ls "$PR/priv" >/dev/null 2>&1 && ok "...which the host owner can't read yet" || bad "the owner reads the box's 0600 file before the regroup"
w rm -f "$BOX" >/dev/null 2>&1 && ok "rm -f the box" || bad "rm"

echo "== giving the box's files back, with no root container (sy-58fo; root_containers = no)"
# mm's own code (src/box.ts giveBack, take), through the wrapper; a throwaway MM_HOME
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun"); mkdir -p "$T/mmhome"
mmjs() { (cd "$T" && MM_HOME="$T/mmhome" MM_DOCKER="$W" "$BUN" -e "$1"); }
if out=$(mmjs "import { giveBack } from '$HERE/src/box.ts'; const r = giveBack(['$PR'], '$IMG'); console.log(JSON.stringify(r)); process.exit(r.ok && r.uids.join() === '$BUID' ? 0 : 1)" 2>&1)
then ok "giveBack: a regroup as the box's uid $BUID, through the wrapper ($out)"; else bad "giveBack: $out"; fi
[ "$(cat "$PR/made" 2>/dev/null)" = from-box ] && [ "$(cat "$PR/priv/deep" 2>/dev/null)" = deep ] && ok "the host owner reads them now (the 0600 file, the file in the 0700 folder)" || bad "the owner can't read them"
mkdir -p "$PR/landing" && mv "$PR/priv" "$PR/landing/priv" 2>"$T/err" && ok "...moves the box's folder to another folder (as a backup lands)" || { bad "move"; cat "$T/err"; }
rm -rf "$PR/landing" 2>"$T/err" && [ ! -e "$PR/landing" ] && ok "...and removes it, with what is in it (as mm archive and the backup keep-14 do)" || { bad "remove"; cat "$T/err"; }
if out=$(mmjs "import { take } from '$HERE/src/box.ts'; const t = take(['$PR']); console.log(JSON.stringify(t)); process.exit(t.left.length ? 1 : 0)" 2>&1) \
    && [ -z "$(find "$PR" ! -user "$U")" ] && [ "$(cat "$PR/made")" = from-box ] && [ "$(stat -c %i "$PR/made")" = "$(stat -c %i "$PR/hl")" ] \
    && [ "$(readlink "$PR/ln")" = made ] && [ "$(stat -c %a "$PR/made")" = 660 ]
then ok "take (mm box off): every file the owner's again, no chown, its content, hard link, symlink and mode kept ($out)"; else bad "take: $out"; find "$PR" -printf '%u %m %p\n'; fi
[ "$(cat "$PR/keep/sub/f" 2>/dev/null)" = k ] && [ "$(stat -c %a "$PR/keep/sub")" = 2770 ] && ok "take: the box's folders too, made again as the owner's, with what is in them" || bad "take: folders"
[ -p "$PR/fifo" ] && [ "$(stat -c %u:%a "$PR/fifo")" = "$U:600" ] && ok "take: a named pipe made again, the owner's" || bad "take: the pipe"
rm -rf "$PR/made" "$PR/hl" "$PR/ln" "$PR/open" "$PR/keep" "$PR/fifo" && ok "the host owner removes them" || bad "remove after take"
w run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE -v "$PR:$PR" \
    --entrypoint chown "$IMG" -R --no-dereference "$U:$G" "$PR" >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "the old root chown helper is refused: $(cut -c1-70 "$T/err")" || bad "the root chown helper ran"
w run --rm --network none --user 0:0 --cap-drop ALL -v "$PR:$PR" --entrypoint sh "$IMG" -c id >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "root with no capabilities is refused too: $(cut -c1-70 "$T/err")" || bad "a root container ran"

echo "== refused, and nothing was made"
gone() { ! $DOCKER container inspect "$BOX" >/dev/null 2>&1; }
w run -d --name "$BOX" --label "mm.project=$P" --privileged --user "$BUID:$G" --cap-drop ALL "$IMG" sleep 60 >/dev/null 2>"$T/err"
[ $? = 125 ] && gone && ok "--privileged: $(cut -c1-80 "$T/err")" || bad "--privileged ran"
w run -d --name "$BOX" --label "mm.project=$P" -v /:/host --user "$BUID:$G" --cap-drop ALL "$IMG" sleep 60 >/dev/null 2>"$T/err"
[ $? = 125 ] && gone && ok "-v /:/host: $(cut -c1-80 "$T/err")" || bad "-v / ran"
w run -d --name "$BOX" --label "mm.project=$P" --network host --user "$BUID:$G" --cap-drop ALL "$IMG" sleep 60 >/dev/null 2>"$T/err"
[ $? = 125 ] && gone && ok "--network host: $(cut -c1-80 "$T/err")" || bad "--network host ran"
$DOCKER run -d --name "$FAKE" --network none "$IMG" sleep 600 >/dev/null
w exec "$FAKE" id >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "exec into $FAKE (made directly, no mm.project label): $(cut -c1-70 "$T/err")" || bad "exec into the unlabelled container ran"
$DOCKER rm -f "$FAKE" >/dev/null; $DOCKER run -d --name "$FAKE" --label mm.project=someone-else --network none "$IMG" sleep 600 >/dev/null
w exec "$FAKE" id >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "exec into $FAKE labelled for another project: refused" || bad "exec into another project's container ran"
w network rm "$NET" >/dev/null 2>&1 && ok "network rm" || bad "network rm"

echo; echo "mm-docker (container): $pass passed, $fail failed"
[ "$fail" = 0 ]
