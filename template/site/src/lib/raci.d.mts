// Types for raci.mjs (an identical copy of template/bin/lib/raci.mjs; test/raci.mjs keeps them equal).
export interface Bounds { tier?: string; repos?: string[]; paths?: string[]; surfaces?: string[]; actions?: string[]; end?: string
  within?: { of: 'migration' | 'boot' | 'gates'; minutes: number }; for_min?: number; times?: number; exclude?: string }
export interface Verify { check: string; expect: string }
export interface WhenCase { on: string; text?: string; next?: string; bounds?: Bounds; verify?: Verify; correct?: string }
export interface Row { id: string; title: string; raci: Record<string, string>; consult?: string[]
  when?: (string | WhenCase)[]; bounds?: Bounds; verify?: Verify; correct?: string }
export interface Case { row: string; n: number; on: string; re: RegExp; text: RegExp | null; next: string; bounds: Bounds; verify: Verify | null; correct: string }
export interface Finding { events?: string[]; lines?: string[] }
export interface Ctx { now?: number; at?: number; since?: number; times?: number; last?: { migration?: number | null; boot?: number | null }; gates?: [number, number][] }
export interface Verdict { routine: boolean; why?: string; case?: Case }
export declare const KINDS: string[]
export declare const TIERS: string[]
export declare const WITHIN: string[]
export declare const UNEXPECTED: string
export declare function routineProblems(a: Row): string[]
export declare function cases(activities: Row[] | null | undefined): Case[]
export declare function outside(b: Bounds, f: Finding, ctx?: Ctx): string | null
export declare function match(cs: Case[], f: Finding, ctx?: Ctx): { case: Case; outside: string | null } | null
export declare function escalates(c: Case | null | undefined): boolean
export declare function judge(cs: Case[], f: Finding, ctx?: Ctx): Verdict
export declare function caseLine(c: Case): string
export declare const LETTERS: string[]
export declare const MEANS: Record<string, string>
export declare const GATE: string[]
export declare const ID: RegExp
export declare function problems(d: { activities?: Row[] } | null | undefined, participants: string[]): string[]
export declare function rowOf(activities: Row[] | null | undefined, act: string | null | undefined): Row | null
export declare function actOf(labels: string[] | null | undefined): string | null
export declare function lettersOf(row: Row | null | undefined, who: string): string
export declare function withLetter(row: Row | null | undefined, letter: string): string[]
export declare function mayAsk(row: Row | null | undefined, role: string): boolean
export declare function noInputOk(row: Row | null | undefined, role: string, intent: string): boolean
