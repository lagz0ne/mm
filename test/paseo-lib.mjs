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
await sdk.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
