# mm sync, whole-machine restore, and the drill

Design (sy-240; review's conditions sy-fto and sy-4in; the vault, docs/vault.md). Status: **built.** `mm sync` (`src/sync.ts`, `test/sync.sh`); `mm restore <repo>` with the restore hold and
`--release` (`src/restore.ts`, `test/restore.sh`); the container drill (`test/restore-drill.sh`). Still design: the
hidden prompt for the recovery identity (today: `--identity <file>`), and a production drill, which is the human's.

## What mastermind holds
A private git repo (the machine's backup), laid out like `$MM_HOME` but only what can't be rebuilt:

| Path in mastermind | From | How |
|---|---|---|
| `config.yaml` | `$MM_HOME/config.yaml` | sealed (`config.yaml.age`): it decides access and routes (sy-fto 3) |
| `vault/*.age`, `vault/recipients.txt`, `vault/digests.txt` | `$MM_HOME/vault/` | an allowlist; **never** `vault/key`; any blob with `AGE-SECRET-KEY-` is refused, by `mm sync` and by a pre-commit hook in the sync checkout |
| `brain/repo.bundle.age` | the brain repo | its git bundle (`--all`), sealed (a bundle keeps history; the restore clones from it) |
| `system/`, `projects/<client>/<name>/` | each board: a fresh `bin/backup` | sealed, one file per kind: `config.bundle.age` (config repo), `code.bundle.age` (product repo, if any), `board.tar.age` (Dolt backup + JSONL + releases, a gzip-compressed tar; restore still reads an older uncompressed one) |
| `projects/<client>/<name>/box.json.age` | a box project (or one that was a box): the host's disk, never the box's backup | sealed: that it is a box, the host's copies of its privilege files (`.mm-answers.yaml`, `services.yaml`, `secrets.json`, `governance.json`, `tools.json`), the engine's seal and the mm-template record. A box's backup runs in the box, so its bundle is the box's own history: restore takes these files from the record over the bundle's, restores a recorded box as a box, and runs no repo hook for its own commits (sy-b15.19). The seal covers `bin/`, `site/`, `ops/` and `setup/`: before anything runs, each file of `ops/` and `setup/` that is neither mm's render nor sealed is written over with mm's render, or removed. Only then does restore point the repo's hooks at `ops/githooks`, for a box too (its hooks are mm's again; the host's own git on a box runs none; sy-atqr) |
| `MANIFEST` | mm | each file's sha256 and the mm version that wrote it (plain text: names and hashes only) |
| `README.md` | mm | what this repo is (plain text, nothing machine-specific) |

**Parts.** A sealed file over 90 MiB of plaintext (GitHub refuses any file over 100 MB) is written as numbered parts
instead, each sealed on its own and each an age file: `board.tar.00.age`, `board.tar.01.age`, ... (any sealed item:
`brain/repo.bundle.00.age`, `code.bundle.00.age`, ...). One that fits keeps its one-file name. When the count changes,
or a file goes from parts to one file or back, the other form is dropped in the same commit. MANIFEST lists each part;
restore opens each part and joins them in order, and still reads the one-file form. (`MM_SYNC_PART_BYTES` sets the
part size, for tests.)

Nothing else may be in it. `mm sync` checks the whole checkout before it commits (the allowlist above, every `.age`
really an age file, no age secret key in any file), and the checkout's pre-commit hook checks the same for a commit
made by hand. Throwaway projects (`mm new --throwaway`) are left out.

Everything is sealed to the vault's two recipients (the machine key and the human's recovery key), so the restore
needs only mastermind plus the recovery key. The repo itself is a convenience for transport and history, not a
security boundary.

## mm sync
`mm sync --init <repo>` once: clones mastermind into `$MM_HOME/state/mastermind` (0700), installs the hook, and
records `mastermind.remote` in `config.yaml`. Then `mm sync [--dry-run] [--no-push]` (run by the system's scheduler,
say hourly, and after a promote):
1. takes a fresh backup of each board (`bin/backup` into a 0700 work folder under `$MM_HOME/state`, removed after)
   and bundles the brain (`git bundle create --all`);
2. seals each from memory into the checkout. **Only what changed is resealed:** age's output differs on every run, so
   resealing everything would add a full copy to the repo each hour. A local `$MM_HOME/state/mastermind.json` (0600,
   never pushed) keeps a fingerprint of each source: a repo's refs, the board's JSONL and release log, a file's
   sha256. A board whose Dolt history changed without any item changing waits for the next item change;
3. drops files whose source is gone (an archived project; history keeps them), writes `MANIFEST`, checks the rails,
   refuses to commit when any file in the checkout is over 95 MB (naming it; `MM_SYNC_MAX_BYTES` for tests),
   commits ("sync <time>"; no commit when nothing changed) and pushes with the mastermind deploy key (the
   `mastermind-deploy-key` input, used by path through `GIT_SSH_COMMAND`; mm never reads it).

A failed sync puts the checkout back to its last commit.

**A push that keeps failing** (the remote refused a commit, e.g. one with a file over its limit, made by an older mm):
each later commit sits on top of it and none can go. `mm sync --redo-unpushed` fetches the branch, drops the
checkout's commits that the remote doesn't have (they stay in the checkout's reflog), resets the checkout to the
remote branch, forgets the fingerprints in `mastermind.json` of every file that differs from it (so they are sealed
again, not kept as "unchanged"), then runs a normal sync and pushes. The remote's history is not changed (unlike
`--fresh`). It is refused when nothing is unpushed.

A push is outward-facing, but it's the backup the human asked for: allowed for `mm sync` only, through the deploy
key, never by a lead.

**A fresh start** (reusing an existing mastermind repo, whose history may be rewritten): `mm sync --fresh --force` makes an orphan
commit with the new layout and force-pushes it to the branch (`mastermind.branch`, default `main`) once. It's a t2
step (ops, the human's approval), because it rewrites what's there; without `--force` it is refused and says why.
The old commits stay in GitHub's storage until GitHub collects them: if the old history holds anything sensitive,
purging it needs GitHub's support, not only the force-push.

## Trust: what a restore applies (sy-fto)
Whoever can write to mastermind could own the next restored box, since restore runs the brain's migrations as root.
So restore applies only what it can verify:
- **a signed tag:** the human signs a tag (`git tag -s`, an SSH key they hold, never on the machine) on a mastermind
  commit after a drill or a weekly look. `mm restore` checks it against `allowed_signers` (shipped in mm, or given with
  `--allowed-signers`) and restores **that** commit;
- anything newer than the newest signed tag is unsigned: restore lists it (commits, files) and applies it only after the
  human types the HEAD hash shown. With no signed tag, typing the hash is the only path;
- `MM_VERSION=vX` is required: the shim refuses `restore` without it (a project's `.tar.gz` restore excepted). The
  shim itself is checked before it runs, against a sha256 you get from somewhere other than the download:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/<mm repo>/vX.Y.Z/bin/mm -o mm-shim   # the tag, never main
  sha256sum mm-shim     # compare with "shim sha256" in the vX.Y.Z release notes, read in your browser
  MM_VERSION=vX.Y.Z sh mm-shim restore git@github.com:<you>/mastermind.git --allowed-signers <your file>
  ```

  The shim then checks the binary against the release's own checksums (integrity; the release notes and your
  signed mastermind tag are the origin checks). Every release lists the shim's sha256 in its notes.

## mm restore
`curl …/bin/mm | MM_VERSION=vX sh -s -- restore git@github.com:<you>/mastermind.git` on a blank box:
1. installs mm (pinned), clones mastermind, checks trust as above. **Built:** every tag is verified against
   `--allowed-signers`; of the valid ones, the one on the newest commit that HEAD contains wins. Newer commits are
   listed and applied only with `--accept <HEAD hash>` (at least 12 characters). Then every tracked file is checked
   against MANIFEST (sha256, allowlist, nothing missing), so a sealed file swapped after the sync is refused even
   when the human typed the hash;
2. asks for the recovery identity (a hidden prompt or a file the human names; refused inside an agent). **Built:** the
   file (`--identity`), read by `age` only; its public key must be the recovery key in `vault/recipients.txt`. The
   hidden prompt comes with the next part. A box with any of mm's state on it is refused: restore is for a blank box,
   and it always lays out one-root (a restore is also how a legacy box moves);
3. opens `config.yaml`, lays out `$MM_HOME`, runs `mm onboard` (tools, process manager, observability). **Built:**
   a blank box has no `age` yet, so restore installs it first from the signed distro package the manifest names.
   The **restore hold** (`restore.hold` in `config.yaml`) is written with the config, before anything can start;
4. reseals the vault to a new machine key (`resealWith`, docs/vault.md); the identity is dropped from memory;
5. restores the brain (clone from its bundle; the human applies its migrations, which are root), then the system board
   and every project (`mm restore` of each: config repo, board data, code) and starts them. **Built:** each repo
   comes back from its bundle with every branch (`mm-template` too) and no remote; the answers' `root:` is pointed at
   the new folder; the board data (Dolt backup, JSONL, releases) is staged in `<root>/.restore` (0700) for the board's
   first start. Then each board comes up: its tools (checksums), a fresh Beads database (`bin/init`) replaced by the
   backup (`dolt backup restore --force`, history included), the database's own project identity written back into
   `control/.beads/metadata.json` (bd refuses to connect on a mismatch, and `bin/init` made a new one), the board
   build, the governance render, the lead worktrees, and its services. Every record of the backup's JSONL must be on
   the board again (the box may add its own meanwhile, e.g. the watchdog's incidents); `.restore` is removed then. `--data-only` stops before onboard (the hermetic test);
6. **before anything outward-facing** (public routes, the tunnel, the Telegram bot, leads, git push): stops and asks
   the human to confirm the old box is down, or that this is a migration. Typed only (sy-4in 3). **Built:** while the
   hold is on, `mm up` starts only what stays inside the box: services that declare `outward: false`, and mm's own
   board engine (`dolt`, `bd-serve`, `board`); anything else (`wake`, which starts leads; the `app` slot; any unknown
   service) is held back and listed, and there are no public routes or forwarders. `mm sync` refuses (the old box may
   still be writing mastermind). `mm restore --release` lifts the hold: it reads a typed phrase from the terminal
   (`/dev/tty`, not stdin; refused inside an agent), then starts every board fully. The tunnel and the Telegram
   bridge are the brain's services (its migrations, which the human applies), so they wait for the human anyway.

## The drill (sy-4in)
`mm restore --drill <mastermind>` in a throwaway box:
- the same steps, except that **nothing outward-facing starts, ever**: the hold is marked `restore.drill`, and
  `--release` refuses on a drill box. Every sealed file is checked against `MANIFEST`, every vault secret is opened
  with the new machine key to memory only (`vault/digests.txt` checked first);
- the report: boards up (each answers), items there (counts per board vs the backup), each sealed input opened, what was
  suppressed, the teardown (tmpfs and decrypted copies gone);
- `test/restore-drill.sh` runs it in a container on this machine against a **synthetic** mastermind (a throwaway vault
  key, fake secrets, a throwaway board) — no production key, nothing T3. A production drill (the real mastermind and the
  recovery key) is the human's step on a box elsewhere.

### The drill's record (sy-3use)
After every drill (`--drill`, with or without `--data-only`), passed or failed, restore writes
`$MM_HOME/state/drill.json` **on the box the drill ran on**: mode 0600, in a 0700 folder, written whole (a temp file,
then renamed over the old one). A drill refused before it began (the box is not blank, or no identity was given
before that check) writes nothing: that box may be a real machine with a record of its own.

| Key | What |
|---|---|
| `at` | when the drill ended (ISO 8601, UTC) |
| `ok` | `true` only if every step passed; a failed drill writes `false` |
| `data_only` | `true` for `--data-only` (the data laid out and checked; no board brought up) |
| `mastermind` | the full commit hash it restored; `null` if it failed before trust chose one |
| `report` | the steps' short lines (`<status> <step>: <detail>`, at most 300 characters each): names, counts and hashes, never a value |

The drill is also one span: the `mm restore` command's own (VictoriaTraces, and a line in `$MM_HOME/pc/mm.log`), with
`drill`, `drill_ok`, `data_only`, `mastermind`, `drill_record` and the outcome `drill passed` or `drill failed`.

**The score term** (the brain's score): debt when the record is missing or not JSON, when `.ok` is not `true`, or when
`.at` is more than 30 days old. A term that wants the boards up as well counts only `.data_only == false`. As a check:

```sh
jq -e '.ok == true and ((.at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) > now - 30*86400)' "$MM_HOME/state/drill.json"
```

## Tests
`mm sync`: the allowlist, the secret-key refusal (and its hook), a sealed MANIFEST matching the files, no plaintext in
the checkout. Restore: an unsigned HEAD refused without the typed hash; a bad tag signature refused; the drill's report
and suppression list; a synthetic restore with boards up and the same item counts; the drill's record (shape, mode,
`ok: false` for a failed drill, untouched by a refused one, no value in it) and its span.
