// Types for owner-card.mjs (an identical copy of template/bin/lib/owner-card.mjs; test/owner-card.mjs keeps them equal).
export declare const FORMAT: string
export declare const KEYS: Record<string, number>
export declare const REQUIRED: string[]
export declare const REQUIRED_T2: string[]
export declare function youKind(v: string): 'approve' | 'reply' | 'check' | 'nothing' | null
export declare function parseCard(description: string | undefined | null, labels?: string[]): {
  ok: boolean; found: boolean; card: Record<string, string> | null; errors: string[]; rest: string
}
