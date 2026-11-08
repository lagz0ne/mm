#!/usr/bin/env node
// Messages on the board (sy-0gsw), at 390x844 and 1280x800 (Playwright): a lead's comment that is a valid message shows
// its intent as a tag, whom it is for, re #n as a link, its Head, and its keys as a list (Expect first); a VERDICT's
// Result in red when blocked; a person's comment and a lead's older free text show as text; "Waits on" above the thread
// lists the ASK or HANDOFF that no later message answers (not the answered one), late in red after its By. No sideways
// scroll. The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve and Paseo.
//   node test/board-message.mjs        exit 0 = every check passed
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
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-message-'))
const SHOTS = process.env.BOARD_MSG_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-message: ${m}\x1b[0m`); process.exit(2) }
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

// ---------- one item and its thread ----------
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const HANDOFF = `HANDOFF → review
Head: mm@56ebb96
Expect: review: sign off or block this head.
Done when: the item has signed-off and signed-head:mm@56ebb96, or a VERDICT blocked.
Verify: bd show ms-1 → labels include signed-head:mm@56ebb96
By: next wake · Else: ops waits; nothing rolls out
Ready: the artifact command, the secret scan
Tests: artifacts/ms-1/gates.txt → 11 suites, 0 failed`
const ASK = `ASK → ops
Expect: ops: find why the release downloads answer 504.
Done when: the cause is named, with evidence.
Verify: curl -I <release URL> → 302, not 504
By: today · Else: clean-box stays blocked
Why: onboard installs no tools.`
const ANSWER = `ANSWER → platform · re #2
Expect: none
Answer: One edge of the host answers 504; the others 302. Nothing changed here.
Verify: artifacts/ms-1/edges.txt → one 504, three 302`
const VERDICT = `VERDICT → platform · re #5
Head: mm@1234567
Result: blocked
Expect: platform: refuse the tap when the item has no signed-off.
Done when: a tap without signed-off writes no label.
Verify: node test/x.mjs → "tap without signed-off" ok
By: next wake · Else: nothing goes live`
const comments = [
  { id: 'c1', author: 'platform', text: HANDOFF, created_at: iso(200) }, // #1 waits on review, late
  { id: 'c2', author: 'platform', text: ASK, created_at: iso(150) }, // #2 answered by #3
  { id: 'c3', author: 'ops', text: ANSWER, created_at: iso(140) }, // #3
  { id: 'c4', author: 'alex', text: 'Please keep it short.', created_at: iso(100) }, // #4 a person
  { id: 'c5', author: 'platform', text: 'Old free text from before the format.', created_at: iso(90) }, // #5 a lead, free text
  { id: 'c6', author: 'review', text: VERDICT, created_at: iso(10) }, // #6
  { id: 'c7', author: 'platform', text: VERDICT.replace('re #5', 're #1'), created_at: iso(5) }, // #7 a VERDICT not by review: text
]
const ITEMS = [{ id: 'ms-1', title: 'Messages on the board', status: 'in_progress', priority: 1, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(300), updated_at: iso(10), description: 'The work.', comments }]
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
    step(`${w} px: the thread of ms-1`)
    await page.goto(`${BASE}/?item=ms-1`)
    await page.locator('[data-message]').first().waitFor({ timeout: 10000 }).catch(() => {})
    const tags = await page.locator('[data-message]').evaluateAll((es) => es.map((e) => e.getAttribute('data-message')))
    ok('four messages, as tags: HANDOFF, ASK, ANSWER, VERDICT', tags.join() === 'HANDOFF,ASK,ANSWER,VERDICT', `${tags.join()} ${errs.join(' | ')}`)
    const first = page.locator('[data-message="HANDOFF"]')
    ok('...the HANDOFF shows → review and its Head', /→ review/.test(await first.textContent()) && (await first.locator('code').first().textContent()) === 'mm@56ebb96')
    const dts = await first.locator('dt').allTextContents()
    ok('...its keys, the expectation first', dts.slice(0, 4).join() === 'Expect,Done when,Verify,By' && dts.includes('Ready') && dts.includes('Tests'), dts.join())
    ok('the ANSWER links re #2', (await page.locator('[data-message="ANSWER"] a', { hasText: 're #2' }).count()) === 1)
    const res = page.locator('[data-message="VERDICT"] dd b')
    ok('the VERDICT: Result blocked, in red', (await res.textContent()) === 'blocked' && /destructive/.test(await res.getAttribute('class')))
    const thread = (await page.locator('ol').last().textContent()) || ''
    ok('a VERDICT by platform (#7) shows as text, not as a message', (await page.locator('[data-message="VERDICT"]').count()) === 1 && /VERDICT → platform · re #1/.test((await page.locator('ol').last().textContent()) || ''))
    ok('a person\'s comment and a lead\'s older free text show as text', thread.includes('Please keep it short.') && thread.includes('Old free text from before the format.'))
    const waits = page.locator('[aria-label="Waits on"] [data-wait]')
    const ws = await waits.evaluateAll((es) => es.map((e) => e.getAttribute('data-wait')))
    ok('"Waits on": #1 only (the HANDOFF; the ASK #2 has its answer #3; #7 answers nothing)', ws.join() === '1', ws.join())
    const wt = (await waits.first().textContent()) || ''
    ok('...it names review, the action, and late by next wake', /review/.test(wt) && /sign off or block this head/.test(wt) && /late · by next wake/.test(wt), wt)
    const wb = await page.locator('[aria-label="Waits on"]').boundingBox(), ob = await page.locator('ol').last().boundingBox()
    ok('..."Waits on" is above the thread', !!wb && !!ob && wb.y < ob.y)
    ok('no sideways scroll', !(await sideways(page)))
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await page.waitForTimeout(600)
    await page.locator('[aria-label="Waits on"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS, `thread-${w}.png`) })
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
