# mm.auth: one sign-in for every board

Design for the sign-in gateway (a machine service under mm, namespace `mm`). Identity comes from the owner's chat bot:
a code shown on the sign-in page is approved there; the gateway turns that approval into a session, answers the router's forward-auth for each board, and tells
the board who is asking in a way the board can verify. Status: **design, for review before it is built.**

## Hosts and cookies
- The gateway has its **own host**, `auth.<domain>`. Its session cookie (`mm_auth`) is **host-only** (no `Domain=`),
  `HttpOnly; Secure; SameSite=Lax; Path=/`, 12 h. It is never sent to a board or an app.
- Each board gets its **own host-only cookie** (`mm_board`), bound to that board's host, `SameSite=Strict`, 12 h at
  most and never longer than the `mm_auth` session it came from. A board cookie presented on another host is refused.
- Product apps and boards never share a cookie, whatever the domain layout. A separate suffix for boards
  (`*.b.<domain>`) is still recommended, because it keeps product code from ever being same-site with a board. That
  choice is the machine's routing and DNS, not the gateway's.

## Sign-in flow: a code on the screen, approved over Telegram
No token in a link, no password. The code grants nothing by itself; only an approval in the chat does.
1. A visitor without a session reaches `https://auth.<domain>/s?b=<board host>` (forward-auth sends them there). The
   page creates a **pending sign-in**: a random id (32 bytes) in a host-only cookie on the auth host (`mm_pending`,
   HttpOnly, Secure, SameSite=Lax, 5 min), and an **8-character code** shown on the screen, `XXXX-XXXX` from an
   alphabet without look-alikes (Crockford base32: no 0/O, 1/I/L, U). The code is stored hashed, bound to that pending
   id (so to that browser), single use, and lives 5 min. The page loads no third-party script and is served with
   `Content-Security-Policy: default-src 'self'`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
2. The page waits: it asks the gateway every 2 s, with its `mm_pending` cookie, whether the code was approved.
3. **Approval** comes over the gateway's local socket from the bot, in one of two ways:
   - **self:** a granted person sends the code to the bot. Before approving, the bot shows what is asking, "Sign in
     to <board> on <browser, OS, approximate place, time>? [This is me] [No]", and approves only on the tap. That is
     the defence against code phishing (someone sending you *their* code to approve): never approve on paste alone.
     Identity = the sender's Telegram account; scope = their grants.
   - **by the owner:** `/approve <code> as <name> for <scope> <duration>` from the owner's Telegram id. That grants a
     named guest on the spot (even someone without Telegram) and approves this one code. The name follows the
     member naming rules below; the grant is recorded like any other (and revocable).
4. The gateway **burns the code atomically**: lookup by sha256(code), constant-time compare of the stored hash, and
   delete in the same step of the single-writer store, so two approvals of one code can't both win. Then the waiting
   page's next poll turns its pending id into a **session**: a new session id (rotated, never the pending id), and the
   `mm_auth` cookie (host-only, see above). The pending cookie is deleted.
5. **Limits:** codes are 40 bits and live 5 min; the gateway allows at most 5 wrong codes per Telegram id per 10 min
   and 100 per hour in all, and logs each refusal. A pending sign-in that isn't approved in 5 min is gone; the page
   offers a new code.
6. **Then each board** (unchanged): a **302 to `https://<board host>/_mm/auth/callback?c=<one-time code>`**, single
   use, 30 s, bound to that board host and that session. The board route sends `/_mm/auth/*` to the gateway, which
   burns it and sets `mm_board` on the board host, then redirects to `/`. Later visits with a live `mm_auth` repeat
   this step at once; a tap on a chat link is cross-site, so `mm_board` (Strict) is not sent but `mm_auth` (Lax) is:
   one redirect hop, no new code.

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
- **`all`:** the system board and every project, now and later (the owner's decision). When the owner confirms an
  `all` grant, the bot lists every board it covers at that moment, client projects included. The gateway's socket API
  returns that list. The gateway also records the explicit list at each moment, so the audit can say who could steer
  which board when.

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
- Code: single use under two concurrent approvals, expiry, bound to its browser (another browser's poll gets
  nothing), the wrong-code limits, headers on the sign-in page; an owner approval creates a named grant; the bot
  refuses to approve without the "This is me" tap.
- Board trust: a request straight to a board port with forged `X-Board-*` and no assertion gets the sign-in page; a
  valid assertion for another board is refused; an expired one is refused; a viewer's POST is refused.
- Cookies: host-only attributes; `mm_board` replayed on another board host is refused; revoke takes effect on the next
  request.
- Store: modes 0700/0600; the store is rejected if its modes are wider.
