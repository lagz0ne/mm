import { createContext, useContext } from 'react'
import { cn } from '@/lib/utils'

export interface Persona { name: string; color: string; avatar?: string }
export interface Personas { theme: string; agents: Record<string, Persona> }

// Filled from the project's roles (setPersonaRoles); `setup` is the governance agent every project has.
const ROLE_TITLE: Record<string, string> = { setup: 'Setup' }
const FALLBACK: Record<string, string> = { setup: '#111111' }
/** Follow the project's role list (titles and default colors); setup stays. */
export function setPersonaRoles(defs: { id: string; title: string; color: string }[]) {
  for (const k of Object.keys(ROLE_TITLE)) if (k !== 'setup') delete ROLE_TITLE[k]
  for (const k of Object.keys(FALLBACK)) if (k !== 'setup') delete FALLBACK[k]
  for (const d of defs) { ROLE_TITLE[d.id] = d.title; FALLBACK[d.id] = d.color }
}

export const PersonaContext = createContext<Personas | null>(null)

/** The persona behind an actor: a role (`design`), a role's helper (`code/w1`, `code-worker`), or null for humans. */
export function usePersona(actor: string | undefined) {
  const p = useContext(PersonaContext)
  return personaOf(p, actor)
}
export function personaOf(p: Personas | null, actor: string | undefined) {
  if (!actor) return null
  const base = actor.split('/')[0].replace(/-worker$/, '')
  if (!ROLE_TITLE[base]) return null
  const a = p?.agents?.[base]
  const worker = actor !== base
  return {
    role: base,
    roleTitle: ROLE_TITLE[base],
    name: a?.name || `${ROLE_TITLE[base]} lead`,
    color: a?.color || FALLBACK[base],
    avatar: a?.avatar || (a?.name || ROLE_TITLE[base]).slice(0, 2),
    worker,
    label: worker ? `${a?.name || ROLE_TITLE[base]}'s worker` : a?.name ? `${a.name} · ${ROLE_TITLE[base]}` : `${ROLE_TITLE[base]} lead`,
  }
}

/** Square avatar in the agent's color: its emoji, or the first letters of its name. */
export function Avatar({ actor, size = 'sm', className }: { actor: string; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }) {
  const p = usePersona(actor)
  if (!p) return null
  const dim = { xs: 'size-4 text-[9px]', sm: 'size-5 text-[11px]', md: 'size-7 text-sm', lg: 'size-10 text-lg' }[size]
  const emoji = /\p{Extended_Pictographic}/u.test(p.avatar)
  return (
    <span title={p.label} className={cn('inline-flex shrink-0 items-center justify-center font-bold leading-none text-white select-none', dim, p.worker && 'opacity-70', className)}
      style={{ background: emoji ? `${p.color}22` : p.color, boxShadow: emoji ? `inset 0 0 0 1.5px ${p.color}` : undefined }}>
      {emoji ? p.avatar : <span>{p.avatar.slice(0, 2)}</span>}
    </span>
  )
}
