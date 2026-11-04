# The vault: secrets sealed with age, opened only into memory-backed files at start

Design for `mm vault` and sealed inputs (one-root plan; review's conditions from sy-suk). Status: **design; the code
waits on `age` being installed** (a signed system package; the manifest lists it).

## Two keys, never the same one
- **The machine key** (`$MM_HOME/vault/key`, 0600; the folder 0700): made by `mm onboard` on a new box with
  `age-keygen`. It opens the vault on this machine. Losing it costs a reseal, not the vault.
- **The recovery key** is the human's, offline (paper, a password manager, or a hardware key through
  `age-plugin-yubikey`). mm only ever holds its **public** half: `mm onboard` asks for the recovery public key
  (`age1…`) and records it in `vault/recipients.txt` next to the machine key's. The recovery identity never touches
  disk here.
- Every secret is sealed to **both** recipients (`vault/recipients.txt`).

## Sealing and opening
- `mm fill <name>` seals: the value goes to `age -e -R vault/recipients.txt` on **stdin** (never argv or env) and the
  output to `vault/<name>.age` (0600, atomic). `vault/digests.txt` records sha256 of each **ciphertext** (not of the
  value: a hash of a low-entropy secret would allow offline guessing). age is authenticated, so a successful
  decryption of a file with the recorded digest is the drill's proof that the value is the sealed one.
- **At start**, mm opens only the secrets a service declares (`secrets: [name, …]` in its services file) into
  `$XDG_RUNTIME_DIR/mm/secrets/<project>/<name>` (0600, folders 0700), with `age -d -i vault/key` reading the
  ciphertext and writing to that file. The service reads the file by path (`<NAME>_FILE` env), never a value in env.
  `MM_SECRETS_DIR` replaces that folder (e.g. a tmpfs the brain mounts with `noswap`). `mm doctor` checks the vault's
  modes and digests and that the folder is a tmpfs (fail), and warns when some swap is not dm-crypt and the folder
  isn't mounted `noswap` (sy-suk 5: that mount needs root, so it's a brain migration for ops).
- Nothing prints a value: `mm vault ls` shows names, sizes, digests and which services use them.

## Restore (whole machine)
`mm restore` asks for the recovery identity (a hidden tty prompt or a file the human names; refused when run inside
an agent, except `--drill` with test keys). The prompt reads `/dev/tty` with echo off and holds the line in a 0600 file
in the memory-backed secrets folder only while restore runs; `age` reads it from there. It decrypts each sealed file in memory, makes a new machine key, reseals everything to the new machine key
plus the recovery public key, and drops the identity from memory. The old machine key is never needed.

## What changes for existing inputs
Inputs whose consumers read a file at a fixed path today (`~/brain/.keys/.cf`, `expose.pass`, …) move one at a time:
the consumer learns the runtime path, then `mm fill` seals that input instead of writing its file, and the old file
is removed by its owner (ops for the brain's keys). Until an input is moved, `mm fill` keeps writing its file, mode
600 as today.

## Sync (sy-240)
`mm sync` copies only `vault/*.age`, `vault/recipients.txt` and `vault/digests.txt` (an allowlist), and refuses
any blob containing `AGE-SECRET-KEY-`; the sync checkout has the same refusal as a hook.

## If a key is exposed
Sealed files stay in git history for ever. A machine key exposed: rotate the underlying secrets (not only reseal). The
recovery key exposed: the same, plus a new recovery key.

## Tests
Seal and open round trip; a value never on argv, env or output; files 0600, folders 0700; runtime files only on a
tmpfs; a second recipient (the recovery key) can open what the machine key sealed; reseal to a new machine key;
`mm sync`'s allowlist and its secret-key refusal.
