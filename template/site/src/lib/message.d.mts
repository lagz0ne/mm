// Types for message.mjs (an identical copy of template/bin/lib/message.mjs; test/message.mjs keeps them equal).
export declare const MAX: number
export declare const MAX_EXPECT_WORDS: number
export declare const INTENTS: Record<string, { says: string; req: string[]; opt: string[]; expect: 'role' | 'none' | 'any' | 'no' }>
export declare const WAITING: string[]
export declare const FORMAT: string
export declare function looksLikeMessage(text: string | undefined | null): boolean
export interface Message {
  ok: boolean; found: boolean; intent: string | null; to: string | null; re: number | null
  keys: Record<string, string>; expect: { role: string; action: string } | null; by: string | null; text: string; errors: string[]
}
export declare function parseMessage(text: string | undefined | null, o?: { roles?: readonly string[] | string[] }): Message
export declare function dueAt(by: string | null, at: string | number | Date, nextWakeMin?: number): number | null
export interface Wait { n: number; intent: string; from: string; to: string; role: string; action: string; by: string | null; due: number | null; late: boolean }
export declare function openWaits(comments: { author?: string; text?: string; created_at?: string }[] | undefined | null,
  o?: { roles?: readonly string[] | string[]; nextWakeMin?: number; now?: number }): Wait[]
