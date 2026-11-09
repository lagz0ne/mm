declare module '*.yaml' { const text: string; export default text }
declare module '*/Dockerfile' { const text: string; export default text }
declare module '*.Dockerfile' { const text: string; export default text }
declare module '*/paseo-join.mjs' { const text: string; export default text } // imported as text (box.ts writes and runs it)
declare module '*/portless-claim.mjs' { const text: string; export default text } // imported as text (project.ts writes it; HTTP services run it)
// the egress proxy's source, imported as text: mm box build writes it into the build context of the egress image
declare module '*/egress/main.go' { const text: string; export default text }
declare module '*/egress/main_test.go' { const text: string; export default text }
declare module '*/egress/go.mod' { const text: string; export default text }
// the approval ledger's checks (sy-1jmi), shared with the board's Supervisor and flow (template/bin/lib/ledger.mjs)
declare module '*/ledger.mjs' {
  export interface ApproveConf { path: string | null; strict?: boolean; verifier: 'actor' | 'ledger'; user?: string; uid?: number | null; dir?: string; ledger?: string; public_key?: string; problems?: string[] }
  export function loadConf(o?: { etc?: string; env?: Record<string, string | undefined> }): ApproveConf
  export function problems(c: ApproveConf): string[]
}
// a gates file's verdict for a head (sy-n4f5) and the T2 go's head rule (sy-6gz6), read by mm ship (sy-sbjh)
declare module '*/gates-file.mjs' {
  export function parseSignedHead(label: string): { repo: string; sha: string } | null
  export function gatesVerdict(text: string, sha: string, o?: { t2?: boolean; file?: string }): string | null
}
declare module '*/owner-card.mjs' {
  export const APPROVED_HEAD: string
  export function approvalRefusal(description: string, labels: Iterable<string>): string | null
}
