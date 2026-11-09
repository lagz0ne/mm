#!/usr/bin/env bash
# Designs on the board against a real Doop (sy-56e), in containers only: the project's Doop run by bin/doop-run
# straight from this checkout in a throwaway project folder (no mm, no process manager; the fork's image by digest),
# its first start makes the design lead's account and agent key; a frame made through the MCP; then the board's server
# from this checkout (a fake bd serve, an item that links the frame) shows it: Doop's own render as a PNG through the
# board's route, what changed after a new version, the version before still served. Throwaway containers and networks.
# Through mm's Docker wrapper (test/lib/docker.sh: the installed one; MM_DOCKER_BIN for this checkout's copy).
#   MM_DOOP_IMAGE=sha256:<64 hex> test/doop-designs.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
. "$HERE/test/lib/docker.sh"
IMAGE=${MM_DOOP_IMAGE:?MM_DOOP_IMAGE=sha256:<64 hex> (the Doop image, by digest)}
pass=0; fail=0
ok() { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }; bad() { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
T=$(mm_test_dir designs); OUT="$T/check.out"   # the tests' area: its name is the throwaway project
check() { local d=$1; shift; if "$@" >"$OUT" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$OUT" | sed 's/^/       /'; fi; }
PROJECT=$(basename "$T"); P="$T/$PROJECT"; C="mm-doop-$PROJECT"; NET="mm-doop-net-$PROJECT"
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
PORT=$(free_port); URL="http://doop.$PROJECT.localhost:1355"; B="http://127.0.0.1:$PORT"
RUN=""
stoprun() { [ -n "$RUN" ] && kill -TERM "$RUN" 2>/dev/null; for _ in $(seq 1 150); do [ -n "$RUN" ] && [ -d "/proc/$RUN" ] || break; sleep 0.2; done; RUN=""; }
cleanup() { stoprun; $DOCKER kill "$C" >/dev/null 2>&1; $DOCKER rm -f "$C" >/dev/null 2>&1; $DOCKER network rm "$NET" >/dev/null 2>&1; rm -rf "$T" 2>/dev/null || true; }
trap cleanup EXIT

# the project, as mm stamps it (what doop-run and the board read)
mkdir -p "$P/.run" "$P/secrets" "$P/data/doop" "$P/leads/design"; chmod 700 "$P/secrets"
cp -r "$HERE/template/bin" "$P/bin"
(cd "$HERE/template/site" && tar --exclude=node_modules --exclude=dist -cf - .) | (mkdir -p "$P/site" && cd "$P/site" && tar -xf -)
echo "project: $PROJECT" >"$P/.mm-answers.yaml"
echo '{"roles":[{"id":"design"},{"id":"qa"},{"id":"requirement"}]}' >"$P/leads/roles.json"
node -e "require('fs').writeFileSync(process.argv[1],JSON.stringify({containers:{docker:process.argv[2],doop_image:process.argv[3]},services:{doop:{url:process.argv[4]}}}))" "$P/.run/endpoints.json" "$DOCKER" "$IMAGE" "$URL"

echo "== the project's Doop (bin/doop-run, $IMAGE)"
PORT=$PORT DOOP_URL=$URL "$P/bin/doop-run" >"$T/run.log" 2>&1 & RUN=$!
check "Doop answers on loopback" bash -c "for i in \$(seq 1 180); do curl -sf -o /dev/null '$B/healthz' && exit 0; sleep 1; done; exit 1"
check "...its first start made the design lead's agent key" bash -c "for i in \$(seq 1 60); do [ -s '$P/secrets/doop-agent-key' ] && exit 0; sleep 1; done; exit 1"

# the driver: makes the frame as the design lead would (MCP, the key from its file, never printed), runs the board
cat >"$T/drive.mjs" <<'EOF'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
const [P, B, step] = process.argv.slice(2)
const key = fs.readFileSync(`${P}/secrets/doop-agent-key`, 'utf8').trim()
const mcp = async (name, args) => {
  const r = await fetch(`${B}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const j = await r.json(); if (j.error || j.result?.isError) throw new Error(JSON.stringify(j).slice(0, 300))
  return JSON.parse(j.result.content.find((c) => c.type === 'text').text)
}
const st = fs.existsSync(`${P}/../state.json`) ? JSON.parse(fs.readFileSync(`${P}/../state.json`, 'utf8')) : {}
const html = (t, bg) => `<!doctype html><html><body style="margin:0;font:32px system-ui;background:${bg}"><h1 style="padding:40px">${t}</h1></body></html>`
if (step === 'make') {
  const c = await mcp('create_canvas', { name: 'Shop', agent_name: 'Design lead' })
  const f = await mcp('create_frame', { canvas_id: c.id, name: 'Sign-in', html: html('Sign in', '#fff'), width: 640, height: 400, agent_name: 'Design lead' })
  const id = f.id || f.frame?.id
  fs.writeFileSync(`${P}/../state.json`, JSON.stringify({ canvas: c.id, frame: id }))
  console.log(id ? 'made' : `no frame id: ${JSON.stringify(f).slice(0, 200)}`); process.exit(id ? 0 : 1)
}
if (step === 'change') { await mcp('set_frame_html', { frame_id: st.frame, html: html('Sign in, bigger', '#fee'), agent_name: 'Design lead' }); console.log('changed'); process.exit(0) }
// 'board' and 'board2': a fake bd serve with one item that links the frame, the board's server, its answers
const item = { id: 'qd-1', title: 'Design sign-in', status: 'open', assignee: 'design', description: '', comments: [{ id: 'k', author: 'design', text: `First version: doop:${st.frame}`, created_at: new Date().toISOString() }] }
const bd = http.createServer((q, s) => { const u = new URL(q.url, 'http://x'); s.writeHead(200, { 'content-type': 'application/json' })
  s.end(JSON.stringify(u.pathname === '/v0/beads/issues/qd-1' ? item : u.pathname === '/v0/beads/issues' ? { items: [item], has_more: false } : u.pathname === '/v0/beads/events' ? { records: [] } : {})) })
await new Promise((r) => bd.listen(0, '127.0.0.1', r))
const port = await new Promise((r) => { const p = http.createServer().listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)) }) })
fs.writeFileSync(`${P}/../paseo`, '#!/bin/sh\necho "[]"\n', { mode: 0o755 })
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', BD_SERVE: `http://127.0.0.1:${bd.address().port}`, SVC_URL_DOOP: B, PASEO_BIN: `${P}/../paseo`, PASEO_NO_SDK: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '', BOARD_DESIGNS_INDEX_MS: '500' }
const srv = spawn('node', [`${P}/site/server.mjs`], { cwd: P, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d))
const get = async (p) => { for (let i = 0; i < 50; i++) { try { return await fetch(`http://127.0.0.1:${port}${p}`) } catch { await new Promise((r) => setTimeout(r, 200)) } } }
const res = {}
try {
  const d = await (await get('/api/designs/qd-1')).json()
  const f = d.frames?.[0]
  res.listed = d.available === true && f?.id === st.frame && f.canvas.name === 'Shop' && f.width === 640 && f.height === 400
  const img = await get(f.image); const buf = Buffer.from(await img.arrayBuffer())
  res.png = img.status === 200 && img.headers.get('content-type') === 'image/png' && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && buf.length > 1000
  res.change = f.change
  res.before = f.before
  if (f.before) { const b = await get(f.before.image); res.beforePng = b.status === 200 && Buffer.from(await b.arrayBuffer()).length > 1000 }
  res.keyless = !JSON.stringify(d).includes(key) && !log.includes(key)
  res.comments = Array.isArray(f.comments)
} catch (e) { res.error = String(e); res.log = log.slice(-1500) }
srv.kill(); bd.close()
console.log(JSON.stringify(res))
EOF
J() { node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.exit(($1)?0:1)" "$T/r.json"; }
echo "== a frame, and the board"
check "the design lead's frame, made through the MCP with the agent key" node "$T/drive.mjs" "$P" "$B" make
node "$T/drive.mjs" "$P" "$B" board >"$T/r.json" 2>&1; sed 's/^/       /' "$T/r.json" | head -c 600; echo
check "the board lists the frame the item links (doop:<frame>), its canvas and size" J "r.listed"
check "...its image: Doop's own render (Chromium), a PNG, through the board's route" J "r.png"
check "...a first version: no earlier one, no image before; its comments read (none)" J "r.change && r.change.versions === 0 && r.before === null && r.comments"
check "...the agent key in nothing the board sent, nor in its log" J "r.keyless"
check "a new version of the frame (set_frame_html)" node "$T/drive.mjs" "$P" "$B" change
node "$T/drive.mjs" "$P" "$B" board >"$T/r.json" 2>&1; sed 's/^/       /' "$T/r.json" | head -c 600; echo
check "the board: what changed (1 earlier version, by the design lead), its new image" J "r.png && r.change && r.change.versions === 1 && /Design lead/.test(r.change.previous.by)"
check "...and the version before, from its cache (the board saw it)" J "r.before && r.beforePng"
stoprun
check "stopped: its container and network are gone" bash -c "! $DOCKER inspect '$C' >/dev/null 2>&1 && ! $DOCKER network inspect '$NET' >/dev/null 2>&1"
printf '\n%s passed, %s failed\n' "$pass" "$fail"; [ "$fail" = 0 ]
