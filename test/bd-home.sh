#!/usr/bin/env bash
# bd leaves nothing in the home folder (sy-nsnp), hermetic: a throwaway HOME / MM_HOME with a throwaway project made of
# the template's engine (bin/init, bin/bd, bin/bd-quiet, tools.json) and the real, pinned bd and Dolt; Dolt runs as the
# services file runs it (loopback, the project's socket), bd serve too, then both stop. bd keeps its metrics state and
# user config per HOME, not under XDG_CONFIG_HOME: while metrics are on, every call writes ~/.beads/eventsData (and
# ~/.beads/machine-id) and bootstraps ~/.config/bd/config.yaml; `bd config set metrics.*` writes there too (a
# user-global key); and bd init saves --stealth's no-git-ops into a ~/.config/bd/config.yaml it finds. Proves:
#  1. bd as it comes (no project env) writes ~/.beads and ~/.config/bd at its first call: the test sees what it guards
#  2. a project's start-up (bin/init, Dolt, bd serve) and a few board calls through bin/bd leave nothing under HOME
#     outside MM_HOME; metrics are off by bin/bd's env; bd-quiet still leaves no-hooks and no-git-ops set
#  3. a home folder that already has ~/.config/bd/config.yaml (an older box, a person's own bd): left as it is
#   test/bd-home.sh [bd binary] [dolt binary]   default: the pinned releases from template/tools.json, checksums checked
#   needs node, git, curl (for the default)
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
[ -n "${KEEP:-}" ] && trap - EXIT && echo "kept: $T"
for c in node git; do command -v $c >/dev/null || { echo "needs $c"; exit 2; }; done
# the pinned release of a tool, as mm new installs it (download sha256, then the extracted binary's)
pin() { node -e "const s=require('$SRC/template/tools.json')['$1']['linux-x64'];process.stdout.write(String(s['$2']))"; }
fetch() {
  local t=$1 out="$T/dl-$1"; mkdir -p "$out"
  curl -fsSL -o "$out/t.tgz" "$(pin "$t" url)" || { echo "needs the $t release (download failed); or pass the binaries" >&2; return 1; }
  [ "$(sha256sum "$out/t.tgz" | cut -d' ' -f1)" = "$(pin "$t" sha256)" ] || { echo "$t release: checksum mismatch" >&2; return 1; }
  tar -xzf "$out/t.tgz" -C "$out" "$(pin "$t" extract)" && echo "$out/$(pin "$t" extract)"
}
BD=${1:-$(fetch bd)} || exit 2
DOLT=${2:-$(fetch dolt)} || exit 2
for b in "$BD" "$DOLT"; do [ -x "$b" ] || { echo "not an executable: $b"; exit 2; }; done
BD=$(readlink -f "$BD"); DOLT=$(readlink -f "$DOLT")
[ "$(sha256sum <"$BD" | cut -d' ' -f1)" = "$(pin bd installed_sha256)" ] || echo "  (note: $BD is not the pinned bd; bin/init will refuse it)"
unset BEADS_DIR BEADS_DB BEADS_ACTOR BD_ACTOR XDG_CONFIG_HOME DOLT_ROOT_PATH BEADS_DOLT_SERVER_SOCKET BD_DISABLE_METRICS \
  BD_DISABLE_EVENT_FLUSH DO_NOT_TRACK MM_TRACE_SELF TRACEPARENT
export GIT_CONFIG_NOSYSTEM=1
newhome() { export HOME="$T/$1" MM_HOME="$T/$1/.mm"; mkdir -p "$HOME"; }
# what is in the home folder outside MM_HOME (files and links; folders only as their path)
outside_files() { (cd "$HOME" && find . -path ./.mm -prune -o ! -type d -print | sed 's|^\./||' | sort | tr '\n' ' '); }
port() { echo $((20000 + RANDOM % 20000)); }
# a project as mm new lays it out: the template's engine for bd, the pinned tools in tools/
project() {
  P="$MM_HOME/projects/acme/shop"
  mkdir -p "$P/bin/lib" "$P/tools"
  cp "$SRC/template/bin/init" "$SRC/template/bin/bd" "$SRC/template/bin/bd-quiet" "$SRC/template/bin/message" "$SRC/template/bin/task" "$P/bin/"
  # bin/bd's gates (bin/message, bin/task) and their libs: without them bd refuses the comment and the create below
  for f in message owner-card task raci; do cp "$SRC/template/bin/lib/$f.mjs" "$P/bin/lib/"; done
  cp "$SRC/template/tools.json" "$P/"
  printf '#!/bin/sh\n# stand-in for bin/trace: no span, just the command after --\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n' >"$P/bin/trace"
  chmod +x "$P/bin/"*; ln -s "$BD" "$P/tools/bd"; ln -s "$DOLT" "$P/tools/dolt"
}
B() { (cd "$P/control" && "$P/bin/bd" "$@"); }
# start-up: bin/init, then Dolt as the services file runs it (its socket), then bd serve; stopped by stop_services
start() {
  (cd "$P" && bin/init t) >"$T/init.out" 2>&1 || { bad "bin/init: $(grep -v '^ *$' "$T/init.out" | tail -8)"; return 1; }
  (cd "$P/control/.beads/dolt" && DOLT_ROOT_PATH="$P/.dolt-root" XDG_CONFIG_HOME="$P/.config" \
    exec "$P/tools/dolt" sql-server --host 127.0.0.1 --port "$(port)" --socket "$P/.dolt/mysql.sock" --loglevel warning) >"$T/dolt.out" 2>&1 &
  DPID=$!; PIDS+=("$DPID")
  for _ in $(seq 1 60); do [ -S "$P/.dolt/mysql.sock" ] && B list --json >/dev/null 2>&1 && break; sleep 0.5; done
  [ -S "$P/.dolt/mysql.sock" ] || { bad "dolt did not start: $(tail -3 "$T/dolt.out")"; return 1; }
  SPORT=$(port)
  (cd "$P/control" && exec "$P/bin/bd" serve --addr "127.0.0.1:$SPORT" --actor ui --allowed-host bd-serve.acme-shop.localhost) >"$T/serve.out" 2>&1 &
  SPID=$!; PIDS+=("$SPID")
  for _ in $(seq 1 40); do curl -sf -o /dev/null -H "Host: bd-serve.acme-shop.localhost" "http://127.0.0.1:$SPORT/v0/beads/issues?limit=1" 2>/dev/null && break; sleep 0.5; done
}
stop_services() { kill "$SPID" "$DPID" 2>/dev/null; wait "$SPID" "$DPID" 2>/dev/null; }
calls() {  # a few board calls, as leads, wake and the board make them
  id=$(B create "hello" --actor qa --json 2>/dev/null | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -1)
  B list --json >/dev/null 2>&1; B show "$id" --json >/dev/null 2>&1; B comments add "$id" "a comment" --actor qa >/dev/null 2>&1
  B update "$id" --claim --actor qa >/dev/null 2>&1; B ready --json >/dev/null 2>&1; B config get no-hooks >/dev/null 2>&1
  (cd "$P" && bin/bd-quiet) >"$T/quiet2.out" 2>&1
}

echo "== 1. bd as it comes, no project env: its first call writes in the home folder"
newhome raw; mkdir -p "$T/raw-work"
(cd "$T/raw-work" && "$BD" version) >/dev/null 2>&1
is "bd version alone wrote ~/.config/bd/config.yaml and ~/.beads/eventsData ($(outside_files))" \
  bash -c "[ -f '$HOME/.config/bd/config.yaml' ] && [ -d '$HOME/.beads/eventsData' ]"
newhome rawxdg; mkdir -p "$T/rawxdg-work/.config"
(cd "$T/rawxdg-work" && XDG_CONFIG_HOME="$T/rawxdg-work/.config" "$BD" version) >/dev/null 2>&1
is "...XDG_CONFIG_HOME alone keeps neither ~/.config/bd (bd prefers it) nor ~/.beads out" \
  bash -c "[ -f '$HOME/.config/bd/config.yaml' ] && [ -d '$HOME/.beads' ] && ! [ -e '$T/rawxdg-work/.config/bd' ]"

echo "== 2. a project's start-up and board calls through bin/bd: nothing outside MM_HOME"
newhome fresh; project
if start; then
  is "bin/init, Dolt, bd serve: nothing under HOME outside MM_HOME ($(outside_files))" [ -z "$(outside_files)" ]
  is "bd serve answers (the board's API)$(curl -sf -o /dev/null -H "Host: bd-serve.acme-shop.localhost" "http://127.0.0.1:$SPORT/v0/beads/issues?limit=1" || echo ": $(tail -c 300 "$T/serve.out")")" \
    curl -sf -o /dev/null -H "Host: bd-serve.acme-shop.localhost" "http://127.0.0.1:$SPORT/v0/beads/issues?limit=1"
  calls
  is "bd create gives an id ($id)" [ -n "$id" ]
  is "create, list, show, comments add, claim, ready, config get, bd-quiet: still nothing outside MM_HOME ($(outside_files))" [ -z "$(outside_files)" ]
  is "bd's metrics are off for the board's calls (bd metrics: OFF)" bash -c "cd '$P/control' && '$P/bin/bd' metrics 2>/dev/null | grep -qx 'Anonymous usage metrics: OFF'"
  is "bd-quiet sets no metrics key ($(grep '^bd-quiet' "$T/init.out" "$T/quiet2.out" | tr '\n' ' '))" bash -c "! grep -q 'bd-quiet: metrics' '$T/init.out' '$T/quiet2.out'"
  is "no-hooks and no-git-ops are set, in the project (control/.beads/config.yaml)" \
    bash -c "[ \"\$(cd '$P/control' && '$P/bin/bd' config get no-hooks | tail -1)\" = true ] && [ \"\$(cd '$P/control' && '$P/bin/bd' config get no-git-ops | tail -1)\" = true ] && grep -q '^no-git-ops: true' '$P/control/.beads/config.yaml'"
  stop_services
  is "...and after Dolt and bd serve stopped: no ~/.beads, no ~/.config/bd ($(outside_files))" bash -c "[ -z \"$(outside_files)\" ] && ! [ -e '$HOME/.beads' ] && ! [ -e '$HOME/.config/bd' ]"
fi

echo "== 3. an older box: ~/.config/bd/config.yaml is there already; the project's start-up and calls leave it as it is"
newhome older; mkdir -p "$HOME/.config/bd"; printf 'actor: someone\n' >"$HOME/.config/bd/config.yaml"
before=$(md5sum <"$HOME/.config/bd/config.yaml")
project
if start; then
  calls; stop_services
  is "~/.config/bd/config.yaml unchanged (bd init saved no-git-ops in the project), no ~/.beads ($(outside_files))" \
    bash -c "[ \"\$(md5sum <'$HOME/.config/bd/config.yaml')\" = '$before' ] && ! [ -e '$HOME/.beads' ] && [ \"$(outside_files)\" = '.config/bd/config.yaml ' ]"
  is "...no-git-ops is the project's (control/.beads/config.yaml)" grep -q '^no-git-ops: true' "$P/control/.beads/config.yaml"
fi

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
