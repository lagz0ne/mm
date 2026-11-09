// Types for owner-card.mjs (an identical copy of template/bin/lib/owner-card.mjs; test/owner-card.mjs keeps them equal).
import type { Problem, Writing } from './writing.mjs'
export declare const FORMAT: string
export declare const KEYS: Record<string, number>
export declare const REQUIRED: string[]
export declare const REQUIRED_T2: string[]
export declare function youKind(v: string): 'approve' | 'reply' | 'check' | 'nothing' | null
export declare const PROSE: string[]
export declare function parseCard(description: string | undefined | null, labels?: string[], id?: string, o?: { writing?: Writing }): {
  ok: boolean; found: boolean; card: Record<string, string> | null; errors: string[]; rest: string; writing: Problem[]
}
export declare const HEAD: RegExp
export declare const SIGNED_HEAD: string
export declare function headRefusal(description: string | undefined | null, labels: Iterable<string> | undefined | null): string | null
export declare function isGoAsk(card: Record<string, string> | null | undefined): boolean
export declare function isNonGoAsk(card: Record<string, string> | null | undefined): boolean
export declare const NO_GO: string
