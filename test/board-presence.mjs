#!/usr/bin/env node
// The "working" avatars in the header never overlap (sy-o817): the built site against fixture data (no bd, no board
// server, no live board), opened with Playwright at 390 (the phone menu), 768, 1024 and 1280 px with 0, 1, 3 and 6 agents
// at work. It checks: no two header boxes intersect (the title, the nav, the goal chip, the right-hand group, and each
// part of the presence bar), nothing runs off the screen, at most 3 avatars then a "+N", the ring is drawn inset (inside
// the avatar's own box), every avatar names its agent, and the bar gives way (fewer avatars, then only "N working")
// before it squeezes the goal chip below its natural width or 16rem. Screenshots go to a folder under the temp dir.
//   node test/board-presence.mjs          exit 0 = every check passed
//   BOARD_PRESENCE_NOBUILD=1 ...          use template/site/dist as it is
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-presence-'))
const SHOTS = path.join(T, 'shots')
fs.mkdirSync(SHOTS)
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-presence: ${m}\x1b[0m`); process.exit(2) }

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
if (!process.env.BOARD_PRESENCE_NOBUILD) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: SITE, encoding: 'utf8' })
  if (b.status !== 0) { console.log((b.stdout + b.stderr).slice(-800)); die('npm run build failed') }
  console.log('  built')
}
const DIST = path.join(SITE, 'dist')
if (!fs.existsSync(path.join(DIST, 'index.html'))) die('no template/site/dist/index.html')

// ---------- fixture data: six roles, a goal with a long title, and a presence feed the test sets ----------
const now = Date.now(), iso = (minAgo) => new Date(now - minAgo * 60e3).toISOString()
const roles = [
  { id: 'ops', title: 'Ops & SRE', initial: 'O', color: '#b91c1c' },
  { id: 'review', title: 'Security & compliance review', initial: 'R', color: '#1f5fbf' },
  { id: 'platform', title: 'Platform (mm)', initial: 'P', color: '#0f766e' },
  { id: 'design', title: 'Design', initial: 'D', color: '#7c3aed' },
  { id: 'qa', title: 'QA', initial: 'Q', color: '#b45309' },
  { id: 'setup', title: 'Setup', initial: 'S', color: '#334155' },
]
let n = 0
const issue = (f = {}) => { n++; return { id: `sy-${n}`, title: `Item ${n}: a normal title of a normal length`, status: 'open', priority: 2, issue_type: 'task', assignee: 'platform', labels: [], created_at: iso(300), updated_at: iso(5 + n), comment_count: 0, ...f } }
const epics = [issue({ issue_type: 'epic', title: 'The board on phones and tablets, and backups that restore on every project' }), issue({ issue_type: 'epic', title: 'Workers for every lead' })]
const work = roles.flatMap((r) => [issue({ assignee: r.id, parent: epics[0].id }), issue({ assignee: r.id, status: 'in_progress', parent: epics[1].id })])
const meta = { project: 'system', roles, leads: {}, states: {}, creators: {}, last: {}, panels: ['machine'], personas: null }
const agentsFor = (k) => Array.from({ length: k }, (_, j) => ({ actor: roles[j % roles.length].id, kind: j < roles.length ? 'lead' : 'worker', id: `a${j}`, item: work[j].id, doing: 'reading the plan' }))
let busy = 6

const json = (res, d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)) }
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname
  if (p === '/api/meta') return json(res, meta)
  if (p === '/api/whoami') return json(res, { actor: 'ops', source: 'local', role: 'owner', approval: 'telegram' }) // the leads' header (a person's bar has presence in its menu, sy-c7mh)
  if (p === '/api/links') return json(res, { links: [] })
  if (p === '/api/presence') return json(res, { agents: agentsFor(busy) })
  if (p === '/api/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (p === '/api/v0/beads/events') return json(res, { head: 0, records: [] })
  if (p === '/api/v0/beads/issues') return json(res, { items: u.searchParams.get('status') === 'closed' ? [] : [...epics, ...work], has_more: false })
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
// Every box that must not touch another: the header's children; the children of the header's right-hand group; the
// visible parts of the presence bar (the probe is invisible and out of the layout). Each with a name for the report.
async function boxes(page, scope) {
  return page.evaluate((scope) => {
    const root = scope === 'header' ? document.querySelector('header') : document.querySelector('[role=dialog] [data-presence-bar]')?.parentElement
    if (!root) return null
    const bar = root.querySelector('[data-presence-bar]')
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom } }
    const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30)
    const shown = (e) => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && e.getBoundingClientRect().width > 0 }
    const groups = []
    if (scope === 'header') {
      groups.push([...root.children].filter(shown))
      let g = bar; while (g && g.parentElement !== root) g = g.parentElement
      if (g) groups.push([...g.children].filter(shown))
    }
    const parts = bar ? [...bar.children].filter((e) => !e.hasAttribute('aria-hidden') && shown(e)) : []
    groups.push(parts)
    const ring = bar?.querySelector('[data-part=avatar]:not([aria-hidden] *)')
    const chip = scope === 'header' ? [...root.querySelectorAll('button')].find((b) => /^Goal/.test(b.textContent.trim())) : null
    return {
      groups: groups.map((g) => g.map((e) => ({ name: name(e), ...r(e) }))),
      bar: bar ? { ...r(bar), text: bar.children.length ? [...bar.children].filter((e) => !e.hasAttribute('aria-hidden')).map((e) => e.textContent).join(' ').trim() : bar.textContent.trim() } : null,
      container: r(root), vw: innerWidth,
      avatars: parts.filter((e) => e.dataset.part === 'avatar').map((e) => ({ label: e.getAttribute('aria-label') || e.title, ...r(e), inner: r(e.firstElementChild) })),
      more: parts.find((e) => e.dataset.part === 'more')?.textContent || null,
      ringShadow: ring ? getComputedStyle(ring).boxShadow : null,
      headerH: root.getBoundingClientRect().height,
      chipW: chip ? chip.getBoundingClientRect().width : null,
    }
  }, scope)
}
const hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5
function overlaps(m) {
  const out = []
  for (const g of m.groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (hit(g[i], g[j])) out.push(`"${g[i].name}" × "${g[j].name}"`)
  return out
}
const shot = async (page, name) => { const f = path.join(SHOTS, `${name}.png`); await page.screenshot({ path: f }); return f }
const shots = []
const browser = await chromium.launch({ executablePath: exe })

function checkBar(tag, m, k) {
  const ov = overlaps(m)
  ok(`${tag}: no two boxes intersect`, ov.length === 0, ov.join('; '))
  ok(`${tag}: nothing runs off the screen`, m.groups.flat().every((b) => b.l >= -0.5 && b.r <= m.vw + 0.5), JSON.stringify(m.groups.flat().filter((b) => b.r > m.vw + 0.5).map((b) => b.name)))
  if (!k) { ok(`${tag}: "all quiet"`, /all quiet/.test(m.bar?.text || '')); return }
  ok(`${tag}: at most 3 avatars (${m.avatars.length})`, m.avatars.length <= 3)
  const extra = k - m.avatars.length
  if (m.avatars.length) ok(`${tag}: the rest is a "+${extra}"`, extra ? m.more === `+${extra}` : m.more === null, `more=${m.more}`)
  ok(`${tag}: the count is there (${k})`, new RegExp(`\\b${k}\\b`).test(m.bar.text), m.bar.text)
  ok(`${tag}: every avatar names its agent`, m.avatars.every((a) => /reading the plan/.test(a.label || '')))
  if (m.avatars.length) {
    ok(`${tag}: the ring is inset (${m.ringShadow})`, /inset/.test(m.ringShadow || ''))
    ok(`${tag}: the avatar sits inside its slot (the ring has its own 2px)`, m.avatars.every((a) => a.inner.l - a.l >= 1.5 && a.r - a.inner.r >= 1.5))
  }
}

// ---------- tablet and desktop: the header ----------
for (const w of [768, 1024, 1280]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  let quietChip = null
  for (const k of [0, 1, 3, 6]) {
    busy = k
    step(`${k} at work, ${w}px`)
    await page.goto(`${BASE}/`)
    await page.getByText(work[0].title).first().waitFor({ timeout: 10000 })
    await page.waitForTimeout(500)
    const m = await boxes(page, 'header')
    const tag = `@${w} ${k} busy`
    checkBar(tag, m, k)
    ok(`${tag}: the header is one line (${Math.round(m.headerH)}px ≤ 48)`, m.headerH <= 48)
    if (w === 1280 && k) ok(`${tag}: with room, the full bar (${Math.min(3, k)} avatars and "${k} working")`, m.avatars.length === Math.min(3, k) && m.bar.text.includes(`${k} working`), m.bar.text)
    if (k === 0) quietChip = m.chipW
    else if (quietChip != null && m.chipW != null) ok(`${tag}: the goal chip keeps its width or 16rem (${Math.round(m.chipW)}px, ${Math.round(quietChip)}px when quiet)`, m.chipW >= Math.min(quietChip, 256) - 1)
    if (k === 6) shots.push(await shot(page, `header-6-${w}`))
  }
  ok(`@${w}: no page error`, errs.length === 0, errs.join(' | '))
  await ctx.close()
}

// ---------- the phone: the bar in the menu ----------
{
  const w = 390
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  for (const k of [0, 6]) {
    busy = k
    step(`${k} at work, ${w}px (the menu)`)
    await page.goto(`${BASE}/`)
    await page.getByRole('button', { name: 'Menu', exact: true }).waitFor({ timeout: 10000 })
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('dialog', { name: 'Menu' }).waitFor({ timeout: 5000 })
    await page.waitForTimeout(500)
    const m = await boxes(page, 'menu')
    ok(`@${w} ${k} busy: the menu shows the bar`, !!m)
    if (!m) continue
    checkBar(`@${w} ${k} busy`, m, k)
    if (k) ok(`@${w} ${k} busy: the bar stays inside the menu`, m.bar.r <= m.container.r + 0.5 && m.bar.l >= m.container.l - 0.5)
    if (k === 6) shots.push(await shot(page, `menu-6-${w}`))
  }
  await ctx.close()
}
await browser.close()
srv.close()

console.log('\nscreenshots:')
for (const s of shots) console.log(`  ${s}`)
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`)
process.exit(fail ? 1 : 0)
