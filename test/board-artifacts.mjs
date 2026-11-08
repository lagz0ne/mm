#!/usr/bin/env node
// An item's artifacts (sy-wxzx): bin/artifact posts a png, an .md and an .html to an item of a throwaway board that has
// no code/ (as the system board), and the board shows them. The built site and the real site/server.mjs (copies, in a
// temp folder), a stand-in bd serve and Paseo; no bd, no live board. Proves: bin/artifact prints the paths and commits
// the files; GET /api/artifacts/<id> lists them (name, type, size, mtime) and nothing else in the folder; the files
// come with their type, nosniff and (HTML) the sandbox CSP; every way out is a 404 (.., encoded .. and slashes,
// absolute paths, dotfiles, a symlinked file, an item folder that is a symlink out, a sub-folder, an unknown type, a
// bad encoding), and the public side wants the gateway's sign-in as for the rest. At 390x844 (Playwright): the item's
// detail shows a strip of thumbnails and chips, thumb-sized (40px+), no sideways scroll; the png opens full size, the
// .md in the dialog, the .html in a new tab; a path in a comment is a link and embeds the image.
//   node test/board-artifacts.mjs      exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...          use template/site/dist as it is
//   BOARD_ARTIFACTS_SHOTS=<dir>        where the screenshots go (default: a folder under the temp dir)
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-artifacts-'))
const SHOTS = process.env.BOARD_ARTIFACTS_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-artifacts: ${m}\x1b[0m`); process.exit(2) }
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

// ---------- a board with no code/: the template's site (built) and bin, its own root repo ----------
const B = path.join(T, 'board')
fs.cpSync(SITE, path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.copyFileSync(path.join(SRC, 'template', '.gitignore'), path.join(B, '.gitignore'))
fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))
const MARK = 'not-for-the-browser-0f3a'
fs.writeFileSync(path.join(B, 'secrets.json'), JSON.stringify({ note: MARK }))
fs.writeFileSync(path.join(B, 'outside.md'), `# ${MARK}\n`)
fs.mkdirSync(path.join(T, 'elsewhere'))
fs.writeFileSync(path.join(T, 'elsewhere', 'ok.md'), `# ${MARK}\n`)
const env = { ...process.env, HOME: path.join(T, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'MM_SERVICE', 'MM_BIND']) delete env[k]
fs.mkdirSync(env.HOME)
const sh = (cmd, args, more = {}) => spawnSync(cmd, args, { cwd: B, encoding: 'utf8', env: { ...env, ...more } })
sh('git', ['init', '-q', '-b', 'main']); sh('git', ['add', '-A']); sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init'])

// ---------- the files a lead made: a screenshot, a note, a report ----------
const browser = await chromium.launch({ executablePath: exe })
{
  const p = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await p.setContent('<body style="margin:0;font:32px system-ui;background:#fff"><div style="background:#e30613;color:#fff;padding:40px">After: the list fits</div><p style="padding:40px">Row one<br>Row two<br>Row three</p></body>')
  await p.screenshot({ path: path.join(T, 'after.png') })
  await p.close()
}
fs.writeFileSync(path.join(T, 'notes.md'), '# Result table\n\n| check | result |\n|---|---|\n| phone | 12/12 |\n| desktop | 9/9 |\n')
fs.writeFileSync(path.join(T, 'report.html'), '<!doctype html><title>Report</title><h1>Report</h1>')

step('bin/artifact posts them to ab-7')
const a = sh(path.join(B, 'bin', 'artifact'), ['ab-7', path.join(T, 'after.png'), path.join(T, 'notes.md'), path.join(T, 'report.html')], { BEADS_ACTOR: 'platform' })
ok('exit 0', a.status === 0, a.stderr)
ok('it prints each path to quote', a.stdout.trim().split('\n').join(' ') === 'artifacts/ab-7/after.png artifacts/ab-7/notes.md artifacts/ab-7/report.html', a.stdout)
const log = sh('git', ['log', '-1', '--format=%an|%s']).stdout.trim()
ok('one commit in the root repo, by the role', log === 'platform|artifact ab-7: after.png notes.md report.html', log)

// what no request may get at: a dotfile, a symlinked file, an item folder that is a symlink out, a sub-folder, a type
const AD = path.join(B, 'artifacts', 'ab-7')
fs.writeFileSync(path.join(AD, '.x.md'), `# ${MARK}\n`)
fs.symlinkSync(path.join(B, 'outside.md'), path.join(AD, 'link.md'))
fs.symlinkSync(path.join(T, 'elsewhere'), path.join(B, 'artifacts', 'ab-9'))
fs.mkdirSync(path.join(AD, 'sub')); fs.writeFileSync(path.join(AD, 'sub', 'x.md'), `# ${MARK}\n`)
fs.writeFileSync(path.join(AD, 'tool.exe'), MARK)

// ---------- a stand-in bd serve and Paseo ----------
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const item = { id: 'ab-7', title: 'The items get the phone screen', status: 'in_progress', priority: 2, issue_type: 'task', assignee: 'platform', labels: [],
  created_at: iso(90), updated_at: iso(3), description: 'Make the list fit a phone.', comments: [
    { id: 'c1', author: 'platform', created_at: iso(5), text: 'Done. Before/after: artifacts/ab-7/after.png, numbers in `artifacts/ab-7/notes.md`.' }] }
const other = { ...item, id: 'ab-8', title: 'No artifacts here', comments: [], status: 'open' }
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? [] : [item, other].map(({ comments, ...i }) => ({ ...i, comment_count: comments.length })), has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: [other], has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = [item, other].find((x) => x.id === m[1]); return i ? json(i) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

// ---------- the board: the real server.mjs ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-ab.example.org'
const sign = (u, r) => { const b = Buffer.from(JSON.stringify({ u, r, h: HOST, exp: Date.now() + 60000, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'ab', MM_PROJECT: 'ab',
  BOARD_PUBLIC_PORT: String(PPORT), MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const BASE = `http://127.0.0.1:${PORT}`
/** A raw GET: the path goes as written (no URL normalising), as a hand-made request would send it. */
const raw = (p, port = PORT, headers = {}) => new Promise((ok_, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok_({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  r.on('error', no); r.end()
})

try {
  step('the API and the files')
  let r = await raw('/api/artifacts/ab-7')
  const list = JSON.parse(r.body.toString())
  ok('GET /api/artifacts/ab-7 lists the three, sorted, nothing else in the folder', r.status === 200 && list.files.map((f) => f.name).join(' ') === 'after.png notes.md report.html', r.body.toString().slice(0, 300))
  const png = list.files.find((f) => f.name === 'after.png')
  ok('each with its path, type, size and mtime', png && png.path === 'artifacts/ab-7/after.png' && png.type === 'image/png' && png.size === fs.statSync(path.join(T, 'after.png')).size && !Number.isNaN(Date.parse(png.mtime)), JSON.stringify(png))
  r = await raw('/api/artifacts/ab-8')
  ok('an item with none: an empty list', r.status === 200 && JSON.parse(r.body.toString()).files.length === 0)
  r = await raw('/api/artifacts/ab-9')
  ok('an item folder that is a symlink out: an empty list', r.status === 200 && JSON.parse(r.body.toString()).files.length === 0, r.body.toString())
  r = await raw('/api/artifacts/..')
  ok('a bad id: refused', r.status >= 400 && r.status < 500, String(r.status))
  r = await raw('/files/artifacts/ab-7/after.png')
  ok('the png: 200, image/png, nosniff, the same bytes', r.status === 200 && r.headers['content-type'] === 'image/png' && r.headers['x-content-type-options'] === 'nosniff' && r.body.equals(fs.readFileSync(path.join(T, 'after.png'))))
  r = await raw('/files/artifacts/ab-7/report.html')
  ok('the html: sandboxed (CSP), nosniff', r.status === 200 && /^sandbox allow-scripts/.test(r.headers['content-security-policy'] || '') && r.headers['x-content-type-options'] === 'nosniff')
  r = await raw('/files/artifacts/ab-7/notes.md')
  ok('the md: text/markdown', r.status === 200 && /^text\/markdown/.test(r.headers['content-type']))

  step('every way out is a 404')
  const refusals = [
    ['/files/artifacts/../secrets.json', '.. (raw)'], ['/files/artifacts/ab-7/../../secrets.json', '.. twice (raw)'],
    ['/files/artifacts/%2e%2e/secrets.json', 'encoded ..'], ['/files/artifacts/ab-7/..%2F..%2Fsecrets.json', 'encoded slashes'],
    ['/files/artifacts/ab-7%2F..%2F..%2Fsecrets.json', 'encoded slashes in the id'], ['/files/artifacts//etc/passwd', 'an absolute path'],
    ['/files/artifacts/%2Fetc%2Fpasswd', 'an encoded absolute path'], ['/files/artifacts/ab-7/.x.md', 'a dotfile'],
    ['/files/artifacts/ab-7/link.md', 'a symlinked file (out of the folder)'], ['/files/artifacts/ab-9/ok.md', 'an item folder that is a symlink out'],
    ['/files/artifacts/ab-7/sub/x.md', 'a sub-folder'], ['/files/artifacts/ab-7/tool.exe', 'an unknown type'],
    ['/files/artifacts/ab-7/%E0%A4%A', 'a bad encoding'], ['/files/artifacts/ab-7/', 'the folder'], ['/files/artifacts/ab-7/nope.png', 'a missing file'],
    ['/files/secrets.json', 'a root file through /files/ (no code/)'],
  ]
  for (const [p, what] of refusals) {
    r = await raw(p)
    ok(`${what}: 404, nothing of it in the answer (${p})`, r.status === 404 && !r.body.toString('latin1').includes(MARK), `${r.status} ${r.body.toString().slice(0, 120)}`)
  }
  const viaFetch = await fetch(`${BASE}/files/artifacts/../secrets.json`)
  ok('a browser\'s URL (.. folded by the URL parser): 404 too', viaFetch.status === 404 && !(await viaFetch.text()).includes(MARK))

  step('the public side: the same sign-in as the rest')
  r = await raw('/files/artifacts/ab-7/after.png', PPORT, { host: HOST })
  ok('no sign-in: 401', r.status === 401)
  r = await raw('/api/artifacts/ab-7', PPORT, { host: HOST })
  ok('no sign-in, the list: 401', r.status === 401)
  r = await raw('/files/artifacts/ab-7/after.png', PPORT, { host: HOST, 'x-mm-assertion': sign('vic', 'viewer') })
  ok('a viewer signed in: 200', r.status === 200 && r.headers['content-type'] === 'image/png')
  r = await raw('/files/artifacts/../secrets.json', PPORT, { host: HOST, 'x-mm-assertion': sign('vic', 'viewer') })
  ok('signed in, a way out: 404', r.status === 404 && !r.body.toString('latin1').includes(MARK))

  step('the item\'s detail at 390x844')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }]) // a visitor who named themselves
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`${BASE}/?item=ab-7`)
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Artifacts · 3$/ }) })
  await section.waitFor({ timeout: 10000 }).catch(() => {})
  ok('an "Artifacts · 3" section', (await section.count()) === 1)
  if (!(await section.count())) { await page.screenshot({ path: path.join(SHOTS, 'debug-no-section.png') }); throw new Error(`no Artifacts section; page errors: ${errs.join(' | ')}`) }
  await section.scrollIntoViewIfNeeded().catch(() => {})
  const thumb = section.locator('[data-artifact="after.png"]')
  await thumb.locator('img').evaluate((img) => img.complete || new Promise((r) => { img.onload = r; img.onerror = r })).catch(() => {})
  ok('the png is a thumbnail, and it loaded', (await thumb.locator('img').evaluate((img) => img.naturalWidth)) > 0)
  const md = section.locator('[data-artifact="notes.md"]'), html = section.locator('[data-artifact="report.html"]')
  ok('the md and the html are chips', (await md.count()) === 1 && (await html.count()) === 1)
  for (const [label, loc] of [['the thumbnail', thumb], ['the md chip', md], ['the html chip', html]]) {
    const box = await loc.boundingBox()
    ok(`${label}: thumb-sized (≥40px high) and on the screen`, !!box && box.height >= 40 && box.x >= 0 && box.x + box.width <= 391, box ? `${Math.round(box.width)}x${Math.round(box.height)} at x=${Math.round(box.x)}` : 'not found')
  }
  const wide = await page.evaluate(() => {
    const s = [...document.querySelectorAll('section')].find((e) => /^Artifacts/.test(e.querySelector('h3')?.textContent || ''))
    const sheet = s?.closest('[data-slot="sheet-content"]') || s?.parentElement
    return { doc: document.documentElement.scrollWidth > innerWidth, section: s ? s.scrollWidth > s.clientWidth + 1 : true, sheet: sheet ? sheet.scrollWidth > sheet.clientWidth + 1 : false }
  })
  ok('no sideways scroll (page, sheet, section)', !wide.doc && !wide.section && !wide.sheet, JSON.stringify(wide))
  ok('the html opens in a new tab', (await html.getAttribute('target')) === '_blank' && (await html.getAttribute('href')) === '/files/artifacts/ab-7/report.html')
  await page.waitForTimeout(300)
  await section.screenshot({ path: path.join(SHOTS, 'artifacts-gallery-390.png') })
  await page.screenshot({ path: path.join(SHOTS, 'artifacts-detail-390.png') })

  step('a tap opens it')
  await thumb.click()
  const dlg = page.getByRole('dialog', { name: 'artifacts/ab-7/after.png' })
  await dlg.waitFor({ timeout: 5000 }).catch(() => {})
  const big = dlg.locator('img[src="/files/artifacts/ab-7/after.png"]')
  ok('the png opens full size in the viewer', (await big.count()) === 1 && (await big.evaluate((img) => img.naturalWidth)) > 0)
  const bb = await big.boundingBox().catch(() => null)
  ok('it fits the phone\'s width', !!bb && bb.width <= 391 && bb.width > 300, bb ? `${Math.round(bb.width)}px` : '')
  await page.waitForTimeout(500) // the dialog's fade-in
  await page.screenshot({ path: path.join(SHOTS, 'artifacts-png-open-390.png') })
  await dlg.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(300)
  await md.click()
  const mdlg = page.getByRole('dialog', { name: 'artifacts/ab-7/notes.md' })
  await mdlg.getByRole('heading', { name: 'Result table' }).waitFor({ timeout: 5000 }).catch(() => {})
  ok('the md opens in the dialog, rendered (its table too)', (await mdlg.getByRole('heading', { name: 'Result table' }).count()) === 1 && (await mdlg.locator('table').count()) === 1)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(SHOTS, 'artifacts-md-open-390.png') })
  await mdlg.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(300)

  step('paths in a comment')
  const thread = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Thread/ }) })
  ok('artifacts/ab-7/after.png in prose is a link', (await thread.getByRole('button', { name: 'artifacts/ab-7/after.png' }).count()) === 1)
  ok('`artifacts/ab-7/notes.md` in code is a link', (await thread.getByRole('button', { name: 'artifacts/ab-7/notes.md' }).count()) === 1)
  ok('the image is embedded under the comment', (await thread.locator('img[src="/files/artifacts/ab-7/after.png"]').count()) === 1)
  await thread.getByRole('button', { name: 'artifacts/ab-7/notes.md' }).click()
  ok('the link opens the md in the dialog', await page.getByRole('dialog', { name: 'artifacts/ab-7/notes.md' }).getByRole('heading', { name: 'Result table' }).waitFor({ timeout: 5000 }).then(() => true, () => false))
  await page.keyboard.press('Escape')
  await thread.scrollIntoViewIfNeeded().catch(() => {})
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'artifacts-comment-390.png') })

  step('an item with none')
  await page.goto(`${BASE}/?item=ab-8`)
  await page.getByText('No artifacts here').first().waitFor({ timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(500)
  ok('no Artifacts section', (await page.getByRole('heading', { name: /^Artifacts/ }).count()) === 0)
  ok('no page error', errs.length === 0, errs.join(' | '))
  await ctx.close()
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
}
console.log('\nscreenshots:')
for (const f of fs.readdirSync(SHOTS)) console.log(`  ${path.join(SHOTS, f)}`)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
fs.rmSync(B, { recursive: true, force: true }) // the board copy; the screenshots stay
process.exit(fail ? 1 : 0)
