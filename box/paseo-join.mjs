// mm: a project box's Paseo joins the machine's Paseo as a host, or leaves it (M1-C, sy-9q1). Through Paseo's own client
// library, so the box's password is read here from its file (0600, on the host) and is never on a command line.
//   node paseo-join.mjs <paseo-cli-dir> <machine-paseo-home> add <label> <address:port> <password-file>
//   node paseo-join.mjs <paseo-cli-dir> <machine-paseo-home> rm  <label>
// Prints one JSON line: { action, label, removed, registrationId?, status? }.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [cliDir, home, action, label, address, pwFile] = process.argv.slice(2)
const { connectToDaemon } = await import(pathToFileURL(join(cliDir, 'dist', 'utils', 'client.js')).href)
const client = await connectToDaemon({ target: { kind: 'instance', home } })
try {
  // one entry per box: an old one goes first (its password changes when the box is made again)
  const old = (await client.listHosts()).hosts.filter((h) => h.label === label)
  for (const h of old) await client.removeHost(h.registrationId)
  const out = { action, label, removed: old.length }
  if (action === 'add') {
    const password = readFileSync(pwFile, 'utf8').trim()
    const r = await client.addHost({ connection: `tcp://${address}?password=${encodeURIComponent(password)}`, label, metadata: { 'mm.box': label } })
    Object.assign(out, { registrationId: r?.registrationId, status: r?.status })
  }
  console.log(JSON.stringify(out))
} finally {
  try { await client.close?.() } catch {}
}
process.exit(0)
