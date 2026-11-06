#!/usr/bin/env bash
# Zero side effects (sy-8w1), hermetic: a throwaway HOME / MM_HOME, stub tools first on PATH (process-compose, systemctl,
# npm, sudo, ...: nothing reaches the machine's process manager, systemd or package manager), a local server for the
# claude download. Proves:
#  1. a fresh onboard writes nothing in the home folder outside MM_HOME but the boot unit and the PATH lines (every file
#     listed); the launcher and mm's own process-compose calls carry the tools' folders under MM_HOME; portless'
#     state is MM_HOME's in every definition (mm.portless and a project's)
#  2. doctor's "outside $MM_HOME" check: ok for the allowed ones; a planted old path, an old npm prefix's tool, an old
#     tool store, as warn with the move
#  3. the move of an old layout (~/.portless, ~/.config/process-compose): by rename, a link left only while the process
#     manager runs, removed once it restarted; refused when both are there; idempotent; only by onboard and doctor
#     --fix: mm up moves nothing (it keeps the old ~/.portless meanwhile); a secret's file outside: warn, the vault's
#  4. installs stay in MM_HOME: npm's cache (onboard reinstalls a tool found in ~/.npm-global), claude's release binary
#     (checksum checked, a wrong one refused)
#   test/outside.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d)
cleanup() { rm -rf "$T"; }
trap cleanup EXIT
[ -n "${KEEP:-}" ] && trap - EXIT && echo "kept: $T"
MMC=${1:-"$BUN $SRC/src/cli.ts"}
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 MM_OBS_TRACES="" MM_SECRETS_DIR="$T/run/secrets" XDG_RUNTIME_DIR="$T/run"
unset PORTLESS_STATE_DIR PROC_COMP_CONFIG PC_CLIENT_LOG_FILE MM_LAYOUT XDG_CONFIG_HOME
mkdir -p "$T/bin" "$T/run"
ln -s "$BUN" "$T/bin/bun"
# every manifest tool answers its version; the ones mm calls for more get their own stub below
command -v jq >/dev/null || { echo 'needs jq'; exit 2; }
for t in git curl tar xz age tmux bwrap socat node claude paseo portless merman-cli victoria-metrics victoria-logs victoria-traces docker cloudflared tailscale python3; do
  printf '#!/bin/sh\necho "%s 99.0.0"\n' "$t" >"$T/bin/$t"; chmod +x "$T/bin/$t"
done
printf '#!/bin/sh\necho "tailscale 99.0.0"; [ "$1" = version ]\n' >"$T/bin/tailscale"
cat >"$T/bin/process-compose" <<EOF
#!/bin/sh
# the stub process manager: answers while $T/pc.up exists; says which folders a call was given
echo "PROC_COMP_CONFIG=\$PROC_COMP_CONFIG PC_CLIENT_LOG_FILE=\$PC_CLIENT_LOG_FILE PORTLESS_STATE_DIR=\$PORTLESS_STATE_DIR" >>"$T/pc.env"
case "\$*" in *"version --short"*) echo 1.124.0; exit 0 ;; esac
[ -e "$T/pc.up" ]
EOF
cat >"$T/bin/systemctl" <<EOF
#!/bin/sh
echo "\$*" >>"$T/systemctl.calls"
case "\$*" in *is-system-running*) echo running ;; *is-enabled*) echo enabled ;; *is-active*) echo inactive ;; esac
exit 0
EOF
printf '#!/bin/sh\necho yes\n' >"$T/bin/loginctl"
printf '#!/bin/sh\nmkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/gh"; echo gh-state >"${XDG_STATE_HOME:-$HOME/.local/state}/gh/device-id"; exit 1\n' >"$T/bin/gh"   # like gh: a state file at each call
printf '#!/bin/sh\necho "$*" >>"%s/sudo.calls"\nexit 1\n' "$T" >"$T/bin/sudo"
cat >"$T/bin/npm" <<EOF
#!/bin/sh
# the stub npm: says where its cache is; an install -g --prefix P <pkg> makes P/bin/<name>
echo "npm_config_cache=\$npm_config_cache update_notifier=\$npm_config_update_notifier args=\$*" >>"$T/npm.calls"
case "\$1" in --version) echo 11.19.0; exit 0 ;; esac
prefix=; pkg=; while [ \$# -gt 0 ]; do case "\$1" in --prefix) prefix=\$2; shift ;; -*|install) ;; *) pkg=\$1 ;; esac; shift; done
name=\${pkg%@*}; name=\${name##*/}; [ "\$name" = cli ] && name=paseo
mkdir -p "\$prefix/bin"; printf '#!/bin/sh\necho "%s 99.0.0"\n' "\$name" >"\$prefix/bin/\$name"; chmod +x "\$prefix/bin/\$name"
EOF
chmod +x "$T/bin/"*
ln -s "$(command -v jq)" "$T/bin/jq"
export PATH="$T/bin:/usr/bin:/bin"
newhome() { export HOME="$T/$1" MM_HOME="$T/$1/.mm"; mkdir -p "$HOME"; rm -f "$T/pc.env" "$T/npm.calls"; }
mmc() { $MMC "$@"; }
# what is in the home folder outside MM_HOME (files and links; folders only as their path)
outside_files() { (cd "$HOME" && find . -path ./.mm -prune -o ! -type d -print | sed 's|^\./||' | sort | tr '\n' ' '); }

echo "== 1. a fresh onboard: nothing outside MM_HOME but the boot unit and the PATH lines"
newhome fresh; touch "$T/pc.up"
mmc onboard -y --access tailscale >"$T/onboard.out" 2>&1
got=$(outside_files)
is "every file under HOME outside MM_HOME: .bashrc .profile .config/systemd/user/mm-pc.service (got: $got)" \
  [ "$got" = ".bashrc .config/systemd/user/mm-pc.service .profile " ]
is "...no ~/.config/process-compose, ~/.portless, ~/.npm, ~/.local" bash -c "! [ -e '$HOME/.config/process-compose' ] && ! [ -e '$HOME/.portless' ] && ! [ -e '$HOME/.npm' ] && ! [ -e '$HOME/.local' ]"
is "no sudo was run" bash -c "! [ -e '$T/sudo.calls' ]"
L="$MM_HOME/bin/mm-pc-up"
is "the launcher exports portless' state, process-compose's settings and its client log, all under MM_HOME" \
  bash -c "grep -qx 'export PORTLESS_STATE_DIR=\"$MM_HOME/portless\"' '$L' && grep -qx 'export PROC_COMP_CONFIG=\"$MM_HOME/pc/config\"' '$L' && grep -qx 'export PC_CLIENT_LOG_FILE=\"$MM_HOME/pc/client.log\"' '$L'"
is "mm's own process-compose calls had the same (never the defaults in ~/.config or /tmp)" \
  bash -c "[ -s '$T/pc.env' ] && ! grep -v 'PROC_COMP_CONFIG=$MM_HOME/pc/config PC_CLIENT_LOG_FILE=$MM_HOME/pc/client.log PORTLESS_STATE_DIR=$MM_HOME/portless' '$T/pc.env'"
is "the boot unit is written and enabled (the stub systemctl)" bash -c "[ -s '$HOME/.config/systemd/user/mm-pc.service' ] && grep -q 'enable --now mm-pc.service' '$T/systemctl.calls'"
"$BUN" -e "
  import { writeBase } from '$SRC/src/pc.ts'
  import { serviceProcess } from '$SRC/src/project.ts'
  writeBase()
  const y = Bun.YAML.parse(await Bun.file('$MM_HOME/pc/base.yaml').text())
  const s = { command: 'node server.js', port: 'http' }
  const p = serviceProcess('/p', 'acme', 'app', s, { app: s }, { env: { PORTLESS_STATE_DIR: '$MM_HOME/portless' }, socket: '/p/.dolt/mysql.sock', pdeath: '' })
  console.log(JSON.stringify({ base: y.processes['mm.portless'].environment, project: p.environment }))" >"$T/defs.json" 2>"$T/defs.err" || bad "writeBase/serviceProcess: $(cat "$T/defs.err")"
is "mm.portless runs with PORTLESS_STATE_DIR=MM_HOME/portless" bash -c "jq -e --arg v 'PORTLESS_STATE_DIR=$MM_HOME/portless' '.base | index(\$v)' '$T/defs.json' >/dev/null"
is "up() gives a project's portless wrappers the same (src/project.ts env)" bash -c "grep -q 'PORTLESS_STATE_DIR: portlessDir(),' '$SRC/src/project.ts'"
mmc doctor -o json >"$T/doc1.json" 2>/dev/null
is "doctor: the boot unit and both PATH lines are listed as allowed (ok)" \
  bash -c "[ \$(jq '[.[] | select(.layer == \"outside\" and .status == \"ok\" and (.item == \"boot unit\" or .item == \"PATH line\"))] | length' '$T/doc1.json') = 3 ]"
is "doctor: nothing outside warns on a fresh box" bash -c "[ \$(jq '[.[] | select(.layer == \"outside\" and .status != \"ok\")] | length' '$T/doc1.json') = 0 ]"

echo "== 2. doctor lists what an older box left outside, as warn with its move"
newhome old; touch "$T/pc.up"
mkdir -p "$HOME/.portless" "$HOME/.config/process-compose" "$HOME/.npm-global/bin" "$HOME/.local/share/victoria-logs/v1"
echo '{"routes":[]}' >"$HOME/.portless/routes.json"; echo 'theme: x' >"$HOME/.config/process-compose/settings.yaml"
printf '#!/bin/sh\necho "portless 0.15.13"\n' >"$HOME/.npm-global/bin/portless"; chmod +x "$HOME/.npm-global/bin/portless"
mmc doctor -o json >"$T/doc2.json" 2>/dev/null
row() { jq -r --arg i "$1" '[.[] | select(.layer == "outside" and .item == $i)][0] | "\(.status) \(.detail) | \(.fix)"' "$T/doc2.json"; }
is "~/.portless: warn, kept in ~/.mm/portless, fix doctor --fix ($(row 'portless state'))" bash -c "row() { jq -r --arg i \"\$1\" '[.[] | select(.layer == \"outside\" and .item == \$i)][0] | \"\(.status) \(.detail) | \(.fix)\"' '$T/doc2.json'; }; row 'portless state' | grep -q '^warn ~/.portless: .*~/.mm/portless | mm doctor --fix'"
is "~/.config/process-compose: warn, kept in ~/.mm/pc/config" bash -c "jq -e '.[] | select(.item == \"process-compose config\" and .status == \"warn\" and (.detail | test(\"~/.mm/pc/config\")))' '$T/doc2.json' >/dev/null"
is "portless run from ~/.npm-global: warn, fix mm onboard" bash -c "jq -e '.[] | select(.item == \"tool portless\" and .status == \"warn\" and (.detail | test(\"~/.npm-global/bin/portless\")) and (.fix | test(\"mm onboard\")))' '$T/doc2.json' >/dev/null"
is "the old npm prefix and the old tool store: warn, removed by hand" bash -c "jq -e '[.[] | select((.item == \"npm tools (old prefix)\" or .item == \"tool store victoria-logs\") and .status == \"warn\" and (.fix | test(\"^rm -r \")))] | length == 2' '$T/doc2.json' >/dev/null"
is "a secret input's file outside MM_HOME: warn, the vault takes it, mm never moves it" bash -c "mkdir -p '$HOME/.config/secrets' && printf test-dummy >'$HOME/.config/secrets/claude-oauth.token' && chmod 600 '$HOME/.config/secrets/claude-oauth.token' && $MMC doctor -o json 2>/dev/null | jq -e '.[] | select(.layer == \"outside\" and .item == \"secret\" and .status == \"warn\" and (.detail | test(\"claude-oauth.token.*the vault takes it\")) and (.fix | test(\"never moves\")))' >/dev/null; rc=\$?; rm -rf '$HOME/.config/secrets'; exit \$rc"
"$BUN" -e "
  import { up } from '$SRC/src/project.ts'
  try { up('$T/no-such-project') } catch {}" >/dev/null 2>&1
is "mm up moves nothing: ~/.portless and ~/.config/process-compose stay real folders (only onboard and doctor --fix move)" \
  bash -c "[ -d '$HOME/.portless' ] && ! [ -L '$HOME/.portless' ] && [ -f '$HOME/.portless/routes.json' ] && [ -d '$HOME/.config/process-compose' ] && ! [ -e '$MM_HOME/portless' ] && ! [ -e '$MM_HOME/pc/config' ]"
is "...and gives the projects' wrappers the old ~/.portless meanwhile (one folder for all)" \
  bash -c "\"$BUN\" -e \"import { portlessDir } from '$SRC/src/env.ts'; console.log(portlessDir())\" | grep -qx '$HOME/.portless'"

echo "== 3. the move: by rename, a link only while the process manager runs, idempotent"
rm -f "$T/pc.up"   # not running: nothing can use the old paths
mmc doctor --fix >"$T/fix1.out" 2>&1
is "~/.portless moved (its file with it), no link left" bash -c "[ -f '$MM_HOME/portless/routes.json' ] && ! [ -e '$HOME/.portless' ] && ! [ -L '$HOME/.portless' ]"
is "~/.config/process-compose moved to ~/.mm/pc/config" bash -c "[ -f '$MM_HOME/pc/config/settings.yaml' ] && ! [ -e '$HOME/.config/process-compose' ]"
is "...and said so" bash -c "grep -q 'move portless state' '$T/fix1.out' && grep -q '~/.portless -> ~/.mm/portless' '$T/fix1.out'"
is "the old npm prefix and tool store are not moved (not only mm's)" bash -c "[ -x '$HOME/.npm-global/bin/portless' ] && [ -d '$HOME/.local/share/victoria-logs/v1' ]"
before=$(cd "$T/old" && find . | sort | md5sum)
mmc doctor --fix >"$T/fix2.out" 2>&1
is "again: nothing to move, nothing changed" bash -c "grep -q 'nothing to move' '$T/fix2.out' && [ \"\$(cd '$T/old' && find . | sort | md5sum)\" = '$before' ]"
mkdir -p "$HOME/.portless"; echo x >"$HOME/.portless/stale"
mmc doctor --fix >"$T/fix3.out" 2>&1; rc=$?
is "both ~/.portless and ~/.mm/portless there: refused, says why, exit 1, nothing touched" \
  bash -c "[ $rc = 1 ] && grep -q 'both ~/.portless and ~/.mm/portless are there' '$T/fix3.out' && [ -f '$HOME/.portless/stale' ] && [ -f '$MM_HOME/portless/routes.json' ]"
"$BUN" -e "import { writeBase } from '$SRC/src/pc.ts'; writeBase()"
is "...while ~/.portless is a real folder, the proxy and the launcher keep using it (one folder for all, never split)" \
  bash -c "grep -q 'PORTLESS_STATE_DIR=$HOME/.portless' '$MM_HOME/pc/base.yaml' && grep -qx 'export PORTLESS_STATE_DIR=\"$HOME/.portless\"' '$MM_HOME/bin/mm-pc-up'"
ob_out=$("$BUN" -e "import { moveOutside } from '$SRC/src/outside.ts'; console.log(JSON.stringify(moveOutside()))")
is "onboard's move (moveOutside) refuses the same way, without unlinking or moving" bash -c "echo '$ob_out' | jq -e 'length == 1 and .[0].status == \"refused\"' >/dev/null"

newhome live; touch "$T/pc.up"   # the process manager runs: a link is left for its processes
mkdir -p "$HOME/.portless" "$MM_HOME/portless"; echo '{}' >"$HOME/.portless/routes.json"   # an empty target is fine
"$BUN" -e "import { writeLauncher } from '$SRC/src/pc.ts'; writeLauncher()"
mmc doctor --fix >"$T/fix4.out" 2>&1
is "running: moved into the empty ~/.mm/portless, a link left at ~/.portless to it" \
  bash -c "[ -f '$MM_HOME/portless/routes.json' ] && [ -L '$HOME/.portless' ] && [ \"\$(readlink '$HOME/.portless')\" = '$MM_HOME/portless' ] && [ -f '$HOME/.portless/routes.json' ]"
is "...no temp link left behind" bash -c "! ls -a '$HOME' | grep -q mm-link"
touch -d '-1 minute' "$MM_HOME/pc.sock"   # the process manager started before the move
mmc doctor --fix >"$T/fix5.out" 2>&1
is "not restarted since: the link stays (and says until when)" bash -c "[ -L '$HOME/.portless' ] && grep -q 'stays until the process manager restarts' '$T/fix5.out'"
mmc doctor -o json >"$T/doc3.json" 2>/dev/null
is "doctor shows the link as warn, to remove after the restart" bash -c "jq -e '.[] | select(.item == \"portless state\" and .status == \"warn\" and (.detail | test(\"link mm left\")) and (.fix | test(\"after the process manager restarts\")))' '$T/doc3.json' >/dev/null"
touch -d '+1 minute' "$MM_HOME/pc.sock"   # restarted (its socket is new) from the launcher that exports the folders
mmc doctor --fix >"$T/fix6.out" 2>&1
is "restarted: the link is removed; the state stays in ~/.mm/portless" bash -c "! [ -e '$HOME/.portless' ] && ! [ -L '$HOME/.portless' ] && [ -f '$MM_HOME/portless/routes.json' ]"
mmc doctor --fix >"$T/fix7.out" 2>&1
is "again: nothing to move" grep -q 'nothing to move' "$T/fix7.out"
mkdir -p "$T/elsewhere"; ln -s "$T/elsewhere" "$HOME/.portless"
mmc doctor --fix >"$T/fix8.out" 2>&1
is "a link that isn't mm's: refused, left as it is" bash -c "grep -q 'is a link, not mm' '$T/fix8.out' && [ \"\$(readlink '$HOME/.portless')\" = '$T/elsewhere' ]"

echo "== 4. installs stay in MM_HOME"
newhome npmold; touch "$T/pc.up"
mkdir -p "$HOME/.npm-global/bin"; printf '#!/bin/sh\necho "portless 0.15.13"\n' >"$HOME/.npm-global/bin/portless"; chmod +x "$HOME/.npm-global/bin/portless"
mmc onboard -y --access tailscale >"$T/onboard2.out" 2>&1
is "onboard reinstalls a tool found in ~/.npm-global into ~/.mm/npm" bash -c "grep -q 'args=install -g --prefix $MM_HOME/npm .*portless@0.15.13' '$T/npm.calls' && [ -x '$MM_HOME/bin/portless' ]"
is "...with npm's cache under ~/.mm/npm and no update check" bash -c "! grep -v 'npm_config_cache=$MM_HOME/npm/.cache update_notifier=false' '$T/npm.calls' | grep -q 'args=install'"
is "...and the old prefix is left alone" [ -x "$HOME/.npm-global/bin/portless" ]
mmc doctor -o json >"$T/doc4.json" 2>/dev/null
is "doctor: portless now runs from MM_HOME (no tool warning)" bash -c "! jq -e '.[] | select(.item == \"tool portless\")' '$T/doc4.json' >/dev/null"
newhome claude
cat >"$T/claude-dist.ts" <<'EOF'
// a local stand-in for Claude Code's release server: a manifest with the binary's sha256, and the binary
const [src, mode] = [process.argv[2], process.argv[3]]
const { claudeDist } = await import(`${src}/src/install.ts`)
const { archNames } = await import(`${src}/src/env.ts`)
const bin = new TextEncoder().encode('#!/bin/sh\necho "2.1.318 (Claude Code)"\n')
const sha = new Bun.CryptoHasher('sha256').update(mode === 'bad' ? 'something else' : bin).digest('hex')
const platform = `linux-${archNames.node}`
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
  const p = new URL(req.url).pathname
  if (p === '/2.1.318/manifest.json') return Response.json({ version: '2.1.318', platforms: { [platform]: { checksum: sha, size: bin.length } } })
  if (p === `/2.1.318/${platform}/claude`) return new Response(bin)
  return new Response('no', { status: 404 })
} })
try { console.log(await claudeDist('2.1.318', `http://127.0.0.1:${server.port}`)) } catch (e) { console.log(`refused: ${(e as Error).message}`) } finally { server.stop(true) }
EOF
out=$("$BUN" "$T/claude-dist.ts" "$SRC" good 2>&1)
is "claude: the release binary into ~/.mm/tools/claude/<version>, linked into ~/.mm/bin ($out)" \
  bash -c "[ -x '$MM_HOME/tools/claude/2.1.318/claude' ] && [ \"\$(readlink '$MM_HOME/bin/claude')\" = '$MM_HOME/tools/claude/2.1.318/claude' ] && '$MM_HOME/bin/claude' | grep -q 2.1.318"
is "...nothing in the home folder outside MM_HOME ($(outside_files))" [ -z "$(outside_files)" ]
newhome claudebad
out=$("$BUN" "$T/claude-dist.ts" "$SRC" bad 2>&1)
is "a checksum that doesn't match: refused, nothing installed ($out)" bash -c "echo '$out' | grep -q 'checksum mismatch' && ! [ -e '$MM_HOME/bin/claude' ] && ! ls '$MM_HOME/tools/claude/2.1.318/' 2>/dev/null | grep -q ."

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
