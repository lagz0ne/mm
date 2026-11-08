#!/usr/bin/env node
// The owner card on the board (sy-z5lz), at 390x844 (Playwright): the item's detail shows the card first, as a box
// at the top (each key in bold, the value as text, Link a link), the description below it without the card; an invalid
// card shows what it read and "card invalid: <reason>"; a needs-you item with no card says "card missing"; an item
// without needs-you and without a card shows nothing more. No sideways scroll. Then the owner's "Waiting for you" list:
// the board's /api/waiting (the real server.mjs, signed in as the owner on its public side) sends each item's You line,
// and the gateway's home page (src/auth.ts, rendered with bun from that answer) shows it, or "card missing".
// The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve and Paseo; no bd, no
// live board, no gateway running.
//   node test/board-owner-card.mjs     exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...          use template/site/dist as it is
//   BOARD_CARD_SHOTS=<dir>             where the screenshots go (default: a folder under the temp dir)
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-owner-card-'))
const SHOTS = process.env.BOARD_CARD_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-owner-card: ${m}\x1b[0m`); process.exit(2) }
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

step('build the site')
if (!process.env.BOARD_PHONE_NOBUILD) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: SITE, encoding: 'utf8' })
  if (b.status !== 0) { console.log((b.stdout + b.stderr).slice(-800)); die('npm run build failed') }
  console.log('  built')
}
if (!fs.existsSync(path.join(SITE, 'dist', 'index.html'))) die('no template/site/dist/index.html')

// ---------- a board: the template's site (built) and bin ----------
const B = path.join(T, 'board')
fs.cpSync(SITE, path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'ops' }, { id: 'review' }, { id: 'platform' }] }))
fs.mkdirSync(path.join(B, 'artifacts', 'oc-1'), { recursive: true })
fs.writeFileSync(path.join(B, 'artifacts', 'oc-1', 'plan.md'), '# The plan\n\nOne card per ask.\n')
const env = { ...process.env, HOME: path.join(T, 'home'), MM_HOME: path.join(T, 'home', '.mm'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'MM_SERVICE', 'MM_BIND']) delete env[k]
fs.mkdirSync(env.HOME)

// ---------- the items: cards as written by hand, an invalid one, none ----------
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const base = { status: 'open', priority: 2, issue_type: 'task', assignee: 'platform', created_at: iso(300), comments: [] }
const CARD = `## Owner
- **What:** A fixed short card like this one at the top of each item that needs you, also sent to Telegram as written.
- **Why:** You see in 6 lines what is asked and why, without reading the agents' threads.
- **You:** Reply: ok, or say which line to change.
- **Link:** artifacts/oc-1/plan.md

The owner asked for output that is "loud and clear, correct and enough". Plan: the steps in the linked file.`
const BAD = `## Owner
- **What:** Open the mail port to the relay so the alerts can leave the machine.
- **Why:** The alerts stay on the board only.
- **You:** Tap Approve
- **If yes:** Ops opens the port and tests one alert.
- **Risk:** some, a wrong rule can close a port

The plan and its rollback: plans/mail.md.`
const ITEMS = [
  { ...base, id: 'oc-1', title: 'The owner card on every item that needs you', labels: ['needs-you'], updated_at: iso(95), description: CARD },
  { ...base, id: 'oc-2', title: 'Open the mail port', labels: ['needs-you', 't2', 'signed-off'], updated_at: iso(40), description: BAD },
  { ...base, id: 'oc-3', title: 'Pick a name for the new service', labels: ['needs-you'], updated_at: iso(20), description: 'Which name do we take? The options are in the thread.' },
  { ...base, id: 'oc-4', title: 'Plain work, nobody asked', labels: [], updated_at: iso(10), description: 'Refactor the list.' },
]
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? [] : ITEMS.map(({ comments, ...i }) => ({ ...i, comment_count: comments.length })), has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: ITEMS, has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = ITEMS.find((x) => x.id === m[1]); return i ? json(i) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

// ---------- the board: the real server.mjs ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-oc.example.org'
const sign = (u, r) => { const b = Buffer.from(JSON.stringify({ u, r, h: HOST, exp: Date.now() + 60000, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'oc', MM_PROJECT: 'oc',
  BOARD_PUBLIC_PORT: String(PPORT), MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const BASE = `http://127.0.0.1:${PORT}`
const getPublic = (p, headers) => new Promise((ok_, no) => {
  const r = http.request({ host: '127.0.0.1', port: PPORT, path: p, method: 'GET', headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok_({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
  })
  r.on('error', no); r.end()
})

const browser = await chromium.launch({ executablePath: exe })
const noSideways = (page) => page.evaluate(() => {
  const sheet = document.querySelector('[data-slot="sheet-content"]')
  const box = document.querySelector('[data-owner-card]')
  return { doc: document.documentElement.scrollWidth > innerWidth, sheet: sheet ? sheet.scrollWidth > sheet.clientWidth + 1 : false, card: box ? box.scrollWidth > box.clientWidth + 1 : false }
})
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))

  step('a valid card (oc-1): a box first, keys in bold, the rest below without the card')
  await page.goto(`${BASE}/?item=oc-1`)
  const box = page.locator('[data-owner-card]')
  await box.waitFor({ timeout: 10000 }).catch(() => {})
  ok('a card box, valid', (await box.count()) === 1 && (await box.getAttribute('data-owner-card')) === 'ok')
  if (!(await box.count())) { await page.screenshot({ path: path.join(SHOTS, 'debug-no-card.png') }); throw new Error(`no card box; page errors: ${errs.join(' | ')}`) }
  const keys = await box.locator('dt').allTextContents()
  ok('its keys in order: What, Why, You, Link', keys.join() === 'What,Why,You,Link', keys.join())
  ok('...each key in bold', (await box.locator('dt').evaluateAll((ds) => ds.every((d) => Number(getComputedStyle(d).fontWeight) >= 700))))
  ok('...the values as written (plain text)', (await box.locator('[data-key="You"] dd').textContent()) === 'Reply: ok, or say which line to change.'
    && (await box.locator('[data-key="Why"] dd').textContent()) === 'You see in 6 lines what is asked and why, without reading the agents\' threads.')
  await page.waitForTimeout(600) // the sheet's slide-in
  const status = page.getByText('Status', { exact: true }).first()
  const [bb, sb] = [await box.boundingBox(), await status.boundingBox()]
  ok('the card is first: above the status, the role and the description', !!bb && !!sb && bb.y < sb.y, `${bb?.y} ${sb?.y}`)
  ok('...on the first screen (its top within 844 px)', !!bb && bb.y < 400 && bb.x >= 0 && bb.x + bb.width <= 391, JSON.stringify(bb))
  const desc = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Description$/ }) })
  const dtext = (await desc.textContent()) || ''
  ok('the description shows the rest, without the card repeated', dtext.includes('loud and clear, correct and enough') && !dtext.includes('A fixed short card') && !/What:|## Owner/.test(dtext), dtext.slice(0, 200))
  const link = box.locator('[data-key="Link"] dd button')
  ok('Link is a link (it opens the artifact)', (await link.count()) === 1 && (await link.textContent()) === 'artifacts/oc-1/plan.md')
  ok('no sideways scroll (page, sheet, card)', Object.values(await noSideways(page)).every((v) => !v), JSON.stringify(await noSideways(page)))
  ok('no "card invalid" note', (await page.locator('[data-owner-card-note]').count()) === 0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'card-valid-390.png') })
  await link.click()
  const dlg = page.getByRole('dialog', { name: 'artifacts/oc-1/plan.md' })
  ok('...a tap opens it in the viewer', await dlg.getByRole('heading', { name: 'The plan' }).waitFor({ timeout: 5000 }).then(() => true, () => false))
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)

  step('an invalid card (oc-2, t2): what it read, and "card invalid: <reason>"')
  await page.goto(`${BASE}/?item=oc-2`)
  await page.locator('[data-owner-card]').waitFor({ timeout: 10000 }).catch(() => {})
  ok('a card box, invalid', (await page.locator('[data-owner-card]').getAttribute('data-owner-card')) === 'invalid')
  const note = (await page.locator('[data-owner-card-note]').textContent()) || ''
  ok('the note names each reason', note.startsWith('card invalid: ') && /Risk does not start with low, medium or high/.test(note) && /If no is missing \(required with t2\)/.test(note), note)
  ok('...what it read still shows', (await page.locator('[data-owner-card] [data-key="You"] dd').textContent()) === 'Tap Approve')
  ok('no sideways scroll', Object.values(await noSideways(page)).every((v) => !v), JSON.stringify(await noSideways(page)))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'card-invalid-390.png') })

  step('needs-you with no card (oc-3): "card missing"; no needs-you, no card (oc-4): nothing')
  await page.goto(`${BASE}/?item=oc-3`)
  await page.locator('[data-owner-card]').waitFor({ timeout: 10000 }).catch(() => {})
  ok('"card missing"', (await page.locator('[data-owner-card="missing"]').count()) === 1 && /^card missing/.test((await page.locator('[data-owner-card="missing"]').textContent()) || ''))
  ok('...the description as it is', ((await page.locator('section').filter({ has: page.getByRole('heading', { name: /^Description$/ }) }).textContent()) || '').includes('Which name do we take?'))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'card-missing-390.png') })
  await page.goto(`${BASE}/?item=oc-4`)
  await page.getByText('Refactor the list.').first().waitFor({ timeout: 10000 }).catch(() => {})
  ok('no box, no note', (await page.locator('[data-owner-card]').count()) === 0)
  ok('no page error', errs.length === 0, errs.join(' | '))
  await ctx.close()

  step('the owner\'s "Waiting for you": the board sends each You line, the gateway shows it')
  const w = await getPublic('/api/waiting', { host: HOST, 'x-mm-assertion': sign('boss', 'owner') })
  const wl = w.status === 200 ? JSON.parse(w.body) : null
  ok('the board\'s /api/waiting for the owner: oc-1, oc-2, oc-3 (oldest first)', wl?.items.map((x) => x.id).join() === 'oc-1,oc-2,oc-3', w.body.slice(0, 300))
  ok('...each with its You line: the card\'s, the invalid card\'s, null for none', wl?.items[0].you === 'Reply: ok, or say which line to change.' && wl?.items[1].you === 'Tap Approve' && wl?.items[2].you === null)
  // the gateway's home page, rendered from that answer (src/auth.ts: waitingOf checks it, the page shows it)
  fs.writeFileSync(path.join(T, 'answer.json'), w.body)
  fs.writeFileSync(path.join(T, 'render.ts'), `import { readFileSync } from 'node:fs'
import { pagesForTest, waitingOf } from '${path.join(SRC, 'src', 'auth.ts')}'
const w = waitingOf(JSON.parse(readFileSync(process.argv[2], 'utf8')), true)
const s = { open: 4, p0: 0, blocked: 0, needs_you: 3, mine: 0, approvals: 1, needs_you_min: 95, last: new Date().toISOString() }
const html = pagesForTest.home('boss', [{ project: 'acme-shop', host: 'board-oc.example.org', role: 'owner', s, w, older: false }] as never)
console.log(JSON.stringify({ html, css: pagesForTest.css }))
`)
  const r = spawnSync('bun', [path.join(T, 'render.ts'), path.join(T, 'answer.json')], { encoding: 'utf8', env })
  let page2
  if (r.status !== 0) ok('the gateway\'s page renders (bun)', false, r.stderr.slice(-600))
  else {
    const { html, css } = JSON.parse(r.stdout)
    ok('the gateway\'s page renders, with each You line, and "card missing" for oc-3', html.includes('<span class="w-you">You: Reply: ok, or say which line to change.</span>') && html.includes('<span class="w-you">You: Tap Approve</span>')
      && /<span class="w-title">Pick a name for the new service<\/span><span class="w-you none">card missing<\/span>/.test(html))
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    page2 = await pctx.newPage()
    await page2.setContent(html.replace('<link rel="stylesheet" href="/s/app.css">', `<style>${css}</style>`))
    const rows = page2.locator('.w-list li')
    ok('three rows, each with its You line in view', (await rows.count()) === 3 && (await page2.locator('.w-you').count()) === 3)
    const ys = await page2.locator('.w-you').evaluateAll((es) => es.map((e) => { const b = e.getBoundingClientRect(); return [b.left, b.right] }))
    ok('...on the phone\'s width, no sideways scroll', ys.every(([l, rr]) => l >= 0 && rr <= 391) && !(await page2.evaluate(() => document.documentElement.scrollWidth > innerWidth)), JSON.stringify(ys))
    await page2.screenshot({ path: path.join(SHOTS, 'waiting-you-390.png') })
    await pctx.close()
  }
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
}
console.log('\nscreenshots:')
for (const f of fs.readdirSync(SHOTS)) console.log(`  ${path.join(SHOTS, f)}`)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
fs.rmSync(B, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
