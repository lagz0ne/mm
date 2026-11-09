#!/usr/bin/env bash
# A box's schedules (sy-6n9w), hermetic: a throwaway HOME / MM_HOME, no Docker (MM_DOCKER is a stub that records what
# it was asked to run). A box has no scheduler of its own: the machine's `mm cron` (on the host's process manager)
# runs the box's jobs in the box, as the box user, and logs them on the host.
# Proves:
#  1. the host's process manager runs mm.cron (its base file)
#  2. mm cron's jobs include the box's health job (every 1m), read from its services.yaml
#  3. one run of it: `docker exec` into the box, in the project's folder, with HEALTH_STATE under .run, the template's
#     bin/health; its line in the host's cron log for the box (~/.mm/box/<project>/cron.log), not in the project folder
#  4. a failed run is logged as failed, with its exit code
#   test/box-cron.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
B="$(command -v bun || echo "$HOME/.bun/bin/bun")"
mkdir -p "$MM_HOME/pc/boxes" "$T/bin"
R="$T/projects/acme/shop"; mkdir -p "$R/.run/logs"
printf 'client: acme\nname: shop\nproject: acme-shop\nshort: as\nbox: true\n' >"$R/.mm-answers.yaml"
cp "$SRC/template/services.yaml" "$R/services.yaml"
# what box.ts writes at box on: the box's registration on the host's process manager
printf '# from %s/services.yaml\n# a project box (mm-box-acme-shop): it runs in its own container, not on this process manager\n' "$R" >"$MM_HOME/pc/boxes/acme-shop.yaml"
# the stub docker: records its arguments (one per line), exits $T/code (0 when missing)
printf '#!/bin/sh\nprintf "%%s\\n" "$@" >"%s/argv"\necho "health ran"\nexit $(cat "%s/code" 2>/dev/null || echo 0)\n' "$T" "$T" >"$T/bin/docker"; chmod +x "$T/bin/docker"
export MM_DOCKER="$T/bin/docker"

echo "== 1. who schedules"
"$B" -e "import { writeBase } from '$SRC/src/pc.ts'; writeBase()" >/dev/null 2>&1
is "the host's process manager runs mm.cron" grep -q 'mm.cron' "$MM_HOME/pc/base.yaml"

echo "== 2. the box's jobs"
cat >"$T/jobs.ts" <<EOF
import { jobs } from '$SRC/src/cron.ts'
console.log(JSON.stringify(jobs()))
EOF
"$B" "$T/jobs.ts" >"$T/jobs.json" 2>"$T/jobs.err"
is "mm cron lists the box's health job, every 1m, as a box job: $(cat "$T/jobs.json" "$T/jobs.err" | cut -c1-200)" \
  jq -e '.[] | select(.project == "acme-shop" and .name == "health" and .every == "1m" and .box == true)' "$T/jobs.json" >/dev/null
is "...its command is the project's bin/health" jq -e --arg c "node $R/bin/health" '.[] | select(.name == "health" and .command == $c)' "$T/jobs.json" >/dev/null

echo "== 3. one run"
cat >"$T/run.ts" <<EOF
import { runOnce } from '$SRC/src/cron.ts'
process.exit(await runOnce(process.argv[2]))
EOF
"$B" "$T/run.ts" acme-shop/health >"$T/run.out" 2>&1; rc=$?
is "the run succeeds: $(cat "$T/run.out")" [ "$rc" = 0 ]
is "...through docker exec into the box" bash -c "[ \"\$(sed -n 1p '$T/argv')\" = exec ] && grep -qx mm-box-acme-shop '$T/argv'"
is "...in the project's folder" bash -c "grep -A1 -x -- -w '$T/argv' | grep -qx '$R'"
is "...with its state under .run" grep -qx "HEALTH_STATE=$R/.run/health.json" "$T/argv"
is "...running bin/health" grep -qx "umask 002 && node $R/bin/health" "$T/argv"
L="$MM_HOME/box/acme-shop/cron.log"
is "...logged in the host's cron log for the box" jq -e 'select(.job == "health" and .exit_code == 0 and .project == "acme-shop" and .service == "cron")' "$L" >/dev/null
is "...not in the project folder (the box can write it)" [ ! -e "$R/.run/logs/cron.log" ]

echo "== 4. a failed run"
echo 3 >"$T/code"; "$B" "$T/run.ts" acme-shop/health >"$T/run.out" 2>&1; rc=$?
is "the run fails with its code ($rc)" [ "$rc" = 3 ]
is "...and its line says so" jq -se '.[-1] | select(.level == "error" and .exit_code == 3)' "$L" >/dev/null

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
