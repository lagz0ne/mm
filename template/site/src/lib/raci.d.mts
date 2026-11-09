// Types for raci.mjs (an identical copy of template/bin/lib/raci.mjs; test/raci.mjs keeps them equal).
export interface Row { id: string; title: string; raci: Record<string, string>; consult?: string[] }
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
