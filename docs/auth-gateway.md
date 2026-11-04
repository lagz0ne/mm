# mm.auth: one sign-in for every board

Design for the sign-in gateway (a machine service under mm, namespace `mm`). Identity comes from the owner's chat bot
(one-time links); the gateway turns a link into a session, answers the router's forward-auth for each board, and tells
the board who is asking in a way the board can verify. Status: **design, for review before it is built.**

## Hosts and cookies
- The gateway has its **own host**, `auth.<domain>`. Its session cookie (`mm_auth`) is **host-only** (no `Domain=`),
  `HttpOnly; Secure; SameSite=Lax; Path=/`, 12 h. It is never sent to a board or an app.
- Each board gets its **own host-only cookie** (`mm_board`), bound to that board's host, `SameSite=Strict`, 12 h at
  most and never longer than the `mm_auth` session it came from. A board cookie presented on another host is refused.
- Product apps and boards never share a cookie, whatever the domain layout. A separate suffix for boards
  (`*.b.<domain>`) is still recommended, because it keeps product code from ever being same-site with a board. That
  choice is the machine's routing and DNS, not the gateway's.

## Sign-in flow
1. The bot (owner or granted person) asks the gateway, over its local socket, for a one-time token bound to their id
   and boards. It sends `https://auth.<domain>/#t=<token>&b=<board host>`.
2. The sign-in page reads the fragment **first** and calls `history.replaceState` to drop it. It loads no third-party
   script and is served with `Content-Security-Policy: default-src 'self'; script-src 'self'`,
   `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. It POSTs the token in the body.
3. The gateway **burns the token atomically**: lookup by sha256(token), with a constant-time compare of the stored hash
   and delete in the same step of a single-writer store. Two posts of one token can't both win. It is valid for 5 min.
   On success it rotates the session id and sets `mm_auth`.
4. For each board, it sends a **302 to `https://<board host>/_mm/auth/callback?c=<code>`**. The code is single-use,
   30 s, and bound to that board host and that session. The board route sends `/_mm/auth/*` to the gateway, which
   burns the code and sets `mm_board` on the board host. It then redirects to `/`.
5. Later visits: if a board request has no or a stale `mm_board`, the gateway's forward-auth answers 302 to
   `auth.<domain>/s?b=<host>`. With a live `mm_auth` that is immediate (step 4 again, no new link); without one, the
   page says "ask the bot for /ui". A tap on a link in the chat app is cross-site, so `mm_board` (Strict) is not sent,
   but `mm_auth` (Lax) is: one redirect hop, no new sign-in.

## What the board trusts
- The router strips every client `X-Board-*` and `X-Mm-Assertion` header **before** forward-auth (a headers middleware
  in front of forward-auth on every board route). It also drops the `Cookie` header on the way upstream, so the board
  never sees `mm_board` or `mm_auth`.
- On every allowed request, forward-auth returns `X-Mm-Assertion`, an **Ed25519 signature** over
  `{user, role, board host, exp (now + 60 s), nonce}`, plus `X-Board-User` and `X-Board-Role` for convenience. All
  three are **always set**: empty when not allowed, and then the gateway answers 401/302 anyway.
- The board verifies the assertion on **every** request: signature with the gateway's public key (written by mm into
  the board's `.run/endpoints.json`), board host equal to its own, exp in the future. Without a valid one it serves
  only a static "sign in through the bot" page. It never trusts bare headers, whoever reaches its port (containers on
  the bridge network, local processes).
- The signing key: `auth/signing.key` (0600, gateway-only), sealed into the vault once the vault exists, so a restore
  keeps it. Rotating it invalidates every board session.

## Members: steering together, with two rails
A grant is **focus**: which boards someone sees and steers. `member` is the default everywhere, including the system
board; `viewer` is optional, for people who only watch. Members steer like the owner in their focus: they create and
prioritise items, assign, comment, answer the leads, close or accept work, and reopen. The leads treat them as humans
of that board. Two rails stay, enforced by the board's API from the verified assertion's role (never by the UI alone):
- **T2 approvals are the owner's.** Only `owner` may add or remove `approved` (the owner's go). Nobody but the owner and
  the leads may change the risk-tier labels `t1`, `t2`, `t3` (a lower tier would route around an approval), and only
  the leads may change `signed-off` (review's) and `audit`. The board answers 403 with the reason.
- **No agent sessions through the bot:** the bot acts only through boards (items and comments), never through Paseo.
- **Author role on every write:** the board stamps the assertion's role on each item and comment it creates (a
  `by:<role>` label on items, and a `role` field on comments). Leads see it in `bd show`, and the template's lead brief
  says to read it.
- **Names:** the gateway derives a member's name from the grant (e.g. the chat display name, lower-cased, made
  unique). It refuses any name that equals a role of any board on the machine, a system author (`wake`, `watchdog`,
  `brain`, `ui`, `beads`, `smoke`, `system`, `admin`, `setup`) or the owner's name. The board refuses a self-chosen
  name when the gateway is on: identity only comes from the assertion.
- **`all`:** the system board and every project, now and later (the owner's decision). The gateway still records the
  explicit list it covers at each moment, so the audit can say who could steer which board when.

## Sessions and revocation
- Server-side only: a session is a random id → `{user, scope, created, expires, boards}`. Forward-auth checks it on
  every call, with no cache and no stateless token, so a revoke takes effect on the next request.
- Revoking a grant deletes that person's sessions; `/revoke all` deletes every session but the owner's current one.
- Roles: `owner` (one Telegram id, from the machine's inputs), `member` (the default for a grant), `viewer`. Viewers
  are read-only on the board: it refuses every non-GET for a viewer assertion.

## The store, and who may write it
- `$MM_HOME/auth/`: 0700; `grants.json`, `sessions.json`, `signing.key`, all 0600. Only the gateway process writes
  them (single writer, atomic rename), and nothing else is supposed to write there.
- The bot talks to the gateway over a unix socket (`$MM_HOME/auth/gateway.sock`, 0600) with a small API: mint a
  sign-in token, create or spend an invite, list or revoke grants and sessions. Every call is logged with the caller's
  pid and exe (SO_PEERCRED).
- **Residual risk, stated plainly:** agents run as the same Unix user as the gateway and the bot. File modes and a
  socket cannot keep an agent of that user out; they only make it an act a deny rule and the guard can refuse
  (`$MM_HOME/auth/**` read and write in every lead's denies and in the guard's secret paths). Real separation needs the
  gateway (and the bot) to run as their own user. That is a machine change for ops (t2), and it is recommended before
  anyone but the owner gets a grant.

## Logging
Every token mint, sign-in, code burn, refusal (with its reason), grant, revoke and socket call is logged at `info`, or
at `warn` for refusals. The logs carry no token, code, cookie or session id, only their first 6 hex digits of sha256.
They are shipped to the logs store; review audits them.

## Tests (before any route uses it)
- Token: single use under two concurrent posts, expiry, wrong board, fragment removed (history), headers on the
  sign-in page.
- Board trust: a request straight to a board port with forged `X-Board-*` and no assertion gets the sign-in page; a
  valid assertion for another board is refused; an expired one is refused; a viewer's POST is refused.
- Cookies: host-only attributes; `mm_board` replayed on another board host is refused; revoke takes effect on the next
  request.
- Store: modes 0700/0600; the store is rejected if its modes are wider.
