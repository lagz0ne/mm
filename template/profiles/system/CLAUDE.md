# System: {{name}}

This board runs the machine `{{name}}` and governs everything on it: the OS, access and security, mm and its machine
services (process manager, names proxy, observability, scheduler), the projects' lifecycle, and the private
mastermind repo. Humans steer through this board. The leads are **ops** (with SRE), **review** (security and
compliance) and **platform** (mm). **setup** changes this board's own configuration.

## The program
`{{brain}}/program.md` is the program. It is human-owned and authoritative: the run loop, the metric
(`bin/brain score`), the risk tiers T0–T3, secrets, memory discipline and git rules all come from there. Where this
file and the program disagree, the program wins; say so on the board.

## Where things are
- `{{brain}}`: the brain repo: `memory/` (what we know; a cache of the machine, the machine is the truth),
  `.claude/skills/` (how to operate each service), `migrations/` (machine changes with rollbacks), `plans/`,
  `journal/`, and the harness (`bin/brain`, `bin/guard`). Its `main` moves only by `bin/brain promote`.
  **Only ops writes it.**
- `{{home}}/mm`: the mm repo (public): CLI, manifest and the project template. **Only platform writes it.**
- `{{projects}}/*`: the projects. **Nobody here writes them.** Their engine changes come from the template
  (`mm update`); their configuration from their own setup agent; their product from their own leads. To ask a
  project for something, file an item on its board: `project-item <project> "title" -d "..."`.
- `{{root}}`: this board's own config repo: `leads/`, `setup/`, `governance.json` (humans only), `services.yaml`.

## Risk tiers on the board
Label every machine change `t1` or `t2` (see the program). A `t2` item needs, in this order: a plan with rollback and
a lockout safeguard in the item, review's sign-off (`signed-off` label + comment), the human's approval (it shows as
`approved`). Only then does ops run it. T3 is never done by a lead: ask the human.
The owner approves in one of two ways, and only these count: the **Approve** button of the bridge's Telegram message
(actor `bridge`), or the board's public address, signed in as the owner. The Supervisor reads who added `approved`
from the board's journal. No lead sets or relays `approved`, and no lead writes as `bridge` or as the owner: the guard
refuses it, and the board's local side refuses `approved` too.

## Seeing the machine
`bin/brain status` and `bin/brain score` (the machine's state and debt), `mm ls`, `mm obs status|errors|slow|logs`
(what every project and service did), `svc ls` (this board's services). No secret is ever read or printed.
