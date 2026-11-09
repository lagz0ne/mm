# Files view on the board (sy-oprc)

A **Files** tab on every board: browse the board's own documents and see each file by its type, like Paseo's file
browser, read-only.

## What Paseo's file browser does (read from the package mm installs)

Server (`@getpaseo/server`, `file-explorer/service.js`):
- **Lists** one folder at a time under the agent's workspace root: name, kind (file / directory), size, modified time.
  Sorted newest first, then by name. Dangling links and links that resolve outside the workspace are skipped.
- **Scope**: every path is resolved with `realpath` and must stay under the workspace's real path; files are opened
  with `O_NOFOLLOW`. Hidden files are listed; the UI has a "Show hidden files" toggle.
- **Reads** a file whole, sorted into three kinds: `image` (png, jpg, gif, webp, svg; sent base64), `binary` (a
  known binary extension, a NUL byte in the first 8 KB, or not valid UTF-8: no content, only size and type) and
  `text` (everything else, UTF-8). Downloads stream in 256 KB chunks.
- It also writes (create, rename, duplicate, delete, save up to 1 MB with a revision check).

Web UI (the bundled Expo app):
- File panels by type: **Markdown** (rendered; ```` ```mermaid ```` fences become diagrams, drawn in an iframe with
  `sandbox="allow-scripts"`), **HTML** (an iframe with `srcDoc` and `sandbox="allow-scripts"`, no referrer),
  **Image**, **Source** (a code view with line numbers). "Open with…" picks a panel per extension.
- States: loading, "No preview available", "Binary preview unavailable", "This file is too large to display".

## What the board copies, and what it does not

| Paseo | the board |
|---|---|
| any folder of the workspace | only the board's document folders: `artifacts/`, `docs/`, `plans/`, `memory/` (each when present) and, on a project, `code/docs/` |
| hidden files behind a toggle | never: no dotfile or dot-folder, no `secrets*`, `node_modules`, `.git`, `.run`, `.env*`, no `inbox/` |
| links inside the workspace followed | a link is followed only when its real path stays inside the same allowed folder; else it is not listed and not served |
| image, binary, text by extension and sniffing | the same three, plus Markdown, Mermaid (`.mmd`, `.mermaid`) and HTML by extension |
| Markdown with Mermaid | the board's own Markdown component; Mermaid is drawn server-side (merman) and shown as an `<img>` |
| HTML in `sandbox="allow-scripts"` | HTML in an iframe with `sandbox=""` (no scripts, no same-origin, no forms, no popups) **and** the file is served with a `sandbox` CSP and `default-src 'none'` (images and styles from the board only) |
| SVG as an image | SVG only as an `<img>` (never inline); served with the sandbox CSP and `nosniff` |
| source view with line numbers | text and code with line numbers, long lines wrap |
| too large / binary: a message | over 2 MB, or binary: the size and a **Download** link |
| writes | none: GET only |

## Shape

- `GET /api/files?path=<folder>`: one folder's entries `{name, path, dir, kind, size, mtime}`; no path: the allowed
  top folders that exist. Folders first, then files, each newest first.
- `GET /api/files/raw/<path>`: the file's bytes with its type, `nosniff`, `cache-control: no-cache`, and
  `content-security-policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`.
  `?download=1`: as an attachment. The path form lets an HTML page's relative images load through the same checks.
- Every refused path (`..`, a dotfile, a forbidden name, a link that leaves its folder, a folder not on the list, a
  bad encoding) answers **404**, the same as a missing file: the answer never says whether something exists.
- **Who**: the same read rights as the rest of the board. The local side reads; on the public side every signed-in
  role reads (a viewer included: GET only), and without the gateway's assertion the answer is 401.
- **UI**: the `#files` tab (`#files/<path>` for a folder or a file, so Back works). A breadcrumb and an "Up" link; on a
  phone (360–430 px) one column, no sideways scroll.
