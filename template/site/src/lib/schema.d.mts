// Types for schema.mjs (an identical copy of template/bin/lib/schema.mjs; test/schema.mjs keeps them equal).
export declare const SUPPORTED: Set<string>
export declare function validator(schemas: object[]): { validate: (id: string, value: unknown) => string[]; schema: (id: string) => object | undefined; check: () => string[] }
