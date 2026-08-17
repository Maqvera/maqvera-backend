# SDK Generation

Enterprise OpenAPI / Swagger Standard — "SDKs SHOULD be generated automatically from OpenAPI. No handwritten SDKs."

## `typescript/` — real, generated, working

`npm run generate:openapi` runs `openapi-typescript` (a real devDependency) directly against the live `swaggerSpec`, producing `typescript/index.d.ts` — genuine, compiler-checked TypeScript types for every path/schema this codebase's OpenAPI document actually declares. Nothing hand-written; regenerate any time the spec changes. This is real enough to build a typed `fetch` wrapper client on top of directly (`paths["/payments"]["post"]["responses"][201]["content"]["application/json"]`, etc.) — a genuine SDK type layer, not a mock.

## Java / Python / C# / Go / PHP / Kotlin / Swift — honestly deferred

The spec's own recommended list names eight SDK languages. Only TypeScript is real here because it's the one language this Node/JS codebase can generate directly, in-process, from its own dependency tree — no new toolchain required. The other seven all need `openapi-generator-cli` (a separate Java-based code generator with its own JVM runtime requirement) or an equivalent per-language toolchain, none of which exist in this environment. Rather than fake a `python/`, `java/`, etc. folder with placeholder or hand-typed "generated" code — which would violate this exact standard's own "No handwritten SDKs" rule — this is left as a genuine, buildable follow-up: once `openapi-generator-cli` (or a language-specific generator) is actually available in a deployment/CI environment, it can point at the same real `docs/openapi/v1.yaml` this file's own TypeScript generation already uses as its source of truth.
