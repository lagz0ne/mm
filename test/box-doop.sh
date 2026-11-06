#!/usr/bin/env bash
# A box project's Doop on the host (sy-wo7y), hermetic: a throwaway HOME / MM_HOME, a box project (its folder only, no
# container), stand-ins for Docker and the host's process manager. Proves:
#  1. the box's own process file: no doop-run in the box; its doop is only a name (portless) to /run/mm/doop/doop.sock,
#     with no public side in the box
#  2. the host's file for the box: <project>-public.doop runs the project's sealed bin/doop-run with DOOP_HOME (mm's
#     folder for the box), the box's socket, the key's way to the box's secrets, and the public port; a bin/doop-run that
#     is not as mm sealed it is never run on the host; nor while its data is still in the project
#  3. doopIn (once, the box stopped): data/doop/ moves to the host's folder with its account (domain and password); the
#     auth secret is never taken; a data/doop that is a link is refused (the link stays, nothing is followed); a password
#     file that is a link is not read; a domain that isn't Doop's shape is not taken; a second time: nothing moves
#  4. doopOut (box off, archive): the data back in data/doop/, the secrets in secrets/; what the box left at data/doop is
#     moved aside; a link the box left in secrets/ is removed, never written through
#  5. landBackup: the box's backup lands, and the host's doop-run adds doop.tar.gz from the host's folder (0600)
#  6. mm up: the box mounts only the socket's folder (read-only, at /run/mm/doop), only while Doop is on; off: the
#     key's copy goes from the box's secrets
#  7. doop-run's host mode refuses what isn't plain (DOOP_HOME, DOOP_PROJECT, DOOP_BOX_SOCKET) and a data link
#   test/box-doop.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -3 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept: $T" || rm -rf "$T"' EXIT
export T HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null MM_SECRETS_DIR="$T/run-secrets" DOOP_BACKUP_WAIT=1
unset PASEO_AGENT_ID PASEO_AGENT_CWD CLAUDECODE MM_API_ENABLED MM_API_DIR
mkdir -p "$MM_HOME/pc/boxes" "$T/bin"
# only this test's stand-ins: never the machine's Docker or process manager
export PATH="$T/bin:$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin"
cat >"$T/bin/fakedocker" <<'EOF'
#!/bin/sh
echo "$*" >> "$T/docker.log"
case "$*" in
  "container inspect"*|"inspect mm-doop-"*|"network inspect"*) echo "Error: No such object" >&2; exit 1 ;;
esac
case "$1" in
  inspect) case "$*" in *State.Running*) echo true ;; *IPAddress*) echo 10.231.5.10 ;; *) echo '[]' ;; esac ;;
esac
exit 0
EOF
printf '#!/bin/sh\necho "$*" >>"$T/pc.log"\necho "[]"\n' >"$T/bin/process-compose"
chmod +x "$T/bin/fakedocker" "$T/bin/process-compose"; export MM_DOCKER="$T/bin/fakedocker"
printf 'access: domain\ndomain: example.test\nbind_host: 127.0.0.1\n' >"$MM_HOME/config.yaml"
R="$HOME/projects/acme/shop"; mkdir -p "$R/bin/lib" "$R/data/doop/pg" "$R/secrets"
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: as\nroot: %s\ntemplate_version: test\ncreated: "2026-01-01"\nthrowaway: true\nbox: true\nservices_on: [doop]\n' "$R" >"$R/.mm-answers.yaml"
cp "$SRC/template/bin/doop-run" "$R/bin/"; cp "$SRC/template/bin/lib/doop-init.mjs" "$R/bin/lib/"
sed -n '/^services:/,/^schedules:/p' "$SRC/template/services.yaml" | sed '/^schedules:/d' | sed 's/{{name}}/shop/; s/{{client}}/acme/' | awk '/^  [a-z-]+:$/ { keep = ($1 == "board:" || $1 == "doop:") } /^services:/ || keep' >"$R/services.yaml"
echo 'pg data' >"$R/data/doop/pg/PG_VERSION"
printf 'old-auth-secret' >"$R/secrets/doop-auth-secret"; printf 'abc123.doop.invalid' >"$R/secrets/doop-signup-domain"; printf 'Pw_0123456789abcdefXYZ' >"$R/secrets/doop-password"
echo "# from $R/services.yaml" >"$MM_HOME/pc/boxes/acme-shop.yaml"
H="$MM_HOME/box/acme-shop"; DH="$H/doop"; PCY="$H/cfg/pc.yaml"; PUB="$MM_HOME/pc/box-public/acme-shop.yaml"
cat >"$T/w.ts" <<EOF
import { appReload, doopIn, doopOut, landBackup, backupStage, up } from '$SRC/src/box'
import { sealEngine } from '$SRC/src/project'
const [what] = process.argv.slice(2), root = '$R'
const out = (x: unknown) => console.log(JSON.stringify(x))
if (what === 'seal') sealEngine(root)
if (what === 'reload') out(appReload(root))
if (what === 'in') out(doopIn(root))
if (what === 'out') out(doopOut(root))
if (what === 'land') console.log(landBackup(root))
if (what === 'up') out(up(root))
if (what === 'stage') console.log(backupStage(root))
EOF
mm() { bun "$T/w.ts" "$@"; }
proc() { bun -e "const y = Bun.YAML.parse(await Bun.file(process.argv[1]).text()); console.log(JSON.stringify(y.processes[process.argv[2]] ?? null))" "$1" "$2"; }
envof() { proc "$1" "$2" | jq -r '.environment[]?'; }
export -f mm proc envof; export R H DH PCY PUB

echo "== 1-2. the box's file and the host's (the engine sealed as mm put it)"
mm seal
check "the data still in data/doop/: the host's Doop is not started (no new empty Doop)" sh -c "mm reload | jq -e '.[] | select(.step == \"doop\" and .status == \"fail\") | .detail | test(\"still in data/doop\")' && [ \"\$(proc '$PUB' acme-shop-public.doop)\" = null ]"
check "doopIn: data/doop/ moves to the host's folder" sh -c "mm in | jq -e '.status == \"ok\"' && [ -f '$DH/data/pg/PG_VERSION' ] && ! [ -e '$R/data/doop' ]"
check "...with its account (domain, password); never the old auth secret" sh -c "[ \"\$(cat '$DH/secrets/doop-signup-domain')\" = abc123.doop.invalid ] && [ -s '$DH/secrets/doop-password' ] && ! [ -e '$DH/secrets/doop-auth-secret' ] && [ \"\$(stat -c %a '$DH/secrets')\" = 700 ]"
check "a second time: nothing to move" sh -c "[ \"\$(mm in)\" = null ]"
mm reload >"$T/reload.json"
check "the reload: no failed step" sh -c "! jq -e '.[] | select(.status == \"fail\")' '$T/reload.json'"
check "the box: no doop-run in its file" sh -c "! grep -q 'doop-run' '$PCY'"
check "the box's doop: its name to the socket (/run/mm/doop/doop.sock), on its loopback" sh -c "proc '$PCY' acme-shop.doop | jq -r .command | grep -q 'portless doop.acme-shop --force .*socat TCP-LISTEN:\\\$\\\$PORT,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/mm/doop/doop.sock'"
check "...no public side in the box (no doop-public, no DOOP_PUBLIC_PORT)" sh -c "[ \"\$(proc '$PCY' acme-shop.doop-public)\" = null ] && ! envof '$PCY' acme-shop.doop | grep -q DOOP_PUBLIC_PORT"
check "the host: <project>-public.doop runs the project's bin/doop-run" sh -c "[ \"\$(proc '$PUB' acme-shop-public.doop | jq -r .command)\" = '$R/bin/doop-run' ]"
check "...with DOOP_HOME (mm's folder for the box), its project, the box's socket and the key's way to the box" sh -c "e=\$(envof '$PUB' acme-shop-public.doop); echo \"\$e\" | grep -qx 'DOOP_HOME=$DH' && echo \"\$e\" | grep -qx 'DOOP_PROJECT=acme-shop' && echo \"\$e\" | grep -qx 'DOOP_BOX_SOCKET=$H/doop-sock/doop.sock' && echo \"\$e\" | grep -qx 'DOOP_AGENT_KEY_TO=$T/run-secrets/acme-shop/doop-agent-key'"
check "...its public port (the gateway's side) and the URL the box uses" sh -c "e=\$(envof '$PUB' acme-shop-public.doop); echo \"\$e\" | grep -qE '^DOOP_PUBLIC_PORT=[0-9]+\$' && echo \"\$e\" | grep -qE '^DOOP_URL=http://doop.acme-shop.localhost:[0-9]+\$'"
check "...bind_host on loopback: no second forwarder for Doop's public side (doop-run listens there)" sh -c "[ \"\$(proc '$PUB' acme-shop-public.doop-public)\" = null ]"
check "...endpoints.json in DOOP_HOME (docker, image), not the project's .run/" sh -c "jq -e '.containers.docker == \"$T/bin/fakedocker\" and (.containers.doop_image | test(\"sha256:\"))' '$DH/endpoints.json'"
check "...the socket's folder 0750, the host port kept in a file (the same one at the next up)" sh -c "[ \"\$(stat -c %a '$H/doop-sock')\" = 750 ] && p1=\$(cat '$DH/port') && mm reload >/dev/null && [ \"\$(cat '$DH/port')\" = \"\$p1\" ] && envof '$PUB' acme-shop-public.doop | grep -qx \"PORT=\$p1\""
cp "$R/bin/doop-run" "$T/doop-run.orig"; echo '# the box wrote this' >>"$R/bin/doop-run"
check "a bin/doop-run that isn't as mm sealed it: not run on the host" sh -c "mm reload | jq -e '.[] | select(.step == \"doop\" and .status == \"fail\") | .detail | test(\"bin/doop-run\")' && [ \"\$(proc '$PUB' acme-shop-public.doop)\" = null ]"
cp "$T/doop-run.orig" "$R/bin/doop-run"; mm reload >/dev/null
sed -i 's/^services_on: \[doop\]$/services_on: []/' "$R/.mm-answers.yaml"
check "doop off: neither in the box nor on the host" sh -c "mm reload >/dev/null; [ \"\$(proc '$PCY' acme-shop.doop)\" = null ] && [ \"\$(proc '$PUB' acme-shop-public.doop 2>/dev/null || echo null)\" = null ]"
sed -i 's/^services_on: \[\]$/services_on: [doop]/' "$R/.mm-answers.yaml"

echo "== 3. what the box may have planted, before the move"
rm -rf "$DH"; mkdir -p "$T/elsewhere"; echo secret >"$T/elsewhere/owner-file"
ln -s "$T/elsewhere" "$R/data/doop"
check "data/doop a link: refused, the link stays, nothing moved or followed" sh -c "mm in | jq -e '.status == \"fail\"' && [ -L '$R/data/doop' ] && ! [ -e '$DH/data' ] && [ -f '$T/elsewhere/owner-file' ]"
rm "$R/data/doop"; mkdir -p "$R/data/doop"; rm -f "$R/secrets/doop-password"; ln -s "$T/elsewhere/owner-file" "$R/secrets/doop-password"
printf 'evil\nNODE_OPTIONS=--require=/x' >"$R/secrets/doop-signup-domain"
check "a password file that is a link is not read; a domain not of Doop's shape is not taken" sh -c "mm in | jq -e '.status == \"ok\"' && ! [ -e '$DH/secrets/doop-password' ] && ! [ -e '$DH/secrets/doop-signup-domain' ]"

echo "== 4. doopOut: back into the project"
printf 'k' >"$DH/secrets/doop-agent-key"; printf 'pw-host' >"$DH/secrets/doop-password"; echo db >"$DH/data/PG_VERSION"
mkdir -p "$R/data/doop"; echo box >"$R/data/doop/planted"   # the box made a data/doop again
rm -f "$R/secrets/doop-password"; ln -s "$T/elsewhere/owner-file" "$R/secrets/doop-password"
check "the data back in data/doop/, what the box left there moved aside" sh -c "mm out | jq -e '.[0].status == \"ok\"' && [ -f '$R/data/doop/PG_VERSION' ] && ls -d '$R'/data/doop.box-* >/dev/null && [ -f \"\$(ls -d '$R'/data/doop.box-*)/planted\" ]"
check "...the secrets in secrets/ (0600), through no link: the link's target is untouched" sh -c "[ \"\$(cat '$R/secrets/doop-password')\" = pw-host ] && ! [ -L '$R/secrets/doop-password' ] && [ \"\$(stat -c %a '$R/secrets/doop-agent-key')\" = 600 ] && [ \"\$(cat '$T/elsewhere/owner-file')\" = secret ]"
check "...mm's folder for the box's Doop and its socket folder are gone" sh -c "! [ -e '$DH' ] && ! [ -e '$H/doop-sock' ]"

echo "== 5. the box's backup lands, with Doop's from the host"
rm -rf "$R/data/doop.box-"*; mm in >/dev/null; mm reload >/dev/null
ST=$(mm stage); mkdir -p "$ST/2026-11-06T0330Z"; echo '{}' >"$ST/2026-11-06T0330Z/board.jsonl"
check "landBackup: the dated folder lands, with doop.tar.gz (0600) from the host's folder" sh -c "mm land | grep -q ', doop\$' && B=\$(bun -e \"import { DIRS } from '$SRC/src/env'; console.log(DIRS.backups)\")/acme-shop/2026-11-06T0330Z && [ -f \"\$B/board.jsonl\" ] && [ \"\$(stat -c %a \"\$B/doop.tar.gz\")\" = 600 ] && tar -tzf \"\$B/doop.tar.gz\" | grep -qx 'doop/PG_VERSION' && ! tar -tzf \"\$B/doop.tar.gz\" | grep -qv '^doop'"

echo "== 6. mm up of the box (stand-in Docker): the socket's folder, read-only, only with Doop on"
mm up >"$T/up.json" 2>&1
runline() { grep '^run -d --name mm-box-acme-shop ' "$T/docker.log" | tail -1; }
export -f runline
check "the box gets $H/doop-sock at /run/mm/doop, read-only" sh -c "runline | grep -q -- '-v $H/doop-sock:/run/mm/doop:ro'"
check "...and no other folder of the box's Doop (not doop/, not its data)" sh -c "! runline | grep -qE -- '$DH(:|/)'"
check "...its key is in the box's secrets folder only by doop-run's copy (none yet)" sh -c "! [ -e '$T/run-secrets/acme-shop/doop-agent-key' ]"
touch "$T/run-secrets/acme-shop/doop-agent-key"; sed -i 's/^services_on: \[doop\]$/services_on: []/' "$R/.mm-answers.yaml"
mm up >"$T/up2.json" 2>&1
check "Doop off: no socket folder in the box, and its key goes from the box's secrets" sh -c "! runline | grep -q doop-sock && ! [ -e '$T/run-secrets/acme-shop/doop-agent-key' ]"
sed -i 's/^services_on: \[\]$/services_on: [doop]/' "$R/.mm-answers.yaml"

echo "== 7. doop-run's host mode refuses what isn't plain"
run6() { env -i PATH="$PATH" T="$T" "$@" "$R/bin/doop-run" release; }
export -f run6
check "DOOP_HOME without DOOP_PROJECT" sh -c "! run6 DOOP_HOME='$DH'"
check "a DOOP_HOME that isn't plain" sh -c "! run6 DOOP_HOME='$DH;x' DOOP_PROJECT=acme-shop"
check "a DOOP_BOX_SOCKET not <folder>/doop.sock" sh -c "! run6 DOOP_HOME='$DH' DOOP_PROJECT=acme-shop DOOP_BOX_SOCKET=/tmp/other"
mv "$DH/data" "$DH/data.real"; ln -s "$DH/data.real" "$DH/data"
check "DOOP_HOME/data a link: refused" sh -c "run6 DOOP_HOME='$DH' DOOP_PROJECT=acme-shop 2>&1 | grep -q 'is a link'"
rm "$DH/data"; mv "$DH/data.real" "$DH/data"
check "the plain case: release runs (no Doop left)" run6 DOOP_HOME="$DH" DOOP_PROJECT=acme-shop

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
