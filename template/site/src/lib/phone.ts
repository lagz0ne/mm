import { useSyncExternalStore } from 'react'

// Phones: below Tailwind's md (48rem). The board's own small-screen layout (sy-81dm) renders there; md and up keep the
// tablet drawer and the desktop grid.
const PHONE = '(max-width: 47.99rem)'
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE) : null
const subscribe = (f: () => void) => { mq?.addEventListener('change', f); return () => mq?.removeEventListener('change', f) }
export const usePhone = () => useSyncExternalStore(subscribe, () => !!mq?.matches, () => false)
