// Types for writing.mjs (an identical copy of template/bin/lib/writing.mjs; test/writing.mjs keeps them equal).
export declare const MAX_PROCEDURAL: number
export declare const MAX_DESCRIPTIVE: number
export declare const MAX_PARAGRAPH: number
export declare const SOFT: string[]
export declare const MAX_REASONS: number
export interface Problem { rule: string; line: number; text: string }
export type Words = Map<string, { pos: string; base: string }>
export interface Writing { terms?: ({ term: string; kind?: string } | string)[]; words?: Words | string; roles?: string[]; refuseFrom?: string | null; today?: Date | string }
export declare function parseWords(text: string): Words
export declare function refusing(refuseFrom: string | null | undefined, today?: Date | string): boolean
export declare function checkWriting(text: string, o?: Writing): Problem[]
export declare function writingCheck(text: string, w: Writing | undefined | null | false, errors: string[]): Problem[]
export declare function sayWriting(list: Problem[]): string
