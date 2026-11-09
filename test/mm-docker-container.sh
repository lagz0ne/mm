#!/usr/bin/env bash
# box/mm-docker against the real Docker (sy-78dy, sy-e6t3): through the wrapper only (test/lib/docker.sh: the installed
# one by default; MM_DOCKER_BIN=box/mm-docker for this checkout's copy in test mode), it builds a small image, makes a
# project network, runs a box-like container and execs into it, gives the box's files back with mm's own giveBack and
# take (src/box.ts: a regroup as the box's uid, then the owner's copies; no root container, root_containers = no),
# copies to and from a container with no mounts (cp), reads logs, port and images, kills, and refuses root, a privileged
# container, a host mount, a cp with a container that has mounts, and another image's rmi. With MM_DOCKER_RAW (plain
# docker, where you may), also an exec into a container that is not mm's (made directly, unlabelled). Only throwaway
# containers, a throwaway network and image, in the tests' area, all removed at the end. Nothing of the machine's mm.
#   test/mm-docker-container.sh                         the installed wrapper (sudo -n /usr/local/libexec/mm-docker)
#   MM_DOCKER_BIN=box/mm-docker MM_DOCKER_RAW="sudo -n docker" test/mm-docker-container.sh      this checkout's copy
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
. "$HERE/test/lib/docker.sh"
W=$DOCKER; RAW=${MM_DOCKER_RAW:-}
BASE=${MM_DOCKER_TEST_BASE:-ubuntu:24.04}   # the image the test builds on; not local: the build through the wrapper pulls it
T=$(mm_test_dir dct); P=$(basename "$T"); IMG="mm-box:test-$$"; NET="mm-net-$P"; BOX="mm-box-$P"; CPC="mm-egress-$P"
ONE="mm-doop-$P"; FAKE="mm-box-${P}x"
w() { $W "$@"; }
cleanup() {
  w rm -f "$BOX" "$CPC" "$ONE" >/dev/null 2>&1; [ -n "$RAW" ] && $RAW rm -f "$FAKE" >/dev/null 2>&1; w network rm "$NET" >/dev/null 2>&1
  # what the box's uid may have left: removed by a throwaway container as that uid, then the image
  [ -n "${BUID:-}" ] && w run --rm --network none --user "$BUID:$(id -g)" --cap-drop ALL -v "$T:/t" "$IMG" sh -c 'rm -rf /t/proj/* /t/proj/.[!.]*' >/dev/null 2>&1
  w rmi -f "$IMG" >/dev/null 2>&1; rm -rf "$T"
}
trap cleanup EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
U=$(id -u); G=$(id -g)
echo "== through: $W  (the tests' area: $T)"
w images -q >/dev/null 2>&1 || { echo "no wrapper (or it does not answer): $W"; exit 2; }
[ -n "$(w images -q "$BASE" 2>/dev/null)" ] || echo "  no local $BASE: the build brings it (FROM, through the wrapper)"

PR="$T/proj"
mkdir -p "$PR" "$T/box/cfg" "$T/out" "$T/in"; printf 'project: %s\n' "$P" >"$PR/.mm-answers.yaml"
echo hello >"$PR/hello"; chmod 2775 "$PR"

echo "== build, network, run, exec through the wrapper"
B="$T/mm-box-build-ct$$"; mkdir -p "$B"; chmod 700 "$B"; printf 'FROM %s\nRUN echo built >/built\n' "$BASE" >"$B/Dockerfile"
if w build -q -t "$IMG" -f "$B/Dockerfile" "$B" >/dev/null 2>"$T/err"; then ok "build $IMG"; else bad "build"; tail -3 "$T/err"; fi
for n in $(seq 249 -1 10); do
  if w network create --internal --subnet "10.231.$n.0/24" --gateway "10.231.$n.1" --label "mm.project=$P" "$NET" >/dev/null 2>"$T/err"; then break; fi
  grep -qiE 'overlap|in use' "$T/err" || break
done
[ "$(w network inspect -f '{{.Internal}}' "$NET" 2>/dev/null)" = true ] && ok "network $NET (internal, 10.231.$n.0/24)" || { bad "network"; cat "$T/err"; }
BUID=$((200000 + n))
if w run -d --name "$BOX" --hostname "$P" --label "mm.project=$P" --network "$NET" --ip "10.231.$n.10" --restart unless-stopped --dns 127.0.0.1 \
    --user "$BUID:$G" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 64m --cpus 1 \
    --tmpfs /tmp:rw,nosuid,nodev,size=8m,mode=1777 -v "$PR:$PR" -v "$T/box/cfg:/run/mm/cfg:ro" -w "$PR" "$IMG" sh -c 'sleep 600' >/dev/null 2>"$T/err"
then ok "run a box-like container"; else bad "run"; cat "$T/err"; fi
f=$(w inspect -f '{{.HostConfig.Privileged}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.NetworkMode}} {{.Config.User}} {{index .Config.Labels "mm.project"}} {{range .Mounts}}{{.Source}} {{end}}' "$BOX" 2>/dev/null)
[[ $f == "false [ALL] [no-new-privileges] $NET $BUID:$G $P "* && $f == *"$PR "* && $f == *"$T/box/cfg "* ]] && ok "it is what was checked ($f)" || bad "inspect: $f"
[ "$(w exec "$BOX" id -u 2>/dev/null)" = "$BUID" ] && ok "exec into it: the box's uid $BUID" || bad "exec id"
[ "$(w exec -w "$PR" "$BOX" cat hello 2>/dev/null)" = hello ] && ok "exec: the project is mounted at its own path" || bad "exec cat"
# what a box's programs leave (umask 002, as in the box; some make their files 0600 and folders 0700 themselves)
w exec "$BOX" sh -c "umask 002 && echo from-box >$PR/made && chmod 600 $PR/made && mkdir $PR/priv && echo deep >$PR/priv/deep && chmod 600 $PR/priv/deep && chmod 700 $PR/priv && echo open >$PR/open && ln $PR/made $PR/hl && ln -s made $PR/ln && mkdir -p $PR/keep/sub && echo k >$PR/keep/sub/f && chmod 600 $PR/keep/sub/f && chmod 700 $PR/keep/sub $PR/keep && mkfifo -m 600 $PR/fifo" 2>/dev/null
[ "$(stat -c %u:%a "$PR/made" 2>/dev/null)" = "$BUID:600" ] && [ "$(stat -c %u:%a "$PR/priv" 2>/dev/null)" = "$BUID:2700" ] && ok "the box made files as its uid (a 0600 file, a 0700 folder with a 0600 file)" || bad "box files"
! cat "$PR/made" >/dev/null 2>&1 && ! ls "$PR/priv" >/dev/null 2>&1 && ok "...which the host owner can't read yet" || bad "the owner reads the box's 0600 file before the regroup"
w cp "$BOX:/etc/hostname" - >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "cp with a container that has mounts is refused: $(cut -c1-80 "$T/err")" || bad "cp with the box (mounts) ran"
w rm -f "$BOX" >/dev/null 2>&1 && ok "rm -f the box" || bad "rm"
# sy-gld3: mm's ports out of the box's random ports (the box's own network namespace), as src/box.ts runs it; a port-0
# listener in it gets none of them
rp=$(w run --rm --network none --user "$BUID:$G" --cap-drop ALL --sysctl net.ipv4.ip_local_reserved_ports=38000-38999 "$IMG" \
  sh -c 'cat /proc/sys/net/ipv4/ip_local_reserved_ports' 2>"$T/err")
[ "$rp" = 38000-38999 ] && ok "--sysctl: the box's kernel reserves mm's ports ($rp)" || { bad "--sysctl: '$rp'"; cat "$T/err"; }
w run --rm --network none --user "$BUID:$G" --cap-drop ALL --sysctl net.ipv4.ip_forward=1 "$IMG" true >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "--sysctl another key is refused: $(cut -c1-80 "$T/err")" || bad "--sysctl ip_forward ran"

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

echo "== create and cp (sy-e6t3): a container with no mounts, the host side the test's own folder"
w create --name "$CPC" --label "mm.project=$P" --network none --user "$((190000 + n)):$G" --cap-drop ALL "$IMG" true >/dev/null 2>"$T/err" \
  && [ "$(w inspect -f '{{.State.Status}} {{len .Mounts}} {{.HostConfig.SecurityOpt}}' "$CPC" 2>/dev/null)" = "created 0 [no-new-privileges]" ] \
  && ok "create: a stopped container, no mounts, no new privileges" || { bad "create"; cat "$T/err"; }
w cp "$CPC:/built" - 2>"$T/err" | tar -xOf - built >"$T/got" && [ "$(cat "$T/got")" = built ] && ok "cp out to -: a tar of what is in it" || { bad "cp out to -"; cat "$T/err"; }
w cp "$CPC:/built" "$T/out" 2>"$T/err" && [ "$(cat "$T/out/built" 2>/dev/null)" = built ] && [ "$(stat -c %u "$T/out/built")" = "$U" ] \
  && ok "cp out into the test's folder: written as the owner" || { bad "cp out to a folder"; cat "$T/err"; }
w cp "$CPC:/usr/bin" "$T/out" >/dev/null 2>&1
[ -n "$(find "$T/out" -perm /6000 -print -quit)" ] && bad "cp out: a setuid or setgid file on the host" || ok "cp out: no setuid or setgid file reaches the host (usr/bin's su, passwd, ...)"
echo in-file >"$T/in/x"; cp /usr/bin/true "$T/in/suid"; chmod 4755 "$T/in/suid"
tar -C "$T/in" -cf - x suid | w cp - "$CPC:/tmp" 2>"$T/err" && [ "$(w cp "$CPC:/tmp/x" - 2>/dev/null | tar -xOf - x)" = in-file ] \
  && ok "cp - into it (a tar of the owner's), and back out" || { bad "cp - in"; cat "$T/err"; }
m=$(w cp "$CPC:/tmp/suid" - 2>/dev/null | tar -tvf - 2>/dev/null)
[[ $m == -rwxr-xr-x\ 0/0* || $m == -rwxr-xr-x\ root/root* ]] && ok "...copied again by the wrapper: no setuid bit, the container's root's ($m)" || bad "cp in: $m"
w cp "$T/in" "$CPC:/tmp" 2>"$T/err" && [ "$(w cp "$CPC:/tmp/in/x" - 2>/dev/null | tar -xOf - x)" = in-file ] && ok "cp a folder of the test's into it" || { bad "cp a folder in"; cat "$T/err"; }
w cp "$CPC:/built" /tmp >/dev/null 2>"$T/err"
[ $? = 125 ] && [ ! -e /tmp/built ] && ok "cp out to /tmp is refused: $(cut -c1-70 "$T/err")" || bad "cp out to /tmp ran"
w cp /etc/hostname "$CPC:/tmp" >/dev/null 2>"$T/err"
[ $? = 125 ] && ok "cp in from /etc is refused: $(cut -c1-70 "$T/err")" || bad "cp in from /etc ran"

echo "== logs, port, kill, images, rmi"
w run -d --name "$ONE" --label "mm.project=$P" --network none --user "$((210000 + n)):$G" --read-only --cap-drop ALL "$IMG" sh -c 'echo hello-logs; sleep 600' >/dev/null 2>"$T/err" || { bad "run $ONE"; cat "$T/err"; }
for _ in 1 2 3 4 5 6 7 8 9 10; do w logs "$ONE" 2>/dev/null | grep -q hello-logs && break; sleep 0.5; done
w logs --tail 5 "$ONE" 2>/dev/null | grep -qx hello-logs && ok "logs" || bad "logs"
p=$(w port "$ONE" 2>&1); [ $? = 0 ] && [ -z "$p" ] && ok "port: nothing published" || bad "port: $p"
w kill "$ONE" >/dev/null 2>&1 && sleep 1 && [ "$(w inspect -f '{{.State.Running}}' "$ONE" 2>/dev/null)" = false ] && ok "kill" || bad "kill"
[ -n "$(w images -q "$IMG" 2>/dev/null)" ] && ok "images: $IMG is there" || bad "images"
w rmi "$BASE" >/dev/null 2>"$T/err"
[ $? = 125 ] && [ -n "$(w images -q "$BASE" 2>/dev/null)" ] && ok "rmi $BASE (not mm's) is refused, it is still there" || bad "rmi $BASE"

echo "== refused, and nothing was made"
gone() { ! w container inspect "$BOX" >/dev/null 2>&1; }
w run -d --name "$BOX" --label "mm.project=$P" --privileged --user "$BUID:$G" --cap-drop ALL "$IMG" sleep 60 >/dev/null 2>"$T/err"
[ $? = 125 ] && gone && ok "--privileged: $(cut -c1-80 "$T/err")" || bad "--privileged ran"
w run -d --name "$BOX" --label "mm.project=$P" -v /:/host --user "$BUID:$G" --cap-drop ALL "$IMG" sleep 60 >/dev/null 2>"$T/err"
[ $? = 125 ] && gone && ok "-v /:/host: $(cut -c1-80 "$T/err")" || bad "-v / ran"
w run -d --name "$BOX" --label "mm.project=$P" --network host --user "$BUID:$G" --cap-drop ALL "$IMG" sleep 60 >/dev/null 2>"$T/err"
[ $? = 125 ] && gone && ok "--network host: $(cut -c1-80 "$T/err")" || bad "--network host ran"
if [ -n "$RAW" ]; then
  $RAW run -d --name "$FAKE" --network none "$IMG" sleep 600 >/dev/null
  w exec "$FAKE" id >/dev/null 2>"$T/err"
  [ $? = 125 ] && ok "exec into $FAKE (made directly, no mm.project label): $(cut -c1-70 "$T/err")" || bad "exec into the unlabelled container ran"
  w cp "$FAKE:/built" - >/dev/null 2>&1; [ $? = 125 ] && ok "...and cp with it" || bad "cp with the unlabelled container ran"
  $RAW rm -f "$FAKE" >/dev/null; $RAW run -d --name "$FAKE" --label mm.project=someone-else --network none "$IMG" sleep 600 >/dev/null
  w exec "$FAKE" id >/dev/null 2>"$T/err"
  [ $? = 125 ] && ok "exec into $FAKE labelled for another project: refused" || bad "exec into another project's container ran"
  $RAW rm -f "$FAKE" >/dev/null
else echo "  skip exec into a container made directly (needs MM_DOCKER_RAW: the wrapper makes only labelled ones)"; fi
w rm -f "$CPC" "$ONE" >/dev/null 2>&1 && ok "rm -f of two" || bad "rm -f of two"
w network rm "$NET" >/dev/null 2>&1 && ok "network rm" || bad "network rm"
w rmi -f "$IMG" >/dev/null 2>&1 && [ -z "$(w images -q "$IMG" 2>/dev/null)" ] && ok "rmi $IMG (mm's, a test's)" || bad "rmi $IMG"

echo; echo "mm-docker (container): $pass passed, $fail failed"
[ "$fail" = 0 ]
