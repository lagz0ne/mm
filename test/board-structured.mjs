#!/usr/bin/env node
// Structured content on the board (sy-rfup, step 1), at 390x844 and 1280x800 (Playwright): a lead's ```mm-message v1
// comment shows as today's message (its intent as a tag, its keys, Expect first), then its parts each by its type (text,
// markdown rendered, a mermaid diagram, a table, html in a frame with sandbox="" whose script does not run, svg as an
// image, a log that scrolls), and "Original" shows the block as written; "Waits on" reads the blocks; the owner card and
// the Task, as blocks in the description, show as their keys and parts; a person's comment shows as text. No sideways
// scroll, no page error. The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve.
//   node test/board-structured.mjs     exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...          use template/site/dist as it is
//   BOARD_MSG_SHOTS=<dir>              where the screenshots go (kept; default: a folder under the temp dir)
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-structured-'))
const SHOTS = process.env.BOARD_MSG_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-structured: ${m}\x1b[0m`); process.exit(2) }
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

// ---------- one item: a card block and a Task block in its description; block messages in its thread ----------
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const J = (kind, d) => '```mm-' + kind + ' v1\n' + JSON.stringify(d, null, 2).replace(/`/g, '\\u0060') + '\n```'
const W = { done: { is: 'signed-off' }, verify: { check: 'bd show ms-2 --json', expect: 'labels has signed-off' }, by: 'next-wake', else: { do: 'escalate', to: 'ops' } }
const ASK = J('message', { intent: 'ASK', to: 'review', expect: { role: 'review', do: 'review', on: 'mm@56ebb96' }, ...W, need: 'review', options: ['keep', 'drop'],
  misc: [
    { type: 'text', text: 'Read the plan first. It has one diagram and one table.' },
    { type: 'markdown', markdown: 'The **plan**: `plans/x.md`.' },
    { type: 'mermaid', title: 'Flow', mermaid: 'graph LR; a-->b' },
    { type: 'table', title: 'Tests', columns: ['file', 'passed', 'failed'], rows: [['test/schema.mjs', 125, 0], ['test/structured.sh', 71, 0]] },
    { type: 'html', title: 'Page', html: '<p id="x">inline page</p><script>parent.document.title = "pwned"</script>' },
    { type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
    { type: 'log', title: 'Run', log: Array.from({ length: 40 }, (_, k) => `line ${k} ${'x'.repeat(120)}`).join('\n') },
  ] })
const ANSWER = 'ANSWER → platform · re #1\nExpect: none\nAnswer: keep\nVerify: artifacts/ms-2/x.txt → keep'
const HANDOFF = J('message', { intent: 'HANDOFF', to: 'review', expect: { role: 'review', do: 'sign-off', on: 'mm@56ebb96' }, ...W, head: 'mm@56ebb96',
  ready: ['mm@56ebb96', 'artifacts/ms-2/plan.md'], surfaces: ['bin', 'site:board'], tests: { artifact: 'artifacts/ms-2/tests.txt', passed: 196, failed: 0 } })
const comments = [
  { id: 'c1', author: 'platform', text: ASK, created_at: iso(200) }, // #1, answered by #2 (the text form)
  { id: 'c2', author: 'review', text: ANSWER, created_at: iso(150) }, // #2
  { id: 'c3', author: 'platform', text: HANDOFF, created_at: iso(100) }, // #3 waits on review, late
  { id: 'c4', author: 'alex', text: 'A person writes free text, as ever.', created_at: iso(50) }, // #4
]
const CARD = J('card', { what: { do: 'decide', on: 'ms-2' }, why: 'request', you: { kind: 'reply' }, misc: [{ type: 'text', text: 'Keep the old form for one more week?' }, { type: 'markdown', markdown: 'See **the plan**.' }] })
const TASK = J('task', { act: 'build', do: 'build', on: 'ms-2', done: { is: 'closed' }, verify: { check: 'node test/schema.mjs', expect: '0 failed' }, misc: [{ type: 'text', text: 'Three schemas and a validator.' }] })
const ITEMS = [{ id: 'ms-2', title: 'Structured content', status: 'in_progress', priority: 1, issue_type: 'task', assignee: 'platform', labels: ['needs-you'], created_at: iso(300), updated_at: iso(10),
  description: `${CARD}\n\n${TASK}\n\nThe rest of the description.`, comments }]
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
const HOST = 'board-ms.example.org'
const sign = (u, r) => { const b = Buffer.from(JSON.stringify({ u, r, h: HOST, exp: Date.now() + 60000, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'ms', MM_PROJECT: 'ms',
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
    step(`${w} px: ms-2, its card, its Task and its thread`)
    await page.goto(`${BASE}/?item=ms-2`)
    await page.locator('[data-message]').first().waitFor({ timeout: 10000 }).catch(() => {})
    const tags = await page.locator('[data-message]').evaluateAll((es) => es.map((e) => e.getAttribute('data-message')))
    ok('three messages as tags: ASK (a block), ANSWER (text), HANDOFF (a block)', tags.join() === 'ASK,ANSWER,HANDOFF', `${tags.join()} ${errs.join(' | ')}`)
    const ask = page.locator('[data-message="ASK"]')
    const dts = await ask.locator('dl dt').allTextContents()
    ok('the ASK block reads as today\'s message: its keys in the thread order (Expect, By, then Done when, Verify; sy-uykv)', dts.slice(0, 4).join() === 'Expect,By,Done when,Verify' && dts.includes('Why') && dts.includes('Options'), dts.join())
    ok('...Expect "review: review mm@56ebb96", By "next wake · Else: escalate ops"', /review: review mm@56ebb96/.test((await ask.locator('dl').allTextContents()).join(' ')) && /next wake · Else: escalate ops/.test((await ask.locator('dl').allTextContents()).join(' ')))
    const types = await ask.locator('[data-part]').evaluateAll((es) => es.map((e) => e.getAttribute('data-part')))
    ok('its misc, in order, each part by its type', types.join() === 'text,markdown,mermaid,table,html,svg,log', types.join())
    ok('...text as text', (await ask.locator('[data-part="text"]').textContent()) === 'Read the plan first. It has one diagram and one table.')
    ok('...markdown rendered (bold)', (await ask.locator('[data-part="markdown"] strong').textContent()) === 'plan')
    ok('...a table: its columns and rows', (await ask.locator('[data-part="table"] th').allTextContents()).join() === 'file,passed,failed' && (await ask.locator('[data-part="table"] tbody tr').count()) === 2)
    const frame = ask.locator('[data-part="html"] iframe')
    ok('...html in a frame with sandbox="" (no scripts, no same origin)', (await frame.getAttribute('sandbox')) === '' && /inline page/.test((await frame.getAttribute('srcdoc')) || ''))
    ok('...its script did not run', (await page.title()) !== 'pwned')
    ok('...svg as an <img> (never runs a script)', /^data:image\/svg\+xml/.test((await ask.locator('[data-part="svg"] img').getAttribute('src')) || ''))
    ok('...a log in a block that scrolls', await ask.locator('[data-part="log"] pre').evaluate((e) => e.scrollHeight > e.clientHeight))
    ok('...a title on a part', (await ask.locator('[data-part="table"] figcaption').textContent()) === 'Tests')
    const tog = ask.locator('[data-original-toggle]')
    ok('"Original" is closed at first', (await ask.locator('[data-original]').count()) === 0)
    await tog.click()
    const orig = (await ask.locator('[data-original]').textContent()) || ''
    ok('..."Original" shows the block as written', orig.startsWith('```mm-message v1') && orig.includes('"intent": "ASK"'), orig.slice(0, 80))
    await tog.click()
    ok('...and hides it again', (await ask.locator('[data-original]').count()) === 0)
    const ho = page.locator('[data-message="HANDOFF"]')
    ok('the HANDOFF block: its Head, Ready as a list, Tests', (await ho.locator('code').first().textContent()) === 'mm@56ebb96' && (await ho.locator('dd li').count()) >= 2 && /196 passed, 0 failed/.test(await ho.textContent()))
    const ws = await page.locator('[aria-label="Waits on"] [data-wait]').evaluateAll((es) => es.map((e) => e.getAttribute('data-wait')))
    ok('"Waits on": #3 (the block HANDOFF); the block ASK #1 has its text ANSWER', ws.join() === '3', ws.join())
    ok('a person\'s comment shows as text', /A person writes free text, as ever\./.test((await page.locator('ol').last().textContent()) || ''))
    const card = page.locator('[data-owner-card]')
    ok('the owner card block: valid, its keys (What, Why, You)', (await card.getAttribute('data-owner-card')) === 'ok' && (await card.locator('dt').allTextContents()).slice(0, 3).join() === 'What,Why,You', await card.textContent())
    ok('...You "Reply: <the first text part>"', /Reply: Keep the old form for one more week\?/.test(await card.locator('[data-key="You"]').textContent()))
    ok('...its parts and Original', (await card.locator('[data-part]').count()) === 2 && (await card.locator('[data-original-toggle]').count()) === 1)
    const task = page.locator('[data-structured="task"]')
    ok('the Task block in the description: its keys', (await task.count()) === 1 && /build ms-2/.test(await task.textContent()) && /node test\/schema\.mjs → 0 failed/.test(await task.textContent()))
    ok('...valid (no "invalid" note), its text part, and Original', (await task.locator('[data-structured-invalid]').count()) === 0 && (await task.locator('[data-part="text"]').count()) === 1 && (await task.locator('[data-original-toggle]').count()) === 1)
    ok('...the rest of the description after it', /The rest of the description\./.test((await page.locator('.md', { hasText: 'The rest of the description.' }).first().textContent()) || ''))
    ok('no sideways scroll', !(await sideways(page)))
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(SHOTS, `structured-${w}.png`), fullPage: false })
    await ask.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS, `structured-thread-${w}.png`) })
    await ctx.close()
  }
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
  if (fail) console.log(out.slice(-1500))
  console.log(`  shots: ${SHOTS}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (!process.env.BOARD_MSG_SHOTS) fs.rmSync(T, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
