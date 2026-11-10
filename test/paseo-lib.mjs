#!/usr/bin/env node
// bin/lib/paseo.mjs against this machine's Paseo daemon, read-only: the SDK path and the CLI path return the same
// agents in the same shape, the SDK is much faster, and with the SDK unavailable every call still works (CLI).
//   node test/paseo-lib.mjs          exit 0 = every check passed. Lists agents only; never creates, sends or archives.
import path from 'node:path'
const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const lib = path.join(SRC, 'template', 'bin', 'lib', 'paseo.mjs')
let pass = 0, fail = 0
const ok = (d, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${d}${extra ? `  (${extra})` : ''}`) }
const load = async (env) => { Object.assign(process.env, env); return import(`${lib}?${Object.keys(env).join('')}${Math.random()}`) }

const sdk = await load({ PASEO_NO_SDK: '' })
const REAL = sdk.address() // where the real daemon answers (a socket by default, sy-nli; ws://host:port/ws otherwise)
let t = Date.now(); const a = await sdk.list(); const first = Date.now() - t
t = Date.now(); await sdk.list(); const warm = Date.now() - t
ok('SDK path is used', sdk.via() === 'sdk', sdk.via())
const cliLib = await load({ PASEO_NO_SDK: '1' })
t = Date.now(); const b = await cliLib.list(); const cliMs = Date.now() - t
ok('CLI path is used when the SDK is off', cliLib.via().startsWith('cli'), cliLib.via())
const ids = (x) => x.map((y) => y.id).sort().join(',')
ok('same agents both ways', ids(a) === ids(b), `${a.length} agents`)
const shape = (x) => x.every((y) => typeof y.id === 'string' && typeof y.shortId === 'string' && typeof y.status === 'string' && y.cwd.startsWith('/') && typeof y.labels === 'object')
ok('same shape both ways (id, shortId, status, absolute cwd, labels)', shape(a) && shape(b))
const proj = (a.find((y) => y.labels.project) || {}).labels?.project || 'none'
const [fa, fb] = [await sdk.list({ project: proj }), await cliLib.list({ project: proj })]
ok(`a label filter agrees both ways (project=${proj})`, ids(fa) === ids(fb) && fb.every((y) => y.labels.project === proj), `${fa.length} agents`)
const byLabel = await sdk.list({ project: (a.find((y) => y.labels.project) || {}).labels?.project || 'none' })
ok('label filter', byLabel.every((y) => y.labels.project === byLabel[0]?.labels.project))
ok('a warm SDK list is far faster than a CLI call', warm * 5 < cliMs, `sdk ${warm} ms (first ${first} ms incl. connect), cli ${cliMs} ms`)
// created: an ISO date both ways (the CLI's is relative, "1 hours ago"), so wake can order a role's leads (sy-p8pc)
const N = Date.parse('2026-11-07T04:00:00Z'), W = (v) => sdk.when(v, N)
ok('when(): the SDK\'s ISO date kept', W('2026-11-07T02:47:56.817Z') === '2026-11-07T02:47:56.817Z')
ok('when(): "1 hours ago", "2 days ago", "an hour ago", "just now"', W('1 hours ago') === '2026-11-07T03:00:00.000Z' && W('2 days ago') === '2026-11-05T04:00:00.000Z' && W('an hour ago') === '2026-11-07T03:00:00.000Z' && W('just now') === '2026-11-07T04:00:00.000Z')
ok('when(): nothing, or words it can\'t read, give null', W(null) === null && W('') === null && W('sometime') === null)
const isDate = (x) => x.every((y) => y.created === null || !Number.isNaN(Date.parse(y.created)))
ok('created is a date (or null) both ways', isDate(a) && isDate(b), `sdk ${a[0]?.created}, cli ${b[0]?.created}`)
// The CLI's date is its words floored to their unit ("3 days ago" for 3.99 days), so it can be up to one unit newer
// than the SDK's exact one (sy-9uxr: a chain of "> 2 days from the previous" split differently both ways). The order
// must agree for every pair of agents whose real (SDK) gap is more than both CLI dates' units: those it can't flip.
const unit = (iso) => { const age = Date.now() - Date.parse(iso); return 5e3 + (age < 36e5 ? 6e4 : age < 864e5 ? 36e5 : age < 6048e5 ? 864e5 : age < 2592e6 ? 6048e5 : age < 31536e6 ? 2592e6 : 31536e6) }
const cliOf = new Map(b.map((y) => [y.id, y.created]))
const both = a.filter((y) => y.created && cliOf.get(y.id))
const pairs = both.flatMap((p, i) => both.slice(i + 1).map((q) => [p, q]))
  .filter(([p, q]) => Math.abs(Date.parse(p.created) - Date.parse(q.created)) > unit(cliOf.get(p.id)) + unit(cliOf.get(q.id)))
const flipped = pairs.filter(([p, q]) => Math.sign(Date.parse(p.created) - Date.parse(q.created)) !== Math.sign(Date.parse(cliOf.get(p.id)) - Date.parse(cliOf.get(q.id))))
ok('agents far apart are in the same order both ways (newest first)', flipped.length === 0,
  `${pairs.length} pairs far apart${flipped.length ? `; flipped: ${flipped.map(([p, q]) => `${p.shortId}/${q.shortId}`).join(' ')}` : ''}`)
// sy-aaq3: a daemon not up yet at the first call (a reboot) is tried again after the backoff, not left to the CLI for good.
// The "daemon" here is a forwarder to the real one (at its own address: REAL) on a free port, opened only after the first
// try failed.
const net = await import('node:net')
const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const late = await load({ PASEO_NO_SDK: '', PASEO_URL: `ws://127.0.0.1:${free}/ws`, PASEO_SDK_RETRY_MS: '3000' })
const l1 = await late.list()
ok('daemon not there yet: the call still answers (CLI) and says why', late.via().startsWith('cli (') && Array.isArray(l1), late.via())
const to = REAL.startsWith('unix://') ? { path: REAL.slice(7) } : (({ hostname, port }) => ({ host: hostname, port: Number(port) || 80 }))(new URL(REAL))
const fwd = net.createServer((c) => { const u = net.connect(to); c.pipe(u); u.pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()) }).listen(free, '127.0.0.1')
await late.list()
ok('...within the backoff: no new try (still the CLI)', late.via().startsWith('cli'))
await new Promise((r) => setTimeout(r, 3200))
const l2 = await late.list()
ok('...after the backoff, with the daemon up: back on the SDK', late.via() === 'sdk' && Array.isArray(l2), late.via())
await late.close(); fwd.close()
delete process.env.PASEO_URL; delete process.env.PASEO_SDK_RETRY_MS
await sdk.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
