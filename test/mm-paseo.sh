#!/usr/bin/env bash
# The machine's Paseo under mm (sy-11g), hermetic: a throwaway HOME / MM_HOME, a stub paseo, a fake systemctl and
# process-compose on PATH, a fake Paseo home with dummy files. Never the machine's Paseo: its listen address is set to a
# free port here, so nothing calls the machine's daemon. Proves:
#  1. writeBase: no mm.paseo while paseo.managed is off (nor PASEO_HOME for clients); on: the entry (namespace mm, mm's
#     the paseo of mm's lock, umask 077, PASEO_HOME $MM_HOME/paseo/system 0700, the listen address, restart always, a readiness
#     probe, its log in $MM_HOME/pc), relay / web UI only when their keys are set; the command really runs under umask
#     077 with the token's file read into the environment (and its path not passed on); clients get PASEO_HOME
#  2. mm paseo migrate: dry run copies nothing and lists paths; refuses a daemon running on either home (its pid lock),
#     not one from another boot; refuses something answering on the listen address; copies with modes and sizes kept,
#     the pid lock left out, the source untouched; refuses a non-empty target, --force copies over it; no file's
#     contents in any output
#  3. mm doctor's paseo row: off: a warn naming the old unit while it exists, skip without it; on: fail while the old
#     unit is enabled or active (the fix disables it), fail without mm.paseo, fail with two daemons, ok with mm's alone
#  6. socket-first (sy-nli): managed with paseo.listen unset, the daemon listens on $MM_HOME/run/paseo.sock (run/
#     0700, probed with test -S); a set value is kept; a host project's endpoints name the address (unix:///path or
#     ws://host:port/ws), a box project's and an unmanaged machine's don't
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
M="$MM_HOME"; mkdir -p "$M/bin" "$M/npm/paseo/node_modules/.bin" "$M/pc" "$T/bin"; chmod 700 "$HOME"
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
is "on: the paseo of mm's lock (npm/paseo), daemon run" grep -qF "exec $M/npm/paseo/node_modules/.bin/paseo daemon run" <<<"$(jq -r .command <<<"$p")"
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
printf '#!/bin/sh\necho "umask=$(umask) token=${CLAUDE_CODE_OAUTH_TOKEN:+set} file=${MM_PASEO_TOKEN_FILE:-unset} home=$PASEO_HOME args=$*"\n' >"$M/npm/paseo/node_modules/.bin/paseo"; chmod +x "$M/npm/paseo/node_modules/.bin/paseo"
cmd=$(jq -r .command <<<"$p" | sed 's/\$\$/$/g')
out=$(env -i $(jq -r '.environment[]' <<<"$p" | tr '\n' ' ') bash -c "$cmd")
is "the daemon starts with umask 077" grep -q "umask=0077" <<<"$out"
is "...with the token in its environment, its file's path not passed on" grep -q "token=set file=unset" <<<"$out"
is "...as 'daemon run' on mm's home" grep -qF "home=$M/paseo/system args=daemon run" <<<"$out"
is "...and the token's value is not on its command line" bash -c '! grep -qF "$1" <<<"$2"' _ "$MARK" "$(jq -r .command <<<"$p")"

echo "== 2. mm paseo migrate"
cfg 'layout: one-root' "paseo:" "  listen: 127.0.0.1:$PORT"
O="$HOME/.paseo" S="$M/paseo/system"; rm -rf "$S"
mkdir -p "$O/agents/claude" "$O/sessions/s1" "$O/hosts" "$O/open"
for f in daemon-keypair.json local-credential config.json server-id agents/claude/a1.json sessions/s1/log.jsonl hosts/h.json open/readme.txt daemon.log; do printf '%s %s\n' "$MARK" "$f" >"$O/$f"; done
head -c 5000 /dev/zero >>"$O/daemon.log"
chmod 700 "$O" "$O/agents" "$O/agents/claude" "$O/sessions" "$O/sessions/s1" "$O/hosts"; chmod 755 "$O/open"
chmod 600 "$O"/daemon-keypair.json "$O"/local-credential "$O"/daemon.log "$O"/agents/claude/a1.json "$O"/sessions/s1/log.jsonl "$O"/hosts/h.json
chmod 644 "$O/config.json" "$O/server-id" "$O/open/readme.txt"
ln -s config.json "$O/config.link"
python3 -I -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$O/daemon.sock"
snap() { (cd "$1" && find . -printf '%p %y %m %s %l\n' | sort; find . -type f -exec sha256sum {} + | sort) | sha256sum; }
before=$(snap "$O")
mig() { "$BUN" "$SRC/src/cli.ts" paseo migrate "$@" >"$T/mig.out" 2>&1; echo $? >"$T/mig.rc"; }
rc() { cat "$T/mig.rc"; }
clean() { ! grep -qF "$MARK" "$T/mig.out"; }
mig --dry-run
is "dry run: exit 0" [ "$(rc)" = 0 ]
is "...lists the keypair's path" grep -q "daemon-keypair.json" "$T/mig.out"
is "...copies nothing" [ ! -e "$S" ] || [ -z "$(ls -A "$S")" ]
is "...no contents printed" clean
sleep 300 & live=$!; PIDS+=("$live")
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","hostname":"h","uid":1,"listen":"127.0.0.1:%s"}\n' "$live" "$PORT" >"$O/paseo.pid"
mig
is "a daemon on the old home: refused" [ "$(rc)" = 1 ] && grep -q "a Paseo daemon runs on ~/.paseo (pid $live)" "$T/mig.out"
is "...nothing copied" [ ! -e "$S" ]
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","hostname":"h","uid":1,"listen":null,"bootId":"another-boot"}\n' "$live" >"$O/paseo.pid"
mkdir -p "$S"; chmod 700 "$S"
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","hostname":"h","uid":1,"listen":null}\n' "$live" >"$S/paseo.pid"
mig
is "a daemon on mm's home: refused" [ "$(rc)" = 1 ] && grep -q "a Paseo daemon runs on ~/.mm/paseo/system" "$T/mig.out"
rm -f "$S/paseo.pid"
python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory "$T/bin" >/dev/null 2>&1 & srv=$!; PIDS+=("$srv")
for _ in $(seq 50); do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
mig
is "something answers on the listen address: refused" [ "$(rc)" = 1 ] && grep -q "answers on 127.0.0.1:$PORT" "$T/mig.out"
kill "$srv"; wait "$srv" 2>/dev/null
mig
is "copy (a pid lock from another boot doesn't count): exit 0" [ "$(rc)" = 0 ] || cat "$T/mig.out"
is "...every file with its size and mode" grep -q "copied: 9/9 file(s)" "$T/mig.out"
is "...the keypair present" grep -q "keypair: daemon-keypair.json present" "$T/mig.out"
is "...no contents printed" clean
for f in daemon-keypair.json local-credential config.json daemon.log agents/claude/a1.json sessions/s1/log.jsonl hosts/h.json open/readme.txt; do
  [ "$(stat -c '%a %s' "$O/$f")" = "$(stat -c '%a %s' "$S/$f")" ] || bad "mode/size of $f: $(stat -c '%a %s' "$S/$f")"; done
ok "...modes and sizes of the files kept (0600 keys, 0644 config)"
is "...folder modes kept (0700, a 0755 one stays 0755); the target 0700" [ "$(stat -c %a "$S/agents/claude") $(stat -c %a "$S/open") $(stat -c %a "$S")" = "700 755 700" ]
is "...the link copied as a link" [ "$(readlink "$S/config.link")" = config.json ]
is "...the pid lock and the socket left out" [ ! -e "$S/paseo.pid" ] && [ ! -e "$S/daemon.sock" ]
is "...the contents the same" cmp -s "$O/sessions/s1/log.jsonl" "$S/sessions/s1/log.jsonl"
rm -f "$O/paseo.pid"
is "the source untouched" [ "$(snap "$O")" = "$before" ]
mig
is "a non-empty target: refused" [ "$(rc)" = 1 ] && grep -q "is not empty" "$T/mig.out"
mig --force
is "--force copies over it" [ "$(rc)" = 0 ] && clean
rm -rf "$O.gone"; mv "$O" "$O.gone"; mig
is "no old home: refused" [ "$(rc)" = 1 ] && grep -q "no Paseo home at ~/.paseo" "$T/mig.out"
mv "$O.gone" "$O"

echo "== 3. mm doctor's paseo row"
# fake systemctl: FAKE_UNIT is none | on (enabled, active) | off (disabled, inactive); fake process-compose: FAKE_PC
cat >"$T/bin/systemctl" <<'EOF'
#!/bin/sh
case "$*" in
  "--user is-system-running") echo running ;;
  *"show paseo.service -p LoadState --value") [ "$FAKE_UNIT" = none ] && echo not-found || echo loaded ;;
  *"is-enabled paseo.service") case "$FAKE_UNIT" in on) echo enabled ;; off) echo disabled ;; *) echo not-found; exit 1 ;; esac ;;
  *"is-active paseo.service") case "$FAKE_UNIT" in on) echo active ;; *) echo inactive; exit 3 ;; esac ;;
  *) exit 1 ;;
esac
EOF
cat >"$T/bin/process-compose" <<'EOF'
#!/bin/sh
case "$FAKE_PC" in
  running) echo '[{"name":"mm.paseo","namespace":"mm","status":"Running","restarts":0}]' ;;
  none) echo '[]' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/bin/systemctl" "$T/bin/process-compose"
cat >"$T/row.ts" <<EOF
import { daemonCheck } from '$SRC/src/paseo'
console.log(JSON.stringify(daemonCheck()))
EOF
want() { # <description> <status> [text the row must have]
  local r; r=$("$BUN" "$T/row.ts"); local st; st=$(jq -r .status <<<"$r")
  if [ "$st" = "$2" ] && { [ -z "${3:-}" ] || grep -qF -- "$3" <<<"$r"; }; then ok "$1"; else bad "$1: $r"; fi; }
rm -f "$O/paseo.pid" "$S/paseo.pid"
cfg 'layout: one-root'
FAKE_UNIT=on FAKE_PC=none want "off, the old unit there: warn naming it" warn "paseo.service (active, enabled) runs the machine's Paseo from ~/.paseo: not under mm yet: sy-11g"
FAKE_UNIT=none FAKE_PC=none want "off, no old unit: skip" skip
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT"
FAKE_UNIT=on FAKE_PC=running want "on, the old unit enabled and active: fail, the fix disables it" fail '"fix":"systemctl --user disable --now paseo.service"'
FAKE_UNIT=none FAKE_PC=none want "on, no mm.paseo in the process manager: fail" fail "no mm.paseo"
FAKE_UNIT=off FAKE_PC=running want "on, the old unit disabled, mm.paseo runs: ok" ok "mm.paseo runs"
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","hostname":"h","uid":1,"listen":null}\n' "$live" >"$O/paseo.pid"
sleep 300 & live2=$!; PIDS+=("$live2")
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","hostname":"h","uid":1,"listen":null}\n' "$live2" >"$S/paseo.pid"
FAKE_UNIT=off FAKE_PC=running want "on, a daemon on each home: fail (two daemons)" fail "two Paseo daemons: pid $live on ~/.paseo, pid $live2"
rm -f "$S/paseo.pid"
FAKE_UNIT=none FAKE_PC=running want "on, a daemon still on the old home (no unit): fail" fail "still runs on ~/.paseo"
rm -f "$O/paseo.pid"

echo "== 4. the listen address: loopback or a socket only (review sy-11g #12, fix 1)"
cat >"$T/lr.ts" <<EOF
import { listenRefusal } from '$SRC/src/paseo'
for (const l of process.argv.slice(2)) console.log(listenRefusal(l) === null ? 'ok' : 'refused')
EOF
lr() { "$BUN" "$T/lr.ts" "$@" | tr '\n' ' ' | sed 's/ $//'; }
is "allowed: 127.0.0.1:6767, [::1]:6767, a socket path, unix:///path" [ "$(lr 127.0.0.1:6767 '[::1]:6767' /run/x/paseo.sock unix:///run/x/p.sock)" = "ok ok ok ok" ]
is "refused: 0.0.0.0, ::, a LAN address, a name, localhost, a bare port, port 0 or 70000" [ "$(lr 0.0.0.0:6767 '[::]:6767' 192.168.1.5:6767 vibea:6767 localhost:6767 6767 127.0.0.1:0 127.0.0.1:70000)" = "refused refused refused refused refused refused refused refused" ]
is "refused: 127.0.0.2 and a look-alike (127.0.0.1.evil:1)" [ "$(lr 127.0.0.2:6767 127.0.0.1.evil:1)" = "refused refused" ]
is "refused: a socket path with shell characters" [ "$(lr '/tmp/a b' '/tmp/$(x)' '/tmp/a;b')" = "refused refused refused" ]
cfg 'layout: one-root' 'paseo:' '  managed: true' '  listen: 0.0.0.0:6767'
p=$(base | jq -c .p)
is "paseo.listen 0.0.0.0:6767: mm.paseo does not start the daemon" bash -c '! grep -q "daemon run" <<<"$1"' _ "$(jq -r .command <<<"$p")"
is "...it says why and stops (restart no)" grep -q "mm.paseo refused: paseo.listen is not" <<<"$(jq -r .command <<<"$p" | sed 's/\$\$/$/g' | bash 2>&1)" && [ "$(jq -r .availability.restart <<<"$p")" = no ]
is "...the configured value is not on its command line" bash -c '! grep -qF "0.0.0.0" <<<"$1"' _ "$(jq -r .command <<<"$p")"
FAKE_UNIT=off FAKE_PC=running want "...and doctor fails, naming the address and the fix" fail 'paseo.listen \"0.0.0.0:6767\" is not loopback'
FAKE_UNIT=off FAKE_PC=running want "...its fix: unset (mm's socket, sy-nli) or a loopback port" fail "mm config unset paseo.listen (mm's socket, ~/.mm/run/paseo.sock), or set it to 127.0.0.1:<port>"

echo "== 5. paseo.home: the home already under mm, used as is (sy-11g #14: ~/.paseo a link to \$MM_HOME/paseo/machine)"
rm -rf "$O" "$S"; MH="$M/paseo/machine"; mkdir -p "$MH/agents"; printf '%s\n' "$MARK" >"$MH/daemon-keypair.json"; chmod 700 "$MH"; ln -s "$MH" "$O"
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT" "  home: ~/.mm/paseo/machine"
r=$(base); p=$(jq -c .p <<<"$r")
is "mm.paseo runs on paseo.home (PASEO_HOME = paseo/machine)" [ "$(envv PASEO_HOME)" = "$MH" ] && grep -q "daemon run" <<<"$(jq -r .command <<<"$p")"
is "...its clients get the same PASEO_HOME (toolEnv)" [ "$(jq -r .home <<<"$r")" = "$MH" ]
is "...no paseo/system made" [ ! -e "$S" ]
mig
is "migrate: nothing to copy (exit 0), no second keypair" [ "$(rc)" = 0 ] && grep -q "nothing to copy" "$T/mig.out" && [ ! -e "$S" ] && clean
printf '{"pid":%s,"startedAt":"2026-01-01T00:00:00Z","hostname":"h","uid":1,"listen":null}\n' "$live" >"$MH/paseo.pid"
FAKE_UNIT=off FAKE_PC=running want "doctor: its daemon (seen through the ~/.paseo link too) is mm's, not a second one: ok" ok "mm.paseo runs (home ~/.mm/paseo/machine"
FAKE_UNIT=on FAKE_PC=running want "...the old unit still enabled: fail, as before" fail "still"
rm -f "$MH/paseo.pid"
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT" "  home: $T/elsewhere"
p=$(base | jq -c .p)
is "paseo.home outside mm's paseo/ folder: mm.paseo does not start the daemon, and says why" bash -c '! grep -q "daemon run" <<<"$1" && grep -q "paseo.home is not a folder in mm/paseo" <<<"$1"' _ "$(jq -r .command <<<"$p")"
is "...nothing made there" [ ! -e "$T/elsewhere" ]
FAKE_UNIT=off FAKE_PC=running want "...doctor fails, naming it" fail "is not a folder inside ~/.mm/paseo"
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT" "  home: ~/.mm/paseo/../outside"
FAKE_UNIT=off FAKE_PC=running want "paseo.home with ..: refused" fail "is not a folder inside"
ln -s "$MH" "$M/paseo/alias"
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT" "  home: ~/.mm/paseo/alias"
FAKE_UNIT=off FAKE_PC=running want "paseo.home a link: refused" fail "is not a real folder"
rm -f "$M/paseo/alias"

echo "== 6. socket-first (sy-nli): paseo.listen unset is mm's socket; every host project's endpoints name the address"
cfg 'layout: one-root' 'paseo:' '  managed: true'
rm -rf "$M/run"
r=$(base); p=$(jq -c .p <<<"$r")
is "listen unset, managed: PASEO_LISTEN is unix://\$MM_HOME/run/paseo.sock" [ "$(envv PASEO_LISTEN)" = "unix://$M/run/paseo.sock" ]
is "...the daemon starts (a socket is not refused)" grep -q "daemon run" <<<"$(jq -r .command <<<"$p")"
is "...its readiness probe: the socket file" [ "$(jq -r .readiness_probe.exec.command <<<"$p")" = "test -S $M/run/paseo.sock" ]
is "...run/ made 0700" [ "$(stat -c %a "$M/run")" = 700 ]
chmod 755 "$M/run"; base >/dev/null
is "...and put back to 0700 when it was wider" [ "$(stat -c %a "$M/run")" = 700 ]
cfg 'layout: one-root' 'paseo:' "  listen: 127.0.0.1:$PORT"
cat >"$T/listen.ts" <<EOF
import { listen, clientAddress } from '$SRC/src/paseo'
console.log(listen() + ' ' + clientAddress(listen()))
EOF
is "unmanaged: listen as configured" [ "$("$BUN" "$T/listen.ts")" = "127.0.0.1:$PORT ws://127.0.0.1:$PORT/ws" ]
cfg 'layout: one-root'
is "unmanaged, unset: Paseo's own default" [ "$("$BUN" "$T/listen.ts")" = "127.0.0.1:6767 ws://127.0.0.1:6767/ws" ]
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: /tmp/elsewhere.sock"
is "a bare socket path: unix:///path for clients" [ "$("$BUN" "$T/listen.ts")" = "/tmp/elsewhere.sock unix:///tmp/elsewhere.sock" ]
# the endpoints of a host project and of a box project (writeRunFiles), with the address mm gave the daemon
proj() { # <dir> <project> [box]
  mkdir -p "$1"; printf 'client: acme\nname: shop\nproject: %s\nshort: x\nroot: %s\ntemplate_version: test\ncreated: test\n%s' "$2" "$1" "${3:+box: true
}" >"$1/.mm-answers.yaml"; printf 'services:\n  worker:\n    command: "true"\n' >"$1/services.yaml"; }
proj "$T/hp" acme-host; proj "$T/bp" acme-box box
cat >"$T/run.ts" <<EOF
import { readFileSync } from 'node:fs'
import { writeRunFiles } from '$SRC/src/project'
import { DIRS } from '$SRC/src/env'
const root = process.argv[2], box = process.argv[3] === 'box'
writeRunFiles(root, box ? '/run/mm/sock/pc.sock' : DIRS.socket)
console.log(JSON.parse(readFileSync(root + '/.run/endpoints.json', 'utf8')).paseo ?? 'none')
EOF
ep() { (cd "$T" && "$BUN" "$T/run.ts" "$@" 2>&1); }
cfg 'layout: one-root' 'paseo:' '  managed: true'
is "managed, listen unset: a host project's paseo is unix://\$MM_HOME/run/paseo.sock" [ "$(ep "$T/hp")" = "unix://$M/run/paseo.sock" ]
is "...a box project's has none (its Paseo is the box's own)" [ "$(ep "$T/bp" box)" = none ]
cfg 'layout: one-root' 'paseo:' '  managed: true' "  listen: 127.0.0.1:$PORT"
is "managed, listen set to TCP: kept, as ws://host:port/ws" [ "$(ep "$T/hp")" = "ws://127.0.0.1:$PORT/ws" ]
cfg 'layout: one-root'
is "unmanaged: no paseo in the endpoints" [ "$(ep "$T/hp")" = none ]

echo
echo "mm-paseo: $pass passed, $fail failed"
[ "$fail" = 0 ]
