#!/usr/bin/env bash
# template/bin/lib/lead-workspace.mjs, hermetic: a fake Paseo client (PASEO_SDK -> a fake daemon-client.js holding its
# state in a JSON file); no daemon, no agent.
# Proves: the first lead makes one Paseo project rooted at the project (named after it) with the root's workspace and
# the role's; the next roles and restarts reuse it (one workspace per role); --tidy archives a workspace of the old
# one-project-per-folder layout once its agent is gone, keeps it while one runs, archives one whose folder is gone, and
# removes the empty projects under the root, never anything outside it; without a client it prints nothing (exit 0).
#   test/lead-workspace.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
P=$T/proj; mkdir -p "$P/bin/lib" "$P/leads/qa" "$P/leads/code" "$P/leads/old" "$P/leads/gone" "$P/setup" "$T/sdk" "$T/other"
cp "$SRC/template/bin/lib/lead-workspace.mjs" "$SRC/template/bin/lib/paseo.mjs" "$SRC/template/bin/lib/svc.mjs" "$P/bin/lib/"
S=$T/state.json
# the fake client: projects, workspaces and agents in $S; ids p1.. / w1..
cat >"$T/sdk/daemon-client.js" <<EOF
import fs from 'node:fs'
import path from 'node:path'
const F = '$S'
const load = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')) } catch { return { n: 0, projects: [], workspaces: [], agents: [] } } }
const save = (s) => fs.writeFileSync(F, JSON.stringify(s))
const row = (s, w) => { const p = s.projects.find((x) => x.projectId === w.projectId)
  return { id: w.id, projectId: w.projectId, projectRootPath: p.root, projectDisplayName: path.basename(p.root), projectCustomName: p.name || null,
    workspaceDirectory: w.dir, title: w.title, archivingAt: null } }
export class DaemonClient {
  constructor(cfg) { if (process.env.FAKE_CFG) fs.writeFileSync(process.env.FAKE_CFG, JSON.stringify({ url: cfg.url, transport: cfg.transportFactory ? cfg.transportFactory.connection : null })) }
  async connect() {}
  async close() {}
  async fetchWorkspaces() { const s = load(); return { entries: s.workspaces.filter((w) => !w.archived).map((w) => row(s, w)) } }
  async fetchAgents() { const s = load(); return { entries: s.agents.map((a) => ({ agent: a })) } }
  async listProjects() { const s = load(); return { projects: s.projects.map((p) => ({ projectId: p.projectId, projectRootPath: p.root })) } }
  async createWorkspace({ source, title }) {
    const s = load(); let p = source.projectId ? s.projects.find((x) => x.projectId === source.projectId) : s.projects.find((x) => x.root === source.path)
    if (!p) { p = { projectId: 'p' + ++s.n, root: source.path }; s.projects.push(p) }
    const w = { id: 'w' + ++s.n, projectId: p.projectId, dir: source.path, title }; s.workspaces.push(w); save(s); return { workspace: row(s, w) } }
  async renameProject(id, name) { const s = load(); s.projects.find((x) => x.projectId === id).name = name; save(s) }
  async archiveWorkspace(id) { const s = load(); s.workspaces.find((w) => w.id === id).archived = true; save(s) }
  async removeProject(id) { const s = load(); s.projects = s.projects.filter((p) => p.projectId !== id); save(s) }
}
EOF
# the SDK's node entry (dist/node/index.js next to the entry): a socket's transport, which says what it was made for
mkdir -p "$T/sdk/node"
cat >"$T/sdk/node/index.js" <<'EOF'
export function createHostTransportFactory(connection) { const f = () => { throw new Error('fake') }; f.connection = connection; return f }
EOF
export PASEO_SDK=$T/sdk/index.js PASEO_HOME=$T/nohome PASEO_URL=   # never the machine's daemon's pid lock
LW() { node "$P/bin/lib/lead-workspace.mjs" "$@"; }
q() { node -e "const s=JSON.parse(require('fs').readFileSync('$S','utf8'));process.stdout.write(String(($1)(s)))"; }

echo "== placing leads"
w_qa=$(LW "$P" "$P/leads/qa" "qa lead" acme-shop)
check "the first lead: one project, rooted at the project, named after it" test "$(q 's=>s.projects.map(p=>p.root+"|"+p.name).join()')" = "$P|acme-shop"
check "  with the root's workspace and the role's (its id printed)" test "$(q "s=>s.workspaces.map(w=>w.dir).sort().join()")" = "$P,$P/leads/qa"
check "  the printed id is the role's workspace" test "$(q "s=>s.workspaces.find(w=>w.id==='$w_qa').dir")" = "$P/leads/qa"
w_code=$(LW "$P" "$P/leads/code" "code lead" acme-shop); w_setup=$(LW "$P" "$P/setup" "setup lead" acme-shop)
check "more roles (setup too): the same project, one workspace each" test "$(q 's=>s.projects.length+"/"+s.workspaces.length')" = "1/4"
check "a restart reuses the role's workspace" test "$(LW "$P" "$P/leads/qa" "qa lead" acme-shop)" = "$w_qa"
check "  and adds nothing" test "$(q 's=>s.workspaces.length')" = 4
check "a symlinked path finds the same workspace" bash -c "ln -s '$P' '$T/link' && test \"\$(node '$P/bin/lib/lead-workspace.mjs' '$T/link' '$T/link/leads/code' 'code lead' acme-shop)\" = '$w_code'"

echo "== tidy"
# the old layout: a project per lead folder (old, with a live agent; gone, its folder deleted), and one outside the root
q "s=>{for(const [r,id] of [['$P/leads/old','po'],['$P/leads/gone','pg'],['$T/other','px']]){s.projects.push({projectId:id,root:r});s.workspaces.push({id:'w'+id,projectId:id,dir:r,title:'master'})}
  s.projects.push({projectId:'pe',root:'$T/other2'})   // empty, outside the root
  s.agents.push({id:'a-old',title:'acme-shop · old lead',workspaceId:'wpo'});require('fs').writeFileSync('$S',JSON.stringify(s));return ''}" >/dev/null
rm -rf "$P/leads/gone"
LW --tidy "$P" 2>"$T/tidy1"
check "an old workspace with a live agent is kept, and says why" bash -c "grep -q 'acme-shop · old lead still runs there' '$T/tidy1' && node -e \"const s=require('$S');process.exit(s.workspaces.find(w=>w.id==='wpo').archived?1:0)\""
check "one whose folder is gone is archived, and its empty project removed" test "$(q "s=>!!s.workspaces.find(w=>w.id==='wpg').archived+'/'+s.projects.some(p=>p.projectId==='pg')")" = "true/false"
check "nothing outside the root is touched, even an empty project" test "$(q "s=>!s.workspaces.find(w=>w.id==='wpx').archived+'/'+s.projects.some(p=>p.projectId==='px')+'/'+s.projects.some(p=>p.projectId==='pe')")" = "true/true/true"
check "the project's own workspaces stay" test "$(q "s=>s.workspaces.filter(w=>w.projectId==='p1'&&!w.archived).length")" = 4
q "s=>{s.agents=[];require('fs').writeFileSync('$S',JSON.stringify(s));return ''}" >/dev/null   # the old lead was restarted
LW --tidy "$P" 2>"$T/tidy2"
check "once its agent is gone, the old workspace is archived and its project removed" test "$(q "s=>!!s.workspaces.find(w=>w.id==='wpo').archived+'/'+s.projects.some(p=>p.projectId==='po')")" = "true/false"
check "  and tidy reports it" grep -q '1 workspace(s) archived, 0 kept (live agent), 1 empty project(s) removed' "$T/tidy2"

echo "== the address (sy-nli): the project's endpoints \"paseo\", a socket through the SDK's node entry"
export FAKE_CFG=$T/cfg.json
EP=$P/.run/endpoints.json
cfgis() { LW "$P" "$P/leads/qa" "qa lead" acme-shop >/dev/null 2>&1; cat "$FAKE_CFG"; }
mkdir -p "$P/.run" "$T/ph"
echo '{"paseo":"unix:///tmp/mm-test-nowhere/paseo.sock","services":{}}' >"$EP"
check "a unix:// address: the node entry's transport for that socket, the SDK's placeholder URL" test "$(cfgis)" = '{"url":"ws://host-connector/ws","transport":"unix:///tmp/mm-test-nowhere/paseo.sock"}'
echo '{"paseo":"ws://127.0.0.1:40999/ws","services":{}}' >"$EP"
check "a ws:// address: as it is, no socket transport" test "$(cfgis)" = '{"url":"ws://127.0.0.1:40999/ws","transport":null}'
check "PASEO_URL first (a bare socket path as unix://)" test "$(PASEO_URL=/tmp/mm-test-nowhere/x.sock cfgis)" = '{"url":"ws://host-connector/ws","transport":"unix:///tmp/mm-test-nowhere/x.sock"}'
rm "$EP"
echo '{"pid":1,"listen":"unix:///tmp/mm-test-nowhere/lock.sock"}' >"$T/ph/paseo.pid"
check "no endpoints: the pid lock's address in PASEO_HOME" test "$(PASEO_HOME=$T/ph cfgis)" = '{"url":"ws://host-connector/ws","transport":"unix:///tmp/mm-test-nowhere/lock.sock"}'
echo '{"pid":1,"listen":"127.0.0.1:40998"}' >"$T/ph/paseo.pid"
check "...a host:port one as ws://host:port/ws" test "$(PASEO_HOME=$T/ph cfgis)" = '{"url":"ws://127.0.0.1:40998/ws","transport":null}'
check "nothing at all: Paseo's own default" test "$(PASEO_HOME=$T/none HOME=$T/none cfgis)" = '{"url":"ws://127.0.0.1:6767/ws","transport":null}'
unset FAKE_CFG

echo "== without a client"
out=$(PASEO_SDK=$T/none/index.js LW "$P" "$P/leads/qa" "qa lead" acme-shop 2>"$T/err"); rc=$?
check "prints nothing, exit 0, says why (bin/lead then starts the lead as before)" bash -c "[ -z '$out' ] && [ $rc = 0 ] && grep -q 'Paseo places the lead itself' '$T/err'"

echo; echo "lead-workspace: $pass passed, $fail failed"; [ "$fail" = 0 ]
