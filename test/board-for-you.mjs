#!/usr/bin/env node
// The human's board (sy-c7mh): For you first, a minimal top bar. First the To review rules (site/review.mjs, pure).
// Then the built site and the real site/server.mjs (copies, in a temp folder) against a stand-in bd serve (items and an
// event log) and Paseo, opened with Playwright on the public side (the gateway's signed assertion) at 390x844 and
// 1280x800:
//   the bar   one row: the project's name, For you, Board, Needs you (N; always there, "Needs you" with no number at
//             0; it opens the Needs you list), ⋯ (no column counts, no toolbar row); the menu holds the rest (search,
//             roles, Now/Activity, Leads, Glossary, links, New, the name and live state, sign out)
//   For you   the start page, two parts only: Needs you and To review (closed or handed over, with an artifact or a
//             card, newest first, thumbnails; Seen clears it and it stays cleared); their empty states. Each Needs you
//             card leads with the action, in this order at both widths: the You line as the headline, its one button
//             large (Approve and Not now for a T2 go; why not, in Approve's place, for a refused head; a Reply box;
//             Done; a t2 non-go ask: its Done, never Approve), then What and Why in smaller text, the link last
//   Board     behind its tab, the full board; a filter set in the menu shows as a line with Clear
// and a lead's local side (no assertion) unchanged: the old header and toolbar, no For you. No sideways scroll; and with
// long content (a long URL, Head, command, a title with no spaces) at 360, 390 and 430 px, For you, the board and an
// open item stay inside the screen, the page's scroll boxes too (sy-hl2t; a failure names the widest element).
//   node test/board-for-you.mjs        exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...          use template/site/dist as it is
//   BOARD_FORYOU_SHOTS=<dir>           where the screenshots go (default: a folder under the temp dir)
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-for-you-'))
const SHOTS = process.env.BOARD_FORYOU_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-for-you: ${m}\x1b[0m`); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()

// ---------- the fixtures ----------
const GO = `## Owner
- **What:** Open the mail port to the relay so the alerts can leave the machine.
- **Why:** The alerts stay on the board only.
- **You:** Tap Approve in Telegram, or press Approve on this item
- **If yes:** Ops opens the port and tests one alert.
- **If no:** The alerts stay on the board.
- **Risk:** low, one rule with a rollback
- **Head:** brain@abc1234

The plan: plans/mail.md.`
const REFUSED = GO.replace('Open the mail port', 'Open the web port').replace('brain@abc1234', 'brain@def5678')
const REPLY = `## Owner
- **What:** Pick the name of the new service.
- **Why:** The name goes in every link.
- **You:** Reply: the name you want, or ok for "relay".`
const CHECK = `## Owner
- **What:** The new board on your phone.
- **Why:** You asked for it.
- **You:** Check: open the board on your phone, at the link below.`
const T2_CHECK = `## Owner
- **What:** The new login works for the backup host.
- **Why:** The backups move to it next.
- **You:** Check: sign in on the backup host and say if it worked.`
const DONE_CARD = `## Owner
- **What:** The alerts now reach your Telegram.
- **Why:** You asked for alerts on the phone.
- **You:** Nothing`
const base = { status: 'open', priority: 2, issue_type: 'task', assignee: 'ops', created_at: iso(3000), comments: [] }
const OPEN = [
  { ...base, id: 'fy-1', title: 'Open the mail port', labels: ['t2', 'needs-you', 'signed-off', 'signed-head:brain@abc1234'], updated_at: iso(120), description: GO },
  { ...base, id: 'fy-2', title: 'Open the web port', labels: ['t2', 'needs-you', 'signed-off', 'signed-head:brain@abc1234'], updated_at: iso(100), description: REFUSED },
  { ...base, id: 'fy-3', title: 'Name the new service', labels: ['needs-you'], updated_at: iso(80), description: REPLY },
  { ...base, id: 'fy-4', title: 'Check the new board', labels: ['needs-you'], updated_at: iso(60), description: CHECK },
  { ...base, id: 'fy-11', title: 'Try the backup login', labels: ['t2', 'needs-you', 'signed-off'], updated_at: iso(50), description: T2_CHECK },
  { ...base, id: 'fy-6', title: 'Review the posture report', assignee: 'review', labels: [], updated_at: iso(30), description: DONE_CARD },
  { ...base, id: 'fy-8', title: 'Plain work handed on, no card, no artifact', assignee: 'review', labels: [], updated_at: iso(25), description: 'Refactor.' },
  { ...base, id: 'fy-9', title: 'Work for mia', assignee: 'mia', labels: [], updated_at: iso(15), description: 'Mia looks at it.' },
]
const CLOSED = [
  { ...base, id: 'fy-5', title: 'Alerts to Telegram', status: 'closed', labels: [], updated_at: iso(40), closed_at: iso(40), description: DONE_CARD },
  { ...base, id: 'fy-7', title: 'Board screenshots', status: 'closed', labels: [], updated_at: iso(20), closed_at: iso(20), description: 'Shots in the artifacts.' },
  { ...base, id: 'fy-10', title: 'Closed long ago', status: 'closed', labels: [], updated_at: iso(3 * 1440), closed_at: iso(3 * 1440), description: DONE_CARD },
]
const snap = (i, more = {}) => ({ id: i.id, title: i.title, description: i.description, status: i.status, issue_type: i.issue_type, assignee: i.assignee, labels: i.labels, ...more })
const all = Object.fromEntries([...OPEN, ...CLOSED].map((i) => [i.id, i]))
let seq = 0
const ev = (min, op, id, actor, more = {}) => ({ seq: ++seq, ts: iso(min), op, issue_id: id, actor, issue: snap(all[id], more) })
const EVENTS = [
  ev(3000, 'create', 'fy-6', 'ops', { assignee: 'ops', status: 'open' }),
  ev(3000, 'create', 'fy-8', 'ops', { assignee: 'ops', status: 'open' }),
  ev(3000, 'create', 'fy-5', 'ops', { assignee: 'ops', status: 'open' }),
  ev(3000, 'create', 'fy-7', 'platform', { assignee: 'platform', status: 'open' }),
  ev(3000, 'create', 'fy-1', 'ops', { assignee: 'ops' }),
  ev(3 * 1440, 'close', 'fy-10', 'ops'),
  ev(40, 'close', 'fy-5', 'ops'),
  ev(30, 'update', 'fy-6', 'ops', { assignee: 'review' }),
  ev(25, 'update', 'fy-8', 'ops', { assignee: 'review' }),
  ev(22, 'update', 'fy-1', 'review', { assignee: 'ops' }), // a sign-off: the assignee did not change, not a handover
  ev(20, 'close', 'fy-7', 'platform'),
]
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

// ---------- the To review rules (pure) ----------
step('To review: the rules (site/review.mjs)')
const { toReview } = await import(path.join(SITE, 'review.mjs'))
const arts = { 'fy-7': [{ name: 'after.png', path: 'artifacts/fy-7/after.png', type: 'image/png' }, { name: 'log.txt', path: 'artifacts/fy-7/log.txt', type: 'text/plain' }, { name: 'before.png', path: 'artifacts/fy-7/before.png', type: 'image/png' }] }
const since = Date.now() - 1440 * 60e3
let r = toReview({ events: EVENTS, items: OPEN, artifacts: arts, since })
ok('closed with an artifact (fy-7), handed with a card (fy-6), closed with a card (fy-5): newest first', r.items.map((x) => x.id).join() === 'fy-7,fy-6,fy-5', r.items.map((x) => x.id).join())
ok('...not: handed with neither (fy-8), a sign-off on an item that kept its assignee (fy-1), closed before the mark (fy-10)', !r.items.some((x) => ['fy-8', 'fy-1', 'fy-10'].includes(x.id)))
ok('...each says what happened and who: fy-6 handed to review by ops, fy-7 closed by platform', r.items[1].kind === 'handed' && r.items[1].to === 'review' && r.items[1].by === 'ops' && r.items[0].kind === 'closed' && r.items[0].by === 'platform')
ok('...the artifacts images first, the card\'s fields', r.items[0].artifacts.map((a) => a.name).join() === 'after.png,before.png,log.txt' && r.items[0].files === 3 && r.items[2].card?.what === 'The alerts now reach your Telegram.')
r = toReview({ events: [...EVENTS, { seq: 99, ts: iso(5), op: 'reopen', issue_id: 'fy-5', actor: 'ops', issue: snap(all['fy-5'], { status: 'open' }) }], items: [...OPEN, { ...all['fy-5'], status: 'open' }], artifacts: arts, since })
ok('a closed item reopened since: out', !r.items.some((x) => x.id === 'fy-5'))
r = toReview({ events: EVENTS.filter((e) => !(e.issue_id === 'fy-6' && e.op === 'create')), items: OPEN, artifacts: arts, since })
ok('a handover with no earlier snapshot (nobody knows who held it): not counted', !r.items.some((x) => x.id === 'fy-6'))
r = toReview({ events: EVENTS, items: OPEN, artifacts: arts, since: Date.now() - 21 * 60e3 })
ok('since: only what came after it', r.items.map((x) => x.id).join() === 'fy-7')

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

// ---------- a board: the template's site (built) and bin, with fy-7's artifacts ----------
const B = path.join(T, 'board')
fs.cpSync(SITE, path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'ops', title: 'Ops', initial: 'O' }, { id: 'review', title: 'Review', initial: 'R' }, { id: 'platform', title: 'Platform', initial: 'P' }] }))
// the gateway's home page (mm writes it next to its key): the menu's sign out links there
fs.mkdirSync(path.join(B, '.run'), { recursive: true })
fs.writeFileSync(path.join(B, '.run', 'endpoints.json'), JSON.stringify({ services: {}, auth: { home: 'https://auth.example.org/' } }))
fs.mkdirSync(path.join(B, 'artifacts', 'fy-7'), { recursive: true })
for (const n of ['after.png', 'before.png']) fs.writeFileSync(path.join(B, 'artifacts', 'fy-7', n), PNG)
fs.writeFileSync(path.join(B, 'artifacts', 'fy-7', 'log.txt'), 'all green\n')
const env = { ...process.env, HOME: path.join(T, 'home'), MM_HOME: path.join(T, 'home', '.mm'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'MM_SERVICE', 'MM_BIND']) delete env[k]
fs.mkdirSync(env.HOME)

const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  const list = (xs) => xs.map(({ comments, ...i }) => ({ ...i, comment_count: comments.length }))
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') {
    const s = Number(u.searchParams.get('since') || 0), n = Number(u.searchParams.get('limit') || 40)
    return json({ head: seq, records: EVENTS.filter((e) => e.seq > s).slice(0, n) })
  }
  if (u.pathname === '/v0/beads/issues') return json({ items: list(u.searchParams.get('status') === 'closed' ? CLOSED : OPEN), has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: list(OPEN.filter((i) => !i.labels.includes('needs-you'))), has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = all[m[1]]; return i ? json(i) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((ok_) => bdSrv.listen(0, '127.0.0.1', ok_))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-fy.example.org'
const sign = (u, role) => { const b = Buffer.from(JSON.stringify({ u, r: role, h: HOST, exp: Date.now() + 3600e3, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((ok_) => p.listen(0, '127.0.0.1', ok_)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'fy', MM_PROJECT: 'fy',
  BOARD_PUBLIC_PORT: String(PPORT), MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const LOCAL = `http://127.0.0.1:${PORT}`, PUB = `http://127.0.0.1:${PPORT}`

step('the server: /api/to-review on the public side')
const tr = await fetch(`${PUB}/api/to-review?since=${since}`, { headers: { 'x-forwarded-host': HOST, 'x-mm-assertion': sign('boss', 'owner') } }).then((x) => x.json()).catch((e) => ({ error: String(e) }))
ok('fy-7, fy-6, fy-5, with fy-7\'s artifacts from the board\'s folder', tr.items?.map((x) => x.id).join() === 'fy-7,fy-6,fy-5' && tr.items[0].artifacts.length === 3, JSON.stringify(tr).slice(0, 300))
const tr2 = await fetch(`${PUB}/api/to-review?since=1`, { headers: { 'x-forwarded-host': HOST, 'x-mm-assertion': sign('boss', 'owner') } }).then((x) => x.json()).catch(() => ({}))
ok('...never more than 7 days back (since=1 is cut to the floor)', Date.parse(tr2.since) > Date.now() - 7.01 * 86400e3 && tr2.items?.some((x) => x.id === 'fy-10'), tr2.since)
const nope = await fetch(`${PUB}/api/to-review`, { headers: { 'x-forwarded-host': HOST } }).then((x) => x.status)
ok('...nothing without the gateway\'s assertion', nope === 401, String(nope))

const browser = await chromium.launch({ executablePath: exe })
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
// the bar's controls: everything a person can act on in the header (the open menu's sheet is not inside it)
const barControls = (page) => page.locator('[data-human-bar]').evaluate((h) => ({
  controls: [...h.querySelectorAll('a,button,input,select,textarea,[role=button],[tabindex]:not([tabindex="-1"])')].map((e) => e.getAttribute('data-bar') || e.textContent.trim().slice(0, 20)),
  h1: h.querySelectorAll('h1').length, height: h.getBoundingClientRect().height,
}))
const human = async (who, role, width, height) => {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}),
    extraHTTPHeaders: { 'x-forwarded-host': HOST, 'x-mm-assertion': sign(who, role) } })
  const page = await ctx.newPage(), errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  return { ctx, page, errs }
}
try {
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    step(`the owner at ${width} px: the bar and For you`)
    const { ctx, page, errs } = await human('boss', 'owner', width, height)
    await page.goto(`${PUB}/`)
    await page.locator('[data-for-you] [data-needs-you]').first().waitFor({ timeout: 10000 }).catch(() => {})
    const bar = await barControls(page).catch(() => null)
    ok('the bar: the name, For you, Board, Needs you, the menu: nothing else', !!bar && bar.h1 === 1 && bar.controls.join() === 'for-you,board,needs-you,menu', JSON.stringify(bar))
    ok('...one row (48 px), no column counts, no toolbar row', !!bar && bar.height <= 50 && (await page.locator('dl dt', { hasText: /^Ready$/ }).count()) === 0
      && (await page.getByRole('button', { name: /^New$/ }).count()) === 0 && (await page.getByPlaceholder('Search').count()) === 0)
    ok('...For you is the start page (no hash)', (await page.locator('[data-bar="for-you"]').getAttribute('aria-current')) === 'page'
      && (await page.locator('[data-bar="for-you"]').textContent()) === 'For you')
    const nb = page.locator('[data-bar="needs-you"]'), nbb = await nb.boundingBox()
    ok('...Needs you, with its count: 5', (await nb.textContent()) === 'Needs you5' && (await nb.getAttribute('aria-label')) === 'Needs you: 5')
    ok(`...in the bar, whole, on the screen at ${width} px (36 px+ high)`, !!nbb && nbb.x >= 0 && nbb.x + nbb.width <= width && nbb.y >= 0 && nbb.y + nbb.height <= 50 && nbb.height >= 36, JSON.stringify(nbb))
    const needs = await page.locator('[data-needs-you]').evaluateAll((as) => as.map((a) => a.getAttribute('data-needs-you')))
    ok('Needs you: the five asks, oldest first', needs.join() === 'fy-1,fy-2,fy-3,fy-4,fy-11', needs.join())
    // a card's parts, in the page's order and on the screen top to bottom; and the action's controls, in order
    const shape = (id) => page.locator(`[data-needs-you="${id}"]`).evaluate((a) => {
      const parts = [...a.querySelectorAll('[data-part]')]
      const tops = parts.map((p) => p.getBoundingClientRect().top)
      const you = a.querySelector('[data-you]'), dd = a.querySelector('[data-part="details"] dd')
      return { parts: parts.map((p) => p.getAttribute('data-part')), down: tops.every((t, i) => i === 0 || t > tops[i - 1]),
        you: you?.textContent || '', youPx: you ? parseFloat(getComputedStyle(you).fontSize) : 0, detailPx: dd ? parseFloat(getComputedStyle(dd).fontSize) : 0,
        act: [...a.querySelectorAll('[data-part="act"] > *')].map((e) => e.getAttribute('data-act') || e.getAttribute('data-head-refused') !== null && 'refused' || e.tagName.toLowerCase()),
        keys: [...a.querySelectorAll('[data-part="details"] dt')].map((e) => e.textContent), link: a.querySelector('[data-part="link"]')?.textContent || '' }
    })
    const s1 = await shape('fy-1')
    ok('each card leads with the action: You, the action, What/Why, the link: in that order, top to bottom', s1.parts.join() === 'you,act,details,link' && s1.down, JSON.stringify(s1))
    ok('...the headline is the You line, larger than the details', s1.you === 'Tap Approve in Telegram, or press Approve on this item' && s1.youPx >= 20 && s1.detailPx > 0 && s1.detailPx < s1.youPx, JSON.stringify(s1))
    ok('...What and Why below it (and a go\'s If yes, If no, Risk), You not repeated', s1.keys.join() === 'What,Why,If yes,If no,Risk')
    ok('...the link last: the item\'s title', /Open the mail port/.test(s1.link))
    ok('...a T2 go: Approve first, then Not now, nothing else', s1.act.join() === 'approve,not-now', s1.act.join())
    const ab = await page.locator('[data-needs-you="fy-1"] [data-act="approve"]').boundingBox(), nn = await page.locator('[data-needs-you="fy-1"] [data-act="not-now"]').boundingBox()
    ok('...Approve is the large button (48 px+, larger than Not now)', !!ab && !!nn && ab.height >= 48 && ab.width * ab.height > nn.width * nn.height, JSON.stringify({ ab, nn }))
    const s2 = await shape('fy-2')
    ok('...a head review did not sign: its reason in Approve\'s place, no Approve, no Not now', s2.parts.join() === 'you,act,details,link' && s2.act.join() === 'refused'
      && ((await page.locator('[data-needs-you="fy-2"] [data-head-refused]').textContent()) || '').startsWith('No go yet: '), JSON.stringify(s2))
    const s3 = await shape('fy-3')
    ok('...Reply: the headline, then a reply box and Send, then What/Why', s3.parts.join() === 'you,act,details,link' && s3.down && s3.act.join() === 'label,reply-text,reply' && s3.you.startsWith('Reply: '), JSON.stringify(s3))
    const s4 = await shape('fy-4')
    ok('...Check: Done', s4.parts.join() === 'you,act,details,link' && s4.act.join() === 'done', JSON.stringify(s4))
    const s11 = await shape('fy-11')
    ok('...a t2 non-go ask (Check:, signed off): Done, never Approve or Not now', s11.act.join() === 'done' && (await page.locator('[data-needs-you="fy-11"] [data-act="approve"], [data-needs-you="fy-11"] [data-act="not-now"]').count()) === 0, JSON.stringify(s11))
    const db = await page.locator('[data-needs-you="fy-4"] [data-act="done"]').boundingBox()
    ok('...Done is a large button too (48 px+)', !!db && db.height >= 48, JSON.stringify(db))
    await page.locator('[data-to-review]').first().waitFor({ timeout: 10000 }).catch(() => {})
    const rev = await page.locator('[data-to-review]').evaluateAll((as) => as.map((a) => a.getAttribute('data-to-review')))
    ok('To review: fy-7, fy-6, fy-5, newest first (the first visit: the last day)', rev.join() === 'fy-7,fy-6,fy-5', rev.join())
    ok('...fy-7 with its two thumbnails and "+1 more file"', (await page.locator('[data-to-review="fy-7"] [data-thumbs] img').count()) === 2 && ((await page.locator('[data-to-review="fy-7"]').textContent()) || '').includes('+1 more file'))
    ok('...fy-6 says it was handed to review, with the card\'s What', /Handed to review/i.test((await page.locator('[data-to-review="fy-6"]').textContent()) || '') && ((await page.locator('[data-to-review="fy-6"]').textContent()) || '').includes('The alerts now reach your Telegram.'))
    ok('nothing else on the page (two parts: Needs you, To review)', (await page.locator('[data-for-you] h2').allTextContents()).map((t) => t.replace(/\d+$/, '')).join() === 'Needs you,To review')
    ok('no sideways scroll', !(await sideways(page)))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `for-you-owner-${width}.png`), fullPage: true })

    await page.locator('[data-to-review="fy-6"] [data-act="seen"]').click()
    ok('Seen clears it', (await page.locator('[data-to-review="fy-6"]').count()) === 0)
    await page.reload()
    await page.locator('[data-to-review]').first().waitFor({ timeout: 10000 }).catch(() => {})
    ok('...and it stays cleared after a reload', (await page.locator('[data-to-review]').evaluateAll((as) => as.map((a) => a.getAttribute('data-to-review')))).join() === 'fy-7,fy-5')
    await page.locator('[data-to-review="fy-7"] > button').first().click()
    ok('a tap on a To review card opens the item', await page.locator('[data-slot="sheet-content"]').getByText('Board screenshots').first().waitFor({ timeout: 8000 }).then(() => true, () => false))
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)

    step(`the owner at ${width} px: the menu and the board`)
    await page.locator('[data-bar="menu"]').click()
    const sheet = page.locator('[data-slot="sheet-content"]')
    await sheet.waitFor({ timeout: 5000 }).catch(() => {})
    const txt = (await sheet.textContent()) || ''
    ok('the menu holds the rest: search, roles, Now/Activity, Leads, Glossary, New item, the name', (await sheet.locator('[data-menu-search]').count()) === 1 && /All roles/.test(txt) && /Activity/.test(txt)
      && (await sheet.getByRole('link', { name: 'Leads' }).count()) === 1 && (await sheet.getByRole('link', { name: 'Glossary' }).count()) === 1 && /New item/.test(txt) && /boss/.test(txt))
    ok('...and sign out, on the gateway\'s home page', (await sheet.locator('[data-sign-out]').getAttribute('href').catch(() => null)) === 'https://auth.example.org/')
    const roleBtns =await sheet.locator('button[aria-pressed]').allTextContents()
    ok('...the roles in it: All roles, ops, review, platform, no role', roleBtns.length === 5, JSON.stringify(roleBtns))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `menu-owner-${width}.png`) })
    await sheet.locator('button[aria-pressed]').nth(1).click()
    await page.waitForTimeout(400)
    ok('a role picked in the menu opens the board, filtered, with a line to clear it', page.url().endsWith('#board') && (await page.locator('[data-filter-line]').count()) === 1
      && (await page.locator('[data-bar="board"]').getAttribute('aria-current')) === 'page')
    const bar2 = await barControls(page).catch(() => null)
    ok('...the bar on the board: still the same controls', !!bar2 && bar2.controls.join() === 'for-you,board,needs-you,menu', JSON.stringify(bar2))
    await page.locator('[data-filter-line] button').click()
    ok('...Clear takes the filter away', (await page.locator('[data-filter-line]').count()) === 0)
    ok('the board shows the items', await page.getByText('Plain work handed on, no card, no artifact').first().waitFor({ timeout: 5000 }).then(() => true, () => false))
    ok('...no sideways scroll', !(await sideways(page)))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `board-owner-${width}.png`) })
    await page.locator('[data-bar="needs-you"]').click()
    await page.waitForTimeout(400)
    const top = await page.locator('#needs-you').boundingBox()
    ok('Needs you from the board: opens the Needs you list, at the top of the screen', page.url().endsWith('#needs-you') && (await page.locator('[data-bar="for-you"]').getAttribute('aria-current')) === 'page'
      && !!top && top.y >= 40 && top.y < 120 && (await page.locator('[data-needs-you]').count()) === 5, JSON.stringify({ url: page.url(), top }))
    await page.locator('[data-for-you]').evaluate(() => document.querySelector('main')?.scrollTo(0, 99999))
    await page.locator('[data-bar="needs-you"]').click()
    await page.waitForTimeout(400)
    const top2 = await page.locator('#needs-you').boundingBox()
    ok('...again from For you, scrolled down: back at the list', !!top2 && top2.y >= 40 && top2.y < 120, JSON.stringify(top2))
    ok('no page error', errs.length === 0, errs.join(' | '))
    await ctx.close()
  }

  step('a member at 390 px: only their own items; nothing to approve')
  {
    const { ctx, page, errs } = await human('mia', 'member', 390, 844)
    await page.goto(`${PUB}/`)
    await page.locator('[data-needs-you]').first().waitFor({ timeout: 10000 }).catch(() => {})
    ok('Needs you: the open item assigned to mia only', (await page.locator('[data-needs-you]').evaluateAll((as) => as.map((a) => a.getAttribute('data-needs-you')))).join() === 'fy-9')
    ok('...no owner actions for a member', (await page.locator('[data-needs-you] [data-act]').count()) === 0)
    ok('...Needs you says 1', (await page.locator('[data-bar="needs-you"]').textContent()) === 'Needs you1')
    const sm = await page.locator('[data-needs-you="fy-9"]').evaluate((a) => [...a.querySelectorAll('[data-part]')].map((p) => p.getAttribute('data-part')).join())
    ok('...the card: its headline (the title: no card), the link; no action', sm === 'you,link', sm)
    ok('no page error', errs.length === 0, errs.join(' | '))
    await ctx.close()
  }
  step('a viewer at 390 px: the empty states')
  {
    const { ctx, page, errs } = await human('vic', 'viewer', 390, 844)
    await page.addInitScript(() => localStorage.setItem('for-you:fy:vic:since', String(Date.now() - 60e3)))
    await page.goto(`${PUB}/`)
    await page.locator('[data-empty="to-review"]').waitFor({ timeout: 10000 }).catch(() => {})
    ok('"Nothing needs you." and "Nothing new."', (await page.locator('[data-empty="needs-you"]').textContent()) === 'Nothing needs you.' && (await page.locator('[data-empty="to-review"]').textContent()) === 'Nothing new.')
    ok('...Needs you still in the bar, with no number', (await page.locator('[data-bar="needs-you"]').textContent()) === 'Needs you' && (await page.locator('[data-bar="needs-you"]').isVisible()))
    await page.screenshot({ path: path.join(SHOTS, 'for-you-empty-390.png') })
    ok('no page error', errs.length === 0, errs.join(' | '))
    await ctx.close()
  }

  for (const [width, height] of [[390, 844], [1280, 800]]) {
    step(`a lead's local side at ${width} px: unchanged`)
    const ctx = await browser.newContext({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) })
    await ctx.addCookies([{ name: 'board_user', value: 'alex', url: LOCAL }])
    const page = await ctx.newPage()
    await page.goto(`${LOCAL}/`)
    await page.getByText('Plain work handed on, no card, no artifact').first().waitFor({ timeout: 10000 }).catch(() => {})
    ok('no human bar, no For you', (await page.locator('[data-human-bar]').count()) === 0 && (await page.locator('[data-for-you]').count()) === 0)
    if (width > 500) ok('...the old header (Board, Leads tabs) and the toolbar (roles, Search, New)', (await page.getByRole('link', { name: /^board$/i }).count()) === 1
      && (await page.getByPlaceholder('Search').count()) === 1 && (await page.getByRole('button', { name: /^New$/ }).count()) === 1)
    else ok('...the phone\'s bar with its column picker', (await page.getByRole('button', { name: /^Column: / }).count()) === 1)
    await page.screenshot({ path: path.join(SHOTS, `lead-local-${width}.png`) })
    await ctx.close()
  }

  // sy-hl2t: For you was wider than a phone (a sideways scrollbar). Cards with long content (a long URL, a long Head, a
  // long command in code marks, a title with no spaces, a row of buttons), at 360, 390 and 430 px: For you, the board
  // and an open item. The page never scrolls sideways (the document, nor main or the item's sheet, the boxes that
  // scroll); a code block may scroll inside its own box. A failure names the widest element.
  const HEX = 'f'.repeat(8) + '0123456789abcdef0123456789abcdef'
  const URL_ = 'https://example.org/a/very/long/link/that/should/wrap/somewhere/in/the/card/and/never/push/the/page/sideways/at/all'
  const LONGWORD = 'Rotate-the-gateway-key-and-restart-every-service-on-the-machine-without-a-single-space-in-it'
  const CMD = 'bin/brain run migrations/0042-rotate-the-gateway-key-and-restart-the-names-proxy.sh --rollback-on-failure'
  const LONG_GO = `## Owner
- **What:** Rotate the key, see ${URL_}
- **Why:** ${LONGWORD}
- **You:** Tap Approve, then run \`${CMD}\`
- **If yes:** Ops runs \`${CMD}\` tonight.
- **If no:** The old key stays at ${URL_}
- **Risk:** low, ${LONGWORD}
- **Head:** mm@${HEX}

The plan:

\`\`\`
${CMD} && ${CMD}
\`\`\`

${URL_}`
  const LONG_CHECK = `## Owner
- **What:** ${LONGWORD}
- **Why:** ${URL_}
- **You:** Check: run \`${CMD}\` and say if it worked`
  const longs = [
    { ...base, id: 'fy-20', title: LONGWORD, labels: ['t2', 'needs-you', 'signed-off', `signed-head:mm@${HEX}`], updated_at: iso(10), description: LONG_GO,
      comments: [{ id: 'l1', author: 'ops', text: `Plan: \`${CMD}\`\n\n\`\`\`\n${CMD} ${CMD}\n\`\`\`\n\n${URL_} mm@${HEX}`, created_at: iso(9) }] },
    { ...base, id: 'fy-21', title: `${LONGWORD} ${URL_}`, labels: ['needs-you'], updated_at: iso(8), description: LONG_CHECK },
    { ...base, id: 'fy-22', title: LONGWORD, labels: ['needs-you'], updated_at: iso(7), description: `## Owner\n- **What:** ${URL_}\n- **You:** Reply: ${LONGWORD}` },
  ]
  const longClosed = { ...base, id: 'fy-23', title: `${LONGWORD}${LONGWORD}`, status: 'closed', labels: [], updated_at: iso(6), closed_at: iso(6), description: LONG_CHECK.replace('Check: ', 'Nothing ') }
  OPEN.push(...longs); CLOSED.push(longClosed)
  for (const i of [...longs, longClosed]) all[i.id] = i
  EVENTS.push(ev(3000, 'create', 'fy-23', 'ops', { status: 'open' }), ev(6, 'close', 'fy-23', 'platform'))
  /** What sticks out at the right: the page's and its scroll boxes' widths, and the widest element past the screen that
   *  no box of its own clips (a code block that scrolls in its box, a truncated line: fine). */
  const overflow = (page) => page.evaluate(() => {
    const de = document.documentElement, iw = innerWidth
    const sel = (e) => { const p = []; for (let a = e; a && a !== document.body && p.length < 4; a = a.parentElement) {
      const d = [...a.attributes].find((x) => x.name.startsWith('data-') && x.name !== 'data-slot')
      p.unshift(a.tagName.toLowerCase() + (a.id ? `#${a.id}` : '') + (d ? `[${d.name}${d.value ? `=${d.value}` : ''}]` : '') + (a.getAttribute('data-slot') ? `[data-slot=${a.getAttribute('data-slot')}]` : '')
        + (typeof a.className === 'string' && a.className ? `.${a.className.trim().split(/\s+/).slice(0, 4).join('.')}` : '')) } return p.join(' > ') }
    // the boxes that scroll the page's content: main (For you, the board) and the item's sheet
    const pageBoxes = [...document.querySelectorAll('main, [data-slot=sheet-content], [data-slot=sheet-content] *')].filter((e) => {
      const o = getComputedStyle(e).overflowX; return (o === 'auto' || o === 'scroll') && !e.closest('pre, table') && e.clientWidth >= iw * 0.8 })
    const boxes = pageBoxes.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => `${sel(b)} (scrollWidth ${b.scrollWidth} > ${b.clientWidth})`)
    const own = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (pageBoxes.includes(a) || a.matches('[data-slot=sheet-content]')) return false
      if (getComputedStyle(a).overflowX !== 'visible') return true } return false }
    const wide = [...document.querySelectorAll('body *')].map((e) => [e, e.getBoundingClientRect()])
      .filter(([e, r]) => r.width && r.height && r.right > iw + 1 && getComputedStyle(e).position !== 'fixed' && !own(e))
      .sort((a, b) => b[1].right - a[1].right).slice(0, 3).map(([e, r]) => `${sel(e)} (right ${Math.round(r.right)}, width ${Math.round(r.width)})`)
    return { sw: de.scrollWidth, iw, boxes, wide }
  })
  const noWider = async (page, what) => {
    await page.waitForTimeout(300)
    const m = await overflow(page)
    ok(`${what}: nothing wider than the screen (document ${m.sw} <= ${m.iw}, no scroll box wider)`, m.sw <= m.iw && m.boxes.length === 0 && m.wide.length === 0,
      `boxes: ${m.boxes.join(' | ') || 'none'}\n        widest: ${m.wide.join(' | ') || 'none'}`)
  }
  for (const width of [360, 390, 430]) {
    step(`long content at ${width} px: For you, the board, an open item (sy-hl2t)`)
    const { ctx, page, errs } = await human('boss', 'owner', width, 844)
    await page.addInitScript(() => { if (!localStorage.getItem('for-you:fy:boss:since')) localStorage.setItem('for-you:fy:boss:since', String(Date.now() - 86400e3)) })
    await page.goto(`${PUB}/`)
    await page.locator('[data-needs-you="fy-20"]').waitFor({ timeout: 10000 }).catch(() => {})
    await page.locator('[data-to-review="fy-23"]').waitFor({ timeout: 10000 }).catch(() => {})
    ok('the long cards are there (fy-20, fy-21, fy-22 in Needs you, fy-23 in To review)', (await page.locator('[data-needs-you="fy-20"], [data-needs-you="fy-21"], [data-needs-you="fy-22"], [data-to-review="fy-23"]').count()) === 4)
    await noWider(page, `For you @${width}`)
    if (width === 390) {
      await page.screenshot({ path: path.join(SHOTS, `for-you-long-${width}.png`) })
      await page.locator('[data-needs-you="fy-20"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(SHOTS, `for-you-long-card-${width}.png`) })
    }
    await page.goto(`${PUB}/#board`)
    await page.getByText('Plain work handed on, no card, no artifact').first().waitFor({ timeout: 8000 }).catch(() => {})
    await noWider(page, `Board @${width}`)
    await page.goto(`${PUB}/?item=fy-20`)
    await page.locator('[data-slot="sheet-content"]').waitFor({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(700)
    await noWider(page, `item fy-20 @${width}`)
    if (width === 390) await page.screenshot({ path: path.join(SHOTS, `item-long-${width}.png`) })
    ok('no page error', errs.length === 0, errs.join(' | '))
    await ctx.close()
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
