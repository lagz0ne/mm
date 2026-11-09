# mm-docker: mm's only way to Docker

`box/mm-docker` is a small root-owned wrapper. mm calls it through sudo instead of `sudo docker`. It runs only the
docker calls mm itself makes (`src/box.ts`, `template/bin/doop-run`, `src/doctor.ts`), and those of mm's container tests
and the system board's leads (sy-e6t3), each limited to mm's own containers, images and folders. So the owner of the
machine does not need blanket sudo for Docker. Docker access is root on the host: a container with `--privileged` or `-v /:/host`
is root. The wrapper refuses those.

Tests: `test/mm-docker.sh` (hermetic: a stand-in docker that records what it would run) and
`test/mm-docker-container.sh` (real Docker through the wrapper, throwaway containers in the tests' area; see "mm's
tests" below).

## What it allows

Each subcommand is an allowlist of exact options. Each value is checked. Docker gets a command line that the wrapper
writes itself (long options, `--opt=value`), never the caller's words. What was checked is what docker runs.

| Call | Allowed |
|---|---|
| `run` | mm's box, egress proxy, Doop, and its two one-shot helpers. `--cap-drop ALL` always. `--security-opt no-new-privileges` and `--pull=never` are always added. Names `mm-box-<p>`, `mm-egress-<p>`, `mm-doop-<p>` with the label `mm.project=<p>`. Networks: `none` or the project's own (`host`, `bridge`, `default` refused). No `--network` given: the wrapper adds `--network none` (docker's default would be its bridge, a way out), for `run` and `create`; only mm's egress proxy `mm-egress-<p>` keeps docker's default, the box's one way out by design (it is then joined to the project's network). Mounts: only the project's own folders, after realpath. |
| `exec` | Only into `mm-box-<p>` or `mm-doop-<p>`, when docker says its `mm.project` label is `<p>`. Then exec by its full id. No `-u`, no `--privileged`. |
| `build` | Only mm's build folder (`mm-box-build-*`, the owner's, not writable by others). It is copied first, as checked, into a private folder: only folders and plain files of the owner's. Tags `mm-box`, `mm-egress` and `mm-doop` only. Build args `UID` and `HOME_DIR` with the owner's values only, and `BASE` (one of mm's images, or by digest: `box/doop/build.sh`). |
| `network` | `create` (internal, `10.231.<n>.0/24` or `10.232.<n>.0/24` for Doop, mm's labels), `connect` (a project's own container to its own network), `inspect`, `ls`, `rm` of mm's networks. |
| `create` | The checks of `run`, and always a name and its label (`box/doop/build.sh`: a stopped container to copy the source out of). |
| `cp` | Only between the host and one of mm's containers (its name and its `mm.project` label, by docker; then by its id) that has **no mounts**: docker cp mounts a container's host folders again, by their path, as root (CVE-2018-15664). The host side is `-` (a tar stream), or a folder of that container's own project (or test, below). It is written or read by a process of the owner's, never as root (extracting drops setuid/setgid bits). What goes into a container is copied again by the wrapper: folders, plain files and links only, no setuid/setgid/sticky bits, owned by the container's root; an absolute name, `..`, a device or a pipe refuses the whole copy. No `-a`, no `-L`. |
| `logs` | One of mm's containers (by its label, then its id). `-f`, `-t`, `--tail`, `--since`, `--until`. |
| `port`, `kill` | mm's containers. `kill -s` only TERM, KILL, INT, HUP, QUIT, USR1, USR2. |
| `images` | Read. `-a`, `-q`, `--digests`, `--no-trunc`, `--format`, `--filter` (dangling, reference, label, before, since), at most one name. |
| `rmi` | mm's images by name only (`mm-box`, `mm-egress`, `mm-doop`, any tag). Never by id: an id can be any image. |
| `inspect`, `container inspect`, `image inspect`, `rm`, `stop`, `restart`, `ps`, `pull` | mm's containers, networks and images only (`network inspect` also the default `bridge`, for its gateway). `rm`, `stop`, `restart`, `kill`, `network rm`: several names, each checked. `ps --filter` (label, name, status, id, network, ancestor, health). `pull` by digest only. |

**Who a container runs as:** always its own uid, given with `--user <uid>:<the owner's group>`: 100000 and up, never a
real account. No capabilities: `--cap-add` is refused. Root is refused: `--user 0:0`, and a `run` with no `--user` (the
image's user, root as far as the wrapper knows). mm's uids (`src/box.ts`, `bin/doop-run`; n is the third octet of the
project's subnet):

| Container | uid |
|---|---|
| the box `mm-box-<p>` | 200000 + n |
| its egress proxy `mm-egress-<p>` (the proxy and its AI forwarder) | 190000 + n |
| Doop `mm-doop-<p>` | 210000 + n |
| giveBack's regroup and Doop's release (`--rm --network none`) | the uid whose files it opens |

**Giving a box's files back, without root** (`src/box.ts` giveBack, take). Some programs in a box make their files
`0600` and their folders `0700`, so the host's owner can't read them. Only a file's owner (or root) can change its mode.
So mm runs a short container as each of mm's uids that owns such a file there (no network, no capabilities, the
project's own folders its only mounts). It makes that uid's own files group-readable and -writable, and its folders
group-writable and setgid, for the owner's group (as `bin/doop-run release` does for Doop). Then the host's owner can
read, move and remove them: a backup lands this way, and `mm archive` packs and removes the project. For `mm box off`,
mm then also takes them back with the box stopped: each file is copied, as the owner, and the copy renamed over it;
each folder is made again and its entries moved into it. No chown.

`root_containers = yes` is only for an mm older than sy-58fo, which ran these two as root (the egress proxy as the
`mm-egress` image's root with `SETUID`/`SETGID`; a chown helper as `--user 0:0` with `CHOWN`/`FOWNER`/`DAC_OVERRIDE`).
It allows those two exact shapes, and it is not a root boundary (see "Known limits"). Don't set it for this mm.

**The project's own folders:** a folder inside one project (its `.mm-answers.yaml` names that project), or
`<mm home>/{box,paseo,claude,egress}/<project>/`, or `<secrets>/<project>/`. The path must exist (else docker would make
it, as root). It must be a folder or a plain file with one link. Symlinks are resolved first, so `..` and symlinks lead
nowhere else.

**Always refused:** global options (`-H`, `--host`, `--context`, `--config`, `-D`); `DOCKER_HOST` and every other
variable (docker gets a clean environment); `--privileged`; `--pid`, `--ipc`, `--uts`, `--userns`, `--cgroupns`;
`--network host`, `--net`, `container:`; root and every `--cap-add` (with `root_containers = yes`: beyond its two old shapes); `--device`; `--mount`,
`--volumes-from`, named volumes, `:shared` and `:z`; `--security-opt` other than `no-new-privileges`; `-p`/`-P`;
every `--sysctl` but one (below), `--runtime`, `--cgroup-parent`, `--log-driver`; `--env-file` that is not a plain file of the owner's in the
project (it is opened by the wrapper and handed to docker as `/dev/fd/<n>`); images that are not mm's (or pinned by
digest); build `-o`/`--output`, `--iidfile`, `--secret`, `--ssh`, `--build-context`, `--cache-from`/`--cache-to`,
`--allow`, `--network`; `cp` with a container that has mounts, or a host path outside its project; and every other docker
subcommand (`commit`, `tag`, `load`, `save`, `volume`, `service`, `plugin`, `compose`, `buildx`, `update`, `start`,
`attach`, `export`, `import`, `system`, ...).

**The one sysctl (sy-gld3):** `run` (and `create`) takes `--sysctl net.ipv4.ip_local_reserved_ports=<a>-<b>`, once,
with one range inside mm's ports (38000-38999). A box has its own network namespace, so the setting is the box's: its
kernel then never hands one of mm's ports to a process that asks for a free one (port 0), so a helper in a box can't
take a board's fixed port. mm's box passes the whole range. Any other key, a second `--sysctl`, a list or a range
outside 38000-38999 is refused. The host's own setting is not the wrapper's (a root change on the host).

## The config: `/etc/mm-docker.conf`

Root's file, `root:root 0644`. The wrapper refuses it if it is writable by anyone but root. `key = value` lines:

```
user = <owner>                  # the only account that may call it (sudo's SUDO_USER)
docker = /usr/bin/docker        # the default
mm_home = /home/<owner>/.mm     # the default: <owner's home>/.mm
projects = /home/<owner>/.mm/projects   # one-root layout; ~/projects in the legacy one
secrets = /run/user/<uid>/mm/secrets    # the default; the same folder as mm's vault.secrets_dir (see below)
root_containers = no            # the default: no root, no capabilities in any container (yes: an older mm only)
test_root = /home/<owner>/.cache/mm-docker-test   # mm's tests' area (none: no test area); see "mm's tests"
test_prefix = mmt-              # the default: a test's folder in test_root is <prefix><name>
max_context_mb = 64             # the default: the most a build folder may hold
max_cp_mb = 512                 # the default: the most a cp into a container may hold
```

**The secrets folder** (`secrets`): a box's opened secrets are mounted from there only. It must name the same folder
as mm's own setting, `vault.secrets_dir` in mm's config (the default when that is unset: the user's runtime folder,
`/run/user/<uid>/mm/secrets`). The wrapper never reads mm's config: that file is the owner's, and the wrapper runs as
root, so a folder the owner names there could let a mount reach anywhere. So the two are set apart, by the same
person (ops), and `mm doctor` warns when they disagree (`secrets folder callers`; it reads this file, which is 0644).

**The tests' area** (`test_root`): a folder `<test_root>/<test_prefix><name>/` and all in it belong to the throwaway
project `<test_prefix><name>`, as a project's own folder does (mounts, `cp`, an `--env-file`). A folder there without
the prefix belongs to none. `test_root` must be apart from mm's home, the projects and the secrets, and not a wide
folder (`/`, `/tmp`, the home, ...). It gives no more than a project's folder: the owner's own files, mounted into a
container that runs as its own uid.

Run as a user other than root (no sudo), the wrapper is in **test mode**: `MM_DOCKER_CONF` names its config, and it
gives no right that user doesn't have already.

## mm's tests

The container tests reach Docker through the wrapper only (`test/lib/docker.sh`), never plain `sudo docker`:

- by default the installed one, `DOCKER="sudo -n /usr/local/libexec/mm-docker"`, whose config names the tests' area;
- `MM_DOCKER_BIN=box/mm-docker`: this checkout's copy in test mode (as the owner, not root), with a config the test
  writes, its docker `MM_DOCKER_RAW` (default `docker`). For a wrapper that is not installed yet: it needs a docker the
  owner may run without the wrapper.
- `DOCKER=<command>` as given.

Each test makes its folders in the area (`mm_test_dir`): `~/.cache/mm-docker-test/mmt-<test>-<pid>/`, its name the
throwaway project. Through the wrapper: `test/mm-docker-container.sh`, `test/box-egress.sh`, `test/doop-gateway.sh`
(with `box/doop/build.sh`), `test/doop-container.sh`, `test/doop-designs.sh`. What still needs plain docker (the wrapper
refuses it on purpose): `test/doop-container.sh`'s older Doop, as the owner's own uid (`MM_DOCKER_RAW`, else skipped);
`test/mm-docker-container.sh`'s unlabelled containers (`MM_DOCKER_RAW`, else skipped).

The tests that run a stock OS image as root with `exec -u dev` (`clean-box.sh`, `auth-e2e.sh`, `in-box.sh`,
`restore-drill.sh`, `box-gateway.sh`) never go through the wrapper. They use rootless podman by default
(`test/lib/stock.sh`): root in the container is the owner's uid in a user namespace, so no sudo. Their images are
fully qualified (`docker.io/library/ubuntu:24.04`). `DOCKER="sudo -n docker"` (or `DOCKER=docker`) runs them on docker
as before. Rootless podman needs `newuidmap`/`newgidmap`, user namespaces on, and a subuid range for the owner that
overlaps no uid mm gives its boxes and proxies.

## Install (ops; a t2 brain migration, the owner approves)

1. **The wrapper**, from the reviewed commit (check its sha256 against the one on the item):
   `install -o root -g root -m 0755 box/mm-docker /usr/local/libexec/mm-docker`. Check that `/usr/bin/python3` is
   root-owned (the wrapper runs as `python3 -I`, isolated: no `PYTHON*` variables, no user site, not the script's
   folder).
2. **The config**: write `/etc/mm-docker.conf` as above, `install -o root -g root -m 0644`. For mm's tests, with
   `test_root = /home/<owner>/.cache/mm-docker-test` and `test_prefix = mmt-`.
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

1. **`root_containers = yes` is not a root boundary.** With it, an older mm's egress proxy and chown helper run as uid 0
   in the container, with a read-write mount of a folder the owner can rename. Docker resolves a mount's host path again
   at each start (`restart`, a reboot, `--restart unless-stopped`). So the owner can swap a folder on that path for a
   symlink after the wrapper's check, and the next start mounts what the symlink names. Also, both images are built from
   the owner's files, and the egress proxy's command is the caller's. Together: root on the host. **Fixed in mm
   (sy-58fo):** the egress proxy starts as its own uid with no capabilities, and a box's files go back by a regroup under
   the box's own uid. This mm needs no root container, so keep `root_containers = no` (the default).
2. **Containers that do not run as root are safe from the same swap.** A box's, an egress proxy's or Doop's uid (100000
   and up, not an account, the owner's group, no capabilities, no new privileges) can reach no more than the owner can.
   Files those uids own stay theirs until mm box off takes them (a backup the box made stays the box uid's, group-rw).
3. **Configured images:** `box.image` and `box.egress_image` must keep mm's names (`mm-box`, `mm-egress`) or be pinned by
   digest. Doop's image is by digest already (`bin/doop-run`).
4. **`--pull=never`**: a `run` never pulls. mm builds its images here, and `pull <name>@sha256:<digest>` is allowed.
5. **Build steps run in BuildKit**, from the copied folder: no host mounts, no secrets, no entitlements.
6. **`cp` reads and writes the host as the owner.** The wrapper checks the host path (realpath, the container's own
   project), then a process of the owner's reads or writes it. A path swapped after the check reaches only what the
   owner may reach anyway. Into a container, only one with no mounts: what lands there stays in that container (no
   setuid bit, and mm's containers run with no new privileges and no capabilities).
