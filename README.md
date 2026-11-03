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

## Use

```sh
mm doctor                    # check this machine against the manifest; changes nothing
mm onboard                   # install and configure what is missing, then doctor
mm new acme/shop             # a project in ~/projects/acme/shop, services started
mm ls | inspect acme/shop    # projects, their services and URLs
mm up | down | restart acme/shop
mm update [acme/shop]        # bring projects up to this mm's template (three-way merge; --dry-run, --continue, --abort)
mm archive acme/shop         # stop, unload, unexpose, archive agents, pack to a tarball, delete; mm restore <tarball>
mm obs status | errors | slow | logs     # what the projects did (metrics, logs, traces on this machine)
```

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
```

Releases: push a tag `v<package.json version>`; CI builds each platform natively (`bun compile --trim`, plus a
plain `bun build --compile` fallback) and publishes them with checksums.
