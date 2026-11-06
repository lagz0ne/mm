#!/usr/bin/env bash
# routeUp's gate (sy-lyeo), hermetic: a throwaway MM_HOME and the test's own route tool (test/lib/expose), never the
# live web proxy. Proves: a board route (public.auth: required) gets the shared password (--auth) while the sign-in
# gateway is off, and the gateway (--sso) once auth.enabled is on; a route that is right already is left alone; an
# [auth] route becomes [sso] when the gateway goes on, and [auth] again when it goes off (the rollback); a route on a
# new port is rewritten; an open route (auth: none) gets neither.
#   test/routes.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_EXPOSE="$SRC/test/lib/expose" MM_EXPOSE_DIR="$T/routes"
mkdir -p "$MM_HOME"
gate() { printf 'auth:\n  enabled: %s\n' "$1" >"$MM_HOME/config.yaml"; }
# one routeUp call, as mm up makes it: prints "<status> <detail>"
up() { bun -e "import { routeUp } from '$SRC/src/project.ts'; const s = routeUp({ project: 'acme-shop' }, '$1', $2, $3, 'https://$1.test'); console.log(s.status + ' ' + s.detail)" 2>&1; }
line() { "$MM_EXPOSE" ls | grep "^https://$1\." || true; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

echo "== the gateway off: the shared password"
gate false
out=$(up board-x 4100 true)
is "a board route gets --auth (listed [auth], not [sso])" bash -c "l='$(line board-x)'; [[ \$l == *':4100'* && \$l == *'[auth]'* && \$l != *'[sso]'* ]]"
is "...and says so (password)" bash -c "[[ '$out' == 'ok https://board-x.test (password)' ]]"
is "the same again: left alone" bash -c "[[ '$(up board-x 4100 true)' == *'(already there)' ]]"

echo "== the gateway on: sign-in through mm.auth"
gate true
out=$(up board-x 4100 true)
is "the [auth] route becomes [sso] (rewritten, not left alone)" bash -c "l='$(line board-x)'; [[ \$l == *'[sso]'* && \$l != *'[auth]'* && '$out' == 'ok https://board-x.test (sign-in)' ]]"
is "the same again: left alone" bash -c "[[ '$(up board-x 4100 true)' == *'(already there)' ]]"
up board-x 4101 true >/dev/null
is "a new port: rewritten, still [sso]" bash -c "l='$(line board-x)'; [[ \$l == *':4101'* && \$l == *'[sso]'* ]]"
up app-x 4200 false >/dev/null
is "an open route (auth: none) gets neither mark" bash -c "l='$(line app-x)'; [[ -n \$l && \$l != *'[sso]'* && \$l != *'[auth]'* ]]"
gate '"true"'
is "auth.enabled written as the string \"true\": the gateway too" bash -c "[[ '$(up board-x 4101 true)' == *'(already there)' ]]"

echo "== the gateway off again (the rollback)"
gate false
up board-x 4101 true >/dev/null
is "the board route goes back to [auth]" bash -c "l='$(line board-x)'; [[ \$l == *'[auth]'* && \$l != *'[sso]'* ]]"
printf 'domain: example.org\n' >"$MM_HOME/config.yaml"
is "no auth key at all: [auth], left alone" bash -c "[[ '$(up board-x 4101 true)' == *'(already there)' ]]"

echo "== mm.log: one line per route mm added or removed (sy-n9zp), none for a route right already"
LOG="$MM_HOME/pc/mm.log"; mkdir -p "$MM_HOME/pc"; rm -f "$LOG"
n() { [ -f "$LOG" ] && wc -l <"$LOG" || echo 0; }; export -f n; export LOG
rm_() { bun -e "import { routeRm } from '$SRC/src/project.ts'; const s = routeRm({ project: '$2', throwaway: $3 }, '$1'); console.log(s.status)" 2>&1; }
gate false
up log-x 4400 false >/dev/null
is "a new route: one line, op route add, the project, name, port and open" bash -c "[ \"\$(n)\" = 1 ] && tail -1 '$LOG' | jq -e '.op == \"route add\" and .args == \"acme-shop log-x 4400 open\" and .ok == true and .project == \"mm\" and .service == \"mm\" and (.time | test(\"Z\$\")) and (has(\"mm_throwaway\") | not)' >/dev/null"
up log-x 4400 false >/dev/null
is "the same again (already there): no line" bash -c "[ \"\$(n)\" = 1 ]"
up log-x 4400 true >/dev/null
is "gated now: a line, sign-in" bash -c "[ \"\$(n)\" = 2 ] && tail -1 '$LOG' | jq -e '.args == \"acme-shop log-x 4400 sign-in\"' >/dev/null"
rm_ log-x acme-shop false >/dev/null
is "removed: a line, op route rm, project and name" bash -c "[ \"\$(n)\" = 3 ] && tail -1 '$LOG' | jq -e '.op == \"route rm\" and .args == \"acme-shop log-x\" and .ok == true' >/dev/null"
rm_ log-x acme-shop false >/dev/null
is "removed again (not there): no line" bash -c "[ \"\$(n)\" = 3 ]"
bun -e "import { routeUp } from '$SRC/src/project.ts'; routeUp({ project: 'tp-x', throwaway: true }, 'tp-x', 4500, false, 'https://tp-x.test')" >/dev/null 2>&1
is "a throwaway project's route (the test tool): marked mm_throwaway" bash -c "[ \"\$(n)\" = 4 ] && tail -1 '$LOG' | jq -e '.op == \"route add\" and .mm_throwaway == \"tp-x\"' >/dev/null"
is "no line carries a secret field (only time, level, msg, project, service, op, args, ok, mm_throwaway)" bash -c "[ \"\$(jq -c 'keys - [\"time\",\"level\",\"msg\",\"project\",\"service\",\"op\",\"args\",\"ok\",\"mm_throwaway\"]' '$LOG' | sort -u)\" = '[]' ]"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
