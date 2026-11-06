# mm

Set up a machine for agent-run projects, and stamp projects from one template.

A project is a work board (Beads + Dolt), role leads and workers (Paseo agents), a governance layer (config checks,
a setup agent that alone changes configuration), land/deploy scripts with rollback, and its services, all run by one
machine-level process manager. mm installs what the machine needs, creates projects, upgrades them from the template,
and removes them cleanly.

## Install

Needs `git` and `curl`. Linux (x64, arm64) first; macOS builds are published but not yet supported end to end.

```sh
curl -fsSL https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm | sh
```

That puts the binary in `~/.mm/bin/mm` and runs it; the first run is `mm onboard`. Without a terminal, pass the
answers: `... | sh -s -- onboard --yes --access tailscale`. A given release: `MM_VERSION=v0.1.0`.
Onboard installs everything it can; what only you can give (tokens, keys, answers) it leaves to `mm needs`, which
says what each one is for and how to get it. Fill each with `mm fill <name>`; `mm doctor` passes once the required
ones are there.

## Use

```sh
mm doctor                    # check this machine against the manifest; changes nothing
mm onboard                   # install and configure what is missing, then doctor
mm needs                     # every input (answers, secrets, accounts): what is missing and how to get it
mm fill <name> [--from f]    # fill one; a secret from a file, a pipe or a hidden prompt, never the command line
mm new acme/shop             # a project in ~/projects/acme/shop, services started
mm ls | inspect acme/shop    # projects, their services and URLs
mm up | down | restart acme/shop
mm update [acme/shop]        # bring projects up to this mm's template (three-way merge; --dry-run, --continue, --abort)
mm archive acme/shop         # stop, unload, unexpose, archive agents, pack to a tarball, delete; mm restore <tarball>
mm obs status | errors | slow | logs     # what the projects did (metrics, logs, traces on this machine)
mm vault init --recovery <age1…>         # sealed secrets: this machine's key + your offline recovery key (public half)
mm sync [--init <repo>]      # seal what can't be rebuilt into your private mastermind repo, and push it
mm restore <repo>            # a whole machine onto a blank box, on hold until you say the old box is down (--release)
```

Secrets are sealed with age to two keys (`docs/vault.md`): the machine's own, and your recovery key, which stays
offline. **If a key is ever exposed, rotate the secrets themselves:** sealed files stay in git history (mastermind)
for ever, so resealing them to a new key is not enough. A lost or exposed machine key costs a reseal plus that
rotation; an exposed recovery key needs a new recovery key too. Restores are documented in `docs/restore.md`.

## Operating model

### Who does what
- **You (humans)** steer through the **work board**: write items, comment, approve. You don't edit project files or
  chat with agents directly; the board is the conversation, and every lead answers there.
- **Leads** are Claude Code agents (via Paseo), one per role: requirement, design, code, qa, architecture, ops by
  default. They pick up their items, answer every human comment, and coordinate through a RACI. The code lead runs
  workers in sandboxed worktrees. Work reaches `code/` only through `land` (test-gated) and production only through
  `deploy` (health-checked, automatic rollback).
- **The setup agent** is the only one that changes a project's own configuration: roles, briefs, skills, permissions.
  Ask it through a board item. A pre-commit check enforces the rules.
- **mm** owns the machine and the project lifecycle: what is installed, what runs, upgrades from the template,
  removal, schedules (health every minute, backup daily), and observability.

### How each kind of change happens

| What changes | Path |
|---|---|
| Product code | leads and workers → `land` → `deploy` |
| Project configuration (roles, briefs, skills, permissions) | a board item for the setup agent |
| Engine and kernel (`bin/`, `site/`, `services.yaml`, …) | a new mm template → `mm update` (three-way merge; project edits kept) |
| The machine | `mm onboard`, `mm config`, a newer mm (`MM_VERSION=… curl … \| sh`) |

Don't edit a project's files by hand. If you need to, do it through the setup agent or in the template.

### Where to run it

**Preferred: one dedicated Linux machine per client (engagement), with several projects on it, reached over
Tailscale.**
- Use a server or VM, not a laptop: leads work around the clock.
- Run as a normal user with sudo, with lingering on (`sudo loginctl enable-linger $USER`) so services survive logout.
- `mm onboard --access tailscale`. Boards and apps are reachable only inside your tailnet, and nothing is on the
  public internet.
- One client per machine keeps their agents, data and secrets apart, and one `mm update` upgrades all of that
  client's projects together.

**Domain mode** (`--access domain --domain example.com`) is for when people outside your tailnet need the board or
the app. A wildcard DNS name points at the machine's web proxy. Public services get `<name>.<domain>`; boards stay
behind a password. It needs Docker, a reverse proxy and an `expose` tool on the machine, so there is more to run and
more exposed. Use it only when you need it.

Not supported: running as root (`mm doctor` refuses: projects live in a normal home), and mixing unrelated clients
on one machine.

### A project's life
```sh
mm new acme/shop                               # services up; `mm inspect acme/shop` shows the board URL
cd ~/projects/acme/shop && for r in requirement design code qa architecture ops setup; do bin/lead start $r; done
# open the board, write the product brief as the first epic; the leads take it from there
mm obs errors --since 24h                      # daily: what failed (or let your own automation read it)
curl -fsSL https://raw.githubusercontent.com/lagz0ne/mm/main/bin/mm | MM_VERSION=v0.2.0 sh -s -- --version   # upgrade mm
mm update --dry-run && mm update               # after upgrading mm: bring every project to the new template
mm archive acme/shop                           # done: clean removal, tarball kept; `mm restore` brings it back
```

More on the inside of a project: [docs/project-model.md](docs/project-model.md).

## How it is put together

- `manifest.yaml` — what a machine needs (tools with pinned versions and checksums, paths, secret *names*,
  services). `doctor` reads it, `onboard` fixes from it.
- `template/` — the project kernel and engine, rendered by `mm new` and merged by `mm update`. Per-project data
  (roles, personas, briefs, skills, permissions) belongs to each project's setup agent.
- One process-compose per machine (`mm-pc`, a systemd user unit) runs every project as a namespace, plus the
  machine services in namespace `mm`: the portless name proxy, `mm cron` (project schedules), and a Victoria stack
  (VictoriaMetrics, VictoriaLogs, VictoriaTraces; loopback only) that every engine operation reports to.
- HTTP services get their port from portless and a name `<service>.<project>.localhost`. With `access: domain`,
  public services are routed by the machine's web proxy.

## Develop

```sh
bun install
bun run build                # packs template/ into the binary: dist/mm
test/lifecycle.sh <old-template-dir>   # on a real machine: new -> update -> restart -> crash -> archive -> restore
test/needs-fill.sh           # mm needs / mm fill, hermetic (throwaway HOME)
test/sentinel.sh             # the system profile's sentinel, on a throwaway board
node test/supervisor.mjs     # the system profile's supervisor (stall, handoff, idle, dirty), hermetic (fake board, stub paseo)
node test/wake-stall.mjs     # bin/wake recovers from an event stream that hangs (fake board, stub paseo)
node test/wake-signals.mjs   # bin/wake: HANDOFF / BLOCKED / DEPENDENCY / REOPEN / DONE wake the named role
test/machine-panel.sh        # the system board's machine panel (SITE_NODE_MODULES=<a site's node_modules>)
```

Releases: push a tag `v<package.json version>`; CI builds each platform natively (`bun compile --trim`, plus a
plain `bun build --compile` fallback) and publishes them with checksums.
