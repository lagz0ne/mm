# mm sync, whole-machine restore, and the drill

Design (sy-240; review's conditions sy-fto and sy-4in; the vault, docs/vault.md). Status: `mm sync` **built** (`src/sync.ts`, `test/sync.sh`). `mm restore <repo>` **built up to the data**
(`src/restore.ts`, `test/restore.sh`: trust, MANIFEST, unseal, reseal, repos and board data in place, nothing started).
Bringing the boards up, the outward gate and the container drill: **design**.

## What mastermind holds
A private git repo (the machine's backup), laid out like `$MM_HOME` but only what can't be rebuilt:

| Path in mastermind | From | How |
|---|---|---|
| `config.yaml` | `$MM_HOME/config.yaml` | sealed (`config.yaml.age`): it decides access and routes (sy-fto 3) |
| `vault/*.age`, `vault/recipients.txt`, `vault/digests.txt` | `$MM_HOME/vault/` | an allowlist; **never** `vault/key`; any blob with `AGE-SECRET-KEY-` is refused, by `mm sync` and by a pre-commit hook in the sync checkout |
| `brain/repo.bundle.age` | the brain repo | its git bundle (`--all`), sealed (a bundle keeps history; the restore clones from it) |
| `system/`, `projects/<client>/<name>/` | each board: a fresh `bin/backup` | sealed, one file per kind: `config.bundle.age` (config repo), `code.bundle.age` (product repo, if any), `board.tar.age` (Dolt backup + JSONL + releases) |
| `MANIFEST` | mm | each file's sha256 and the mm version that wrote it (plain text: names and hashes only) |
| `README.md` | mm | what this repo is (plain text, nothing machine-specific) |

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
   commits ("sync <time>"; no commit when nothing changed) and pushes with the mastermind deploy key (the
   `mastermind-deploy-key` input, used by path through `GIT_SSH_COMMAND`; mm never reads it).

A failed sync puts the checkout back to its last commit.

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
- `MM_VERSION=vX` is required (the shim installs that release), and the restore doc gives the shim's sha256 to check
  first.

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
3. opens `config.yaml`, lays out `$MM_HOME`, runs `mm onboard` (tools, process manager, observability);
4. reseals the vault to a new machine key (`resealWith`, docs/vault.md); the identity is dropped from memory;
5. restores the brain (clone from its bundle; the human applies its migrations, which are root), then the system board
   and every project (`mm restore` of each: config repo, board data, code) and starts them. **Built:** each repo
   comes back from its bundle with every branch (`mm-template` too) and no remote; the answers' `root:` is pointed at
   the new folder; the board data (Dolt backup, JSONL, releases) is staged in `<root>/.restore` (0700) for the board's
   first start, which is the next part;
6. **before anything outward-facing** (public routes, the tunnel, the Telegram bot, leads, git push): stops and asks
   the human to confirm the old box is down, or that this is a migration. Typed only (sy-4in 3).

## The drill (sy-4in)
`mm restore --drill <mastermind>` in a throwaway box:
- the same steps, except that **nothing outward-facing starts**: services declare `outward: true` (anything unknown counts
  as outward) and are listed as suppressed; no leads start; no push. Each sealed file is opened to a hash only and
  compared with `MANIFEST` and `vault/digests.txt`;
- the report: boards up (each answers), items there (counts per board vs the backup), each sealed input opened, what was
  suppressed, the teardown (tmpfs and decrypted copies gone);
- `test/restore-drill.sh` runs it in a container on this machine against a **synthetic** mastermind (a throwaway vault
  key, fake secrets, a throwaway board) — no production key, nothing T3. A production drill (the real mastermind and the
  recovery key) is the human's step on a box elsewhere.

## Tests
`mm sync`: the allowlist, the secret-key refusal (and its hook), a sealed MANIFEST matching the files, no plaintext in
the checkout. Restore: an unsigned HEAD refused without the typed hash; a bad tag signature refused; the drill's report
and suppression list; a synthetic restore with boards up and the same item counts.
