#!/usr/bin/env node
// The Glossary page (sy-ko6r), at 390x844 and 1280x800 (Playwright): reached from the views (the nav on a wide screen,
// the menu on a phone); /api/glossary serves the terms of glossary.yaml and glossary.local.yaml, each with its meaning,
// on the public side too; the page lists them, marks the board's own, and finds a term by its name or meaning. No
// sideways scroll. The built site and the real site/server.mjs (copies, in a temp folder), a stand-in bd serve and Paseo.
//   node test/board-glossary.mjs       exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...          use template/site/dist as it is
//   BOARD_GLOSSARY_SHOTS=<dir>              where the screenshots go (kept; default: a folder under the temp dir)
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-glossary-'))
const SHOTS = process.env.BOARD_GLOSSARY_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-glossary: ${m}\x1b[0m`); process.exit(2) }
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

fs.copyFileSync(path.join(SRC, 'template', 'glossary.yaml'), path.join(B, 'glossary.yaml'))
fs.writeFileSync(path.join(B, 'glossary.local.yaml'), 'terms:\n  - term: storefront\n    kind: technical name\n    means: The public pages of the shop, where a client buys.\n    not: site, shop\n    owner: setup\n    since: 2026-11-08 sy-ko6r\n')

const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const ITEMS = [{ id: 'gl-1', title: 'An item', status: 'open', priority: 2, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(30), updated_at: iso(10), description: 'The work.', comments: [] }]
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? [] : ITEMS, has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: ITEMS, has_more: false })
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

// ---------- the board: the real server.mjs ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-gl.example.org'
const sign = (u, r) => { const b = Buffer.from(JSON.stringify({ u, r, h: HOST, exp: Date.now() + 60000, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
const PORT = await freePort(), PPORT = await freePort()
let out = ''
const srv = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(PORT), HOST: '127.0.0.1',
  BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'gl', MM_PROJECT: 'gl',
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

step('/api/glossary')
const api = await (await fetch(`${BASE}/api/glossary`)).json()
const tpl = fs.readFileSync(path.join(SRC, 'template', 'glossary.yaml'), 'utf8').split('\n').filter((l) => /^  - term: /.test(l)).length
ok(`the terms of both files (${tpl} + 1), with meaning, kind, owner`, api.terms.length === tpl + 1 && api.terms.every((t) => t.term && t.means && t.kind && t.owner), String(api.terms.length))
ok('...the local one marked, the others not', api.terms.filter((t) => t.local).map((t) => t.term).join() === 'storefront')
ok('...no refuse_from yet, the size of the word list, no errors', api.refuseFrom === null && api.words > 1000 && api.errors === 0, JSON.stringify({ r: api.refuseFrom, w: api.words, e: api.errors }))
const pub = await getPublic('/api/glossary', { host: HOST, 'x-mm-assertion': sign('viewer1', 'viewer') })
ok('the public side serves it to a viewer', pub.status === 200 && JSON.parse(pub.body).terms.length === api.terms.length, String(pub.status))

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
    step(`${w} px: the Glossary page`)
    await page.goto(`${BASE}/`)
    if (mobile) {
      await page.getByRole('button', { name: 'Menu' }).click()
      await page.getByRole('link', { name: 'Glossary' }).click()
    } else await page.locator('header nav a', { hasText: /^glossary$/i }).click()
    await page.locator('[data-glossary] [data-term]').first().waitFor({ timeout: 10000 }).catch(() => {})
    ok('reached from the views: #glossary', page.url().endsWith('#glossary'), page.url())
    const n = await page.locator('[data-term]').count()
    ok(`every term listed (${n})`, n === api.terms.length)
    const oc = (await page.locator('[data-term="owner card"]').textContent()) || ''
    ok('a term shows its plain meaning, what not to say, and its owner', /asks the owner one thing/.test(oc) && /Not: card, summary/.test(oc) && /Kept by setup/.test(oc), oc)
    ok('the board\'s own term is marked "this board"', /this board/.test((await page.locator('[data-term="storefront"]').textContent()) || ''))
    await page.getByRole('searchbox', { name: 'Find a term' }).fill('client buys')
    const found = await page.locator('[data-term]').evaluateAll((es) => es.map((e) => e.getAttribute('data-term')))
    ok('the search finds a term by its meaning', found.join() === 'storefront', found.join())
    await page.getByRole('searchbox', { name: 'Find a term' }).fill('')
    ok('no sideways scroll', !(await sideways(page)))
    ok('no page errors', errs.length === 0, errs.join(' | '))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(SHOTS, `glossary-${w}.png`) })
    await ctx.close()
  }
} finally {
  await browser.close()
  srv.kill(); bdSrv.close()
  if (fail) console.log(out.slice(-1500))
  console.log(`  shots: ${SHOTS}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (!process.env.BOARD_GLOSSARY_SHOTS) fs.rmSync(T, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
