# Sockets first: HTTP services on unix sockets, one front by name (spike)

Status: **steps 1-3 built, behind `front.enabled` (default off: portless as before, the rollback); 4-9 not yet.**
Refs: sy-onx.

Built: step 1 `listen: unix` and the socket paths in `resolve()` (`test/sockets.sh`); step 2 `mm.front`
(`src/front.ts`, `mm front serve|ls`; `test/front.sh`); step 3 the mm-given ports (`local_port`, recorded in
`.run/services.json`) and mm.front in place of mm.portless when `front.enabled` is on (`test/front.sh`, in a container:
`test/front-container.sh`). The front's table is `$MM_HOME/front/routes/<project>.json`, written by `mm up` from
`resolve()`. It binds 127.0.0.1 and ::1 only, serves `.localhost` names only, and refuses a `-public` socket or a
gated public port as a target (review's conditions 1 and 2). A box keeps its own portless (step 9).

The goal: every HTTP service that can (the boards, VictoriaMetrics/Logs/Traces, Paseo) listens on a unix socket under
`$MM_HOME/run` (folders 0700, sockets 0600). One front listener routes by name to them, for browsers and for the web
proxy (Traefik can't proxy to a unix socket). TCP-only tools (bd serve, Dolt) keep loopback ports that mm assigns and
records. Review's acceptance: (2) a board binds only its sockets, no TCP fallback (QA: no board port on `ss -tln`);
(3) Dolt and bd serve on loopback only, and a per-board Dolt user and password if the tools allow it.

Each fact below gives its evidence: a file and line in this repo, a pinned tool's own help or source, or a prototype
run in a throwaway folder under /tmp (scripts quoted in "Prototypes", the end of this file).

---

## 1. Today's paths

### How a browser reaches a board
- **Local names:** portless (pinned 0.15.13) listens on `portless_port` (1355, `manifest.yaml:37`) and maps
  `<service>.<project>.localhost` to a loopback port. mm wraps every `port: http` service as
  `portless <service>.<project> --force sh -c '<command>'` (`src/project.ts:283`). portless picks the port and hands it
  over as `PORT`. Every `{url:<service>}` and every `url` in `.run/endpoints.json` is
  `http://<service>.<project>.localhost:<portless_port>` (`src/project.ts:223`).
- **The board's local side:** `template/site/server.mjs:25-27,806` listens on `PORT` (it exits without one) at `HOST`
  (127.0.0.1). No sign-in there: the visitor names themselves (cookie `board_user`, `server.mjs:59,829`).
- **The board's public side:** domain mode only. A second listener on `BOARD_PUBLIC_PORT`, always 127.0.0.1
  (`server.mjs:758,807-810`), takes only requests that carry the gateway's signed assertion (`server.mjs:769-779`).
  mm gives the port (`hashPort(<project>/board)`, kept in `.run/services.json`; `src/project.ts:252-255`). mm adds a
  forwarder `<project>.board-public`, `socat TCP-LISTEN:<port>,bind=<bind_host> ... TCP:127.0.0.1:<port>`
  (`src/project.ts:590-601`). It is skipped when bind_host is loopback.
- **Traefik:** a route per public name, written by the machine's `expose <name> <port> --sso` (`src/project.ts:637-655`).
  That route goes to `bind_host:<public port>`, i.e. to the socat forwarder.
- **mm.auth is not a proxy.** It is Traefik's *forward-auth*: Traefik asks `/verify` on every request, gets
  `X-Mm-Assertion`, and then proxies to the board itself (`docs/auth-gateway.md` "What the board trusts", `src/auth.ts`
  header lines 6-14). mm.auth listens on `127.0.0.1:<auth_port>` and on `bind_host:<auth_port>` (`src/auth.ts:725-733`),
  plus its own API socket `$MM_HOME/run/auth.sock` (0600, `src/auth.ts:37,731-732`). **So "the front" is new
  proxying code**, wherever it runs.
- **Boxes:** a box runs its own portless and services in the container. The host reaches a box's public side by socat
  from bind_host to the box's IP (`src/box.ts:316-317,351-362`).

### Who else calls a board, or the services behind it, over TCP
| caller | calls | how (file) |
|---|---|---|
| the process manager's ready/liveness probe | board `/api/whoami`, bd-serve `/healthz`, every `ready.http` | `curl ${url}${path}` through portless (`src/project.ts:286`) |
| `bin/health` (every 1 min) | every service's `ready.http`, bd-serve | node `fetch(svcUrl(name)+path)` (`template/bin/health:19-35`) |
| mm.auth's home page | board public side `/api/summary`, `/api/waiting` | Bun `fetch(http://<bind_host>:<public_port>…)` with an assertion (`src/auth.ts:107-110,135,361-363`) |
| Traefik | board public side | through the socat forwarder (above) |
| the board | bd-serve (all `/api/*`) | node `http.request({host, port})` (`server.mjs:205-207`), `fetch(new URL(…, BD))` (`server.mjs:796`) |
| the board | VictoriaMetrics export | node `fetch(MM_OBS_METRICS…)` (`server.mjs:343-350`) |
| the board | Paseo (presence, workers) | the `paseo` CLI (`server.mjs:33`) |
| `bin/wake`, `bin/flow`, `bin/smoke-beads` | bd-serve | `requireUrl('bd-serve')` through portless (`template/bin/wake:37`, `flow:24`, `smoke-beads:13`) |
| `bin/config-check` | renders `{url:<service>}` into the leads' permissions | `template/bin/config-check:170,216`. Today only `{url:app}` (curl rules for code/ops/qa) and `{url:doop}/mcp` (the design lead's MCP: Claude Code's HTTP MCP, TCP only) |
| `svc url` / `svc ls` | prints the URLs | `template/bin/svc:12` |
| mm's CLI | no board call (only the process manager over `pc.sock`) | `grep fetch src/*.ts` |
| `bin/bd` | Dolt, over its socket (no board) | `template/bin/bd:7` |
| `bin/backup` | Dolt, over **TCP**, as `root` with an empty password | `template/bin/backup:27-31` |
| `bin/dolt-ready` | Dolt socket, `root` with no password | `template/bin/dolt-ready:5,36` |
| tests | `fake-portless`, `.localhost:` URLs | `test/lib/fake-portless.mjs`, `test/{names,portless-claim,auth-e2e,box*,doop*}.sh` |
| **not checked** (not in this repo) | the Supervisor, the brain's `bin/health`, the `expose` tool, `paseo.service` | brain-owned: ops must grep for `.localhost:`, `public_port`, `6767` |

---

## 2. portless: no unix upstream
- A route is `{hostname, port: number, pid}`, and a route without a numeric port is dropped:
  `isValidRoute` requires `typeof value.port === "number"` (portless 0.15.13 `dist/chunk-*.js:1274-1276`).
- Every proxied request dials `createLoopbackConnection(route.port)`, i.e. `net.connect({host: "localhost", port})`
  (`dist/chunk-*.js:36-43`, used at `:771,:868,:985`). There is no `socketPath` anywhere in the package.
- So portless can't take a socket upstream without a fork. **Recommendation: replace it with mm's own front on
  `portless_port`.** mm already gives out and records ports (`hashPort`, `public_port`, `dolt_port`), so the TCP-only
  services (bd-serve, app, Doop) get an mm port, recorded in `.run/services.json`, instead of portless's `PORT`.
  The `portless-claim` check (sy-1qkv) and `--force` then go away. Local names become the front's route table.
  Should the front run *in* mm.auth, or as its own process from the same mm binary? That is open question Q1.

## 3. The board server: what assumes TCP
`template/site/server.mjs`:
- `:25-26` refuses to start without `PORT`. `:806` `listen(PORT, HOST)` and `:810` `listen(PUBLIC_PORT, '127.0.0.1')`.
  Both need a `BOARD_SOCKET` / `BOARD_PUBLIC_SOCKET` path instead, made with umask 0177 so the file is born 0600.
  The prototype (P2) does exactly that. To meet review's (2), the TCP listen goes away once the socket is set: no fallback.
- `:806` logs `http://${HOST}:${PORT}`: cosmetic.
- `:776` the assertion is bound to `x-forwarded-host || host`. The front must pass the **public** Host through,
  or set `x-forwarded-host`. Bun's `fetch(…, {unix})` keeps the Host header you give it (P2: `host` and `xfh` came
  through unchanged).
- `:828` the cookie's `Secure` comes from `x-forwarded-proto`: the front must pass that header on.
- The two sides are told apart by **listener**, not by header. That must stay: two sockets, and the front maps a
  public host only to the public socket, a `.localhost` name only to the local one. The front's bind_host listener
  must refuse a `.localhost` Host. Otherwise anything on the docker bridge could send `Host: <board>.localhost` and
  reach the trusted local side.
- `req.socket.remoteAddress` is not used (grep). It is `null` on a socket (P2), so nothing breaks.
- The board's own clients: bd-serve stays TCP (§6), so `:205` is unchanged. The metrics export (`:350`) and
  `bin/lib/obs.mjs` use node's global `fetch`, which **can't dial a unix socket** in Node 24 without the undici
  package. Once metrics/logs move, the template needs a small `http.request({socketPath})` helper in `bin/lib/svc.mjs`.
- SSE (`events:watch`) streams fine through a Bun front on a socket (P2: three events arrived 200 ms apart).

## 4. VictoriaMetrics / Logs / Traces
- **Metrics 1.155.0 and Logs 1.53.0: yes.** `-help`: "Use unix:/path/to/socket to listen on Unix domain socket".
  P1: both answered `/health` with `OK` over `curl --unix-socket`.
- **Traces 0.12.1: no.** `-help` says "TCP address", and P1 fails:
  `cannot start http server at unix:…: listen tcp4: lookup tcp//…: unknown port`. It keeps a loopback port until a
  release has the flag. A newer release was not checked: open question Q4.
- The socket is made `srwxr-xr-x` (P1). Only a 0700 folder (or a umask set by mm's launcher) keeps others out.
- **What talks to them** (all TCP to 127.0.0.1 today, from `obsPorts()`, `src/obs.ts:11-18`):
  - mm itself (Bun): the shipper `mm ship` → logs `/insert/jsonline` (`src/obs.ts:127`); `mm obs` queries
    (`:162,168,174`); health (`:182`); `src/flow.ts:118`; mm's own spans (`:203`). Bun's `fetch` takes `{unix}`:
    mm.auth already does this (`src/auth.ts:738`). **Easy.**
  - The template (Node, no dependencies): `bin/lib/obs.mjs:90,180,217` pushes OTLP-JSON traces and metrics with
    global `fetch`; the board reads metrics (`server.mjs:350`). These need the socket helper (§3).
  - The stack's self-scrape: `-promscrape.config` targets `127.0.0.1:<port>` of all three (`src/obs.ts:38`).
    promscrape takes host:port targets only; a socket can't be scraped. Metrics can use `-selfScrapeInterval`
    (in its `-help`). Logs/Traces can push their own metrics with `-pushmetrics.url` (in Logs' `-help`), as long as
    the URL they push to is TCP. That means VictoriaMetrics keeps one loopback listener for this, or we lose the
    stack's own metrics: open question Q5.
  - No vmagent and no OpenTelemetry collector here: the services push themselves.
  - Boxes: a box's `.run/endpoints.json` gets the same 127.0.0.1 URLs, which inside the container reach nothing.
    That is unchanged by this plan, and a gap of its own.

## 5. Paseo (pinned 0.13.0)
- **Daemon: yes.** `PASEO_LISTEN` accepts `unix:///path` or an absolute path; `httpServer.listen(path)` clears a
  stale file first (`@getpaseo/server/dist/server/server/bootstrap.js:30-49,1390-1398`).
- **CLI: yes.** `--host unix:///path` maps to `ws+unix://<path>:/ws` (`@getpaseo/cli/dist/utils/client.js:98-109`).
  With no `--host`, the CLI reads the daemon's `listen` from `$PASEO_HOME/paseo.pid` (`client.js:139-146`), so it
  follows a socket by itself. The local credential is keyed by target and knows `unix://`
  (`server/local-credential.js:43-56`).
- **SDK: yes, but only through its node entry.** `@getpaseo/client/dist/node/index.js:5,63-67` builds a `ws`
  WebSocket with `socketPath`. The default entry, which `template/bin/lib/paseo.mjs` loads via `sdkPath()`, uses
  `globalThis.WebSocket` (`daemon-client-websocket-transport.js:2-19`), which has no socket option. `lib/paseo.mjs`
  must load the node entry or pass a `webSocketFactory`, and accept `unix:` in `PASEO_URL` / `endpoints.paseo`
  (today `ws://127.0.0.1:6767/ws`, `lib/paseo.mjs:30`, `lib/lead-workspace.mjs:32`).
- **The system daemon** runs from the brain's `paseo.service` (`manifest.yaml:138`): moving it is an ops migration,
  not mm. It also has the relay and the web UI. Does anything outside this machine need its TCP port? Open question Q3.
- **A box's daemon** listens on `0.0.0.0:6767` on the box network (`src/box.ts:301`). The machine's daemon joins it
  as a host at `tcp://<box ip>:6767` (`src/box.ts:747`), across the container boundary. A socket would need a mounted
  folder and a shared group, as the box's Doop already does (0660, the owner's group, `src/box.ts:139-141,308`).
  That comes later (step 9).
- I did not start a daemon (no live Paseo, and a throwaway daemon starts agents' machinery). This section is
  source-only.

## 6. bd serve and Dolt
- **bd serve 1.3.2: TCP only.** `--addr`: "Address to bind as IP:PORT; the host must be a numeric IP literal"
  (`bd serve --help`). It stays on a loopback port that mm gives out. bd serve **has a bearer token**:
  `--auth-token-file` (env `BEADS_SERVE_TOKEN_FILE`), one token per line, re-read while running (rotation), and
  deliberately no token flag on the command line. That closes the loopback port to every other local process; the
  board, wake, flow and health would send the token.
- **Dolt 2.6.2, loopback:** already `--host 127.0.0.1 --port <dolt_port> --socket <root>/.dolt/mysql.sock`
  (`template/services.yaml`). It needs the port: "dolt exits without a TCP port" (`manifest.yaml:155`).
  P3: bd reaches it through `BEADS_DOLT_SERVER_SOCKET` alone, with no port it could know.
- **Today Dolt has `root` with no password**, over the socket and over TCP (P3 step 3). The socket is
  `srwxr-xr-x`, so other uids can't connect to it. **But anything that can reach `127.0.0.1:<dolt_port>` is root of
  that board's database**: another uid, or an agent sandbox that hides the files but shares the network.
- **Users and passwords in Dolt:** the config.yaml `user`/`password` fields and the `-u/-p` flags are gone ("This
  option is no longer supported. Instead, you can create users using CREATE USER and GRANT", `dolt sql-server
  --help`). Users live in `.doltcfg/privileges.db`, 0600, next to the database. `--skip-root-user-initialization`
  exists, and the binary knows `DOLT_ROOT_PASSWORD` / `DOLT_ROOT_HOST` (the root made at first start). The `dolt`
  client reads `DOLT_CLI_USER` / `DOLT_CLI_PASSWORD` from env; with neither it prompts and fails without a tty (P3).
  **P3 proves it:** `CREATE USER 'board'@'%' IDENTIFIED BY …; GRANT …; ALTER USER 'root'@'localhost' IDENTIFIED BY …`.
  Then root without a password gets `Access denied`, `board` with the wrong password `Access denied`, with the right
  one `select 1` works.
- **bd passes it, through env only:** `BEADS_DOLT_SERVER_USER` and `BEADS_DOLT_PASSWORD` (P3 steps 6-7). `bd create`,
  `bd list` and `bd serve` all work over the socket with them. `bd list` with no credentials: `Access denied for user
  'root'`. **bd serve with no credentials refuses to start** (P3 step 7).
- **bd has no password file.** `BEADS_DOLT_CREDENTIAL_COMMAND` exists, but it is for a token "gateway" mode. P4:
  bd sent the command's output as the *user name*, over TCP to the port in its own config, ignoring the socket. Its
  own message: "bd serve holds one connection identity for the life of the process and cannot refresh it". The only
  config key is `dolt.user` (`bd dolt set user`). **So the password reaches bd only in its environment.** That breaks
  the vault's rule "never argv, never env" (`src/vault.ts:1-2`). Plainly: Dolt can take a per-board user and
  password, and bd can pass them, but only by env.
- **Sketch: a per-board Dolt password from the vault, never printed** (needs review's yes on the env exception):
  1. `mm up` (or `mm update`), once per board: when the vault has no `<project>.dolt-board`, mm makes 32 random bytes
     and seals them (`vault.seal`, from a pipe). Over the socket, as root (still without a password, the first
     time), it runs `CREATE USER 'board'@'localhost'` and `'board'@'127.0.0.1'` (P3 used `'%'`; the narrow hosts were
     not tried), `GRANT ALL ON <db>.*`, then `ALTER USER root … IDENTIFIED BY <a second sealed secret,
     <project>.dolt-root>`. These statements go to `dolt sql` on **stdin** with `DOLT_CLI_PASSWORD` in the child's
     env, never argv: worth checking that `dolt sql` reads stdin (not tried).
  2. Services: `bd-serve` declares `secrets: [dolt-board]`. mm already opens it into the memory-backed runtime folder
     and sets `DOLT_BOARD_FILE` (`src/project.ts:274-276`, `src/cli.ts:490-497`). The command becomes
     `BEADS_DOLT_PASSWORD="$(cat "$DOLT_BOARD_FILE")" exec bd serve …`, so the value sits only in bd serve's own
     environ (0400, its own uid).
  3. `bin/bd` (agents' and scripts' CLI) does the same from the same file. **So every agent that may run `bin/bd`
     can read the password**: it guards the board against *other* projects' agents, other uids and sandboxes without
     that file, not against the project's own leads. `bin/dolt-ready` (a hand-written root login,
     `template/bin/dolt-ready:36`) needs `mysql_native_password` scrambling, or a call to `dolt sql` instead.
     `bin/backup` (root over TCP) moves to the socket and the board user.
  4. The rollback: `ALTER USER root … IDENTIFIED BY ''`, drop `board`, remove the env. The data is untouched.

---

## Target picture

```
browser (local)  ──► 127.0.0.1:<portless_port>  mm front (local names only)
                       ├─ board.<p>.localhost     ──► $MM_HOME/run/<p>/board.sock          (0600; dir 0700)
                       ├─ bd-serve.<p>.localhost  ──► 127.0.0.1:<mm port>                  (TCP: bd serve, token)
                       ├─ app/doop.<p>.localhost  ──► 127.0.0.1:<mm port>                  (TCP: product / Doop)
                       └─ metrics|logs.localhost  ──► $MM_HOME/run/obs/{metrics,logs}.sock
Traefik ─forward-auth─► mm.auth (unchanged)
        ─proxy───────► <bind_host>:<front_port>   mm front (public hosts only; refuses .localhost)
                       └─ <board public host>     ──► $MM_HOME/run/<p>/board-public.sock   (assertion checked)
mm.auth home page ───► $MM_HOME/run/<p>/board-public.sock  (Bun fetch {unix})
Paseo (system)       ► $MM_HOME/run/paseo.sock    (ops migration; CLI follows paseo.pid)
VictoriaTraces       ► 127.0.0.1:<traces_port>    (TCP until a release listens on unix)
Dolt                 ► <root>/.dolt/mysql.sock + 127.0.0.1:<dolt_port> (port required by dolt), per-board user
```
- **Stays TCP, and why:** bd serve (numeric IP only), Dolt's port (it won't start without one), VictoriaTraces 0.12.1
  (no unix listener), the app slot and Doop (product code and the leads' `curl {url:app}` / MCP `{url:doop}` are
  HTTP URLs), the front itself (browsers and Traefik speak TCP), a box's Paseo across the container boundary (until
  step 9), and mm.auth's sign-in listener.
- Socket paths: `sun_path` holds at most 107 bytes. `$MM_HOME/run/<project>/board-public.sock` fits normally, but mm
  must check the length in `resolve()` and refuse clearly.

## Steps, in the order they can land (each small, each with its test)
1. **Route table in `resolve()`.** A service may declare `listen: unix`. resolve() gives it
   `socket: $MM_HOME/run/<p>/<service>.sock` (and `public_socket`), checks the length, and writes `socket` next to
   `url` in `.run/endpoints.json`; `svc.mjs` gets `svcSocket()` and a `request()` helper over `http.request`.
   Nothing listens yet. *Test:* new `test/sockets.sh` (hermetic, like `test/names.sh`): the paths, the length refusal,
   endpoints.json, and the helper against a node server on a socket.
2. **The front, routing to ports first.** A front (Bun: `Bun.serve` on a port, `fetch(…, {unix})`, P2) that serves
   the route table on a test port: names → loopback ports and sockets, SSE streaming, Host and `x-forwarded-*` passed
   on, unknown name 404, `.localhost` refused on the public listener. *Test:* `test/front.sh`, hermetic, a fake board
   on a socket and one on a port.
3. **mm gives the ports instead of portless** (bd-serve, app, Doop: `hashPort`, recorded like `public_port`), with the
   front on `portless_port` behind `front.enabled` (off: portless as today, the rollback). Probes become
   `curl --unix-socket …` / mm's port. *Test:* `test/front.sh` plus `test/names.sh` and `test/portless-claim.sh`
   unchanged with the flag off; `test/mm-docker-container.sh`-style container run with it on.
4. **The board on its sockets** (template): `BOARD_SOCKET` / `BOARD_PUBLIC_SOCKET`, umask 0177, no TCP listen when
   set; `bin/health` and the probes through the helper. An older template keeps `PORT` (mm checks for the env var
   in `site/server.mjs`, as `publicSide()` does today, `src/project.ts:206-210`). *Test:* a node test of server.mjs
   on a socket (whoami, the public side refusing without an assertion, Host binding); in a container: `ss -tln` shows
   no board port.
5. **Public side through the front:** Traefik routes go to `<bind_host>:<front_port>` (one port), the socat
   `*-public` forwarders go away, mm.auth's `askBoard` dials the public socket. The `expose` tool is the brain's:
   this needs ops (a route's target changes). *Test:* `test/auth-e2e.sh` with the test route tool, and
   `test/box-gateway.sh` for a box (still socat to the box IP until step 9).
6. **Metrics and Logs on sockets:** `src/obs.ts` (Bun `{unix}`), the template's `obs.mjs` and the board's export
   through the helper, self-scrape per Q5. Traces stays on its port. *Test:* `test/pc-logs.sh` and `test/flow.mjs`
   with a throwaway stack (P1 shows the binaries run as a non-root user in /tmp).
7. **bd serve token:** `--auth-token-file` from the vault (a file, re-read: no env needed); board, wake, flow, health
   and smoke-beads send it. *Test:* hermetic bd serve (P3 shows it runs from /tmp): 401 without the token.
8. **Per-board Dolt user** (the sketch in §6), after review's yes on the env exception. *Test:* P3 turned into
   `test/dolt-auth.sh` (throwaway Dolt): root refused, board accepted, bd serve refuses to start without it, backup
   and dolt-ready work.
9. **Boxes and Paseo:** the system Paseo on a socket (ops migration; `lib/paseo.mjs` loads the SDK's node entry
   first, a step of its own); the box's board and Paseo sockets in a mounted folder, 0660 in the owner's group, as
   Doop is. *Test:* `test/paseo-lib.mjs` against a fake socket daemon; box tests in throwaway containers.

## Risks: what breaks for whom during a rollout
- **Two kinds of template at once.** A project on an older template still needs `PORT` and portless names until its
  `mm update`. The front must route both (step 3's table holds ports and sockets), and portless can't stop while any
  project still needs it.
- **Every `.localhost` URL that was saved anywhere:** the leads' rendered permissions (`curl {url:app}`), bookmarks,
  `svc ls`, the Supervisor and the brain's health. The names stay the same if the front takes 1355, which is the
  reason to keep that port.
- **The local side is still open to every local uid through the front on 1355,** exactly as through portless today.
  The 0600 socket closes only the direct way in. To close the front too, local browsing would go through the sign-in
  (Q2).
  **Who is every local user** (who reaches 127.0.0.1 / ::1, so the front): the machine's user (every agent, every
  project's services, mm itself), the owner's admin account, the signer's user (later), and the system services.
  Nothing a box runs is on the host's loopback: a box has its own network namespace, and reaches the host only through
  the forwarders mm gives it.
- **Traefik's targets change** (one front port in place of one port per service): an ops migration with a rollback
  (old routes and forwarders back). Until it lands, a board's public side must still be reachable: steps 4 and 5
  ship together for public boards, or the board keeps `BOARD_PUBLIC_PORT` until step 5.
- **The front becomes a single point of failure** for local names (portless is one today, too). Inside mm.auth, one
  crash takes sign-in *and* local names down together.
- **Socket permissions across uids:** boxes (another uid) and Traefik (docker) can't use a 0600 socket. Boxes need
  0660 and a group; Traefik always goes through the front's TCP listener.
- **bd password in env** (step 8): visible in `/proc/<pid>/environ` to the same uid, and passed to every child of
  bd serve. bd's hooks are off in serve, so serve starts no children of its own.
- **A stale socket file after a crash** makes the next listen fail with EADDRINUSE. Paseo and the prototype unlink
  first; the board must too, without unlinking a socket that something still answers on (what `bin/dolt-run` does
  for Dolt).

## Open questions (for the owner or review)
- **Q1 (owner):** the front inside mm.auth, or its own process (`mm.front`, same binary, namespace mm)? Own process:
  a crash doesn't take sign-in down, and the proxy holds no session secrets. Inside mm.auth: one process fewer, and
  the host map is already loaded.
- **Q2 (review):** is the local side through the front on 1355 (any local uid, as today) acceptable, or should local
  browsing need the sign-in too?
- **Q3 (owner/ops):** does anything outside this machine use the system Paseo's TCP port (the app, the relay)? If so,
  it keeps a TCP listener next to the socket.
- **Q4 (owner):** wait for a VictoriaTraces release that listens on unix, or keep its loopback port (and is a
  version bump in scope here)?
- **Q5 (review):** lose the stack's own metrics, or keep one loopback listener on VictoriaMetrics for
  `-pushmetrics.url` / scrape?
- **Q6 (review):** bd takes the Dolt password only from env (§6). Is that exception to "never env" acceptable for
  bd serve and `bin/bd`? If not, the per-board password waits for bd upstream (a password file option).

## Prototypes (all under /tmp, throwaway; nothing of the machine's touched)
- **P1** `vm-try.sh`: each pinned `victoria-{metrics,logs,traces}` with `-httpListenAddr unix:<tmp>/<x>.s` and a tmp
  `-storageDataPath`, then `curl --unix-socket … /health`. Results: metrics `OK`, logs `OK`, traces fatal
  `listen tcp4: … unknown port`; the sockets were `srwxr-xr-x`.
- **P2** `front/`: `board.mjs` (node `http`, `listen(sock)` with umask 0177, echoes Host, an SSE route) and
  `front.ts` (Bun, 10 lines: Host → `fetch(url, {unix: sock, headers, body})`). Results: the socket `srw-------` in a
  `drwx------` folder; Host and `x-forwarded-host` kept; SSE events 200 ms apart; unknown name 404;
  `ss -tlnp | grep pid=<board>`: none.
- **P3** `dolt-auth.sh`: the pinned bd 1.3.2 and dolt 2.6.2 (manifest URLs, sha256 checked). A throwaway project
  (`bd init --server --stealth` as `bin/init` does), then `dolt sql-server --host 127.0.0.1 --port <p> --socket <s>`.
  root logs in with no password (as on every board). Then `CREATE USER board … ; GRANT …; ALTER USER root …`.
  Results: root refused, wrong password refused, right one accepted (`DOLT_CLI_PASSWORD` env). `bd list` refused;
  with `BEADS_DOLT_SERVER_USER` + `BEADS_DOLT_PASSWORD`, `bd create` / `bd list` / `bd serve` work, and bd serve
  without them won't start. The users are in `.doltcfg/privileges.db` (0600). `bd-sock.sh`: with only the socket
  set and Dolt on a port bd can't know, `bd list` works.
- **P4** `bd-credcmd.sh`: `BEADS_DOLT_CREDENTIAL_COMMAND="cat <0600 file>"`. Result: `Access denied for user
  '<the file's content>'`, over TCP to the port in bd's config. Not a password path.
