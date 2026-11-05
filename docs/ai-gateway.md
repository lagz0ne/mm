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

## Turning it on (ops, t2)

1. The owner fills the upstream key: `mm fill ai-upstream-key`. This is an Anthropic API key, or the key of an
   Anthropic-compatible gateway. For the second kind, also set `ai.upstream` (its URL), and `ai.upstream_auth: bearer`
   if it wants `Authorization: Bearer`.
2. `mm config set ai.enabled true`. The next `mm up` of any project reloads the machine's process file, and that starts
   `mm.ai`. `mm up` for each box then gives it a key.
3. The guard and the template keep agents out of `$MM_HOME/ai/` and the upstream key file (sy-sn0).

## Logs

Each call is one line in `~/.mm/pc/ai.log`: the box, the person, the model, the tokens and the cost. Refused keys are
logged with the first 6 characters of their sha256. No key is ever logged.
