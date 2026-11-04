# mm sync, whole-machine restore, and the drill

Design (sy-240; review's conditions sy-fto and sy-4in; the vault, docs/vault.md). Status: **design**.

## What mastermind holds
A private git repo (the machine's backup), laid out like `$MM_HOME` but only what can't be rebuilt:

| Path in mastermind | From | How |
|---|---|---|
| `config.yaml` | `$MM_HOME/config.yaml` | sealed (`config.yaml.age`): it decides access and routes (sy-fto 3) |
| `vault/*.age`, `vault/recipients.txt`, `vault/digests.txt` | `$MM_HOME/vault/` | an allowlist; **never** `vault/key`; any blob with `AGE-SECRET-KEY-` is refused, by `mm sync` and by a pre-commit hook in the sync checkout |
| `brain/` | the brain repo | its git bundle, sealed (a bundle keeps history; the restore clones from it) |
| `system/`, `projects/<client>/<name>/` | each board's config repo, board data (the newest `bin/backup`: Dolt backup + JSONL), code bundle | sealed, one file per board and kind (`<id>.config.bundle.age`, `<id>.board.tar.age`, `<id>.code.bundle.age`) |
| `MANIFEST` | mm | what's in it: each file's sha256, the mm version that wrote it, the time |

Everything is sealed to the vault's two recipients (the machine key and the human's recovery key), so the restore
needs only mastermind plus the recovery key. The repo itself is a convenience for transport and history, not a
security boundary.

## mm sync
`mm sync [--dry-run]` (run by the system's scheduler, say hourly, and after a promote):
1. takes a fresh backup of each board (`bin/backup`) and of the brain (`git bundle create --all`);
2. seals each into the sync checkout (`$MM_HOME/state/mastermind`, a clone of the repo), with the allowlist and the
   secret-key refusal;
3. writes `MANIFEST`, commits ("sync <time>") and pushes with the mastermind deploy key (an input).

A push is outward-facing, but it's the backup the human asked for: allowed for `mm sync` only, through the deploy
key, never by a lead.

**A fresh start** (the human: reuse lagz0ne/mastermind, history may be rewritten): `mm sync --fresh` makes an orphan
commit with the new layout and force-pushes it to the repo's default branch once. It's a t2 step (ops, the human's
approval), because it rewrites what's there.

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
1. installs mm (pinned), clones mastermind, checks trust as above;
2. asks for the recovery identity (a hidden prompt or a file the human names; refused inside an agent);
3. opens `config.yaml`, lays out `$MM_HOME`, runs `mm onboard` (tools, process manager, observability);
4. reseals the vault to a new machine key (`resealWith`, docs/vault.md); the identity is dropped from memory;
5. restores the brain (clone from its bundle; the human applies its migrations, which are root), then the system board
   and every project (`mm restore` of each: config repo, board data, code) and starts them;
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
