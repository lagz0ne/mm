# Working on the board (all leads)

Humans steer through the work board, which is Beads. Each person names themselves there (e.g. `alex`); any
author that isn't a lead or the system (`wake`, `watchdog`) is a human. You never chat with them directly: everything you say goes
in a comment on the item, and they read it there. Address the person by name, and answer the human who asked. The other leads are agents like you.
Talk to them the same way, with comments and new items. Who does, approves, is consulted on, and is told about each
kind of work:

@RACI.md

## Board CLI: `bd` (on your PATH; your actor is preset to your role, so changes show under your name)
- `bd ready --assignee <role> --json` (your queue, in priority order) · `bd list --assignee <role> --status in_progress,blocked --json`
- `bd show ID --json` (includes comments and dependencies) · `bd comments add ID "text"` (long text: `-f file`)
- `bd update ID --claim` (pull an item: atomic, and it refuses one someone else holds) · `bd update ID -s blocked` ·
  `bd label add|remove ID needs-you`
- `bd create "title" -d "..." -t task|feature|bug -p 0-4 --assignee <role> --parent EPIC --deps blocks:ID --json`
- `bd close ID --reason "..."`: closing unblocks whatever waits on it, which wakes that lead.

## Each time you are woken ("Board update" message)
1. Read the update, then your items (ready, in progress, blocked) and any new comments.
2. **Answer every human comment on your items in this turn**, even if only "noted, doing X next".
3. Pulling a ready item (within your capacity, see below): `bd update ID --claim`, then comment what you understood and
   your plan (2–4 lines). Never set `--status in_progress` by hand: your settings refuse it.
4. Do the work. Post progress as comments at meaningful points, not every step, and at least every 30 min (that keeps
   your claim).
5. Questions only the human can answer: comment the question, `label add needs-you`, `status blocked`, and stop working
   on that item. Prefer a stated, reasonable assumption over a question when the risk is low.
6. Done: comment what you did, where it is (file paths, commit ids, URLs), and how to check it, then `close` with a
   short reason.
7. End your turn. You will be woken again on the next change or comment; don't poll or sleep.

## Your queue and your capacity (the pull model)
- **Your queue is the board:** your ready items, `bd ready --assignee <role> --json`, in priority order. A handover to
  you lands there too. When you have room, `wake` hands you the head of the queue ("... is next in your queue"); a new
  lead gets it in its first prompt.
- **Capacity:** your role's `capacity` in `leads/roles.json` (default 1) is the most items you hold in progress at once,
  yours and your workers' together (the project has a cap over all roles too). At capacity, finish, hand over or block
  one before you claim the next; `wake` keeps the rest of the queue waiting.
- **Workers** (roles that have them): claim the item yourself, then give it to one worker in its own worktree (your role
  brief says how). The item stays yours: you frame it, integrate the result and end the unit of work. Never more
  workers than your free capacity.
- **Lease:** a claim stays yours while the item moves (any comment or change). An item in progress with no update for
  30 min goes back to your queue (status open, by `wake`), and the Supervisor reports it; the 3rd time, it goes to the
  human (`needs-you`). Claim it again to go on.

## End a unit of work with a board change
`wake` reads the board's state, not the words in a comment: the change itself says who acts next. First comment what
you did and where (as in step 6), then make one of these changes:
- **Hand over** to another role: `bd update ID -a <role> -s open --if-assignee <you> --if-status <its status now>`.
  The item lands in that role's queue (`bd ready -a <role>`), and wake wakes that role, also when you were the
  assignee. Hand it to the human the same way, with their name (e.g. for an approval): wake labels it `needs-you`.
  Exit code 13 means the item changed under you (someone else took or moved it). Read it again (`bd show ID --json`)
  and decide again; never force it.
- **Blocked**: `bd update ID -s blocked`. wake wakes the role Accountable for the item's activity, else the board's
  Lead, else the human (`needs-you`).
- **Waits on another item**: `bd dep add ID OTHER`. wake wakes OTHER's assignee.
- **Reopen** an item whose task does not hold (its outcome, constraints or verify): comment why on it, then
  `bd reopen OTHER`. wake wakes its assignee.
- **Done**: `bd close ID --reason "..."`, with the proof (tests, commit, URL) in your last comment. It wakes nobody;
  closing unblocks what waits on it.
A comment line such as `HANDOFF review` changes nothing. A role is never woken by its own change, and lead-to-lead
wakes on one item stop after a few rounds without a human.

## Your files: one writer per repo
- ops writes `{{brain}}` (through the program's run loop: `bin/brain run start|keep|discard`, one idea per commit).
- platform writes `{{home}}/mm` (commit with the item id in the body; releases go through the board).
- review writes nothing but comments and items.
- Quote commit hashes and file paths on the item. Nobody here edits `{{projects}}/*`.

## Shared rules
- `{{brain}}/program.md` is the source of truth. If it is wrong or unclear, comment on the item. Don't silently diverge.
- On the board, link files by their path (e.g. `memory/svc-sshd.md`, `plans/<slug>.md`), with a short summary. Don't paste whole
  documents into comments: the board renders and embeds the file itself.
- Comments on an item are #1..#n in thread order (the `comments` order in `bd show ID --json`); board updates name
  the new number. Refer to earlier comments as #n instead of quoting them; start a reply to one with "re #n".
- Only change your own items, apart from creating new ones (bugs, questions) for other roles.
- Memory: when you save a memory, put `verified: <today, YYYY-MM-DD>` and `ttl_days: <how many days it holds>` under
  `metadata:` in its frontmatter (`memory/README.md`). config-check refuses one without them. When you check a fact
  again, update `verified`; when it is wrong, fix or delete the file.
- Stay inside what your role brief allows. No `git push` (pushes go through ops with the human's approval), no secrets:
  refer to them by path only, never read or print them.
