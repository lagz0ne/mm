# mm.auth: the accounts and one sign-in for every board

The sign-in gateway, a machine service under mm (namespace `mm`), built on **Better Auth** (pinned, telemetry off).
The owner makes people and grants them roles on projects with `mm`; a person signs in with a single-use link that mm
prints; one session then opens every board they are granted. The gateway answers the router's forward-auth for each
board and tells the board who is asking in a way the board can verify. No password, no email, no third-party login.
Status: **built** (`src/auth.ts`; `test/auth.sh`, `test/auth-e2e.sh`, `test/box-gateway.sh`).

## People, projects, roles
- **People:** Better Auth's admin plugin. `mm user add <name>` makes one (no password); `mm user add <name> --owner`
  makes the owner (once, from the machine). Better Auth needs an email, so each person gets `<name>@users.mm.invalid`;
  mm never sends mail.
- **Projects = organizations** (the organization plugin), one per project id, made on the first grant and owned by the
  owner. **Roles** (custom, with `createAccessControl`): `designer` (a member who also edits the project's Doop),
  `member` (steers the board), `viewer` (reads). The owner is `owner` on every project without a membership.
- `mm grant <name> <project> --as designer|member|viewer` adds the member on the server, or changes the role.
  `mm revoke <name> <project>` removes it; `mm revoke <name>` removes every grant and ends their sessions.
  `mm user rm <name>` removes the person: grants, sessions, board sessions, tokens and their Claude token end at once.
  `mm user ls` shows people, owner or not, grants, sessions, tokens, and `claude_token: set|none`.
- **Names a person can't take:** the system's actors (`wake`, `watchdog`, `sentinel`, `bridge`, `mm`, `root`, …), the
  leads and `steward`/`assistant`, `owner` (except as the owner), and the owner's name (`owner_name`).
- The forward-auth reads the role from the **membership in the host's project**, never from Better Auth's "active
  organization".

## Signing in: a link that works once
- `mm user link <name>` prints a link: Better Auth's magic-link plugin, with mm capturing the URL instead of sending
  mail. It works **once** and expires after 24 h. The owner gives it to the person themselves.
- Opening it (`https://auth.<domain>/api/auth/magic-link/verify?token=…`) gives a **session on the gateway's host
  only**, then `/s/done`, the home page (below).
- **One session opens everything granted, without a cookie on the parent domain** (sy-p2i): when the person opens a
  board, forward-auth sends them to `/s?b=<board host>`. With a live session and a grant on that project, the gateway
  answers with a **302 to `https://<board host>/_mm/auth/callback?c=<one-time code>`** (single use, 30 s, bound to that
  host and that session). The board route sends `/_mm/auth/*` to the gateway, which sets **`mm_board`** on that board's
  host, then goes back to the page. The person sees one redirect, never a new link. The same works on `*.localhost`.
- The page loads no third-party script and is served with `Content-Security-Policy: default-src 'self'`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- **Every gateway page** (the code page, the link's Continue page, the home page, the short messages) is in the
  boards' Swiss style, with the same header line as a board. That CSP blocks `style=""` and `<style>`, so the pages
  carry no inline style: they link one stylesheet, `/s/app.css`, served by the gateway (same headers, but cacheable
  for an hour). Fonts: the boards' stack (`'Inter Variable', 'Helvetica Neue', Helvetica, Arial`), from the device;
  nothing is loaded from elsewhere. The only script is the code page's `/s/app.js` (same origin, so the CSP allows it).

## Home
`https://auth.<domain>/` (and `/s/done`, where a link lands) is the signed-in person's home page: one card per board
they hold a role on. No session: `/` goes to the sign-in page.
- **Which cards:** every project in the host's registry (the same host map forward-auth uses, never a project's or a
  box's `.run/`) where `roleOn` gives this person a role. The owner sees every project, the system board included. A
  project the person isn't granted never appears, not even its name. A host two projects claim has no card.
- **A card:** the project's name and its board link from the gateway's own data (the link is `/s?b=<board host>`, the
  one-redirect flow), the person's role (a viewer's card says read-only and has only a read-only view link), and the
  board's counts: open, P0, blocked, items that need a human (`needs-you`; for the owner also `t2` items with
  `signed-off` that wait for `approved`), assigned to this person, and the last activity time.
- **The counts come from each board**, `GET /api/summary`, asked for this person: one fresh assertion per board and
  page load (this person, this role, that board's host, 60 s; the forward-auth signer), sent to the board's public side
  at the address the host gave its route (`public_bind:public_port` from `resolve()`). The board checks it like any
  other request and applies its own role rules; a viewer may read it. All boards are asked at once; each gets 3 s and
  16 KB, and no redirect is followed. No cache: a revoke shows on the next load.
- **A board's answer is untrusted.** Only `{open, p0, blocked, needs_you, mine}` as whole numbers 0..1e6 and `last` as
  an ISO time (or absent); any other field or value, a non-200, a timeout or too many bytes makes that card say
  "unavailable" (logged at `warn` with the reason), and the rest of the page is unchanged. No item text ever leaves a
  board this way (titles leave only for the list below).
- **The worst signal** (one line per card): the gateway asks `GET /api/summary?signal=1`, and the board adds whole
  numbers only (`needs_you_min`, `approvals`, `queue`, `queue_min`) and one role id (`queue_role`, the role whose queue
  head waits longest). The role id must match `^[a-z][a-z0-9-]{0,30}$` and be one of that project's roles as the
  gateway reads them (`<project>/leads/roles.json`, inside the project's folder only, plus `setup`); anything else
  makes the card "unavailable". The gateway writes the line itself ("review queue 3, oldest 40 min", "needs you 2
  (1 approval), oldest 3 h", "nothing waiting"). It is red only when the board needs the person: `needs-you` items or
  an approval wait. A board without the signal (an older template) gets no line, or only "needs you n".
- **"Waiting for you"** (the first thing on the page): the items that wait on this person, from every board they hold
  a role on, oldest first: the ask, the title, the board, the id and the age. Each board is asked `GET /api/waiting`
  the same way as the counts (this person's own fresh assertion, 3 s, no redirect, no cache) with 32 KB. The board
  answers by the person in the assertion: the **owner** gets the `needs-you` items and the `t2` items with
  `signed-off` and no `approved`; a **designer, member or viewer** gets only the open items assigned to their own name
  (`needs-you` means the owner, so a member never gets the owner's asks). Each entry is `{id, title, age_min,
  labels}`, with only the labels the ask needs; what doesn't fit in 32 KB is counted in `more`.
  - **Checked by the gateway:** the answer has only `items` and `more`, else that board's list is dropped (a note
    names the board). Each item: an id of the boards' pattern (`^[a-z]+-[a-z0-9]+(\.[0-9]+)*$`, at most 64), a title
    of 1..200 characters with no control, line-separator or bidi characters, `age_min` a whole number, labels only from
    `needs-you`, `t2`, `signed-off`, and no other field; anything else drops that item.
  - **The ask is the gateway's:** for the owner "approve (t2, signed off)" (t2 and signed-off) or "needs you"
    (needs-you), both red, and an item with neither is dropped; for anyone else "assigned to you". **The link is the
    gateway's:** `/s?b=<board host>&r=/?item=<id>` (the one-redirect flow, then the board opens that item), from the
    host's registry and the checked id, never from board text. Everything is escaped.
  - A board on an older template has no such answer (404, or 403 from its proxy): it adds nothing, and that is no
    error. With no list from any board there is no section at all.
- **The page** is made on the server, has no script, escapes every value, and carries the gateway's headers
  (`Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`, `no-store`, `no-referrer`, `nosniff`); its
  stylesheet is `/s/app.css` (below).

## Your Claude token (each person's own)
Every person can set their **own long-term Claude token**, so the work mm runs for them runs on their own Claude
subscription, never on the owner's (sy-8n4w).
- **Setting it:** `https://auth.<domain>/s/token`, "Your Claude token" (linked from the home page), signed in. The
  person pastes the token that `claude setup-token` made on their own computer, and presses Save. The same page
  replaces it (paste a new one) and removes it. It is on the gateway's own host only (no new public route; on a board
  host it is 404). Not signed in: the page sends you to sign in; a POST is refused.
- **Only your own:** the person is the session's, never a name in the form, so nobody sets or removes another
  person's token. The form's POST passes only from the page itself (the same CSRF rule as the link's Continue page:
  a foreign `Origin` is refused; with `Sec-Fetch-Site` only `same-origin` passes). 10 changes per 10 minutes, 4 KB.
  The page has the gateway's headers (CSP `default-src 'self'`, `no-store`, `no-referrer`) and no script.
- **The owner,** in their own terminal: `mm user claude-token` (it asks with no echo, or reads a pipe; never an
  argument), `mm user claude-token --remove`. It sets the owner's account only, and refuses in an agent's shell.
- **Kept sealed:** in the vault as `claude_token.<person>` (`$MM_HOME/vault/`, sealed to the machine key and the
  recovery key, like every vault value; `mm sync` carries it sealed). One per person. mm checks its shape lightly
  (`sk-ant-oat01-...`) and never repeats what was pasted. It is never shown again, never logged (the log says who set,
  replaced or removed one, and from where), and the owner hears each change on Telegram. `mm user ls` shows
  `claude_token: set|none` only. `mm user rm` removes it with the account.
- **Out of every agent's reach:** the vault folder and the opened-secrets folder are in every role's and setup's fixed
  denies (Read, Edit, Bash in any spelling), and so are `claude_token.*`, `mm run-as`, `mm user claude-token` and
  `bin/lead start ... --as`.
- **Using it:** `mm run-as <person> <project> <role>` (the owner's step, or mm's; refused in an agent's shell) starts
  that role's lead for that person. mm checks the person's role on the project (owner, designer or member; a viewer
  has no runs; grants that can't be read refuse), opens their token from the vault into the noswap secrets tmpfs
  (`<secrets>/_run/`, a new file for this run, removed as soon as the run holds it), and gives it to
  `bin/lead start <role> --as <person>` on its stdin. bin/lead makes the run through Paseo's own client library, so
  the token goes into that run's environment only, as `CLAUDE_CODE_OAUTH_TOKEN`, in the unmodified Claude Code binary.
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are empty for it (nothing else signs its calls,
  and its token goes to the model's own API only), `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps it out of the shells and
  hooks the run starts, and the run is labelled `person=<name>`. Like every lead, it is that role's one lead.
- **No token, no run:** a person without one gets "set your Claude token on the home page", and nothing starts. The
  owner's token is never used for anyone else. The owner without a personal token runs on the machine's own token
  (which is the owner's), as every lead does.
- **In a box:** the token goes over `docker exec -i`'s stdin to bin/lead in the box; it never enters a box's files.
  The run calls the model's own API, not mm.ai, so the box's egress list must have `api.anthropic.com`; without it,
  `mm run-as` refuses (the owner decides: that way skips mm.ai's check of server-side tools).
- **The terms:** this follows Anthropic's "an end user signing in to the unmodified Claude Code binary with their own
  Claude subscription, including where a platform hosts Claude Code". The owner reads the terms
  (code.claude.com/docs/en/legal-and-compliance) and decides; this note is not legal advice.

## Hosts and cookies
- The session cookie (Better Auth's, `__Secure-` prefixed) is **host-only** on `auth.<domain>`, `HttpOnly; Secure`,
  12 h. It is never sent to a board or an app.
- Each board has its **own host-only cookie** (`mm_board`): bound to that host, `SameSite=Strict`, never longer than
  the session it came from, and **alive only while that session lives**: sign-out, `mm revoke <name>` or
  `mm user rm` ends it on the next request. A board cookie on another host is refused.
- Product apps and boards never share a cookie. A separate suffix for boards (`*.b.<domain>`) is still recommended, so
  product code is never same-site with a board; that is the machine's routing and DNS.

## Board routes: the gateway or the shared password
- A service with `public.auth: required` (a board) gets its route from the machine's route tool. While the gateway is
  off, `mm up` writes it with the shared password (`expose --auth`, `[auth]` in `expose ls`). Once the machine turns
  the gateway on (`auth.enabled`), `mm up` and `mm update` write it with `expose --sso` (forward-auth to the gateway,
  `[sso]`), and rewrite an `[auth]` route they find. Turning the gateway off writes the password back on the next
  `mm up` (the rollback). A route that is right already is left alone; an open route (`auth: none`) gets neither.

## Tools: bearer tokens
- `mm token <name> <project> [--days n]` prints a token (`mmt_…`, shown once, stored as a hash), bound to **one
  project**, 30 days by default, at most 365. `/verify` takes `Authorization: Bearer <token>` and gives the same
  assertion as a browser; on another project's host it answers 401. A revoke of that project, `mm revoke <name>` and
  `mm user rm` end the person's tokens there.

## What the board trusts (unchanged)
- The router strips every client `X-Board-*` and `X-Mm-Assertion` header before forward-auth, and drops the `Cookie`
  header on the way upstream, so the board never sees `mm_board` or the session.
- On every allowed request, forward-auth returns `X-Mm-Assertion`, an **Ed25519 signature** over
  `{user, role, board host, exp (now + 60 s), nonce}`, plus `X-Board-User` and `X-Board-Role`. All three are **always
  set** (`-` when refused, so a client's copy can't pass).
- The board verifies the assertion on every request: the signature with the gateway's public key (written by mm into
  `.run/endpoints.json`, made once even if a board starts before the gateway), its own host, a future `exp`. It never
  trusts bare headers.

## Members: steering together, with rails (unchanged)
Members steer like the owner on their projects: create and prioritise items, assign, comment, close, reopen. The rails,
enforced by the board's API from the assertion's role:
- Only `owner` adds or removes `approved` (the T2 go) and the tiers `t1`/`t2`/`t3`; only the leads change `signed-off`
  and `audit`. A designer is a member here.
- The board stamps the author's role on every item (`by:<role>`) and comment.
- Viewers are read-only: the board refuses every non-GET for a viewer assertion.

## The store, and who may write it
- `$MM_HOME/auth/`: 0700; `accounts.db` (Better Auth's tables, plus mm's `mm_token` and `mm_board_session`), `secret`
  (Better Auth's), `signing.key`, all 0600. Only the gateway process writes them.
- `mm user|grant|revoke|token` talk to the gateway over a unix socket (`$MM_HOME/run/auth.sock`, 0600).
- **Residual risk, stated plainly:** agents run as the same Unix user as the gateway (until the project boxes,
  sy-b15). File modes and a socket can't keep an agent of that user out; they make it an act a deny rule and the guard
  refuse (`$MM_HOME/auth/**` in every lead's denies and in the guard's secret paths). In a box, the agents are a
  different user on a different network, and the gateway stays on the host.

## Logging
Every link made, sign-in by link, refusal, grant, revoke, token and board session is logged at `info` (refusals at
`warn`). The logs carry no link token, token, cookie or session id, only the first 6 hex digits of their sha256.
