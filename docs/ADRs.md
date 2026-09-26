# ADRs — Atlas Inspector

Architecture Decision Records. Statuses: **accepted** (Fase 0 audit, approved by user).

Defaults locked during Fase 0 after registry verification; short rationale here,
details in the audit report and ARCHITECTURE.md conventions.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 001 | Fastify 5.12.5 + @fastify/static/cors/rate-limit/swagger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | accepted             |
| 002 | zod 4.6.5 + fastify-type-provider-zod 7; OpenAPI via @fastify/swagger `jsonSchemaTransform` (no zod-to-openapi)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | accepted             |
| 003 | csv-parse 7 for DB2 CSV tables (no ORM/DB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted             |
| 004 | undici 8; retry/backoff manual in `WagoSource` (legacy policy: 5 tries, 1500+n*1000ms). No p-retry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | accepted             |
| 005 | lru-cache 11 (BLP source) + disk atomic cache (tmp+rename), TTL everywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted             |
| 006 | pino 10 logs + pino-pretty (dev)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | accepted             |
| 007 | Vite 8 + @tanstack/virtual-core + zustand 5 vanilla + own undo snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | accepted             |
| 008 | Native canvas; @pinta365/blp 0.2.0 behind `BlpDecoder` interface; wow-blp-web 0.7.2 as post-test candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted*            |
| 009 | No semver lib (4-part builds need a tiny module): `src/shared/buildVersion.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | accepted             |
| 010 | vitest + fastify.inject integration; @playwright/test e2e (no supertest)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | accepted             |
| 011 | Renovate (grouped) over Dependabot; engine >=22.12 <27; `.nvmrc` 22; CI matrix [22, 26]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | accepted             |
| 012 | Serve ONLY `dist/client` (legacy allowlist only while dist is absent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | accepted (blocks S1) |
| 013 | Errors: RFC 7807 problem+json, typed 404/502/504/400/413; no 500 leaks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | accepted (blocks S2) |
| 014 | Client: Pointer Events + AbortController; virtualized list keeps focus keyboard contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | accepted (blocks C1) |
| 015 | Lua export: one emitter, five styles — `default` (byte-compatible w/ legacy), `coords`, `atlasinfo`, `sheetfirst`, `xml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | accepted (Fase 4)    |
| 016 | Addon-code atlas scanner as pure shared parser (`src/shared/scan.ts`) + DOM-free row derivation (`src/shared/scanView.ts`, re-exported by the client)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | accepted (Fase 4)    |
| 017 | Define-mode auto-fill from alpha islands: `src/shared/islands.ts` `findIslands` + offscreen-canvas alpha readback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | accepted (Fase 4)    |
| 018 | `POST /api/v1/scan` — expose the scanner to agents: JSON `{ code, sheet? }` → normalized entries; row derivation lives in shared so UI and endpoint emit the same numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | accepted (Fase 4)    |
| 019 | MCP server (`src/mcp/`, name `atlas-inspector-mcp-server`) as a thin read-only wrapper over v1 for opencode/Claude: stdio + optional stateless streamable HTTP; inputs validated against shared zod schemas. `outputSchema` declared where structured output is load-bearing (`atlas_server_status`, `atlas_search`) — see the ADR-019 note below for the SDK-compat caveat that originally caused it to be omitted everywhere                                                                                                                                                                                                                                          | accepted (Fase 4)    |
| 020 | Listfile consent gate: the ~146 MB `community-listfile.csv` is **never** downloaded automatically. `ListfileIndex.ensure()` only reads local disk; bytes move exclusively through `fetch()`, reached via `POST /api/v1/listfile/fetch` and only after the `atlas_prepare_index` MCP tool gets an explicit accept through elicitation (decline/cancel/unticked/unsupported all fail closed). A 7-hourly release check (~14 KB, server-side, `unref`) publishes `updateAvailable` via a provenance sidecar. Single-flight, atomic tmp+rename. `GET /api/v1/health` publishes real readiness under `capabilities.search`; `/search` returns 200 with a `status`, never 503 | accepted             |

Entries marked `*` carry a flip-if-fails condition verified during Fase 2:

- **002**: type-provider route-validation held under Fastify 5 + zod 4, and the OpenAPI
  doc comes from `@fastify/swagger` `jsonSchemaTransform` (verified with the
  `/documentation/yaml` smoke) — the zod-to-openapi fallback was never needed.
- **008**: if `@pinta365/blp` fails pixel-identical goldens on the real fixtures (incl. one DXT-with-alpha),
  evaluate `wow-blp-web` 0.7.2 through the same `BlpDecoder` interface. No interface = no swap cost.
- **019**: `outputSchema` was originally omitted on every tool because SDK 1.30 output validation
  was believed incompatible with classic zod v4 schemas. That has since been verified against
  SDK 1.30.1 + zod 4.6.5 for all three risky shapes — declared `outputSchema` with normal
  `structuredContent`, with `isError` and **no** `structuredContent`, and with `isError` **and**
  `structuredContent` — none of which throw. It is now declared only on `atlas_server_status`
  and `atlas_search`, and `tests/integration/mcp.test.ts` pins the `isError` + `structuredContent`
  case. Re-check these three shapes before adding `outputSchema` to more tools.

### ADR-020 — why the listfile asks before it downloads

`cache/listfile.csv` is a ~146 MB index of every texture name in the game. It cannot
ship in the repo, so on a fresh install it is always missing — and `atlas_search` is
the entry point for every atlas lookup. The old behaviour answered 503 "run
`npm run fetch:listfile`", which is useless to an MCP agent (no shell) while
`status: "ok"` health lied about a dead feature.

The first fix made the server self-heal: any search triggered a 150 MB download.
That is the wrong default, and not only because of bandwidth. An agent with a
listfile-shaped tool can be steered into calling it, and a 150 MB side effect that
no human ever agreed to is a bug in any review. So the lifecycle stayed and the
_trigger_ changed:

- **The read path never downloads.** `ensure()` reads local disk and nothing else.
  `GET /api/v1/search` and `GET /api/v1/health` are side-effect free by construction,
  not by a flag. `fetch()` is the only method that writes bytes.
- **Consent is mandatory and fails closed.** `atlas_prepare_index` prompts through
  MCP elicitation and only downloads on an explicit `accept` **and** a ticked box.
  `decline`, `cancel`, accepting without ticking, a client that cannot be asked
  (no elicitation capability), and a prompt nobody answered within 180s all mean
  "no download", and the result names `npm run fetch:listfile` as the manual path.
  The tool is declared `readOnlyHint: false` so a client cannot auto-approve it as
  harmless.
- **The prompt is asked only when it means something.** An index that is already
  ready and current returns immediately with no prompt; so does a refresh that is
  already in flight. Only "absent" or "update available" prompts. A consent prompt
  for something that would not happen teaches people to click through.
- **Freshness without bandwidth.** The server polls the release metadata (~14 KB)
  every 7 hours minimum (`LISTFILE_CHECK_INTERVAL_HOURS`, enforced floor, `unref`ed
  timers, failures swallowed so a rate-limited or offline host keeps searching).
  The stored release comes from a provenance sidecar (`<csv>.meta.json`) written
  after a successful, tag-pinned download; `updateAvailable` is only true when both
  the stored and the latest release are known, because "unknown" is the only honest
  answer for a CSV fetched before provenance existed.
- `absent` → `indexing` → `ready`, or `error` (retried next time). One download at a
  time per process (single-flight), so N concurrent callers cannot start N × 146 MB
  transfers. Writes go to `.tmp` and `rename` into place, so a killed process never
  leaves a half-written CSV that later parses as a tiny index.
- **`status` answers one question: can a search return a real answer now?** That is
  why a refresh of a usable index keeps reporting `ready` (with `refreshing: true`)
  instead of downgrading a working search to `indexing`, and why a failed refresh
  leaves the existing index serving rather than flipping to `error`.
- `/api/v1/search` never returns 503 for a missing index: 200 with `status` plus an
  actionable `detail`, so an agent retries or asks instead of crashing.
- `?wait=<seconds>` (0–25) lets a caller ride out a nearly-finished build. The MCP
  client default is 25s against a 15s HTTP timeout, so it only ever waits when the
  download is seconds from done. It never holds a request open for the whole
  transfer, and giving up never cancels the shared download.
- `POST /api/v1/listfile/fetch` is the only route that can start a download. It
  defaults to `wait: 0` (acknowledge immediately, keep going in the background) so a
  direct caller can never hang an HTTP connection on a multi-minute transfer.
- `LISTFILE_URL` / `LISTFILE_RELEASE_API` repoint the download and the check for
  mirrored or air-gapped installs. `LISTFILE_AUTOFETCH` is gone: there is no
  automatic mode left to configure.

`scripts/fetch-listfile.mjs` does not implement its own download; it delegates to
the compiled `listfileFetch` module so there is exactly one code path — and it now
reports the release tag it installed.

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
