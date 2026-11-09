#!/usr/bin/env node
// The board stays quick while the agents are busy (sy-jjcx): a busy board (130 items, 4 roles, an item with a long
// Markdown thread) on a stand-in server (no bd, no board server), opened as a person on a phone (390x844, the CPU slowed
// 4x), while 100 board events (comments, status changes, label changes, each with the item's snapshot as bd serve
// sends it) arrive over 60 s on the live stream: a third with For you showing, a third on the Board, a third with an
// item open. The site is built unminified (so the components keep their names) into a temp folder; a stand-in React
// DevTools hook counts every component render per commit (the DevTools' own rule: a fiber that did work, under a parent
// whose children were cloned). Per phase and per event it measures:
//   renders   component renders (and which cards: an event must re-render only its own card)
//   calls     the page's requests to /api/ (the live stream itself left out)
//   ms        main-thread time (CDP Performance: all tasks, and the scripts alone), also over the same view idle
// and prints the table (BOARD_PERF_OUT=<file> writes it as Markdown and JSON too). The budget (BUDGET, per view): on the
// Board no card but the event's own re-renders and at most one card render per event; per event at most so many calls,
// component renders and script ms (script time: the part renders cost; all-task time also counts the animations' paint,
// which a loaded machine makes noisy).
//   node test/board-perf.mjs           exit 0 = within the budget
//   BOARD_PERF_NOBUDGET=1 ...          measure and print only (a "before" run)
//   BOARD_PERF_SITE=<dir>              measure another copy of template/site (e.g. main's, for the "before" numbers)
// The browser: playwright-core (mm's dev dependency) and its cached headless shell, or PLAYWRIGHT_CHROMIUM=<binary>.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = process.env.BOARD_PERF_SITE || path.join(SRC, 'template', 'site') // BOARD_PERF_SITE: another copy of the site (a "before" run)
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-perf-'))
const DIST = path.join(T, 'dist')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-perf: ${m}\x1b[0m`); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// the budget, per event and view, set from the measured numbers with room for a slower or busier machine. Measured
// (sy-jjcx), before → after: For you 240 → 31 renders, 6.3 → 1.2 calls, 23 → 12 script ms; Board 1344 → 40 renders,
// 5.3 → 0.9 calls, 80 → 13 ms; an open item 3845 → 302 renders, 10.4 → 2.8 calls, 516 → 35 ms. An event on the open item
// reads it again with its content, artifacts, designs and workers (5 calls): a third of that view's events are on it.
const BUDGET = {
  foryou: { calls: 1.5, renders: 60, script: 30 },
  board: { calls: 1.5, renders: 80, script: 30 },
  item: { calls: 3.5, renders: 500, script: 80 },
}
const EVENTS = 100, SPAN_MS = 60000, IDLE_MS = 5000, CPU_RATE = 4

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

// ---------- the site, built unminified into the temp folder ----------
step('build the site (unminified, for the component names)')
{
  // (test/gates built and checked the site already: BOARD_PHONE_NOBUILD; this build goes to the temp folder only)
  if (!process.env.BOARD_PHONE_NOBUILD) {
    const tsc = spawnSync('npx', ['tsc', '-b'], { cwd: SITE, encoding: 'utf8' })
    if (tsc.status !== 0) { console.log((tsc.stdout + tsc.stderr).slice(-800)); die('tsc failed') }
  }
  const b = spawnSync('npx', ['vite', 'build', '--minify', 'false', '--outDir', DIST, '--emptyOutDir'], { cwd: SITE, encoding: 'utf8' })
  if (b.status !== 0) { console.log((b.stdout + b.stderr).slice(-800)); die('vite build failed') }
  console.log('  built')
}

// ---------- the busy board ----------
const now = Date.now(), iso = (minAgo) => new Date(now - minAgo * 60e3).toISOString()
const roles = [
  { id: 'ops', title: 'Ops', initial: 'O', color: '#b91c1c' },
  { id: 'review', title: 'Review', initial: 'R', color: '#1f5fbf' },
  { id: 'platform', title: 'Platform', initial: 'P', color: '#0f766e' },
  { id: 'design', title: 'Design', initial: 'D', color: '#7c3aed' },
]
const STATUSES = ['open', 'open', 'in_progress', 'blocked', 'closed']
const items = new Map()
for (let n = 1; n <= 130; n++) {
  const st = STATUSES[n % STATUSES.length]
  items.set(`sy-${n}`, {
    id: `sy-${n}`, title: `Item ${n}: a normal title of a normal length for a card`, status: st, priority: n % 4, issue_type: n <= 3 ? 'epic' : 'task',
    assignee: roles[n % roles.length].id, labels: n % 7 === 0 ? ['needs-you'] : [], created_at: iso(900), updated_at: iso(n), comment_count: n % 5,
    ...(st === 'closed' ? { closed_at: iso(n) } : {}),
    ...(n > 3 ? { parent: `sy-${1 + (n % 3)}` } : {}),
    dependencies: n % 9 === 0 ? [{ issue_id: `sy-${n}`, depends_on_id: `sy-${n - 1}`, type: 'blocks' }] : [],
  })
}
const OPEN = 'sy-11'
const md = (k) => k % 3 === 0
  ? `NOTE → ops\nChecked the **plan** for #${k}:\n\n- step one: \`bin/check\`\n- step two, with a [link](https://example.org)\n\n| what | ms |\n|---|---|\n| a | ${k} |\n| b | ${k * 2} |`
  : k % 3 === 1 ? `Ran the tests:\n\n\`\`\`\nok 1 - one\nok 2 - two\nok ${k} - more\n\`\`\`\nAll green.` : `A plain reply, with *emphasis* and a path docs/plan.md, and #${Math.max(1, k - 1)}.`
const comments = new Map([[OPEN, Array.from({ length: 24 }, (_, k) => ({ id: `c${k}`, issue_id: OPEN, author: roles[k % 4].id, text: md(k), created_at: iso(200 - k) }))]])
items.get(OPEN).comment_count = 24
items.get(OPEN).description = '## Goal\n\nThe board stays quick.\n\n- one\n- two\n\n```\ncode\n```'
const last = {}
const meta = () => ({ project: 'board', roles, leads: {}, states: {}, creators: {}, last, panels: [], personas: null })
const readyNow = () => [...items.values()].filter((i) => i.status === 'open' && !(i.dependencies || []).some((d) => items.get(d.depends_on_id)?.status !== 'closed'))
let agents = roles.slice(0, 3).map((r, j) => ({ actor: r.id, kind: 'lead', id: `a${j}`, item: `sy-${5 + j}`, doing: 'reading the plan' }))

let seq = 0
const records = [], streams = new Set()
let cseq = 100
function emit(op, id, extra = {}) {
  const i = items.get(id)
  i.updated_at = new Date().toISOString()
  const e = { seq: ++seq, ts: i.updated_at, op, issue_id: id, actor: i.assignee, issue: { ...i }, ...extra }
  records.push(e)
  for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`)
  return e
}
// one event: k%4 0,1 a comment; 2 a status change; 3 a label change
const FLOW = { open: 'in_progress', in_progress: 'blocked', blocked: 'open' }
function event(k, id) {
  const i = items.get(id)
  if (k % 4 < 2) {
    const c = { id: `c${++cseq}`, issue_id: id, author: i.assignee, text: md(k), created_at: new Date().toISOString() }
    if (!comments.has(id)) comments.set(id, [])
    comments.get(id).push(c)
    i.comment_count = (i.comment_count || 0) + 1
    last[id] = { author: c.author, at: c.created_at }
    return emit('comment', id, { comment: c })
  }
  if (k % 4 === 2) { i.status = FLOW[i.status] || 'open'; return emit('update', id) }
  const has = (i.labels || []).includes('t1')
  i.labels = has ? i.labels.filter((l) => l !== 't1') : [...(i.labels || []), 't1']
  return emit(has ? 'label_removed' : 'label_added', id)
}

const json = (res, d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)) }
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname
  if (p === '/api/meta') return json(res, meta())
  if (p === '/api/whoami') return json(res, { actor: 'alex', source: 'gateway', role: 'owner', approval: 'label' })
  if (p === '/api/links') return json(res, { links: [] })
  if (p === '/api/presence') return json(res, { agents })
  if (p === '/api/waiting') return json(res, { items: [...items.values()].filter((i) => i.labels.includes('needs-you') && i.status !== 'closed').slice(0, 4).map((i) => ({ id: i.id, title: i.title, age_min: 5, labels: i.labels, you: 'Reply: is this right?', card: null })), more: 0 })
  if (p === '/api/to-review') return json(res, { since: iso(60), items: [], more: 0 })
  if (p.startsWith('/api/workers/')) return json(res, { workers: [], commits: [], branch: null })
  if (p.startsWith('/api/content/') || p.startsWith('/api/artifacts/')) return json(res, { files: [] })
  if (p === '/api/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(':\n\n')
    streams.add(res); req.on('close', () => streams.delete(res)); return
  }
  if (p === '/api/v0/beads/events') {
    const since = Number(u.searchParams.get('since') || 0), limit = Number(u.searchParams.get('limit') || 40)
    return json(res, { head: seq, records: records.filter((r) => r.seq > since).slice(0, limit) })
  }
  if (p === '/api/v0/beads/issues') {
    const closed = u.searchParams.get('status') === 'closed'
    return json(res, { items: [...items.values()].filter((i) => (i.status === 'closed') === closed), has_more: false })
  }
  if (p === '/api/v0/beads/ready') return json(res, { items: readyNow(), has_more: false })
  const one = /^\/api\/v0\/beads\/issues\/([\w.-]+)$/.exec(p)
  if (one && items.has(one[1])) return json(res, { ...items.get(one[1]), comments: comments.get(one[1]) || [] })
  if (p.startsWith('/api/')) return json(res, {})
  const f = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''))
  const file = fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`

// ---------- the render counter: a stand-in React DevTools hook ----------
const HOOK = () => {
  const P = (window.__perf = { renders: {}, cards: [], commits: 0 })
  const nameOf = (f) => {
    const t = f.type
    if (!t) return null
    if (f.tag === 11) return t.displayName || t.render?.displayName || t.render?.name || 'ForwardRef'
    return t.displayName || t.name || null
  }
  const count = (f) => {
    if (f.tag !== 0 && f.tag !== 1 && f.tag !== 11 && f.tag !== 15) return
    const n = nameOf(f)
    if (!n) return
    P.renders[n] = (P.renders[n] || 0) + 1
    if (n === 'Card' && f.memoizedProps?.issue) P.cards.push(f.memoizedProps.issue.id)
  }
  // the DevTools' rule: a mounted fiber rendered; an updated one did work (PerformedWork); a parent whose child list
  // was not cloned bailed out with its whole subtree
  const walk = (next, prev) => {
    if (!prev) count(next)
    else if (next.flags & 1) count(next)
    if (prev && next.child === prev.child) return
    for (let c = next.child; c; c = c.sibling) walk(c, c.alternate)
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject() { return 1 }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { P.commits++; const cur = root.current; walk(cur, cur.alternate) },
  }
}

// ---------- the run ----------
const browser = await chromium.launch({ executablePath: exe })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript(HOOK)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
let phase = null
const calls = {}
page.on('request', (r) => {
  const u = new URL(r.url())
  if (!phase || !u.pathname.startsWith('/api/') || u.pathname.endsWith('events:watch')) return
  const k = u.pathname.replace(/\/sy-\d+$/, '/<id>')
  ;(calls[phase] ||= {})[k] = ((calls[phase] ||= {})[k] || 0) + 1
})
const cdp = await ctx.newCDPSession(page)
await cdp.send('Performance.enable')
await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE })
// main-thread time so far, in ms: all tasks (scripts, style, layout, paint) and the scripts alone
const cpu = async () => {
  const m = (await cdp.send('Performance.getMetrics')).metrics
  const v = (name) => m.find((x) => x.name === name).value * 1000
  return { task: v('TaskDuration'), script: v('ScriptDuration') }
}

step('open the board as a person, 390 px')
await page.goto(`${BASE}/`)
await page.waitForSelector('text=Needs you', { timeout: 20000 })
await sleep(2500)

const PHASES = [
  { key: 'foryou', label: 'For you', go: async () => { } },
  { key: 'board', label: 'Board', go: async () => { await page.evaluate(() => { location.hash = '#board' }); await page.waitForSelector('[data-card]') } },
  { key: 'item', label: 'Open item', go: async () => {
    await page.evaluate((id) => { history.pushState({ mmItem: true }, '', `/?item=${id}#board`); dispatchEvent(new PopStateEvent('popstate')) }, OPEN)
    await page.waitForSelector(`[data-comment="24"]`, { timeout: 20000 })
  } },
]
const results = []
const per = Math.round(EVENTS / PHASES.length)
const openIds = () => [...items.values()].filter((i) => i.status !== 'closed' && i.issue_type !== 'epic').map((i) => i.id)
let k = 0, rnd = 7
for (const [pi, ph] of PHASES.entries()) {
  step(`${ph.label}: ${pi === PHASES.length - 1 ? EVENTS - k : per} events`)
  await ph.go()
  await sleep(2500) // settle: the view's own first loads are not the events'
  // the idle baseline: the same view for IDLE_MS with no event (polls, the CSS animations of who is working)
  // (with the test's own read per event, so the difference is the events' cost)
  const i0 = await cpu()
  for (let s = 0; s < IDLE_MS / (SPAN_MS / EVENTS); s++) { await page.evaluate(() => window.__perf.cards.splice(0)); await sleep(SPAN_MS / EVENTS) }
  const i1 = await cpu()
  const idle = { task: (i1.task - i0.task) / (IDLE_MS / 1000), script: (i1.script - i0.script) / (IDLE_MS / 1000) } // ms per s
  await page.evaluate(() => { window.__perf.renders = {}; window.__perf.cards = []; window.__perf.commits = 0 })
  phase = ph.key
  const t0 = await cpu()
  const n = pi === PHASES.length - 1 ? EVENTS - k : per
  const foreign = [] // cards rendered for an event on another item
  let prevId = null
  for (let j = 0; j < n; j++, k++) {
    rnd = (rnd * 1103515245 + 12345) % 2147483648
    const ids = openIds()
    const id = ph.key === 'item' && j % 3 === 0 ? OPEN : ids[rnd % ids.length]
    // the cards rendered since the previous event belong to it; read them, then send the next
    const before = await page.evaluate(() => window.__perf.cards.splice(0))
    if (j > 0) foreign.push(...before.filter((c) => c !== prevId))
    prevId = id
    event(k, id)
    if (k % 10 === 9) agents = agents.map((a, x) => (x === k % agents.length ? { ...a, doing: `step ${k}` } : a)) // presence moves now and then
    await sleep(SPAN_MS / EVENTS)
  }
  await sleep(1000)
  const tail = await page.evaluate(() => window.__perf.cards.splice(0))
  foreign.push(...tail.filter((c) => c !== prevId))
  const t1 = await cpu()
  const secs = (n * SPAN_MS) / EVENTS / 1000 + 1
  phase = null
  const r = await page.evaluate(() => ({ renders: window.__perf.renders, commits: window.__perf.commits }))
  const total = Object.values(r.renders).reduce((a, b) => a + b, 0)
  const nCalls = Object.values(calls[ph.key] || {}).reduce((a, b) => a + b, 0)
  results.push({ phase: ph.label, key: ph.key, events: n, renders: total / n, cards: (r.renders.Card || 0) / n, foreignCards: foreign.length, calls: nCalls / n,
    ms: (t1.task - t0.task) / n, script: (t1.script - t0.script) / n, idle: idle.task,
    // what the events cost above the same view idle (the idle's polls and animations taken out)
    net: (t1.task - t0.task - idle.task * secs) / n, scriptNet: (t1.script - t0.script - idle.script * secs) / n, commits: r.commits / n,
    top: Object.entries(r.renders).sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.BOARD_PERF_TOP) || 8).map(([c, v]) => `${c} ${(v / n).toFixed(1)}`), byPath: calls[ph.key] || {} })
}
await browser.close(); srv.close()

// ---------- the table ----------
const f1 = (x) => x.toFixed(1)
const lines = ['| view | events | renders / event | card renders / event | other cards re-rendered | calls / event | main-thread ms / event | of it script | script ms / event over idle | idle main-thread ms / s | commits / event |', '|---|---|---|---|---|---|---|---|---|---|---|']
for (const r of results) lines.push(`| ${r.phase} | ${r.events} | ${f1(r.renders)} | ${f1(r.cards)} | ${r.foreignCards} | ${f1(r.calls)} | ${f1(r.ms)} | ${f1(r.script)} | ${f1(r.scriptNet)} | ${f1(r.idle)} | ${f1(r.commits)} |`)
lines.push('', `CPU slowed ${CPU_RATE}x (a phone), 390x844. ms are per event, the polls and animations of the same time included; "over idle" takes out what the same view spends with no event.`)
lines.push('', 'Most renders per event:', ...results.map((r) => `- ${r.phase}: ${r.top.join(', ')}`))
lines.push('', 'Calls per path (whole phase):', ...results.map((r) => `- ${r.phase}: ${Object.entries(r.byPath).map(([p, v]) => `${p} ${v}`).join(', ') || 'none'}`))
step('the numbers')
console.log(lines.join('\n'))
if (process.env.BOARD_PERF_OUT) {
  fs.writeFileSync(process.env.BOARD_PERF_OUT, lines.join('\n') + '\n')
  fs.writeFileSync(process.env.BOARD_PERF_OUT.replace(/\.md$/, '') + '.json', JSON.stringify(results, null, 2))
}

step('the budget')
ok('no page errors', errors.length === 0, errors.join('\n'))
ok(`${EVENTS} events replayed`, results.reduce((a, r) => a + r.events, 0) === EVENTS)
if (!process.env.BOARD_PERF_NOBUDGET) {
  const board = results.find((r) => r.key === 'board')
  ok('on the Board an event re-renders only its own card (no other card renders)', board.foreignCards === 0, `${board.foreignCards} other card renders`)
  ok('on the Board at most one card render per event', board.cards <= 1.05, `${f1(board.cards)} per event`)
  for (const r of results) {
    const b = BUDGET[r.key]
    ok(`${r.phase}: at most ${b.calls} calls per event (${f1(r.calls)})`, r.calls <= b.calls, JSON.stringify(r.byPath))
    ok(`${r.phase}: at most ${b.renders} component renders per event (${f1(r.renders)})`, r.renders <= b.renders, r.top.join(', '))
    ok(`${r.phase}: under ${b.script} ms of script per event (${f1(r.script)})`, r.script < b.script)
  }
}
fs.rmSync(T, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
