# Inside a project

What `mm new <client>/<name>` makes, and how the pieces work together. Everything here comes from `template/` and is
upgraded by `mm update`. Per-project data (roles, personas, briefs, skills, permissions) is owned by the project's
setup agent.

## Folders (`~/projects/<client>/<name>/`)

| Path | What |
|---|---|
| `CLAUDE.md` | the project brief every agent loads first: where things are |
| `leads/<role>/` | one folder per role: `CLAUDE.md` (role brief), `.claude/skills/`, `.claude/settings.tmpl.json` (permissions) |
| `leads/roles.json`, `leads/raci.json`, `leads/personas.json` | the roles, who is Responsible / Accountable / Consulted / Informed for what, names and avatars |
| `setup/` | the setup agent's folder; humans only may change it |
| `code/` | the product repo on `main`: landed work only, nobody edits it directly |
| `worktrees/lead-<role>/`, `worktrees/w-<item>/` | one git worktree per lead, and one per code worker (sandboxed) |
| `release/` | what production runs; moved only by `bin/deploy` |
| `control/` | the board's database (Beads on Dolt); use `bin/bd`, never the files |
| `site/` | the board (web UI and API proxy) |
| `bin/` | kernel and engine scripts (below) |
| `services.yaml` | the project's processes: dolt, bd-serve, board, wake, and an optional app; plus schedules |
| `.run/` | runtime, written by mm: resolved services, endpoints, logs |

The project root is itself a git repo (the *config repo*). Its pre-commit hook runs `bin/config-check`, which
enforces the governance rules and renders each role's real `settings.json` from its template.

## The work loop
1. A human writes or comments on an item on the board.
2. `wake` sees the board event and, when the assigned lead is idle, sends it a short prompt naming the item (and the
   comment number, `#n`). Lead-to-lead ping-pong stops after 3 hops without a human (`needs-you`).
3. The lead works in its worktree, answers on the item, and hands off through the board (RACI says to whom).
4. The code lead runs one worker per item (`bin/wt w-<item>`) in a bubblewrap sandbox and reads only its short report.
5. `bin/land <worktree>` rebases onto `main`, runs the test gate and fast-forwards `code/`. It never merges and never
   rewrites history.
6. `bin/deploy` moves `release/`, health-checks the app and rolls back on its own if the check fails.

## Kernel scripts (`bin/`)

| Script | Does |
|---|---|
| `lead start\|stop\|ls <role>` | start or stop a lead (a Paseo agent labelled `project`/`role`, in `leads/<role>/`) |
| `bd` | the board's CLI, project-local (its own Dolt over a Unix socket) |
| `wt`, `land`, `deploy` | worktrees, landing, releasing (above) |
| `config-check` | governance rules + permission rendering (pre-commit hook) |
| `role`, `raci`, `persona`, `skill` | the setup agent's tools for roles, RACI, personas, skills (from skills.sh) |
| `health` | every minute (`mm cron`): checks each service; after 3 failures opens a P0 incident on the board, closes it when fixed |
| `backup` | daily (`mm cron`): Dolt backup, readable export, git bundles, to `~/.local/share/backups/<project>/` |
| `svc` | where services are, their logs, restart |
| `trace` | wraps every kernel operation in a trace span (see Observability) |

## Governance
- Only the setup agent changes configuration (briefs, skills, permissions, roles). Others ask it through a board item
  assigned to `setup` with the label `governance`.
- `bin/config-check` holds the rules: what no role may be allowed, what every role must be denied, and that `setup/`
  changes only with a human (`SETUP_HUMAN=1`).
- Permissions are templates with `{root}`, `{home}`, `{project}` and `{url:<service>}`; the rendered files are
  generated and git-ignored.

## Services
One process-compose per machine runs each project in its own namespace. HTTP services get a port and a name,
`<service>.<project>.localhost`, from portless; in domain mode, public services also get `<name>.<domain>`. The
process manager restarts crashed or hung services (liveness probes); `health` only reports.

## Observability
Every kernel operation is a trace in the machine's VictoriaTraces, and every log line is in VictoriaLogs, tagged
with `project` and `service`. That covers board requests, calls to the board API, paseo, git and other commands,
wake events and lead wake-ups, and each `bin/*` run. A command's children join its trace (`TRACEPARENT`). Read it
with `mm obs status | errors | slow | logs`.
