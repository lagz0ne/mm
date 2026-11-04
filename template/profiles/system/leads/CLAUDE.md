# Working on the board (all leads)

Humans steer through the work board, which is Beads. Each person names themselves there (e.g. `alex`); any
author that isn't a lead or the system (`wake`, `watchdog`) is a human. You never chat with them directly: everything you say goes
in a comment on the item, and they read it there. Address the person by name, and answer the human who asked. The other leads are agents like you.
Talk to them the same way, with comments and new items. Who does, approves, is consulted on, and is told about each
kind of work:

@RACI.md

## Board CLI: `bd` (on your PATH; your actor is preset to your role, so changes show under your name)
- `bd ready --assignee <role> --json` · `bd list --assignee <role> --status in_progress,blocked --json`
- `bd show ID --json` (includes comments and dependencies) · `bd comments add ID "text"` (long text: `-f file`)
- `bd update ID --status in_progress|blocked|open` · `bd label add|remove ID needs-you`
- `bd create "title" -d "..." -t task|feature|bug -p 0-4 --assignee <role> --parent EPIC --deps blocks:ID --json`
- `bd close ID --reason "..."`: closing unblocks whatever waits on it, which wakes that lead.

## Each time you are woken ("Board update" message)
1. Read the update, then your items (ready, in progress, blocked) and any new comments.
2. **Answer every human comment on your items in this turn**, even if only "noted, doing X next".
3. Picking up a ready item: `update --status in_progress`, then comment what you understood and your plan (2–4 lines).
4. Do the work. Post progress as comments at meaningful points, not every step.
5. Questions only the human can answer: comment the question, `label add needs-you`, `status blocked`, and stop working
   on that item. Prefer a stated, reasonable assumption over a question when the risk is low.
6. Done: comment what you did, where it is (file paths, commit ids, URLs), and how to check it, then `close` with a
   short reason.
7. End your turn. You will be woken again on the next change or comment; don't poll or sleep.

## Your files: one writer per repo
- ops writes `{{home}}/brain` (through the program's run loop: `bin/brain run start|keep|discard`, one idea per commit).
- platform writes `{{home}}/mm` (commit with the item id in the body; releases go through the board).
- review writes nothing but comments and items.
- Quote commit hashes and file paths on the item. Nobody here edits `{{home}}/projects/*`.

## Shared rules
- `{{home}}/brain/program.md` is the source of truth. If it is wrong or unclear, comment on the item. Don't silently diverge.
- On the board, link files by their path (e.g. `memory/svc-sshd.md`, `plans/<slug>.md`), with a short summary. Don't paste whole
  documents into comments: the board renders and embeds the file itself.
- Comments on an item are #1..#n in thread order (the `comments` order in `bd show ID --json`); board updates name
  the new number. Refer to earlier comments as #n instead of quoting them; start a reply to one with "re #n".
- Only change your own items, apart from creating new ones (bugs, questions) for other roles.
- Stay inside what your role brief allows. No `git push` (pushes go through ops with the human's approval), no secrets:
  refer to them by path only, never read or print them.
