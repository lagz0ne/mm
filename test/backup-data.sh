#!/usr/bin/env bash
# template bin/backup's app data and modes (pg-82r), hermetic: a throwaway project with stand-ins for Dolt and bd. The
# app's release/data/ is copied (not its *.tmp files), and the backup is user-only (dirs 0700, files 0600).
#   test/backup-data.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then printf '  \033[32mok\033[0m   %s\n' "$d"; pass=$((pass+1)); else printf '  \033[31mFAIL\033[0m %s\n' "$d"; fail=$((fail+1)); fi; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
P="$T/acme/shop"; mkdir -p "$P/bin" "$P/tools" "$P/control/.beads" "$P/.run" "$P/release/data/users"
cp "$SRC/template/bin/backup" "$P/bin/backup"
printf 'project: acme-shop\n' >"$P/.mm-answers.yaml"
printf '{"dolt_port": 1}\n' >"$P/.run/services.json"; printf '{"dolt_database": "beads"}\n' >"$P/control/.beads/metadata.json"
printf '#!/bin/sh\nexit 0\n' >"$P/tools/dolt"
printf '#!/bin/sh\n[ "$1" = export ] && { [ "${4:-}" ] && echo "{}" > "$4" || echo "{}"; }\nexit 0\n' >"$P/bin/bd"
chmod +x "$P/tools/dolt" "$P/bin/bd" "$P/bin/backup"
git -C "$P" init -q; git -C "$P" -c user.name=t -c user.email=t@t commit -q --allow-empty -m x
umask 022
echo '{"todos":[]}' >"$P/release/data/todos.json"; echo 'hash' >"$P/release/data/users/alex.json"; echo partial >"$P/release/data/todos.json.tmp"
chmod 644 "$P/release/data/todos.json"

echo "== a backup of a project whose app keeps data"
OUT=$(MM_TRACE_SELF="$P/bin/backup" BACKUP_DIR="$T/bk" "$P/bin/backup" 2>&1); RC=$?
check "it runs (exit 0)" [ "$RC" = 0 ]
D=$(ls -1d "$T/bk"/20*/ 2>/dev/null | head -1)
check "the app's data is in <backup>/data/, sub-folders too" sh -c "cmp -s '$P/release/data/todos.json' '${D}data/todos.json' && cmp -s '$P/release/data/users/alex.json' '${D}data/users/alex.json'"
check "...but not its *.tmp write files" test ! -e "${D}data/todos.json.tmp"
check "the summary counts the data files (2)" sh -c "echo '$OUT' | grep -q ', 2 data files'"
check "the backup root is 0700" sh -c "[ \$(stat -c %a '$T/bk') = 700 ]"
check "every folder in it is 0700, every file 0600 (whatever the source's modes)" sh -c "! find '$T/bk' -mindepth 1 -type d ! -perm 700 | grep -q . && ! find '$T/bk' -type f ! -perm 600 | grep -q ."
echo "== a project with no app data"
rm -rf "$P/release"
OUT=$(MM_TRACE_SELF="$P/bin/backup" BACKUP_DIR="$T/bk2" "$P/bin/backup" 2>&1); RC=$?
check "it runs, with no data/ folder and 0 data files" sh -c "[ $RC = 0 ] && ! ls -d '$T/bk2'/20*/data >/dev/null 2>&1 && echo '$OUT' | grep -q ', 0 data files'"

echo "== its Doop, through bin/doop-run and a docker stand-in (sy-bey8)"
# the stand-in: `container inspect` answers line n of $T/dk/state at its n-th call (then the last line again; "none":
# no such container, "down": the daemon fails); `exec` runs the host's tar over data/doop/, or fails as $T/dk/exec says
cp "$SRC/template/bin/doop-run" "$P/bin/doop-run"; chmod +x "$P/bin/doop-run"
mkdir -p "$P/data/doop/pg" "$T/dk"; echo canvas >"$P/data/doop/pg/canvas"
cat >"$T/dk/docker" <<EOF
#!/bin/sh
case "\$1" in
  container) n=\$(cat "$T/dk/n" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n >"$T/dk/n"
    s=\$(sed -n "\${n}p" "$T/dk/state"); [ -n "\$s" ] || s=\$(tail -1 "$T/dk/state")
    case "\$s" in none) echo "Error: No such container: mm-doop-acme-shop" >&2; exit 1 ;; down) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;; esac
    echo "\$s 2026-11-06T13:00:00Z" ;;
  exec) case "\$(cat "$T/dk/exec" 2>/dev/null)" in
      daemon) echo "Error response from daemon: container 0123 is not running" >&2; exit 1 ;;
      tar) echo "tar: data/pg/canvas: Cannot open: Permission denied" >&2; exit 2 ;;
    esac
    exec tar -czf - -C "$P/data" doop ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/dk/docker"; printf '{"containers":{"docker":"%s"}}\n' "$T/dk/docker" >"$P/.run/endpoints.json"
printf 'project: acme-shop\nservices_on: [doop]\n' >"$P/.mm-answers.yaml"
# bk <case> <state lines> <exec mode>: one backup with DOOP_BACKUP_WAIT=2; its stdout in $OUT, stderr in $T/err-<case>,
# exit in $RC, folder in $D
bk() { rm -f "$T/dk/n"; printf '%s\n' $2 >"$T/dk/state"; printf '%s' "$3" >"$T/dk/exec"
  OUT=$(DOOP_BACKUP_WAIT=2 MM_TRACE_SELF="$P/bin/backup" BACKUP_DIR="$T/bk-$1" "$P/bin/backup" 2>"$T/err-$1"); RC=$?
  D=$(ls -1d "$T/bk-$1"/20*/ 2>/dev/null | head -1); }
bk run running ""
check "running: doop.tar.gz from the exec, exit 0, nothing skipped" sh -c "[ $RC = 0 ] && tar -tzf '${D}doop.tar.gz' | grep -qx 'doop/pg/canvas' && ! echo '$OUT' | grep -q skipped"
bk restart "restarting running" ""
check "restarting, then running: waited for, doop.tar.gz is there" sh -c "[ $RC = 0 ] && tar -tzf '${D}doop.tar.gz' | grep -qx 'doop/pg/canvas' && ! echo '$OUT' | grep -q skipped"
bk stays restarting ""
check "restarting for good: exit 0, the summary says doop skipped and why" sh -c "[ $RC = 0 ] && echo '$OUT' | grep -q ', doop skipped: its container is restarting\$'"
check "...a warn line on stderr" grep -q '^backup: warn: doop skipped: its container is restarting' "$T/err-stays"
check "...no doop.tar.gz (never a half one), the rest is there" sh -c "[ ! -e '${D}doop.tar.gz' ] && [ -s '${D}board.jsonl' ] && [ -s '${D}config.bundle' ]"
check "...after about DOOP_BACKUP_WAIT seconds (3 looks, 1 s apart)" [ "$(cat "$T/dk/n")" = 3 ]
bk daemon running daemon
check "the exec fails with a docker error: doop skipped, exit 0" sh -c "[ $RC = 0 ] && echo '$OUT' | grep -q ', doop skipped: the exec into its container failed: Error response from daemon: container 0123 is not running'"
bk down down ""
check "docker itself fails: doop skipped, exit 0" sh -c "[ $RC = 0 ] && echo '$OUT' | grep -q ', doop skipped: docker: Cannot connect to the Docker daemon'"
bk tar running tar
check "Doop's own tar fails in a steady container: a real error, the backup fails, with tar's message" sh -c "[ $RC != 0 ] && grep -q 'Cannot open: Permission denied' '$T/err-tar'"
bk gone none ""
check "on, but no container for good: the host's tar after the wait (as when it is off)" sh -c "[ $RC = 0 ] && tar -tzf '${D}doop.tar.gz' | grep -qx 'doop/pg/canvas' && [ \$(cat '$T/dk/n') = 3 ]"
printf 'project: acme-shop\n' >"$P/.mm-answers.yaml"
bk off none ""
check "off, no container: the host's tar at once" sh -c "[ $RC = 0 ] && tar -tzf '${D}doop.tar.gz' | grep -qx 'doop/pg/canvas' && [ \$(cat '$T/dk/n') = 1 ]"
bk off-left exited ""
check "off, a container left over (exited): the host's tar at once" sh -c "[ $RC = 0 ] && tar -tzf '${D}doop.tar.gz' | grep -qx 'doop/pg/canvas' && [ \$(cat '$T/dk/n') = 1 ]"
printf '#!/bin/sh\nexit 3\n' >"$P/bin/doop-run"
bk broken running ""
check "a doop-run that fails another way (exit 3): the backup fails with it" [ "$RC" = 3 ]

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
