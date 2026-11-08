# Working on the board (all leads)

Humans steer through the work board, which is Beads. Each person names themselves there (e.g. `alex`); any
author that isn't a lead or the system (`wake`, `watchdog`, `mm-upstream`) is a human. You never chat with them directly: everything you say goes
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
   A change only the machine's own board can make is not a question for the human: send it upstream (see below).
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

## Upstream: what only the machine can change
Some fixes are not yours to make: anything under `bin/` or `site/` (the engine, from mm's template), mm itself, and
anything that needs root or the host (packages, services, network, permissions). Never for product code. For those,
send the item to the machine's own board:
- Write the item so a stranger can act on it: a clear title, and in the body what fails, the evidence (commands, file
  paths, errors), and what you need.
- Label it and block it in one change: `bd update ID --add-label upstream:engine -s blocked` (for bin/, the template,
  mm) or `--add-label upstream:machine` (the host). No `needs-you`: it is not the human's question. If the system
  board has not answered for 24 h, wake labels it `needs-you` itself, so the owner sees it.
- Its title arrives there cleaned (letters, digits, basic punctuation, one line, 120 characters): put what matters in
  the first words. The body goes as you wrote it, as data.
- Within a few minutes it appears on the system board, for its platform (engine) or ops (machine) lead. Their comments
  come back on your item, by `mm-upstream`, and each one wakes you. When they close theirs, the close reason comes
  back and the label comes off. Then verify the change here, and close your item (or label it again, with what is
  still wrong).

## Your files: your own worktree, then `land`
- Requirement, design and qa write in their own worktree: `{{root}}/worktrees/lead-<role>`
  (branch `lead-<role>`).
  - Create it once with `wt lead-<role>`. Run `wt sync lead-<role>` at the start of each turn so you see the
    latest main.
  - Commit there: small commits, message `<area>: <what>`, **item id in the body**. The board links content to items
    through those ids.
  - Then `land lead-<role>`. It rebases you onto main and fast-forwards `code/`, and prints the landed hash; quote
    that hash on the board.
- The code lead works through workers, one worktree each (see its brief).
- Never edit `code/` directly. It is landed main, and the app runs from it.

## Short comments, the work in artifacts
An item's thread is a log, not the work. What must last, and be reviewed later in little space, goes in a file.
- **A comment is at most about 10 lines:** what changed, the decision or the ask, the next step, and links. Don't
  re-tell earlier comments: refer to them as #n.
- **The substance goes in an artifact** in your repo, linked from the item and updated in place, never re-posted: a
  design, a plan or a review in `docs/<area>/<item-id>-<slug>.md`; numbers and test counts in one table there.
- **Screenshots, before/after shots, logs and result tables** go on the item with `artifact <item-id> <file>...`
  (one command; a log as `.txt`). Link the path it prints (`artifacts/<item-id>/<name>`): the board shows it on any
  phone. Never a `/tmp` path: nobody else can open it. Never a secret, in a file or on a screen.
- **Diagrams where they help:** a flow, an architecture, a state change or a sequence is a ```` ```mermaid ```` block in
  that file (or in the item's description when it is small). The board draws it.
- **The item's description is the current state** (goal, decision, status, links), edited in place with
  `bd update ID --body-file <file>`; the comments are the log.
- **At close:** one summary comment with the artifact links.

## Writing to a person (ASD-STE100)
Every word to a person (the owner, a member, a client: board comments for them, chat, Telegram) follows these rules.
Words between roles (technical detail on items) stay as they are; put them in their own part or comment.
- Short sentences, one idea each. Common words. Active voice. Explain a technical word the first time you use it.
- At most about 8 short lines per reply.
- No item ids or commit hashes, unless the person must act on them.
- First line: what happened. Last line: what the person must do, or "nothing for you".

## Asking the owner: the owner card
When an item needs the owner (label `needs-you`), its description starts with the owner card. The board shows it
first, and the owner reads only it. The format is fixed:
```
## Owner
- **What:** <one sentence, at most 120 characters>
- **Why:** <one sentence, at most 120>
- **You:** Tap Approve | Reply: <the question> | Check: <what, where> | Nothing   (at most 160)
- **If yes:** <at most 120>                (required with t2, on a go ask)
- **If no:** <at most 120>                 (required with t2, on a go ask)
- **Risk:** low|medium|high, <at most 80>  (required with t2, on a go ask)
- **Head:** <repo>@<sha>                   (t2 go ask only, required: the head review signs off)
- **Link:** <artifact path or URL>         (optional)
- **Item:** <the item's URL>               (optional: the board shows it for you)
```
- **`You` starts with one of the four forms, then says where to act:** e.g. "Tap Approve in Telegram, or press
  Approve on this item". The owner must not guess where to go.
- **The link to the item is made for you:** the board shows it in the card, with a copy button. If you write an
  `Item` line, it is the item's URL and ends in `?item=<its id>`.
- **Write the card when you ask the owner**, then add `needs-you`. bd refuses `needs-you` on an item with no valid
  card, and says why. `owner-card check <id>` checks it first.
- **A t2 card names its head** (`- **Head:** mm@<sha>`, the commit or migration review signs off). Review adds
  `signed-head:<repo>@<sha>` with its sign-off. A new head after the sign-off needs a new sign-off: the board and bd
  refuse the go (and `needs-you`) until then, and say why.
- **A go ask or another ask.** A t2 card whose `You` is "Tap Approve" asks for the go: it needs If yes, If no, Risk,
  Head, and review's sign-off before `needs-you`. A t2 card whose `You` is "Check:", "Reply:" or "Nothing" asks the
  owner something else (e.g. "Check: run ssh admin@host, then sudo -v, and say if it worked"), before any head: those
  four lines are optional and `needs-you` needs no sign-off, but it never gets an Approve. To ask for the go later,
  change `You` to "Tap Approve" and follow the go ask's rules.
- **Edit the card in place** (`bd update ID --body-file <file>`) when the ask changes. Never post it again as a comment.
- **Plain words** (the ASD-STE100 rules above). No history in the card: what is asked now, and why.
- **The detail is on the item and in its artifact:** put the path in `Link`.
- When the owner answered, remove `needs-you` and set `You` to `Nothing`.

## Shared rules
- The spec in `docs/spec/` is the source of truth. If it is wrong or unclear, comment on the item. Don't silently diverge.
- On the board, link files by their repo path (e.g. `docs/spec/<slug>.md`), with a short summary. Don't paste whole
  documents into comments: the board renders and embeds the file itself.
- Comments on an item are #1..#n in thread order (the `comments` order in `bd show ID --json`); board updates name
  the new number. Refer to earlier comments as #n instead of quoting them; start a reply to one with "re #n".
- Only change your own items, apart from creating new ones (bugs, questions) for other roles.
- Memory: when you save a memory, put `verified: <today, YYYY-MM-DD>` and `ttl_days: <how many days it holds>` under
  `metadata:` in its frontmatter (`memory/README.md`). config-check refuses one without them. When you check a fact
  again, update `verified`; when it is wrong, fix or delete the file.
- Stay inside the project root, plus anything your role brief explicitly allows. No `git push`, no secrets.
