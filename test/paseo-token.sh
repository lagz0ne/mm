#!/usr/bin/env bash
# mm.paseo's Claude token (sy-nli), hermetic: a throwaway HOME / MM_HOME, a test vault (a test recovery key), a
# memory-backed runtime folder (/dev/shm), a stub paseo, a dummy token. Never the machine's vault, Paseo or token. Proves:
#  1. not sealed: mm.paseo reads the input's file at the start, as before (its path in the environment, not passed on)
#  2. sealed: mm.paseo starts through `mm vault run _machine claude-oauth-token`: no file path or value in the base file;
#     the daemon gets the token in its environment; the opened file is gone before the daemon runs; no value in an output
#  3. `mm vault run _machine`: only a machine secret input mm fills itself, sealed; refused in an agent's shell
#  4. doctor rows: claude-oauth-token says where mm.paseo reads it from (vault or file), never the value; Paseo's own
#     files are checked in mm.paseo's home once managed; the old ~/.paseo: a link to mm's home allowed, a real folder warns
#   test/paseo-token.sh   (needs age + age-keygen)
set -uo pipefail
unset CLAUDECODE PASEO_AGENT_ID   # the test plays the process manager and the owner in a throwaway HOME
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "age is not installed"; exit 2; }
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); SHM=$(mktemp -d /dev/shm/mmt.XXXX)
trap '[ -n "${KEEP:-}" ] && echo "kept $T $SHM" || rm -rf "$T" "$SHM"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_LAYOUT=one-root XDG_RUNTIME_DIR="$SHM"
printf 'Filename\tType\tSize\tUsed\tPriority\n' >"$T/swaps"; export MM_PROC_SWAPS="$T/swaps"   # no swap: not this test's
M="$MM_HOME"; mkdir -p "$M/bin" "$M/npm/bin" "$M/pc" "$T/bin"; chmod 700 "$HOME"
printf '#!/bin/sh\nexec %s %s/src/cli.ts "$@"\n' "$BUN" "$SRC" >"$T/bin/mm"; chmod +x "$T/bin/mm"
export PATH="$T/bin:$(dirname "$BUN"):/usr/bin:/bin"
cfg() { printf '%s\n' "$@" >"$M/config.yaml"; }
MARK=dummy-tok-5c1e9   # the dummy token: it must never show in a command, the base file or an output
TOKF="$HOME/.config/secrets/claude-oauth.token"
RUNDIR="$SHM/mm/secrets/_run"
# the stub daemon: says whether it got the token (compares, never prints it), whether a file path was passed on, and
# how many opened files are left in _run
cat >"$M/npm/bin/paseo" <<EOF
#!/bin/sh
[ "\$CLAUDE_CODE_OAUTH_TOKEN" = "$MARK" ] && t=match || t=no
echo "umask=\$(umask) token=\$t pfile=\${MM_PASEO_TOKEN_FILE:-unset} vfile=\${CLAUDE_OAUTH_TOKEN_FILE:-unset} left=\$(ls -A "$RUNDIR" 2>/dev/null | wc -l) args=\$*"
EOF
chmod +x "$M/npm/bin/paseo"
cat >"$T/base.ts" <<EOF
import { readFileSync } from 'node:fs'
import { writeBase } from '$SRC/src/pc'
writeBase()
const y = Bun.YAML.parse(readFileSync('$M/pc/base.yaml', 'utf8')) as any
console.log(JSON.stringify(y.processes['mm.paseo'] ?? null))
EOF
envv() { jq -r --arg k "$1" '.environment[] | select(startswith($k + "=")) | sub("^[^=]*="; "")' <<<"$p"; }
# run the command as process-compose would ($$ is its $): the entry's environment over process-compose's own (here only
# the test's runtime folder and swaps file, so nothing opens in the machine's runtime folder)
start() { local cmd; cmd=$(jq -r .command <<<"$p" | sed 's/\$\$/$/g'); env -i XDG_RUNTIME_DIR="$SHM" MM_PROC_SWAPS="$MM_PROC_SWAPS" $(jq -r '.environment[]' <<<"$p" | tr '\n' ' ') bash -c "$cmd" 2>&1; }
cat >"$T/need.ts" <<EOF
import { needs } from '$SRC/src/inputs'
const n = needs().find((x) => x.name === process.argv[2])
console.log(JSON.stringify(n))
EOF
need() { "$BUN" "$T/need.ts" "$1"; }
clean() { ! grep -qF "$MARK" <<<"$1"; }

cfg 'layout: one-root' 'paseo:' '  managed: true' '  listen: 127.0.0.1:1'
mkdir -p "$(dirname "$TOKF")"; printf '%s' "$MARK" >"$TOKF"; chmod 600 "$TOKF"

echo "== 1. not sealed: the input's file"
r=$(need claude-oauth-token)
is "doctor (no base file yet): mm.paseo will read it from its file" grep -qF "mm.paseo will read it from its file" <<<"$r"
p=$("$BUN" "$T/base.ts")
is "the command is the daemon's shell, no vault run" bash -c '! grep -q "vault run" <<<"$1" && grep -q "daemon run" <<<"$1"' _ "$(jq -r .command <<<"$p")"
is "MM_PASEO_TOKEN_FILE is the input's path" [ "$(envv MM_PASEO_TOKEN_FILE)" = "$TOKF" ]
out=$(start)
is "the daemon gets the token, the path not passed on, umask 077" grep -q "umask=0077 token=match pfile=unset vfile=unset" <<<"$out"
r=$(need claude-oauth-token)
is "doctor: filled; mm.paseo reads it from its file" bash -c 'jq -e ".status == \"filled\"" <<<"$1" >/dev/null && grep -qF "mm.paseo reads it from its file\"" <<<"$1"' _ "$r"
is "...no value in it" clean "$r"

echo "== 2. sealed: through the vault"
age-keygen -o "$T/recovery.key" 2>/dev/null
mm vault init --recovery "$(age-keygen -y "$T/recovery.key")" >/dev/null 2>&1 || bad "vault init"
printf "import { seal } from '%s/src/vault'\nseal('claude-oauth-token', Buffer.from(await Bun.stdin.text()))\n" "$SRC" >"$T/seal.ts"
printf '%s' "$MARK" | "$BUN" "$T/seal.ts" || bad "seal"
r=$(need claude-oauth-token)
is "doctor, sealed but the base file still reads the file: says the next mm up switches" grep -qF "mm.paseo reads it from its file (the next mm up: from the vault)" <<<"$r"
p=$("$BUN" "$T/base.ts")
c=$(jq -r .command <<<"$p")
is "the command: mm vault run _machine claude-oauth-token -- sh -c ... daemon run" grep -qE "^$T/bin/mm vault run _machine claude-oauth-token -- sh -c '.*exec $M/npm/bin/paseo daemon run'\$" <<<"$c"
is "...no token file path in its environment" [ -z "$(envv MM_PASEO_TOKEN_FILE)$(envv CLAUDE_OAUTH_TOKEN_FILE)" ]
is "...neither the value nor the input's path in the base file" bash -c '! grep -qF "$1" "$3" && ! grep -qF "$2" "$3"' _ "$MARK" "$TOKF" "$M/pc/base.yaml"
rm -f "$TOKF"   # the file gone: only the vault has it now
out=$(start)
is "the daemon gets the token from the vault (no file left behind)" grep -q "umask=0077 token=match pfile=unset vfile=unset left=0 args=daemon run" <<<"$out"
[ -n "${DEBUG:-}" ] && echo "    $out"
is "...the opened file removed after the run too" bash -c '[ -d "$1" ] && [ -z "$(ls -A "$1")" ]' _ "$RUNDIR"
is "...no value in the output" clean "$out"
r=$(need claude-oauth-token)
is "doctor: sealed (no file), mm.paseo reads it from the vault" bash -c 'jq -e ".status == \"sealed\"" <<<"$1" >/dev/null && grep -qF "no file; sealed (vault/claude-oauth-token.age); mm.paseo reads it from the vault\"" <<<"$1"' _ "$r"
is "...nothing to fill, no value" bash -c 'jq -e ".fill == \"\"" <<<"$1" >/dev/null' _ "$r" && clean "$r"
cfg 'layout: one-root'
r=$(need claude-oauth-token)
is "paseo.managed off: the row says nothing of mm.paseo" bash -c '! jq -r .detail <<<"$1" | grep -q "mm.paseo"' _ "$r"
cfg 'layout: one-root' 'paseo:' '  managed: true' '  listen: 127.0.0.1:1'

echo "== 3. mm vault run _machine: what it opens"
v() { mm vault run _machine "$@" >"$T/v.out" 2>&1; echo $?; }; export -f v; export T
is "a managed_by input (paseo-keypair): refused" bash -c '[ "$(v paseo-keypair -- true)" = 1 ] && grep -q "not a machine secret input" "$1"' _ "$T/v.out"
is "a var input (telegram_owner_id): refused" [ "$(v telegram_owner_id -- true)" = 1 ]
is "no such input: refused" [ "$(v nope -- true)" = 1 ]
is "a machine secret input not sealed (telegram-bot-token): refused" bash -c '[ "$(v telegram-bot-token -- true)" = 1 ] && grep -q "not sealed" "$1"' _ "$T/v.out"
is "no command: refused" [ "$(v claude-oauth-token)" = 1 ]
is "the command's exit code is passed on, the file removed" bash -c '[ "$(v claude-oauth-token -- sh -c "test -s \"\$CLAUDE_OAUTH_TOKEN_FILE\" && exit 7")" = 7 ] && [ -d "$1" ] && [ -z "$(ls -A "$1")" ]' _ "$RUNDIR"
is "in an agent's shell: refused" bash -c '[ "$(CLAUDECODE=1 mm vault run _machine claude-oauth-token -- true >/dev/null 2>&1; echo $?)" = 1 ]'
is "no value in any of it" clean "$(cat "$T/v.out")"

echo "== 4. Paseo's own files and the old home"
S="$M/paseo/system"; O="$HOME/.paseo"
printf '%s\n' x >"$S/daemon-keypair.json"; chmod 600 "$S/daemon-keypair.json"
r=$(need paseo-keypair)
is "managed: the keypair is checked in mm.paseo's home" bash -c 'jq -e ".status == \"managed\"" <<<"$1" >/dev/null && grep -qF "~/.mm/paseo/system/daemon-keypair.json (made by paseo)" <<<"$1"' _ "$r"
r=$(need paseo-credential)
is "...the credential not there yet: missing, named there" bash -c 'jq -e ".status == \"missing\"" <<<"$1" >/dev/null && grep -qF "~/.mm/paseo/system/local-credential" <<<"$1"' _ "$r"
cfg 'layout: one-root'
r=$(need paseo-keypair)
is "not managed: checked in ~/.paseo" grep -qF '"detail":"~/.paseo/daemon-keypair.json (made by paseo)"' <<<"$r"
cat >"$T/out.ts" <<EOF
import { outsideChecks } from '$SRC/src/outside'
console.log(JSON.stringify(outsideChecks().find((r) => r.item === 'Paseo home') ?? null))
EOF
row() { "$BUN" "$T/out.ts"; }
mkdir -p "$O"
r=$(row)
is "not managed, ~/.paseo a folder: warn, still the daemon's" bash -c 'jq -e ".status == \"warn\"" <<<"$1" >/dev/null && grep -q "paseo.service today" <<<"$1"' _ "$r"
cfg 'layout: one-root' 'paseo:' '  managed: true'
r=$(row)
is "managed, ~/.paseo a real folder left: warn (the rollback; remove it)" bash -c 'jq -e ".status == \"warn\"" <<<"$1" >/dev/null && grep -q "left as the rollback" <<<"$1" && grep -q "rm -r ~/.paseo" <<<"$1"' _ "$r"
rmdir "$O"; ln -s "$S" "$O"
r=$(row)
is "managed, ~/.paseo a link to mm's home: ok (allowed)" bash -c 'jq -e ".status == \"ok\"" <<<"$1" >/dev/null && grep -q "a link to mm.paseo" <<<"$1"' _ "$r"
rm "$O"; ln -s "$T" "$O"
r=$(row)
is "managed, ~/.paseo a link elsewhere: warn" bash -c 'jq -e ".status == \"warn\"" <<<"$1" >/dev/null' _ "$r"
rm "$O"
is "managed, ~/.paseo gone: no row" [ "$(row)" = null ]

echo
echo "paseo-token: $pass passed, $fail failed"
[ "$fail" = 0 ]
