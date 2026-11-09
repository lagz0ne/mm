// Types for glossary.mjs (an identical copy of template/bin/lib/glossary.mjs; test/glossary.mjs keeps them equal).
export declare const KINDS: string[]
export declare const FIELDS: string[]
export declare const REQUIRED: string[]
export declare const FILE: string
export declare const LOCAL: string
export declare const WORDS: string
export interface Entry { term: string; kind: string; means: string; not?: string; owner: string; since: string; _line: number; source?: string }
export interface Parsed { refuseFrom: string | null; hasRefuseFrom: boolean; entries: Entry[]; errors: string[] }
export declare function parseGlossary(text: string, file?: string): Parsed
export declare function mergeGlossary(base: Parsed, local: Parsed | null): { refuseFrom: string | null; entries: Entry[]; errors: string[] }
export declare function readGlossary(read: (rel: string) => string | null): { refuseFrom: string | null; entries: Entry[]; terms: { term: string; kind: string }[]; words: string; errors: string[] }
export declare function checkWords(text: string): string[]
