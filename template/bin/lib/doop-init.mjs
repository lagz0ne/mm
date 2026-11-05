// doop-init — the first start of a project's Doop (bin/doop-run; plans/doop.md): Doop's own account for the project
// (designer@<the secret sign-up domain>), and an agent key for the design lead's MCP. Both are kept in secrets/
// (0600); nothing secret is printed or put on a command line.
//   node bin/lib/doop-init.mjs <loopback base> <public origin> <secrets dir>
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const [base, origin, S] = process.argv.slice(2)
const file = (n) => path.join(S, n)
const put = (n, v) => { fs.writeFileSync(file(n), v, { mode: 0o600 }); fs.chmodSync(file(n), 0o600) }
const domain = fs.readFileSync(file('doop-signup-domain'), 'utf8').trim()
if (!fs.existsSync(file('doop-password'))) put('doop-password', crypto.randomBytes(24).toString('base64url'))
const email = `designer@${domain}`, password = fs.readFileSync(file('doop-password'), 'utf8').trim()
const post = (p, body, cookie) => fetch(`${base}${p}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
const cookieOf = (r) => (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')

let r = await post('/api/auth/sign-up/email', { email, password, name: 'Design lead' })
if (!r.ok) r = await post('/api/auth/sign-in/email', { email, password }) // made before (the key was lost): sign in
if (!r.ok) { console.error(`doop-init: no account (HTTP ${r.status})`); process.exit(1) }
const cookie = cookieOf(r)
const k = await post('/api/agent-keys', { name: 'design lead (mm)' }, cookie)
if (!k.ok) { console.error(`doop-init: no agent key (HTTP ${k.status})`); process.exit(1) }
const { secret, start } = await k.json()
if (!secret) { console.error('doop-init: the reply had no key'); process.exit(1) }
put('doop-agent-key', secret)
console.log(`doop-init: account ${email.replace(/@.*/, '@…')}, agent key ${String(start || '').slice(0, 6)}… saved`)
