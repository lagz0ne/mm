#!/usr/bin/env node
// The gateway's Waiting list as the owner's place to act (sy-92sg), on a phone: the home page as the gateway makes it
// (src/auth.ts pagesForTest, rendered by bun with a throwaway HOME) with owner cards and each kind of action (Approve
// and Not now, Reply, Done, the link only), and a member's list, opened with Playwright at 390x844. It fails on
// sideways scroll, on a tap target (button, text box) under 44 px high, on a text box under 16 px (iOS zooms), on a card
// field shown as markup instead of text. Screenshots go to $WAITING_SHOTS (else a temp folder); their paths are printed.
//   node test/waiting-phone.mjs            exit 0 = every check passed
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-phone-'))
const SHOTS = process.env.WAITING_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const die = (m) => { console.error(`\x1b[31mwaiting-phone: ${m}\x1b[0m`); process.exit(2) }

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

// ---------- the pages, made by the gateway's own code ----------
const GW = path.join(T, 'gw'), HOME = path.join(T, 'home')
fs.mkdirSync(GW); fs.mkdirSync(HOME)
if (!fs.existsSync(path.join(SRC, 'src', 'template.gen.json'))) spawnSync('bun', ['scripts/pack-template.ts'], { cwd: SRC, stdio: 'ignore' })
const render = `
const { pagesForTest: P } = await import(${JSON.stringify(path.join(SRC, 'src', 'auth.ts'))})
const fs = await import('node:fs'), out = process.argv[1]
const sum = { open: 31, p0: 2, blocked: 4, needs_you: 5, mine: 0, last: '2026-11-07T12:00:00Z' }
const card = { what: 'Rotate the gateway key for <script>alert(1)</script> every board, with a long-word-that-does-not-break-easily-at-all', why: 'The old key was in a log file that an agent read yesterday.', you: 'Tap Approve here or in Telegram', if_yes: 'Ops rotates it tonight; every board signs in again once.', if_no: 'The old key stays until you say.', risk: 'medium, a minute without sign-in on every board' }
const items = [
  { id: 'ab-12', title: 'Rotate the gateway key (t2): plan, rollback, lockout safeguard, all in the item', age_min: 190, ask: 'approve (t2, signed off)', hot: true, you: card.you, card, act: 'approve' },
  { id: 'ab-13', title: 'Which name do we use for the shop?', age_min: 45, ask: 'needs you', hot: true, you: 'Reply: which name do we use, acme or acme-shop?', card: { what: 'A name for the shop.', why: 'The domain is bought today.', you: 'Reply: which name do we use, acme or acme-shop?' }, act: 'reply' },
  { id: 'ab-14', title: 'Check the new sign-in page', age_min: 12, ask: 'needs you', hot: true, you: 'Check: the sign-in page, on your phone', card: { what: 'The sign-in page is new.', why: 'It must work on a phone.', you: 'Check: the sign-in page, on your phone' }, act: 'check' },
  { id: 'ab-15', title: 'For your information: the backup ran', age_min: 3, ask: 'needs you', hot: true, you: 'Nothing', card: { what: 'The backup ran.', why: 'You asked to hear.', you: 'Nothing' }, act: 'none' },
  { id: 'ab-16', title: 'An item with no card', age_min: 1, ask: 'needs you', hot: true, you: null, card: null, act: 'none' },
]
fs.writeFileSync(out + '/owner.html', P.home('Alex Example-Longname', [
  { project: 'a-rather-long-project-name-with-dashes', host: 'board.example.org', role: 'owner', s: sum, w: { items, more: 0 }, older: false }], 'a-rather-long-project-name-with-dashes ab-12: Approved on the board by alex.'))
fs.writeFileSync(out + '/member.html', P.home('Sam Example', [
  { project: 'a-rather-long-project-name-with-dashes', host: 'board.example.org', role: 'member', s: sum, w: { items: [{ id: 'ab-13', title: 'Which name do we use for the shop?', age_min: 45, ask: 'assigned to you', hot: false, you: 'Reply: which name?' }], more: 0 }, older: false }]))
fs.writeFileSync(out + '/app.css', P.css)
`
const r = spawnSync('bun', ['-e', render, GW], { encoding: 'utf8', env: { ...process.env, HOME, MM_HOME: path.join(HOME, '.mm') } })
ok('the gateway\'s home pages render', r.status === 0 && fs.existsSync(path.join(GW, 'owner.html')), (r.stdout + r.stderr).slice(-800))
if (r.status !== 0) process.exit(1)

const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/s/app.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(fs.readFileSync(path.join(GW, 'app.css'))) }
  if (p.startsWith('/gw/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })
    return res.end(fs.readFileSync(path.join(GW, `${path.basename(p)}.html`)))
  }
  res.writeHead(404); res.end()
}).listen(0, '127.0.0.1')
await new Promise((ok) => srv.once('listening', ok))
const BASE = `http://127.0.0.1:${srv.address().port}`

const browser = await chromium.launch({ executablePath: exe })
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const csp = []
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()) })
  for (const who of ['owner', 'member']) {
    console.log(`\n\x1b[1m== the ${who}'s Waiting list at 390x844\x1b[0m`)
    await page.goto(`${BASE}/gw/${who}`)
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
    ok(`no sideways scroll (${m.sw} <= ${m.iw})`, m.sw <= m.iw)
    const small = await page.evaluate(() => [...document.querySelectorAll('.waiting button, .waiting textarea, .waiting input:not([type=hidden])')]
      .map((e) => ({ t: e.tagName + ' ' + (e.textContent || e.getAttribute('name') || ''), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }))
      .filter((x) => x.h < 44 || x.w < 44))
    ok('every tap target in the list is at least 44 px', small.length === 0, JSON.stringify(small))
    const fonts = await page.evaluate(() => [...document.querySelectorAll('.waiting textarea')].map((e) => parseFloat(getComputedStyle(e).fontSize)))
    ok('a text box is 16 px or more (no zoom on focus)', fonts.every((f) => f >= 16), JSON.stringify(fonts))
    const shot = path.join(SHOTS, `waiting-${who}-390x844.png`)
    await page.screenshot({ path: shot, fullPage: true })
    console.log(`        ${shot}`)
    if (who === 'owner') {
      ok('the owner: Approve and Not now, a reply box and Send, Done: one action per row that has one', await page.evaluate(() =>
        document.querySelectorAll('button[value=approve]').length === 1 && document.querySelectorAll('button[value=not-now]').length === 1
        && document.querySelectorAll('textarea[name=t]').length === 1 && [...document.querySelectorAll('.w-act button')].filter((b) => b.textContent === 'Done').length === 1))
      ok('..."Nothing" and no card: the link only', await page.evaluate(() => [...document.querySelectorAll('.w-list li')].slice(3).every((li) => !li.querySelector('form'))))
      ok('...the card shown as text: the <script> in What is text, no script element', await page.evaluate(() =>
        document.querySelectorAll('script').length === 0 && [...document.querySelectorAll('.w-card dd')].some((d) => d.textContent.includes('<script>alert(1)</script>'))))
      ok('...the board\'s answer shown at the top', await page.evaluate(() => document.querySelector('main > p.msg[role=status]')?.textContent.includes('Approved on the board')))
      // the Approve button in view without scrolling far: the first row's action fits the first two screens
      const y = await page.evaluate(() => document.querySelector('button[value=approve]').getBoundingClientRect().top + window.scrollY)
      ok(`...the first Approve is near the top (${Math.round(y)} px, within two screens)`, y < 844 * 2)
    } else {
      ok('a member: no card lines and no forms (as before)', await page.evaluate(() => !document.querySelector('.w-card') && !document.querySelector('form[action="/s/act"]')))
    }
  }
  ok('no CSP violation on either page (no inline script or style)', csp.length === 0, csp.join('\n'))
} finally { await browser.close(); srv.close() }
console.log(`\n${pass} passed, ${fail} failed`)
if (!process.env.WAITING_SHOTS) console.log(`screenshots in ${SHOTS}`)
process.exit(fail ? 1 : 0)
