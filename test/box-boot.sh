#!/usr/bin/env bash
# The boot step for boxes (sy-duj0), hermetic: a throwaway HOME / MM_HOME / secrets base, no Docker. Proves: bootReason
# says why a box needs its mm up (no secrets folder; an empty one) and null once the folder is this user's and holds
# the box's Paseo password; vault.runtimeDir makes the folder 0700 and keeps one that is this user's; the machine's
# process manager gets the one-shot mm.boxes (mm box boot, not restarted). A folder of another uid (Docker's, at boot)
# needs root to make, so box.sh and the live check after a reboot cover that path.
#   test/box-boot.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_SECRETS_DIR="$T/sec" MM_OBS_TRACES=""
mkdir -p "$MM_HOME/pc" "$MM_SECRETS_DIR"; chmod 700 "$HOME" "$MM_SECRETS_DIR"
B="$(command -v bun || echo "$HOME/.bun/bin/bun")"
cat >"$T/t.ts" <<EOF
import { writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bootReason } from '$SRC/src/box'
import * as vault from '$SRC/src/vault'
const [op, p] = process.argv.slice(2)
if (op === 'reason') console.log(bootReason(p) ?? 'null')
if (op === 'make') { const d = vault.runtimeDir(p); console.log((statSync(d).mode & 0o777).toString(8)) }
if (op === 'pw') writeFileSync(join(vault.runtimeDir(p), 'paseo.password'), 'x', { mode: 0o640 })
EOF
t() { "$B" "$T/t.ts" "$@" 2>&1; }
is() { local d=$1 want=$2; shift 2; local got; got=$("$@"); [ "$got" = "$want" ] && ok "$d" || bad "$d: want '$want', got '$got'"; }

echo "== bootReason"
is "no secrets folder: needs its up" "its secrets folder is missing" t reason acme-shop
is "runtimeDir makes it 0700" "700" t make acme-shop
is "an empty folder (its up never ran): needs its up" "its secrets folder is empty" t reason acme-shop
t pw acme-shop >/dev/null
is "this user's, with the Paseo password: nothing to do" "null" t reason acme-shop
chmod 750 "$MM_SECRETS_DIR/acme-shop"
is "runtimeDir keeps this user's folder (and narrows it)" "700" t make acme-shop
[ -f "$MM_SECRETS_DIR/acme-shop/paseo.password" ] && ok "...and what is in it" || bad "runtimeDir lost the folder's files"

echo "== the process manager's one-shot"
cat >"$T/pc.ts" <<EOF
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeBase } from '$SRC/src/pc'
import { DIRS } from '$SRC/src/env'
writeBase()
const y = Bun.YAML.parse(readFileSync(join(DIRS.pc, 'base.yaml'), 'utf8')) as any
const p = y.processes['mm.boxes']
console.log(p ? [/ box boot$/.test(p.command), p.availability?.restart].join(' ') : 'none')
EOF
is "mm.boxes runs mm box boot once (restart no)" "true no" "$B" "$T/pc.ts"

echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
