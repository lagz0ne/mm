#!/usr/bin/env bash
# The machine's naming rule for public services (sy-b15.3), hermetic: a throwaway HOME and MM_HOME, the test's own
# route tool (test/lib/expose), stubs for the process manager. Proves: with no `names` (legacy, the default) every
# name is today's; with `names: project` the routes, the gateway's host registry and the board's own URL use
# <project>.<domain> and <service>.<project>.<domain>, and the system board keeps its name; a host two projects would
# share, the gateway's host, a route granted to a box and an invalid DNS name are refused (mm up, mm new, mm.api);
# `mm names` shows both columns and the routes a switch adds and leaves behind. The gateway's gate under both rules:
# test/auth.sh ("names: project").
#   test/names.sh [mm command]       default: bun <repo>/src/cli.ts
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd); MMC=${1:-"bun $SRC/src/cli.ts"}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
is() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_EXPOSE="$SRC/test/lib/expose" MM_EXPOSE_DIR="$T/routes" MM_API_DIR="$T/api"
unset PASEO_AGENT_ID PASEO_AGENT_CWD
# never the machine's process manager: these stubs fail, so nothing here can start or load one
mkdir -p "$T/stub" "$MM_HOME/pc/projects"
for c in systemctl process-compose; do printf '#!/bin/sh\nexit 1\n' >"$T/stub/$c"; chmod +x "$T/stub/$c"; done
export PATH="$T/stub:$PATH:/usr/sbin"
conf() { printf 'access: domain\ndomain: example.org\nbind_host: 127.0.0.1\n%b' "${1:-}" >"$MM_HOME/config.yaml"; }
# a project as mm reads it: its answers and its services.yaml (a board behind the sign-in, an open app slot)
fakeproj() { # <dir> <client> <name> [project] [profile]
  local p=${4:-$2-$3}; mkdir -p "$1"
  printf 'client: %s\nname: %s\nproject: %s\nshort: x\nroot: %s\ntemplate_version: test\ncreated: test\n%s' "$2" "$3" "$p" "$1" "${5:+profile: $5
}" >"$1/.mm-answers.yaml"
  printf 'services:\n  board:\n    command: "true"\n    port: http\n    public: { name: "board-%s-%s", auth: required }\n  app:\n    command: "true"\n    port: http\n    public: { name: "%s-%s", auth: none }\n' "$3" "$2" "$3" "$2" >"$1/services.yaml"
  echo "# from $1/services.yaml" >"$MM_HOME/pc/projects/$p.yaml"; }
fakeproj "$T/p1" acme shop; fakeproj "$T/p2" acme other
# the system board: public here only to show it keeps its name (the real one is loopback only)
fakeproj "$T/sys" mm system system system
# bun -e with the repo's modules: prints what the snippet prints
js() { (cd "$T" && bun -e "import * as P from '$SRC/src/project.ts'; import * as A from '$SRC/src/auth.ts'; import * as API from '$SRC/src/api.ts'; $1" 2>&1); }
pub() { js "const s = P.resolve('$1').services; console.log(Object.keys(s).filter((n) => s[n].public_url).map((n) => n + '=' + s[n].public_url + '=' + s[n].public.name).join(' '))"; }
routes() { js "for (const r of ['$T/p1', '$T/p2', '$T/sys']) { const x = P.resolve(r); for (const s of P.serviceRoutes(x.answers, x.services)) console.log(s.status + ' ' + s.detail) }" >/dev/null; "$MM_EXPOSE" ls | awk '{print $1, $NF}' | sort; }
claims() { js "const c = A.hostClaims(); console.log(Object.keys(c.claims).sort().join(' ') + ' | ' + Object.keys(c.hosts).sort().join(' '))"; }
boardurl() { js "P.writeRunFiles('$1', '$T/pc.sock')" >/dev/null; jq -r .services.board.public "$1/.run/endpoints.json"; }
export -f js pub routes claims boardurl; export T SRC MMC

echo '== no names setting (legacy, the default): today'"'"'s names, nothing changes'
conf
is "the board board-shop-acme, the app shop-acme" test "$(pub "$T/p1")" = "board=https://board-shop-acme.example.org=board-shop-acme app=https://shop-acme.example.org=shop-acme"
R=$(routes)
is "the routes mm up writes: the same names (the board behind the sign-in, the app open)" bash -c "grep -qx 'https://board-shop-acme.test \[auth\]' <<<\"\$1\" && grep -q '^https://shop-acme.test http://127.0.0.1:' <<<\"\$1\"" _ "$R"
is "...and nothing else: 6 routes (2 projects and the system board), each today's name" test "$(routes | awk '{print $1}' | tr '\n' ' ')" = "https://board-other-acme.test https://board-shop-acme.test https://board-system-mm.test https://other-acme.test https://shop-acme.test https://system-mm.test "
is "the gateway's registry: boards board-*, every host" test "$(claims)" = "board-other-acme.example.org board-shop-acme.example.org board-system-mm.example.org | board-other-acme.example.org board-shop-acme.example.org board-system-mm.example.org other-acme.example.org shop-acme.example.org system-mm.example.org"
is "the board's own URL (.run/endpoints.json)" test "$(boardurl "$T/p1")" = "https://board-shop-acme.example.org"
conf 'names: legacy\n'
is "names: legacy written out: the same" test "$(pub "$T/p1")" = "board=https://board-shop-acme.example.org=board-shop-acme app=https://shop-acme.example.org=shop-acme"

echo '== names: project'
conf 'names: project\n'; rm -rf "$T/routes"
is "the board acme-shop.example.org, the app app.acme-shop.example.org" test "$(pub "$T/p1")" = "board=https://acme-shop.example.org=acme-shop app=https://app.acme-shop.example.org=app.acme-shop"
is "the system board keeps its own name (and its other services)" test "$(pub "$T/sys")" = "board=https://board-system-mm.example.org=board-system-mm app=https://system-mm.example.org=system-mm"
is "the routes: acme-shop behind the sign-in, app.acme-shop open; the system's unchanged" test "$(routes | awk '{print $1}' | tr '\n' ' ')" = "https://acme-other.test https://acme-shop.test https://app.acme-other.test https://app.acme-shop.test https://board-system-mm.test https://system-mm.test "
is "...the board's route is gated, the app's is not" bash -c "routes | grep -qx 'https://acme-shop.test \[auth\]' && ! routes | grep '^https://app.acme-shop.test' | grep -q '\['"
is "the gateway's registry: the new board hosts, and every new host" test "$(claims)" = "acme-other.example.org acme-shop.example.org board-system-mm.example.org | acme-other.example.org acme-shop.example.org app.acme-other.example.org app.acme-shop.example.org board-system-mm.example.org system-mm.example.org"
is "the board's own URL follows" test "$(boardurl "$T/p1")" = "https://acme-shop.example.org"
is "...and a link to the app (endpoints.json services.app.public)" test "$(jq -r .services.app.public "$T/p1/.run/endpoints.json")" = "https://app.acme-shop.example.org"
conf 'names: projects\n'
is "an unknown value: refused, with the choices (not guessed)" bash -c "js \"P.resolve('$T/p1')\" | grep -q 'config names: \"projects\" is not one of legacy, project'"

echo '== two projects never get one host (refused, with a clear message)'
conf 'names: project\n'
up() { js "const s = P.up('$1'); console.log(s.map((x) => x.step + ': ' + x.status + ' ' + x.detail).join('\n'))"; }; export -f up
# a second folder with the same project id: under names: project the same board host
fakeproj "$T/p3" acme shop acme-shop; echo "# from $T/p1/services.yaml" >"$MM_HOME/pc/projects/acme-shop.yaml"
is "mm up of a second folder with acme-shop's project id: refused before it is registered" bash -c "up '$T/p3' | grep -q \"public names: fail refused: the project id acme-shop is already $T/p1's\" && grep -q '$T/p1/' '$MM_HOME/pc/projects/acme-shop.yaml'"
# the gateway's own host: a project whose id is auth
fakeproj "$T/p4" acme gw auth; rm -f "$MM_HOME/pc/projects/auth.yaml"
is "a project named auth: auth.example.org is the gateway's, refused" bash -c "up '$T/p4' | grep -q 'refused: auth.example.org (its board) is the sign-in gateway.s host' && [ ! -e '$MM_HOME/pc/projects/auth.yaml' ]"
# a name that is no DNS label (a project id ending in -)
fakeproj "$T/p5" acme bad acme-bad-; rm -f "$MM_HOME/pc/projects/acme-bad-.yaml"
is "a project id that makes no valid DNS name: refused, says why" bash -c "up '$T/p5' | grep -q 'acme-bad-: \"acme-bad-\" is no valid DNS name (names: project)'"
# legacy: two projects whose own public.name is the same (board-c-a-b from a-b/c and b/c-a)
conf; fakeproj "$T/q1" a-b c; fakeproj "$T/q2" b c-a; rm -f "$MM_HOME/pc/projects/b-c-a.yaml"
is "legacy too: board-c-a-b is a-b-c's already, so b/c-a is refused" bash -c "up '$T/q2' | grep -q 'refused: board-c-a-b.example.org (its board) is a-b-c.s already' && [ ! -e '$MM_HOME/pc/projects/b-c-a.yaml' ]"
rm -f "$MM_HOME/pc/projects/a-b-c.yaml"
# a route the owner granted a box: under names: project app.<project> is the app slot's host
conf 'names: project\n'; mkdir -p "$MM_API_DIR/granted"
printf '{"routes":[{"name":"app","host":"app.acme-other.example.org","open":false,"id":"r1"}],"egress":[],"release":null,"secrets":[]}' >"$MM_API_DIR/granted/acme-other.json"
is "a route granted to the box (app.acme-other) is its app slot's host now: mm up refuses, and says so" bash -c "up '$T/p2' | grep -q 'refused: app.acme-other.example.org (its app) is a route the owner granted its box'"
rm -f "$MM_API_DIR/granted/acme-other.json"
is "mm.api: a box may not ask for the route app (app.acme-shop is its app slot's host)" bash -c "js \"console.log(API.hostTaken('acme-shop', 'app', 'app.acme-shop.example.org'))\" | grep -qx 'app.acme-shop.example.org is acme-shop.s public service'"
is "...nor for a host that is another project's board" bash -c "js \"console.log(API.hostTaken('acme-other', 'x', 'acme-shop.example.org'))\" | grep -q \"is a board's\""
is "...a free name is fine" bash -c "js \"console.log(API.hostTaken('acme-shop', 'shop', 'shop.acme-shop.example.org'))\" | grep -qx null"
# mm new: a project id another folder holds is refused before anything is made (the folder is gone again)
is "mm new with another folder's project id: refused, nothing left behind" bash -c "js \"try { await P.newProject('acme/twin', { project: 'acme-shop', root: '$T/new1' }) } catch (e) { console.log(String(e.message)) }\" | grep -q 'refused: the project id acme-shop is already' && [ ! -e '$T/new1' ]"

echo '== mm names (read-only)'
conf
mm() { (cd "$T" && $MMC "$@"); }; export -f mm
N=$(mm names 2>&1)
is "both columns, per project and service" bash -c "printf '%s\n' \"\$1\" | grep -E '^acme-shop +board +board-shop-acme.example.org +acme-shop.example.org +sign-in' >/dev/null && printf '%s\n' \"\$1\" | grep -E '^acme-shop +app +shop-acme.example.org +app.acme-shop.example.org +open' >/dev/null" _ "$N"
is "says the machine's rule now (legacy, the default)" bash -c "printf '%s\n' \"\$1\" | grep -q '^names: legacy (the default); domain example.org'" _ "$N"
is "the routes a switch adds and leaves behind" bash -c "printf '%s\n' \"\$1\" | grep -qE '^ +\+ acme-shop -> :[0-9]+  sign-in' && printf '%s\n' \"\$1\" | grep -qE '^ +\+ app.acme-shop -> :[0-9]+  open' && printf '%s\n' \"\$1\" | grep -qE '^ +- board-shop-acme$' && printf '%s\n' \"\$1\" | grep -qE '^ +- shop-acme$'" _ "$N"
is "...the system board's routes neither added nor removed" bash -c "! printf '%s\n' \"\$1\" | grep -qE '^ +[-+] (board-)?system-mm'" _ "$N"
is "...the DNS names two labels deep" bash -c "printf '%s\n' \"\$1\" | grep -q 'must cover \*.acme-other.example.org, \*.acme-shop.example.org'" _ "$N"
is "-o json: the same, with the rule" bash -c "mm names -o json | jq -e '.names == \"legacy\" and .switch_to == \"project\" and ([.rows[] | select(.project == \"acme-shop\" and .service == \"board\")][0] | .legacy == \"board-shop-acme.example.org\" and .project_mode == \"acme-shop.example.org\")' >/dev/null"
sleep 1; touch "$T/mark"; sleep 1; mm names >/dev/null 2>&1
CH=$(find "$MM_HOME" "$T/routes" -type f -newer "$T/mark" ! -name '*.log' 2>/dev/null); [ -n "$CH" ] && echo "changed: $CH"
is "changes nothing (no file in MM_HOME or the routes written; mm's own log aside)" test -z "$CH"
conf 'names: project\n'
is "on project: the other way (legacy is the switch), the same rows" bash -c "mm names | grep -q '^names: project; domain' && mm names | grep -qE '^ +- acme-shop$' && mm names | grep -qE '^ +\+ board-shop-acme '"
printf 'access: tailscale\n' >"$MM_HOME/config.yaml"
is "no domain: says so" bash -c "mm names | grep -q 'no domain'"

printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
