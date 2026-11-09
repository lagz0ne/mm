#!/usr/bin/env node
// The Files view (sy-oprc; docs/board/sy-oprc-files.md): a throwaway board (the built site and the real
// site/server.mjs, copies in a temp folder; a stand-in bd serve, Paseo and Mermaid renderer; no bd, no live board).
// Proves: GET /api/files lists only the allowed folders (artifacts, docs, plans, memory, code/docs when it is a real
// folder) and, in a folder, nothing hidden, forbidden or linked out; every way out (.., encoded .., an absolute path,
// a dotfile, secrets, a folder not on the list, a link out, a top folder that is a link out) is a 404 with nothing of
// it in the answer; each file comes with its type, nosniff and a sandbox CSP with no token; the public side wants the
// gateway's sign-in (401 without), a viewer reads. In a browser at 390x844: the list, a folder, Markdown (with a
// Mermaid fence), a Mermaid file, a png, an svg as an <img>, HTML in a sandbox="" frame where no script runs, text with
// line numbers, a binary and a file over 2 MB as size + Download; Up and Back; no sideways scroll. At 1280: the tab.
//   node test/board-files.mjs       exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...       use template/site/dist as it is
//   BOARD_FILES_SHOTS=<dir>         where the screenshots go (default: a folder under the temp dir)
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-files-'))
const SHOTS = process.env.BOARD_FILES_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-files: ${m}\x1b[0m`); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the browser ----------
let chromium
try { ({ chromium } = await import('playwright-core')) } catch { die('playwright-core is not installed (run `bun install` at mm\'s root)') }
function findBrowser() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM) ? process.env.PLAYWRIGHT_CHROMIUM : null
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright')
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p } catch {}
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort().reverse() : []
  for (const d of dirs) for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
    const p = path.join(cache, d, rel)
    if (fs.existsSync(p)) return p
  }
  return null
}
const exe = findBrowser()
if (!exe) die('no Chromium found: install one (`bunx playwright-core install chromium-headless-shell`) or set PLAYWRIGHT_CHROMIUM. Nothing was checked.')

// ---------- the site, built ----------
step('build the site')
if (!process.env.BOARD_PHONE_NOBUILD) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: SITE, encoding: 'utf8' })
  if (b.status !== 0) { console.log((b.stdout + b.stderr).slice(-800)); die('npm run build failed') }
  console.log('  built')
}
if (!fs.existsSync(path.join(SITE, 'dist', 'index.html'))) die('no template/site/dist/index.html')

// ---------- a board: the template's site (built) and bin, its own root repo, and files of every kind ----------
const B = path.join(T, 'board')
fs.cpSync(SITE, path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))
const MARK = 'not-for-the-browser-7c1e'
const w = (rel, body, mode) => { const f = path.join(B, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, mode ? { mode } : undefined); return f }
// what no request may get at
w('secrets.json', JSON.stringify({ note: MARK }))
w('secrets/key', MARK)
w('inbox/upload.md', `# ${MARK}\n`)
w('docs/.env', `TOKEN=${MARK}\n`)
w('docs/.hidden.md', `# ${MARK}\n`)
w('docs/node_modules/x.js', MARK)
w('docs/secrets.yaml', MARK)
w('artifacts/ab-7/.notes.md', `# ${MARK}\n`)
fs.mkdirSync(path.join(T, 'elsewhere'))
fs.writeFileSync(path.join(T, 'elsewhere', 'ok.md'), `# ${MARK}\n`)
// the documents
const browser = await chromium.launch({ executablePath: exe })
{
  const p = await browser.newPage({ viewport: { width: 400, height: 200 } })
  await p.setContent('<body style="margin:0;font:28px system-ui;background:#fff"><div style="background:#e30613;color:#fff;padding:30px">A screenshot</div></body>')
  await p.screenshot({ path: path.join(B, 'artifacts-pic.png') })
  await p.close()
}
fs.mkdirSync(path.join(B, 'artifacts', 'ab-7'), { recursive: true })
fs.renameSync(path.join(B, 'artifacts-pic.png'), path.join(B, 'artifacts', 'ab-7', 'pic.png'))
w('artifacts/ab-7/notes.md', '# Result table\n\nThe flow:\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n| check | result |\n|---|---|\n| phone | 12/12 |\n')
w('artifacts/ab-7/flow.mmd', 'graph TD\n  Start --> End\n')
w('artifacts/ab-7/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><script>window.top.svgRan=1</script><rect width="120" height="60" fill="#111"/></svg>')
w('artifacts/ab-7/page.html', '<!doctype html><title>Report</title><h1>Report page</h1><img id="pic" src="pic.png" width="40"><script>document.body.dataset.ran = "1"; try { parent.document.title = "pwned" } catch (e) {}</script>')
w('artifacts/ab-7/code.js', 'const a = 1\nconst b = 2\n// a very long line ' + 'x'.repeat(400) + '\nexport default a + b\n')
w('artifacts/ab-7/tool.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2, 3]))
w('artifacts/ab-7/big.txt', 'line\n'.repeat(500000)) // 2.5 MB
w('docs/guide.md', '# Guide\n\nRead me.\n')
w('docs/sub/deeper.txt', 'deep\n')
w('plans/next.md', '# Next\n')
w('memory/MEMORY.md', '# Memory\n')
w('leads/notes.md', `# ${MARK}\n`)
// links: one inside its folder (kept), one out of it, one to a forbidden folder, a top folder that is a link out
fs.symlinkSync('guide.md', path.join(B, 'docs', 'inlink.md'))
fs.symlinkSync('../../secrets.json', path.join(B, 'artifacts', 'ab-7', 'link.json'))
fs.symlinkSync('../secrets', path.join(B, 'docs', 'tosecrets'))
fs.symlinkSync('../leads', path.join(B, 'docs', 'toleads'))
fs.mkdirSync(path.join(B, 'code'))
fs.symlinkSync(path.join(T, 'elsewhere'), path.join(B, 'code', 'docs'))
const env = { ...process.env, HOME: path.join(T, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'MM_SERVICE', 'MM_BIND']) delete env[k]
fs.mkdirSync(env.HOME)
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: B, env })
w('.git/mark', MARK)

// ---------- a stand-in bd serve, Paseo and Mermaid renderer ----------
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues' || u.pathname === '/v0/beads/ready') return json({ items: [], has_more: false })
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })
fs.writeFileSync(path.join(T, 'merman'), '#!/bin/sh\ncat >/dev/null\nprintf \'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="200" height="80"><rect width="200" height="80" fill="#e30613"/></svg>\'\n', { mode: 0o755 })

// ---------- the board: the real server.mjs ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-ab.example.org'
const sign = (u, r) => { const b = Buffer.from(JSON.stringify({ u, r, h: HOST, exp: Date.now() + 60000, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'ab', MM_PROJECT: 'ab',
  MERMAN_BIN: path.join(T, 'merman'), BOARD_PUBLIC_PORT: String(PPORT), MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const BASE = `http://127.0.0.1:${PORT}`
/** A raw request: the path goes as written (no URL normalising), as a hand-made request would send it. */
const raw = (p, port = PORT, headers = {}, method = 'GET') => new Promise((ok_, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok_({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  r.on('error', no); r.end()
})
const names = (r) => JSON.parse(r.body.toString()).entries.map((e) => e.name).sort().join(' ')
const SANDBOX = /^sandbox;/ // the sandbox directive with no token: no script, no same-origin

try {
  step('the list: only the allowed folders')
  let r = await raw('/api/files')
  ok('the top: artifacts, docs, memory, plans (not code/docs, a link out; nothing else of the root)', r.status === 200 && names(r) === 'artifacts docs memory plans', r.body.toString().slice(0, 300))
  r = await raw('/api/files?path=docs')
  ok('docs/: the guide, the link inside it and the sub-folder; no dotfile, secrets, node_modules or link out', r.status === 200 && names(r) === 'guide.md inlink.md sub', r.body.toString().slice(0, 400))
  r = await raw('/api/files?path=artifacts/ab-7')
  const ab7 = JSON.parse(r.body.toString()).entries
  ok('artifacts/ab-7/: every document, not the dotfile nor the link out', ab7.map((e) => e.name).sort().join(' ') === 'big.txt code.js flow.mmd logo.svg notes.md page.html pic.png tool.bin', ab7.map((e) => e.name).join(' '))
  const kinds = Object.fromEntries(ab7.map((e) => [e.name, e.kind]))
  const KINDS = { 'big.txt': 'text', 'code.js': 'text', 'flow.mmd': 'mermaid', 'logo.svg': 'image', 'notes.md': 'markdown', 'page.html': 'html', 'pic.png': 'image', 'tool.bin': 'binary' }
  ok('each with its kind (by extension, a NUL byte: binary)', ab7.length === 8 && ab7.every((e) => KINDS[e.name] === e.kind), JSON.stringify(kinds))
  const png = ab7.find((e) => e.name === 'pic.png')
  ok('each with its path, size and mtime', png?.path === 'artifacts/ab-7/pic.png' && png.size === fs.statSync(path.join(B, 'artifacts/ab-7/pic.png')).size && !Number.isNaN(Date.parse(png.mtime)), JSON.stringify(png))
  ok('no answer names the mark', ![await raw('/api/files'), await raw('/api/files?path=docs'), await raw('/api/files?path=artifacts/ab-7')].some((x) => x.body.toString().includes(MARK)))

  step('every way out is refused (404)')
  const refused = ['..', '../secrets.json', 'docs/../secrets.json', '%2e%2e', 'docs/%2e%2e/secrets.json', '/etc/passwd', 'secrets', 'secrets/key', 'secrets.json',
    'leads', 'leads/notes.md', 'inbox/upload.md', '.git', '.git/mark', 'docs/.env', 'docs/.hidden.md', 'docs/node_modules/x.js', 'docs/secrets.yaml',
    'artifacts/ab-7/.notes.md', 'artifacts/ab-7/link.json', 'docs/tosecrets', 'docs/tosecrets/key', 'docs/toleads/notes.md', 'code/docs', 'code/docs/ok.md',
    'docs//guide.md', 'code', 'artifacts/ab-7/nope.md']
  for (const p of refused) {
    const a = await raw(`/api/files/raw/${p}`), l = await raw(`/api/files?path=${encodeURIComponent(p)}`)
    // a raw .. that the URL parser folds lands on another /api/ path: the board's allowlist refuses it (403)
    ok(`${p}: refused (404, or 403 once folded) to read and to list, nothing of it in the answer`, [403, 404].includes(a.status) && l.status === 404 && !a.body.toString('latin1').includes(MARK) && !l.body.toString().includes(MARK), `${a.status}/${l.status}`)
  }
  for (const p of ['/api/files/raw/artifacts%2F..%2Fsecrets.json', '/api/files/raw/docs/%E0%A4%A', '/api/files/raw/', '/api/files/raw/docs'])
    { r = await raw(p); ok(`${p}: 404`, r.status === 404 && !r.body.toString('latin1').includes(MARK), String(r.status)) }
  const viaFetch = await fetch(`${BASE}/api/files/raw/docs/../secrets.json`)
  ok('a browser\'s URL (.. folded by the URL parser): 404 too', viaFetch.status === 404 && !(await viaFetch.text()).includes(MARK))
  r = await raw('/api/files/raw/docs/guide.md', PORT, { 'content-type': 'application/json' }, 'POST')
  ok('no write: a POST is not a Files route (403 from the board\'s allowlist)', r.status === 403 || r.status === 404 || r.status === 405, String(r.status))

  step('the files: their type, nosniff, the sandbox CSP')
  r = await raw('/api/files/raw/artifacts/ab-7/pic.png')
  ok('the png: image/png, the same bytes', r.status === 200 && r.headers['content-type'] === 'image/png' && r.body.equals(fs.readFileSync(path.join(B, 'artifacts/ab-7/pic.png'))))
  r = await raw('/api/files/raw/artifacts/ab-7/page.html')
  ok('the html: text/html, nosniff, CSP sandbox with no token, default-src none', r.status === 200 && /^text\/html/.test(r.headers['content-type']) && r.headers['x-content-type-options'] === 'nosniff' && SANDBOX.test(r.headers['content-security-policy'] || '') && !/allow-scripts|allow-same-origin/.test(r.headers['content-security-policy']) && /default-src 'none'/.test(r.headers['content-security-policy']), r.headers['content-security-policy'])
  r = await raw('/api/files/raw/artifacts/ab-7/logo.svg')
  ok('the svg: image/svg+xml with the same CSP', r.status === 200 && r.headers['content-type'] === 'image/svg+xml' && SANDBOX.test(r.headers['content-security-policy'] || ''))
  r = await raw('/api/files/raw/artifacts/ab-7/notes.md')
  ok('the md: text/markdown', r.status === 200 && /^text\/markdown/.test(r.headers['content-type']))
  r = await raw('/api/files/raw/artifacts/ab-7/code.js')
  ok('the js: text/plain (never run as a script)', r.status === 200 && /^text\/plain/.test(r.headers['content-type']))
  r = await raw('/api/files/raw/artifacts/ab-7/tool.bin')
  ok('the binary: an attachment', r.status === 200 && r.headers['content-type'] === 'application/octet-stream' && /^attachment/.test(r.headers['content-disposition'] || ''))
  r = await raw('/api/files/raw/artifacts/ab-7/page.html?download=1')
  ok('?download=1: an attachment, octet-stream', r.status === 200 && r.headers['content-type'] === 'application/octet-stream' && /^attachment; filename="page.html"/.test(r.headers['content-disposition'] || ''))
  r = await raw('/api/files/raw/docs/inlink.md')
  ok('a link inside its folder: served', r.status === 200 && r.body.toString().includes('# Guide'))

  step('the public side: the same sign-in as the rest')
  r = await raw('/api/files', PPORT, { host: HOST })
  ok('no sign-in, the list: 401', r.status === 401)
  r = await raw('/api/files/raw/docs/guide.md', PPORT, { host: HOST })
  ok('no sign-in, a file: 401', r.status === 401 && !r.body.toString().includes('Guide'))
  r = await raw('/api/files/raw/docs/guide.md', PPORT, { host: HOST, 'x-mm-assertion': 'e30.bad' })
  ok('a forged assertion: 401', r.status === 401)
  r = await raw('/api/files?path=docs', PPORT, { host: HOST, 'x-mm-assertion': sign('vic', 'viewer') })
  ok('a viewer signed in: the list', r.status === 200 && names(r) === 'guide.md inlink.md sub')
  r = await raw('/api/files/raw/docs/guide.md', PPORT, { host: HOST, 'x-mm-assertion': sign('vic', 'viewer') })
  ok('a viewer signed in: the file', r.status === 200 && r.body.toString().includes('# Guide'))
  r = await raw('/api/files/raw/secrets/key', PPORT, { host: HOST, 'x-mm-assertion': sign('olga', 'owner') })
  ok('the owner signed in, a way out: 404', r.status === 404 && !r.body.toString().includes(MARK))

  step('the view at 390x844')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const noSideways = () => page.evaluate(() => {
    const m = document.querySelector('[data-files]')
    return document.documentElement.scrollWidth > innerWidth || (m ? m.scrollWidth > m.clientWidth + 1 : true)
  })
  await page.goto(`${BASE}/#files`)
  const list = page.locator('[data-files-list]')
  await list.waitFor({ timeout: 10000 }).catch(() => {})
  ok('#files lists the four folders', (await list.locator('[data-entry]').count()) === 4 && (await list.locator('[data-entry="artifacts"]').count()) === 1, await page.locator('[data-files]').innerText().catch(() => 'no view'))
  ok('no sideways scroll (the top)', !(await noSideways()))
  await page.screenshot({ path: path.join(SHOTS, 'files-top-390.png') })
  await list.locator('[data-entry="artifacts"]').click()
  await page.locator('[data-entry="ab-7"]').click()
  await page.locator('[data-entry="notes.md"]').waitFor({ timeout: 5000 }).catch(() => {})
  ok('a tap opens a folder: #files/artifacts/ab-7, its files', page.url().endsWith('#files/artifacts/ab-7') && (await page.locator('[data-files-list] [data-entry]').count()) === 8)
  const rows = await page.locator('[data-files-list] a').evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))
  ok('every row is thumb-sized (≥44px)', rows.every((h) => h >= 44), rows.join(','))
  ok('no sideways scroll (a folder)', !(await noSideways()))
  await page.screenshot({ path: path.join(SHOTS, 'files-list-390.png') })

  const open = async (name) => {
    await page.goto(`${BASE}/#files/artifacts/ab-7/${name}`)
    await page.locator(`[data-file="artifacts/ab-7/${name}"]`).waitFor({ timeout: 8000 }).catch(() => {})
    return page.locator(`[data-file="artifacts/ab-7/${name}"]`)
  }
  let f = await open('notes.md')
  await f.getByRole('heading', { name: 'Result table' }).waitFor({ timeout: 5000 }).catch(() => {})
  ok('markdown: rendered (heading, table)', (await f.getByRole('heading', { name: 'Result table' }).count()) === 1 && (await f.locator('table').count()) === 1)
  await f.locator('img[alt="Mermaid diagram"]').waitFor({ timeout: 5000 }).catch(() => {})
  ok('markdown: its mermaid fence is a diagram (an <img>)', (await f.locator('img[alt="Mermaid diagram"]').count()) === 1)
  ok('no sideways scroll (markdown)', !(await noSideways()))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'files-md-390.png') })
  await page.locator('[data-files-up]').click()
  await page.locator('[data-files-list]').waitFor({ timeout: 5000 }).catch(() => {})
  ok('Up goes to the folder', page.url().endsWith('#files/artifacts/ab-7') && (await page.locator('[data-files-list]').count()) === 1)
  await page.goBack()
  await page.locator('[data-file="artifacts/ab-7/notes.md"]').waitFor({ timeout: 5000 }).catch(() => {})
  ok('Back returns to the file', (await page.locator('[data-file="artifacts/ab-7/notes.md"]').count()) === 1)

  f = await open('flow.mmd')
  await f.locator('img[alt="Mermaid diagram"]').waitFor({ timeout: 5000 }).catch(() => {})
  ok('a .mmd file: a diagram', (await f.locator('img[alt="Mermaid diagram"]').count()) === 1)
  f = await open('pic.png')
  const img = f.locator('img[src="/api/files/raw/artifacts/ab-7/pic.png"]')
  await img.evaluate((i) => i.complete || new Promise((r) => { i.onload = r; i.onerror = r })).catch(() => {})
  ok('a png: an image, loaded, fits the phone', (await img.count()) === 1 && (await img.evaluate((i) => i.naturalWidth)) > 0 && ((await img.boundingBox())?.width ?? 999) <= 390)
  f = await open('logo.svg')
  const simg = f.locator('img[src="/api/files/raw/artifacts/ab-7/logo.svg"]')
  await simg.evaluate((i) => i.complete || new Promise((r) => { i.onload = r; i.onerror = r })).catch(() => {})
  ok('an svg: an <img>, never inline; its script did not run', (await simg.count()) === 1 && (await f.locator('svg rect').count()) === 0 && !(await page.evaluate(() => window.svgRan)))
  f = await open('page.html')
  const frame = f.locator('iframe[data-html-frame]')
  ok('html: an iframe with sandbox="" (no token)', (await frame.count()) === 1 && (await frame.getAttribute('sandbox')) === '')
  await page.waitForTimeout(800)
  const fr = page.frames().find((x) => x.url().endsWith('/api/files/raw/artifacts/ab-7/page.html'))
  const inner = fr ? await fr.evaluate(() => ({ h1: document.querySelector('h1')?.textContent, ran: document.body.dataset.ran || null, img: document.getElementById('pic')?.naturalWidth || 0 })).catch((e) => ({ err: e.message })) : null
  ok('html: the page shows in it', inner?.h1 === 'Report page', JSON.stringify(inner))
  ok('html: no script ran in it (and the board\'s title is untouched)', !!inner && inner.ran === null && !/pwned/.test(await page.title()), JSON.stringify(inner))
  ok('html: its relative image loads (through the same checks)', !!inner && inner.img > 0, JSON.stringify(inner))
  await page.screenshot({ path: path.join(SHOTS, 'files-html-390.png') })
  f = await open('code.js')
  await f.locator('[data-lines]').waitFor({ timeout: 5000 }).catch(() => {})
  ok('text: with line numbers', (await f.locator('[data-lines] > div').count()) === 4 && (await f.locator('[data-lines] > div').first().innerText()).startsWith('1'))
  ok('no sideways scroll (a 400-character line wraps)', !(await noSideways()))
  await page.screenshot({ path: path.join(SHOTS, 'files-text-390.png') })
  f = await open('tool.bin')
  ok('a binary: no preview, its size and Download', (await f.locator('[data-no-preview]').count()) === 1 && (await f.locator('[data-download]').getAttribute('href')) === '/api/files/raw/artifacts/ab-7/tool.bin?download=1')
  f = await open('big.txt')
  ok('over 2 MB: no preview, "too large", Download', (await f.locator('[data-no-preview]').innerText().catch(() => '')).includes('Too large') && (await f.locator('[data-download]').count()) === 1 && (await f.locator('[data-lines]').count()) === 0)
  await page.goto(`${BASE}/#files/secrets`)
  await page.getByText(/^Not available/).waitFor({ timeout: 5000 }).catch(() => {})
  ok('#files/secrets: "Not available", nothing of it', (await page.getByText(/^Not available/).count()) === 1 && !(await page.content()).includes(MARK))
  ok('no page error', errs.length === 0, errs.join(' | '))
  await ctx.close()

  step('the tab at 1280')
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await dctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
  const dp = await dctx.newPage()
  await dp.goto(`${BASE}/`)
  const tab = dp.locator('header nav a[href="#files"]')
  await tab.waitFor({ timeout: 10000 }).catch(() => {})
  ok('the header has a Files tab', (await tab.count()) === 1)
  await tab.click().catch(() => {})
  ok('it opens the view', await dp.locator('[data-files-list]').waitFor({ timeout: 5000 }).then(() => true, () => false))
  await dctx.close()
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
}
console.log('\nscreenshots:')
for (const f of fs.readdirSync(SHOTS)) console.log(`  ${path.join(SHOTS, f)}`)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
fs.rmSync(B, { recursive: true, force: true }) // the board copy; the screenshots stay
process.exit(fail ? 1 : 0)
