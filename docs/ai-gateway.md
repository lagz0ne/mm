# mm.ai: the AI gateway for project boxes

Every model call from a project box goes through `mm.ai`, a host service. A box has no provider key, only a key from mm
that works for its own project. The gateway checks the key, the budgets and the cap on parallel calls. Then it calls the
upstream with the machine's key, and it counts each answer's tokens and cost. Code: `src/ai.ts`. Test: `test/ai.sh`, and
the "models only through mm's AI gateway" part of `test/box.sh` (Claude Code in a real box).

## The path

```
agent in the box --http--> <egress proxy>:4000 --socat--> $MM_HOME/box/<project>/ai/ai.sock --> mm.ai --https--> upstream
```

- Each box gets its own Unix socket. Only that box's egress proxy mounts it. The proxy listens on port 4000 on the box's
  network only (its address `.2`), not on its way out.
- **The project is the socket the call came in on.** A key for another project is refused there.
- There is no TCP port on the host, so the firewall rule that keeps containers off host ports stays as it is.
- In the box: `ANTHROPIC_BASE_URL=http://mm-egress-<project>:4000`, and the key in `/run/mm/secrets/ai.key` (tmpfs,
  read-only). The box's Paseo daemon starts its agents with `ANTHROPIC_API_KEY` from that file.

## Keys

- `mm up` for a box makes a new project key (31 days), and ends the project's previous ones.
- `mm ai revoke <project>` ends every key of a project now.
- mm keeps only each key's sha256. No command prints a key.
- Keys for one person in a project (for a lead that works on that person's item) are in the store already. They are
  handed out with the project API (sy-b15.8).

## Budgets and use

- `mm ai budget <project> <usd> [--person <name>]`: a monthly budget in USD; 0 removes it. Only the owner sets one: the
  command refuses in an agent's shell, and the template denies it to every role.
- At 80 % and at 100 %, the owner hears it on Telegram (once a month for each level).
- At 100 %, new calls get `403 permission_error` with the reason. Calls that are already running finish.
- `mm usage` (or `mm ai usage`): this month's use by project, person and model, with each budget and what is spent.
- Prices: `DEFAULT_PRICES` in `src/ai.ts`, in USD per million tokens. `ai.prices` in the config overrides or adds a
  model. A model with no price is counted at the dearest known one.

## The cap

`ai.max_parallel` (default 3): at most that many calls at once for each project. The next one gets `429` with
`retry-after: 5`, and Claude Code waits and tries again. This is the "agent cap" of plans/project-box.md step A.

## What is served

Only `POST /v1/messages`, `POST /v1/messages/count_tokens` and `GET /v1/models[/<id>]`. Anything else (batches, files,
the old completions API) gets 404 and never reaches the upstream. Only the headers the Messages API needs are passed
on: `anthropic-version`, `anthropic-beta`, `content-type` and `accept`. The box's key is never passed on.

## The model's own way out (review sy-b15.18)

Some Messages API tools run on the provider's side and reach the internet from there: web search and web fetch, code
execution, MCP servers (`mcp_servers`, `mcp_toolset`), and skills in a `container`. That is a way out of the box that
its egress list never sees. So mm.ai lets a tool through only when it runs in the box: one the caller defines (no
`type`, or `custom`), or one Anthropic defines that the caller runs itself (bash, text editor, computer, memory, tool
search). Anything else, `mcp_servers` and `container` get `400 invalid_request_error`, with the reason.

The owner can allow one for a project, like an egress host:

```yaml
ai:
  server_tools:
    <project>: [web_search]          # web_search, web_fetch, code_execution, mcp, container
```

`anthropic-beta` values that turn these on (`mcp-client-*`, `code-execution-*`, `web-fetch-*`, `web-search-*`,
`files-api-*`, `skills-*`, `container-*`) are dropped for a project with none allowed. Every other beta passes, so a new
Claude Code release that sends a new beta keeps working. The body check is the real control; this is a second one.

Note: a client feature that is built on a server tool (for example a web search that sends `web_search` to the API)
fails in a box with that 400 until the owner allows the tool. Tools that fetch from the box itself go through the
box's egress proxy and its list, as before.

## Turning it on (ops, t2)

1. The owner fills the upstream key: `mm fill ai-upstream-key`. This is an Anthropic API key, or the key of an
   Anthropic-compatible gateway. For the second kind, also set `ai.upstream` (its URL), and `ai.upstream_auth: bearer`
   if it wants `Authorization: Bearer`.
2. `mm config set ai.enabled true`. The next `mm up` of any project reloads the machine's process file, and that starts
   `mm.ai`. `mm up` for each box then gives it a key.
3. The guard and the template keep agents out of `$MM_HOME/ai/` and the upstream key file (sy-sn0).

## For now: the machine's Claude token as the upstream credential

**Only for the machine owner's own work, on their own subscription. It is not a feature for anyone else's use.**
Anthropic's terms for Claude Code (code.claude.com/docs/en/legal-and-compliance) say developers may not "route requests
through Free, Pro, Max, or Ultra plan credentials on behalf of their users", nor "collect, store, or intermediate
Claude.ai credentials or session tokens". What they allow is "an end user signing in to the unmodified Claude Code
binary with their own Claude subscription, including where a platform hosts Claude Code". So mm keeps this mode to
the owner: in oauth mode mm.ai takes only the owner's own run key (`owner_name`), or a project's background key for a
project where nobody but the owner holds a role (mm.auth's grants, read at each call; if they can't be read, it
refuses). Anyone else's run gets `403`. The default stays `ai-upstream-key`, a separate API key; use that as soon as you
can. Read the terms yourself: this note is not legal advice.

The owner can let mm.ai call Anthropic with the machine's long-term Claude token (the machine input
`claude-oauth-token`, made with `claude setup-token`) instead of a separate upstream key. Then no `ai-upstream-key` is
needed. Two lines, with `ai.enabled` on as above:

```
mm config set ai.upstream_key_input claude-oauth-token
mm config set ai.upstream_auth oauth
```

- `ai.upstream_key_input` names the machine input whose file mm.ai reads. Only `ai-upstream-key` (the default) and
  `claude-oauth-token` are allowed, never a path. Anything else stops mm.ai at start, with a log line that says why.
  If the config changes while mm.ai runs, each call gets `503` with the same reason.
- `ai.upstream_auth: oauth` sends the token as `Authorization: Bearer`, with no `x-api-key`, and adds the beta
  `oauth-2025-04-20` to the client's `anthropic-beta` (once). It also passes the client's `user-agent` and `x-app` as
  they came, so the upstream sees Claude Code's own identity (each cut to 256 characters, dropped if it holds a
  control character). The other modes drop both.
- The token stays on the host, in mm.ai. mm.ai reads it by path at each call. It never logs it, and never passes it to a
  box. Boxes still get only their own per-run keys from mm, and the box's key never goes upstream.
- Budgets, the cap and the logs work as before. Use shows in `mm usage`. Its cost there is the list price for the
  tokens: on a subscription that money is notional, but the budgets still stop calls at 100 %.
- The calls share the subscription's usage limits with the machine's own agents, which use the same token.
- If the token file is missing, calls get `503`, and the message names `claude-oauth-token`.

**Later, a separate key:** the owner fills `ai-upstream-key`, then `mm config unset ai.upstream_key_input` and
`mm config unset ai.upstream_auth`. That is the default again (an API key as `x-api-key`).

## Logs

Each call is one line in `~/.mm/pc/ai.log`: the box, the person, the model, the tokens and the cost. Refused keys are
logged with the first 6 characters of their sha256. No key is ever logged.
