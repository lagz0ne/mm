#!/usr/bin/env bash
# mm doctor's router check never runs plain `sudo docker` (sy-nu5r): with no box.docker set and plain docker refused,
# it asks mm's wrapper through sudo when that is installed, and nothing else. Hermetic: a throwaway HOME / MM_HOME,
# stub docker and sudo on PATH that record their arguments.
#   test/doctor-docker.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.mm" "$T/bin"
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
printf 'layout: one-root\naccess: domain\ndomain: example.test\n' >"$MM_HOME/config.yaml"
printf '#!/bin/sh\necho "docker $*" >>"%s/calls"\nexit 1\n' "$T" >"$T/bin/docker"
printf '#!/bin/sh\necho "sudo $*" >>"%s/calls"\nexit 1\n' "$T" >"$T/bin/sudo"
chmod +x "$T/bin/docker" "$T/bin/sudo"
PATH="$T/bin:$PATH" $MMC doctor >/dev/null 2>&1
calls=$(cat "$T/calls" 2>/dev/null || true)
if echo "$calls" | grep -q '^docker ps'; then ok "plain docker is tried first"; else bad "plain docker is tried first ($calls)"; fi
if echo "$calls" | grep -qE '^sudo (-n )?docker'; then bad "never sudo docker ($calls)"; else ok "never plain sudo docker"; fi
if [ -e /usr/local/libexec/mm-docker ]; then
  if echo "$calls" | grep -q '^sudo -n /usr/local/libexec/mm-docker ps'; then ok "...then the installed wrapper through sudo"; else bad "...then the installed wrapper through sudo ($calls)"; fi
else
  if echo "$calls" | grep -q '^sudo'; then bad "no wrapper installed: no sudo at all ($calls)"; else ok "no wrapper installed: no sudo at all"; fi
fi
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
