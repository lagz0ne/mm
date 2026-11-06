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

echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
