#!/usr/bin/env bash
# The vault, hermetic: a throwaway HOME / MM_HOME, a fake project, a memory-backed runtime folder (/dev/shm), and a
# test recovery key standing in for the human's offline one. Needs age + age-keygen installed.
#   test/vault.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
# the test plays the owner in a throwaway HOME: vault init and run refuse in an agent's shell (sy-uvgq), so not one here
unset CLAUDECODE PASEO_AGENT_ID
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "age is not installed"; exit 2; }
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); SHM=$(mktemp -d /dev/shm/mmv.XXXX); trap 'rm -rf "$T" "$SHM"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" XDG_RUNTIME_DIR="$SHM"
# this machine's swap is not this test's: a stand-in /proc/swaps with none on (vault: opened secrets only where swap cannot reach, sy-rjwg 6)
printf 'Filename\tType\tSize\tUsed\tPriority\n' >"$T/swaps"; export MM_PROC_SWAPS="$T/swaps"
mkdir -p "$MM_HOME/pc/projects" "$T/bin" "$T/proj"
printf '#!/bin/sh\nexec %s "$@"\n' "$MMC" >"$T/bin/mm"; chmod +x "$T/bin/mm"; export PATH="$T/bin:$PATH"
echo "# from $T/proj/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"
echo '{"required":[{"name":"API_KEY","for":"app"}],"optional":[]}' >"$T/proj/secrets.json"
LOG="$T/out"; V='v4ult-secret-81723'
age-keygen -o "$T/recovery.key" 2>/dev/null; REC=$(age-keygen -y "$T/recovery.key")

echo '== init'
check "a secret key is refused as the recovery key" bash -c "! mm vault init --recovery \"\$(tail -1 '$T/recovery.key')\""
mm vault init --recovery "$REC" >>"$LOG" 2>&1 && ok "init with the recovery public key" || bad "init"
check "vault/ 0700, key and recipients 0600" bash -c "[ \$(stat -c %a '$MM_HOME/vault') = 700 ] && [ \$(stat -c %a '$MM_HOME/vault/key') = 600 ] && [ \$(stat -c %a '$MM_HOME/vault/recipients.txt') = 600 ]"
check "both recipients recorded" bash -c "grep -c '^age1' '$MM_HOME/vault/recipients.txt' | grep -qx 2 && grep -q '$REC' '$MM_HOME/vault/recipients.txt'"
check "a second init is refused (it would orphan what's sealed)" bash -c "! mm vault init --recovery '$REC'"

echo '== seal'
printf '%s' "$V" | mm fill acme-shop:API_KEY >>"$LOG" 2>&1 && ok "mm fill seals a project secret (from a pipe)" || bad "fill"
check "sealed, 0600; no plaintext file in the project" bash -c "[ \$(stat -c %a '$MM_HOME/vault/acme-shop.api_key.age') = 600 ] && [ ! -e '$T/proj/secrets/API_KEY' ]"
check "the sealed file doesn't contain the value" bash -c "! grep -q '$V' '$MM_HOME/vault/acme-shop.api_key.age'"
check "mm needs shows it sealed" bash -c "mm needs -p acme-shop -o json | jq -e '.[] | select(.name==\"API_KEY\") | .status == \"sealed\"'"
check "mm vault ls: name and digest, intact" bash -c "mm vault ls -o json | jq -e '.[] | select(.name==\"acme-shop.api_key\") | .intact'"
check "the human's recovery key opens it (offline restore path)" bash -c "[ \"\$(age -d -i '$T/recovery.key' '$MM_HOME/vault/acme-shop.api_key.age')\" = '$V' ]"
check "no reseal without --replace" bash -c "! printf x | mm fill acme-shop:API_KEY"

echo '== open at start'
OUT=$(mm vault run acme-shop API_KEY -- sh -c 'cat "$API_KEY_FILE"; printf " %s" "$(stat -c %a "$API_KEY_FILE")"' 2>>"$LOG")
check "the service reads it from <NAME>_FILE" test "${OUT% *}" = "$V"
check "...a 0600 file" test "${OUT##* }" = 600
check "...in a memory-backed folder (0700)" bash -c "[ \"\$(stat -f -c %T '$SHM')\" = tmpfs ] && [ \$(stat -c %a '$SHM/mm/secrets/acme-shop') = 700 ]"
check "not on disk: refused when the runtime folder isn't tmpfs" bash -c "! XDG_RUNTIME_DIR='$T' mm vault run acme-shop API_KEY -- true"
check "MM_SECRETS_DIR (e.g. a noswap tmpfs) is where it opens" bash -c "MM_SECRETS_DIR='$SHM/noswap' mm vault run acme-shop API_KEY -- sh -c 'case \"\$API_KEY_FILE\" in '$SHM'/noswap/acme-shop/*) exit 0;; *) exit 1;; esac'"
check "...and it is refused there too when that isn't tmpfs" bash -c "! MM_SECRETS_DIR='$T/disk' mm vault run acme-shop API_KEY -- true"
# swap on, plain (not dm-crypt), and the tmpfs not mounted noswap: an opened secret could be paged out to disk (sy-rjwg 6)
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/mm-test-noswap-dev partition 524284 0 -2\n' >"$T/swaps-on"
if findmnt -no OPTIONS -T "$SHM" | grep -qE '(^|,)noswap(,|$)'; then ok "(skipped: this machine's /dev/shm is noswap)"; ok "(skipped)"; else
check "swap on (plain) and the tmpfs not noswap: refused, it says why, nothing opened" bash -c "! MM_PROC_SWAPS='$T/swaps-on' mm vault run acme-shop API_KEY -- true 2>'$T/sw.err' && grep -q 'not mounted noswap' '$T/sw.err'"
check "...a person's run file too (openForRun): refused, no file in _run/" bash -c "! MM_PROC_SWAPS='$T/swaps-on' bun -e \"import { openForRun } from '$SRC/src/vault'; openForRun('acme-shop.api_key')\" 2>'$T/sw2.err' && grep -q 'not mounted noswap' '$T/sw2.err' && [ -z \"\$(ls -A '$SHM/mm/secrets/_run' 2>/dev/null)\" ]"
fi
check "no swap on: it opens (as above)" bash -c "mm vault run acme-shop API_KEY -- true"
check "mm doctor reports the vault: modes and digests ok, the secrets folder memory-backed" bash -c "mm doctor -o json 2>/dev/null | jq -e '[.[] | select(.layer==\"vault\")] | (map(select(.item==\"vault\")) | length > 0 and all(.status==\"ok\")) and (map(select(.item==\"secrets folder\" and .status==\"ok\")) | length == 1)'"
cp "$MM_HOME/vault/acme-shop.api_key.age" "$T/good.age"; printf 'x' >>"$MM_HOME/vault/acme-shop.api_key.age"
check "a changed sealed file is refused (digest)" bash -c "! mm vault run acme-shop API_KEY -- true && mm vault check | grep -q FAIL"
cp "$T/good.age" "$MM_HOME/vault/acme-shop.api_key.age"; chmod 600 "$MM_HOME/vault/acme-shop.api_key.age"
check "mm vault check: ok again" mm vault check

echo '== one opened-secrets folder for every call (sy-lt7c)'
# what each caller in mm decides, from the source: the vault's base, the outside list, the secret paths for config-check
cat >"$T/callers.ts" <<EOF
import { outsidePaths, secretsDir } from '$SRC/src/env'
import { machineSecretPaths } from '$SRC/src/inputs'
import * as vault from '$SRC/src/vault'
const s = secretsDir(), o = outsidePaths().find((x) => x.id === 'opened secrets')!.path, sp = machineSecretPaths().dirs
console.log(JSON.stringify({ from: s.from, base: vault.secretsBase(), outside: o, run: vault.runtimeDir('acme-shop'), listed: sp.includes(s.path) }))
EOF
CALLERS="bun '$T/callers.ts' 2>>'$LOG'"
dr() { { mm doctor -o json 2>/dev/null || true; } | jq -e "[.[] | select(.item==\"secrets folder callers\")] | length == 1 and ($1)"; }
export MM_DOCKER_CONF="$T/mm-docker.conf"   # doctor reads the wrapper's config from here, never the machine's /etc one
KEYED="$SHM/kp/keyed"; mkdir -p "$SHM/kp" "$MM_HOME/bin"; chmod 755 "$SHM/kp"
check "no key: the default (the user's runtime folder)" bash -c "$CALLERS | jq -e '.from==\"default\" and .base==\"$SHM/mm/secrets\"'"
check "...doctor: the callers agree" dr '.[0].status=="ok"'
mm config set vault.secrets_dir "$KEYED" >>"$LOG" 2>&1
check "the key wins over the default" bash -c "mm vault run acme-shop API_KEY -- sh -c 'case \"\$API_KEY_FILE\" in $KEYED/acme-shop/*) exit 0;; *) exit 1;; esac'"
check "...every caller gets the key's folder (vault, outside list, config-check's list)" bash -c "$CALLERS | jq -e '.from==\"config\" and .base==\"$KEYED\" and .outside==\"$KEYED\" and .run==\"$KEYED/acme-shop\" and .listed'"
check "...0700; its parent, the machine's, keeps its mode (only the default's mm/ is narrowed)" bash -c "[ \$(stat -c %a '$KEYED') = 700 ] && [ \$(stat -c %a '$SHM/kp') = 755 ]"
check "MM_SECRETS_DIR wins over the key" bash -c "MM_SECRETS_DIR='$SHM/noswap' mm vault run acme-shop API_KEY -- sh -c 'case \"\$API_KEY_FILE\" in '$SHM'/noswap/acme-shop/*) exit 0;; *) exit 1;; esac'"
check "...every caller gets it" bash -c "MM_SECRETS_DIR='$SHM/noswap' $CALLERS | jq -e '.from==\"env\" and .base==\"$SHM/noswap\" and .outside==\"$SHM/noswap\" and .listed'"
check "doctor: the key alone, callers agree" dr '.[0].status=="ok" and (.[0].detail | test("vault.secrets_dir"))'
check "doctor: this call's MM_SECRETS_DIR differs from the key: a warning" bash -c "MM_SECRETS_DIR='$SHM/noswap' mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item==\"secrets folder callers\") | .status==\"warn\" and (.detail | test(\"this call\"))'"
printf '#!/bin/sh\nexport MM_SECRETS_DIR="%s"\nexec true\n' "$SHM/pcdir" >"$MM_HOME/bin/mm-pc-up"
check "doctor: mm-pc's launcher names another folder: a warning" dr '.[0].status=="warn" and (.[0].detail | test("mm-pc-up"))'
printf '#!/bin/sh\nexport MM_SECRETS_DIR="%s"\nexec true\n' "$KEYED" >"$MM_HOME/bin/mm-pc-up"
check "...the same folder: they agree" dr '.[0].status=="ok"'
rm -f "$MM_HOME/bin/mm-pc-up"
printf '#!/bin/sh\ncase "$*" in *is-system-running*) echo running;; *show*mm-pc.service*Environment*) echo "PATH=/usr/bin MM_SECRETS_DIR=%s";; *) exit 1;; esac\n' "$SHM/pcunit" >"$T/bin/systemctl"; chmod +x "$T/bin/systemctl"
check "doctor: MM_SECRETS_DIR in mm-pc's unit differs: a warning" dr '.[0].status=="warn" and (.[0].detail | test("its unit"))'
rm -f "$T/bin/systemctl"
printf 'user = %s\nsecrets = %s\n' "$(id -un)" "$SHM/other" >"$T/mm-docker.conf"
check "doctor: the wrapper's secrets line differs: a warning" bash -c "MM_DOCKER_CONF='$T/mm-docker.conf' mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item==\"secrets folder callers\") | .status==\"warn\" and (.detail | test(\"mm-docker\"))'"
printf 'user = %s\n' "$(id -un)" >"$T/mm-docker.conf"
check "...no secrets line (its default) while the key names another: a warning" bash -c "MM_DOCKER_CONF='$T/mm-docker.conf' mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item==\"secrets folder callers\") | .status==\"warn\" and (.detail | test(\"its default\"))'"
printf 'user = %s\nsecrets = %s/\n' "$(id -un)" "$KEYED" >"$T/mm-docker.conf"
check "...the same folder: they agree" bash -c "MM_DOCKER_CONF='$T/mm-docker.conf' mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item==\"secrets folder callers\") | .status==\"ok\" and (.detail | test(\"mm-docker\"))'"
printf 'user = someone-else\nsecrets = %s\n' "$SHM/other" >"$T/mm-docker.conf"
check "...a wrapper config for another user is not this one's" bash -c "MM_DOCKER_CONF='$T/mm-docker.conf' mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item==\"secrets folder callers\") | .status==\"ok\"'"
mm config set vault.secrets_dir relative/dir >>"$LOG" 2>&1
check "a key that isn't an absolute path is ignored (the default), and doctor names it" bash -c "$CALLERS | jq -e '.from==\"default\"' && mm doctor -o json 2>/dev/null | jq -e '.[] | select(.item==\"secrets folder key\") | .status==\"warn\"'"
mm config unset vault.secrets_dir >>"$LOG" 2>&1

echo '== no value anywhere'
check "no output contains the value" bash -c "! grep -q '$V' '$LOG'"
check "no file under MM_HOME contains it in the clear" bash -c "! grep -rq '$V' '$MM_HOME'"
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
