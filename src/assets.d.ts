declare module '*.yaml' { const text: string; export default text }
declare module '*/Dockerfile' { const text: string; export default text }
declare module '*.Dockerfile' { const text: string; export default text }
declare module '*/paseo-join.mjs' { const text: string; export default text } // imported as text (box.ts writes and runs it)
declare module '*/portless-claim.mjs' { const text: string; export default text } // imported as text (project.ts writes it; HTTP services run it)
// the egress proxy's source, imported as text: mm box build writes it into the build context of the egress image
declare module '*/egress/main.go' { const text: string; export default text }
declare module '*/egress/main_test.go' { const text: string; export default text }
declare module '*/egress/go.mod' { const text: string; export default text }
