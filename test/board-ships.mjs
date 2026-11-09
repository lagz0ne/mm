#!/usr/bin/env node
// Work that waits only for its rollout is not blocked (sy-7n3c), at 1280x800 and 390x844 (Playwright). An item whose
// every open blocker is a rollout item (label act:project-rollout or act:project-rollout-t2) shows "Ships with <id>",
// never "blocked", below the real waits of its cell; an item that also waits on a normal item stays blocked; the Waiting
// count counts only the real waits (the rest quietly: "· n ship next"). The labels come with the board's list: no fetch
// per card. The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve and Paseo.
//   node test/board-ships.mjs        exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...        use template/site/dist as it is
//   BOARD_SHIPS_SHOTS=<dir>          where the screenshots go (kept; default: a folder under the temp dir)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ships-'))
const SHOTS = process.env.BOARD_SHIPS_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-ships: ${m}\x1b[0m`); process.exit(2) }
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
const env = { ...process.env, HOME: path.join(T, 'home'), MM_HOME: path.join(T, 'home', '.mm'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'MM_SERVICE', 'MM_BIND']) delete env[k]
fs.mkdirSync(env.HOME)

// ---------- the items, as bd serve lists them ----------
//  r-1, r-2: rollout items (the two labels). b-1: a normal item. c-1: a normal item, closed.
//  s-1 (blocked) waits on r-1: ships. s-2 waits on r-1 and r-2: ships with both. s-3 waits on r-2 and the closed c-1: ships.
//  w-1 (blocked) waits on r-1 and b-1: blocked. w-2 waits on b-1: a real wait (open, not ready).
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const edge = (from, to, type = 'blocks') => ({ issue_id: from, depends_on_id: to, type, created_at: iso(60), created_by: 'alex', metadata: '{}' })
const item = (id, title, more = {}) => ({ id, title, status: 'open', priority: 2, issue_type: 'task', labels: [], created_at: iso(120), updated_at: iso(5),
  dependency_count: 0, dependent_count: 0, comment_count: 0, ...more })
const deps = (id, ...to) => ({ dependencies: to.map((t) => edge(id, t)), dependency_count: to.length })
const ITEMS = [
  item('r-1', 'Roll out the template', { assignee: 'ops', labels: ['act:project-rollout'] }),
  item('r-2', 'Roll out the T2 change', { assignee: 'ops', labels: ['act:project-rollout-t2', 't2'] }),
  item('b-1', 'A normal blocker', { assignee: 'review' }),
  item('s-1', 'Landed, waits for its rollout', { assignee: 'platform', status: 'blocked', priority: 1, ...deps('s-1', 'r-1') }),
  item('s-2', 'Landed, waits for two rollouts', { assignee: 'platform', ...deps('s-2', 'r-1', 'r-2') }),
  item('s-3', 'Landed, its other blocker closed', { assignee: 'review', ...deps('s-3', 'r-2', 'c-1') }),
  item('w-1', 'Waits on a rollout and a normal item', { assignee: 'platform', status: 'blocked', priority: 3, ...deps('w-1', 'r-1', 'b-1') }),
  item('w-2', 'Waits on a normal item', { assignee: 'ops', ...deps('w-2', 'b-1') }),
]
const CLOSED = [item('c-1', 'A closed blocker', { assignee: 'review', status: 'closed', closed_at: iso(30) })]
const READY = ['r-1', 'r-2', 'b-1']
let itemCalls = 0
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? CLOSED : ITEMS, has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: ITEMS.filter((i) => READY.includes(i.id)).map(({ dependencies, ...i }) => i), has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { itemCalls++; const i = [...ITEMS, ...CLOSED].find((x) => x.id === m[1]); return i ? json({ ...i, comments: [] }) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

// ---------- the board: the real server.mjs ----------
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'sh', MM_PROJECT: 'sh' } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const BASE = `http://127.0.0.1:${PORT}`

const browser = await chromium.launch({ executablePath: exe })
const card = (page, id) => page.locator(`[data-card="${id}"]`)
const ships = (page, id) => card(page, id).locator('[data-ships]').getAttribute('data-ships', { timeout: 500 }).catch(() => null)
const text = async (page, id) => ((await card(page, id).textContent().catch(() => '')) || '').replace(/\s+/g, ' ')
const order = (page) => page.locator('[data-card]').evaluateAll((es) => es.map((e) => e.getAttribute('data-card')))
async function cards(page, label) {
  step(`${label}: the cards`)
  ok('s-1 (blocked, waits only on r-1): "Ships with r-1"', (await ships(page, 's-1')) === 'r-1' && /Ships with r-1/.test(await text(page, 's-1')), await text(page, 's-1'))
  ok('...not "blocked", and no "waits on" line', !/blocked|waits on/i.test(await text(page, 's-1')), await text(page, 's-1'))
  ok('s-2 (two rollouts, both labels): "Ships with r-1, r-2"', (await ships(page, 's-2')) === 'r-1 r-2' && /Ships with r-1, r-2/.test(await text(page, 's-2')), await text(page, 's-2'))
  ok('s-3 (a rollout and a closed blocker): ships with r-2', (await ships(page, 's-3')) === 'r-2', String(await ships(page, 's-3')))
  ok('w-1 (a rollout and a normal blocker): blocked, no "Ships with"', (await ships(page, 'w-1')) === null && /blocked/i.test(await text(page, 'w-1')) && /waits on r-1, b-1/.test(await text(page, 'w-1')), await text(page, 'w-1'))
  ok('w-2 (a normal blocker): "waits on b-1", no "Ships with"', (await ships(page, 'w-2')) === null && /waits on b-1/.test(await text(page, 'w-2')), await text(page, 'w-2'))
  ok('the rollout items themselves show no chip', (await ships(page, 'r-1')) === null && (await ships(page, 'r-2')) === null)
  ok('no sideways scroll', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)))
}
try {
  // ---------- 1280 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(BASE)
    await card(page, 'w-2').waitFor({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(400)
    await cards(page, '1280 px')
    step('1280 px: the Waiting column and its count')
    const head = ((await page.locator('[data-count=waiting]').textContent()) || '').trim()
    ok('the Waiting count counts the real waits only: 2 (w-1, w-2), then "· 3 ship next"', /^2\b/.test(head) && /3 ship next/.test(head), head)
    ok('...the ships count as data: 3', (await page.locator('[data-ships-count]').getAttribute('data-ships-count')) === '3')
    const o = await order(page)
    ok('in platform\'s Waiting cell the real wait comes first: w-1 (P3) before s-1 (P1) and s-2', o.indexOf('w-1') < o.indexOf('s-1') && o.indexOf('w-1') < o.indexOf('s-2'), o.join(' '))
    ok('the shipping items stay in the Waiting column (to the right of Ready)', await page.evaluate(() => {
      const x = (id) => document.querySelector(`[data-card="${id}"]`).getBoundingClientRect().x
      return Math.abs(x('s-1') - x('w-1')) < 2 && x('s-1') > x('r-1')
    }))
    ok('no fetch per card (the labels come with the list)', itemCalls === 0, `${itemCalls} item fetches`)
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await page.screenshot({ path: path.join(SHOTS, 'ships-1280.png') })
    await ctx.close()
  }

  // ---------- 390 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(BASE)
    await card(page, 'r-1').waitFor({ timeout: 10000 }).catch(() => {})
    const picker = page.getByRole('button', { name: /^Column/ })
    await picker.click()
    const wItem = page.getByRole('menuitemradio', { name: /Waiting/ })
    const wText = ((await wItem.textContent()) || '').replace(/\s+/g, ' ')
    ok('390 px: the picker counts 2 for Waiting (the real waits)', /Waiting\s*2$/.test(wText), wText)
    await wItem.click()
    await card(page, 'w-2').waitFor({ timeout: 5000 }).catch(() => {})
    await page.mouse.move(385, 840) // the menu's click leaves the mouse over a card: off it, so it marks no links
    await page.waitForTimeout(300)
    ok('...its label says 2 items', /Waiting, 2 items/.test((await picker.getAttribute('aria-label')) || ''), await picker.getAttribute('aria-label'))
    await cards(page, '390 px')
    const o = await order(page)
    ok('in platform\'s group the real wait comes first: w-1 before s-1 and s-2', o.indexOf('w-1') < o.indexOf('s-1') && o.indexOf('w-1') < o.indexOf('s-2'), o.join(' '))
    const bx = await card(page, 's-2').locator('[data-ships]').boundingBox(), cb = await card(page, 's-2').boundingBox()
    ok('the chip fits in its card', !!bx && !!cb && bx.x >= cb.x && bx.x + bx.width <= cb.x + cb.width + 0.5, JSON.stringify({ bx, cb }))
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await page.screenshot({ path: path.join(SHOTS, 'ships-390.png') })
    await ctx.close()
  }
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
  if (fail) console.log(out.slice(-1500))
  console.log(`  shots: ${SHOTS}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (!process.env.BOARD_SHIPS_SHOTS) fs.rmSync(T, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
