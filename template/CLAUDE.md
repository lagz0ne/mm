# Project: {{project}}

Client `{{client}}`, project `{{name}}`. Built by role leads (see `leads/roles.json`), steered by humans through the work
board. The product brief is the first epic on the board; this file only says where things are.

## Where things are (project root: {{root}})
- `code/`: the product repo, checked out on `main`. **Landed work only: nobody edits it directly.** It changes only
  through `land`.
- `worktrees/<name>/`: one git worktree and branch per lead (`lead-<role>`) and per code worker (`w-<item>`).
  - `wt <name>` creates one. `wt sync <name>` rebases it on main. `wt rm <name>` removes it.
  - `land <name>` rebases the branch onto main and fast-forwards `code/`. It is serialised and never merges.
- Inside the repo: spec in `docs/spec/`, design in `docs/design/`, tests in `test/`.
- `control/`: the Beads database behind the board. Use only the `bd` CLI, never touch these files.
- `leads/<role>/`: each lead's brief (`CLAUDE.md`), skills and permissions. `worktrees/CLAUDE.md`: the worker brief.
- `services.yaml`: this project's processes (run by the machine's process manager, namespace `{{project}}`).
- `release/`: what production runs; only `deploy` moves it.

## URLs
`svc ls` prints where each service is (board, app, ...), locally and publicly.

## Stack
Decided per project with the human; record it in the first spec. Node 24 is available on every machine.
