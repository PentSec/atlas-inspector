# AGENTS.md — Atlas Inspector

Guidance for AI coding agents working in this repository. Read this before
making changes.

## Project in one line

Local web app to inspect WoW texture atlases by FileDataID: a **Node/Fastify + TypeScript
API** (server) and a **strict TypeScript Vite client** (no framework, single canvas),
both fed by on-demand lookups against wago.tools.

## Runtime & commands

- Requires **Node ≥ 22.12** (this repo uses modern node: `import.meta.dirname`, `--env-file-if-exists`). ESM everywhere (`"type": "module"`).
- Deps: `zustand` (client store, vanilla — **no React**), `fastify` + plugins, `zod`, `lru-cache`, `pino`, `undici`, `csv-parse`, `@pinta365/blp` (BLP decoder), `vite`, `tsx`, `vitest`, `playwright` (e2e), `eslint`, `prettier`.

| Task           | Command                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Run everything | `node start.mjs` (auto-builds once; `--dev` = tsx hot reload)                                   |
| Dev API        | `npm run dev:server`                                                                            |
| Dev UI         | `npm run dev:client` (Vite, proxies `/api` → `127.0.0.1:8000`)                                  |
| Tests          | `npm test` (`vitest run`)                                                                       |
| Typecheck      | `npm run typecheck` (client+shared) and `npm run build:server` (server part of `npm run build`) |
| Lint / format  | `npm run lint`, `npm run format:check`                                                          |
| Build          | `npm run build` → `dist/server/` + `dist/client/`                                               |

**Verification contract (run all three before finishing a change):** `npm run typecheck`, `npm test`, `npm run build`.

## Architecture — the rules that keep it sane

1. **One wire contract.** Shared zod schemas live in `src/shared/schemas.ts` (re-exported by `src/shared/types.ts`). Server parses with them **and** clients/agents import the inferred types. Never drift: any API shape change must be a schema change first.
2. **One Lua exporter.** `src/shared/lua.ts` (`luaRegionEntry`, `luaExport`, `luaEscape`, `displaySizeFallback`, `atlasLuaStyled`, `texCoordLinePx`/`texCoordLineNorm`) is the ONLY formatter, with five styles (`default`, `coords`, `atlasinfo`, `sheetfirst`, `xml`). Client list copy (`src/client/state/export.ts`), scan copy (`src/client/ui/scan.ts`) and server `/export` all route through it. Format parity note: the legacy prototype emitted `toFixed(6)` decimals — the shared exporter reproduces that byte-for-byte except it additionally escapes backslashes (intentional, documented fix). Only `default` carries the 2-space indent; styled lines emit at column 0 and `coords` sizes in `--` comments are raw piece px.
3. **The client only talks to v1** (ADR-013): `GET /api/v1/{health,builds,files/:fdid,files/:fdid/blp,atlas/:fdid[?build=]}`, `POST /api/v1/blp/decode`. Atlas errors are HTTP 404 Problem+JSON — parse `problem.detail`. There is no v1 render endpoint on purpose: sheet preview = download BLP → decode → PNG. **Agents consuming the app** (outside the browser) use the same v1 plus `GET /api/v1/search?q=[&limit=][&wait=]` (ADR-020), `POST /api/v1/listfile/fetch` (the consent-gated download trigger), `POST /api/v1/scan` (addon-code scanner → normalized entries; body `{ code, sheet? }` is application/json, sheet carries `{ width, height, members[] }`) and the `GET /api/v1/atlas/:fdid/export` Lua export. The scan row derivation lives in `src/shared/scanView.ts` (moved out of the client so server and UI share it). **MCP** (`src/mcp/`, stdio + optional streamable HTTP) is a thin read-only wrapper over the same v1 for opencode/Claude — reuse `AtlasApiClient`/`tools.ts`, never add a tool that bypasses a v1 route or a shared schema. `atlas_prepare_index` is the one deliberate exception to "read-only": it writes 146 MB after elicitation, and it is the only tool allowed to do so. `src/mcp/launch.ts` (`ensureAppRunning`) auto-starts the app when it boots: it health-checks `ATLAS_URL` and spawns `node start.mjs` detached (loopback URLs only, `ATLAS_AUTOSTART=0` opts out, logs to `cache/mcp-app.log`). `atlas_blp_islands`/`atlas_blp_alpha` resolve their `blp` argument through `src/mcp/blpInput.ts` (`resolveBlpBytes`), which accepts a **path or base64** and validates the BLP magic before sending — never reintroduce a bare `Buffer.from(blp, "base64")`.
4. **The listfile never downloads without the user's say-so** (ADR-020). `cache/listfile.csv` (~146 MB) is not in the repo, so on a fresh install `atlas_search` is dead — and the only way to fix that must not be a silent 146 MB side effect. `ListfileIndex` (`src/server/services/search.ts`) keeps the `absent → indexing → ready | error` lifecycle, but the trigger is consent, not traffic: `ensure()` reads local disk only, `fetch()` is the sole writer, and it is reached solely through `POST /api/v1/listfile/fetch`. That route is called by the `atlas_prepare_index` MCP tool **only after** elicitation returns an explicit accept + ticked box; `decline`/`cancel`/unticked/unsupported/no-answer all fail closed and name `npm run fetch:listfile`. Staleness is reported, not fixed: `startReleaseCheck` (`src/server/services/releaseCheck.ts`) polls ~14 KB of release metadata every ≥7h with `unref`ed timers and swallowed failures, and the stored release comes from a `<csv>.meta.json` sidecar so `updateAvailable` is only ever true when both tags are known. `status` answers exactly one question — _can a search return a real answer now_ — so a refresh behind a usable index stays `ready` with `refreshing: true`, and a failed refresh never disables a working index. Single-flight + atomic (`tmp` + `rename`), shared with `scripts/fetch-listfile.mjs` via `listfileFetch.ts`. `/health` and `/search` are side-effect free by construction. `ensure(waitMs)`/`fetch(waitMs)` are in **milliseconds** while the HTTP `?wait=`, the POST body and the MCP `wait` are in **seconds** — that mismatch shipped a real bug once, so each route converts explicitly. A bounded wait never cancels the shared download, and `fetch()` with no argument blocks until settled.
5. **A not-ready `atlas_search` is an error, never an empty success** (ADR-020). The dangerous outcome on a cold install is zero hits that read as "no such texture". `src/mcp/tools.ts` returns `isError` plus `searchNotReadyText(...)` for every non-`ready` status, and the text must name a real next step (`wait: 25` while indexing; `atlas_prepare_index` when absent, since autofetch is gone and retrying will not help). When adding an MCP `outputSchema`, check all three shapes against SDK 1.30.1: normal `structuredContent`, `isError` without `structuredContent`, and `isError` _with_ `structuredContent` — all three are safe, and the last one is pinned by `tests/integration/mcp.test.ts`.
6. **DOM ids are anchored** (legacy parity). Before renaming an id in `src/client/index.html`, grep the client for `q<...>("#id")` / `getElementById("id")` users. The ids (`#fdid`, `#build`, `#rows`, `#cv`, `#dList`, …) mirror the original prototype — keep them stable.
7. **Dead-simple state:** `createAppStore()` (zustand vanilla, `src/client/state/store.ts`) is the single source of truth. `grpColor(store, name)` is a **free function** (assigns palette per 2-part prefix, resets on `setResult`). `filteredMembers`/`filteredPosition` in `select.ts` are memoized on a module-level cache. Scan state (`scanOpen`, `scans`, `scanSel`) and the `exportStyle` preference live here too.
8. **Scan derives pure, renders DOM-free.** `src/shared/scan.ts` is the baseline-blocks Lua/XML parser (textures + `SetTexCoord`, flips, multi-line); `src/shared/scanView.ts` turns scans into rows (px rects, exactness vs `EXACT_EPS`, Lua text per style, nine-slice margins) with **no `document`/`window`** — it's node-testable and shared with the `POST /api/v1/scan` endpoint; `src/client/state/scanView.ts` is just a re-export shim. Only `src/client/ui/scan.ts` touches the DOM. `src/shared/islands.ts` (`findIslands`) feeds define-mode **Auto** from alpha readback.
9. **Layout is deliberate:** vitest `include` is `tests/unit`, `tests/integration`, and **`src/client/**/*.test.ts`** (client pure-logic tests run in the plain node env — they must NOT touch DOM). Vite `root` is `src/client`, so asset/source paths in `index.html` are relative (`./main.ts`) and `outDir` is `../../dist/client`. Server tsc outputs to `dist/server/` with `rootDir: src`, so the compiled entry is `dist/server/server/index.js` (the `npm start` launcher and `start.mjs` already account for this).

## Gotchas (learned the hard way)

- **`import.meta.dirname` depth depends on build vs source.** `dist/server/server/config.js` sits two levels deeper than `src/server/config.ts`; never compute project-root paths with a fixed `../..`. `config.ts` walks up to the nearest `package.json` (`findRoot`). If you ever move the server output layout, re-check that.
- **`@fastify/static` fails silently.** If `dist/client/` doesn't exist or its root is wrong, front-end routes just 404 with no log. Check `dirs.dist` in config before debugging routes.
- **`Math.round(12.5)` is `13`** in JS — display-size fallbacks round "half rect up". Don't "fix" it; tests assert it.
- Register the **error handler before routes** in `app.ts` (fastify binds the first `setErrorHandler`); Problem+JSON responses depend on it.
- `LOG_PRETTY` off (`0`) or `LOG_LEVEL` such as error → clean JSON logs (integration tests rely on machine-readable output).
- **Never collapse a decode failure into "unsupported format".** The `/blp/*` routes take the **raw BLP as the request body**, so a `curl -F` multipart upload reaches the decoder as a form envelope (`----…`) and fails — an unconditional `catch {}` around `decodeToPng` used to report that as `BLP format not supported`, and an agent duly reported a nonexistent "BLP2 is not supported" bug for a BLP2 that decodes fine. `describeDecodeFailure` in `decodeService.ts` now splits the two: wrong magic → "Body is not a BLP file" naming the offending bytes; valid magic → "BLP decode failed for a valid BLP2 header". **When you catch an error, keep the cause** — a vague message about the most common failure (garbage in) is worse than no message, because it sends people hunting a feature gap that does not exist. Same rule on the MCP side: `resolveBlpBytes` (`src/mcp/blpInput.ts`) accepts a **path or base64** and says exactly which one was wrong.
- **A `.` proves the argument is not base64** (the base64 alphabet has no dot), which is how `resolveBlpBytes` tells `Atlas.blp` from `QkxQMgEA`. Prefix checks alone miss bare filenames — a unit test caught that.

## Working conventions

- **Commits:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`). **Never commit unless the user explicitly asked.**
- **Never add AI attribution** or Co-Authored-By.
- **Comments in code:** none unless they earn their place; public/contextual comments in English.
- **New endpoints:** schemas first, then handler, then order/route tests in `tests/integration`, keep parity for any legacy behavior you touch.
- **Mirror the repo style** (persona/voice only applies to chat, never to code/UI/docs).

## Definitions of done

- `npm run typecheck` clean, `npm test` green, `npm run build` produces `dist/`.
- For API changes: schema updated + validated, integration test added.
- For client changes: DOM ids unchanged (or migrated with grep), pure logic covered by a `src/client/**/*.test.ts` node test, no `document`/`window` in tested modules.
