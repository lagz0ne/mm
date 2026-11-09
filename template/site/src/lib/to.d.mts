// Types for to.mjs (an identical copy of template/bin/lib/to.mjs; test/board-thread.mjs keeps them equal).
export declare function pickOf(text: string, roles?: string[]): string | null
export declare function splitPick(text: string, roles?: string[]): { to: string | null; body: string }
export declare const withPick: (text: string, role?: string | null) => string
