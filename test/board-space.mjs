#!/usr/bin/env node
// The board gets the screen (sy-p88g): the built site against fixture data (no bd, no board server, no live board),
// opened with Playwright at desktop and tablet sizes. It measures the board's share of the screen (the visible part of
// the columns' area, <main>, over the viewport) and fails under 85% at 1280x800, 1440x900 and 1920x1080 with the side
// panel closed. It also checks: the header is one line; the goals are one chip (no strip) whose menu lists them all,
// and no chip when there is no goal; Now and Activity are closed by default, open docked beside the board on desktop
// (an overlay drawer on a tablet), and the choice is remembered across a reload; the role column folds to avatars;
// cards keep a readable width. Screenshots go to a folder under the temp dir; their paths and the shares are printed.
//   node test/board-space.mjs            exit 0 = every check passed
//   BOARD_SPACE_NOBUILD=1 ...            use template/site/dist as it is
//   BOARD_SPACE_MEASURE=1 ...            only measure and screenshot (any layout, e.g. an old build), no checks
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-space-'))
const SHOTS = path.join(T, 'shots')
fs.mkdirSync(SHOTS)
const MEASURE = !!process.env.BOARD_SPACE_MEASURE
const TARGET = 0.85
let pass = 0, fail = 0
const ok = (d, c, more = '') => { if (MEASURE) return; c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-space: ${m}\x1b[0m`); process.exit(2) }

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
if (!process.env.BOARD_SPACE_NOBUILD) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: SITE, encoding: 'utf8' })
  if (b.status !== 0) { console.log((b.stdout + b.stderr).slice(-800)); die('npm run build failed') }
  console.log('  built')
}
const DIST = path.join(SITE, 'dist')
if (!fs.existsSync(path.join(DIST, 'index.html'))) die('no template/site/dist/index.html')

// ---------- fixture data: a busy board (five roles, three goals, normal titles) ----------
const now = Date.now(), iso = (minAgo) => new Date(now - minAgo * 60e3).toISOString()
const roles = [
  { id: 'ops', title: 'Ops & SRE', initial: 'O', color: '#b91c1c' },
  { id: 'review', title: 'Security & compliance review', initial: 'R', color: '#1f5fbf' },
  { id: 'platform', title: 'Platform (mm)', initial: 'P', color: '#0f766e' },
  { id: 'design', title: 'Design', initial: 'D', color: '#7c3aed' },
  { id: 'qa', title: 'QA', initial: 'Q', color: '#b45309' },
]
const TITLES = ['Rotate the gateway key: plan, rollback and lockout safeguard', 'Board UI: give the space to the board',
  'Upgrade Dolt to the next minor release on every project', 'Add a restore drill for the brain repo',
  'The names proxy drops long-lived SSE connections after 60 s', 'Template: pin the Paseo version in the lockfile']
let n = 0
const issue = (f = {}) => { n++; return { id: `sy-${n}`, title: TITLES[n % TITLES.length], status: 'open', priority: 2, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(300), updated_at: iso(5 + n), comment_count: n % 3, ...f } }
const epics = [
  issue({ issue_type: 'epic', title: 'The board on phones and tablets' }),
  issue({ issue_type: 'epic', title: 'Backups that restore: drills on every project' }),
  issue({ issue_type: 'epic', title: 'Workers for every lead' }),
]
const work = []
for (const r of roles) for (const [status, k] of [['open', 2], ['in_progress', 1], ['blocked', 1]]) for (let j = 0; j < k; j++)
  work.push(issue({ assignee: r.id, status, priority: (n % 4), parent: epics[n % 3].id }))
work.push(issue({ assignee: '', title: 'An item with no role yet' }))
const closed = roles.flatMap((r) => [issue({ assignee: r.id, status: 'closed', closed_at: iso(60), parent: epics[0].id })])
const meta = { project: 'system', roles, leads: { ops: { id: 'a1', name: 'ops', status: 'running' }, _workers: [{ id: 'w1', role: 'platform', status: 'running', item: work[8].id }] },
  states: { ops: { state: 'working', label: `working on ${work[0].id}`, item: work[0].id }, review: { state: 'waiting', label: `waiting for you on ${work[4].id}`, item: work[4].id } },
  creators: {}, last: {}, panels: ['machine'], personas: null }
let withGoals = true
const openIssues = () => [...(withGoals ? epics : []), ...work]
const events = work.map((i, k) => ({ seq: k + 1, ts: iso(k * 7), op: 'update', issue_id: i.id, actor: i.assignee || 'ops', issue: i }))

const json = (res, d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)) }
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname
  if (p === '/api/meta') return json(res, meta)
  if (p === '/api/whoami') return json(res, { actor: 'alex', source: 'gateway', role: 'owner', approval: 'telegram' })
  if (p === '/api/links') return json(res, { links: [] })
  if (p === '/api/presence') return json(res, { agents: [{ actor: 'ops', kind: 'lead', id: 'a1', item: work[0].id, doing: 'reading the plan' }] })
  if (p === '/api/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (p === '/api/v0/beads/events') return json(res, { head: events.length, records: events })
  if (p === '/api/v0/beads/issues') return json(res, { items: u.searchParams.get('status') === 'closed' ? closed : openIssues(), has_more: false })
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
const settle = (page) => page.waitForTimeout(400)
async function measure(page) {
  return page.evaluate(() => {
    const vis = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); return { w, h, top: r.top, left: r.left, area: w * h } }
    const main = vis(document.querySelector('main'))
    const header = vis(document.querySelector('header'))
    const side = document.querySelector('#board-side')
    const sideShown = !!side && getComputedStyle(side).display !== 'none' && side.getBoundingClientRect().width > 0
    // the cards in the first (Ready) column of the grid: their width
    const cards = [...document.querySelectorAll('main button[draggable]')].map((c) => c.getBoundingClientRect().width).filter(Boolean)
    const scrim = document.querySelector('[data-side-scrim]')
    return { share: main ? main.area / (innerWidth * innerHeight) : 0, mainW: main?.w, mainTop: main?.top, headerH: header?.h, sideShown,
      sideW: sideShown ? side.getBoundingClientRect().width : 0, scrim: !!scrim && getComputedStyle(scrim).display !== 'none',
      minCard: cards.length ? Math.min(...cards) : 0 }
  })
}
const shot = async (page, name) => { const f = path.join(SHOTS, `${name}.png`); await page.screenshot({ path: f }); return f }
const pct = (x) => `${(x * 100).toFixed(1)}%`

const shots = [], table = []
for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], [1024, 768]]) {
  const size = `${w}x${h}`, desk = w >= 1280
  step(`the board at ${size}`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  withGoals = true
  await page.goto(`${BASE}/`)
  await page.getByText(TITLES[1]).first().waitFor({ timeout: 10000 })
  await settle(page)
  const m = await measure(page)
  shots.push(await shot(page, `board-${size}`))
  table.push([size, 'side closed', pct(m.share)])
  console.log(`  board share ${pct(m.share)} (main ${Math.round(m.mainW)}px wide from y=${Math.round(m.mainTop)}; header ${Math.round(m.headerH)}px; narrowest card ${Math.round(m.minCard)}px)`)
  if (MEASURE) { await ctx.close(); continue }
  if (desk) ok(`board @${size}: the board takes at least ${pct(TARGET)} of the screen (${pct(m.share)})`, m.share >= TARGET)
  ok(`board @${size}: Now and Activity closed by default`, !m.sideShown)
  ok(`board @${size}: the header is one line (${Math.round(m.headerH)}px ≤ 48px)`, m.headerH <= 48)
  ok(`board @${size}: no goal strip above the board (the board starts at y=${Math.round(m.mainTop)} ≤ 120)`, m.mainTop <= 120)
  ok(`board @${size}: cards readable (narrowest ${Math.round(m.minCard)}px ≥ 180px)`, m.minCard >= 180)

  step(`goals at ${size}`)
  const chip = page.getByRole('button', { name: /^Goal/ })
  ok(`goals @${size}: one goal chip in the header`, (await chip.count()) === 1)
  if (await chip.count()) {
    ok(`goals @${size}: the chip names the first goal and its progress`, /The board on phones and tablets[\s\S]*\d+\/\d+/.test(await chip.innerText()), await chip.innerText())
    await chip.click()
    await settle(page)
    const menu = page.getByRole('dialog', { name: 'Goals' })
    ok(`goals @${size}: its menu lists every goal`, (await menu.count()) === 1 && (await menu.getByRole('button').count()) === 3)
    shots.push(await shot(page, `goals-${size}`))
    await page.keyboard.press('Escape')
  }

  step(`Now and Activity at ${size}`)
  const toggle = page.locator('button[aria-controls=board-side]')
  ok(`now @${size}: the toggle is there`, (await toggle.count()) === 1 && (await toggle.isVisible()))
  await toggle.click()
  await settle(page)
  const o = await measure(page)
  shots.push(await shot(page, `now-open-${size}`))
  table.push([size, 'side open', pct(o.share)])
  ok(`now @${size}: opens`, o.sideShown)
  if (desk) {
    ok(`now @${size}: docked beside the board (no scrim; the board narrows by the panel, ${Math.round(m.mainW)} → ${Math.round(o.mainW)})`, !o.scrim && Math.abs(m.mainW - o.mainW - o.sideW) <= 2)
    await page.reload()
    await page.getByText(TITLES[1]).first().waitFor({ timeout: 10000 })
    await settle(page)
    ok(`now @${size}: still open after a reload (remembered)`, (await measure(page)).sideShown)
    await page.locator('button[aria-controls=board-side]').click()
    await settle(page)
    await page.reload()
    await page.getByText(TITLES[1]).first().waitFor({ timeout: 10000 })
    await settle(page)
    ok(`now @${size}: closed after a reload once closed`, !(await measure(page)).sideShown)
  } else {
    ok(`now @${size}: an overlay drawer over the board (the board keeps its width)`, o.scrim && Math.abs(m.mainW - o.mainW) <= 2)
    await page.keyboard.press('Escape')
    await settle(page)
    ok(`now @${size}: Escape closes it`, !(await measure(page)).sideShown)
  }

  step(`the role column at ${size}`)
  const fold = page.getByRole('button', { name: /roles? column/i })
  ok(`roles @${size}: a toggle folds the role column`, (await fold.count()) === 1)
  if (await fold.count()) {
    const before = (await measure(page)).minCard
    await fold.click()
    await settle(page)
    const after = (await measure(page)).minCard
    ok(`roles @${size}: folded, the cards get wider (${Math.round(before)} → ${Math.round(after)}px)`, after > before)
    shots.push(await shot(page, `roles-folded-${size}`))
    await fold.click()
  }

  step(`no goal at ${size}`)
  withGoals = false
  await page.reload()
  await page.getByText(TITLES[1]).first().waitFor({ timeout: 10000 })
  await settle(page)
  ok(`goals @${size}: no chip when there is no goal`, (await page.getByRole('button', { name: /^Goal/ }).count()) === 0)
  ok(`board @${size}: no page error`, errs.length === 0, errs.join(' | '))
  await ctx.close()
}

// the phone, measured only (test/board-phone.mjs checks it)
{
  withGoals = true
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/`)
  await page.getByRole('button', { name: /^Column/ }).waitFor({ timeout: 10000 })
  await settle(page)
  const m = await measure(page)
  table.push(['390x844', 'phone', pct(m.share)])
  shots.push(await shot(page, 'board-390x844'))
  await ctx.close()
}
await browser.close()
srv.close()

console.log('\nboard share of the screen:')
for (const [s, k, v] of table) console.log(`  ${s.padEnd(10)} ${k.padEnd(12)} ${v}`)
console.log('\nscreenshots:')
for (const s of shots) console.log(`  ${s}`)
if (MEASURE) process.exit(0)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
