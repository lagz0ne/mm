// The boxes a machine server (mm.ai, mm.api) answers, from the host's own registry (pc/boxes, which the host writes).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, HOME } from './env'

/** A test's own server (`only`: MM_AI_ONLY, MM_API_ONLY; a comma list) answers its own boxes only. The machine's never answers a
 *  throwaway project's box (`mm new --throwaway`: a test's): that test runs its own servers, which file into stand-ins,
 *  never into the owner's board or Telegram. Before this, the machine's mm.api took a test box's socket and filed its
 *  test requests on the system board (sy-bpgq). */
export function servedBoxes(name: RegExp, only?: string): string[] {
  const dir = join(DIRS.pc, 'boxes')
  const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).filter((p) => name.test(p)) : []
  const mine = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null
  return mine ? all.filter((p) => mine.has(p)) : all.filter((p) => !throwaway(p))
}

/** The box's answers say throwaway: true (its root from the registry; the answers are read-only in the box). */
function throwaway(project: string): boolean {
  try {
    const m = /from (.+)\/services\.yaml/.exec(readFileSync(join(DIRS.pc, 'boxes', `${project}.yaml`), 'utf8'))
    const root = m ? m[1].replace(/^~(?=\/)/, HOME) : ''
    return !!root && /^throwaway:\s*true\s*$/m.test(readFileSync(join(root, '.mm-answers.yaml'), 'utf8'))
  } catch { return false }
}
