#!/usr/bin/env node
// An item's links on the board (sy-x7kh), at 1280x800 and 390x844 (Playwright). Hover a card: what it waits on (its
// blocker) and what waits on it (its dependent) are marked, each its own color and line, each with its tag in words
// ("blocks t-2", "waits on t-2"); its child in a quiet third style; the rest dims; no fetch per hover (the edges come
// with the board's list). Links with no card in sight (an epic, a filtered-out item, a dependent the list does not hold)
// show as "+n linked, not shown" on the hovered card. On a phone: a long press marks, a tap elsewhere clears, a tap
// still opens the item. The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve and
// Paseo.
//   node test/board-links.mjs        exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...        use template/site/dist as it is
//   BOARD_LINKS_SHOTS=<dir>          where the screenshots go (kept; default: a folder under the temp dir)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-links-'))
const SHOTS = process.env.BOARD_LINKS_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-links: ${m}\x1b[0m`); process.exit(2) }
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

// ---------- the items, as bd serve lists them: each with its own outgoing edges and its dependent_count ----------
//  t-2 waits on t-1 (blocks); t-3 waits on t-2. t-5 is a child of the epic t-e (not on the board), has a child t-7,
//  a dependent t-6, and one more dependent the list does not hold (dependent_count 2). t-4 is linked to nothing.
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const edge = (from, to, type) => ({ issue_id: from, depends_on_id: to, type, created_at: iso(60), created_by: 'alex', metadata: '{}' })
const item = (id, title, more = {}) => ({ id, title, status: 'open', priority: 2, issue_type: 'task', labels: [], created_at: iso(120), updated_at: iso(5),
  dependency_count: 0, dependent_count: 0, comment_count: 0, ...more })
const ITEMS = [
  item('t-1', 'Blocker item', { assignee: 'ops', dependent_count: 1 }),
  item('t-2', 'Hovered item', { assignee: 'platform', dependencies: [edge('t-2', 't-1', 'blocks')], dependency_count: 1, dependent_count: 1 }),
  item('t-3', 'Dependent item', { assignee: 'review', dependencies: [edge('t-3', 't-2', 'blocks')], dependency_count: 1 }),
  item('t-4', 'Unrelated item', { assignee: 'ops' }),
  item('t-5', 'Lonely item', { assignee: 'platform', parent: 't-e', dependencies: [edge('t-5', 't-e', 'parent-child')], dependent_count: 2 }),
  item('t-6', 'Hidden dependent', { assignee: 'review', dependencies: [edge('t-6', 't-5', 'blocks')], dependency_count: 1 }),
  item('t-7', 'Child item', { assignee: 'ops', parent: 't-5', dependencies: [edge('t-7', 't-5', 'parent-child')] }),
  item('t-e', 'The epic', { issue_type: 'epic' }),
]
const READY = ['t-1', 't-4', 't-5', 't-7', 't-e']
let listCalls = 0
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname.startsWith('/v0/beads/issues') || u.pathname === '/v0/beads/ready') listCalls++
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? [] : ITEMS, has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: ITEMS.filter((i) => READY.includes(i.id)).map(({ dependencies, ...i }) => i), has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = ITEMS.find((x) => x.id === m[1]); return i ? json({ ...i, comments: [] }) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

// ---------- the board: the real server.mjs ----------
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'lk', MM_PROJECT: 'lk' } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const BASE = `http://127.0.0.1:${PORT}`

const browser = await chromium.launch({ executablePath: exe })
const card = (page, id) => page.locator(`[data-card="${id}"]`)
const links = (page) => page.locator('[data-card]').evaluateAll((es) => Object.fromEntries(es.map((e) => [e.getAttribute('data-card'), e.getAttribute('data-link') || ''])))
const look = (page, id) => card(page, id).evaluate((e) => { const s = getComputedStyle(e); return { color: s.outlineColor, style: s.outlineStyle, opacity: Number(s.opacity) } })
const tag = async (page, id) => ((await card(page, id).locator('[data-link-tag]').textContent().catch(() => '')) || '').trim()
const hidden = async (page, id) => Number((await card(page, id).locator('[data-links-hidden]').getAttribute('data-links-hidden', { timeout: 500 }).catch(() => '0')) || 0)
const grey = (c) => {
  const o = /oklch\(([\d.]+) ([\d.]+)/.exec(c); if (o) return +o[2] < 0.03 // a computed color may stay in oklch (no chroma: grey)
  const m =/rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(c); return !!m && Math.max(+m[1], +m[2], +m[3]) - Math.min(+m[1], +m[2], +m[3]) < 12 }
try {
  // ---------- 1280: hover ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    step('1280 px: hover t-2 (waits on t-1, t-3 waits on it)')
    await page.goto(BASE)
    await card(page, 't-7').waitFor({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(400)
    ok('no card is marked before a hover', Object.values(await links(page)).every((v) => !v))
    const before = listCalls
    await card(page, 't-2').hover()
    await page.waitForTimeout(250)
    const l = await links(page)
    ok('t-2 is the marked card; t-1 its blocker, t-3 its dependent', l['t-2'] === 'self' && l['t-1'] === 'blocker' && l['t-3'] === 'dependent', JSON.stringify(l))
    ok('...2 cards marked as linked', Object.values(l).filter((v) => v === 'blocker' || v === 'dependent').length === 2, JSON.stringify(l))
    ok('...the others dimmed (t-4, t-5, t-6, t-7)', ['t-4', 't-5', 't-6', 't-7'].every((id) => l[id] === 'dim'), JSON.stringify(l))
    const a = await look(page, 't-1'), b = await look(page, 't-3'), d = await look(page, 't-4')
    ok('two colors, neither grey, and two lines (solid, dashed)', a.color !== b.color && !grey(a.color) && !grey(b.color) && a.style === 'solid' && b.style === 'dashed', `${JSON.stringify(a)} ${JSON.stringify(b)}`)
    ok('a dimmed card is fainter than a marked one', d.opacity < 0.6 && a.opacity === 1 && b.opacity === 1, `${d.opacity} ${a.opacity} ${b.opacity}`)
    const ta = await tag(page, 't-1'), tb = await tag(page, 't-3')
    ok('the tags, in words: "blocks t-2", "waits on t-2"', ta === 'blocks t-2' && tb === 'waits on t-2', `${ta} | ${tb}`)
    ok('no tag on the dimmed cards nor on t-2', (await page.locator('[data-card="t-4"] [data-link-tag], [data-card="t-2"] [data-link-tag]').count()) === 0)
    ok('every link of t-2 is in sight: no "not shown" count', (await hidden(page, 't-2')) === 0)
    await page.screenshot({ path: path.join(SHOTS, 'links-1280.png') })

    step('1280 px: hover t-5 (its epic off the board, a child, a dependent, one dependent not in the list)')
    await card(page, 't-5').hover()
    await page.waitForTimeout(250)
    const l5 = await links(page)
    ok('t-7 marked as its child (the quiet style), t-6 as its dependent', l5['t-7'] === 'child' && l5['t-6'] === 'dependent' && l5['t-2'] === 'dim', JSON.stringify(l5))
    const c7 = await look(page, 't-7')
    ok('...the child: dotted, grey', c7.style === 'dotted' && grey(c7.color), JSON.stringify(c7))
    ok('...its tag: "child of t-5"', (await tag(page, 't-7')) === 'child of t-5')
    const h5 = await hidden(page, 't-5')
    ok('"+2 linked, not shown" (the epic, and the dependent the list lacks)', h5 === 2 && /\+2 linked, not shown/.test((await card(page, 't-5').textContent()) || ''), String(h5))
    await page.screenshot({ path: path.join(SHOTS, 'links-1280-offscreen.png') })
    await page.mouse.move(5, 790)
    await page.waitForTimeout(200)
    ok('the mouse off the cards: no mark', Object.values(await links(page)).every((v) => !v), JSON.stringify(await links(page)))

    step('1280 px: filtered out')
    await page.locator('input[type=search], input[placeholder]').first().fill('Lonely')
    await page.waitForTimeout(300)
    await card(page, 't-5').hover()
    await page.waitForTimeout(250)
    const hf = await hidden(page, 't-5')
    ok('with a search that shows t-5 alone: "+4 linked, not shown" (t-6 and t-7 filtered out too)', hf === 4, String(hf))
    ok('no fetch for the hovers (the list carries the edges)', listCalls === before, `${listCalls - before} list calls`)
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await ctx.close()
  }

  // ---------- 390: long press ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    const cdp = await ctx.newCDPSession(page)
    const press = async (id, ms) => {
      const bx = await card(page, id).boundingBox()
      const p = { x: bx.x + bx.width / 2, y: bx.y + bx.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] })
      await sleep(ms)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(300)
    }
    step('390 px: long press t-5 (the Ready column)')
    await page.goto(BASE)
    await card(page, 't-5').waitFor({ timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(400)
    await press('t-5', 700)
    const l = await links(page)
    ok('a long press marks: t-5 itself, t-7 its child; t-1 and t-4 dimmed', l['t-5'] === 'self' && l['t-7'] === 'child' && l['t-1'] === 'dim' && l['t-4'] === 'dim', JSON.stringify(l))
    ok('...the long press did not open the item', (await page.locator('[data-slot=sheet-content]').count()) === 0)
    ok('...its tag: "child of t-5"', (await tag(page, 't-7')) === 'child of t-5')
    const h = await hidden(page, 't-5')
    ok('"+3 linked, not shown" (t-6 is in another column, the epic, one not in the list)', h === 3, String(h))
    ok('no sideways scroll', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)))
    await page.screenshot({ path: path.join(SHOTS, 'links-390.png') })
    ok('the marks stay after the finger lifts', (await links(page))['t-7'] === 'child')
    await page.touchscreen.tap(380, 836)
    await page.waitForTimeout(250)
    ok('a tap off the cards clears them', Object.values(await links(page)).every((v) => !v), JSON.stringify(await links(page)))

    step('390 px: a tap still opens the item')
    await card(page, 't-1').tap()
    await page.locator('[data-slot=sheet-content]').waitFor({ timeout: 5000 }).catch(() => {})
    ok('a tap on t-1 opens it', (await page.locator('[data-slot=sheet-content]').count()) === 1 && /t-1/.test(page.url() + ((await page.locator('[data-slot=sheet-content]').textContent().catch(() => '')) || '')))
    ok('...and marks nothing', Object.values(await links(page)).every((v) => !v))
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await ctx.close()
  }
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
  if (fail) console.log(out.slice(-1500))
  console.log(`  shots: ${SHOTS}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (!process.env.BOARD_LINKS_SHOTS) fs.rmSync(T, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
