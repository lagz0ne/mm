// Public names: the one rule for the host a project's public service gets under the machine's domain (sy-b15.3).
// The machine setting `names` (config.yaml) picks it:
//   legacy (the default)  each service's own `public.name` from its services.yaml (today: board-<name>-<client>, the
//                         app <name>-<client>)
//   project               a project's board is <project>.<domain>, its other public services <service>.<project>.<domain>
// The system board keeps its own name in both. resolve() (src/project.ts) is the only caller that names a service, so
// the routes mm writes, the gateway's host registry (src/auth.ts hostClaims), the board's own URL (.run/endpoints.json)
// and the forward-auth gate all follow it; a box's granted routes (src/api.ts) are boxRoute(). A small module with no
// heavy imports, so each of them can read it.
import { getPath, loadConfig, type Config } from './config'

export const NAMES_MODES = ['legacy', 'project'] as const
export type NamesMode = typeof NAMES_MODES[number]

/** The machine's naming rule; unset is `legacy`. Any other value is refused (not guessed): a wrong one would move
 *  every public route. */
export function namesMode(c: Config = loadConfig()): NamesMode {
  const v = getPath(c, 'names')
  if (v === undefined || v === null || v === '') return 'legacy'
  if ((NAMES_MODES as readonly string[]).includes(String(v))) return String(v) as NamesMode
  throw new Error(`config names: "${String(v)}" is not one of ${NAMES_MODES.join(', ')} (mm config set names legacy)`)
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
/** A name under the domain is a set of DNS labels: each 1-63 of a-z 0-9 -, no - first or last; at most 200 in all
 *  (the domain takes the rest of the 253). */
export const dnsName = (n: string) => n.length <= 200 && n.split('.').every((l) => LABEL.test(l))

/**
 * The route name (what goes before `.<domain>`) of a project's public service. `own` is the service's `public.name`
 * (filled): what legacy keeps. Under `project`, a name that is no valid DNS label set is refused.
 */
export function routeName(a: { project: string; profile?: string }, service: string, own: string, mode: NamesMode = namesMode()): string {
  if (mode === 'legacy' || a.profile === 'system') return own
  const n = service === 'board' ? a.project : `${service}.${a.project}`
  if (!dnsName(n)) throw new Error(`${a.project}: "${n}" is no valid DNS name (names: project), so its ${service} can have no public name`)
  return n
}
/** The route name of a route the owner granted a box (src/api.ts): <name>.<project>, in both modes. */
export const boxRoute = (project: string, name: string) => `${name}.${project}`
