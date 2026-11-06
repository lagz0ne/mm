# Approvals the machine's owner account can't make

A tier-2 change (an access change, a firewall, a root wrapper's policy) runs only after the owner's approval. Today
that approval is the `approved` label on the board, read with the actor the board's journal gives it (`bridge`, or the
owner's name). Every agent runs as the machine's owner account. That account can write every part of such an approval:
the bd CLI and bd-serve take any actor, and the board's database is its own files. The guards' text rules are a brake,
not a wall.

This design makes an approval something that account can't make: **a line in a ledger, signed with a key only a
separate system user can read.** `box/mm-approve` is that signer. The checks in mm (the Supervisor, flow, `mm doctor`)
read the ledger when a root-owned switch says so.

## Read this first: when it is a wall

1. **Only after the owner account loses blanket sudo.** While that account has passwordless sudo, any agent can
   become the signer's user or root, read the key and sign what it likes. Until then the ledger holds against a
   careful agent, not a hostile one, as the actor field does today. Switch the ledger on with the host-hardening step
   that takes blanket sudo away (step 7), or after it, never before.
2. **The bot token is rotated when the bridge moves.** The owner account has been able to read today's Telegram bot
   token. Whoever holds it can send the owner a message with an Approve button that looks like any item. At the move,
   the owner revokes it and makes a new one (BotFather), and only the signer's user reads the new one. That step is the
   owner's.
3. **The checks in mm detect; they are not the wall.** The Supervisor and flow run as the owner account, from files it
   can write. They tell the owner when an approval is missing. The wall is the step that runs a tier-2 change as root
   once the owner account has no sudo of its own: it must call `mm-approve verify <item> <subject>` for the exact
   migration (or head) it is about to run, and refuse on anything but yes. That step is ops' (`bin/brain migrate` and
   `promote` with the approval flag, behind a root wrapper).

## The parts

| Part | Where (example) | Owner, mode |
|---|---|---|
| the signer | `/usr/local/libexec/mm-approve` (`box/mm-approve`) | root:root 0755 |
| its config and the switch | `/etc/mm-approve.conf` | root:root 0644 |
| its folder | `/var/lib/mm-approve/` | the signer's user, 0755 |
| the signing key | `/var/lib/mm-approve/private/key.pem` (and its offers) | the signer's user, folder 0700, files 0600 |
| the ledger | `/var/lib/mm-approve/ledger.jsonl` | the signer's user, 0644 |
| the public key | `/etc/mm-approve.pub` (installed from `/var/lib/mm-approve/key.pub`) | root:root 0644 |
| the plan command | e.g. `/usr/local/libexec/mm-approve-plan` (ops' code) | root:root 0755 |

The signer's user (`mm-approve`) is a system user with no login shell and no sudo. The verifiers refuse the whole
ledger (nothing counts) when the ledger, its folder or any folder above it can be changed by anyone but the signer's
user or root, when the ledger is a symlink or has a second link, or when the public key isn't root's.

### The config: `/etc/mm-approve.conf`

`key = value` lines, `#` comments:

| Key | Default | Meaning |
|---|---|---|
| `verifier` | `actor` | `actor`: approvals are read as before (the journal's actor). `ledger`: only signed ledger lines count. |
| `user` | `mm-approve` | the signer's user |
| `dir` | `/var/lib/mm-approve` | the signer's folder (ledger, `key.pub`, `private/`) |
| `public_key` | `/etc/mm-approve.pub` | the public key the verifiers use (root's) |
| `plan_command` | none | a root-owned command that prints an item's plan: `plan_command <item>` |
| `owner_telegram_id` | none | the only Telegram id whose tap signs |
| `expires_hours` | `24` | how long an offer can be tapped |
| `max_shown` | `3500` | how much of the plan a message shows (Telegram's limit is 4096) |
| `openssl` | `/usr/bin/openssl` | the ed25519 implementation (python's standard library has none) |

The file is root's, so the owner account can't flip the switch. Ops' guard lists it as tier 2. The verifiers read it
whenever it exists, and then never a config named by the environment. Only on a machine without it, `MM_APPROVE_CONF`
names another one (mm's tests).

## How an approval is made

1. **Offer** (before the bridge shows a button): `mm-approve offer <item> --subject <S>...`. The signer runs
   `plan_command <item>` itself and hashes the raw text it prints (sha256): the **plan hash**. It keeps
   `{offer id, item, plan hash, subjects, expires}` in its private folder, and prints JSON: the offer id, the plan hash,
   the subjects, the expiry, and `text`: what the message shows. The text is the plan as the command printed it, then
   the hash and the subjects. If the plan is longer than `max_shown`, the text says so; the hash is still the whole
   plan's. (`--plan-stdin`: the bridge may pass the text it means to show; the signer refuses it unless it is exactly
   what the command printed.)
2. **Show**: the bridge sends `text` with an Approve button whose callback data is the offer id.
3. **Tap**: on the callback, `mm-approve tap <offer id> <tapper id> [--item <the item the callback names>]`. The tapper
   id is the one Telegram's update says tapped (the bridge checks the update came from Telegram). The signer:
   - refuses an id that isn't the config's `owner_telegram_id`;
   - refuses an offer id it never made, one already used (one approval per message), and one expired;
   - refuses when `--item` names another item than the offer's (the item and the hash never come from callback data);
   - runs `plan_command <item>` again, and refuses if the hash changed since the offer (the offer is then void: make a
     new offer);
   - then appends one signed line to the ledger.

Exit codes: 0 signed; 2 refused; 3 the plan changed; 4 used; 5 expired.

### What is signed: a ledger line

```json
{"approver": "telegram:<id>", "item": "sy-x", "offer": "<32 hex>", "plan": "<sha256 of the plan>",
 "sig": "<base64 ed25519>", "subjects": ["sha256:<64 hex>", "git:<40 hex>"], "time": "2026-01-01T00:00:00Z", "v": 1}
```

The signature covers these bytes, one field per line in this order (the same in `box/mm-approve` and
`template/bin/lib/ledger.mjs`):

```
mm-approve/1
item=<item>
plan=<plan hash>
subjects=<subject>,<subject>
approver=<approver>
time=<time>
offer=<offer id>
```

### Subjects: what the approval lets run

An approval is bound to what it lets run, not only to the item. Each subject is one of:
- a migration: `sha256:` + sha256 of `mm-approve/1 migration\n<sha256 of the script>\n<sha256 of the rollback>\n`
  (no rollback: the hash of nothing). `mm-approve subject migration <script> [<rollback>]` prints it;
  `migrationSubject()` in ledger.mjs is the same.
- a promote: `git:<the full head>` (`mm-approve subject head <sha>`).

A changed script or rollback is another subject: it needs its own approval. So does a later migration that names the
same item.

### Checking an approval

- `mm-approve verify <item> <subject>`: `yes` (exit 0) only for a well-signed line of that item naming that subject,
  in a ledger whose owner and modes are right, with `verifier = ledger`. Anything else: `no` and why (exit 1).
- `template/bin/lib/ledger.mjs`: the same checks in node, for the board's own programs.
- **The Supervisor** (`t2-unapproved`): with the ledger on, the journal's actor counts for nothing. A t2 item in
  progress needs a line of the item; each applied tier-2 migration that names the item needs a line of the item with
  that migration's subject. An `approved` label with no line of its item is a finding, whoever added it. A ledger the
  verifier refuses is one finding of its own (`t2-unapproved:ledger`), and then no approval counts.
- **flow**: the approval rail ends only when the label comes with a line of the item.
- **`mm doctor`** (`approval ledger`): with the ledger on, the owners and modes above, and the private folder 0700.

## What the bridge must do (ops' code)

- Run as the signer's user, from root-owned code and a root-owned unit. Code the owner account can write would give
  it the signer's rights.
- Read the new bot token (rotated at the move); nobody else reads it.
- Before it shows an Approve button: `offer`, and show exactly the `text` it gets. A model's rewrite may be shown as
  well, but it is never part of what is offered or signed. Better: the model call runs in another process.
- On the callback: `tap <offer id from the callback> <the tapper's id from Telegram's update>` (and `--item` with the
  item the callback names, if it names one). Never sign itself, never build a ledger line.
- On "plan changed": send a new offer. On "used" or "expired": say so.
- Then add `approved` on the board as today, for the people who read the board. The label alone counts for nothing.

The owner's Approve on the board's public address is to go the same way (not built yet): it asks the bridge to send
the Telegram offer, and the tap is what counts. Until then, with the ledger on, an approval on the board's web page
counts for nothing.

## Putting it on the machine (ops, tier 2)

1. The user: `useradd --system --no-create-home --shell /usr/sbin/nologin mm-approve` (no sudo).
2. The signer: `install -o root -g root -m 0755 box/mm-approve /usr/local/libexec/mm-approve`; the plan command the
   same way.
3. The config: `/etc/mm-approve.conf`, `install -o root -g root -m 0644`, with `verifier = actor` first.
4. The folder and the key: `install -d -o mm-approve -g mm-approve -m 0755 /var/lib/mm-approve`; then, as that user,
   `mm-approve keygen`; then `install -o root -g root -m 0644 /var/lib/mm-approve/key.pub /etc/mm-approve.pub`.
   `mm-approve check` says whether the owners and modes are right.
5. The bridge moves to the signer's user; the owner rotates the bot token.
6. `verifier = ledger`, with or after the step that takes blanket sudo away from the owner account. `mm doctor` checks
   it. Ops' root-side runner of tier-2 changes calls `mm-approve verify` for each migration or head.

**Rollback:** `verifier = actor` in the config (the verifiers read the journal's actor again); the bridge back to its
old user. The ledger and the key stay; nothing reads them.

Keep the key. A new key makes every earlier line unverifiable (`keygen` refuses to replace one).

## Tests

`test/mm-approve.sh` (hermetic: the signer in test mode, a throwaway folder as its home, the test's user as the
signer's user, a stub plan command): the good path in both verifiers; a forged line (another key), a line with its item
or subject changed, a line for another subject or item, a changed plan after the offer, callback data naming another
item, an expired offer, an offer used twice, a tap by someone else, an offer never made, the ledger, its folder or the
key writable by others, a second link, a symlink, another owner; the switch; subjects; a long plan; `mm doctor`.
`test/supervisor.mjs` and `test/flow.mjs` each run their ledger cases with the real signer. On a machine where
`/etc/mm-approve.conf` exists, the verifier cases are skipped: the verifiers never read a test config there.
