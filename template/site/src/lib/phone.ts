import { useSyncExternalStore } from 'react'

const media = (q: string) => {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null
  const subscribe = (f: () => void) => { mq?.addEventListener('change', f); return () => mq?.removeEventListener('change', f) }
  return () => useSyncExternalStore(subscribe, () => !!mq?.matches, () => false)
}
// Phones: below Tailwind's md (48rem). The board's own small-screen layout (sy-81dm) renders there; md and up keep the
// tablet drawer and the desktop grid.
export const usePhone = media('(max-width: 47.99rem)')
// Desktop: Tailwind's xl (80rem) and up. Now and Activity dock beside the board there when opened (sy-p88g); below,
// they open as a drawer over it.
export const useDesk = media('(min-width: 80rem)')
