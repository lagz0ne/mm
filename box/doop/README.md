# The mm fork of Doop: one sign-in with the boards (sy-3yz)

Each project's Doop (the design canvas, `mm doop on <project>`) sits behind mm's sign-in gateway, on its own public
host (`doop.<project>.<domain>` under `names: project`, `doop-<name>-<client>.<domain>` under `legacy`). A person who
is signed in to the boards opens it with no second login. Doop is AGPL, so this change is a published fork.

- `0001-gateway-assertion.patch`: the change, against Doop 0.12.0 (the source in the pinned image
  `sha256:4062eea5…`). It applies with `git am` (or `git apply`).
- `0002-source-link.patch` (sy-9a30, on top of 0001: tag `v0.12.0-mm.2`): every HTML page of the gateway side gets a
  small "Source" link (bottom left), to `DOOP_SOURCE_URL`, the fork's source at its tag (the AGPL's section 13). mm
  makes it from `doop.source` in its config (the fork's repository, `https://…`; `{tag}` in it is the tag, else
  `/tree/<tag>` is added) and its pin `DOOP_TAG` (`src/project.ts`), and `bin/doop-run` passes it with
  `DOOP_SOURCE_TAG`. No `doop.source`: the link goes to `/.mm-source/<tag>` on the gateway side, a page that names the
  tag, upstream's version and these patches (no account is named anywhere in mm). The loopback side is unchanged.
- `Dockerfile`, `build.sh`: the fork as an image, built on the pinned image (only `server/` and `shared/` change).
- `test/doop-gateway.sh` (in mm): the proof, in throwaway containers.

## What the patch does (Doop's side)
- **The assertion.** mm's gateway answers the web proxy's forward-auth for Doop's host like for a board. On each
  request it lets through, it adds `X-Mm-Assertion`: `base64url(JSON {u, r, h, exp, n})` `.` an Ed25519 signature of
  that first part (mm `src/auth.ts`, `signAssertion`). `u` is the person, `r` their role on the project, `h` the host,
  `exp` now + 60 s (ms), `n` a nonce.
- **A second listener.** With the gateway's public key set, Doop opens `MM_GATEWAY_PORT` (4401) for its public host.
  Every request and every WebSocket upgrade there needs a valid assertion: the signature with the gateway's key,
  `h` = `MM_GATEWAY_HOST`, a future `exp`, a known role, a gateway name. Anything else is 401.
- **The person.** Their Doop account is made on their first visit (`<name>@gateway.mm.invalid`, tied by an
  `mm-gateway` account row, never by email; Doop's own sign-up refuses that domain). The request runs as a session of
  that account that the server holds. Doop drops the client's own `Cookie` and `Authorization`, and sends no
  `Set-Cookie`. So the browser never holds a Doop session, and nothing works without the gateway.
- **Doop's own login is off there:** every `/api/auth/*` route except `GET /api/auth/get-session`, and
  `/api/account-exists`, are 403 (the path is read decoded, lower case, with `//` and `..` resolved).
- **The roles** (as mm's roles say, `src/auth.ts` `ORG_ROLES`, doop: read or edit):
  - `owner` and `designer`: edit every canvas of this Doop (the design lead's too), and make new ones;
  - `member` and `viewer`: look only. Only GET and HEAD pass, and every canvas is `view`, even with a share link.
  - A role changes with the next assertion. An open room of someone with no assertion for 10 minutes closes; its
    reconnect asks the gateway again.
- **The rest is unchanged.** Doop's own listener (`PORT`, 4400: the loopback side) keeps its own login, the design
  lead's account and agent key, and the MCP. Without a gateway key there is no second listener: Doop is as before.

Its settings (environment):

| Name | What |
|---|---|
| `MM_GATEWAY_PUBLIC_KEY_FILE` | the gateway's public key (PEM, Ed25519); or `MM_GATEWAY_PUBLIC_KEY` with the PEM itself |
| `MM_GATEWAY_HOST` | Doop's public host, the one the assertions name (required with a key) |
| `MM_GATEWAY_PORT` | the gateway listener (default 4401) |
| `DOOP_SOURCE_TAG`, `DOOP_SOURCE_URL` | the fork's tag, and its source at that tag (the "Source" link; 0002) |

A key without a host, or a host without a key, stops Doop at boot.

## mm's side
- `template/services.yaml`: `doop` has `public: { name: "doop-{{name}}-{{client}}", auth: required }`. mm writes its
  route with `expose --sso` (forward-auth to the gateway), as for a board; the gateway maps the host to the project.
- `src/project.ts`: a gated service gets its own public listener port in an env var: `BOARD_PUBLIC_PORT` (the board)
  or `DOOP_PUBLIC_PORT` (Doop). A Doop whose `bin/doop-run` has no public side gets no public name at all (its own
  login is never on a public port). `mm doop off` removes its route.
- `template/bin/doop-run`: with `DOOP_PUBLIC_PORT` and the gateway's key in `.run/endpoints.json`, it writes the key to
  `.run/doop-gateway.pem`, mounts it read-only at `/run/mm-gateway.pem`, gives Doop the three settings, and forwards
  `127.0.0.1:$DOOP_PUBLIC_PORT` to the container's 4401. No key or no public name: no public side.
- `src/auth.ts`: the home page's card for a project is its board's host, never its Doop's.

## Build (a throwaway image, or ops' own)
    box/doop/build.sh mm-doop:<version> [mm-doop:0.12.0]
Through mm's Docker wrapper (`DOCKER`, default `sudo -n /usr/local/libexec/mm-docker`; docs/mm-docker.md). It checks
that the base is the pinned image (by id), copies `server/`, `shared/` and `package.json` out of a stopped container
(labelled, no mounts, as a tar stream), applies the patch with `git apply`, builds `Dockerfile` on the base, and
prints the new image's id. Nothing is pulled or pushed.

## Publish (ops, t2: the owner's approval through the bridge)
1. **The repo:** a public fork of upstream Doop, on the owner's GitHub account. Its branch `mm/gateway-assertion`
   starts at upstream's 0.12.0 (check: its `server/` and `shared/` are the pinned image's, `diff -r` is empty).
2. **The commit:** `git am box/doop/0001-gateway-assertion.patch` on that branch; add this README's "What the patch
   does" to the fork's README (the AGPL's notice of the change), keep upstream's LICENSE.
3. **The tag:** `v0.12.0-mm.1` on that commit; push the branch and the tag. Each later patch is one more commit
   (`git am box/doop/0002-source-link.patch`) and the next tag (`v0.12.0-mm.2`), the value of `DOOP_TAG` in
   `src/project.ts`; then `mm config set doop.source https://<the fork's repository>` on the machine.
4. **The image:** `box/doop/build.sh mm-doop:0.12.0-mm.1` (the same server code as the tag, on the pinned image); or
   upstream's own Dockerfile at the tag. Then `MM_DOOP_GW_IMAGE=<its id> test/doop-gateway.sh` must pass. If it goes
   to a registry, its digest is `<registry>/doop@sha256:<64 hex>`.
5. **The pin:** `mm config set doop.image <the id or digest>` on the machine; the TODO in `manifest.yaml` gets the
   digest once mm pins it there.
6. **Each project with Doop on:** `mm update <project>` (services.yaml, bin/doop-run), then `mm up <project>`: the
   route (`[sso]`), and Doop starts again on the fork's image. Its public name needs DNS like a board's.
