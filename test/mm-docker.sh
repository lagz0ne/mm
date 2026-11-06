#!/usr/bin/env bash
# Escape tests for box/mm-docker (sy-78dy; plans/host-hardening.md step 3), hermetic: the wrapper in test mode (not
# root, its config from MM_DOCKER_CONF) in front of a stand-in docker that records what it would run. Every docker call
# mm makes (src/box.ts, template/bin/doop-run, src/doctor.ts) passes, as the command line the wrapper writes; every
# refusal (the item's list, review's list on sy-6fu, quoting tricks) exits 125 and runs nothing.
#   test/mm-docker.sh
# Then mm's own `box build` through the wrapper (bun src/cli.ts, a throwaway MM_HOME).
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
W="$HERE/box/mm-docker"
T=$(mktemp -d); trap 'chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
U=$(id -u); G=$(id -g); H=$(getent passwd "$U" | cut -d: -f6)

# the stand-in docker: one line per call (each word %q-quoted); the wrapper's own label check answers from $T/labels
cat >"$T/docker" <<'EOF'
#!/usr/bin/env bash
T=$(dirname "$0")
if [ "$1 $2 $3" = "container inspect --format" ] && [[ $4 == '{{.Id}}|'* ]]; then
  n=${!#}; l=$(grep "^$n " "$T/labels" 2>/dev/null | head -1)
  [ -n "$l" ] || { echo "Error: No such container: $n" >&2; exit 1; }
  set -- $l; echo "$2|/$1|${3:-}|${4:-0}"; exit 0
fi
printf '%q ' "$@" >>"$T/calls"; echo >>"$T/calls"
# cp: out of a container, a tar of $T/ctr (what the container holds); into one, what it got is kept as $T/cpin.tar
if [ "$1" = cp ] && [ "${!#}" = - ]; then tar -C "$T/ctr" -cf - "$(basename "${2#*:}")"; fi
if [ "$1" = cp ] && [ "$2" = - ]; then cat >"$T/cpin.tar"; fi
if [ "$1" = build ]; then ctx=${!#}; (cd "$ctx" && find . -type f | sort | tr '\n' ' ') >>"$T/calls"; echo >>"$T/calls"; fi
exit 0
EOF
chmod 755 "$T/docker"
MM="$T/mm"; PR="$MM/projects/acme/shop"; SEC="$T/secrets"
mkdir -p "$PR"/{bin,secrets,data/doop,.git/hooks,.run/logs} "$MM/projects/acme/other" "$MM/box/acme-shop"/{cfg,sock,backup,ai,egress,api} \
  "$MM/paseo/acme-shop" "$MM/claude/acme-shop" "$MM/egress/acme-shop" "$SEC/acme-shop" "$T/outside"
printf 'client: acme\nname: shop\nproject: acme-shop\n' >"$PR/.mm-answers.yaml"
printf 'project: "acme-other"\n' >"$MM/projects/acme/other/.mm-answers.yaml"
echo '[core]' >"$PR/.git/config"; printf 'a public key\n' >"$PR/.run/doop-gateway.pem"; echo 'NODE_ENV=production' >"$PR/secrets/doop.env"; chmod 600 "$PR/secrets/doop.env"
echo x >"$MM/egress/acme-shop/allow"; echo 'box:x' >"$MM/box/acme-shop/passwd"; echo 'box:x' >"$MM/box/acme-shop/group"
echo s >"$T/outside/secret"
ln -s "$T/outside" "$PR/evil"; ln -s / "$PR/rootlink"; ln -s "$T/outside/secret" "$PR/secrets/linked.env"
echo h >"$PR/data/h"; ln "$PR/data/h" "$PR/hardlink"
cat >"$T/conf" <<EOF
# test config (the installed one is /etc/mm-docker.conf, root's)
docker = $T/docker
mm_home = $MM
projects = $MM/projects
secrets = $SEC
root_containers = no
test_root = $T/troot
test_prefix = mmt-
EOF
export MM_DOCKER_CONF="$T/conf"
# a test's own area (sy-e6t3): <test_root>/mmt-<name>/ is the throwaway project mmt-<name>
TR="$T/troot"; mkdir -p "$TR/mmt-cp/out" "$TR/mmt-cp/in/sub" "$TR/nopfx" "$TR/mmt-two"; echo i >"$TR/mmt-cp/in/sub/f"
ln -s "$T/outside" "$TR/mmt-cp/evil"
# what the stand-in's containers hold (docker cp out): a file, a setuid file, a link
mkdir -p "$T/ctr/server/lib"; echo s >"$T/ctr/server/lib/a.js"; echo x >"$T/ctr/server/suid"; chmod 4755 "$T/ctr/server/suid"
ln -s lib/a.js "$T/ctr/server/link"; echo p >"$T/ctr/passwd"

# yes <desc> <grep -F for the recorded call | -> <args...>: passes, docker ran once, its line has the text
yes() {
  local d=$1 want=$2; shift 2; : >"$T/calls"
  if out=$("$W" "$@" 2>&1 | tr -d '\000') && [ "$(grep -c . "$T/calls")" -ge 1 ] && { [ "$want" = - ] || grep -qF -- "$want" "$T/calls"; }; then ok "$d"
  else bad "$d"; echo "       exit/out: $out"; sed 's/^/       ran: /' "$T/calls"; fi
}
# no <desc> <args...>: exit 125, "refused", docker ran nothing (an exec's own label check is not a run)
no() {
  local d=$1; shift; : >"$T/calls"
  out=$("$W" "$@" 2>&1); rc=$?
  if [ $rc = 125 ] && grep -q 'refused' <<<"$out" && [ ! -s "$T/calls" ]; then ok "$d  ($(sed 's/^mm-docker: refused: //' <<<"$out" | head -c 90))"
  else bad "$d (exit $rc)"; echo "       out: $out"; sed 's/^/       ran: /' "$T/calls"; fi
}

IMG=mm-box:0.1.1; EG=mm-egress:0.1.1; DIG=sha256:$(printf 'a%.0s' $(seq 64))
BOXRUN=(run -d --name mm-box-acme-shop --hostname acme-shop --label mm.project=acme-shop --network mm-net-acme-shop --ip 10.231.40.10 --restart unless-stopped
  --dns 127.0.0.1 --user 200040:"$G" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 2048 --memory 4g --cpus 2
  --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 --tmpfs "$H:rw,nosuid,nodev,size=512m,uid=200040,gid=$G,mode=0700" -e "HOME=$H"
  -v "$MM/box/acme-shop/passwd:/etc/passwd:ro" -v "$MM/box/acme-shop/group:/etc/group:ro" -v "$PR:$PR"
  -v "$PR/bin:$PR/bin:ro" -v "$PR/.git/config:$PR/.git/config:ro" -v "$MM/box/acme-shop/cfg:/run/mm/cfg:ro" -v "$MM/box/acme-shop/sock:/run/mm/sock"
  -v "$MM/box/acme-shop/backup:/run/mm/backup" -v "$MM/claude/acme-shop:$MM/claude/acme-shop" -v "$MM/paseo/acme-shop:$MM/paseo/acme-shop"
  -v "$SEC/acme-shop:/run/mm/secrets:ro" -v "$MM/box/acme-shop/api:/run/mm/api:ro" -w "$PR" "$IMG" sh -c "umask 002 && exec process-compose up")
# the egress proxy and giveBack's regroup as mm makes them now (sy-58fo): their own uid, no capabilities
EGRUN=(run -d --name mm-egress-acme-shop --label mm.project=acme-shop --restart unless-stopped --init --read-only --tmpfs /run:size=8m
  --user 190040:"$G" --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 256m -e MM_EGRESS_DENY=10.0.0.0/8
  -v "$MM/egress/acme-shop/allow:/etc/mm/allow:ro" -v "$MM/box/acme-shop/ai:/run/mm/ai" -v "$MM/box/acme-shop/egress:/run/mm/log" "$EG" sh -c 'exec mm-egress')
GIVEBACK=(run --rm --network none --user 200040:"$G" --read-only --cap-drop ALL --security-opt no-new-privileges -v "$PR:$PR" -v "$MM/box/acme-shop:$MM/box/acme-shop"
  --entrypoint sh "$IMG" -c 'find "$@" -user "$(id -u)" -exec chmod g+rw {} +; exit 0' sh "$PR" "$MM/box/acme-shop")
# ...and as an older mm made them (root in the container): only with root_containers = yes
EGRUN_OLD=(run -d --name mm-egress-acme-shop --label mm.project=acme-shop --restart unless-stopped --init --read-only --tmpfs /run:size=8m
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges --pids-limit 256 --memory 256m -e MM_EGRESS_DENY=10.0.0.0/8
  --group-add "$G" -v "$MM/egress/acme-shop/allow:/etc/mm/allow:ro" -v "$MM/box/acme-shop/ai:/run/mm/ai" -v "$MM/box/acme-shop/egress:/run/mm/log" "$EG" sh -c 'exec mm-egress')
CHOWN=(run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE -v "$PR:$PR" -v "$MM/box/acme-shop:$MM/box/acme-shop"
  --entrypoint chown "$IMG" -R --no-dereference "$U:$G" "$PR" "$MM/box/acme-shop")
DOOP=(run --rm --name mm-doop-acme-shop --label mm.project=acme-shop --label mm.service=doop --network mm-doop-net-acme-shop --ip 10.232.40.10 --dns 127.0.0.1
  --user 210040:"$G" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --cap-drop ALL --security-opt no-new-privileges --memory 2g --pids-limit 1024
  -v "$PR/data/doop:/app/data" --env-file "$PR/secrets/doop.env" --entrypoint sh "$DIG" -c 'umask 002; "$@"' sh node server.js)
# with its public side behind the sign-in gateway (sy-3yz): the gateway's public key, a file of the project's, read-only
DOOPGW=(run --rm --name mm-doop-acme-shop --label mm.project=acme-shop --label mm.service=doop --network mm-doop-net-acme-shop --ip 10.232.40.10 --dns 127.0.0.1
  --user 210040:"$G" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m --cap-drop ALL --security-opt no-new-privileges --memory 2g --pids-limit 1024
  -v "$PR/data/doop:/app/data" -v "$PR/.run/doop-gateway.pem:/run/mm-gateway.pem:ro" --env-file "$PR/secrets/doop.env" --entrypoint sh "$DIG" -c 'umask 002; "$@"' sh node server.js)
REGROUP=(run --rm --network none --user 210040:"$G" --read-only --cap-drop ALL --security-opt no-new-privileges -v "$PR/data/doop:/app/data" --entrypoint sh "$DIG" -c 'exit 0')
# name, id, its mm.project label, how many mounts it has
printf 'mm-box-acme-shop %s acme-shop 14\nmm-doop-acme-shop %s acme-shop 2\nmm-box-nolabel %s\nmm-box-other %s acme-other 0\nmm-box-shortid %s acme-shortid 0\nmm-egress-acme-shop %s acme-shop 0\nmm-doop-mmt-cp %s mmt-cp 0\nmm-box-acme-badmounts %s acme-badmounts x\n' \
  "$(printf 'b%.0s' $(seq 64))" "$(printf 'd%.0s' $(seq 64))" "$(printf 'c%.0s' $(seq 64))" "$(printf 'e%.0s' $(seq 64))" "abc" \
  "$(printf 'f%.0s' $(seq 64))" "$(printf '1%.0s' $(seq 64))" "$(printf '2%.0s' $(seq 64))" >"$T/labels"

echo "== mm's own calls pass (as the wrapper's own command line)"
yes "box: run" "--volume=$PR:$PR" "${BOXRUN[@]}"
yes "box: no-new-privileges and never a pull, always" "run --pull=never --security-opt=no-new-privileges" "${BOXRUN[@]}"
yes "egress proxy: run (its own uid, no capabilities)" "--user=190040:$G --cap-drop=ALL" "${EGRUN[@]}"
yes "giveBack: the regroup as the box's uid (no root)" "--user=200040:$G" "${GIVEBACK[@]}"
yes "doop: run (env file passed as an open file)" "--env-file=/dev/fd/" "${DOOP[@]}"
cp "$T/conf" "$T/path.conf"; echo 'env_file = path' >>"$T/path.conf"
MM_DOCKER_CONF="$T/path.conf" yes "env_file = path (test mode: sudo closes the open file): its checked, real path" "--env-file=$PR/secrets/doop.env" "${DOOP[@]}"
yes "doop: run with the gateway's key (read-only, the project's own file)" "--volume=$PR/.run/doop-gateway.pem:/run/mm-gateway.pem:ro" "${DOOPGW[@]}"
yes "doop: release regroup" "--user=210040:$G" "${REGROUP[@]}"
yes "network create (box)" - network create --internal --subnet 10.231.40.0/24 --gateway 10.231.40.1 --label mm.project=acme-shop mm-net-acme-shop
yes "network create (doop)" - network create --internal --subnet 10.232.40.0/24 --gateway 10.232.40.1 --label mm.project=acme-shop --label mm.service=doop mm-doop-net-acme-shop
yes "network connect egress" - network connect --ip 10.231.40.2 mm-net-acme-shop mm-egress-acme-shop
yes "network inspect -f subnet" - network inspect -f '{{(index .IPAM.Config 0).Subnet}}' mm-net-acme-shop
yes "network inspect ids" - network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 0123456789ab ba9876543210
yes "network ls -q" - network ls -q
yes "network rm" - network rm mm-net-acme-shop
yes "container inspect (exists)" - container inspect mm-box-acme-shop
yes "inspect -f running" - inspect -f '{{.State.Running}}' mm-egress-acme-shop
yes "inspect an mm network" - inspect mm-net-acme-shop
yes "image inspect" - image inspect "$IMG"
yes "image inspect by digest" - image inspect -f '{{.Id}}' "$DIG"
yes "rm -f" - rm -f mm-box-acme-shop
yes "restart -t 2" - restart -t 2 mm-egress-acme-shop
yes "stop -t 20 doop" - stop -t 20 mm-doop-acme-shop
yes "ps --format (doctor)" - ps --format '{{.Names}}'
yes "pull by digest" - pull "ghcr.io/x/doop@$DIG"
yes "exec into the box, by its id" "exec --workdir=$PR --env=A=1 $(printf 'b%.0s' $(seq 64)) sh -c" exec -w "$PR" -e A=1 mm-box-acme-shop sh -c 'echo hi'
yes "exec -it (mm shell)" "--interactive --tty" exec -it -w "$PR" mm-box-acme-shop sh -c 'exec "$@"' sh bash
yes "exec into doop (backup)" - exec mm-doop-acme-shop tar -czf - -C /app data
yes "process-compose in the box (app slot)" - exec mm-box-acme-shop process-compose -U -u /run/mm/sock/pc.sock project update -f /run/mm/cfg/pc.yaml
yes "a command word that looks like an option stays the container's" "$IMG --privileged" run --rm --network none --user 200040:"$G" --cap-drop ALL "$IMG" --privileged
yes "a symlink inside the project to its own folder: mounted as the real path" "--volume=$PR/bin:/x" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR/./bin/../bin:/x" "$IMG"

echo "== refused: the item's list"
no "--privileged" run --privileged "${BOXRUN[@]:1}"
no "--privileged=true" run --privileged=true "${BOXRUN[@]:1}"
no "--privileged=false (no flag games at all)" run --privileged=false "${BOXRUN[@]:1}"
no "-v /:/host" run -v /:/host "${BOXRUN[@]:1}"
no "--volume=/:/host" run --volume=/:/host "${BOXRUN[@]:1}"
no "-v/etc:/x (glued)" run -v/etc:/x "${BOXRUN[@]:1}"
no "-dv /:/x (combined shorts)" run -dv /:/x --rm --network none --user 200040:"$G" --cap-drop ALL "$IMG"
no "-v=/:/x" run -v=/:/x --rm --network none --user 200040:"$G" --cap-drop ALL "$IMG"
no "a host path outside the project (home)" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$H:/x" "$IMG"
no "the projects folder itself" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$MM/projects:/x" "$IMG"
no "mm's home (vault, config)" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$MM:/x" "$IMG"
no "../ out of the project" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR/../../../../outside:/x" "$IMG"
no "a symlink in the project to outside" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR/evil:/x" "$IMG"
no "a symlink in the project to /" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR/rootlink/etc:/x" "$IMG"
no "another project's folder into this box" run -d --name mm-box-acme-shop --label mm.project=acme-shop --cap-drop ALL --user 200040:"$G" -v "$MM/projects/acme/other:/x" "$IMG"
no "a missing host path (docker would make it as root)" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR/nothere:/x" "$IMG"
no "a named volume" run --rm --network none --user 200040:"$G" --cap-drop ALL -v dokploy-postgres:/x "$IMG"
no "a hard-linked file" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR/hardlink:/x" "$IMG"
no "-v with :shared propagation" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR:/x:shared" "$IMG"
no "-v with :z relabel" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR:/x:z" "$IMG"
no "--mount type=bind,src=/" run --mount type=bind,src=/,dst=/h --rm --network none --user 200040:"$G" --cap-drop ALL "$IMG"
no "--volumes-from" run --volumes-from dokploy --rm --network none --user 200040:"$G" --cap-drop ALL "$IMG"
no "--pid=host" run --pid=host "${BOXRUN[@]:1}"
no "--pid host" run --pid host "${BOXRUN[@]:1}"
no "--ipc host" run --ipc host "${BOXRUN[@]:1}"
no "--userns host" run --userns host "${BOXRUN[@]:1}"
no "--uts host" run --uts host "${BOXRUN[@]:1}"
no "--network=host" run --network=host --rm --user 200040:"$G" --cap-drop ALL "$IMG"
no "--network host" run --network host --rm --user 200040:"$G" --cap-drop ALL "$IMG"
no "--net=host (the alias)" run --net=host --rm --user 200040:"$G" --cap-drop ALL "$IMG"
no "--network container:dokploy" run --network container:dokploy --rm --user 200040:"$G" --cap-drop ALL "$IMG"
no "--network dokploy-network" run --network dokploy-network --rm --user 200040:"$G" --cap-drop ALL "$IMG"
no "another project's network" run -d --name mm-box-acme-shop --label mm.project=acme-shop --network mm-net-acme-other --user 200040:"$G" --cap-drop ALL "$IMG"
no "--cap-add SYS_ADMIN (box)" run --cap-add SYS_ADMIN "${BOXRUN[@]:1}"
no "--cap-add=ALL (egress)" run --cap-add=ALL "${EGRUN[@]:1}"
no "--cap-add NET_ADMIN on the egress proxy" run --cap-add NET_ADMIN "${EGRUN[@]:1}"
no "egress caps on a box" run --cap-add SETUID "${BOXRUN[@]:1}"
no "no --cap-drop ALL" run --rm --network none --user 200040:"$G" "$IMG"
no "--cap-drop NET_RAW only" run --rm --network none --user 200040:"$G" --cap-drop NET_RAW "$IMG"
no "--device /dev/sda" run --device /dev/sda "${BOXRUN[@]:1}"
no "--device=/dev/kmsg" run --device=/dev/kmsg "${BOXRUN[@]:1}"
no "--security-opt seccomp=unconfined" run --security-opt seccomp=unconfined "${BOXRUN[@]:1}"
no "--security-opt apparmor=unconfined" run --security-opt apparmor=unconfined "${BOXRUN[@]:1}"
no "--security-opt label=disable" run --security-opt=label=disable "${BOXRUN[@]:1}"
no "--security-opt systempaths=unconfined" run --security-opt systempaths=unconfined "${BOXRUN[@]:1}"

echo "== refused: exec into what is not mm's"
no "exec into dokploy" exec dokploy sh
no "exec into a container by its id" exec 0123456789ab sh
no "exec into a name with no mm.project label" exec mm-box-nolabel sh
no "exec into a box labelled for another project" exec mm-box-other sh
no "exec into a container that is not there" exec mm-box-ghost sh
no "exec when docker's answer has no full id" exec mm-box-shortid sh
no "exec into the egress proxy" exec mm-egress-acme-shop sh
no "exec -u 0" exec -u 0 mm-box-acme-shop sh
no "exec --user root" exec --user root mm-box-acme-shop sh
no "exec --privileged" exec --privileged mm-box-acme-shop sh
no "exec --env-file a host file" exec --env-file /etc/passwd mm-box-acme-shop sh
no "exec -d detach-keys games" exec --detach-keys ctrl-x mm-box-acme-shop sh

echo "== refused: root in a container, beyond mm's two fixed shapes"
no "--user 0:0 on a box" run -d --name mm-box-acme-shop --label mm.project=acme-shop --network mm-net-acme-shop --user 0:0 --cap-drop ALL "$IMG"
no "--user root (a name)" run --rm --network none --user root --cap-drop ALL "$IMG"
no "--user 0" run --rm --network none --user 0 --cap-drop ALL "$IMG"
no "--user 200040 (no group: root's)" run --rm --network none --user 200040 --cap-drop ALL "$IMG"
no "--user <uid>:0 (root's group)" run --rm --network none --user 200040:0 --cap-drop ALL "$IMG"
no "--user the owner's own uid" run --rm --network none --user "$U:$G" --cap-drop ALL "$IMG"
no "--user a real account (nobody)" run --rm --network none --user "$(id -u nobody 2>/dev/null || echo 65534):$G" --cap-drop ALL "$IMG"
no "--group-add 0" run --group-add 0 "${BOXRUN[@]:1}"
no "--group-add wheel" run --group-add wheel "${BOXRUN[@]:1}"
no "no --user on a box (the image's root)" run -d --name mm-box-acme-shop --label mm.project=acme-shop --cap-drop ALL "$IMG"
no "the egress shape on the host network" run --network host "${EGRUN[@]:1}"
no "an --entrypoint other than sh/chown" run --entrypoint /bin/bash "${BOXRUN[@]:1}"
echo "== refused with root_containers = no (the default): root and any capability, in every shape"
no "the old egress proxy (the image's root, SETUID/SETGID)" "${EGRUN_OLD[@]}"
no "the old chown helper (root, CHOWN/FOWNER/DAC_OVERRIDE)" "${CHOWN[@]}"
no "the egress proxy without --user (the image's user: root as far as the wrapper knows)" run "${EGRUN[@]:1:11}" "${EGRUN[@]:14}"
no "--cap-add SETUID on the egress proxy's own uid" run --cap-add SETUID "${EGRUN[@]:1}"
no "--cap-add NET_BIND_SERVICE on the egress proxy" run --cap-add NET_BIND_SERVICE "${EGRUN[@]:1}"
no "--cap-add CHOWN on the regroup" run --cap-add CHOWN "${GIVEBACK[@]:1}"
no "--cap-add DAC_OVERRIDE on a box" run --cap-add DAC_OVERRIDE "${BOXRUN[@]:1}"
no "the regroup as root" run --rm --network none --user 0:0 --read-only --cap-drop ALL -v "$PR:$PR" --entrypoint sh "$IMG" -c id
no "the regroup as the owner's uid" run --rm --network none --user "$U:$G" --read-only --cap-drop ALL -v "$PR:$PR" --entrypoint sh "$IMG" -c id
no "--entrypoint chown as a box's uid" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR:$PR" --entrypoint chown "$IMG" -R "$U:$G" "$PR"
no "--user 0:0, no capabilities (root still owns every file)" run --rm --network none --user 0:0 --cap-drop ALL "$IMG"
yes "a box still runs" - "${BOXRUN[@]}"
yes "Doop's release regroup still runs" - "${REGROUP[@]}"
echo "== root_containers = yes (an older mm only): its two root shapes, exactly"
sed -i 's/^root_containers = no/root_containers = yes/' "$T/conf"
yes "the old egress proxy (root in its image, SETUID/SETGID only)" "--cap-add=SETUID" "${EGRUN_OLD[@]}"
yes "the old chown helper" "--entrypoint=chown" "${CHOWN[@]}"
no "the chown helper with another entrypoint" run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN -v "$PR:$PR" --entrypoint sh "$IMG" -c id
no "the chown helper chowning to root" run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN -v "$PR:$PR" --entrypoint chown "$IMG" -R --no-dereference 0:0 "$PR"
no "the chown helper on a path it did not mount" run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN -v "$PR:$PR" --entrypoint chown "$IMG" -R --no-dereference "$U:$G" /etc
no "the chown helper with a network" run --rm --user 0:0 --cap-drop ALL --cap-add CHOWN -v "$PR:$PR" --entrypoint chown "$IMG" -R --no-dereference "$U:$G" "$PR"
no "the old egress shape with another image" run "${EGRUN_OLD[@]:1:$((${#EGRUN_OLD[@]}-5))}" "$IMG" sh -c id
no "the old egress shape on the host network" run --network host "${EGRUN_OLD[@]:1}"
no "--cap-add=ALL (old egress)" run --cap-add=ALL "${EGRUN_OLD[@]:1}"
no "--cap-add NET_ADMIN on the old egress proxy" run --cap-add NET_ADMIN "${EGRUN_OLD[@]:1}"
no "egress caps on a box's own uid" run --cap-add SETUID "${BOXRUN[@]:1}"
sed -i 's/^root_containers = yes/root_containers = no/' "$T/conf"

echo "== refused: other ways out"
no "-p 0.0.0.0:80:80 (publish)" run -p 0.0.0.0:80:80 "${BOXRUN[@]:1}"
no "--publish-all" run -P "${BOXRUN[@]:1}"
no "--sysctl" run --sysctl net.ipv4.ip_forward=1 "${BOXRUN[@]:1}"
no "--runtime" run --runtime runc-evil "${BOXRUN[@]:1}"
no "--cgroup-parent" run --cgroup-parent / "${BOXRUN[@]:1}"
no "--log-driver" run --log-driver syslog "${BOXRUN[@]:1}"
ONE=(--rm --network none --user 210040:"$G" --cap-drop ALL -v "$PR/data/doop:/app/data")
no "--env-file a host file (/etc/passwd)" run "${ONE[@]}" --env-file /etc/passwd "$DIG"
no "--env-file through a symlink" run "${ONE[@]}" --env-file "$PR/secrets/linked.env" "$DIG"
no "--env-file of another project" run --rm --network none --user 210040:"$G" --cap-drop ALL --env-file "$MM/projects/acme/other/.mm-answers.yaml" -v "$PR/data/doop:/app/data" "$DIG"
no "-e without =value (the wrapper's env)" run -e SUDO_USER "${BOXRUN[@]:1}"
no "an image that is not mm's" run --rm --network none --user 200040:"$G" --cap-drop ALL ubuntu:24.04
no "an image dokploy uses" run --rm --network none --user 200040:"$G" --cap-drop ALL dokploy/dokploy:latest
no "an image named like an option" run --rm --network none --user 200040:"$G" --cap-drop ALL -- --privileged
no "-- then an option-looking image" run --rm --network none --user 200040:"$G" --cap-drop ALL -- -v
no "a nameless container mm would keep (no --rm)" run --network none --user 200040:"$G" --cap-drop ALL "$IMG"
no "a container not named mm's" run -d --name dokploy --label mm.project=acme-shop --cap-drop ALL --user 200040:"$G" "$IMG"
no "a name and a label that differ" run -d --name mm-box-acme-shop --label mm.project=acme-other --cap-drop ALL --user 200040:"$G" "$IMG"
no "a label of another kind" run --label traefik.enable=true "${BOXRUN[@]:1}"
no "--dns 8.8.8.8" run --rm --network mm-net-acme-shop --label mm.project=acme-shop --dns 8.8.8.8 --user 200040:"$G" --cap-drop ALL "$IMG"
no "an option given twice (--name)" run --name mm-box-x "${BOXRUN[@]:1}"
no "a newline in a mount" run --rm --network none --user 200040:"$G" --cap-drop ALL -v "$PR:/x
:ro" "$IMG"

echo "== refused: global options, daemons, other subcommands"
no "-H tcp://" -H tcp://127.0.0.1:2375 ps
no "--host=unix:///" --host=unix:///var/run/docker.sock ps
no "--context" --context evil ps
no "--config (the CLI's plugins)" --config /tmp/evil ps
no "-D (debug)" -D ps
no "docker commit" commit mm-box-acme-shop mm-box:evil
no "docker tag (a moved tag)" tag ubuntu:24.04 mm-box:0.1.1
no "docker load" load -i /tmp/x.tar
no "docker plugin install" plugin install evil
no "docker compose" compose up
no "docker buildx" buildx build /
no "docker volume create (a bind)" volume create -o type=none -o o=bind -o device=/ v
no "docker service create" service create --mount type=bind,src=/,dst=/h alpine
no "docker update --privileged" update mm-box-acme-shop
no "docker network create without --internal" network create --subnet 10.231.40.0/24 --gateway 10.231.40.1 --label mm.project=acme-shop mm-net-acme-shop
no "docker network create with a driver option" network create --internal -o com.docker.network.bridge.name=eth0 --subnet 10.231.40.0/24 --gateway 10.231.40.1 --label mm.project=acme-shop mm-net-acme-shop
no "docker network create of another subnet" network create --internal --subnet 172.18.0.0/16 --gateway 172.18.0.1 --label mm.project=acme-shop mm-net-acme-shop
no "docker network connect dokploy to a box net" network connect mm-net-acme-shop dokploy-traefik
no "docker network connect a box to dokploy-network" network connect dokploy-network mm-box-acme-shop
no "docker network connect across projects" network connect mm-net-acme-other mm-egress-acme-shop
no "docker network rm dokploy-network" network rm dokploy-network
no "docker rm -f dokploy" rm -f dokploy
no "docker rm -f -- dokploy-traefik" rm -f -- dokploy-traefik
no "docker stop traefik" stop -t 1 dokploy-traefik
no "docker inspect dokploy (its env has secrets)" inspect dokploy
no "docker container inspect dokploy" container inspect dokploy
no "docker image inspect of another image" image inspect dokploy/dokploy
no "docker pull by tag" pull alpine:latest
no "docker ps --filter of another kind" ps --filter before=mm-box-acme-shop
no "docker ps --filter with a space" ps --filter 'label=a b'
no "an empty call" ""

echo "== the verbs mm's tests and the leads use (sy-e6t3): create, logs, port, kill, images, rmi, more names at once"
CREATE=(create --name mm-doop-mmt-cp --label mm.project=mmt-cp --network none --user 210000:"$G" --cap-drop ALL "$DIG")
yes "create (box/doop/build.sh: a stopped container to copy the source out of)" "create --pull=never --security-opt=no-new-privileges --name=mm-doop-mmt-cp" "${CREATE[@]}"
yes "create a box, the checks of run" "create --pull=never" create "${BOXRUN[@]:2}"
no "create with --privileged" create --privileged "${BOXRUN[@]:2}"
no "create -v /:/host" create -v /:/host "${BOXRUN[@]:2}"
no "create as root" create --name mm-doop-mmt-cp --label mm.project=mmt-cp --network none --user 0:0 --cap-drop ALL "$DIG"
no "create without a name (nothing mm could find again)" create --rm --network none --user 210000:"$G" --cap-drop ALL "$DIG"
no "create of an image that is not mm's" create --name mm-doop-mmt-cp --label mm.project=mmt-cp --network none --user 210000:"$G" --cap-drop ALL ubuntu:24.04
no "create with --network host" create --name mm-doop-mmt-cp --label mm.project=mmt-cp --network host --user 210000:"$G" --cap-drop ALL "$DIG"
yes "logs of mm's container, by its id" "logs --tail=50 --timestamps $(printf 'b%.0s' $(seq 64))" logs --tail 50 -t mm-box-acme-shop
yes "logs -f --since" "logs --follow --since=15m" logs -f --since 15m mm-doop-acme-shop
no "logs of dokploy" logs dokploy
no "logs of a name with no mm.project label" logs mm-box-nolabel
no "logs of a box labelled for another project" logs mm-box-other
no "logs --details" logs --details mm-box-acme-shop
no "logs --tail with a word" logs --tail 'all;id' mm-box-acme-shop
no "logs of two containers" logs mm-box-acme-shop mm-doop-acme-shop
yes "port (read)" "port mm-doop-acme-shop" port mm-doop-acme-shop
yes "port of one port" "port mm-doop-acme-shop 4400/tcp" port mm-doop-acme-shop 4400/tcp
no "port of dokploy-traefik" port dokploy-traefik
no "port with a word" port mm-doop-acme-shop 'x y'
yes "kill (doop-container: no clean stop)" "kill mm-doop-acme-shop" kill mm-doop-acme-shop
yes "kill -s TERM" "kill --signal=TERM" kill -s TERM mm-doop-acme-shop
no "kill dokploy" kill dokploy
no "kill -s STOP (not a stop mm uses)" kill -s STOP mm-doop-acme-shop
yes "images (read)" "images" images
yes "images --format, one name" "images --format=" images --format '{{.ID}}' mm-box
yes "images -q --filter dangling=true" "images --quiet --filter=dangling=true" images -q --filter dangling=true
no "images --filter of another kind" images --filter 'until=1h'
no "images of two names" images mm-box mm-egress
yes "rmi -f a test's image" "rmi --force mm-egress:test-1" rmi -f mm-egress:test-1
yes "rmi of two of mm's images" "rmi mm-doop:gwqa-1 mm-box:x" rmi mm-doop:gwqa-1 mm-box:x
no "rmi of another image (ubuntu)" rmi ubuntu:24.04
no "rmi of dokploy's" rmi -f dokploy/dokploy:latest
no "rmi by id (any image)" rmi "$DIG"
no "rmi by a short id" rmi 4062eea59e91
no "rmi of mm's and another" rmi mm-box:x traefik:v3.6.25
no "rmi -- an option-looking name" rmi -- --force
yes "rm -f of two (a test's cleanup)" "rm --force mm-box-acme-shop mm-egress-acme-shop" rm -f mm-box-acme-shop mm-egress-acme-shop
no "rm -f of mm's and dokploy" rm -f mm-box-acme-shop dokploy
yes "network rm of two" "network rm mm-net-acme-shop mm-doop-net-acme-shop" network rm mm-net-acme-shop mm-doop-net-acme-shop
no "network rm of mm's and dokploy-network" network rm mm-net-acme-shop dokploy-network
yes "network inspect bridge (its gateway: the host, as a box sees it)" "network inspect" network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'
yes "ps --filter label=mm.project --no-trunc" "ps --no-trunc --filter=label=mm.project=acme-shop" ps --no-trunc --filter label=mm.project=acme-shop

echo "== cp (sy-e6t3): the host and one of mm's containers with no mounts; the host side the project's own, as the owner"
F64=$(printf 'f%.0s' $(seq 64)); ONE64=$(printf '1%.0s' $(seq 64))
yes "cp out to - (a tar stream to the caller, box/doop/build.sh)" "cp $F64:/app/server -" cp mm-egress-acme-shop:/app/server -
yes "cp out into a folder of the project's" "cp $F64:/app/server -" cp mm-egress-acme-shop:/app/server "$PR/data"
if [ "$(cat "$PR/data/server/lib/a.js" 2>/dev/null)" = s ] && [ "$(stat -c %u "$PR/data/server/lib/a.js")" = "$U" ] && [ "$(readlink "$PR/data/server/link")" = lib/a.js ] \
  && [ "$(stat -c %a "$PR/data/server/suid")" = 755 ]; then ok "...written as the owner, the link kept, the setuid bit dropped"
else bad "cp out: what was written"; find "$PR/data/server" -printf '       %u %m %p\n'; fi
yes "cp out into a test's own folder" "cp $ONE64:/passwd -" cp mm-doop-mmt-cp:/passwd "$TR/mmt-cp/out"
[ "$(cat "$TR/mmt-cp/out/passwd" 2>/dev/null)" = p ] && ok "...it is there" || bad "cp out to the test's folder"
yes "cp -q" "cp --quiet" cp -q mm-egress-acme-shop:/passwd -
python3 -I - "$T/tars" "$TR/mmt-cp/in" <<'PY'
import io, os, sys, tarfile
d, src = sys.argv[1], sys.argv[2]; os.makedirs(d)
def mk(name, *members):
    with tarfile.open(os.path.join(d, name), 'w') as t:
        for m, data in members:
            t.addfile(m, io.BytesIO(data) if data is not None else None)
def f(n, data=b'x', mode=0o644, uid=1000):
    m = tarfile.TarInfo(n); m.size = len(data); m.mode = mode; m.uid = uid; return m, data
def k(n, t, link=''):
    m = tarfile.TarInfo(n); m.type = t; m.linkname = link; m.mode = 0o755; return m, None
mk('good.tar', k('sub', tarfile.DIRTYPE), f('sub/f'), f('sub/suid', mode=0o4755, uid=0), f('sub/sgid', mode=0o2775),
   k('sub/link', tarfile.SYMTYPE, '/etc/passwd'), k('sub/hard', tarfile.LNKTYPE, 'sub/f'))
mk('abs.tar', f('/etc/cron.d/x'))
mk('dotdot.tar', f('sub/../../x'))
mk('dev.tar', k('sda', tarfile.BLKTYPE))
mk('chr.tar', k('mem', tarfile.CHRTYPE))
mk('fifo.tar', k('p', tarfile.FIFOTYPE))
mk('hardout.tar', k('h', tarfile.LNKTYPE, '../../etc/shadow'))
mk('hardabs.tar', k('h', tarfile.LNKTYPE, '/etc/shadow'))
PY
# yesin/noin <desc> <stdin file> <args...>: as yes/no, the call reads the file
yesin() { local d=$1 f=$2; shift 2; : >"$T/calls"; rm -f "$T/cpin.tar"
  if out=$("$W" "$@" <"$f" 2>&1) && grep -q '^cp - ' "$T/calls"; then ok "$d"; else bad "$d"; echo "       exit/out: $out"; sed 's/^/       ran: /' "$T/calls"; fi; }
noin() { local d=$1 f=$2; shift 2; : >"$T/calls"
  out=$("$W" "$@" <"$f" 2>&1); rc=$?
  if [ $rc = 125 ] && grep -q refused <<<"$out" && [ ! -s "$T/calls" ]; then ok "$d  ($(sed 's/^mm-docker: refused: //' <<<"$out" | head -c 90))"
  else bad "$d (exit $rc)"; echo "       out: $out"; sed 's/^/       ran: /' "$T/calls"; fi; }
yesin "cp - into a container (a tar from the caller)" "$T/tars/good.tar" cp - mm-egress-acme-shop:/tmp
l=$(tar -tvf "$T/cpin.tar" 2>/dev/null)
if [ "$(grep -c . <<<"$l")" = 6 ] && ! grep -qE '^[^ ]*[sStT]' <<<"$l" && ! grep -qv ' root/root \| 0/0 ' <<<"$l"; then ok "...copied again: no setuid/setgid bits, owned by the container's root (links as links)"
else bad "cp in: the copy"; sed 's/^/       /' <<<"$l"; fi
yesin "cp a folder of the test's into a container (read as the owner)" /dev/null cp "$TR/mmt-cp/in" mm-doop-mmt-cp:/tmp
tar -tf "$T/cpin.tar" 2>/dev/null | grep -qx 'in/sub/f' && ok "...the folder, by its name" || { bad "cp in from a folder"; tar -tf "$T/cpin.tar" | sed 's/^/       /'; }
yesin "cp a file of the project's into a container" /dev/null cp "$PR/data/h" mm-egress-acme-shop:/tmp
noin "cp - with an absolute name in the tar" "$T/tars/abs.tar" cp - mm-egress-acme-shop:/tmp
noin "cp - with ../ in a name" "$T/tars/dotdot.tar" cp - mm-egress-acme-shop:/tmp
noin "cp - with a block device" "$T/tars/dev.tar" cp - mm-egress-acme-shop:/tmp
noin "cp - with a char device" "$T/tars/chr.tar" cp - mm-egress-acme-shop:/tmp
noin "cp - with a named pipe" "$T/tars/fifo.tar" cp - mm-egress-acme-shop:/tmp
noin "cp - with a hard link out of the copy (../)" "$T/tars/hardout.tar" cp - mm-egress-acme-shop:/tmp
noin "cp - with a hard link to an absolute path" "$T/tars/hardabs.tar" cp - mm-egress-acme-shop:/tmp
printf 'not a tar' >"$T/tars/junk"
noin "cp - with what is not a tar" "$T/tars/junk" cp - mm-egress-acme-shop:/tmp
no "cp into a container that has mounts (CVE-2018-15664)" cp "$PR/data/h" mm-box-acme-shop:/tmp
no "cp out of a container that has mounts" cp mm-doop-acme-shop:/app/data -
no "cp when docker's answer has no mount count" cp mm-box-acme-badmounts:/x -
no "cp out to a host path outside the project" cp mm-egress-acme-shop:/etc/passwd /tmp
no "cp out to the owner's home" cp mm-egress-acme-shop:/etc/passwd "$H"
no "cp out to another project's folder" cp mm-egress-acme-shop:/etc/passwd "$MM/projects/acme/other"
no "cp out through a symlink in the project to outside" cp mm-egress-acme-shop:/etc/passwd "$PR/evil"
no "cp out through a symlink in the test's folder" cp mm-doop-mmt-cp:/passwd "$TR/mmt-cp/evil"
no "cp out to a test folder without the prefix" cp mm-doop-mmt-cp:/passwd "$TR/nopfx"
no "cp out to another test's folder" cp mm-doop-mmt-cp:/passwd "$TR/mmt-two"
no "cp out to a path that is not there (a folder only)" cp mm-egress-acme-shop:/etc/passwd "$PR/data/newname"
no "cp out onto a file" cp mm-egress-acme-shop:/etc/passwd "$PR/data/h"
no "cp out to a relative host path" cp mm-egress-acme-shop:/etc/passwd data
no "cp in from a host file outside" cp "$T/outside/secret" mm-egress-acme-shop:/tmp
no "cp in from a symlink to outside" cp "$PR/evil" mm-egress-acme-shop:/tmp
no "cp in from /etc/shadow" cp /etc/shadow mm-egress-acme-shop:/tmp
no "cp in from another project" cp "$MM/projects/acme/other/.mm-answers.yaml" mm-egress-acme-shop:/tmp
no "cp between two containers" cp mm-egress-acme-shop:/etc/passwd mm-doop-mmt-cp:/tmp
no "cp from - to -" cp - -
no "cp of dokploy" cp dokploy:/etc/dokploy -
no "cp of a name with no mm.project label" cp mm-box-nolabel:/etc/passwd -
no "cp of a box labelled for another project" cp mm-box-other:/etc/passwd -
no "cp of a container that is not there" cp mm-box-ghost:/etc/passwd -
no "cp -a (keeps the tar's owners)" cp -a - mm-egress-acme-shop:/tmp
no "cp -L (follows links on the host)" cp -L "$PR/data/h" mm-egress-acme-shop:/tmp
no "cp --archive" cp --archive mm-egress-acme-shop:/etc/passwd -
no "cp with a relative path in the container" cp mm-egress-acme-shop:etc/passwd -
no "cp with a newline in the container path" cp "mm-egress-acme-shop:/etc
/passwd" -
no "cp with three paths" cp mm-egress-acme-shop:/a - -

echo "== the test area: <test_root>/<test_prefix><name>/ is the throwaway project <name>"
TONE=(--rm --network none --user 200040:"$G" --cap-drop ALL)
yes "a test's own folder mounted (its label)" "--volume=$TR/mmt-cp/in:/x" run -d --name mm-box-mmt-cp --label mm.project=mmt-cp --user 200040:"$G" --cap-drop ALL -v "$TR/mmt-cp/in:/x" "$IMG"
no "a test's folder in another project's container" run -d --name mm-box-mmt-two --label mm.project=mmt-two --user 200040:"$G" --cap-drop ALL -v "$TR/mmt-cp/in:/x" "$IMG"
no "a test folder without the prefix" run "${TONE[@]}" -v "$TR/nopfx:/x" "$IMG"
no "the test root itself" run "${TONE[@]}" -v "$TR:/x" "$IMG"
no "a symlink in the test's folder to outside" run "${TONE[@]}" -v "$TR/mmt-cp/evil:/x" "$IMG"
for bad_conf in "test_root = /" "test_root = /tmp" "test_root = $H" "test_root = $MM/.." "test_root = $MM" "test_root = $MM/projects/acme" "test_prefix = x" "test_prefix = MM-" "test_prefix = a b-" "env_file = name"; do
  { grep -v '^test_' "$T/conf"; printf '%s\n' "$bad_conf"; [[ $bad_conf != test_prefix* ]] || echo "test_root = $TR"; } >"$T/bad.conf"
  : >"$T/calls"; out=$(MM_DOCKER_CONF="$T/bad.conf" "$W" ps 2>&1); rc=$?
  [ $rc = 125 ] && [ ! -s "$T/calls" ] && ok "config '$bad_conf' is refused ($(sed 's/^mm-docker: refused: //' <<<"$out" | head -c 70))" || bad "config '$bad_conf' (exit $rc: $out)"
done
grep -v '^test_' "$T/conf" >"$T/notest.conf"
: >"$T/calls"; out=$(MM_DOCKER_CONF="$T/notest.conf" "$W" run "${TONE[@]}" -v "$TR/mmt-cp/in:/x" "$IMG" 2>&1); rc=$?
[ $rc = 125 ] && [ ! -s "$T/calls" ] && ok "no test_root: a test's folder is outside, like any other" || bad "no test_root (exit $rc: $out)"

echo "== build: mm's folder only, copied as checked, mm's tags only"
B="$T/mm-box-build-abc123"; mkdir -p "$B/npm"; echo 'FROM scratch' >"$B/Dockerfile"; echo '{}' >"$B/npm/package.json"; chmod 700 "$B"
yes "build (as mm box build)" "Dockerfile ./npm/package.json" build -q -t "$IMG" -f "$B/Dockerfile" --build-arg "UID=$U" --build-arg "HOME_DIR=$H" "$B"
yes "build: docker reads a copy, not the owner's folder" "--file=/" build -q -t "$EG" -f "$B/Dockerfile" "$B"
if grep -qF -- "$B" "$T/calls"; then bad "build: the owner's folder never reaches docker"; else ok "build: the owner's folder never reaches docker"; fi
no "build -t over another image (dokploy)" build -q -t dokploy/dokploy:latest -f "$B/Dockerfile" "$B"
no "build -t traefik" build -t traefik:v3.6.25 "$B"
no "build -o (writes host files)" build -o type=local,dest=/etc -t "$IMG" "$B"
no "build --output" build --output=/tmp/x -t "$IMG" "$B"
no "build --iidfile" build --iidfile /etc/x -t "$IMG" "$B"
no "build --secret" build --secret id=a,src=/etc/passwd -t "$IMG" "$B"
no "build --build-context" build --build-context root=/ -t "$IMG" "$B"
no "build --allow security.insecure" build --allow security.insecure -t "$IMG" "$B"
no "build --network host" build --network host -t "$IMG" "$B"
no "build --cache-from local" build --cache-from type=local,src=/ -t "$IMG" "$B"
no "build --build-arg other" build --build-arg X=1 -t "$IMG" "$B"
yes "build mm-doop (box/doop/build.sh: BASE, one of mm's images)" "--tag=mm-doop:gwqa-1 --build-arg=BASE=mm-doop:0.12.0" build -q -t mm-doop:gwqa-1 --build-arg BASE=mm-doop:0.12.0 "$B"
yes "build --build-arg BASE by digest" "--build-arg=BASE=$DIG" build -q -t mm-doop:gwqa-1 --build-arg "BASE=$DIG" "$B"
no "build --build-arg BASE of another image" build -t mm-doop:gwqa-1 --build-arg BASE=ubuntu:24.04 "$B"
no "build -t mm-doop-gw-qa (not mm's name)" build -t mm-doop-gw-qa:1 "$B"
no "build --build-arg UID=0" build --build-arg UID=0 -t "$IMG" "$B"
no "build of / " build -t "$IMG" /
no "build of a folder not mm's (the home)" build -t "$IMG" "$H"
no "build -f outside the folder" build -t "$IMG" -f /etc/passwd "$B"
no "build -f ../ out of the folder" build -t "$IMG" -f "$B/../conf" "$B"
no "build from a URL" build -t "$IMG" https://example.com/x.git
no "build from stdin" build -t "$IMG" -
mkdir -p "$T/mm-box-build-link"; echo 'FROM scratch' >"$T/mm-box-build-link/Dockerfile"; ln -s "$T/outside/secret" "$T/mm-box-build-link/s"
no "build: a symlink in the folder" build -t "$IMG" "$T/mm-box-build-link"
ln -s "$B" "$T/mm-box-build-viasym"
yes "build: the folder through a symlink is its real one" - build -t "$IMG" "$T/mm-box-build-viasym"
mkdir -p "$T/mm-box-build-wide"; echo 'FROM scratch' >"$T/mm-box-build-wide/Dockerfile"; chmod 777 "$T/mm-box-build-wide"
no "build: a folder others can write" build -t "$IMG" "$T/mm-box-build-wide"

echo "== the config and the caller"
: >"$T/calls"; out=$(env -u MM_DOCKER_CONF "$W" ps 2>&1); rc=$?
[ $rc = 125 ] && [ ! -s "$T/calls" ] && ok "no config: refused ($out)" || bad "no config (exit $rc: $out)"
printf 'docker = %s\nmm_home = /\n' "$T/docker" >"$T/wide.conf"
: >"$T/calls"; out=$(MM_DOCKER_CONF="$T/wide.conf" "$W" ps 2>&1); rc=$?
[ $rc = 125 ] && [ ! -s "$T/calls" ] && ok "mm_home = / is refused as too wide" || bad "mm_home = / (exit $rc: $out)"
cat >"$T/docker-env" <<'EOF'
#!/usr/bin/env bash
env >"$(dirname "$0")/env"
EOF
chmod 755 "$T/docker-env"; sed "s|^docker = .*|docker = $T/docker-env|" "$T/conf" >"$T/env.conf"
DOCKER_HOST=tcp://evil:2375 DOCKER_CONFIG=/tmp/evil DOCKER_CONTEXT=evil LD_PRELOAD=/tmp/evil.so MM_DOCKER_CONF="$T/env.conf" "$W" ps >/dev/null 2>&1
if [ -s "$T/env" ] && ! grep -qE '^(DOCKER_|LD_PRELOAD)' "$T/env"; then ok "docker gets a clean environment (no DOCKER_HOST, DOCKER_CONFIG, DOCKER_CONTEXT, LD_PRELOAD)"
else bad "docker's environment"; cat "$T/env" 2>/dev/null | grep -E '^(DOCKER_|LD_)' | sed 's/^/       /'; fi

echo "== mm's own code through the wrapper (bun src/cli.ts box build, a throwaway MM_HOME)"
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
if [ -x "$BUN" ]; then
  : >"$T/calls"; mkdir -p "$T/mmhome"
  out=$(cd "$HERE" && MM_HOME="$T/mmhome" MM_DOCKER="$W" "$BUN" src/cli.ts box build 2>&1); rc=$?
  if [ $rc = 0 ] && [ "$(grep -c '^build ' "$T/calls")" = 2 ] && grep -q 'Dockerfile' "$T/calls" && grep -q 'egress.Dockerfile' "$T/calls"; then ok "mm box build: both images, through the wrapper"
  else bad "mm box build (exit $rc)"; echo "$out" | tail -5 | sed 's/^/       /'; sed 's/^/       ran: /' "$T/calls"; fi
else echo "  skip mm box build (no bun)"; fi

echo; echo "mm-docker: $pass passed, $fail failed"
[ "$fail" = 0 ]
