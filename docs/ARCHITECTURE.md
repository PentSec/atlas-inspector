# Atlas Inspector — Architecture

Professional refactor of the Atlas Inspector prototype (Node 22+, TypeScript strict).
Three code layers sharing one domain model, plus a pluggable BLP decoder.

## Layer diagram

```
                      ┌────────────────────────────┐
                      │         Agent (MCP)        │  (Fase 2, optional)
                      └─────────────┬──────────────┘
                                    │ HTTP  /api/v1
┌────────────────────────────────────▼───────────────────────────────┐
│  src/server  (Fastify 5, in: src/server/index.ts)                  │
│  routes/  →  services/  →  adapters/                               │
│    HTTP shapes,       pure business    WowFileSource, BlpDecoder,  │
│    zod schemas,       logic (resolution ListfileIndex, cache,      │
│    RFC 7807 errors    path, export)   upstream (wago)              │
└───────────────┬─────────────────────────────────────┬───────────────┘
                │ static dist/client (Fase 2+3)       │ @pinta365/blp
┌───────────────▼───────────────────────┐   ┌──────────▼──────────────┐
│  src/client  (Vite 8)                 │   │ adapters/blpDecoder.ts  │
│  canvas renderer, virtualized list,   │   │ (swap target for        │
│  undo/redo, API client                │   │  wow-blp-web, ADR-008)  │
└───────────────────────────────────────┘   └─────────────────────────┘
        ▲                                              │
        └────────────── src/shared ────────────────────┘
        shared domain model: types, buildVersion, coords, lua (5 export
        styles), scan (addon-code parser), islands (alpha blobs) — NO I/O
```

## Conventions (deterministic, tested)

- **Coordinates**: top-left origin, +y down, integer px. `left`/`top` INCLUSIVE,
  `right`/`bottom` EXCLUSIVE (one past the last pixel, `drawImage` semantics).
  Normalized rects use `u` = horizontal, `v` = vertical. ENFORCED BY TESTS.
- **Builds**: 4-part numeric `MAJOR.MINOR.PATCH.BUILD`; `src/shared/buildVersion.ts`.
  Range checks are half-open `[lo, hi)`.
- **Lua export**: single shared implementation with 6-decimal normalization and
  escape of both `\` and `'` (historical output fixed for the backslash case).
  Five styles (`default`, `coords`, `atlasinfo`, `sheetfirst`, `xml`) share the
  emitter; `default` stays byte-compatible with legacy output, the other styles
  emit at column 0 (no leading indent) and annotate piece size in `-- WxH px`
  (raw sub-pixel size, not the rounded display size).
- **Atlas scanner** (`src/shared/scan.ts`): pure baseline-blocks Lua/XML
  parser; positional entries require a texture path as first arg, keyed entries
  match `left=`/`coords = {…}`, 4- and 8-arg `SetTexCoord`, multi-line balance,
  flips via `flippedX/Y`. Rows derive in `src/shared/scanView.ts`
  (DOM-free, node-tested): pixel rects vs the sheet, corner error vs `EXACT_EPS`,
  Lua text per style — shared by the client scan panel (re-exported from
  `src/client/state/scanView.ts`) and the `POST /api/v1/scan` endpoint, so an
  agent probes the exact same derivation the UI uses.
- **Alpha islands** (`src/shared/islands.ts`): connected-blob labeling with
  `findIslands(binary, w, h, gap, minpx)`; the define mode feeds it from an
  offscreen-canvas alpha readback (`autoDefineRegions`).
- **API style**: JSON, errors as RFC 7807 problem+json, no stack traces on 5xx.
  OpenAPI is generated from the zod schemas.
- **Client**: Pointer Events + AbortController, virtualized rows (tab/Focus-trap
  driven, same keyboard contract as the legacy UI). No Konva — native canvas.

See ADRs for per-dependency rationale and the few explicit behavior changes.
