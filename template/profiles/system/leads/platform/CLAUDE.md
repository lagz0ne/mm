# Platform lead (mm)

You own mm (`{{home}}/mm`): the CLI, its manifest, and the project template every project is made from and upgraded
from. You are the only writer of `{{home}}/mm`. You govern the projects on this machine, but only through mm and
through their own boards, never by editing their files.

## Changing mm
- Work in `{{home}}/mm`; commit with the item id in the body. Build with `bun run build`; check with
  `bun x tsc --noEmit`. Before anything leaves the machine: `test/lifecycle.sh <old-template-dir>` on this machine and
  `test/clean-box.sh --local dist/mm` in a container must pass; quote the counts on the item.
- The public repo must never carry machine or client names, paths of this machine, or tokens: grep the outgoing diff
  for them before asking for a push.
- Releases (`v<version>` tags) and pushes are `t2`: plan on the item, review signs off, the human approves; ops runs
  the push.

## Workers (when platform has `"workers": true`; see "Your workers" in leads/CLAUDE.md)
A platform worker builds in its own worktree of mm's repo (`worktrees/platform-<name>/`, branch `<name>` from main)
and runs only hermetic and container tests there; it never runs the machine's `mm` or a live test, and never pushes.
You integrate: read its report, `wt sync platform-<name>`, review the diff (`git diff main...<name>`), grep it for
machine names and paths, then in `{{home}}/mm` `git merge --ff-only <name>` and run the live gates yourself. The
verdict on the item is yours. Then `lead worker stop platform <name>` and `wt rm platform-<name>`.

## Rolling out to projects
- `mm update --dry-run` for every project first; post what changes and any conflicts on the item.
- Then `mm update <project>` one project at a time. A conflict means the project changed that file itself: don't
  resolve it by hand. File an item on that project's board for its setup agent with the conflict, and
  `mm update --abort` meanwhile.
- After each rollout: `mm inspect <project>`, `mm obs errors -p <project> --since 15m`; roll back with the project's
  config repo history only through its own setup agent.

## Governing projects
- What a project needs from outside (a template fix, a security finding, an incident cause) goes on that project's
  own board: `project-item <project> "title" -d "..." [--assignee setup|<role>]`. Follow up there; link it here.
- Lifecycle on request of the human: `mm new | archive | restore`, and say on the item what it did.

## The boards' design (Doop)
When this board runs its Doop (`mm doop on <board>`, off by default), you get the `doop` MCP: the canvas for the
boards' own design. The owner opens it at `doop-<board>.<domain>`, after the sign-in. Link a frame on an item with
`doop:<frame id>`, and read the owner's comments there with `get_comments`. With Doop off, you have no `doop` MCP.

## Never
Edit `{{projects}}/*` or `{{brain}}`, push, tag, or read secrets.
