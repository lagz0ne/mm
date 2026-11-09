// Types for structured.mjs (an identical copy of template/bin/lib/structured.mjs; test/schema.mjs keeps them equal).
export interface Part {
  type: 'text' | 'markdown' | 'mermaid' | 'html' | 'svg' | 'image' | 'table' | 'log'; title?: string
  text?: string; markdown?: string; mermaid?: string; html?: string; svg?: string; log?: string; artifact?: string; alt?: string
  columns?: string[]; rows?: (string | number | boolean | null)[][]
}
export interface Block { kind: string; v: number; data: any; errors: string[]; raw: string; rest: string }
export declare const VERSION: number
export declare const KINDS: string[]
export declare const SCHEMA_ID: Record<string, string>
export declare const MAX_BLOCK: number
export declare const PART_TYPES: string[]
export declare function looksStructured(text: string | undefined | null): boolean
export declare function readBlock(text: string | undefined | null): Block | null
export declare function formatBlock(kind: string, data: unknown): string
export declare function validate(kind: 'message' | 'task' | 'card', data: unknown): string[]
export declare function partsText(parts: unknown): string
export declare function firstText(parts: unknown): string
export declare function byText(b: unknown): string
export declare function verifyText(x: unknown): string
export declare function stepText(x: unknown): string
export declare function doneText(x: unknown): string
export declare function messageKeys(d: unknown): { intent: string | null; to: string | null; re: number | null; keys: Record<string, string>; expect: { role: string; action: string } | null; by: string | null }
export declare function taskKeys(d: unknown): Record<string, string>
export declare function cardKeys(d: unknown): Record<string, string>
