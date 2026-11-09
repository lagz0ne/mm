# A per-project work queue: what the Paseo Hub gives, and what mm builds

Status: research and decision (sy-2elg step 1). No runtime code yet.

## The goal

One shared model account should not have to do a project's work by itself. The work is split into the **board** and a
**queue**:

- The board is still where work comes from. When an item is ready and has its Task, it becomes one **unit** in the
  project's queue, and the unit names the role it needs.
- A **worker** is a Paseo daemon with its own model account. Anyone who joins the project can run one. A worker takes
  a unit, does the work on its own machine and acks it. The results come back as messages, artifacts and a branch.
- By default units are shared out by **weighted round robin** (each worker has a weight, a capacity and a set of
  roles). They do not all go to one account. If a worker doesn't ack a unit in time, the unit goes to the next worker.
- Review, gates, landing and rollouts stay on the main machine. A worker that runs off the main machine gets only the
  project's code and board.

The question for this step: can the Paseo Hub "mailbox" be that queue?

## Sources

Version read: **Paseo 0.13.0** (`@getpaseo/cli`, `@getpaseo/server`, `@getpaseo/protocol`), the copy mm installs in
its npm folder (`npm/paseo/node_modules/@getpaseo/`). The CLI was not run. This step was read-only, and running the
CLI wasn't allowed, so the help text below comes from the command definitions in the package. Files read:

| Short name | File (under `@getpaseo/`) |
|---|---|
| hub-cli | `cli/dist/commands/hub/index.js`: the `paseo hub` subcommands (login, init, connect, status, disconnect, permissions, projects, export, deploy, logout) |
| connect | `cli/dist/commands/hub/connect.js`: `paseo hub connect [origin] --api-key --permission` |
| permissions | `cli/dist/commands/hub/permissions.js`: `paseo hub permissions list/grant/revoke` |
| hub-api | `cli/dist/commands/hub/hub-client/index.d.ts`, `internal/contracts.d.ts`: the Hub HTTP API the CLI uses |
| init-plan | `cli/dist/commands/hub/init-plan.js`: the trigger YAML the CLI writes |
| executions | `server/dist/server/server/hub/execution-controller.js`, `daemon-executions.js`: what a daemon does when the Hub talks to it |
| remote | `server/dist/server/server/hub/relationship-remote.js`, `relationship-retry.js`: enrollment, socket, heartbeat, reconnect |
| perms-list | `protocol/dist/messages.js` (`DAEMON_PERMISSIONS`), `server/dist/server/server/authorization/operation-permissions.js` |

Public docs (`https://paseo.sh/docs/hub/...`, linked from the CLI): `concepts`, `daemons`, `api`, `triggers`,
`security`, `hosted`, `faq`. They were read on 2026-11-09.

**There is no "mailbox" in Paseo 0.13.0.** The word does not occur in the CLI, the server or the protocol. It shows up
only as an icon name in the bundled web UI. No public doc page covers a mailbox, an inbox or a queue (docs index). The
Hub is something else: an **event router**. A trigger (a GitHub, Slack or Discord event, or a manual run through the
API) starts a workflow, and each step of that workflow runs one agent on **one named daemon** (docs `concepts`). The
answers below describe that model.

## Answers

### 1. Delivery

- The daemon keeps a WebSocket open to the Hub. It pings every 10 s and drops the socket after 45 s without a pong.
  When the socket drops, the daemon reconnects with bounded exponential backoff (0.5 s, doubling, capped at 30 s, with
  jitter) (remote).
- The Hub sends `hub.execution.agent.create.request` (an `executionId`, a prompt, a `cwd`, a provider, model and mode,
  an env, MCP servers, a tool policy, and a worktree: branch-off, checkout a branch, or checkout a PR). The daemon
  starts the agent and answers `hub.execution.agent.create.response`. After that it streams
  `hub.execution.agent.update` and `hub.execution.agent.stream` events for the agents it owns (executions).
- **It always goes to one daemon.** A trigger's `run.target` is `{ daemon: <slug>, cwd }` (init-plan; docs `triggers`).
  The slug becomes a daemon id when the configuration is activated (docs `daemons`). Nothing can target a group.
- Ordering: the steps of one workflow run in sequence, and each step sees the previous step's output (docs `concepts`).
  Control actions on one execution are applied in order (executions). Nothing orders separate runs against each other.

### 2. Ack and retry

- The create response is an ack of the **start**. Nothing acks that the work got done. Inside the run, the agent ends it
  by calling the Hub's `hub.finish_execution` tool (init-plan).
- Limits are set per run: `max_runtime` and `idle_timeout` (init-plan; docs `triggers`).
- Redelivery is idempotent. If a response is lost or the Hub restarts, the Hub sends the same create again, and the
  daemon returns the agent it already has for that `executionId` instead of running the prompt again (executions; docs
  `daemons`).
- **An offline daemon: "Nothing is queued for later."** The event fails with `daemon_not_connected` and has to be fired
  again (docs `daemons`, `faq`). When an agent closes or errors, the Hub records it as interrupted and does not start a
  second one (docs `daemons`). Nothing hands the work to another daemon.

### 3. Routing

- A sender can address only the daemon that the trigger configuration names. The API's `POST /api/v1/manual-runs`
  takes a project, a trigger name, an actor and an input. It **has no daemon field** (docs `api`). No pool, label,
  role, capacity or "any free daemon" option exists (docs `daemons`, `triggers`).
- For mm to do the choosing through the Hub, it would need one trigger per worker, or it would have to rewrite and
  reinstall the trigger before every dispatch (`POST /api/v1/triggers/install`). Reinstalling also fails while the
  target daemon is offline (docs `daemons`). Both are workarounds, not routing.
- The API lists no endpoint to read a run's status or output, or to cancel a run (docs `api`).

### 4. Permissions

- **Enrolling:** `paseo hub connect` uses an organization API key or login to get a single-use enrollment token
  (`POST /api/v1/daemons/enrollment-tokens`, scope `daemons:enroll`). The daemon trades the token for its own
  credential (`POST /api/daemons/enroll`) (connect, remote, hub-api). **A daemon can have only one Hub relationship**
  (docs `daemons`).
- **Removing:** `paseo hub disconnect` on the machine (`DELETE /api/daemons/<id>`), or "Revoke daemon" in the Hub.
  Revoking does not stop agents that are already running on that machine (remote; docs `daemons`).
- **Daemon rights:** the person who runs the daemon grants them on that machine:
  `daemon.read`, `daemon.manage`, `tunnel.manage`, `access.manage`, `workspace.read`, `workspace.write`,
  `workspace.manage`, `automation.manage`, `hub.execute` (perms-list). Running agents needs `hub.execute`, and it is off
  by default (permissions; docs `security`). `hub.execute` is wide: it lets the Hub create and continue agents, read
  their timelines, set their model and permission mode, and archive workspaces. **"It is not an isolation boundary
  around Hub-created work"** (docs `security`).
- **Who may send:** inside the Hub, a trigger's `from_users` allowlist, which must not be empty. On the API, an
  organization API key with the scope `runs:dispatch`. Keys are scoped to the whole organization, and no project-level
  scope exists (docs `api`). Who may read: the organization's dashboard. The docs don't describe member roles.

### 5. Cost and limits

- Hosted Hub: the Free plan has one seat and a monthly allowance of agent runs. Pro adds unlimited runs and more seats.
  The docs don't give prices or exact figures. A self-hosted Hub has no plans and no billing (docs `hosted`).
- Rate limits, payload limits for a manual run's `input`, and retention are not stated (docs `api`, `hosted`). The
  only limits given are for the legacy configuration bundle: 100 files, 1,000,000 characters per file.

### 6. What the Hub is not

- It is not a queue and not a mailbox. Nothing is held for an offline daemon (docs `faq`).
- It does not run the agent. The daemon does, on its own machine (docs `faq`).
- It does not clone the code. `cwd` must already exist on the daemon (docs `daemons`).
- It does not hold the board, and it knows nothing about roles, capacity or weights.
- It is not an isolation boundary between projects (docs `security`).

## Need → Hub gives → gap

| Need | Hub gives | Gap mm must fill |
|---|---|---|
| A unit waits until a worker takes it | Nothing is queued. An offline target fails the event | The queue itself: units held per project |
| Weighted round robin over workers with weight, capacity and roles | A fixed daemon per trigger. No pools, labels or capacity | The chooser, plus a way to address the daemon it chose (the Hub has none per run) |
| Ack the work, with a timeout and a hand-off to the next worker | Ack of the start, `finish_execution`, `max_runtime`/`idle_timeout`. No move to another daemon | Lease and ack timeout, redelivery to the next worker |
| Redelivery is safe | Idempotent create by `executionId` on one daemon | Keyed by unit, not by daemon (mm can reuse the idea) |
| A person who joins works as themselves, on one project | Org API keys and org-wide daemons. One Hub relationship per daemon | A per-project grant and a bearer token bound to that person and project |
| A worker gets only one project's code and board | `hub.execute` is wide and not an isolation boundary | The token's scope, and a worker that checks out only that project |
| Results come back: messages, artifacts, a branch | Agent stream to the Hub, replies only to Slack/Discord. No API to read output | The result channel: comments on the item, artifacts, a pushed branch |
| See the flow | The Hub's activity page (outside mm) | `mm obs flow`: units, leases, acks, per worker |
| Cost | Free plan has a monthly run allowance. Pro is unlimited | None if mm doesn't use the Hub |

## Decision: a small queue in mm, not the Hub

**mm builds a small per-project queue, and Paseo daemons stay the runners.** The Hub has no mailbox. Its dispatch goes
to one fixed daemon per trigger, nothing waits for an offline daemon, and work never moves on to another daemon. The
three things this plan needs are exactly the three things the Hub doesn't do: holding units, choosing a worker, and
moving a unit on when its ack is late. Building those on the Hub would mean mm keeps the queue and the chooser anyway
and then rewrites triggers so a dispatch reaches the daemon it chose. Its keys are organization-wide, and `hub.execute`
is not a boundary, so neither fits "one person, one project". On the hosted Hub, every unit would also count against a
plan's run allowance.

The queue lives with the board. A unit is a ready item plus its Task. A worker **pulls** it: it asks the project's
public address, with its bearer token, for a unit for its roles. That way a worker behind NAT or offline needs nothing
held for it. The pull gives the ack and the timeout for free (a lease with an expiry, like the board's own leases). The
chooser runs when a worker pulls: a unit goes to a worker only when that worker is its turn under weighted round robin
and has free capacity. The worker runs the unit on its own Paseo daemon (`paseo run` locally, its own model account),
pushes a branch, writes its result on the item, and acks. A lease that expires puts the unit back for the next worker.

The Hub can still come later as an **optional event source**: a trigger whose step tells a worker to pull. It is not
the queue.

## Pilot design (step 2)

- **Where:** the playground project only. No other project gets a queue until the pilot passes.
- **Two workers, 1:1:** two Paseo daemons with two different model accounts, each enrolled as one person with a grant
  on the playground (`weight 1`, `capacity 1`, roles `dev`). One may run on the main machine and one off it.
- **Units:** 6 to 10 small, ready playground items. With 1:1 weights the expected split is about even (at most one apart
  when both are always free).
- **Faults to test:** stop one worker in the middle of a unit. Its lease expires and the unit goes to the other worker,
  exactly once (one branch, one result on the item). A worker with no grant, or a token from another project, is
  refused.
- **What stays on the main machine:** review, gates, landing and rollout, as today. A worker's branch is only an input
  to review.
- **What `mm obs flow` shows** (new rows next to today's per-role rows): per project and worker: units taken, acked, and
  expired (re-queued); lease p50/p95 (taken → acked); queue p50/p95 (ready → taken); and the share each worker got
  compared with its weight. `mm obs item <id>` shows the unit's path: queued → taken by worker → (expired → taken by the
  next) → acked → review.
- **Pass:** every unit is acked or re-queued, no unit is done twice, the split is within one of 1:1, and the fault
  cases behave as above.
