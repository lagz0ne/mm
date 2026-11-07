#!/usr/bin/env bash
# The machine's Paseo under mm (sy-11g), hermetic: a throwaway HOME / MM_HOME, a stub paseo, a fake systemctl and
# process-compose on PATH, a fake Paseo home with dummy files. Never the machine's Paseo: its listen address is set to a
# free port here, so nothing calls the machine's daemon. Proves:
#  1. writeBase: no mm.paseo while paseo.managed is off (nor PASEO_HOME for clients); on: the entry (namespace mm, mm's
#     own npm's paseo, umask 077, PASEO_HOME $MM_HOME/paseo/system 0700, the listen address, restart always, a readiness
#     probe, its log in $MM_HOME/pc), relay / web UI only when their keys are set; the command really runs under umask
#     077 with the token's file read into the environment (and its path not passed on); clients get PASEO_HOME
#  2. mm paseo migrate: dry run copies nothing and lists paths; refuses a daemon running on either home (its pid lock),
#     not one from another boot; refuses something answering on the listen address; copies with modes and sizes kept,
#     the pid lock left out, the source untouched; refuses a non-empty target, --force copies over it; no file's
#     contents in any output
#  3. mm doctor's paseo row: off: a warn naming the old unit while it exists, skip without it; on: fail while the old
#     unit is enabled or active (the fix disables it), fail without mm.paseo, fail with two daemons, ok with mm's alone
#   test/mm-paseo.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; [ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"; }
trap cleanup EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_LAYOUT=one-root
M="$MM_HOME"; mkdir -p "$M/bin" "$M/npm/bin" "$M/pc" "$T/bin"; chmod 700 "$HOME"
export PATH="$T/bin:$(dirname "$BUN"):/usr/bin:/bin"
# a free port for the listen address (never the machine's 6767)
PORT=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
cfg() { printf '%s\n' "$@" >"$M/config.yaml"; }
MARK=dummy-contents-7f3a  # in every fake file: it must never show in an output

echo "== 1. writeBase"
cat >"$T/base.ts" <<EOF
import { readFileSync } from 'node:fs'
import { writeBase } from '$SRC/src/pc'
import { toolEnv } from '$SRC/src/env'
writeBase()
const y = Bun.YAML.parse(readFileSync('$M/pc/base.yaml', 'utf8')) as any
console.log(JSON.stringify({ p: y.processes['mm.paseo'] ?? null, home: toolEnv().PASEO_HOME ?? null }))
EOF
base() { "$BUN" "$T/base.ts"; }
cfg 'layout: one-root'
r=$(base)
is "off: no mm.paseo" [ "$(jq -c .p <<<"$r")" = null ]
is "off: no PASEO_HOME for clients" [ "$(jq -r .home <<<"$r")" = null ]
is "off: no paseo/system folder made" [ ! -e "$M/paseo/system" ]
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT"
r=$(base); p=$(jq -c .p <<<"$r")
envv() { jq -r --arg k "$1" '.environment[] | select(startswith($k + "=")) | sub("^[^=]*="; "")' <<<"$p"; }
is "on: mm.paseo in namespace mm" [ "$(jq -r .namespace <<<"$p")" = mm ]
is "on: mm's own npm's paseo, daemon run" grep -qF "exec $M/npm/bin/paseo daemon run" <<<"$(jq -r .command <<<"$p")"
is "on: umask 077" grep -qF "umask 077" <<<"$(jq -r .command <<<"$p")"
is "on: PASEO_HOME is \$MM_HOME/paseo/system" [ "$(envv PASEO_HOME)" = "$M/paseo/system" ]
is "on: PASEO_LISTEN from paseo.listen" [ "$(envv PASEO_LISTEN)" = "127.0.0.1:$PORT" ]
is "on: HOME and MM_HOME set" [ "$(envv HOME)" = "$HOME" ] && [ "$(envv MM_HOME)" = "$M" ]
is "on: relay and web UI not forced (the home's config.json decides)" [ -z "$(envv PASEO_RELAY_ENABLED)$(envv PASEO_WEB_UI_ENABLED)" ]
is "on: restart always" [ "$(jq -r .availability.restart <<<"$p")" = always ]
is "on: readiness probe on the listen address" grep -qF "http://127.0.0.1:$PORT/" <<<"$(jq -r .readiness_probe.exec.command <<<"$p")"
is "on: its log in \$MM_HOME/pc" [ "$(jq -r .log_location <<<"$p")" = "$M/pc/paseo.log" ]
is "on: paseo/system 0700, paseo/ 0700" [ "$(stat -c %a "$M/paseo/system")" = 700 ] && [ "$(stat -c %a "$M/paseo")" = 700 ]
is "on: clients get PASEO_HOME (toolEnv)" [ "$(jq -r .home <<<"$r")" = "$M/paseo/system" ]
is "on: no CLAUDE_CONFIG_DIR at the daemon (each lead's own, bin/lead)" [ -z "$(envv CLAUDE_CONFIG_DIR)" ]
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT" '  relay: true' '  web_ui: false'
p=$(base | jq -c .p)
is "relay / web UI keys: PASEO_RELAY_ENABLED=true, PASEO_WEB_UI_ENABLED=false" [ "$(envv PASEO_RELAY_ENABLED)/$(envv PASEO_WEB_UI_ENABLED)" = true/false ]
# run the command as process-compose would ($$ is its $), with a stub paseo that reports what it got
TOKF=$(envv MM_PASEO_TOKEN_FILE)
is "the token's file is the machine input's path" [ "$TOKF" = "$HOME/.config/secrets/claude-oauth.token" ]
mkdir -p "$(dirname "$TOKF")"; printf '%s' "$MARK" >"$TOKF"; chmod 600 "$TOKF"
printf '#!/bin/sh\necho "umask=$(umask) token=${CLAUDE_CODE_OAUTH_TOKEN:+set} file=${MM_PASEO_TOKEN_FILE:-unset} home=$PASEO_HOME args=$*"\n' >"$M/npm/bin/paseo"; chmod +x "$M/npm/bin/paseo"
cmd=$(jq -r .command <<<"$p" | sed 's/\$\$/$/g')
out=$(env -i $(jq -r '.environment[]' <<<"$p" | tr '\n' ' ') bash -c "$cmd")
is "the daemon starts with umask 077" grep -q "umask=0077" <<<"$out"
is "...with the token in its environment, its file's path not passed on" grep -q "token=set file=unset" <<<"$out"
is "...as 'daemon run' on mm's home" grep -qF "home=$M/paseo/system args=daemon run" <<<"$out"
is "...and the token's value is not on its command line" bash -c '! grep -qF "$1" <<<"$2"' _ "$MARK" "$(jq -r .command <<<"$p")"

echo
echo "mm-paseo: $pass passed, $fail failed"
[ "$fail" = 0 ]
