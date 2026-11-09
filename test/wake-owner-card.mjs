#!/usr/bin/env node
// bin/wake and the owner card (sy-0omb): bd refuses needs-you unless the item's description starts with a valid owner
// card (bin/owner-card gate), and the owner is asked only through one.
//   - the hop limit: the item gets `paused` (never needs-you) and the board's Lead is woken with it; while `paused` is
//     on no lead is woken for the item; removing `paused` (the Lead or a human; another lead's removal is undone) resumes it, so does a human comment (wake then
//     removes the label itself);
//   - where wake asks the owner itself (a reassign to a person, a block nobody else can take, an upstream wait): an item
//     with no card gets a minimal one first, its old description below it unchanged; an item with a valid card keeps it;
//     an invalid card someone wrote, or a t2 go ask review has not signed off, is never written over: the Lead is woken
//     instead, and nothing is labelled;
//   - a refusal of bd's gate is a warn ("refused by bd"), tried once, never an error.
// Hermetic: temp folder, stub paseo, a stub bd that runs the template's real bin/owner-card gate for every needs-you,
// and a small fake bd-serve.
//   node test/wake-owner-card.mjs            exit 0 = every check passed
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const { parseCard } = await import(path.join(SRC, 'template', 'bin', 'lib', 'owner-card.mjs'))
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-owner-card-'))
let pass = 0, fail = 0
const ok = (d, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(200) } return false }

const ROLES = ['ops', 'review', 'platform']
const PROJ = path.join(T, 'proj')
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(PROJ, 'bin'), { recursive: true })
fs.mkdirSync(path.join(PROJ, 'leads'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'leads', 'roles.json'), JSON.stringify({ lead: 'ops', roles: ROLES.map((id) => ({ id })) }))
fs.mkdirSync(path.join(PROJ, 'control'), { recursive: true })
const SENT = path.join(T, 'sent.txt')
fs.writeFileSync(path.join(T, 'paseo'), `#!/bin/sh
case "$1" in
  ls) for r in ${ROLES.join(' ')}; do case "$*" in *role=$r*) echo "[{\\"id\\":\\"agent-$r\\",\\"shortId\\":\\"$r\\",\\"status\\":\\"idle\\"}]"; exit 0 ;; esac; done; echo '[]' ;;
  send) id=$2; shift; while [ $# -gt 0 ]; do [ "$1" = --prompt ] && printf 'TO %s\\n%s\\n----\\n' "$id" "$2" >>"${SENT}"; shift; done ;;
esac
`, { mode: 0o755 })

const now = () => new Date().toISOString()
const items = new Map()
const add = (id, f) => items.set(id, { id, title: `title of ${id}`, status: 'in_progress', assignee: 'platform', labels: [], description: '', updated_at: now(), ...f })
const CARD = '## Owner\n- **What:** Choose the name\n- **Why:** Two names fit\n- **You:** Reply: which name?\n\nThe rest, as the lead wrote it.'
const GO = '## Owner\n- **What:** Run the change\n- **Why:** It needs the go\n- **You:** Tap Approve\n- **If yes:** it runs\n- **If no:** it waits\n- **Risk:** low, one file\n- **Head:** mm@abcdef1'
for (const id of ['p-1', 'p-2']) add(id, { status: 'open' })
add('h-1', { description: 'Old text.\n\nSecond paragraph, `as is`.' }) // no card: wake writes one above it
add('h-2', { description: CARD }) // a valid card: kept as it is
add('h-3', { description: '## Owner\n- **What:** half a card' }) // an invalid card someone wrote: never written over
add('h-4', { description: GO, labels: ['t2'] }) // a t2 go ask with no sign-off: the gate would refuse it
add('b-1', { assignee: 'ops' }) // blocked by the Lead itself: nobody else to take it
add('u-1', { labels: ['upstream:engine'] }) // waits on the system board
add('r-1', { description: CARD }) // bd show answers with no card (it changed under wake): the gate refuses
const records = [], streams = []
let seq = 0, n = 0
const emit = (e) => { e.seq = ++seq; e.ts = now(); records.push(e); for (const s of streams) s.write(`data: ${JSON.stringify(e)}\n\n`) }
const change = (id, actor, f, op = 'update') => { const i = items.get(id); Object.assign(i, f, { updated_at: now() }); emit({ op, issue_id: id, actor, issue: { ...i } }) }
const comment = (id, author, text) => emit({ op: 'comment', issue_id: id, actor: author, issue: { ...items.get(id) }, comment: { id: `c${++n}`, author, text } })
// bd as the stub calls it: update --body-file, label add|remove, comments add; show --json for the gate
function bdCli(args) {
  const actor = args[args.indexOf('--actor') + 1] || 'nobody', flag = (f) => { const k = args.indexOf(f); return k >= 0 ? args[k + 1] : undefined }
  const [cmd, a1, a2, a3] = args, i = items.get(cmd === 'label' || cmd === 'comments' ? a2 : a1)
  if (!i) return { code: 1, err: `Issue ${a1} not found` }
  if (cmd === 'show') return { code: 0, out: JSON.stringify([{ ...i, description: i.id === 'r-1' ? 'changed: no card' : i.description }]) }
  if (cmd === 'update') { const f = {}; if (flag('--body-file')) f.description = fs.readFileSync(flag('--body-file'), 'utf8'); change(i.id, actor, f); return { code: 0 } }
  if (cmd === 'label') { change(i.id, actor, { labels: a1 === 'add' ? [...new Set([...i.labels, a3])] : i.labels.filter((l) => l !== a3) }); return { code: 0 } }
  if (cmd === 'comments' && a1 === 'add') { (i.comments ||= []).push({ author: actor, text: a3 }); comment(i.id, actor, a3); return { code: 0 } }
  return { code: 1, err: `stub bd: ${cmd}?` }
}
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n')
    streams.push(res); req.on('close', () => streams.splice(streams.indexOf(res), 1)); return
  }
  if (u.pathname === '/v0/beads/events') { const since = Number(u.searchParams.get('since') || 0); return json({ head: seq, records: records.filter((e) => e.seq > since) }) }
  if (u.pathname === '/v0/beads/ready') return json({ items: [] })
  const m = /^\/v0\/beads\/issues\/(.+)$/.exec(u.pathname)
  if (m) return items.has(decodeURIComponent(m[1])) ? json({ comments: [], ...items.get(decodeURIComponent(m[1])) }) : json({ title: 'not found' }, 404)
  if (u.pathname === '/v0/beads/issues') return json({ items: [...items.values()] })
  if (u.pathname === '/stub-bd') { let body = ''; for await (const c of req) body += c; return json(bdCli(JSON.parse(body))) }
  res.writeHead(404); res.end('{}')
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const BD = `http://127.0.0.1:${srv.address().port}`
// stub bin/bd: logs its arguments; a call that names needs-you goes through the template's real gate first (as bin/bd
// does), which reads the item with `bd show --json` (this stub again); then the fake board applies it
const BDLOG = path.join(T, 'bd.log')
fs.writeFileSync(path.join(PROJ, 'bin', 'bd'), `#!/usr/bin/env node
const fs = require('node:fs'), { spawnSync } = require('node:child_process'), path = require('node:path'); const a = process.argv.slice(2)
if (a[0] !== 'show') fs.appendFileSync(${JSON.stringify(BDLOG)}, a.map((x) => x.replace(/\\n/g, ' ')).join(' ') + '\\n')
if (['create', 'update', 'edit', 'label'].includes(a[0]) && a.some((x) => x.includes('needs-you'))) {
  const g = spawnSync(path.join(__dirname, 'owner-card'), ['gate', '--', ...a], { encoding: 'utf8' })
  if (g.status !== 0) { process.stderr.write(g.stderr); process.exit(1) }
}
fetch(${JSON.stringify(`${BD}/stub-bd`)}, { method: 'POST', body: JSON.stringify(a) }).then((r) => r.json()).then((r) => { if (r.out) console.log(r.out); if (r.err) console.error(r.err); process.exit(r.code) })
`, { mode: 0o755 })

const env = { ...process.env, BD_SERVE: BD, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', MM_PROJECT: 'wc', MM_OBS_TRACES: '', MM_OBS_METRICS: '',
  WAKE_EVERY_MS: '300', WAKE_CHECK_MS: '500', WAKE_RESUME_CHECK_MS: '600000', WAKE_UPSTREAM_WAIT_MS: '3000', WAKE_RETRY_MS: '100', WAKE_LABEL_GAP_MS: '20' }
delete env.MM_SERVICE
const w = spawn('node', [path.join(PROJ, 'bin', 'wake')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''; w.stdout.on('data', (d) => (out += d)); w.stderr.on('data', (d) => (out += d))
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const sent = () => read(SENT), bdlog = () => read(BDLOG), opsLog = () => read(path.join(PROJ, '.run', 'logs', 'ops.log'))
const to = (role) => sent().split('----\n').filter((b) => b.startsWith(`TO agent-${role}\n`)).join('\n')
const times = (role, re) => (to(role).match(re) || []).length
const I = (id) => items.get(id), has = (id, l) => I(id).labels.includes(l)
const errors = () => opsLog().split('\n').filter((l) => /"level":"error"/.test(l))

/** Loop one item between platform and review until the hop limit pauses it. */
async function loop(id) {
  for (let i = 1; i <= 3; i++) {
    const [from, next] = i % 2 ? ['platform', 'review'] : ['review', 'platform']
    const had = times(next, new RegExp(`on ${id}`, 'g'))
    change(id, from, { assignee: next, status: 'open' })
    await until(() => times(next, new RegExp(`on ${id}`, 'g')) > had)
  }
  change(id, 'platform', { assignee: 'review', status: 'open' }) // the 4th
}

try {
  await until(() => /watching/.test(opsLog()))
  console.log('== the hop limit: paused, and the board\'s Lead gets it (never a person)')
  const r0 = times('review', /on p-1/g)
  await loop('p-1')
  ok('the item is labelled paused', await until(() => has('p-1', 'paused')))
  ok('...not needs-you', !has('p-1', 'needs-you') && !/p-1 needs-you/.test(bdlog()))
  ok('...the 4th lead-to-lead wake is not sent', times('review', /on p-1/g) === r0 + 2 && !(await until(() => times('review', /on p-1/g) > r0 + 2, 1500)))
  ok('...one Paused comment, naming the Lead', (I('p-1').comments || []).filter((c) => /^Paused: 3 lead-to-lead wakes .*The Lead \(ops\) resumes it/.test(c.text)).length === 1)
  ok('...the Lead (ops) is woken with it, once', await until(() => times('ops', /PAUSED: p-1 had 3 lead-to-lead wakes/g) === 1))
  const q1 = sent()
  comment('p-1', 'platform', 'NOTE: still mine?')
  change('p-1', 'platform', { assignee: 'review', status: 'open' })
  await sleep(1500)
  ok('while paused, a lead\'s comment or change wakes no lead', !/p-1/.test(sent().slice(q1.length)))
  // review #4: a looping lead must not unpause itself: only the Lead (ops) or a human resumes it
  const q1b = sent()
  change('p-1', 'platform', { labels: [] })
  ok('a lead removes paused (not the Lead): still paused (wake labels it again)', await until(() => has('p-1', 'paused') && /p-1: paused removed by platform, who is not the Lead \(ops\) or a human: labelled again/.test(opsLog())))
  ok('...the Lead is told, and no other lead is woken', await until(() => times('ops', /PAUSED: platform removed `paused` from p-1/g) === 1) && !/HANDOFF to you|on p-1 \(/.test(sent().slice(q1b.length).replace(/PAUSED: platform removed[^\n]*/g, '')))
  change('p-1', 'review/w1', { labels: [] })
  ok("...a worker's removal too (only the Lead itself)", await until(() => has('p-1', 'paused') && /removed by review\/w1, who is not the Lead/.test(opsLog())))
  change('p-1', 'ops', { labels: [] }) // the Lead resumes it
  ok('removing paused resumes it (logged)', await until(() => /p-1: paused removed \(by ops\): resumed/.test(opsLog())))
  change('p-1', 'review', { assignee: 'platform', status: 'open' })
  ok('...and the count starts again: the next lead change wakes platform', await until(() => /HANDOFF to you from review on p-1/.test(sent().slice(q1.length))))

  console.log('== a human comment resumes a paused item (wake takes the label off)')
  await loop('p-2')
  ok('p-2 paused', await until(() => has('p-2', 'paused')))
  const q2 = sent()
  comment('p-2', 'alex', 'Go on with option B.')
  ok('wake removes paused itself', await until(() => /label remove p-2 paused --actor wake/.test(bdlog()) && !has('p-2', 'paused')))
  ok('...and the board\'s Lead (ops) is woken for the human comment (sy-uykv)', await until(() => /alex commented[\s\S]*Go on with option B/.test(to('ops')) && sent().length > q2.length))

  console.log('== wake asks the owner only with an owner card')
  change('h-1', 'platform', { assignee: 'alex' })
  ok('a reassign to a person, no card: needs-you', await until(() => has('h-1', 'needs-you')))
  const c1 = parseCard(I('h-1').description, I('h-1').labels, 'h-1')
  ok('...with a valid card wake wrote first (a Check:, never a go ask)', c1.ok && /^Check: /.test(c1.card.You) && /handed h-1 to alex, a person/.test(c1.card.What))
  ok('...the old description below it, unchanged', c1.rest === 'Old text.\n\nSecond paragraph, `as is`.')
  ok('...card, then label (bd log order)', /update h-1 --body-file [^\n]*\n(?:[^\n]*\n)*?label add h-1 needs-you/.test(bdlog()))
  change('h-2', 'platform', { assignee: 'alex' })
  ok('a valid card already there: only the label', await until(() => has('h-2', 'needs-you')) && I('h-2').description === CARD && !/update h-2 /.test(bdlog()))
  change('h-3', 'platform', { assignee: 'alex' })
  ok('an invalid card someone wrote: the Lead (ops) is woken to fix it', await until(() => /OWNER CARD: wake must ask the owner on h-3[\s\S]*its owner card is invalid/.test(to('ops'))))
  ok('...never written over, never labelled', I('h-3').description === '## Owner\n- **What:** half a card' && !has('h-3', 'needs-you') && !/h-3/.test(bdlog()))
  change('h-4', 'platform', { assignee: 'alex' })
  ok('a t2 go ask review has not signed off: the Lead, no label', await until(() => /OWNER CARD: wake must ask the owner on h-4[\s\S]*before review signed off/.test(to('ops'))) && !has('h-4', 'needs-you') && I('h-4').description === GO)
  change('b-1', 'ops', { status: 'blocked' })
  ok('blocked by the Lead itself (nobody to route it to): a card (Reply:) and needs-you', await until(() => has('b-1', 'needs-you')) && /^Reply: /.test(parseCard(I('b-1').description).card?.You || ''))
  change('u-1', 'platform', { status: 'blocked' })
  await sleep(3500); change('p-1', 'beads', {}) // past the wait (3 s here); any event: a reconcile pass soon after
  ok('an upstream wait past its limit: a card and needs-you, and why on the item', await until(() => has('u-1', 'needs-you') && (I('u-1').comments || []).length > 0)
    && parseCard(I('u-1').description).ok && (I('u-1').comments || []).some((c) => /Blocked on the system board \(upstream:engine\)/.test(c.text)))

  console.log('== a refusal of bd\'s gate is bd\'s answer, not an error')
  change('r-1', 'platform', { assignee: 'alex' })
  ok('the gate refuses (the item changed under wake): a warn, "refused by bd"', await until(() => /"level":"warn"[^\n]*label r-1 refused by bd: bd: refused: needs-you only with a valid owner card/.test(opsLog())))
  await sleep(800)
  ok('...tried once, not three times', (bdlog().match(/label add r-1 needs-you/g) || []).length === 1)
  ok('no error in wake\'s log for any of it', errors().length === 0)
} finally {
  w.kill(); srv.close(); for (const s of streams) s.destroy()
  if (fail) console.log(`--- wake output\n${opsLog().split('\n').slice(-30).join('\n')}\n${out.slice(-1500)}\n--- bd\n${bdlog().slice(-2000)}`)
  fs.rmSync(T, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
