# ADRs — Atlas Inspector

Architecture Decision Records. Statuses: **accepted** (Fase 0 audit, approved by user).

Defaults locked during Fase 0 after registry verification; short rationale here,
details in the audit report and ARCHITECTURE.md conventions.

| #   | Decision                                                                                                                                                                                                                                                                                                    | Status               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 001 | Fastify 5.12.5 + @fastify/static/cors/rate-limit/swagger                                                                                                                                                                                                                                                    | accepted             |
| 002 | zod 4.6.5 + fastify-type-provider-zod 7; OpenAPI via @fastify/swagger `jsonSchemaTransform` (no zod-to-openapi)                                                                                                                                                                                             | accepted             |
| 003 | csv-parse 7 for DB2 CSV tables (no ORM/DB)                                                                                                                                                                                                                                                                  | accepted             |
| 004 | undici 8; retry/backoff manual in `WagoSource` (legacy policy: 5 tries, 1500+n*1000ms). No p-retry.                                                                                                                                                                                                         | accepted             |
| 005 | lru-cache 11 (BLP source) + disk atomic cache (tmp+rename), TTL everywhere                                                                                                                                                                                                                                  | accepted             |
| 006 | pino 10 logs + pino-pretty (dev)                                                                                                                                                                                                                                                                            | accepted             |
| 007 | Vite 8 + @tanstack/virtual-core + zustand 5 vanilla + own undo snapshots                                                                                                                                                                                                                                    | accepted             |
| 008 | Native canvas; @pinta365/blp 0.2.0 behind `BlpDecoder` interface; wow-blp-web 0.7.2 as post-test candidate                                                                                                                                                                                                  | accepted*            |
| 009 | No semver lib (4-part builds need a tiny module): `src/shared/buildVersion.ts`                                                                                                                                                                                                                              | accepted             |
| 010 | vitest + fastify.inject integration; @playwright/test e2e (no supertest)                                                                                                                                                                                                                                    | accepted             |
| 011 | Renovate (grouped) over Dependabot; engine >=22.12 <27; `.nvmrc` 22; CI matrix [22, 26]                                                                                                                                                                                                                     | accepted             |
| 012 | Serve ONLY `dist/client` (legacy allowlist only while dist is absent)                                                                                                                                                                                                                                       | accepted (blocks S1) |
| 013 | Errors: RFC 7807 problem+json, typed 404/502/504/400/413; no 500 leaks                                                                                                                                                                                                                                      | accepted (blocks S2) |
| 014 | Client: Pointer Events + AbortController; virtualized list keeps focus keyboard contract                                                                                                                                                                                                                    | accepted (blocks C1) |
| 015 | Lua export: one emitter, five styles — `default` (byte-compatible w/ legacy), `coords`, `atlasinfo`, `sheetfirst`, `xml`                                                                                                                                                                                    | accepted (Fase 4)    |
| 016 | Addon-code atlas scanner as pure shared parser (`src/shared/scan.ts`) + DOM-free row derivation (`src/shared/scanView.ts`, re-exported by the client)                                                                                                                                                       | accepted (Fase 4)    |
| 017 | Define-mode auto-fill from alpha islands: `src/shared/islands.ts` `findIslands` + offscreen-canvas alpha readback                                                                                                                                                                                           | accepted (Fase 4)    |
| 018 | `POST /api/v1/scan` — expose the scanner to agents: JSON `{ code, sheet? }` → normalized entries; row derivation lives in shared so UI and endpoint emit the same numbers                                                                                                                                   | accepted (Fase 4)    |
| 019 | MCP server (`src/mcp/`, name `atlas-inspector-mcp-server`) as a thin read-only wrapper over v1 for opencode/Claude: stdio + optional stateless streamable HTTP; inputs validated against shared zod schemas (outputSchema omitted — SDK 1.30 output validation is incompatible with classic zod v4 schemas) | accepted (Fase 4)    |

Entries marked `*` carry a flip-if-fails condition verified during Fase 2:

- **002**: type-provider route-validation held under Fastify 5 + zod 4, and the OpenAPI
  doc comes from `@fastify/swagger` `jsonSchemaTransform` (verified with the
  `/documentation/yaml` smoke) — the zod-to-openapi fallback was never needed.
- **008**: if `@pinta365/blp` fails pixel-identical goldens on the real fixtures (incl. one DXT-with-alpha),
  evaluate `wow-blp-web` 0.7.2 through the same `BlpDecoder` interface. No interface = no swap cost.

### Explicit behavior changes vs legacy (C1 fixes)

- 5xx responses no longer return `e.message` (S2) → RFC 7807.
- Lua export now escapes `\` (legacy escaped only `'`).
- Outside `default`, styled Lua lines (coords/atlasinfo/sheetfirst/xml) emit at
  column 0 — only the legacy-style `default` keeps the 2-space indent — and
  `coords` annotates `-- WxH px` with the raw piece size (fractional for
  sub-pixel edges), not the rounded display size. Tests assert both.
- Client uses Pointer Events + AbortController → cancels stale renders (was fire-and-forget mouse-only).
- Cache-buster `&t=Date.now()` removed so `Cache-Control: max-age` works.
- `/search` has no public upstream (wago.tools has no search API) — it indexes the
  community listfile (wowdev/wow-listfile); missing index → 503 + hint to run `npm run fetch:listfile`.
- Remote UA becomes an honest `atlas-inspector/…` (legacy faked Chrome).

### Known pending checks

- Listfile licence: `wowdev/wow-listfile` has no LICENSE file; the release
  artifact is the community-maintained listfile. Fetching at runtime is fine,
  but confirm before distributing the _generated index_ with the app.
- Renovate handling of the JSR alias `npm:@jsr/pinta365__blp` (may need `pinDigests`/override).
