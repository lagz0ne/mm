# mm-docker: mm's only way to Docker

`box/mm-docker` is a small root-owned wrapper. mm calls it through sudo instead of `sudo docker`. It runs only the
docker calls mm itself makes (`src/box.ts`, `template/bin/doop-run`, `src/doctor.ts`). So the owner of the machine
does not need blanket sudo for Docker. Docker access is root on the host: a container with `--privileged` or `-v /:/host`
is root. The wrapper refuses those.

Tests: `test/mm-docker.sh` (hermetic: a stand-in docker that records what it would run) and
`test/mm-docker-container.sh` (real Docker, throwaway containers: `DOCKER="sudo -n docker"`).

## What it allows

Each subcommand is an allowlist of exact options. Each value is checked. Docker gets a command line that the wrapper
writes itself (long options, `--opt=value`), never the caller's words. What was checked is what docker runs.

| Call | Allowed |
|---|---|
| `run` | mm's box, egress proxy, Doop, and its two one-shot helpers. `--cap-drop ALL` always. `--security-opt no-new-privileges` and `--pull=never` are always added. Names `mm-box-<p>`, `mm-egress-<p>`, `mm-doop-<p>` with the label `mm.project=<p>`. Networks: `none` or the project's own. Mounts: only the project's own folders, after realpath. |
| `exec` | Only into `mm-box-<p>` or `mm-doop-<p>`, when docker says its `mm.project` label is `<p>`. Then exec by its full id. No `-u`, no `--privileged`. |
| `build` | Only mm's build folder (`mm-box-build-*`, the owner's, not writable by others). It is copied first, as checked, into a private folder: only folders and plain files of the owner's. Tags `mm-box` and `mm-egress` only. Build args `UID` and `HOME_DIR` with the owner's values only. |
| `network` | `create` (internal, `10.231.<n>.0/24` or `10.232.<n>.0/24` for Doop, mm's labels), `connect` (a project's own container to its own network), `inspect`, `ls`, `rm` of mm's networks. |
| `inspect`, `container inspect`, `image inspect`, `rm`, `stop`, `restart`, `ps`, `pull` | mm's containers, networks and images only. `pull` by digest only. |

**Who a container runs as:**
- A box's or Doop's own uid: 100000 and up, never a real account, with the owner's group. No capabilities.
- Root only in two fixed shapes, and only when the config says `root_containers = yes`:
  - the egress proxy: `mm-egress-<p>`, the `mm-egress` image, `SETUID`/`SETGID` only;
  - the chown helper: `--rm --network none --user 0:0`, `CHOWN`/`FOWNER`/`DAC_OVERRIDE` only, entrypoint `chown`,
    `-R --no-dereference <owner>:<group>` on its own mounts only.

**The project's own folders:** a folder inside one project (its `.mm-answers.yaml` names that project), or
`<mm home>/{box,paseo,claude,egress}/<project>/`, or `<secrets>/<project>/`. The path must exist (else docker would make
it, as root). It must be a folder or a plain file with one link. Symlinks are resolved first, so `..` and symlinks lead
nowhere else.

**Always refused:** global options (`-H`, `--host`, `--context`, `--config`, `-D`); `DOCKER_HOST` and every other
variable (docker gets a clean environment); `--privileged`; `--pid`, `--ipc`, `--uts`, `--userns`, `--cgroupns`;
`--network host`, `--net`, `container:`; `--cap-add` beyond the two shapes above; `--device`; `--mount`,
`--volumes-from`, named volumes, `:shared` and `:z`; `--security-opt` other than `no-new-privileges`; `-p`/`-P`;
`--sysctl`, `--runtime`, `--cgroup-parent`, `--log-driver`; `--env-file` that is not a plain file of the owner's in the
project (it is opened by the wrapper and handed to docker as `/dev/fd/<n>`); images that are not mm's (or pinned by
digest); build `-o`/`--output`, `--iidfile`, `--secret`, `--ssh`, `--build-context`, `--cache-from`/`--cache-to`,
`--allow`, `--network`; and every other docker subcommand (`cp`, `create`, `commit`, `tag`, `load`, `volume`, `service`,
`plugin`, `compose`, `buildx`, `update`, ...).

## The config: `/etc/mm-docker.conf`

Root's file, `root:root 0644`. The wrapper refuses it if it is writable by anyone but root. `key = value` lines:

```
user = <owner>                  # the only account that may call it (sudo's SUDO_USER)
docker = /usr/bin/docker        # the default
mm_home = /home/<owner>/.mm     # the default: <owner's home>/.mm
projects = /home/<owner>/.mm/projects   # one-root layout; ~/projects in the legacy one
secrets = /run/user/<uid>/mm/secrets    # the default; MM_SECRETS_DIR's value if mm runs with one
root_containers = no            # yes: the egress proxy and the chown helper may run (see "Known limits")
```

Run as a user other than root (no sudo), the wrapper is in **test mode**: `MM_DOCKER_CONF` names its config, and it
gives no right that user doesn't have already.

## Install (ops; a t2 brain migration, the owner approves)

1. **The wrapper**, from the reviewed commit (check its sha256 against the one on the item):
   `install -o root -g root -m 0755 box/mm-docker /usr/local/libexec/mm-docker`. Check that `/usr/bin/python3` is
   root-owned (the wrapper runs as `python3 -I`, isolated: no `PYTHON*` variables, no user site, not the script's
   folder).
2. **The config**: write `/etc/mm-docker.conf` as above, `install -o root -g root -m 0644`.
3. **The one sudoers line**, in its own file, e.g. `/etc/sudoers.d/50-mm`:
   ```
   <owner> ALL=(root) NOPASSWD: /usr/local/libexec/mm-docker
   ```
   Write it to a temp file, check it with `visudo -cf <temp>`, then `install -o root -g root -m 0440 <temp>
   /etc/sudoers.d/50-mm`, then `visudo -c`. It names only the wrapper's absolute path. No `SETENV`, so the caller can't
   pass variables through sudo.
4. **Lockout safeguard** (a broken sudoers file locks root out): a second session open; `visudo -c` before and after;
   a timed revert (`systemd-run --on-active=10min rm -f /etc/sudoers.d/50-mm`) that the second session cancels after
   `sudo -n true` works.
5. **Check:**
   - `sudo -n -l` lists the entry.
   - `sudo -n /usr/local/libexec/mm-docker ps --format '{{.Names}}'` lists the containers.
   - `sudo -n /usr/local/libexec/mm-docker run --privileged --cap-drop ALL mm-box sh` exits 125 with
     `mm-docker: refused: --privileged ...`, and nothing is created.
6. **Switch mm to it**: `mm config set box.docker "sudo -n /usr/local/libexec/mm-docker"`. Then, for a box project:
   `mm up <project>`, `mm inspect <project>`, `mm obs errors -p <project> --since 15m`; `mm doctor` (its router check
   uses `box.docker` too). The projects' `.run/endpoints.json` (`containers.docker`, for `bin/doop-run`) picks it up at
   their next `mm up`.
7. **Rollback**: `mm config set box.docker "sudo -n docker"`; `rm -f /etc/sudoers.d/50-mm`; `visudo -c`; remove the
   wrapper and its config.

The wrapper adds no right while the owner still has `NOPASSWD: ALL`. It is the replacement that lets that line go later.

## Known limits (open, for review and the owner)

1. **The root shapes are not a root boundary yet.** With `root_containers = yes`, the egress proxy and the chown helper
   run as uid 0 in the container, with a read-write mount of a folder the owner can rename. Docker resolves a mount's
   host path again at each start (`restart`, a reboot, `--restart unless-stopped`). So the owner can swap a folder on
   that path for a symlink after the wrapper's check, and the next start mounts what the symlink names. Also, both
   images are built from the owner's files, and the egress proxy's command is the caller's. Together: root on the host.
   **Fix (an mm change):** run the egress proxy as its own non-root uid (it needs no `SETUID`/`SETGID` then), and give a
   box's files back with a regroup under the box's own uid (as `bin/doop-run release` does for Doop) instead of a chown
   as root. Then `root_containers = no`.
2. **Containers that do not run as root are safe from the same swap.** A box's or Doop's uid (100000 and up, not an
   account, the owner's group, no capabilities, no new privileges) can reach no more than the owner can.
3. **Configured images:** `box.image` and `box.egress_image` must keep mm's names (`mm-box`, `mm-egress`) or be pinned by
   digest. Doop's image is by digest already (`bin/doop-run`).
4. **`--pull=never`**: a `run` never pulls. mm builds its images here, and `pull <name>@sha256:<digest>` is allowed.
5. **Build steps run in BuildKit**, from the copied folder: no host mounts, no secrets, no entitlements.
