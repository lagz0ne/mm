#!/usr/bin/env node
// The board's pull model and flow panels (sy-6h43): (1) site/pull-state.mjs on its own: queue order, work in progress
// against capacity, the lease colours at 24/26/31 min, a requeue read from the journal; (2) the board's server against a
// fake bd serve, a stub paseo and a fake VictoriaMetrics export: /api/pull (queues, claims, leases, requeues, workers),
// /api/flow (the same rows and event range as `mm obs flow <project>` over the same series, only this project's), and
// /api/summary's worst signal (whole numbers and one role id). Hermetic: a temp folder, no built site needed.
//   node test/board-pull.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-pull-'))
const BUN = process.env.BUN || path.join(os.homedir(), '.bun', 'bin', 'bun')
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN = 60e3, NOW = Date.now(), ago = (m) => new Date(NOW - m * MIN).toISOString()

const { pullState, foldRequeues, leaseOf } = await import(path.join(SRC, 'template', 'site', 'pull-state.mjs'))
const { waitingFor, plainTitle, youLine, MAX_BYTES, YOU_MAX, CARD_FIELDS } = await import(path.join(SRC, 'template', 'site', 'waiting.mjs'))

// ---------- the fixture board ----------
const PROJECT = 'pb'
const it = (id, assignee, status, m, f = {}) => ({ id, title: `title ${id}`, assignee, status, priority: 2, labels: [], updated_at: ago(m), ...f })
const items = [
  it('pb-1', 'code', 'in_progress', 24), // lease ok
  it('pb-2', 'code/worker', 'in_progress', 26), // a worker's claim: the role's, near
  it('pb-3', 'code', 'in_progress', 31), // over: expired, not requeued yet (the lead is in a turn)
  it('pb-4', 'review', 'open', 40, { priority: 1 }),
  it('pb-5', 'review', 'open', 10, { priority: 0 }),
  it('pb-6', 'review', 'open', 90, { labels: ['needs-you'] }), // waits for the human: not in the queue
  it('pb-7', 'ops', 'open', 5), // requeued by wake (expiry 2 of 3)
  it('pb-8', 'ops', 'open', 50), // put back by a person: not a requeue
  it('pb-10', 'code', 'in_progress', 2), // requeued once, claimed again
  it('pb-11', 'setup', 'in_progress', 40), // setup: no capacity, no lease
  it('pb-12', 'code', 'closed', 1),
  it('pb-13', 'review', 'blocked', 3),
]
// bd ready: open, no open blocker, in bd's order (what wake hands next)
const ready = ['pb-5', 'pb-4', 'pb-6', 'pb-8', 'pb-7'].map((id) => items.find((i) => i.id === id))
const snap = (id, f) => ({ ...items.find((i) => i.id === id), ...f })
let seq = 0
const ev = (op, id, actor, m, f = {}, extra = {}) => ({ seq: ++seq, ts: ago(m), op, issue_id: id, actor, ...(op === 'comment' ? {} : { issue: snap(id, f) }), ...extra })
const requeueText = (id, role, n) => `Requeued: in progress with no update for 30 min, so wake put it back in the ${role} queue (status open; expiry ${n} of 3). Claim it again with bd update ${id} --claim.`
const records = [
  ev('create', 'pb-7', 'alex', 120, { status: 'open' }),
  ev('update', 'pb-7', 'ops', 100, { status: 'in_progress' }),
  ev('update', 'pb-7', 'wake', 5, { status: 'open', assignee: 'ops' }),
  ev('comment', 'pb-7', 'wake', 5, {}, { comment: { id: 'c1', author: 'wake', text: requeueText('pb-7', 'ops', 2) } }),
  ev('update', 'pb-8', 'ops', 110, { status: 'in_progress' }),
  ev('update', 'pb-8', 'alex', 50, { status: 'open' }),
  ev('update', 'pb-10', 'code', 70, { status: 'in_progress' }),
  ev('update', 'pb-10', 'wake', 35, { status: 'open' }),
  ev('comment', 'pb-10', 'wake', 35, {}, { comment: { id: 'c2', author: 'wake', text: requeueText('pb-10', 'code', 1) } }),
  ev('update', 'pb-10', 'code', 2, { status: 'in_progress' }),
]
const ROLES = [{ id: 'code', title: 'Code', initial: 'C', color: '#000000', workers: true, capacity: 3 }, { id: 'review', title: 'Review', initial: 'R', color: '#000000' },
  { id: 'ops', title: 'Ops', initial: 'O', color: '#000000', capacity: 2 }]

step('site/pull-state.mjs')
ok('lease: 24 min ok, 26 min near (amber), 31 min over (expired)', leaseOf(24 * MIN) === 'ok' && leaseOf(26 * MIN) === 'near' && leaseOf(31 * MIN) === 'over' && leaseOf(25 * MIN) === 'near' && leaseOf(30 * MIN) === 'over')
const marks = {}, seen = {}
foldRequeues(marks, seen, records)
ok('the journal: pb-7 requeued by wake, expiry 2 of 3', marks['pb-7']?.n === 2 && marks['pb-7']?.of === 3 && marks['pb-7']?.at === ago(5), JSON.stringify(marks))
ok('...not pb-8 (a person put it back), not pb-10 (claimed again since)', !marks['pb-8'] && !marks['pb-10'])
const m2 = { ...marks }, s2 = JSON.parse(JSON.stringify(seen))
foldRequeues(m2, s2, [ev('update', 'pb-7', 'alex', 1, { status: 'open', assignee: 'review' })])
ok('...a requeued item handed to another role loses the mark', !m2['pb-7'])
const P = Object.fromEntries(pullState({ roles: ['code', 'review', 'ops', 'setup'], capacity: { code: 3, ops: 2 }, items, ready, requeues: marks, now: NOW }).map((r) => [r.role, r]))
ok('queue: the role\'s ready items in bd\'s order, not needs-you, not blocked (review: pb-5 then pb-4)', P.review.queue.map((q) => q.id).join() === 'pb-5,pb-4')
ok('...with the wait since the last update', P.review.queue[1].wait_s === 2400)
ok('work in progress vs capacity: code 4 / 3 (its worker\'s claim counts; a P0 may go past by one), review 0 / 1 (the default), ops 0 / 2', P.code.wip === 4 && P.code.capacity === 3 && P.review.wip === 0 && P.review.capacity === 1 && P.ops.capacity === 2)
ok('...a closed item is not a claim; pb-10 (claimed again) is', !P.code.claims.some((c) => c.id === 'pb-12') && P.code.claims.some((c) => c.id === 'pb-10'))
ok('claims: oldest first, each with its age and lease', P.code.claims.map((c) => `${c.id}:${c.lease}`).join() === 'pb-3:over,pb-2:near,pb-1:ok,pb-10:ok' && P.code.claims[0].age_s === 1860)
ok('...the lease time left (negative once over: 0)', P.code.claims.find((c) => c.id === 'pb-1').left_s === 360 && P.code.claims.find((c) => c.id === 'pb-3').left_s === 0)
ok('a requeued item: in the queue, marked, counted (ops 1)', P.ops.queue.find((q) => q.id === 'pb-7')?.requeued?.n === 2 && P.ops.requeued === 1 && !P.ops.queue.find((q) => q.id === 'pb-8').requeued)
ok('setup: no capacity, no lease', P.setup.capacity === null && P.setup.claims[0]?.lease === 'ok' && P.setup.claims[0]?.left_s === null)

step('site/waiting.mjs (the gateway\'s "Waiting for you" list, sy-vdi8)')
{
  // an owner card as written by hand (sy-z5lz)
  const CARD = '## Owner\n- **What:** A fixed short card at the top of each item that needs you.\n- **Why:** You see in 6 lines what is asked and why.\n- **You:** Reply: ok, or say which line to change.\n\nThe thread.'
  const W = [
    it('pb-20', 'review', 'open', 90, { labels: ['needs-you'], title: 'owner needed', description: CARD }),
    it('pb-21', 'ops', 'open', 30, { labels: ['t2', 'signed-off'], title: 'approve me' }),
    it('pb-22', 'ops', 'open', 20, { labels: ['t2', 'signed-off', 'approved'], title: 'approved already' }),
    it('pb-23', 'alex', 'in_progress', 10, { title: 'alex\'s own', labels: ['needs-you', 'bug'], description: CARD.replace('Reply: ok, or say which line to change.', 'Check: the\u202e shot,\u0007 artifacts/pb-23/a.png') }),
    it('pb-24', 'alex', 'closed', 5, { title: 'alex closed' }),
    it('pb-25', 'bob', 'open', 5, { title: 'bob\'s' }),
    it('pb-26', 'ops', 'open', 40, { labels: ['needs-you', 't2', 'signed-off'], title: 'both' }),
    it('PB-27', 'alex', 'open', 1, { title: 'odd id' }),
    it('pb-28', 'alex', 'blocked', 3, { title: 'a\u0007b\u202eevil\ncd' }),
  ]
  const o = waitingFor({ items: W, me: 'boss', owner: true, now: NOW })
  ok('the owner: needs-you items and the signed-off t2s without approved, oldest first', o.items.map((x) => x.id).join() === 'pb-20,pb-26,pb-21,pb-23' && o.more === 0, JSON.stringify(o))
  ok('...each with only the labels its ask needs (no bug, no approved), age in whole minutes', JSON.stringify(o.items.find((x) => x.id === 'pb-26').labels) === '["needs-you","t2","signed-off"]'
    && JSON.stringify(o.items.find((x) => x.id === 'pb-23').labels) === '["needs-you"]' && o.items[0].age_min === 90 && o.items.every((x) => Object.keys(x).join() === 'id,title,age_min,labels,you'))
  ok('...and each its card\'s You line (sy-z5lz); null when it has no card (the gateway says "card missing")', o.items.find((x) => x.id === 'pb-20').you === 'Reply: ok, or say which line to change.'
    && o.items.find((x) => x.id === 'pb-26').you === null && o.items.find((x) => x.id === 'pb-21').you === null, JSON.stringify(o.items))
  ok('...the You line as plain text, like a title: control and bidi characters out', o.items.find((x) => x.id === 'pb-23').you === 'Check: the shot, artifacts/pb-23/a.png')
  const lng = youLine(CARD.replace('Reply: ok, or say which line to change.', `Reply: ${'w'.repeat(200)}`)), bad = youLine(CARD.replace('**You:** Reply: ok, or say which line to change.', '**You:** \u202e'))
  ok(`...cut to ${YOU_MAX} characters (an invalid card's You still shows: its own detail says invalid); none for no card, an empty one`, Array.from(lng).length === YOU_MAX && lng.endsWith('…') && youLine('no card') === null && bad === null)
  // sy-92sg: with ?card=1 the owner's entries carry the card's fields, plain text, each cut to the card's limit
  const T2CARD = `## Owner\n- **What:** Rotate <b>the</b> key\u202e now.\n- **Why:** ${'w'.repeat(130)}\n- **You:** Tap Approve\n- **If yes:** it runs\n- **If no:** it waits\n- **Risk:** low, a minute\n- **Link:** https://evil.example/\n\nThread.`
  const c = waitingFor({ items: [...W, it('pb-29', 'ops', 'open', 50, { labels: ['t2', 'signed-off'], title: 'carded', description: T2CARD })], me: 'boss', owner: true, now: NOW, cards: true })
  const cc = c.items.find((x) => x.id === 'pb-29').card
  ok('?card=1, the owner: each entry also has card: the fields the card has, plain text (control and bidi out), cut to its limit; no Link', JSON.stringify(Object.keys(cc)) === '["what","why","you","if_yes","if_no","risk"]'
    && cc.what === 'Rotate <b>the</b> key now.' && Array.from(cc.why).length === CARD_FIELDS.why[1] && cc.why.endsWith('…') && cc.risk === 'low, a minute' && cc.you === 'Tap Approve', JSON.stringify(cc))
  ok('...null for an item with no card; the other keys as before', c.items.find((x) => x.id === 'pb-21').card === null && c.items.every((x) => Object.keys(x).join() === 'id,title,age_min,labels,you,card'))
  ok('...without ?card=1 no card key (an older gateway drops an entry with a key it doesn\'t know); never for a member', !o.items.some((x) => 'card' in x)
    && !waitingFor({ items: W, me: 'alex', owner: false, now: NOW, cards: true }).items.some((x) => 'card' in x))
  // sy-hzmu: with ?card=1&head=1 the card also carries its Head, and an entry whose head review did not sign off its reason
  const HCARD = (h) => T2CARD.replace('- **Link:**', `- **Head:** ${h}\n- **Link:**`)
  const hi = [it('pb-30', 'ops', 'open', 40, { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], title: 'moved', description: HCARD('mm@9f8e7d6') }),
    it('pb-31', 'ops', 'open', 40, { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], title: 'signed', description: HCARD('mm@0a1b2c3') }),
    it('pb-32', 'ops', 'open', 40, { labels: ['t2', 'signed-off'], title: 'bad head', description: HCARD('mm@main') })]
  const h2 = waitingFor({ items: hi, me: 'boss', owner: true, now: NOW, cards: 2 }), h1 = waitingFor({ items: hi, me: 'boss', owner: true, now: NOW, cards: true })
  const e = (r, id) => r.items.find((x) => x.id === id)
  ok('?card=1&head=1: the card has head (<repo>@<sha>, plain text), after the other fields', e(h2, 'pb-30').card.head === 'mm@9f8e7d6' && e(h2, 'pb-31').card.head === 'mm@0a1b2c3'
    && Object.keys(e(h2, 'pb-31').card).pop() === 'head', JSON.stringify(h2))
  ok('...an invalid Head is not sent as head (its refusal says why)', !('head' in e(h2, 'pb-32').card) && /the card's Head is not/.test(e(h2, 'pb-32').refused || ''))
  ok('...a moved head: refused, the reason (headRefusal) as plain text', e(h2, 'pb-30').refused === "the head changed since review's sign-off (card: mm@9f8e7d6, signed: mm@0a1b2c3)")
  ok('...the signed head: no refused key', !('refused' in e(h2, 'pb-31')))
  ok('?card=1 alone (an older gateway): no head, no refused', h1.items.every((x) => !('refused' in x) && x.card && !('head' in x.card)))
  // sy-t9tg: a signed-off t2 whose card asks no go (Reply:/Check:/Nothing) is no approval: listed by needs-you only
  const NGC = (you) => `## Owner\n- **What:** Check the admin login.\n- **Why:** The plan needs sudo.\n- **You:** ${you}\n\nThread.`
  const ng = waitingFor({ items: [it('pb-40', 'ops', 'open', 30, { labels: ['t2', 'signed-off', 'needs-you'], title: 'ask', description: NGC('Check: run ssh admin@host, then sudo -v') }),
    it('pb-41', 'ops', 'open', 30, { labels: ['t2', 'signed-off', 'signed-head:mm@0a1b2c3'], title: 'no ny', description: NGC('Reply: which?') }),
    it('pb-42', 'ops', 'open', 30, { labels: ['t2', 'signed-off'], title: 'go, no card', description: 'no card' })], me: 'boss', owner: true, now: NOW, cards: 2 })
  ok('a signed-off t2 non-go ask with needs-you: labels needs-you only (no approval), its You, no refused', JSON.stringify(e(ng, 'pb-40')?.labels) === '["needs-you"]'
    && e(ng, 'pb-40').you === 'Check: run ssh admin@host, then sudo -v' && !('refused' in e(ng, 'pb-40')), JSON.stringify(ng))
  ok('...without needs-you: not on the list (it waits on nobody)', !e(ng, 'pb-41'))
  ok('...a signed-off t2 with no card is still an approval, with its refusal', JSON.stringify(e(ng, 'pb-42')?.labels) === '["t2","signed-off"]' && /names no head/.test(e(ng, 'pb-42').refused || ''))
  ok('a member never gets head or refused', waitingFor({ items: hi.map((x) => ({ ...x, assignee: 'alex' })), me: 'alex', owner: false, now: NOW, cards: 2 }).items.every((x) => !('refused' in x) && !('card' in x)))
  const m = waitingFor({ items: W, me: 'alex', owner: false, now: NOW })
  ok('a member: only the open items assigned to them (not closed, not the owner\'s needs-you, not a bad id)', m.items.map((x) => x.id).join() === 'pb-23,pb-28', JSON.stringify(m))
  ok('...with no labels at all (needs-you is the owner\'s ask)', m.items.every((x) => x.labels.length === 0))
  ok('...a You line only where the card has one (no "card missing" for a member)', m.items.find((x) => x.id === 'pb-23').you === 'Check: the shot, artifacts/pb-23/a.png' && !('you' in m.items.find((x) => x.id === 'pb-28')))
  ok('...a title\'s control and bidi characters become spaces', m.items.find((x) => x.id === 'pb-28').title === 'a b evil cd')
  ok('no name (a viewer with none, the local side): nothing', waitingFor({ items: W, me: '', owner: false, now: NOW }).items.length === 0)
  const long = plainTitle('x'.repeat(500)), astral = plainTitle('\u{1F600}'.repeat(300))
  ok('a title over 200 characters is cut to 200 (with an ellipsis), counted in characters; an empty one says so', Array.from(long).length === 200 && long.endsWith('…') && Array.from(astral).length === 200 && plainTitle('  ') === '(no title)')
  const many = Array.from({ length: 400 }, (_, k) => it(`pb-${1000 + k}`, 'alex', 'open', k, { title: '\u00e9'.repeat(200) }))
  const big = waitingFor({ items: many, me: 'alex', owner: false, now: NOW })
  ok(`a long list stays under 32 KB: what doesn't fit is counted in more (${big.items.length} kept, ${big.more} more)`, Buffer.byteLength(JSON.stringify(big)) <= MAX_BYTES && big.more > 0 && big.items.length + big.more === 400 && big.items[0].id === 'pb-1399')
}

// ---------- a fake VictoriaMetrics export: flow series of this project and another, duplicates kept ----------
const FNOW = Date.parse('2026-11-05T12:00:00Z'), H = 3600e3
const series = []
const add = (name, labels, pts) => series.push({ metric: { __name__: name, ...labels }, values: pts.map((p) => p[1]), timestamps: pts.map((p) => p[0]) })
const at = (h) => FNOW - h * H
for (const project of [PROJECT, 'other']) {
  const k = project === PROJECT ? 1 : 7
  add('mm_flow_queue_wait_seconds', { project, role: 'code', item: `${project}-1` }, [[at(2), 600 * k], [at(2), 600 * k]]) // sent twice: one sample
  add('mm_flow_queue_wait_seconds', { project, role: 'code', item: `${project}-2` }, [[at(30), 1800 * k]]) // only in 7 d
  add('mm_flow_queue_wait_seconds', { project, role: 'review', item: `${project}-3` }, [[at(1), 300 * k]])
  add('mm_flow_cycle_seconds', { project, role: 'code', item: `${project}-1` }, [[at(1), 3600 * k]])
  add('mm_flow_cycle_seconds', { project, role: 'code', item: `${project}-2` }, [[at(28), 7200 * k]])
  add('mm_flow_paused_seconds', { project, role: 'code', item: `${project}-1`, rail: 'all' }, [[at(1), 120]])
  add('mm_flow_handoff_wait_seconds', { project, role: 'review', item: `${project}-1` }, [[at(1.5), 900 * k]])
  add('mm_flow_review_first_pass', { project, role: 'code', item: `${project}-1` }, [[at(1.2), 1]])
  add('mm_flow_review_first_pass', { project, role: 'code', item: `${project}-4` }, [[at(3), 0]])
  add('mm_flow_reopened_total', { project, role: 'code', item: `${project}-5` }, [[at(4), 1]])
  add('mm_flow_escaped_total', { project, role: 'code', item: `${project}-6` }, [[at(50), 1]])
  add('mm_flow_lease_expired_total', { project, role: 'ops', item: `${project}-7` }, [[at(5), 1]])
  add('mm_flow_wip', { project, role: 'code' }, [[FNOW - 20 * MIN, 1], [FNOW - 5 * MIN, 2]])
  add('mm_flow_capacity', { project, role: 'code' }, [[FNOW - 5 * MIN, 3]])
  add('mm_flow_needs_you_age_seconds', { project, role: 'review', item: `${project}-8` }, [[FNOW - 5 * MIN, 5400]])
  add('mm_flow_journal_first_seq', { project }, [[FNOW - 5 * MIN, 1]])
  add('mm_flow_journal_last_seq', { project }, [[FNOW - 5 * MIN, 240 * k]])
  add('mm_flow_journal_first_time', { project }, [[FNOW - 5 * MIN, (FNOW - 6 * 86400e3) / 1000]])
  add('mm_flow_journal_last_time', { project }, [[FNOW - 5 * MIN, (FNOW - 10 * MIN) / 1000]])
}
add('mm_flow_cycle_seconds', { project: PROJECT, role: 'code', item: `${PROJECT}-9` }, [[at(24 * 9), 99999]]) // older than the export's range
let exports = []
const vmSrv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  for await (const _ of req) { /* drain */ }
  if (req.method === 'POST') { res.writeHead(204); return res.end() } // the board's own metrics: taken, not kept
  if (u.pathname !== '/api/v1/export') { res.writeHead(404); return res.end() }
  const sel = u.searchParams.get('match[]') || '', pj = /project="([^"]*)"/.exec(sel)?.[1], s = Number(u.searchParams.get('start')) * 1000, e = Number(u.searchParams.get('end')) * 1000
  exports.push(sel)
  const out = []
  for (const x of series) {
    if (!/^mm_flow_/.test(x.metric.__name__) || (pj && x.metric.project !== pj)) continue
    const keep = x.timestamps.map((t, i) => [t, x.values[i]]).filter(([t]) => t >= s && t <= e)
    if (keep.length) out.push(JSON.stringify({ metric: x.metric, values: keep.map((p) => p[1]), timestamps: keep.map((p) => p[0]) }))
  }
  res.writeHead(200); res.end(out.join('\n') + '\n')
})
await new Promise((r) => vmSrv.listen(0, '127.0.0.1', r))
const VM = `http://127.0.0.1:${vmSrv.address().port}`

// ---------- the board: a copy of the template's site and bin, roles, a stub paseo, a fake bd serve ----------
const B = path.join(T, 'board')
fs.cpSync(path.join(SRC, 'template', 'site'), path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules|\/dist(\/|$)/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
for (const r of ['code', 'review', 'ops']) fs.mkdirSync(path.join(B, 'leads', r), { recursive: true })
fs.mkdirSync(path.join(B, 'setup'), { recursive: true }); fs.mkdirSync(path.join(B, 'worktrees', 'w-pb-9'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: ROLES }))
const agentsJson = JSON.stringify([
  { id: 'agent-code', shortId: 'lcode', title: 'pb · code lead', status: 'running', cwd: `${B}/leads/code`, labels: { project: PROJECT, role: 'code' } },
  { id: 'agent-w3', shortId: 'w3', title: 'pb · code worker pb-3', status: 'running', cwd: '/elsewhere/wt-3', labels: { project: PROJECT, role: 'code-worker', item: 'pb-3' } },
  { id: 'agent-w2', shortId: 'w2', title: 'pb · review worker pb-13', status: 'idle', cwd: '/elsewhere/wt-13' }, // the CLI's list: no labels, the name says it
  { id: 'agent-w9', shortId: 'w9', title: 'something', status: 'running', cwd: `${B}/worktrees/w-pb-9` }, // a worker's worktree here
  { id: 'agent-zz', shortId: 'zz', title: 'zz · code worker zz-1', status: 'running', cwd: '/elsewhere/zz', labels: { project: 'zz', role: 'code-worker', item: 'zz-1' } },
  { id: 'agent-x', shortId: 'x', title: 'pb · ops helper', status: 'running', cwd: '/elsewhere/x', labels: { project: PROJECT, role: 'ops' } },
])
fs.writeFileSync(path.join(T, 'agents.json'), agentsJson)
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh\ncase "$1" in\n  ls) cat '${path.join(T, 'agents.json')}' ;;\n  logs) echo '' ;;\nesac\n`, { mode: 0o755 })
const bdSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events') return json({ head: seq, records: records.filter((x) => x.seq > Number(u.searchParams.get('since') || 0)) })
  if (u.pathname === '/v0/beads/ready') return json({ items: ready, has_more: false })
  if (u.pathname === '/v0/beads/issues') return json({ items: items.filter((i) => i.status !== 'closed'), has_more: false })
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const PORT = probe.address().port; probe.close()
const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1',
  BOARD_PROJECT: PROJECT, MM_PROJECT: PROJECT, MM_OBS_TRACES: '', MM_OBS_METRICS: `${VM}/api/v1/import/prometheus`, BOARD_FLOW_NOW: String(FNOW) }
delete env.MM_SERVICE; delete env.MM_BIND
const s = spawn('node', [path.join(B, 'site', 'server.mjs')], { cwd: B, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; s.stdout.on('data', (d) => (out += d)); s.stderr.on('data', (d) => (out += d))
const get = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.json())
const runp = (cmd, args, e) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let o = '', er = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (er += d))
  p.on('close', (code) => resolve({ code, out: o, err: er }))
})
try {
  step('the board: /api/pull')
  let pull = null
  for (let i = 0; i < 50 && !pull?.roles; i++) { try { pull = await get('/api/pull') } catch { await sleep(200) } }
  for (let i = 0; i < 30 && !(pull?.roles || []).some((r) => r.workers.length); i++) { await sleep(300); pull = await get('/api/pull').catch(() => pull) } // the first agent poll
  const R = Object.fromEntries((pull?.roles || []).map((r) => [r.role, r]))
  ok('a row for every role and setup, in roles.json order', (pull?.roles || []).map((r) => r.role).join() === 'code,review,ops,setup')
  ok('queue order: review pb-5 (P0) then pb-4; needs-you and blocked left out', R.review?.queue.map((q) => q.id).join() === 'pb-5,pb-4')
  ok('WIP vs capacity: code 4 / 3, review 0 / 1, ops 0 / 2, setup none', R.code?.wip === 4 && R.code?.capacity === 3 && R.review?.capacity === 1 && R.ops?.capacity === 2 && R.setup?.capacity === null)
  ok('leases: pb-1 (24 min) ok, pb-2 (26 min) near, pb-3 (31 min) over', ['pb-1:ok', 'pb-2:near', 'pb-3:over'].every((x) => R.code?.claims.some((c) => `${c.id}:${c.lease}` === x)))
  ok('after a requeue: pb-7 in ops\' queue, marked requeued, expiry 2 of 3; pb-8 and pb-10 not', R.ops?.queue.find((q) => q.id === 'pb-7')?.requeued?.n === 2 && R.ops?.requeued === 1 && !R.ops?.queue.find((q) => q.id === 'pb-8')?.requeued)
  const wk = (role) => (R[role]?.workers || []).map((w) => `${w.id}:${w.item}:${w.status}`).sort().join()
  ok('workers: code has w3 on pb-3 (labels) and w9 on pb-9 (its worktree here)', wk('code') === 'w3:pb-3:running,w9:pb-9:running', wk('code'))
  ok('...review has w2 on pb-13 (the CLI\'s list: no labels, its name says it)', wk('review') === 'w2:pb-13:idle', wk('review'))
  ok('...not the code lead, not another project\'s worker, not an agent that is no worker', !JSON.stringify(pull).includes('lcode') && !JSON.stringify(pull).includes('zz-1') && !(R.ops?.workers || []).length)
  const meta = await get('/api/meta')
  ok('/api/meta: the code lead is still the code lead, the workers in _workers', meta.leads?.code?.id === 'lcode' && (meta.leads?._workers || []).length === 3)

  step('the board: /api/flow = mm obs flow, from the same series')
  const flow = await get('/api/flow')
  const MMH = path.join(T, 'mmhome'); fs.mkdirSync(MMH, { recursive: true })
  fs.writeFileSync(path.join(MMH, 'config.yaml'), `metrics_port: ${vmSrv.address().port}\ntraces_port: ${vmSrv.address().port}\nlogs_port: ${vmSrv.address().port}\n`)
  const r = await runp(BUN, [path.join(SRC, 'src/cli.ts'), '-o', 'json', 'obs', 'flow', PROJECT], { PATH: process.env.PATH, HOME: path.join(T, 'home'), MM_HOME: MMH, MM_OBS_TRACES: '', MM_FLOW_NOW: String(FNOW), NO_COLOR: '1' })
  let mm = null; try { mm = JSON.parse(r.out) } catch {}
  ok('mm obs flow ran (exit 0)', r.code === 0 && !!mm, r.err.slice(0, 300))
  ok('available, this project only', flow.available === true && flow.project === PROJECT && flow.rows.every((x) => x.project === PROJECT) && flow.rows.length === 6)
  ok('the rows equal mm obs flow\'s, value for value', JSON.stringify(flow.rows) === JSON.stringify(mm?.rows), `board ${JSON.stringify(flow.rows).slice(0, 300)}\n        mm    ${JSON.stringify(mm?.rows).slice(0, 300)}`)
  ok('the event range equals mm obs flow\'s', JSON.stringify(flow.events) === JSON.stringify(mm?.events) && flow.events[0]?.last_seq === 240, JSON.stringify(flow.events))
  const row = (role, w) => flow.rows.find((x) => x.role === role && x.window === w) || {}
  ok('code 24 h: queue p50 600 s (a sample sent twice is one), cycle 3600, first pass 50% of 2, reopened 1, WIP 2 of 3', row('code', '24h').queue_p50 === 600 && row('code', '24h').cycle_p50 === 3600 && row('code', '24h').first_pass === 0.5 && row('code', '24h').reviewed === 2 && row('code', '24h').reopened === 1 && row('code', '24h').wip === 2 && row('code', '24h').capacity === 3)
  ok('code 7 d: queue p95 1800, cycle p95 7200, escaped 1 (older samples count)', row('code', '7d').queue_p95 === 1800 && row('code', '7d').cycle_p95 === 7200 && row('code', '7d').escaped === 1)
  ok('review: handoff 900 s, needs-you 1, oldest 5400 s; ops: a lease expired', row('review', '24h').handoff_p50 === 900 && row('review', '24h').needs_you === 1 && row('review', '24h').needs_you_max === 5400 && row('ops', '24h').leases_expired === 1)
  ok('the store was asked for this project\'s flow series only', exports.length >= 2 && exports.every((x) => x === `{__name__=~"mm_flow_.+",project="${PROJECT}"}`), exports.join(' | '))
  ok('the pairs (speed next to quality) are mm obs flow\'s PAIRS', JSON.stringify(flow.pairs) === JSON.stringify({ queue: ['first_pass'], cycle: ['reopened', 'escaped'], handoff: ['first_pass'] }))

  step('the board: /api/summary\'s worst signal (numbers and one role id)')
  const old = await get('/api/summary')
  ok('without ?signal=1 (a gateway that reads only the counts): the five counts and the time, nothing more', Object.keys(old).sort().join() === 'blocked,last,mine,needs_you,open,p0', JSON.stringify(old))
  const sm = await get('/api/summary?signal=1')
  ok('the five counts as before', sm.open === 11 && sm.p0 === 1 && sm.blocked === 1 && sm.needs_you === 1 && sm.mine === 0, JSON.stringify(sm))
  ok('the worst queue: ops, 2 items, its head waits 50 min (review\'s waits 40)', sm.queue_role === 'ops' && sm.queue === 2 && sm.queue_min === 50, JSON.stringify(sm))
  ok('needs-you: the oldest waits 90 min; no approvals (not the owner)', sm.needs_you_min === 90 && sm.approvals === 0)
  ok('only whole numbers, one time and one role id: no title, no text', Object.entries(sm).every(([k, v]) => (k === 'last' ? typeof v === 'string' : k === 'queue_role' ? /^[a-z][a-z0-9-]{0,30}$/.test(v) : Number.isInteger(v))) && !/title/.test(JSON.stringify(sm)))

  step('the board: /api/waiting (the gateway\'s list; the roles are checked in test/auth.sh on the public side)')
  const wt = await get('/api/waiting')
  ok('the local side (a guest, not the owner): only its own items (none), the answer\'s shape', Array.isArray(wt.items) && wt.items.length === 0 && wt.more === 0 && Object.keys(wt).join() === 'items,more', JSON.stringify(wt))
} finally {
  s.kill(); bdSrv.close(); vmSrv.close()
  if (fail) console.log(`--- board output\n${out.slice(-2000)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
