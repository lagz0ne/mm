#!/usr/bin/env node
// An item's inbox (sy-seqz): a person signed in through the gateway uploads a file or a zip to an item; it lands,
// checked, in inbox/<item>/<upload>/ of a throwaway board (the real site/server.mjs and inbox.mjs, copies in a temp
// folder; a stand-in bd serve; no bd, no live board). Proves: the owner's zip is unpacked there, no executable bit, a
// comment by the owner lists the files and the path; the inbox stays out of git (config repo and code/); every bad
// upload is refused with its reason and nothing written (a ".." path, an absolute path, a link, a device, 51 MB, a zip
// bomb (declared and lying), too many files, a secret, another site, not the bytes, an unknown item); the local side
// and a viewer get 403; the uploader or the owner removes an upload, nobody else; an inbox that is a link is refused.
// A second board with small limits proves: a 50 MB + 1 body with no length is cut while it streams and the server's
// peak memory does not take it; the inbox's total cap (BOARD_INBOX_MAX_MB) refuses a file, a streamed file and a zip
// with 413, nothing written; one upload at a time (a second waits for the first; past BOARD_UPLOAD_WAIT_S it gets 429
// and lands when tried again); a stalled body (BOARD_UPLOAD_IDLE_S) gets 408 and gives the turn back.
// At 390x844 (Playwright): the item's detail has the "Upload a file" control, an upload through it lands, and there is
// no sideways scroll; the screenshot is board-inbox-390.png.
//   node test/board-inbox.mjs        exit 0 = every check passed
//   BOARD_PHONE_NOBUILD=1 ...         use template/site/dist as it is
//   BOARD_INBOX_SHOTS=<dir>           where the screenshots go (default: a folder under the temp dir)
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SITE = path.join(SRC, 'template', 'site')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'board-inbox-'))
const SHOTS = process.env.BOARD_INBOX_SHOTS || path.join(T, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, fail = 0
const ok = (d, c, more = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${c || !more ? '' : `\n        ${more}`}`) }
const step = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`)
const die = (m) => { console.error(`\x1b[31mboard-inbox: ${m}\x1b[0m`); process.exit(2) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- a zip, made here: entries { name, data?, mode?, method?, declared? } ----------
function zip(entries) {
  const locals = [], central = []
  let off = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data ?? ''), method = e.method ?? (data.length > 64 ? 8 : 0)
    const body = method === 8 ? zlib.deflateRawSync(data) : data, crc = zlib.crc32(data), usize = e.declared ?? data.length
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(((e.mode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38); ch.writeUInt32LE(off, 42)
    locals.push(lh, name, body); central.push(ch, name)
    off += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}

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

// ---------- a board: the template's site and bin, its .gitignore, its own root repo and a code/ repo ----------
const B = path.join(T, 'board')
fs.cpSync(SITE, path.join(B, 'site'), { recursive: true, filter: (f) => !/node_modules/.test(f) })
fs.cpSync(path.join(SRC, 'template', 'bin'), path.join(B, 'bin'), { recursive: true })
fs.copyFileSync(path.join(SRC, 'template', '.gitignore'), path.join(B, '.gitignore'))
fs.mkdirSync(path.join(B, 'leads'), { recursive: true })
fs.writeFileSync(path.join(B, 'leads', 'roles.json'), JSON.stringify({ roles: [{ id: 'code' }, { id: 'design' }] }))
const env = { ...process.env, HOME: path.join(T, 'home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MM_OBS_TRACES: '', MM_OBS_METRICS: '' }
for (const k of ['BEADS_ACTOR', 'BD_ACTOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'MM_SERVICE', 'MM_BIND',
  'BOARD_UPLOAD_MAX_MB', 'BOARD_UPLOAD_MAX_FILES', 'BOARD_UPLOAD_MAX_UNPACKED_MB', 'BOARD_INBOX_MAX_MB', 'BOARD_UPLOAD_WAIT_S', 'BOARD_UPLOAD_IDLE_S']) delete env[k]
fs.mkdirSync(env.HOME)
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env })
git(B, 'init', '-q', '-b', 'main'); git(B, 'add', '-A'); git(B, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init')
const CODE = path.join(B, 'code'); fs.mkdirSync(CODE)
fs.writeFileSync(path.join(CODE, '.gitignore'), 'node_modules/\ndata/\n'); fs.writeFileSync(path.join(CODE, 'README.md'), '# x\n')
git(CODE, 'init', '-q', '-b', 'main'); git(CODE, 'add', '-A'); git(CODE, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init')

// ---------- a stand-in bd serve: it keeps the comments the board writes ----------
const iso = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString()
const item = { id: 'ab-7', title: 'Import the design export', status: 'in_progress', priority: 2, issue_type: 'task', assignee: 'design', labels: [],
  created_at: iso(90), updated_at: iso(3), description: 'The export is a zip: put it here.', comments: [] }
const shut = { ...item, id: 'ab-8', title: 'Done already', status: 'closed', comments: [] }
const comments = []
const bdSrv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (u.pathname === '/v0/beads/events:watch') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return }
  if (u.pathname === '/v0/beads/events') return json({ head: 0, records: [] })
  if (u.pathname === '/v0/beads/issues') return json({ items: u.searchParams.get('status') === 'closed' ? [] : [item].map(({ comments: c, ...i }) => ({ ...i, comment_count: c.length })), has_more: false })
  if (u.pathname === '/v0/beads/ready') return json({ items: [], has_more: false })
  const cm = /^\/v0\/beads\/issues\/([\w.-]+)\/comments$/.exec(u.pathname)
  if (cm && req.method === 'POST') {
    let b = ''; for await (const c of req) b += c
    const d = JSON.parse(b), c = { id: `c${comments.length + 1}`, issue_id: cm[1], author: d.author, text: d.text, created_at: new Date().toISOString() }
    comments.push(c); if (cm[1] === item.id) item.comments.push(c)
    return json(c, 201)
  }
  const m = /^\/v0\/beads\/issues\/([\w.-]+)$/.exec(u.pathname)
  if (m) { const i = [item, shut].find((x) => x.id === m[1]); return i ? json(i) : json({ title: 'not found' }, 404) }
  json({ items: [] })
})
await new Promise((r) => bdSrv.listen(0, '127.0.0.1', r))
fs.writeFileSync(path.join(T, 'paseo'), '#!/bin/sh\ncase "$1" in ls) echo "[]" ;; esac\n', { mode: 0o755 })

// ---------- the board: the real server.mjs, its local and its public side ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const HOST = 'board-ab.example.org', ORIGIN = `https://${HOST}`
const sign = (u, r) => { const b = Buffer.from(JSON.stringify({ u, r, h: HOST, exp: Date.now() + 120000, n: crypto.randomUUID() })).toString('base64url'); return `${b}.${crypto.sign(null, Buffer.from(b), privateKey).toString('base64url')}` }
const freePort = async () => { const p = http.createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; p.close(); return n }
/** A board's server (the real server.mjs) on a board folder, with more env: { proc, port, pport, log() }. */
async function startBoard(root, more = {}) {
  const port = await freePort(), pport = await freePort()
  let log = ''
  const proc = spawn('node', [path.join(root, 'site', 'server.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(port), HOST: '127.0.0.1',
    BD_SERVE: `http://127.0.0.1:${bdSrv.address().port}`, PASEO_BIN: path.join(T, 'paseo'), PASEO_NO_SDK: '1', BOARD_PROJECT: 'ab', MM_PROJECT: 'ab',
    BOARD_PUBLIC_PORT: String(pport), MM_AUTH_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), ...more } })
  proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d))
  let up = false
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/api/whoami`); up = true } catch { await sleep(100) } }
  if (!up) { console.log(log.slice(-1500)); die('the board did not start') }
  return { proc, port, pport, log: () => log }
}
// a second board, the same files, with small limits: the inbox's cap (1 MB), the wait for a turn (1 s), a stall (2 s)
const B2 = path.join(T, 'board2')
fs.cpSync(B, B2, { recursive: true })
const main = await startBoard(B), small = await startBoard(B2, { BOARD_INBOX_MAX_MB: '1', BOARD_UPLOAD_WAIT_S: '1', BOARD_UPLOAD_IDLE_S: '2' })
const srv = main.proc, PORT = main.port, PPORT = main.pport
const out = { get length() { return main.log().length }, includes: (x) => main.log().includes(x), slice: (...a) => main.log().slice(...a) }

/** A raw request (no fetch rules on the headers): { status, body (parsed JSON or text) }. */
const req = (method, p, { port = PPORT, who, role, body, headers = {} } = {}) => new Promise((ok_, no) => {
  const h = { host: HOST, ...(who ? { 'x-mm-assertion': sign(who, role) } : {}), ...(body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {}),
    origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers }
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k]
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
      const t = Buffer.concat(chunks).toString(); let j = t; try { j = JSON.parse(t) } catch {}
      ok_({ status: res.statusCode, body: j })
    })
  })
  r.on('error', no); if (body) r.write(body); r.end()
})
/** A POST whose body goes in parts: a Buffer is written (with backpressure), a number pauses that many ms. No
 *  content-length (chunked), so the server counts as it reads. { status, body, at: when the answer came }. */
const stream = (p, parts, { port = PPORT, who = 'olga', role = 'owner' } = {}) => new Promise((ok_) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: HOST, 'x-mm-assertion': sign(who, role),
    'content-type': 'application/octet-stream', origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
      const t = Buffer.concat(chunks).toString(); let j = t; try { j = JSON.parse(t) } catch {}
      ok_({ status: res.statusCode, body: j, at: Date.now() })
    })
  })
  r.on('error', (e) => ok_({ status: 0, body: e.code, at: Date.now() }))
  ;(async () => {
    for (const x of parts) {
      if (r.destroyed) return
      if (typeof x === 'number') await sleep(x)
      else if (!r.write(x)) await new Promise((d) => { const go = () => { r.off('drain', go); r.off('close', go); d() }; r.on('drain', go); r.on('close', go) })
    }
    r.end()
  })().catch(() => {})
})
const upload = (name, body, o = {}) => req('POST', `/api/inbox/${o.item || 'ab-7'}?name=${encodeURIComponent(name)}`, { who: 'olga', role: 'owner', body, ...o })
const INBOX = path.join(B, 'inbox')
/** Every path under the inbox, with its size: what a refusal must leave as it was. */
const tree = (d = INBOX, pre = '') => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [`${pre}${e.name}/`, ...tree(path.join(d, e.name), `${pre}${e.name}/`)] : [`${pre}${e.name}:${fs.lstatSync(path.join(d, e.name)).size}`]).sort() } catch { return [] } }
const browser = await chromium.launch({ executablePath: exe })

try {
  step('the owner uploads a zip')
  const readme = 'The design export: two frames and a list.\n'
  const z = zip([{ name: 'export/' }, { name: 'export/README.md', data: readme }, { name: 'export/frames/home.json', data: JSON.stringify({ frame: 'home', w: 390, pad: 'x'.repeat(400) }) },
    { name: 'export/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755 }, { name: '__MACOSX/export/._README.md', data: 'junk' }])
  let r = await upload('Design Export.zip', z)
  ok('200, the path and the files', r.status === 200 && r.body.path === 'inbox/ab-7/Design-Export/' && r.body.files?.length === 3, JSON.stringify(r.body).slice(0, 300))
  const D = path.join(INBOX, 'ab-7', 'Design-Export')
  ok('the files are there, unpacked', fs.readFileSync(path.join(D, 'export', 'README.md'), 'utf8') === readme && fs.existsSync(path.join(D, 'export', 'frames', 'home.json')))
  ok('the Finder\'s __MACOSX is left out', !fs.existsSync(path.join(D, '__MACOSX')))
  const modeOf = (f) => fs.statSync(f).mode & 0o777
  ok('no executable bit (run.sh was 0755 in the zip)', (modeOf(path.join(D, 'export', 'run.sh')) & 0o111) === 0, modeOf(path.join(D, 'export', 'run.sh')).toString(8))
  ok('no temp folder left', !fs.readdirSync(path.join(INBOX, 'ab-7')).some((n) => n.startsWith('.incoming-')))
  const c = comments.at(-1)
  ok('a comment on the item, by the owner, with the role prefix', c?.issue_id === 'ab-7' && c.author === 'olga' && c.text.startsWith('[owner] Uploaded Design-Export.zip'), JSON.stringify(c))
  ok('it lists the files with their sizes and the inbox path', c && c.text.includes('`inbox/ab-7/Design-Export/`') && c.text.includes(`\`export/README.md\` (${Buffer.byteLength(readme)} B)`) && c.text.includes('`export/run.sh`') && c.text.includes('`export/frames/home.json`'), c?.text)

  step('a single file, and the same name again')
  r = await upload('notes.txt', Buffer.from('a plain note\n'))
  ok('a single file lands in inbox/ab-7/notes/notes.txt', r.status === 200 && fs.readFileSync(path.join(INBOX, 'ab-7', 'notes', 'notes.txt'), 'utf8') === 'a plain note\n', JSON.stringify(r.body))
  r = await upload('notes.txt', Buffer.from('a second note\n'))
  ok('the same name again: notes-2, the first kept', r.status === 200 && r.body.path === 'inbox/ab-7/notes-2/' && fs.readFileSync(path.join(INBOX, 'ab-7', 'notes', 'notes.txt'), 'utf8') === 'a plain note\n', JSON.stringify(r.body))

  step('the inbox stays out of git')
  ok('the config repo: a clean tree', git(B, 'status', '--porcelain').stdout.trim() === '', git(B, 'status', '--porcelain').stdout)
  ok('the config repo ignores inbox/ by name too', git(B, 'check-ignore', '-q', 'inbox/ab-7/notes/notes.txt').status === 0)
  ok('code/: a clean tree', git(CODE, 'status', '--porcelain').stdout.trim() === '')
  git(B, 'add', '-A')
  ok('git add -A stages nothing of it', !git(B, 'diff', '--cached', '--name-only').stdout.includes('inbox'))

  step('the list')
  r = await req('GET', '/api/inbox/ab-7', { who: 'vic', role: 'viewer' })
  ok('a viewer reads the list (can: false)', r.status === 200 && r.body.uploads.map((u) => u.name).join(' ') === 'Design-Export notes notes-2' && r.body.can === false && r.body.uploads[0].by === 'olga', JSON.stringify(r.body).slice(0, 300))
  r = await req('GET', '/api/inbox/ab-7', { port: PORT })
  ok('the local side reads it too (the leads), can: false', r.status === 200 && r.body.uploads.length === 3 && r.body.can === false)
  ok('the limits it says: 50 MB', r.body.limits?.bytes === 50 << 20)

  step('refused, with the reason, and nothing written')
  const AKIA = 'AKIA' + 'QWERTYUIOPASDFGH'
  const bad = [
    ['a ".." path', 'evil.zip', zip([{ name: 'ok.txt', data: 'fine' }, { name: '../../escape.txt', data: 'out' }]), 400, /"\.\." path/],
    ['a ".." path inside', 'evil.zip', zip([{ name: 'a/../../b.txt', data: 'out' }]), 400, /"\.\." path/],
    ['an absolute path', 'abs.zip', zip([{ name: '/etc/cron.d/x', data: 'out' }]), 400, /absolute path/],
    ['a drive path', 'abs.zip', zip([{ name: 'C:/x.txt', data: 'out' }]), 400, /absolute path/],
    ['a backslash', 'bs.zip', zip([{ name: '..\\x.txt', data: 'out' }]), 400, /backslash/],
    ['a link', 'link.zip', zip([{ name: 'ok.txt', data: 'fine' }, { name: 'passwd', data: '/etc/passwd', mode: 0o120777 }]), 400, /a link/],
    ['a device', 'dev.zip', zip([{ name: 'null', data: '', mode: 0o020666 }]), 400, /device/],
    ['a .git folder', 'git.zip', zip([{ name: 'x/.git/hooks/post-checkout', data: '#!/bin/sh\n' }]), 400, /\.git/],
    ['a name twice', 'dup.zip', zip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]), 400, /twice/],
    ['a file and a folder at once', 'fd.zip', zip([{ name: 'a', data: '1' }, { name: 'a/b', data: '2' }]), 400, /file and a folder/],
    ['a secret in a zip (the file named, the kind, not the key)', 'keys.zip', zip([{ name: 'ok.txt', data: 'fine' }, { name: 'conf/aws.env', data: `AWS_ACCESS_KEY_ID=${AKIA}\n` }]), 422, /^conf\/aws\.env: looks like an AWS access key/],
    ['a secret in a file', 'id.txt', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n'), 422, /^id\.txt: looks like a private key/],
    ['a .zip that is not one', 'fake.zip', Buffer.from('hello, not a zip at all, but long enough'), 400, /not a zip/],
    ['an empty file', 'empty.txt', Buffer.alloc(0), 400, /empty/i],
  ]
  for (const [what, name, body, code, re] of bad) {
    const before = tree()
    r = await upload(name, body)
    ok(`${what}: ${code}, "${String(r.body?.title).slice(0, 90)}"`, r.status === code && re.test(r.body?.title || ''), `${r.status} ${JSON.stringify(r.body)}`)
    ok(`  … nothing written`, JSON.stringify(tree()) === JSON.stringify(before), tree().filter((x) => !before.includes(x)).join(', '))
  }
  ok('the secret is never in an answer', !JSON.stringify(comments).includes(AKIA) && !out.includes(AKIA))
  ok('nothing landed outside the inbox', !fs.existsSync(path.join(T, 'escape.txt')) && !fs.existsSync(path.join(B, 'escape.txt')) && !fs.existsSync(path.join(B, 'b.txt')))

  step('the limits: 51 MB, a zip bomb, too many files')
  let before = tree()
  r = await upload('big.bin', Buffer.alloc(51 << 20, 7))
  ok(`51 MB: 413, "${r.body?.title}"`, r.status === 413 && /more than the 50\.0 MB/.test(r.body?.title || ''), JSON.stringify(r.body))
  const bomb = zip([{ name: 'zeros.bin', data: Buffer.alloc(250 << 20) }])
  ok(`  (the honest bomb is ${Math.round(bomb.length / 1024)} KB, 250 MB unpacked)`, bomb.length < (2 << 20))
  r = await upload('bomb.zip', bomb)
  ok(`a zip bomb (declared): 413, "${r.body?.title}"`, r.status === 413 && /unpacked \(a zip bomb/.test(r.body?.title || ''), JSON.stringify(r.body))
  const liar = zip([{ name: 'small.txt', data: Buffer.alloc(100 << 20), declared: 1024 }])
  r = await upload('liar.zip', liar)
  ok(`a zip bomb that lies about its size: 413, "${r.body?.title}"`, r.status === 413 && /inflates past its declared size/.test(r.body?.title || ''), JSON.stringify(r.body))
  r = await upload('many.zip', zip(Array.from({ length: 1001 }, (_, k) => ({ name: `f${k}.txt`, data: 'x' }))))
  ok(`1001 files: 413, "${r.body?.title}"`, r.status === 413 && /1000 files/.test(r.body?.title || ''), JSON.stringify(r.body))
  ok('  … nothing written', JSON.stringify(tree()) === JSON.stringify(before))

  step('a 50 MB + 1 body with no length is cut while it streams (the second board; its memory does not take the body)')
  const SP = small.pport, INBOX2 = path.join(B2, 'inbox')
  const mem = () => { const s = fs.readFileSync(`/proc/${small.proc.pid}/status`, 'utf8'), kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] || 0) * 1024; return { rss: kb('VmRSS'), peak: kb('VmHWM') } }
  const mb1 = Buffer.alloc(1 << 20, 0x61)
  let before2 = tree(INBOX2)
  const m0 = mem()
  r = await stream('/api/inbox/ab-7?name=huge.bin', [...Array(50).fill(mb1), Buffer.from('b')], { port: SP })
  const m1 = mem()
  ok(`413, "${r.body?.title}"`, r.status === 413 && /^50\.0 MB: more than the 50\.0 MB/.test(r.body?.title || ''), `${r.status} ${JSON.stringify(r.body)}`)
  ok(`the server's peak memory grew ${((m1.peak - m0.peak) / (1 << 20)).toFixed(1)} MB (< 20 MB) for a 50 MB body`, m1.peak - m0.peak < 20 << 20, JSON.stringify({ m0, m1 }))
  ok('  … nothing written (no spool, no temp folder)', JSON.stringify(tree(INBOX2)) === JSON.stringify(before2), tree(INBOX2).join(', '))

  step('the inbox\'s total cap (the second board: BOARD_INBOX_MAX_MB=1)')
  const k600 = Buffer.alloc(600 << 10, 0x62)
  r = await upload('a.bin', k600, { port: SP })
  ok('600 KB into an empty inbox: 200', r.status === 200, JSON.stringify(r.body))
  r = await req('GET', '/api/inbox/ab-7', { port: SP, who: 'vic', role: 'viewer' })
  ok('the cap it says: 1 MB', r.body.limits?.inbox === 1 << 20)
  before2 = tree(INBOX2)
  const full = /^The inbox is full: it holds \d+ KB of its 1\.0 MB and this upload needs \d+ KB/
  r = await upload('b.bin', k600, { port: SP })
  ok(`600 KB more (its length said): 413, "${r.body?.title}"`, r.status === 413 && full.test(r.body?.title || ''), `${r.status} ${JSON.stringify(r.body)}`)
  r = await stream('/api/inbox/ab-7?name=c.bin', [k600], { port: SP })
  ok(`600 KB more, no length (measured after it streams): 413, "${String(r.body?.title).slice(0, 60)}"`, r.status === 413 && full.test(r.body?.title || ''), `${r.status} ${JSON.stringify(r.body)}`)
  r = await upload('d.zip', zip([{ name: 'zeros.bin', data: Buffer.alloc(600 << 10) }]), { port: SP })
  ok(`a 1 KB zip that unpacks to 600 KB: 413, "${String(r.body?.title).slice(0, 60)}"`, r.status === 413 && full.test(r.body?.title || ''), `${r.status} ${JSON.stringify(r.body)}`)
  ok('  … nothing written', JSON.stringify(tree(INBOX2)) === JSON.stringify(before2), tree(INBOX2).filter((x) => !before2.includes(x)).join(', '))
  r = await upload('note.txt', Buffer.from('still room for this\n'), { port: SP })
  ok('a small file still fits: 200', r.status === 200)
  r = await req('DELETE', '/api/inbox/ab-7/a', { port: SP, who: 'olga', role: 'owner' })
  r = await upload('b.bin', k600, { port: SP })
  ok('after the owner removes the first, the 600 KB fits: 200', r.status === 200 && fs.statSync(path.join(INBOX2, 'ab-7', 'b', 'b.bin')).size === 600 << 10, JSON.stringify(r.body))

  step('one upload at a time: a second waits for the first (the first board: it waits up to 120 s)')
  const first = stream('/api/inbox/ab-7?name=first.txt', [Buffer.from('one\n'), 800, Buffer.from('two\n')])
  await sleep(150)
  const t0 = Date.now(), second = stream('/api/inbox/ab-7?name=second.txt', [Buffer.from('the second\n')])
  const [a1, a2] = await Promise.all([first, second])
  ok('both 200', a1.status === 200 && a2.status === 200, `${a1.status} ${JSON.stringify(a1.body)} / ${a2.status} ${JSON.stringify(a2.body)}`)
  ok(`the second answered after the first (it waited ${a2.at - t0} ms)`, a2.at >= a1.at && a2.at - t0 >= 500)
  ok('both land whole', fs.readFileSync(path.join(INBOX, 'ab-7', 'first', 'first.txt'), 'utf8') === 'one\ntwo\n' && fs.readFileSync(path.join(INBOX, 'ab-7', 'second', 'second.txt'), 'utf8') === 'the second\n')
  ok('no spool or temp left', !fs.readdirSync(path.join(INBOX, 'ab-7')).some((n) => /^\.(incoming|spool)-/.test(n)))

  step('waiting too long: 429, "try again" (the second board: it waits 1 s); a stalled body: 408')
  const slow = stream('/api/inbox/ab-7?name=slow.txt', [Buffer.from('slow, '), 1500, Buffer.from('but whole\n')], { port: SP })
  await sleep(150)
  before2 = tree(INBOX2)
  const t1 = Date.now(), quick = await upload('quick.txt', Buffer.from('quick\n'), { port: SP })
  ok(`the second: 429 after about 1 s (${Date.now() - t1} ms), "${quick.body?.title}"`, quick.status === 429 && /try again/.test(quick.body?.title || '') && Date.now() - t1 >= 900)
  const s1 = await slow
  ok('the first lands whole: 200', s1.status === 200 && fs.readFileSync(path.join(INBOX2, 'ab-7', 'slow', 'slow.txt'), 'utf8') === 'slow, but whole\n', JSON.stringify(s1.body))
  ok('  … nothing of the second', !fs.existsSync(path.join(INBOX2, 'ab-7', 'quick')))
  r = await upload('quick.txt', Buffer.from('quick\n'), { port: SP })
  ok('tried again: 200', r.status === 200 && fs.readFileSync(path.join(INBOX2, 'ab-7', 'quick', 'quick.txt'), 'utf8') === 'quick\n')
  before2 = tree(INBOX2)
  r = await stream('/api/inbox/ab-7?name=stall.txt', [Buffer.from('a'), 3000, Buffer.from('b')], { port: SP })
  ok(`a body that stalls 3 s (BOARD_UPLOAD_IDLE_S=2): 408, "${r.body?.title}"`, r.status === 408 && /stalled/.test(r.body?.title || ''), `${r.status} ${JSON.stringify(r.body)}`)
  ok('  … nothing written', JSON.stringify(tree(INBOX2)) === JSON.stringify(before2))
  r = await upload('after.txt', Buffer.from('after the stall\n'), { port: SP })
  ok('the turn was given back: the next upload lands', r.status === 200)

  step('who may upload')
  before = tree()
  r = await req('POST', '/api/inbox/ab-7?name=x.txt', { port: PORT, body: Buffer.from('hi'), headers: { cookie: 'board_user=alex', host: null, origin: null, 'sec-fetch-site': null } })
  ok(`the local side (a visitor's name): 403, "${r.body?.title}"`, r.status === 403 && /public address/.test(r.body?.title || ''))
  r = await req('POST', '/api/inbox/ab-7?name=x.txt', { port: PORT, body: Buffer.from('hi'), headers: { host: null, origin: null, 'sec-fetch-site': null } })
  ok('the local side (the default actor, as a lead\'s): 403', r.status === 403)
  r = await upload('x.txt', Buffer.from('hi'), { who: 'vic', role: 'viewer' })
  ok(`a viewer: 403, "${r.body?.title}"`, r.status === 403)
  r = await upload('x.txt', Buffer.from('hi'), { who: null })
  ok('no sign-in: 401', r.status === 401)
  r = await upload('x.txt', Buffer.from('hi'), { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
  ok('another site: 403', r.status === 403 && /own page/.test(r.body?.title || ''))
  r = await upload('x.txt', Buffer.from('hi'), { headers: { 'content-type': 'text/plain' } })
  ok('not the bytes (a form\'s text/plain): 415', r.status === 415)
  r = await upload('x.txt', Buffer.from('hi'), { item: 'ab-99' })
  ok('an unknown item: 404', r.status === 404)
  r = await upload('x.txt', Buffer.from('hi'), { item: '..' })
  ok(`not an item id: refused (${r.status})`, r.status >= 400 && r.status < 500)
  r = await upload('x.txt', Buffer.from('hi'), { item: 'ab-8' })
  ok('a closed item: 409', r.status === 409)
  r = await upload('../x.txt', Buffer.from('hi'))
  ok('a file name with a folder: 400', r.status === 400)
  ok('  … nothing written', JSON.stringify(tree()) === JSON.stringify(before))
  r = await upload('brief.md', Buffer.from('# from a member\n'), { who: 'mia', role: 'member' })
  ok('a member: 200, the comment is hers', r.status === 200 && comments.at(-1).author === 'mia' && comments.at(-1).text.startsWith('[member] '), JSON.stringify(r.body))
  r = await upload('mock.txt', Buffer.from('from a designer\n'), { who: 'dan', role: 'designer' })
  ok('a designer: 200', r.status === 200)

  step('remove')
  r = await req('DELETE', '/api/inbox/ab-7/brief', { who: 'dan', role: 'designer' })
  ok('someone else\'s upload: 403', r.status === 403 && fs.existsSync(path.join(INBOX, 'ab-7', 'brief')))
  r = await req('DELETE', '/api/inbox/ab-7/brief', { port: PORT, headers: { host: null, origin: null, 'sec-fetch-site': null } })
  ok('the local side: 403', r.status === 403 && fs.existsSync(path.join(INBOX, 'ab-7', 'brief')))
  r = await req('DELETE', '/api/inbox/ab-7/brief', { who: 'vic', role: 'viewer' })
  ok('a viewer: 403', r.status === 403)
  r = await req('DELETE', '/api/inbox/ab-7/brief', { who: 'mia', role: 'member', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
  ok('from another site: 403', r.status === 403 && fs.existsSync(path.join(INBOX, 'ab-7', 'brief')))
  r = await req('DELETE', '/api/inbox/ab-7/brief', { who: 'mia', role: 'member' })
  ok('the uploader removes hers: 200, the folder is gone', r.status === 200 && !fs.existsSync(path.join(INBOX, 'ab-7', 'brief')))
  ok('a comment says so', comments.at(-1).author === 'mia' && comments.at(-1).text === '[member] Removed the upload `inbox/ab-7/brief/`.', comments.at(-1).text)
  r = await req('DELETE', '/api/inbox/ab-7/mock', { who: 'olga', role: 'owner' })
  ok('the owner removes anyone\'s', r.status === 200 && !fs.existsSync(path.join(INBOX, 'ab-7', 'mock')))
  r = await req('DELETE', '/api/inbox/ab-7/..', { who: 'olga', role: 'owner' })
  ok('a way out (..): refused, nothing removed', r.status >= 400 && fs.existsSync(path.join(INBOX, 'ab-7', 'notes')))
  r = await req('DELETE', '/api/inbox/ab-7/%2E%2E', { who: 'olga', role: 'owner' })
  ok('an encoded way out: refused', r.status >= 400 && fs.existsSync(INBOX))
  r = await req('DELETE', '/api/inbox/ab-7/nope', { who: 'olga', role: 'owner' })
  ok('no such upload: 404', r.status === 404)

  step('the item\'s detail at 390x844')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    extraHTTPHeaders: { 'x-forwarded-host': HOST, 'x-mm-assertion': sign('olga', 'owner') } })
  // the board's public origin is https://<host>; the test reaches it on loopback, so the browser's Origin is set to it
  // (route.continue can't change the Origin in Chromium; route.fetch sends the request itself)
  const routed = []
  await ctx.route('**/api/inbox/**', async (route) => {
    const res = await route.fetch({ headers: { ...route.request().headers(), origin: ORIGIN } })
    if (route.request().method() !== 'GET') routed.push(`${res.status()} ${(await res.text()).slice(0, 200)}`)
    await route.fulfill({ response: res })
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`http://127.0.0.1:${PPORT}/?item=ab-7`)
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: /^Inbox · \d+$/ }) })
  await section.waitFor({ timeout: 10000 }).catch(() => {})
  ok('an "Inbox" section', (await section.count()) === 1, errs.join(' | '))
  const btn = section.locator('[data-inbox-upload]')
  ok('an "Upload a file" button', (await btn.count()) === 1 && (await btn.textContent()).includes('Upload a file'))
  await section.scrollIntoViewIfNeeded().catch(() => {})
  const box = await btn.boundingBox()
  ok('thumb-sized (≥40px high) and on the screen', !!box && box.height >= 40 && box.x >= 0 && box.x + box.width <= 391, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : '')
  fs.writeFileSync(path.join(T, 'Design frames.zip'), zip([{ name: 'frames/one.json', data: '{"a":1}' }, { name: 'frames/two.json', data: '{"b":2}' }]))
  await section.locator('[data-inbox-file]').setInputFiles(path.join(T, 'Design frames.zip'))
  const landed = section.locator('[data-upload="Design-frames"]')
  await landed.waitFor({ timeout: 10000 }).catch(() => {})
  ok('an upload through the control lands and is listed', (await landed.count()) === 1 && fs.existsSync(path.join(INBOX, 'ab-7', 'Design-frames', 'frames', 'two.json')), routed.join(' | '))
  ok('the owner sees a Remove on each', (await section.getByRole('button', { name: 'Remove' }).count()) === (await section.locator('[data-upload]').count()))
  const wide = await page.evaluate(() => {
    const s = [...document.querySelectorAll('section')].find((e) => /^Inbox/.test(e.querySelector('h3')?.textContent || ''))
    const sheet = s?.closest('[data-slot="sheet-content"]') || s?.parentElement
    return { doc: document.documentElement.scrollWidth > innerWidth, section: s ? s.scrollWidth > s.clientWidth + 1 : true, sheet: sheet ? sheet.scrollWidth > sheet.clientWidth + 1 : false }
  })
  ok('no sideways scroll (page, sheet, section)', !wide.doc && !wide.section && !wide.sheet, JSON.stringify(wide))
  await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {}) // the "landed" toast
  await page.waitForTimeout(400)
  await section.screenshot({ path: path.join(SHOTS, 'board-inbox-390.png') })
  await page.screenshot({ path: path.join(SHOTS, 'board-inbox-detail-390.png') })
  await ctx.close()
  for (const [who, role] of [['vic', 'viewer']]) {
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-forwarded-host': HOST, 'x-mm-assertion': sign(who, role) } })
    const p2 = await c2.newPage(); await p2.goto(`http://127.0.0.1:${PPORT}/?item=ab-7`)
    const s2 = p2.locator('section').filter({ has: p2.getByRole('heading', { name: /^Inbox/ }) })
    await s2.waitFor({ timeout: 10000 }).catch(() => {})
    ok('a viewer sees the list, no upload control and no Remove', (await s2.count()) === 1 && (await s2.locator('[data-inbox-upload]').count()) === 0 && (await s2.getByRole('button', { name: 'Remove' }).count()) === 0)
    await c2.close()
  }

  step('an inbox that is a link is refused')
  const away = path.join(T, 'away'); fs.mkdirSync(away)
  fs.renameSync(INBOX, path.join(T, 'inbox-was')); fs.symlinkSync(away, INBOX)
  r = await upload('x.txt', Buffer.from('hi'))
  ok(`refused (${r.status}), nothing in the link's target`, r.status >= 400 && fs.readdirSync(away).length === 0, JSON.stringify(r.body))
} finally {
  await browser.close().catch(() => {})
  srv.kill(); small.proc.kill(); bdSrv.close()
}
console.log(`\nboard-inbox: ${pass} passed, ${fail} failed (screenshots: ${SHOTS})`)
if (fail) { console.log(out.slice(-2000)); process.exit(1) }
fs.rmSync(path.join(T, 'board'), { recursive: true, force: true })
