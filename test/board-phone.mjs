#!/usr/bin/env node
// The board and the gateway on a phone (sy-81dm): the built site against fixture data (no bd, no board server, no live
// board) and the gateway's pages as they are made (src/auth.ts pagesForTest, rendered by bun with a throwaway HOME),
// opened with Playwright at 390x844 and 375x667. It fails on sideways scroll (scrollWidth > innerWidth) on the board, an
// open item, the Now/Activity panel, the Designs panel, the Machine panel, the gateway's home, sign-in and token pages;
// on an input under 16px (iOS zooms on focus below that); on a main action under 40px high. Screenshots go to a folder
// under the temp dir; their paths are printed. Then it runs test/board-phone-space.mjs (the items' share of the screen,
// the one-row bar and its menu) on the same build, and counts its checks with its own.
//   node test/board-phone.mjs            exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...            use template/site/dist as it is
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-phone-'))
const SHOTS = path.join(T, 'shots')
fs.mkdirSync(SHOTS)
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-phone: ${m}\x1b[0m`); process.exit(2) }

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
  ok('npm run build', b.status === 0, (b.stdout + b.stderr).slice(-800))
  if (b.status !== 0) process.exit(1)
}
const DIST = path.join(SITE, 'dist')
if (!fs.existsSync(path.join(DIST, 'index.html'))) die('no template/site/dist/index.html')

// ---------- the gateway's pages, made by its own code (bun: auth.ts uses bun:sqlite) ----------
step('render the gateway pages')
const GW = path.join(T, 'gw'), HOME = path.join(T, 'home')
fs.mkdirSync(GW); fs.mkdirSync(HOME)
// auth.ts imports the packed template (src/template.gen.json, gitignored): pack it when a fresh checkout has none.
if (!fs.existsSync(path.join(SRC, 'src', 'template.gen.json'))) spawnSync('bun', ['scripts/pack-template.ts'], { cwd: SRC, stdio: 'ignore' })
const render = `
const { pagesForTest: P } = await import(${JSON.stringify(path.join(SRC, 'src', 'auth.ts'))})
const fs = await import('node:fs'), out = process.argv[1]
const w = (n, s) => fs.writeFileSync(out + '/' + n + '.html', s)
const sum = { open: 31, p0: 2, blocked: 4, needs_you: 3, mine: 7, last: '2026-11-07T12:00:00Z' }
const items = [{ id: 'ab-12', title: 'A long title on the item that waits for the owner to approve it, with words that wrap', age_min: 190, ask: 'approve (t2, signed off)', hot: true },
  { id: 'ab-13', title: 'Short one', age_min: 3, ask: 'needs you', hot: true }]
w('home', P.home('Alex Example-Longname', [
  { project: 'a-rather-long-project-name-with-dashes', host: 'board.example.org', role: 'owner', s: sum, w: { items, more: 2 }, older: false },
  { project: 'second', host: 'board2.example.org', role: 'viewer', s: null, w: null, older: true }]))
w('signin', P.code('ABCD-EFGH', 'a-rather-long-project-name-with-dashes', 'mm_example_bot'))
w('signin-nobot', P.code('ABCD-EFGH', 'a-rather-long-project-name-with-dashes', ''))
fs.writeFileSync(out + '/app.js', P.js)
w('continue', P.continue('tok', '/'))
w('token', P.account('Alex Example-Longname', true, true, '2026-11-01T10:00:00Z', 'Saved.'))
w('runs', P.runs('Alex Example-Longname', [{ project: 'second', item: 'ab-12', expires: Date.parse('2026-11-08T10:00:00Z') }], ['second'], false, ''))
fs.writeFileSync(out + '/app.css', P.css)
`
const r = spawnSync('bun', ['-e', render, GW], { encoding: 'utf8', env: { ...process.env, HOME, MM_HOME: path.join(HOME, '.mm') } })
ok('the gateway\'s pages render', r.status === 0 && fs.existsSync(path.join(GW, 'home.html')), (r.stdout + r.stderr).slice(-800))

// ---------- fixture data: what the board server answers ----------
const now = Date.now(), iso = (minAgo) => new Date(now - minAgo * 60e3).toISOString()
const LONG = 'A long item title that goes on, with a/very/long/path/in/it/that/does/not/break/easily.tsx and more words'
const issue = (id, f = {}) => ({ id, title: `${id} ${LONG}`, status: 'open', priority: 2, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(300), updated_at: iso(5), comment_count: 2, ...f })
const issues = [
  // a t2 card names its head and review signed that head (sy-hzmu), so the item shows its Approve
  issue('sy-1', { priority: 0, labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], assignee: 'ops', title: 'Rotate the gateway key (t2): plan, rollback, lockout safeguard',
    description: '## Owner\n- **What:** Rotate the gateway key.\n- **Why:** The old one is a year old.\n- **You:** Tap Approve\n- **If yes:** Ops rotates it tonight.\n- **If no:** The old key stays.\n- **Risk:** medium, a minute without sign-in\n- **Head:** mm@0a1b2c3\n\nThe plan, the rollback and the lockout safeguard.' }),
  issue('sy-2', { status: 'in_progress', assignee: 'platform' }),
  issue('sy-3', { status: 'blocked', assignee: 'review', dependencies: [{ issue_id: 'sy-3', depends_on_id: 'sy-2', type: 'blocks' }] }),
  issue('sy-4', { assignee: 'setup' }),
  issue('sy-5', { assignee: '' }),
  issue('sy-6', { issue_type: 'epic', title: 'The board on phones' }),
  issue('sy-7', { parent: 'sy-6', assignee: 'platform' }),
]
const closed = [issue('sy-9', { status: 'closed', closed_at: iso(60) })]
const comments = [
  { id: 'c1', issue_id: 'sy-1', author: 'ops', text: 'Plan:\n\n1. step one, `bin/brain run migrations/0042-rotate.sh`\n2. rollback: `git revert` and restart\n\n```\na very long line in a code block that must scroll inside its box and never widen the page itself at all ok\n```', created_at: iso(120) },
  { id: 'c2', issue_id: 'sy-1', author: 'review', text: 'Signed off. https://example.org/a/very/long/link/that/should/wrap/somewhere/in/the/comment/and/not/push/the/page', created_at: iso(60) },
  { id: 'c3', issue_id: 'sy-1', author: 'alex', text: 'Looks fine to me.', created_at: iso(30) },
]
const events = issues.map((i, k) => ({ seq: k + 1, ts: iso(k * 7), op: 'updated', issue_id: i.id, actor: i.assignee || 'ops', issue: i }))
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8cfc0f01f0005000201' + 'e221bc330000000049454e44ae426082', 'hex')
const frame = (id, name, w, h) => ({ id, name, canvas: { id: 'Canv_00001', name: 'Board' }, how: 'link', width: w, height: h, approval: 'needs_review', updatedAt: iso(30), updatedBy: 'Design lead',
  image: `/img/${id}.png`, before: { image: `/img/${id}-b.png`, at: iso(90) }, open: 'https://doop.example.org/c/Canv_00001?frame=' + id,
  change: { versions: 3, previous: { at: iso(90), by: 'Design lead', kind: 'agent', width: 1280, height: 800 }, resized: true },
  history: null, comments: [{ id: 't1', from: 'alex', text: 'The button is too small on a phone, make it bigger please', at: iso(40), element: true, waiting: true, replies: [{ from: 'Design lead', text: 'Bigger now?', at: iso(20) }] }] })
const designs = { id: 'sy-1', available: true, me: 'alex', doop: 'https://doop.example.org', frames: [frame('Fr4me_0001', 'Board · phone · a long frame name with no-breaks-in-it-at-all-anywhere', 1440, 900), frame('Fr4me_0002', 'Item', 390, 844)], more: 1, missing: [], children: [] }
const machine = { at: new Date().toISOString(),
  brain: { ok: true, score: { total: 14, items: [[6, 'uncovered: a-service-with-a-long-name'], [8, 'lint error: memory/some/long/path/to/a/file.md: missing frontmatter']] },
    lines: [{ kind: 'alert', text: 'alert: disk /var/lib/containers at 91% (threshold 85%): prune images with podman-system-prune-all-or-so' }, { kind: 'info', text: 'info: 14 services up' }] },
  obs: { ok: true, stores: [{ store: 'logs', status: 'ok' }, { store: 'traces', status: 'ok' }, { store: 'metrics', status: 'down' }] },
  projects: [{ project: 'system', root: '/srv/x/system', processes: '4/4', ready: 'ready', self: true, logs: 120, errors: 0, failed_spans: 0 },
    { project: 'a-rather-long-project-name-with-dashes', root: '/srv/x/projects/a-rather-long-project-name-with-dashes', processes: '2/3', ready: 'degraded', logs: 3400, errors: 12, failed_spans: 3 }] }
const meta = { project: 'system', leads: { ops: { id: 'a1', name: 'ops', status: 'running' }, _workers: [{ id: 'w1', role: 'platform', status: 'running', item: 'sy-2' }] },
  states: { ops: { state: 'working', label: 'working on sy-1', item: 'sy-1' }, review: { state: 'waiting', label: 'waiting for you on sy-3', item: 'sy-3' } },
  creators: {}, last: { 'sy-1': { author: 'alex', at: iso(30) } }, panels: ['machine'], personas: null }

const json = (res, d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)) }
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname
  if (p === '/s/app.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(fs.readFileSync(path.join(GW, 'app.css'))) }
  if (p === '/s/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(GW, 'app.js'))) }
  if (p === '/s/poll') return json(res, { state: 'pending' })
  if (p.startsWith('/gw/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(GW, `${path.basename(p)}.html`))) }
  if (p.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png) }
  if (p === '/api/meta') return json(res, meta)
  if (p === '/api/whoami') return json(res, { actor: 'alex', source: 'gateway', role: 'owner', approval: 'telegram' })
  if (p === '/api/links') return json(res, { links: [] })
  if (p === '/api/presence') return json(res, { agents: [{ actor: 'ops', kind: 'lead', id: 'a1', item: 'sy-1', doing: 'reading the plan' }] })
  if (p === '/api/pull') return json(res, { title: 'not here' }, 404)
  if (p === '/api/machine') return json(res, machine)
  if (p.startsWith('/api/designs/')) return json(res, designs)
  if (p.startsWith('/api/content/')) return json(res, { files: [] })
  if (p.startsWith('/api/workers/')) return json(res, { branch: 'w-sy-1', landed: false, commits: [{ sha: 'abc1234', author: 'ops', date: iso(10), subject: 'a commit' }], stat: ' src/a-very-long-file-name-here.ts | 12 +++++-----\n 1 file changed', workers: [{ id: 'w-sy-1-a-long-worker-id', status: 'done', created: iso(50), activity: ['did a thing with a/very/long/path/that/goes/on/and/on/and/on.ts'] }] })
  if (p === '/api/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (p === '/api/v0/beads/events') return json(res, { head: events.length, records: events })
  if (p === '/api/v0/beads/issues') return json(res, { items: u.searchParams.get('status') === 'closed' ? closed : issues, has_more: false })
  if (p === '/api/v0/beads/ready') return json(res, { items: issues.filter((i) => i.status === 'open' && !i.dependencies), has_more: false })
  const m = /^\/api\/v0\/beads\/issues\/([^/:]+)$/.exec(p)
  if (m) { const i = [...issues, ...closed].find((x) => x.id === m[1]); return i ? json(res, { ...i, comments: i.id === 'sy-1' ? comments : [] }) : json(res, { title: 'no' }, 404) }
  if (p.startsWith('/api/')) return json(res, {})
  const f = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
  const file = fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`

// ---------- the checks ----------
const browser = await chromium.launch({ executablePath: exe })
const settle = (page) => page.waitForTimeout(400)
/** No sideways scroll; inputs at 16px or more; the visible controls named by `taps` at least 40px high. */
async function check(page, name, size, taps = []) {
  await settle(page)
  const m = await page.evaluate(() => {
    const de = document.documentElement
    // Wider than the screen and only cut off by the page (the open item's sheet clips sideways, so the page never
    // scrolls): a real overflow. Inside its own clipping box (a code block that scrolls, a truncated line) it is fine.
    const clippedByOwnBox = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (a.matches('[data-slot=sheet-content]')) return false
      if (getComputedStyle(a).overflowX !== 'visible') return true } return false }
    const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !clippedByOwnBox(e) })
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 70)} (right ${Math.round(e.getBoundingClientRect().right)})`)
    const small = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select')]
      .filter((e) => e.getBoundingClientRect().width && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.id}] ${getComputedStyle(e).fontSize}`)
    return { sw: de.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth, wide, small }
  })
  ok(`${name} @${size}: no sideways scroll (scrollWidth ${m.sw}, innerWidth ${m.iw})`, m.sw <= m.iw && m.bw <= m.iw, `wider: ${m.wide.slice(0, 4).join(' | ')}`)
  ok(`${name} @${size}: nothing cut off at the right edge`, m.wide.length === 0, m.wide.slice(0, 4).join(' | '))
  ok(`${name} @${size}: every input at 16px or more`, m.small.length === 0, m.small.join(' | '))
  for (const t of taps) {
    const loc = typeof t === 'string' ? page.getByRole('button', { name: t, exact: true }).first() : t.loc
    const label = typeof t === 'string' ? t : t.name
    const box = (await loc.count()) ? await loc.boundingBox() : null
    ok(`${name} @${size}: "${label}" there and thumb-sized (≥40px high)`, !!box && box.height >= 40 && box.x >= 0 && box.x + box.width <= m.iw + 1, box ? `${Math.round(box.width)}x${Math.round(box.height)} at x=${Math.round(box.x)}` : 'not found')
  }
  const file = path.join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${size}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

const shots = []
for (const [w, h] of [[390, 844], [375, 667]]) {
  const size = `${w}x${h}`
  step(`the board at ${size}`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`${BASE}/`)
  await page.getByText('Rotate the gateway key').first().waitFor({ timeout: 10000 })
  // one column at a time, chosen in the bar's picker; everything else in its menu (sy-hrsm, test/board-phone-space.mjs)
  const picker = page.getByRole('button', { name: /^Column/ })
  shots.push(await check(page, 'board', size, [{ name: 'Column picker', loc: picker }, 'Menu']))
  await picker.click()
  ok(`board @${size}: the picker offers the four columns`, (await page.getByRole('menuitemradio').count()) === 4)
  await page.getByRole('menuitemradio', { name: /In progress/ }).click()
  await page.getByText(/sy-2 A long item title/).first().waitFor({ timeout: 5000 }).catch(() => {})
  ok(`board @${size}: a pick shows its column (In progress has sy-2)`, await page.getByText(/sy-2 A long item title/).first().isVisible())
  shots.push(await check(page, 'board-tab-2', size))
  await picker.click()
  await page.getByRole('menuitemradio', { name: /Ready/ }).click()

  step(`the menu at ${size}`)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.waitForTimeout(300)
  shots.push(await check(page, 'menu', size, ['Close', { name: 'New item', loc: page.getByRole('button', { name: /New item/ }) }, { name: 'All roles', loc: page.getByRole('button', { name: /^All roles/ }) }]))

  step(`Now and Activity at ${size}`)
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: /^Now/ }).click()
  await page.waitForTimeout(300)
  shots.push(await check(page, 'now-activity', size, ['Close']))
  ok(`now @${size}: the panel covers the board`, await page.locator('#board-side').isVisible())
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  ok(`now @${size}: Close hides it`, !(await page.locator('#board-side').isVisible()))

  step(`an item at ${size}`)
  await page.goto(`${BASE}/?item=sy-1`)
  await page.getByText('Signed off.').first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(700) // the sheet slides in
  const sheet = await page.locator('[data-slot=sheet-content]').boundingBox()
  ok(`item @${size}: the item opens full screen (${sheet && Math.round(sheet.width)}px)`, !!sheet && sheet.width >= w - 1 && sheet.x <= 1)
  shots.push(await check(page, 'item', size, ['Approve on Telegram', 'Close', { name: 'Status', loc: page.locator('[data-slot=select-trigger]').first() }]))
  const ta = page.getByPlaceholder(/Write to the lead/)
  await ta.scrollIntoViewIfNeeded()
  await ta.fill('From a phone.')
  shots.push(await check(page, 'item-comment', size, ['Send']))
  await page.locator('section', { hasText: 'Designs ·' }).first().scrollIntoViewIfNeeded()
  shots.push(await check(page, 'designs', size, [{ name: 'Design tab', loc: page.getByRole('tab', { name: 'Design' }) }]))
  for (const v of ['Requirement', 'QA', 'Summary']) {
    await page.getByRole('tab', { name: v }).click()
    await check(page, `designs-${v.toLowerCase()}`, size)
  }

  step(`the Machine panel at ${size}`)
  await page.goto(`${BASE}/#machine`)
  await page.getByText('Observability').waitFor({ timeout: 10000 })
  shots.push(await check(page, 'machine', size, ['File on its board']))
  await page.getByRole('button', { name: 'File on its board' }).first().click()
  shots.push(await check(page, 'machine-file', size, ['File it']))
  ok(`board @${size}: no page error`, errs.length === 0, errs.join(' | '))
  await ctx.close()

  step(`the gateway at ${size}`)
  const g = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const gp = await g.newPage()
  for (const [n, taps] of [['home', [{ name: 'Open the board', loc: gp.getByRole('link', { name: 'Open the board' }) }, 'Sign out']],
    ['signin', ['Copy code', { name: 'Open in Telegram', loc: gp.getByRole('link', { name: 'Open in Telegram' }) }]], ['signin-nobot', ['Copy code']],
    ['continue', []], ['token', ['Replace']], ['runs', ['Ask for runs']]]) {
    await gp.goto(`${BASE}/gw/${n}`)
    shots.push(await check(gp, `gateway-${n}`, size, taps))
  }

  step(`the sign-in code at ${size} (sy-2pv9)`)
  await g.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  await gp.goto(`${BASE}/gw/signin`)
  const href = await gp.getByRole('link', { name: 'Open in Telegram' }).getAttribute('href')
  ok(`signin @${size}: the Telegram link carries the code (${href})`, href === 'https://t.me/mm_example_bot?start=ABCD-EFGH')
  ok(`signin @${size}: the hint to send it to the bot`, await gp.getByText("Send this code to the bot in Telegram, then press 'This is me' there.").isVisible())
  const code = await gp.locator('#code').evaluate((e) => { const s = getComputedStyle(e); return { sel: s.userSelect || s.webkitUserSelect, ws: s.whiteSpace, fs: parseFloat(s.fontSize) } })
  ok(`signin @${size}: the code selects whole, on one line, ≥16px (${JSON.stringify(code)})`, code.sel === 'all' && code.ws === 'nowrap' && code.fs >= 16)
  await gp.getByRole('button', { name: 'Copy code' }).click()
  await gp.getByRole('button', { name: 'Copied' }).waitFor({ timeout: 3000 }).catch(() => {})
  ok(`signin @${size}: Copy code says Copied`, (await gp.getByRole('button', { name: 'Copied' }).count()) === 1)
  ok(`signin @${size}: the clipboard has the code`, (await gp.evaluate(() => navigator.clipboard.readText()).catch((e) => String(e))) === 'ABCD-EFGH')
  await gp.waitForTimeout(2300)
  ok(`signin @${size}: back to "Copy code" after 2 s`, (await gp.getByRole('button', { name: 'Copy code' }).count()) === 1)
  await gp.goto(`${BASE}/gw/signin-nobot`)
  ok(`signin @${size}: no bot name, no Telegram button`, (await gp.getByRole('link', { name: 'Open in Telegram' }).count()) === 0)
  await g.close()
}
await browser.close()
srv.close()

// the items' share of the phone's screen, the one-row bar, its menu and filter chip (sy-hrsm): same build, own fixture
step('the items get the screen (test/board-phone-space.mjs)')
const sp = spawnSync('node', [path.join(SRC, 'test', 'board-phone-space.mjs')], { encoding: 'utf8', env: { ...process.env, BOARD_PHONE_NOBUILD: '1' } })
process.stdout.write(sp.stdout.split('\n').filter((l) => !/build the site|^\s+built$/.test(l)).join('\n'))
const sm = /(\d+) passed, (\d+) failed/.exec(sp.stdout.replace(/\x1b\[[0-9;]*m/g, ''))
if (sm) { pass += +sm[1]; fail += +sm[2] }
ok('board-phone-space ran to the end', sp.status === 0 || (sm && +sm[2] > 0), (sp.stderr || '').slice(-600))

console.log('\nscreenshots:')
for (const s of shots) console.log(`  ${s}`)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
