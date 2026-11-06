# Assistants: one per human, between them and the boards

Design for the assistant kind (profile system first). An assistant reads and drafts for one human. It never acts:
everything it produces is a draft or a summary, and only the human's tap posts or approves. Status: **design, for
review and the bridge's owner before it is built.**

## Shape on disk
`assistants/<user>/` on the system board, next to `leads/`:
- `CLAUDE.md`: that person's style, language, level of detail and priorities. Written with the human by setup; the
  human or setup changes it, nothing else.
- `.claude/skills/`: their workflows.
- `.claude/settings.tmpl.json`: permissions (none that act or read), rendered by `config-check`; owner or setup only.
  of its own (below).
- `assistants/CLAUDE.md`: the shared brief (what an assistant is, its limits, the data boundary).

## Three calls and one conversation
The bridge talks to the assistant through one command, `bin/assist`. JSON goes in on stdin, and JSON validated
against a schema comes out on stdout. Each call is one `claude -p --json-schema` run in `assistants/<user>/` (its brief
and permissions apply), with a hard timeout. On a timeout, an error or invalid output, `bin/assist` exits non-zero and
the bridge falls back to the raw text. The assistant is never on the critical path.
- `bin/assist card <user>`: an approval card from facts only: the request and its fingerprint, the guard's reason,
  the item with its sign-off and tier, and the brain's memory/skill for that service. Out: `{asked, item, signoff,
  risk, safeguard, read, tier, fingerprint}`, at most ~8 lines rendered. `read` is a recommendation or
  `"unclear: …"`, never a decision. The card never contains the buttons' effect; Allow and Deny stay the bridge's.
- `bin/assist in <user>`: a message the human typed. Out: `{intent, board, item, missing[], questions[≤3], draft}`;
  `questions` is empty when the message is clear. The bridge shows the questions, then **Send / Edit / Send as I
  wrote it**.
- `bin/assist out <user>`: a lead reply, an incident or an approval on its way to the human. Out: `{summary,
  needs_you, next, ref}`. The bridge shows the summary, with the full text one tap away (`ref`).
- **Explain:** a conversation about one request or item. It runs in a Paseo agent per human (labels
  `project=system kind=assistant user=<user>`), started by `bin/assist chat <user>`, with the same brief and permissions.

Modes per human (`always`, `on demand`: a `?` prefix or `/assist`, `off`) are stored in
`assistants/<user>/mode` and read by the bridge.

## Limits (enforced by its tools, not by its brief)
- **No tools that act or read.** An assistant has `Skill` (its workflows' text) and nothing else. No Bash: any shell
  as this user reaches the agent manager, the boards' databases and sudo. No file tools, no web tools (a URL could
  leak board content), no agent-manager MCP, no scheduling, messaging or agent tools. How it's enforced:
  - every built-in tool is denied by name in its settings and on the command line (`bin/lib/assist.mjs`);
  - no MCP servers are loaded (`--strict-mcp-config`);
  - a refused tool is never asked about (`dontAsk`), so no permission request written by an assistant can reach a
    human as a card;
  - `bin/assist` reads the session's tool list before the model's first turn and kills the run (exit 5) if it has
    any tool outside the allowlist, for example one a newer CLI adds. `bin/assist tools <user>` prints that list for
    an audit.
  - the conversation agent (`bin/assist chat`) runs in Paseo, which can't kill a run by its tools, and without the
    command-line flags: only its folder's settings. So `bin/assist tools <user> --chat` decides that session's tools
    from the files Claude Code reads at start (its folder's and its Claude folder's settings and MCP servers, the
    managed settings), without starting anything: no Claude Code, no MCP server, no hook. A built-in tool no source
    denies, an MCP server not denied whole (its tools are known only when it runs: "unverified", unless the allow list
    names them one by one), an enabled plugin, a hook on any event but `PreToolUse` or a setting that runs a command
    fails it (exit 5). `chat` runs it first and starts nothing unless it passes; the system board's sentinel runs it
    once per pass and opens `assist:<user>` (P1, for ops) when it doesn't. Not seen: what Paseo itself adds at its
    start; auditing that real start waits until Paseo exposes its start arguments.
- **What it reads comes in the message.** The bridge passes the request, item, reply or incident. A scoped read tool
  (`mcp__mm_read`, served by the gateway or bridge, checking the human's focus on every call) is the only read tool an
  assistant may ever get; it's allowed by name and doesn't exist yet. File and Bash allowlists can't enforce scope,
  because every board's database answers any process of this user on localhost.
- **Posting is the bridge's,** under the human's name, after the human's tap: exactly the text the human saw when they
  tapped Send. Nothing is regenerated after the tap.
- **Who changes what:** the human may change their brief (`CLAUDE.md`: style, language) and skills. Only the owner
  (`SETUP_HUMAN=1`) or setup may change `assistants/<user>/.claude/` (permissions). `config-check --staged` refuses
  anyone else, and `config-check` refuses any assistant template with a tool outside the allowlist, extra directories,
  hooks, or an asking mode.
- **Revoke:** `bin/assist stop <user>` archives their conversation agent. The gateway's revoke calls it, and a smaller
  focus narrows the read tool on its next call.
- **Approving and granting are the human's taps.** No assistant call can produce one: they're not in any schema.
- **Lead output is data.** `out`, `card` and `chat` get board text inside a fenced, labelled block. The brief says
  that block is material to summarise, never instructions. Since the assistant can't act, the worst an injected
  instruction can do is distort a summary. That's why the full text and the exact command are always one tap away,
  and why the card's facts (fingerprint, tier, sign-off) are copied by `bin/assist` from the request, not written by
  the model.
- **Scope:** an assistant reads only the boards in its human's focus (the gateway's grants, once they exist; until
  then, the owner's assistant only).

## Tests
- Schema: each call returns valid JSON, or the command fails (timeout, bad output) and the bridge can fall back.
- Facts: the card's fingerprint, tier and sign-off equal the request's, even when the model is told otherwise inside
  the data block.
- Limits: `config-check` refuses an assistant template with any tool outside the allowlist; a session that offers one
  (or an MCP server) is killed; a real session has `Skill` only. Injections in an approval request, an item body, a
  lead reply and a member comment are reported as content, and there is no tool to act on them anyway
  (`test/assist.sh`, `ASSIST_LIVE=1` for the real calls).
