#!/usr/bin/env node
// The thread on the board (sy-uykv), at 390x844 and 1280x800 (Playwright): a message shows as a card (its intent, whom
// it is for and its Head on top; then Expect and By; then Done when and Verify; then the intent's own rows); any other
// text as Markdown with its single line breaks kept (lists and code as Markdown); a long log and a long table fold
// ("Show all"); each comment shows its author, its role, its time and #n; a person's pick (`→ <role>`) shows as whom it
// went to, not as text; the comment box's To sends the pick (the Lead by default: no pick line). No sideways scroll.
// The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve and Paseo.
//   node test/board-thread.mjs         exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...          use template/site/dist as it is
//   BOARD_THREAD_SHOTS=<dir>           where the screenshots go (kept; default: a folder under the temp dir)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-thread-'))
const SHOTS = process.env.BOARD_THREAD_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-thread: ${m}\x1b[0m`); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

step('lib/to.mjs: the board\'s copy is the same as bin\'s')
ok('site/src/lib/to.mjs == bin/lib/to.mjs', fs.readFileSync(path.join(SITE, 'src/lib/to.mjs'), 'utf8') === fs.readFileSync(path.join(SRC, 'template/bin/lib/to.mjs'), 'utf8'))

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

const B = path.join(T, 'board')
fs.cpSync(SITE, path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: [{ id: 'ops', title: 'Ops' }, { id: 'review', title: 'Review' }, { id: 'platform', title: 'Platform' }] }))
const env = { ...process.env, HOME: path.join(T, 'home'), MM_HOME: path.join(T, 'home', '.mm'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'MM_SERVICE', 'MM_BIND']) delete env[k]
fs.mkdirSync(env.HOME)

const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const HANDOFF = `HANDOFF → review
Head: mm@56ebb96
Expect: review: sign off or block this head.
Done when: the item has signed-off and signed-head:mm@56ebb96, or a VERDICT blocked.
Verify: bd show th-1 → labels include signed-head:mm@56ebb96
By: next wake · Else: ops waits; nothing rolls out
Ready: the thread view, the To choice
Surfaces: the boards (template)
Tests: node test/board-thread.mjs → 0 failed`
const FREE = 'First line of a thought\nsecond line, right under it\nthird line\n\n- one\n- two\n\nRun `bd show th-1`:\n\n```\nbd show th-1 --json\n```'
const LOG = `The run, as it printed:\n\n\`\`\`\n${Array.from({ length: 60 }, (_, k) => `step ${k + 1}: ok`).join('\n')}\n\`\`\``
const TABLE = `The counts:\n\n| suite | passed | failed |\n|---|---|---|\n${Array.from({ length: 30 }, (_, k) => `| suite-${k + 1} | ${k + 3} | 0 |`).join('\n')}`
const comments = [
  { id: 'c1', author: 'platform', text: HANDOFF, created_at: iso(200) }, // #1 a message: a card
  { id: 'c2', author: 'alex', text: FREE, created_at: iso(150) }, // #2 a person's words, line breaks
  { id: 'c3', author: 'platform', text: LOG, created_at: iso(140) }, // #3 a long log: folds
  { id: 'c4', author: 'alex', text: '→ review\nPlease look at the head too.', created_at: iso(100) }, // #4 a pick
  { id: 'c5', author: 'boss', text: '[owner] → platform\nFrom the public side.', created_at: iso(90) }, // #5 a pick on the public side
  { id: 'c6', author: 'ops', text: TABLE, created_at: iso(10) }, // #6 a long table: folds
  { id: 'c7', author: 'wake', text: 'Requeued: in progress with no update for 30 min.', created_at: iso(5) }, // #7 the system
]
const ITEMS = [{ id: 'th-1', title: 'The thread reads well', status: 'in_progress', priority: 0, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(300), updated_at: iso(5), description: 'The work.', comments }]
const posted = []
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  const pc = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname)
  if (pc && req.method === 'POST') {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { const d = JSON.parse(b || '{}'); posted.push(d); json({ id: `p${posted.length}`, issue_id: pc[1], author: d.author, text: d.text, created_at: new Date().toISOString() }) })
    return
  }
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? [] : ITEMS.map(({ comments, ...i }) => ({ ...i, comment_count: comments.length })), has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: ITEMS, has_more: false })
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = ITEMS.find((x) => x.id === m[1]); return i ? json(i) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'th', MM_PROJECT: 'th' } })
srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d))
let up = false
for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/whoami`); up = true } catch { await sleep(100) } }
if (!up) { console.log(out.slice(-1500)); die('the board did not start') }
const BASE = `http://127.0.0.1:${PORT}`

const browser = await chromium.launch({ executablePath: exe })
const sideways = (page) => page.evaluate(() => {
  const sheet = document.querySelector('[data-slot="sheet-content"]')
  return document.documentElement.scrollWidth > innerWidth || (sheet ? sheet.scrollWidth > sheet.clientWidth + 1 : false)
})
try {
  for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile })
    await ctx.addCookies([{ name: 'board_user', value: 'alex', url: BASE }])
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(e.message))
    step(`${w} px: the thread of th-1`)
    await page.goto(`${BASE}/?item=th-1`)
    await page.locator('[data-message]').first().waitFor({ timeout: 10000 }).catch(() => {})
    const li = (n) => page.locator(`li[data-comment="${n}"]`)

    const card = page.locator('[data-message="HANDOFF"]')
    ok('a HANDOFF is a card: its intent, → review and its Head on top', (await card.count()) === 1 && /HANDOFF/.test(await card.locator('[data-intent]').textContent()) &&
      /→ review/.test(await card.textContent()) && (await card.locator('code').first().textContent()) === 'mm@56ebb96')
    const rows = async (g) => card.locator(`[data-rows="${g}"] dt`).allTextContents()
    const act = await rows('act'), check = await rows('check'), own = await rows('own')
    ok('...then Expect and By, then Done when and Verify, then its own rows (Ready, Surfaces, Tests)',
      act.join() === 'Expect,By' && check.join() === 'Done when,Verify' && own.join() === 'Ready,Surfaces,Tests', `${act} | ${check} | ${own}`)
    const ord = await card.locator('[data-rows]').evaluateAll((es) => es.map((e) => e.getAttribute('data-rows')))
    ok('...in that order', ord.join() === 'act,check,own', ord.join())

    const free = li(2)
    ok('a free comment keeps its single line breaks', (await free.locator('.md p').first().locator('br').count()) === 2 &&
      (await free.locator('.md p').first().innerText()).split('\n').length === 3, await free.locator('.md p').first().innerText())
    ok('...a list and code as Markdown', (await free.locator('.md ul li').count()) === 2 && (await free.locator('.md pre code').count()) === 1 && (await free.locator('.md p code').count()) >= 1)
    ok('...a short code block does not fold', (await free.locator('[data-folded="1"]').count()) === 0)

    const log = li(3).locator('[data-fold="log"]')
    ok('a long log folds, with "Show all"', (await log.getAttribute('data-folded')) === '1' && (await log.locator('button', { hasText: 'Show all' }).count()) === 1)
    const hFold = (await log.boundingBox())?.height || 0
    await log.locator('button', { hasText: 'Show all' }).click()
    const hOpen = (await log.boundingBox())?.height || 0
    ok('..."Show all" opens it (all 60 lines), "Show less" folds it again', (await log.getAttribute('data-folded')) === '0' && hOpen > hFold * 2 && /step 60: ok/.test(await log.innerText()), `${hFold} -> ${hOpen}`)
    await log.locator('button', { hasText: 'Show less' }).click()
    ok('...folded again', (await log.getAttribute('data-folded')) === '1')
    ok('a long table folds too', (await li(6).locator('[data-fold="table"]').getAttribute('data-folded')) === '1')

    const heads = await page.locator('li[data-comment]').evaluateAll((es) => es.map((e) => ({
      n: e.querySelector('[data-n]')?.textContent, author: e.querySelector('[data-author]')?.textContent?.trim(), role: e.querySelector('[data-role]')?.textContent, time: e.querySelector('time')?.textContent })))
    ok('each comment has its own head: author, role, time, #n (7 comments, 7 heads)', heads.length === 7 && heads.every((x, k) => x.n === `#${k + 1}` && x.author && x.role && /ago$/.test(x.time || '')), JSON.stringify(heads))
    ok('...the roles: a lead\'s role, a person, the public side\'s [owner], the system', /lead/i.test(heads[0].role) && heads[1].role === 'person' && heads[4].role === 'owner' && heads[6].role === 'system', heads.map((x) => x.role).join())
    ok('a person\'s pick shows as whom it went to (→ Review), not as a line of text', (await li(4).locator('[data-to="review"]').count()) === 1 && !/→ review/.test(await li(4).locator('.md').innerText()))
    ok('...on the public side too ([owner] → platform): → Platform, no [owner] in the text', (await li(5).locator('[data-to="platform"]').count()) === 1 && !/\[owner\]|→/.test(await li(5).locator('.md').innerText()))

    step(`${w} px: the comment box's To`)
    const sel = page.locator('select[aria-label="To"]')
    const opts = await sel.locator('option').allTextContents()
    ok('To: the Lead (the default), the assignee, each other role', opts.join() === 'Lead · Ops,Assignee · Platform,Review' && (await sel.inputValue()) === '_lead', opts.join())
    const box = page.getByPlaceholder(/Write to/)
    ok('...the box says whom it writes to', /Write to the Lead/.test(await box.getAttribute('placeholder')))
    const n0 = posted.length
    await sel.selectOption('review')
    ok('...a pick changes it', /Write to Review/.test(await box.getAttribute('placeholder')))
    await box.fill(`for review at ${w}`)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    for (let k = 0; k < 30 && posted.length === n0; k++) await sleep(100)
    ok('Send with a pick: the comment\'s first line is → review', posted[n0]?.text === `→ review\nfor review at ${w}` && posted[n0]?.author === 'alex', JSON.stringify(posted[n0]))
    await sleep(300)
    ok('...after it, To is the Lead again', (await sel.inputValue()) === '_lead')
    await box.fill(`for the lead at ${w}`)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    for (let k = 0; k < 30 && posted.length === n0 + 1; k++) await sleep(100)
    ok('Send to the Lead: no pick line (wake gives it to the Lead)', posted[n0 + 1]?.text === `for the lead at ${w}`, JSON.stringify(posted[n0 + 1]))

    ok('no sideways scroll', !(await sideways(page)))
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await page.waitForTimeout(400)
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS, `thread-${w}.png`) })
    await li(4).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS, `thread-${w}-picks.png`) })
    await sel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS, `thread-${w}-box.png`) })
    await ctx.close()
  }
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
  if (fail) console.log(out.slice(-1500))
  console.log(`  shots: ${SHOTS}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (!process.env.BOARD_THREAD_SHOTS) fs.rmSync(T, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
