#!/usr/bin/env bash
# mm doctor's "mode $MM_HOME" row (review sy-lud 1), hermetic: a throwaway $MM_HOME. Proves: 0700 folders, sockets no
# one else can connect to and 0600 Paseo logs pass; $MM_HOME, paseo/, claude/ or run/ wider than 0700 fail, and so do a
# socket the group may write and a Paseo log others may read; the fix names each path; other files don't count.
#   test/mm-home-modes.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES=""
M="$MM_HOME"; mkdir -p "$M"/{paseo/logs,claude,run/boards,data}
chmod 700 "$HOME" "$M" "$M/paseo" "$M/claude" "$M/run"
cat >"$T/row.ts" <<EOF
import { mmHomeModes } from '$SRC/src/doctor'
const r = mmHomeModes(process.argv[2])
console.log(JSON.stringify(r))
EOF
row() { PATH="$HOME/.bun/bin:$PATH" bun "$T/row.ts" "$M" 2>/dev/null || bun "$T/row.ts" "$M"; }
sock() { python3 -I -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$1"; }
want() { # <description> <ok|fail> [text the detail or fix must have]
  local r; r=$(row); local st; st=$(jq -r .status <<<"$r")
  if [ "$st" = "$2" ] && { [ -z "${3:-}" ] || grep -qF -- "$3" <<<"$r"; }; then ok "$1"; else bad "$1: $r"; fi
}

echo "== narrow everywhere"
sock "$M/pc.sock"; chmod 755 "$M/pc.sock"
sock "$M/run/boards/b.sock"; chmod 600 "$M/run/boards/b.sock"
: >"$M/paseo/daemon.log"; chmod 600 "$M/paseo/daemon.log"
: >"$M/paseo/logs/agent.log"; chmod 600 "$M/paseo/logs/agent.log"
: >"$M/config.yaml"; chmod 644 "$M/config.yaml"; chmod 755 "$M/data"
want "0700 folders, a socket only the owner can write (0755), 0600 logs: ok (other files and folders don't count)" ok

echo "== wider folders"
S='~/.mm'   # how doctor shows $MM_HOME (under the home)
chmod 755 "$M"; want "\$MM_HOME 0755 fails, fix chmod 700" fail "chmod 700 $S"; chmod 700 "$M"
for d in paseo claude run; do chmod 750 "$M/$d"; want "$d/ 0750 fails" fail "$S/$d 0750"; chmod 700 "$M/$d"; done

echo "== sockets"
chmod 775 "$M/pc.sock"; want "pc.sock group-writable fails, fix go-w" fail "chmod go-w $S/pc.sock"; chmod 755 "$M/pc.sock"
chmod 666 "$M/run/boards/b.sock"; want "a board socket under run/ others may write fails" fail "$S/run/boards/b.sock 0666"; chmod 600 "$M/run/boards/b.sock"

echo "== Paseo logs"
chmod 644 "$M/paseo/daemon.log"; want "daemon.log 0644 fails, fix chmod 600" fail "chmod 600 $S/paseo/daemon.log"; chmod 600 "$M/paseo/daemon.log"
chmod 640 "$M/paseo/logs/agent.log"; want "a log one folder down 0640 fails" fail "$S/paseo/logs/agent.log"; chmod 600 "$M/paseo/logs/agent.log"
: >"$M/paseo/state.json"; chmod 644 "$M/paseo/state.json"; want "a non-log file in paseo/ doesn't count" ok

echo "== a missing folder"
rmdir "$M/claude"; want "no claude/ yet: ok" ok

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
