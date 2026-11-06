#!/usr/bin/env node
// A stand-in for `portless <name> [--force] ...` (test/portless-claim.sh), copied onto PATH as `portless`, so it runs
// as Node runs the real one (node <path>/portless <name> ...). It registers <name>.localhost in
// $PORTLESS_STATE_DIR/routes.json as portless' addRoute does: a dead pid on record is dropped; a live one is a conflict,
// and with --force it gets SIGTERM ("killed <pid>" on stdout). Then it runs until TERM. It never starts a proxy.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [name, ...rest] = process.argv.slice(2), force = rest.includes('--force'), host = `${name}.localhost`
const f = join(process.env.PORTLESS_STATE_DIR, 'routes.json')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
let routes = []
try { routes = JSON.parse(readFileSync(f, 'utf8')) } catch {}
routes = routes.filter((r) => alive(r.pid))
const old = routes.find((r) => r.hostname === host)
if (old && old.pid !== process.pid) {
  if (!force) { console.error(`"${host}" is already registered by a running process (PID ${old.pid})`); process.exit(1) }
  try { process.kill(old.pid, 'SIGTERM'); console.log(`killed ${old.pid}`) } catch {}
}
routes = routes.filter((r) => r.hostname !== host)
routes.push({ hostname: host, port: 4000, pid: process.pid, registeredAt: Date.now() })
writeFileSync(f, JSON.stringify(routes, null, 2))
console.log(`registered ${host} as ${process.pid}`)
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
