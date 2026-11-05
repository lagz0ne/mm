declare module '*.yaml' { const text: string; export default text }
declare module '*/Dockerfile' { const text: string; export default text }
declare module '*.Dockerfile' { const text: string; export default text }
declare module '*/paseo-join.mjs' { const text: string; export default text } // imported as text (box.ts writes and runs it)
