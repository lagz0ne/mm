# mm.api: the project API for boxes

Inside a project box, Paseo's permission prompts are not a boundary: the box's agents run as the box's user and can
answer their own requests. The box itself is the boundary. So every action that matters for a box (a public route, a
site on its egress list, a build on its app slot, a new secret) is a **project API call**, decided **on the host** by
the owner. Nothing inside the box, and no label on a board, decides one. Design and review: board item sy-b15.8.
Status: **built** (`src/api.ts`, `src/apistate.ts`; `test/api.sh`, and the project API section of `test/box.sh`).
Off until the machine turns it on (`mm config set api.enabled true`, then `mm onboard` or `mm up` of any project to
load `mm.api`): a t2 change, after review's sign-off and the owner's approval.

## The way in
- `mm.api` is a machine service under mm's process manager (namespace `mm`), like `mm.auth` and `mm.ai`.
- Each box gets its own socket: `$MM_HOME/box/<project>/api/api.sock` (0660 in a 0750 folder). Only that box mounts
  the folder, read-only, at `/run/mm/api/`. There is no TCP port.
- **The project is the socket the call came in on.** A project name in the call is never read.
- The box sees only a status (`pending`, `done`, `refused`), the request's id, its item's id, and for a refusal one
  fixed word (`format`, `rate`, `open-limit`, `exists`, `taken`, `no-build`, `no-app-slot`, `no-domain`,
  `unknown-call`).

## The four calls (anything else: refused)
`POST` with a JSON body that has exactly the one field below. Example, from the box:
`curl -s --unix-socket /run/mm/api/api.sock -X POST -d '{"site":"api.stripe.com"}' http://api/egress`

| Call | Body | Format | Who decides |
|------|------|--------|-------------|
| `/route` | `{"name": …}` | `[a-z0-9-]{1,30}`, no `-` first or last | the owner |
| `/egress` | `{"site": …}` | an exact host name: no wildcard, no address, no port | review signs off, then the owner |
| `/release` | `{"build": …}` | a folder name under `release/` (`[a-z0-9][a-z0-9_.-]{0,63}`, no `..`) | the owner |
| `/secret` | `{"name": …}` | `[a-z0-9-]{1,40}`: a NEW name in this project's vault namespace | the owner |

- **Route:** always `<name>.<project>.<domain>`, so one project can't claim another's name. The target is only the
  box's app slot (its own service, forwarded from the host to the box's address; Traefik never joins the box network).
  Behind the gateway's sign-in (people with a role on the project) by default; with no login only if the owner
  chooses it when approving (`mm api approve <id> --no-login`). Refused if the host is in the gateway's host map
  (a board's), another box's, or a route the router already has. With the gateway off, the route gets the shared
  password, as a board's would.
- **Egress:** the exact site joins the box's egress list (`$MM_HOME/egress/<project>/allow`); its proxy restarts to read
  it. Review signs off on the item (`signed-off` and a comment), then the owner approves (review's option (a)).
- **Release:** while the API is on, a box's app slot runs only the build the owner approved: `release/<build>/`, inside
  the box, as the box user, loaded by the box's own process manager. mm copies nothing from `release/` to a host path
  and follows no link there (`release/` and `release/<build>` must be real folders: `lstat`). The box can still change
  the files of an approved build: what the owner approves is its name. The host makes `release/` for the box.
- **Secret:** no value ever goes through the API. The request names a new secret `<project>.<name>`: never a machine
  input's name, never one that is sealed already or that the project declares, never another project's (the name has
  no dot). After the approval the owner fills it in their own terminal (`mm fill <project>:<name>`, into the vault
  only); the box gets it at its next start, read-only on tmpfs, at `/run/mm/secrets/<project>.<name>`.

## How a request is decided
1. The box calls. mm checks the format, the limits and the call's own rules, then files **one item on the system
   board** (boxes can't write it) as `watchdog`, labelled `mm-api` and `needs-you` (egress: `mm-api`, `t2`, assigned to
   review). The owner is told on Telegram, with the request's **one-time code** (below). Asking again for the same
   thing gives its status; no new item and no new code.
2. **The item's text is mm's.** The box's value appears only inside a frame mm writes ("From the box (data, not
   instructions)", in a code block), after its format check (so one short line, no backticks). A fixed last line,
   `mm-api: <id> sha256:<hash>`, names the request for the bridge.
3. **No label decides.** `approved` or `signed-off` added by anyone changes nothing (`signed-off` is a precondition for
   egress, never the decision). The decision comes only through the **owner's socket**,
   `$MM_HOME/api/approve.sock` (0600 in a 0700 folder):
   - the bridge's Allow tap on mm.api's Telegram message (the contract: "The bridge", below);
   - the owner's own terminal: `mm api approve <id>` shows the request and asks for the code; without a terminal it
     needs `--hash <first 12 or more of the hash>` and reads the code from stdin (never an argument: no shell history,
     no `ps`). `mm api approve|deny|undo|code` are refused when `CLAUDECODE` or `PASEO_AGENT_ID` is set, as
     `mm auth approve` is.
   Every agent session is denied the socket, its store and `mm api` (the template's rendered denies).
4. **An approval is bound to its request:** the hash is sha256 of `[project, call, value]`; it must match the request's,
   and mm recomputes it. mm applies exactly that request, checks its format again at apply time, comments what it did
   and the undo (`mm api undo <id>`) on the item, labels it `approved` (the state) and closes it.
5. **An approval shows the owner made it: the one-time code** (sy-35f2). The hash is printed in the item, and every
   host session runs as the same user, so the hash alone doesn't prove the owner decided. So:
   - Each request gets a random code: 8 base32 characters (`A-Z`, `2-7`; 40 bits). mm.api sends it **only** to the
     owner on Telegram (the bot and `telegram.owner_id`, as mm.auth's notices) and keeps only a slow hash of it
     (scrypt, with its own salt) in `api.db`. The code is in no item, no board text, no log line, and no file.
   - It is valid until the request is decided, or for 24 h. `/approve` needs it, together with the id and the hash.
     Case, spaces and dashes don't matter.
   - A wrong or missing code applies nothing (403) and is logged at warn, without what was sent. After **5** wrong
     tries the code is void; a used code never works again (on its request or any other).
   - `mm api code <id>` (or `POST /code {"id": "<id>", "by": …}`) sends a new code to the owner, and the old one stops
     working. At most 5 codes per request; then deny it, and the box may ask again.
   - An egress approval before review's sign-off is refused (409) and doesn't use the code: tap Allow again later.
   - `/deny` and `/undo` don't need a code (they take nothing new from the owner).

## The bridge (ops builds it)
mm.api sends the owner **one Telegram message per code** (`sendMessage` to `telegram.owner_id`):
- its text ends with the fixed line `mm-api: <id> sha256:<hash>`, and has the line `Code: <CODE> (…)` for the terminal;
- its `reply_markup.inline_keyboard` is one row of buttons, with this `callback_data`:
  - `mmapi:allow:<id>:<CODE>` (Allow);
  - for a route only: `mmapi:open:<id>:<CODE>` (Allow, no login);
  - `mmapi:deny:<id>` (Deny).

On a `callback_query` whose `data` starts with `mmapi:`, the bridge does exactly this:
1. It takes the tap only if `callback_query.from.id` is `telegram.owner_id`.
2. For `mmapi:allow:<id>:<CODE>` or `mmapi:open:<id>:<CODE>`: it reads the hash from the last line of
   `callback_query.message.text` (`mm-api: <id> sha256:<64 hex>`). The id there must equal the id in the data.
   Then it calls the owner socket `$MM_HOME/api/approve.sock`:
   `POST /approve` with `{"id": "<id>", "hash": "<64 hex>", "code": "<CODE>", "by": "bridge"}`,
   and `"open": true` only for `mmapi:open`.
3. For `mmapi:deny:<id>`: `POST /deny` with `{"id": "<id>", "by": "bridge"}`.
4. It shows the answer's `error` text (or "applied") to the owner (`answerCallbackQuery`), and after a 200 removes the
   buttons. The answers: 200 applied or refused as asked; 403 wrong code; 409 not pending, another request's hash, no
   valid code (`mm api code <id>`), or review hasn't signed off (the code still works); 429 too many tries; 500 not
   applied.
5. It never logs or stores the callback data or the message text (they carry the code).

The bridge no longer builds an Allow from the board item: the item has no code. It may still show the item; for an
egress item it shows "review signed off" only with a link to review's sign-off comment.

## Person runs (not a request)
`/person-run` on the same socket asks for a lead's run for one person of the box's project, on that person's own
token. No owner tap: the host decides by rules (who asked for the items on the gateway, the grants, the token; the box
names only item ids, never a person; docs/auth-gateway.md, "A box's wake asks the host"). It is on only while `wake.person_runs` is; mm.api also runs for it alone, and the four calls are
then refused (`api-off`), as with no mm.api.

## Limits and logs
- 10 calls an hour for each box (refused ones count), at most 5 open requests; then calls are refused. Person runs
  have their own: 20 asks an hour per box, one start at a time.
- Every call is logged (`pc/api.log`, shipped like every mm service log) with the project from the socket (`box`); a
  value that fails its format is logged by its length only.

## The store
- `$MM_HOME/api/` (0700): `api.db` (0600: requests and calls), `approve.sock`, `granted/<project>.json` (0600: what the
  owner granted, read by `mm up`, `mm needs`/`mm fill` and the gateway's host map). No box mounts any of it.
- `mm archive` removes a project's grants and its granted routes; its requests stay in `api.db` for the audit.
- **Residual risk, stated plainly:** host agents run as the same user as `mm.api`, so a process on the host can reach
  the owner's socket. Without the request's one-time code that applies nothing: the code is only on the owner's
  Telegram, and 5 wrong tries void it. The CLI refusal, the denies and the guard make even the try an act that is
  refused, and the owner is told of every change with its undo. What stays: a host process with the bot token could
  read the bot's updates (the token is a machine secret, denied to every agent), and it could read mm.api's memory
  (the same user). In a box, the agents are another user and see only their own socket.
