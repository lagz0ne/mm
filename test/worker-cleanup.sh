#!/usr/bin/env bash
# A worker's Paseo place and its cleanup (sy-7f7i), hermetic: a throwaway HOME / MM_HOME, a system board rendered from
# mm's template, a throwaway git repo standing in for mm's, a stub bd and a stub paseo on PATH that keeps projects,
# workspaces and agents as Paseo does (a bare run makes a project and a workspace for its folder) and logs each call.
# Proves: lead worker start puts the worker's workspace in the board's one Paseo project (made with the board's own
# workspace if Paseo has none), never a project of its own, and runs the agent there (--workspace); when Paseo refuses
# the workspace it starts the worker anyway (Paseo places it); lead worker stop archives the agent and its workspace
# (and a project of the old layout), the board's project and its other workspaces stay, the folder stays;
# lead worker sweep <role> is a dry run that lists and changes nothing, and --apply archives the role's workspaces and
# deletes its projects with no live agent and wt rm --force's its folders whose branch is all on main (git cherry: a
# cherry-picked commit counts), and keeps a branch with commits not on main, a folder with a live agent, a dirty one,
# and another role's.
#   test/worker-cleanup.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" MM_OBS_METRICS="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset WAKE_CAP MM_BRAIN MM_PROJECTS MM_SERVICE PASEO_AGENT_ID PASEO_WORKSPACE_ID
mkdir -p "$HOME"
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const [root] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'b', project: 'acme-b', short: 'ab', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true, profile: 'system' }, null, 2) + '\n')
renderTo(root, { ...templateVars(root), profile: 'system' }, t)
EOF
SYS="$T/sys"; W="$SYS/worktrees"; MMR="$HOME/mm"
PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$SYS" >/dev/null || { echo "stamp failed"; exit 1; }
for r in "$MMR" "$HOME/.mm/brain"; do mkdir -p "$r"; git -C "$r" init -q -b main; echo x >"$r/README.md"; git -C "$r" add README.md; git -C "$r" commit -qm init; done
RJ="$SYS/leads/roles.json"
jq '.roles |= map(.workers = true | .capacity = 9)' "$RJ" >"$T/r.json" && cp "$T/r.json" "$RJ"
(cd "$SYS" && node bin/config-check --render >/dev/null 2>&1)
cat >"$T/items.json" <<'EOF'
[{"id":"ab-1","assignee":"platform","status":"in_progress","priority":2},{"id":"ab-3","assignee":"review","status":"in_progress","priority":2}]
EOF
printf '#!/bin/sh\ncase "$1" in list) cat %s ;; *) exit 0 ;; esac\n' "$T/items.json" >"$SYS/bin/bd"; chmod +x "$SYS/bin/bd"

# the stub paseo, on PATH: state in $STUB (agents, projects, workspaces); STUB_WS_REFUSE: workspace create fails
mkdir -p "$T/stubbin"
cat >"$T/stubbin/paseo" <<'EOF'
#!/usr/bin/env node
const fs = require('fs'), F = process.env.STUB, a = process.argv.slice(2)
fs.appendFileSync(F + '.log', JSON.stringify(a) + '\n')
let s = { n: 0, agents: [], projects: [], workspaces: [] }; try { s = JSON.parse(fs.readFileSync(F, 'utf8')) } catch {}
const save = () => fs.writeFileSync(F, JSON.stringify(s)), opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined)
const out = (o) => console.log(JSON.stringify(o)), id = (p) => `${p}${++s.n}`
const proj = (root) => { let p = s.projects.find((x) => x.path === root); if (!p) { p = { projectId: id('pj'), name: root.split('/').pop(), path: root }; s.projects.push(p) } return p }
const mkws = (dir, p, title) => { const w = { workspaceId: id('ws'), projectId: p.projectId, cwd: dir, title }; s.workspaces.push(w); return w }
const wsRow = (w) => ({ workspaceId: w.workspaceId, project: s.projects.find((p) => p.projectId === w.projectId)?.name, name: w.title, isolation: 'local', cwd: w.cwd })
const archiveWs = (w) => { w.archived = true; for (const x of s.agents) if (x.workspaceId === w.workspaceId) x.archived = true }
const lab = {}; for (let i = 0; i < a.length; i++) if (a[i] === '--label') { const [k, v] = a[i + 1].split('='); lab[k] = v }
if (a[0] === 'ls') out(s.agents.filter((x) => (a.includes('-a') || !x.archived) && Object.entries(lab).every(([k, v]) => x.labels[k] === v)).map(({ labels, ...x }) => x))
else if (a[0] === 'run') {
  let w = opt('--workspace') && s.workspaces.find((x) => x.workspaceId === opt('--workspace') && !x.archived)
  if (opt('--workspace') && !w) { console.error('Workspace not found'); process.exit(1) }
  if (!w) w = mkws(opt('--cwd'), proj(opt('--cwd')), 'master') // a bare run: Paseo makes a project and a workspace for its folder
  const ag = { id: id('ag'), title: opt('--title'), status: 'running', cwd: w.cwd, workspaceId: w.workspaceId, labels: lab }
  ag.shortId = ag.id; s.agents.push(ag); save(); console.log(ag.id)
} else if (a[0] === 'archive') { for (const x of s.agents) if (x.id === a[a.length - 1]) x.archived = true; save() }
else if (a[0] === 'logs') console.log('RESULT: done')
else if (a[0] === 'project' && a[1] === 'ls') out(s.projects)
else if (a[0] === 'project' && a[1] === 'delete') {
  const p = s.projects.find((x) => x.projectId === a[2]); if (!p) { console.error('Project not found'); process.exit(1) }
  for (const w of s.workspaces) if (w.projectId === p.projectId) archiveWs(w)
  s.projects = s.projects.filter((x) => x !== p); save()
} else if (a[0] === 'workspace' && a[1] === 'ls') out(s.workspaces.filter((w) => !w.archived).map(wsRow))
else if (a[0] === 'workspace' && a[1] === 'create') {
  if (process.env.STUB_WS_REFUSE) { console.error('workspace refused'); process.exit(1) }
  const p = opt('--project') ? s.projects.find((x) => x.projectId === opt('--project')) : proj(opt('--path'))
  if (!p) { console.error('Project not found'); process.exit(1) }
  const w = mkws(opt('--path'), p, opt('--title')); save(); out(wsRow(w))
} else if (a[0] === 'workspace' && a[1] === 'archive') { const w = s.workspaces.find((x) => x.workspaceId === a[2]); if (!w) process.exit(1); archiveWs(w); save() }
else { console.error(`stub: ${a.join(' ')}`); process.exit(9) }
EOF
chmod +x "$T/stubbin/paseo"
export PATH="$T/stubbin:$PATH" STUB="$T/paseo.json"
unset PASEO_BIN
q() { node -e "const s=JSON.parse(require('fs').readFileSync('$STUB','utf8'));process.stdout.write(String(($1)(s)))"; }
LW() { "$SYS/bin/lead" worker "$@" 2>&1; }
echo "the brief" >"$T/brief.md"

echo "== start: the worker's workspace in the board's one Paseo project"
out=$(LW start platform a1 --item ab-1 --brief "$T/brief.md"); rc=$?
check "start platform a1 (exit $rc)" test "$rc" = 0
check "...one Paseo project, rooted at the board (made with the board's own workspace)" test "$(q 's=>s.projects.map(p=>p.path).join()')" = "$SYS"
WS1=$(q "s=>s.workspaces.find(w=>w.cwd==='$W/platform-a1').workspaceId")
check "...the worker folder's workspace is in it" test "$(q "s=>s.workspaces.find(w=>w.cwd==='$W/platform-a1').projectId===s.projects[0].projectId")" = true
check "...and paseo run ran in it (--workspace $WS1)" bash -c "grep '\"run\"' '$STUB.log' | tail -1 | grep -qF '\"--workspace\",\"$WS1\"'"
check "...no project rooted at the worker folder" test "$(q "s=>s.projects.some(p=>p.path.startsWith('$W'))")" = false
out=$(LW start review r1 --item ab-3 --brief "$T/brief.md"); rc=$?
check "start review r1 (exit $rc): the same one project, a workspace more" test "$rc/$(q 's=>s.projects.length+"/"+s.workspaces.length')" = "0/1/3"

echo "== stop: the agent and its workspace go, the folder stays"
out=$(LW stop platform a1)
check "stop platform a1 archives the agent and its workspace" bash -c "grep -q 'archived platform/a1' <<<'$out' && grep -q 'archived its Paseo workspace $WS1' <<<'$out' && grep -qF '\"workspace\",\"archive\",\"$WS1\"' '$STUB.log'"
check "...its folder stays (a branch may wait for its rollout)" bash -c "[ -d '$W/platform-a1' ] && grep -q 'its folder stays' <<<'$out'"
check "...the board's project, its own workspace and review r1's stay" test "$(q "s=>s.projects.length+'/'+s.workspaces.filter(w=>!w.archived).map(w=>w.cwd.slice('$SYS'.length)||'/').sort().join()")" = "1//,/worktrees/review-r1"
check "...the archived agent stays (its report)" bash -c "LW() { '$SYS/bin/lead' worker \"\$@\" 2>&1; }; LW report platform a1 | grep -q 'RESULT: done'"

echo "== Paseo refuses the workspace: the worker starts anyway; stop cleans what Paseo made"
out=$(STUB_WS_REFUSE=1 LW start platform a2 --item ab-1 --brief "$T/brief.md"); rc=$?
check "start platform a2 (exit $rc), says Paseo places it" grep -q 'Paseo places it itself' <<<"$out"
check "...paseo run with no --workspace" bash -c "[ $rc = 0 ] && ! grep '\"run\"' '$STUB.log' | tail -1 | grep -q -- '--workspace'"
check "...Paseo made a project for its folder" test "$(q "s=>s.projects.some(p=>p.path==='$W/platform-a2')")" = true
out=$(LW stop platform a2)
check "stop platform a2 deletes that project and archives its workspace" bash -c "grep -q 'deleted its Paseo project' <<<'$out' && grep -q 'archived its Paseo workspace' <<<'$out' && [ \"\$(node -e \"const s=require('$STUB');process.stdout.write(String(s.projects.length))\")\" = 1 ]"

echo "== sweep"
# platform-a1: its commit cherry-picked onto main (all on main); platform-a2: a commit not on main; platform-a3: a live
# agent; platform-a4: uncommitted changes; leftovers of a folder gone (a workspace) and of the old layout (a project)
echo one >"$W/platform-a1/one.txt"; git -C "$W/platform-a1" add one.txt; git -C "$W/platform-a1" commit -qm one
git -C "$MMR" cherry-pick "$(git -C "$W/platform-a1" rev-parse HEAD)" >/dev/null
echo two >"$W/platform-a2/two.txt"; git -C "$W/platform-a2" add two.txt; git -C "$W/platform-a2" commit -qm two
LW start platform a3 --item ab-1 --brief "$T/brief.md" >/dev/null
LW start platform a4 --item ab-1 --brief "$T/brief.md" >/dev/null; LW stop platform a4 >/dev/null; echo dirty >"$W/platform-a4/d.txt"
node -e "const f='$STUB',s=require(f);const b=s.projects[0].projectId
s.workspaces.push({workspaceId:'wsgone',projectId:b,cwd:'$W/platform-gone',title:'x'},{workspaceId:'wsrev',projectId:b,cwd:'$W/review-old',title:'x'})
s.projects.push({projectId:'pjold',name:'platform-old',path:'$W/platform-old'});require('fs').writeFileSync(f,JSON.stringify(s))"
cp "$STUB" "$T/before.json"; n0=$(wc -l <"$STUB.log")
out=$(LW sweep platform); rc=$?
echo "$out" | sed 's/^/    | /'
check "the dry run (exit $rc) says so, and changes nothing" bash -c "[ $rc = 0 ] && head -1 <<<'$out' | grep -qF 'sweep platform (dry run: --apply to act)' && cmp -s '$T/before.json' '$STUB' && [ -d '$W/platform-a1' ]"
check "...and calls no archive, delete or wt rm" bash -c "! tail -n +$((n0 + 1)) '$STUB.log' | grep -qE '\"(archive|delete)\"'"
for l in 'archive  workspace wsgone worktrees/platform-gone: no live agent' 'delete   project pjold worktrees/platform-old: no live agent' \
  'rm       platform-a1: every commit of its branch a1 is on main (wt rm --force)' 'keep     platform-a2: its branch a2 has 1 commit(s) not on main' \
  'keep     platform-a3: a live agent is in it' 'keep     platform-a4: it has uncommitted changes' '3 to do, 3 kept'; do
  check "...lists: $l" grep -qF -- "$l" <<<"$out"
done
check "...never another role's (review-old) nor the board's own workspaces" bash -c "! grep -qE 'review-|worktrees/ |wsrev' <<<'$out'"
out=$(LW sweep platform --apply); rc=$?
echo "$out" | sed 's/^/    | /'
check "--apply (exit $rc): 3 done" bash -c "[ $rc = 0 ] && grep -qF '3 done, 0 failed, 3 kept' <<<'$out'"
check "...the leftover workspace archived, the old project deleted" test "$(q "s=>!!s.workspaces.find(w=>w.workspaceId==='wsgone').archived+'/'+s.projects.some(p=>p.projectId==='pjold')")" = "true/false"
check "...platform-a1 removed, folder and branch" bash -c "[ ! -e '$W/platform-a1' ] && ! git -C '$MMR' rev-parse -q --verify refs/heads/a1 >/dev/null"
check "...platform-a2 (unlanded), a3 (live), a4 (dirty) kept, a2's branch too" bash -c "[ -d '$W/platform-a2' ] && [ -d '$W/platform-a3' ] && [ -f '$W/platform-a4/d.txt' ] && git -C '$MMR' rev-parse -q --verify refs/heads/a2 >/dev/null"
check "...a3's agent still runs and its workspace stays" test "$(q "s=>s.agents.find(a=>a.labels.worker==='a3').archived?'no':s.workspaces.find(w=>w.cwd==='$W/platform-a3'&&!w.archived)?'yes':'no'")" = yes
check "...review's workspace and the board's project untouched" test "$(q "s=>!s.workspaces.find(w=>w.workspaceId==='wsrev').archived+'/'+s.projects.some(p=>p.path==='$SYS')")" = "true/true"
out=$(LW sweep platform); check "a second dry run has nothing to do" grep -qF '0 to do, 3 kept' <<<"$out"
out=$(LW sweep platform --bogus 2>&1); rc=$?; check "sweep refuses another option (exit $rc)" test "$rc" = 2
out=$(PATH="$T/nopaseo:/usr/bin:/bin:$(dirname "$(command -v node)")" LW sweep platform --apply); rc=$?
check "Paseo not there: sweep does nothing (exit $rc) and says why" bash -c "grep -q 'Paseo did not answer' <<<'$out' && grep -qF '0 done, 0 failed, 1 kept' <<<'$out' && [ -d '$W/platform-a2' ]"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
