// Zero side effects (sy-8w1): everything mm touches lives under $MM_HOME, but for the boot unit and a PATH line. The list is
// env.ts outsidePaths() (plus the manifest's secret inputs, and the tools mm manages); here are its doctor check and the
// one-time move of an older box's folders (`mm up`, `mm onboard`, `mm doctor --fix`).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DIRS, HOME, outsidePaths, run, tilde, which, within, type Outside } from './env'
import { expand, machineInputs } from './inputs'
import { manifest } from './manifest'
import { writeLauncher } from './pc'

export interface Row { layer: string; item: string; status: 'ok' | 'warn' | 'fail' | 'skip'; detail: string; fix?: string }
export interface MoveStep { step: string; status: 'ok' | 'fixed' | 'refused' | 'skip'; detail: string }

const lst = (p: string) => { try { return lstatSync(p) } catch { return null } }
const isEmptyDir = (p: string) => { try { return statSync(p).isDirectory() && readdirSync(p).length === 0 } catch { return false } }
/** The old path is a link mm left, to its new place. */
const leftLink = (o: Outside) => { const s = lst(o.path); return !!s?.isSymbolicLink() && !!o.to && readlinkSync(o.path) === o.to }
const answering = () => run(['process-compose', '-U', '-u', DIRS.socket, 'project', 'state'], { timeoutMs: 10_000 }).ok
/**
 * Every process the process manager runs has the new place (so a link left at the old one can go): it isn't running, or
 * it started (its socket is made at start) after the link was left, from a launcher that exports the tools' folders.
 */
function restartedSince(o: Outside): boolean {
  if (!answering()) return true
  const launcher = join(DIRS.bin, 'mm-pc-up'), sock = lst(DIRS.socket), link = lst(o.path), ln = lst(launcher)
  if (!sock || !link || !ln) return false
  let text = ''; try { text = readFileSync(launcher, 'utf8') } catch {}
  return text.includes(`PORTLESS_STATE_DIR="${DIRS.portless}"`) && sock.mtimeMs > link.mtimeMs && sock.mtimeMs > ln.mtimeMs
}

/**
 * The managed tools (an install kind of mm's own, not a system package) that this machine runs from the home folder but
 * outside $MM_HOME: an older install (~/.npm-global, ~/.local/bin). A tool of the system's (/usr/bin) is not mm's side effect.
 */
export function toolsOutside(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = []
  for (const [name, t] of Object.entries(manifest.machine.tools)) {
    if (!t.install || t.install.kind === 'system' || t.install.kind === 'script') continue
    const p = which(name)
    if (p && within(p, HOME) && !within(p, DIRS.mm)) out.push({ name, path: p })
  }
  return out
}

/** The secret inputs whose file is outside $MM_HOME (paths only; never opened). */
function secretsOutside(): string[] {
  return Object.values(machineInputs()).filter((i) => i.kind === 'secret' && i.path && !i.managed_by).map((i) => expand(i.path!))
    .filter((p) => !within(p, DIRS.mm) && existsSync(p))
}

/** doctor: "outside $MM_HOME". A row for each path that is there; the allowed ones ok, the rest warn with its move. */
export function outsideChecks(): Row[] {
  const rows: Row[] = []
  const row = (item: string, status: Row['status'], detail: string, fix?: string) => rows.push({ layer: 'outside', item, status, detail, fix })
  for (const o of outsidePaths()) {
    const s = lst(o.path); if (!s) continue
    const at = tilde(o.path), to = o.to ? tilde(o.to) : ''
    if (o.use === 'allowed') row(o.id, 'ok', `${at}: ${o.what} (allowed)`)
    else if (o.use === 'theirs') row(o.id, 'ok', `${at}: ${o.what}, not mm's${o.note ? `; ${o.note}` : ''}`)
    else if (o.use === 'move' && leftLink(o)) row(o.id, 'warn', `${at} is the link mm left to ${to} (for what still ran with the old path)`,
      restartedSince(o) ? 'mm doctor --fix (removes the link)' : `after the process manager restarts: mm doctor --fix (or rm ${at})`)
    else if (o.use === 'move') row(o.id, 'warn', `${at}: ${o.what}; mm keeps it in ${to}`, 'mm doctor --fix (or the next mm up) moves it')
    else row(o.id, 'warn', `${at}: ${o.what}${o.note ? `; ${o.note}` : ''}`, o.use === 'old' ? `rm -r ${at} once nothing runs from it` : undefined)
  }
  for (const t of toolsOutside()) row(`tool ${t.name}`, 'warn', `runs from ${tilde(t.path)}, outside ${tilde(DIRS.mm)}`, 'mm onboard (installs its own into ~/.mm)')
  for (const p of secretsOutside()) row('secret', 'warn', `${tilde(p)}: a secret input's file outside ${tilde(DIRS.mm)}`, 'the vault holds secrets (docs/vault.md); mm never moves one')
  if (!rows.some((r) => r.status !== 'ok')) row('outside $MM_HOME', 'ok', `nothing of mm's outside ${tilde(DIRS.mm)} but the allowed`)
  return rows
}

/**
 * The one-time move of what an older box kept outside $MM_HOME (the `move` entries). Only by rename, only into an empty
 * (or missing) place; a link is left at the old path when the process manager runs (its processes may still use it
 * until it restarts). Anything else is refused, with why. `unlink`: also remove such a link once nothing needs it (doctor
 * --fix). Idempotent: a moved entry is nothing to do.
 */
export function moveOutside(o: { unlink?: boolean } = {}): MoveStep[] {
  const steps: MoveStep[] = []
  let live: boolean | undefined
  const running = () => (live ??= answering())
  for (const e of outsidePaths()) {
    if (e.use !== 'move' || !e.to) continue
    const s = lst(e.path), at = tilde(e.path), to = tilde(e.to), step = `move ${e.id}`
    if (!s) continue
    if (leftLink(e)) {
      if (!o.unlink) continue
      if (restartedSince(e)) { unlinkSync(e.path); steps.push({ step, status: 'fixed', detail: `removed the link ${at} (nothing runs with the old path)` }) }
      else steps.push({ step, status: 'skip', detail: `the link ${at} stays until the process manager restarts` })
      continue
    }
    if (s.isSymbolicLink()) { steps.push({ step, status: 'refused', detail: `${at} is a link, not mm's (to ${readlinkSync(e.path)}): left as it is` }); continue }
    if (!s.isDirectory()) { steps.push({ step, status: 'refused', detail: `${at} is not a folder: left as it is` }); continue }
    if (lst(e.to) && !isEmptyDir(e.to)) { steps.push({ step, status: 'refused', detail: `both ${at} and ${to} are there: mm uses ${to}; merge ${at} into it, or remove it, by hand` }); continue }
    const tmp = `${e.path}.mm-link-${process.pid}`
    try {
      if (lst(e.to)) rmdirSync(e.to)
      mkdirSync(dirname(e.to), { recursive: true })
      const linkNow = !!e.link && running()
      if (linkNow) symlinkSync(e.to, tmp)       // made first, so the old path is a folder or the link, never missing for long
      renameSync(e.path, e.to)
      if (linkNow) renameSync(tmp, e.path)
      steps.push({ step, status: 'fixed', detail: `${at} -> ${to}${linkNow ? ` (a link left at ${at} until the process manager restarts)` : ''}` })
    } catch (err) {
      if (lst(tmp)) unlinkSync(tmp)
      const why = (err as NodeJS.ErrnoException).code === 'EXDEV' ? 'on another file system: move it by hand' : String((err as Error).message)
      steps.push({ step, status: 'refused', detail: `${at}: ${why}` })
    }
  }
  // the launcher exports the new places from the process manager's next restart on
  if (steps.some((m) => m.status === 'fixed' && !m.detail.startsWith('removed'))) writeLauncher()
  return steps
}
