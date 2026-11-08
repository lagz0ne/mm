#!/usr/bin/env node
// The items get the phone's screen (sy-hrsm): the built site against a live-like fixture (seven roles with long names,
// three goals with long titles, a long project name, five people at work, items in every column; no bd, no board
// server, no live board), opened with Playwright at 390x844 and 375x667. It measures the items list's share of the
// screen on first load (from the top of the first role group to the bottom of the screen, over the viewport height)
// and fails under 80%. It also checks: the control bar is one row and at most 48px; one menu holds the role filter, the
// goals, who is at work, Now and Activity, the views, the links, New item and who you are; no filter is set on first
// load; a role filter shows as one chip inside the bar (it adds no row) and its x clears it; the bar hides on scroll
// down and comes back on scroll up without moving the list; no sideways scroll, 16px inputs, 40px+ targets.
// test/board-phone.mjs runs it after its own checks (same build).
//   node test/board-phone-space.mjs      exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...            use template/site/dist as it is
//   BOARD_PHONE_SPACE_MEASURE=1 ...      only measure and screenshot (any layout, e.g. an old build), no checks
//   BOARD_PHONE_SPACE_SHOTS=<dir>        where the screenshots go (default: a folder under the temp dir)
//   BOARD_PHONE_SPACE_TAG=<tag>          screenshot names end in -<tag> (default: after)
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const SHOTS = process.env.BOARD_PHONE_SPACE_SHOTS || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'board-phone-space-')), 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const TAG = process.env.BOARD_PHONE_SPACE_TAG || 'after'
const MEASURE = !!process.env.BOARD_PHONE_SPACE_MEASURE
const TARGET = 0.8, BAR = 48
let pass = 0, fail = 0
const ok = (d, c, more = '') => { if (MEASURE) return; c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-phone-space: ${m}\x1b[0m`); process.exit(2) }

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
const DIST = path.join(SITE, 'dist')
if (!fs.existsSync(path.join(DIST, 'index.html'))) die('no template/site/dist/index.html')

// ---------- fixture data: a live-like board ----------
const now = Date.now(), iso = (minAgo) => new Date(now - minAgo * 60e3).toISOString()
const roles = [
  { id: 'ops', title: 'Operations and site reliability engineering', initial: 'O', color: '#b91c1c' },
  { id: 'review', title: 'Security and compliance review', initial: 'R', color: '#1f5fbf' },
  { id: 'platform', title: 'Platform engineering (the mm command line)', initial: 'P', color: '#0f766e' },
  { id: 'design', title: 'Product and interaction design', initial: 'D', color: '#7c3aed' },
  { id: 'qa', title: 'Quality assurance and release testing', initial: 'Q', color: '#b45309' },
  { id: 'data', title: 'Data engineering and analytics pipelines', initial: 'A', color: '#be185d' },
  { id: 'docs', title: 'Documentation and developer relations', initial: 'W', color: '#4d7c0f' },
]
const TITLES = ['Rotate the gateway key: plan, rollback and lockout safeguard', 'The names proxy drops long-lived SSE connections after 60 s',
  'Upgrade Dolt to the next minor release on every project', 'Add a restore drill for the brain repo',
  'Board UI: the items get the screen on a phone', 'Template: pin the Paseo version in the lockfile']
let n = 0
const issue = (f = {}) => { n++; return { id: `ab-${n}`, title: TITLES[n % TITLES.length], status: 'open', priority: 2, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(300), updated_at: iso(5 + n), comment_count: n % 3, ...f } }
const epics = [
  issue({ issue_type: 'epic', title: 'The board on phones and tablets, usable with one thumb on a train' }),
  issue({ issue_type: 'epic', title: 'Backups that restore: a monthly drill on every project and the brain' }),
  issue({ issue_type: 'epic', title: 'Workers for every lead, with their own worktree and a report the lead can trust' }),
]
const work = []
for (const r of roles) for (const [status, k] of [['open', 2], ['in_progress', 1], ['blocked', 1]]) for (let j = 0; j < k; j++)
  work.push(issue({ assignee: r.id, status, priority: (n % 4), parent: epics[n % 3].id }))
work.push(issue({ assignee: '', title: 'An item with no role yet' }))
const closed = roles.flatMap((r) => [issue({ assignee: r.id, status: 'closed', closed_at: iso(60), parent: epics[0].id })])
const PROJECT = 'a-rather-long-project-name-for-the-client'
const meta = { project: PROJECT, roles, leads: { ops: { id: 'a1', name: 'ops', status: 'running' }, _workers: [{ id: 'w1', role: 'platform', status: 'running', item: work[8].id }] },
  states: { ops: { state: 'working', label: `working on ${work[0].id}`, item: work[0].id }, review: { state: 'waiting', label: `waiting for you on ${work[4].id}`, item: work[4].id } },
  creators: {}, last: {}, panels: ['machine'], personas: null }
const presence = ['ops', 'review', 'platform', 'design', 'qa'].map((a, k) => ({ actor: a, kind: 'lead', id: `a${k}`, item: work[k * 4].id, doing: 'reading the plan and writing a long comment' }))
const links = [{ name: 'doop', label: 'Designs', url: 'https://doop.example.org/' }, { name: 'grafana', label: 'Observability', url: 'https://obs.example.org/' }]
const events = work.map((i, k) => ({ seq: k + 1, ts: iso(k * 7), op: 'update', issue_id: i.id, actor: i.assignee || 'ops', issue: i }))

const json = (res, d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)) }
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname
  if (p === '/api/meta') return json(res, meta)
  // a local person (sy-c7mh: one signed in through the gateway starts on For you; test/board-for-you.mjs checks that)
  if (p === '/api/whoami') return json(res, { actor: 'alex-example-longname', source: 'self', approval: 'telegram' })
  if (p === '/api/links') return json(res, { links })
  if (p === '/api/presence') return json(res, { agents: presence })
  if (p === '/api/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (p === '/api/v0/beads/events') return json(res, { head: events.length, records: events })
  if (p === '/api/v0/beads/issues') return json(res, { items: u.searchParams.get('status') === 'closed' ? closed : [...epics, ...work], has_more: false })
  if (p === '/api/v0/beads/ready') return json(res, { items: work.filter((i) => i.status === 'open'), has_more: false })
  if (p.startsWith('/api/')) return json(res, {})
  const f = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
  const file = fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`

// ---------- the measures ----------
const browser = await chromium.launch({ executablePath: exe })
const settle = (page, ms = 400) => page.waitForTimeout(ms)
/** The items list: from the top of the first role group (everything above it is controls) to the bottom of <main> or
 *  of the screen. The bar: the header's height and whether its visible children sit on one row. */
const measure = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  const first = main?.querySelector('section')
  const mr = main?.getBoundingClientRect()
  const top = first ? Math.max(0, first.getBoundingClientRect().top) : innerHeight
  const bottom = mr ? Math.min(innerHeight, mr.bottom) : 0
  const header = document.querySelector('header')
  const hr = header?.getBoundingClientRect()
  const kids = header ? [...header.querySelectorAll(':scope > *')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height) : []
  const oneRow = kids.length > 0 && kids.every((r) => kids.every((s) => r.top < s.bottom && s.top < r.bottom))
  const de = document.documentElement
  return { share: Math.max(0, bottom - top) / innerHeight, top, barH: hr ? hr.height : 0, barBottom: hr ? hr.bottom : 0, oneRow,
    scrollTop: main?.scrollTop || 0, sideways: de.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    small: [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select')]
      .filter((e) => e.getBoundingClientRect().width && parseFloat(getComputedStyle(e).fontSize) < 16).length }
})
const shot = async (page, name) => { const f = path.join(SHOTS, `${name}-${TAG}.png`); await page.screenshot({ path: f }); return f }
const pct = (x) => `${(x * 100).toFixed(1)}%`
async function tall(page, loc, label, size) {
  const box = (await loc.count()) ? await loc.first().boundingBox() : null
  const w = page.viewportSize().width
  ok(`${size}: "${label}" there and thumb-sized (≥40px high)`, !!box && box.height >= 40 && box.x >= 0 && box.x + box.width <= w + 1, box ? `${Math.round(box.width)}x${Math.round(box.height)} at x=${Math.round(box.x)}` : 'not found')
}

const shots = [], table = []
for (const [w, h] of [[390, 844], [375, 667]]) {
  const size = `${w}x${h}`
  step(`first load at ${size}`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`${BASE}/`)
  await page.getByText(TITLES[1]).first().waitFor({ timeout: 10000 })
  await page.getByText(PROJECT).first().waitFor({ timeout: 5000 }).catch(() => {})
  await settle(page, 700)
  const m = await measure(page)
  shots.push(await shot(page, `board-${w}`))
  table.push([size, pct(m.share), `${Math.round(m.top)}px of controls`, `bar ${Math.round(m.barH)}px`])
  console.log(`  items list ${pct(m.share)} of the screen (starts at y=${Math.round(m.top)}; bar ${Math.round(m.barH)}px, ${m.oneRow ? 'one row' : 'wraps'})`)
  if (MEASURE) { await ctx.close(); continue }
  ok(`${size}: the items list takes at least ${pct(TARGET)} of the screen (${pct(m.share)})`, m.share >= TARGET)
  ok(`${size}: the control bar is at most ${BAR}px high (${Math.round(m.barH)}px)`, m.barH > 0 && m.barH <= BAR)
  ok(`${size}: the control bar is one row`, m.oneRow)
  ok(`${size}: no sideways scroll`, !m.sideways)
  ok(`${size}: the project name is in the bar`, (await page.locator('header').getByText(PROJECT).count()) === 1)
  ok(`${size}: no filter set on first load (no chip, every role's items shown)`, (await page.locator('[data-filter-chip]').count()) === 0
    && (await page.locator('main section').count()) >= roles.length)
  const picker = page.getByRole('button', { name: /^Column/ })
  await tall(page, picker, 'Column picker', size)
  await tall(page, page.getByRole('button', { name: 'Menu', exact: true }), 'Menu', size)

  step(`the column picker at ${size}`)
  await picker.click()
  await settle(page)
  const opts = page.getByRole('menuitemradio')
  ok(`${size}: the picker lists the four columns`, (await opts.count()) === 4)
  shots.push(await shot(page, `columns-${w}`))
  await page.getByRole('menuitemradio', { name: /In progress/ }).click()
  await settle(page)
  ok(`${size}: picking In progress shows that column`, /In progress/.test(await picker.innerText()) && (await page.locator('main').getByText(/^ab-\d+$/).count()) === roles.length)
  await picker.click()
  await page.getByRole('menuitemradio', { name: /Ready/ }).click()
  await settle(page)

  step(`the menu at ${size}`)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await settle(page, 600)
  const menu = page.getByRole('dialog', { name: 'Menu' })
  ok(`${size}: the menu opens`, (await menu.count()) === 1)
  for (const [label, loc] of [
    ['All roles', menu.getByRole('button', { name: /^All roles/ })],
    [roles[5].title, menu.getByRole('button', { name: new RegExp(roles[5].title) })],
    ['a goal', menu.getByRole('button', { name: new RegExp(epics[2].title) })],
    ['Now and activity', menu.getByRole('button', { name: /^Now/ })],
    ['Board', menu.getByRole('link', { name: 'Board', exact: true })],
    ['Leads', menu.getByRole('link', { name: 'Leads', exact: true })],
    ['Machine', menu.getByRole('link', { name: 'Machine', exact: true })],
    ['Designs', menu.getByRole('link', { name: /Designs/ })],
    ['New item', menu.getByRole('button', { name: /New item/ })],
    ['who you are', menu.getByRole('button', { name: /alex-example-longname/ })],
  ]) await tall(page, loc, `menu: ${label}`, size)
  ok(`${size}: the menu shows who is at work`, (await menu.getByText(/5 working/).count()) >= 1)
  const mm = await measure(page)
  ok(`${size}: menu open: no sideways scroll, inputs 16px`, !mm.sideways && mm.small === 0)
  shots.push(await shot(page, `menu-${w}`))

  step(`a role filter at ${size}`)
  await menu.getByRole('button', { name: new RegExp(roles[0].title) }).click()
  await settle(page, 600)
  const chip = page.locator('[data-filter-chip]')
  const f = await measure(page)
  ok(`${size}: the menu closes on a pick`, (await page.getByRole('dialog', { name: 'Menu' }).count()) === 0)
  ok(`${size}: the filter shows as one chip in the bar`, (await chip.count()) === 1 && (await page.locator('header [data-filter-chip]').count()) === 1)
  ok(`${size}: with the chip the bar is still one row, ≤${BAR}px (${Math.round(f.barH)}px)`, f.oneRow && f.barH <= BAR)
  ok(`${size}: only that role's items (one group)`, (await page.locator('main section').count()) === 1)
  ok(`${size}: with a filter, no sideways scroll`, !f.sideways)
  shots.push(await shot(page, `filter-chip-${w}`))
  await tall(page, page.getByRole('button', { name: /^Clear the filter/ }), 'chip x', size)
  await page.getByRole('button', { name: /^Clear the filter/ }).click()
  await settle(page)
  ok(`${size}: the chip's x clears the filter`, (await chip.count()) === 0 && (await page.locator('main section').count()) >= roles.length)

  step(`the bar on scroll at ${size}`)
  const before = await measure(page)
  await page.locator('main').evaluate((e) => e.scrollBy(0, 200))
  await settle(page, 500)
  await page.locator('main').evaluate((e) => e.scrollBy(0, 200))
  await settle(page, 500)
  const down = await measure(page)
  ok(`${size}: scrolled down, the bar hides (bottom at ${Math.round(down.barBottom)}px)`, down.scrollTop > 0 && down.barBottom <= 1)
  shots.push(await shot(page, `bar-hidden-${w}`))
  await page.locator('main').evaluate((e) => e.scrollBy(0, -60))
  await settle(page, 500)
  const up = await measure(page)
  ok(`${size}: scrolled up a little, the bar is back (bottom at ${Math.round(up.barBottom)}px)`, Math.abs(up.barBottom - before.barBottom) <= 1)
  ok(`${size}: the list did not jump (scrollTop ${Math.round(down.scrollTop)} → ${Math.round(up.scrollTop)})`, Math.abs(down.scrollTop - 60 - up.scrollTop) <= 2)

  step(`Now and Activity, New item at ${size}`)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await settle(page, 600)
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: /^Now/ }).click()
  await settle(page, 600)
  ok(`${size}: Now and Activity opens from the menu`, await page.locator('#board-side').isVisible())
  await tall(page, page.locator('#board-side').getByRole('button', { name: 'Close', exact: true }), 'Close (Now)', size)
  await page.locator('#board-side').getByRole('button', { name: 'Close', exact: true }).click()
  await settle(page)
  ok(`${size}: Close hides it`, !(await page.locator('#board-side').isVisible()))
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await settle(page, 600)
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: /New item/ }).click()
  await settle(page, 600)
  ok(`${size}: New item opens from the menu`, (await page.getByRole('dialog').filter({ hasText: /New item/ }).count()) >= 1)
  ok(`${size}: no page error`, errs.length === 0, errs.join(' | '))
  await ctx.close()
}
await browser.close()
srv.close()

console.log('\nitems list share of the screen on first load:')
for (const r of table) console.log(`  ${r[0].padEnd(10)} ${r[1].padEnd(7)} ${r[2].padEnd(18)} ${r[3]}`)
console.log('\nscreenshots:')
for (const s of shots) console.log(`  ${s}`)
if (MEASURE) process.exit(0)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
