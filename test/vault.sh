#!/usr/bin/env bash
# The vault, hermetic: a throwaway HOME / MM_HOME, a fake project, a memory-backed runtime folder (/dev/shm), and a
# test recovery key standing in for the human's offline one. Needs age + age-keygen installed.
#   test/vault.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
command -v age >/dev/null && command -v age-keygen >/dev/null || { echo "age is not installed"; exit 2; }
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); SHM=$(mktemp -d /dev/shm/mmv.XXXX); trap 'rm -rf "$T" "$SHM"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" XDG_RUNTIME_DIR="$SHM"
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
check "mm doctor reports the vault: modes and digests ok, the secrets folder memory-backed" bash -c "mm doctor -o json 2>/dev/null | jq -e '[.[] | select(.layer==\"vault\")] | (map(select(.item==\"vault\")) | length > 0 and all(.status==\"ok\")) and (map(select(.item==\"secrets folder\" and .status==\"ok\")) | length == 1)'"
cp "$MM_HOME/vault/acme-shop.api_key.age" "$T/good.age"; printf 'x' >>"$MM_HOME/vault/acme-shop.api_key.age"
check "a changed sealed file is refused (digest)" bash -c "! mm vault run acme-shop API_KEY -- true && mm vault check | grep -q FAIL"
cp "$T/good.age" "$MM_HOME/vault/acme-shop.api_key.age"; chmod 600 "$MM_HOME/vault/acme-shop.api_key.age"
check "mm vault check: ok again" mm vault check

echo '== no value anywhere'
check "no output contains the value" bash -c "! grep -q '$V' '$LOG'"
check "no file under MM_HOME contains it in the clear" bash -c "! grep -rq '$V' '$MM_HOME'"
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
