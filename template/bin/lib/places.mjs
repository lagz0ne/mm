// places — what a role holds against its capacity (roles.json `capacity`) and the project's cap (`wake.cap`): its
// items in progress and its workers, counted once each (sy-asaw). Read by wake (what to hand out), bin/lead worker
// (whether a worker may start) and the Supervisor (who is over).
//   - each live worker of the role is one place (a Paseo agent labelled project=<P> role=<role>-worker; live = not
//     archived and not closed: an idle worker holds its place until its lead stops it);
//   - each item in progress of the role (assignee `<role>` or `<role>/<worker>`) that no live worker works on is one.
// So a lead with one item and one worker on it holds 1; with one item and two workers on it, 2; a stray worker, 1.
// A worker's name and item: its labels `worker` and `item`; Paseo's CLI list has no labels, so also from its title
// ("<project> · <role> worker <name> on <item>", as bin/lead worker start names it).

import fs from 'node:fs'
import path from 'node:path'

const ITEM = /^[a-z][a-z0-9]*-[a-z0-9]+(?:\.\d+)*$/
export const live = (w) => !w.archived && w.status !== 'closed'
const mineOf = (role, i) => i.assignee === role || String(i.assignee || '').startsWith(`${role}/`)

/** A Paseo agent (bin/lib/paseo.mjs's shape) as a worker of `role`: { id, role, name, item, status, archived }. */
export function asWorker(a, role) {
  const t = / worker ([a-z0-9][a-z0-9.-]*) on ([a-z][a-z0-9]*-[a-z0-9.]+)\s*$/.exec(a.name || '') || []
  const item = a.labels?.item || t[2] || null
  return { id: a.id, role, name: a.labels?.worker || t[1] || null, item: item && ITEM.test(item) ? item : null, status: a.status, archived: !!a.archived }
}

/** The live workers of these roles, from Paseo (`paseo`: bin/lib/paseo.mjs). One list per role (the CLI filters by label). */
export async function workersOf(paseo, project, roles) {
  const out = []
  for (const role of roles) for (const a of await paseo.list({ project, role: `${role}-worker` })) { const w = asWorker(a, role); if (live(w)) out.push(w) }
  return out
}

/** The places `role` holds: { used, items (in progress), workers (live), unworked (items no worker works on) }. */
export function places(role, items, workers) {
  const held = items.filter((i) => i.status === 'in_progress' && mineOf(role, i))
  const ws = workers.filter((w) => w.role === role && live(w))
  const worked = new Set(ws.map((w) => w.item).filter(Boolean))
  const unworked = held.filter((i) => !worked.has(i.id))
  return { used: unworked.length + ws.length, items: held, workers: ws, unworked }
}

/** The places over all roles (the project's cap): items in progress of any role, and every live worker. */
export function total(roles, items, workers) {
  return roles.reduce((n, r) => n + places(r, items, workers).used, 0)
}

/** The project's cap: WAKE_CAP, else `wake.cap` in mm's config.yaml (`mm config set wake.cap <n>`); 0 = none. */
export function projectCap(mmDir) {
  if (process.env.WAKE_CAP) return Number(process.env.WAKE_CAP) || 0
  let c = ''; try { c = fs.readFileSync(path.join(mmDir, 'config.yaml'), 'utf8') } catch {}
  const m = /^wake:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+cap:[ \t]*["']?(\d+)/m.exec(c)
  return m ? Number(m[1]) : 0
}
