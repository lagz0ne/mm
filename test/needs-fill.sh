#!/usr/bin/env bash
# mm needs / mm fill, hermetic: a throwaway HOME and MM_HOME (no process manager, no real secrets), a fake project.
# Proves: the table and exit codes, doctor failing on a required missing input, vars as arguments, secrets only from a
# file / a pipe / a hidden terminal prompt (never the command line), mode 600 + byte-for-byte, no overwrite without
# --replace, accounts and tool-made ones refused, project inputs, and that no value appears in any output.
#
#   test/needs-fill.sh [mm binary]        default dist/mm
set -uo pipefail
MM=$(readlink -f "${1:-$(dirname "$0")/../dist/mm}")
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" ; mkdir -p "$HOME" "$MM_HOME"
unset PASEO_AGENT_ID PASEO_AGENT_CWD
LOG="$T/all-output"
mm() { "$MM" "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }
rows() { "$MM" needs --all -o json 2>/dev/null; }
st() { rows | jq -r --arg s "${2:-machine}" --arg n "$1" '.[] | select(.scope==$s and .name==$n) | .status'; }
V1='S3cret-from-pipe-81723'; V2='S3cret-from-file-55102'; V3='S3cret-typed-hidden-4471'; V4='S3cret-on-argv-9001'
mode() { stat -c %a "$1"; }

echo '== empty machine'
mm needs --machine >/dev/null; rc=$?
[ $rc = 1 ] && ok "needs exits 1 (required missing)" || bad "needs exit $rc"
check "access missing, required" sh -c "\"$MM\" needs -o json | jq -e '.[] | select(.name==\"access\" and .required and .status==\"missing\")'"
check "domain hidden until access == domain" sh -c "! \"$MM\" needs -o json | jq -e '.[] | select(.name==\"domain\")'"
check "doctor fails on the missing claude-oauth-token" sh -c "\"$MM\" doctor -o json | jq -e '.[] | select(.item==\"claude-oauth-token\" and .status==\"fail\")'"

echo '== vars'
check "a bad choice is refused" sh -c "! \"$MM\" fill access sideways"
mm fill access domain >/dev/null && ok "fill access domain" || bad "fill access domain"
check "domain now shown, missing" test "$(st domain)" = missing
mm fill domain example.org >/dev/null && ok "fill domain" || bad "fill domain"
check "config.yaml has it" grep -q 'domain: example.org' "$MM_HOME/config.yaml"
mm fill telegram_owner_id 12345 >/dev/null; check "dotted config key (telegram.owner_id)" sh -c "\"$MM\" config get telegram.owner_id | grep -qx 12345"

echo '== secrets'
SECRET="$HOME/.config/secrets/claude-oauth.token"
mm fill claude-oauth-token "$V4" >/dev/null; rc=$?
[ $rc = 1 ] && ok "a secret on the command line is refused" || bad "argv secret exit $rc"
check "...and nothing was written" test ! -e "$SECRET"
printf '%s\n' "$V1" | mm fill claude-oauth-token >/dev/null && ok "fill from a pipe" || bad "fill from a pipe"
check "mode 600" test "$(mode "$SECRET")" = 600
check "folder made 700" test "$(mode "$(dirname "$SECRET")")" = 700
check "value without the trailing newline" test "$(cat "$SECRET")" = "$V1" -a "$(wc -c <"$SECRET")" = "${#V1}"
check "no overwrite without --replace" sh -c "! printf x | \"$MM\" fill claude-oauth-token"
check "...value kept" test "$(cat "$SECRET")" = "$V1"
printf '%s\n' "$V2" >"$T/key"; printf 'line2\n' >>"$T/key"
mm fill claude-oauth-token --from "$T/key" --replace >/dev/null && ok "fill --from a file --replace" || bad "fill --from"
check "file kept byte for byte (keys)" cmp -s "$T/key" "$SECRET"
check "empty value refused" sh -c "! printf '' | \"$MM\" fill cloudflare-token"
(sleep 2; printf '%s\r' "$V3") | script -qec "\"$MM\" fill expose-password" /dev/null >"$T/tty.out" 2>&1   # typed after the prompt; cat "$T/tty.out" >>"$LOG"
check "fill from a terminal (hidden prompt)" test "$(cat "$HOME/.config/secrets/expose.pass" 2>/dev/null)" = "$V3"
check "the prompt does not echo the value" sh -c "! grep -q '$V3' '$T/tty.out' && grep -q 'input hidden' '$T/tty.out'"
check "a made-by-a-tool secret is refused" sh -c "! \"$MM\" fill paseo-keypair --from '$T/key'"
check "an account is refused" sh -c "! \"$MM\" fill github"
check "an unknown input is refused" sh -c "! \"$MM\" fill no-such-thing x"
chmod 644 "$SECRET"; check "a secret with mode 644 is bad" test "$(st claude-oauth-token)" = bad; chmod 600 "$SECRET"
printf '%s' "$V2" | mm fill cloudflare-token >/dev/null
mm needs --machine >/dev/null; rc=$?
[ $rc = 0 ] && ok "needs exits 0 once every required input is there" || bad "needs exit $rc"

echo '== project inputs'
P="$T/proj"; mkdir -p "$P" "$MM_HOME/pc/projects"
echo "# from $P/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"
echo '{"required":[{"name":"API_KEY","for":"app","how":"the vendor dashboard"}],"optional":[{"name":"TEAM","secret":false,"for":"board"}]}' >"$P/secrets.json"
mm needs -p acme-shop >/dev/null; rc=$?
[ $rc = 1 ] && ok "a project's required secret missing: exit 1" || bad "project needs exit $rc"
check "API_KEY is shown with its fill command" sh -c "\"$MM\" needs -p acme-shop -o json | jq -e '.[] | select(.name==\"API_KEY\" and .fill==\"mm fill acme-shop:API_KEY\")'"
check "a project secret on the command line is refused" sh -c "! \"$MM\" fill acme-shop:API_KEY '$V4'"
printf '%s' "$V1" | mm fill acme-shop:API_KEY >/dev/null && ok "fill acme-shop:API_KEY from a pipe" || bad "fill project secret"
check "{root}/secrets/API_KEY, mode 600" test "$(mode "$P/secrets/API_KEY")" = 600
mm fill acme-shop:TEAM my-team >/dev/null && ok "a non-secret project value as an argument" || bad "project var"
check "an undeclared name is refused" sh -c "! \"$MM\" fill acme-shop:NOPE x"
mm needs -p acme-shop >/dev/null; rc=$?
[ $rc = 0 ] && ok "project complete: exit 0" || bad "project needs exit $rc"
P2="$T/proj2"; mkdir -p "$P2"; echo "# from $P2/services.yaml" >"$MM_HOME/pc/projects/acme-tmpl.yaml"
cp "$(dirname "$0")/../template/secrets.json" "$P2/secrets.json"
check "a project with the template's secrets.json: no ACCESS_* row (Cloudflare Access is not used)" \
  sh -c "\"$MM\" needs -p acme-tmpl -o json | jq -e 'type == \"array\" and all(.[]; .name | startswith(\"ACCESS_\") | not)'"

echo '== no value anywhere'
for v in "$V1" "$V2" "$V3" "$V4"; do check "no output contains ${v:0:14}…" sh -c "! grep -q '$v' '$LOG'"; done
check "nor the needs table" sh -c "! \"$MM\" needs --all -o json | grep -q 'S3cret'"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
