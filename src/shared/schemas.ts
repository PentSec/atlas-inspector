/**
 * Wire schemas for the Atlas Inspector API — the single source of truth for
 * request/response validation (server), generated OpenAPI, the client types
 * and the optional MCP agent bindings.
 *
 * Domain types are derived from these schemas (see types.ts).
 */
import { z } from "zod";

// ---------- build list ----------

export const BuildsResponseSchema = z.object({
    builds: z.array(z.string()),
});
export type BuildsResponse = z.infer<typeof BuildsResponseSchema>;

// ---------- atlas regions ----------

/**
 * A texture region in integer pixel coordinates.
 *
 * Coordinate convention (shared, tested):
 *  - origin top-left, +y down, in image pixels
 *  - `left`/`top` INCLUSIVE, `right`/`bottom` EXCLUSIVE (one past the last pixel)
 */
export const RegionSchema = z.object({
    name: z.string(),
    left: z.number().int(),
    right: z.number().int(),
    top: z.number().int(),
    bottom: z.number().int(),
    /** source size recorded in DB2 (0 when unset) */
    width: z.number().int(),
    height: z.number().int(),
    /** overridden display size in DB2 (0 when unset) */
    overrideW: z.number().int(),
    overrideH: z.number().int(),
    /** effective display size: override when present, source size otherwise */
    displayW: z.number().int(),
    displayH: z.number().int(),
    elementId: z.string(),
});
export type Region = z.infer<typeof RegionSchema>;

export const AtlasMetaSchema = z.object({
    id: z.number().int(),
    filedata: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
});
export type AtlasMeta = z.infer<typeof AtlasMetaSchema>;

export const AtlasOkSchema = z.object({
    kind: z.literal("atlas"),
    filedata: z.number().int(),
    build: z.string(),
    atlas: AtlasMetaSchema,
    members: z.array(RegionSchema),
});
export type AtlasResultOk = z.infer<typeof AtlasOkSchema>;

export const TextureResultSchema = z.object({
    kind: z.literal("texture"),
    filedata: z.number().int(),
    filename: z.string(),
    type: z.string(),
    version: z.string().nullable(),
    versions: z.array(z.string()),
    download: z.string(),
    error: z.string(),
});
export type TextureResult = z.infer<typeof TextureResultSchema>;

export const MissingResultSchema = z.object({
    kind: z.literal("missing"),
    filedata: z.number().int(),
    error: z.string(),
});
export type MissingResult = z.infer<typeof MissingResultSchema>;

export const AtlasResultSchema = z.discriminatedUnion("kind", [
    AtlasOkSchema,
    TextureResultSchema,
    MissingResultSchema,
]);
export type AtlasResult = z.infer<typeof AtlasResultSchema>;

// ---------- BLP decode ----------

export const BlpCompressionSchema = z.enum([
    "jpeg",
    "raw1",
    "raw3",
    "dxt1",
    "dxt3",
    "dxt5",
    "unknown",
]);
export type BlpCompression = z.infer<typeof BlpCompressionSchema>;

export const BlpDecodeResultSchema = z.object({
    kind: z.literal("ok"),
    width: z.number().int(),
    height: z.number().int(),
    /** human label of the BLP2 compression */
    compression: BlpCompressionSchema,
    /** raw BLP2 `compression` header byte (0=JPEG, 1=palette, 2=DXTC, 3=RAW) */
    compressionId: z.number().int(),
    alphaSize: z.number().int(),
    alphaDepth: z.number().int(),
    mipmaps: z.number().int(),
    /** hex SHA-256 of the input bytes (content address, cache key) */
    contentHash: z.string(),
    /** relative URL of the decoded PNG */
    pngUrl: z.string(),
});
export type BlpDecodeResult = z.infer<typeof BlpDecodeResultSchema>;

/** One connected opaque component on a decoded BLP sheet. */
export const BlpIslandSchema = z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    npx: z.number().int().positive(),
});
export type BlpIsland = z.infer<typeof BlpIslandSchema>;

export const BlpIslandsResponseSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    islands: z.array(BlpIslandSchema),
});
export type BlpIslandsResponse = z.infer<typeof BlpIslandsResponseSchema>;

export const BlpAlphaResponseSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    top: z.number().int().nonnegative(),
    right: z.number().int().nonnegative(),
    bottom: z.number().int().nonnegative(),
    left: z.number().int().nonnegative(),
});
export type BlpAlphaResponse = z.infer<typeof BlpAlphaResponseSchema>;

export const BlpTcRequestSchema = z
    .object({
        width: z.number().int().positive().describe("Sheet width in pixels."),
        height: z.number().int().positive().describe("Sheet height in pixels."),
        px: z
            .object({
                x: z.number().int().nonnegative(),
                y: z.number().int().nonnegative(),
                w: z.number().int().positive(),
                h: z.number().int().positive(),
            })
            .optional()
            .describe("Input as pixel rect (x, y, w, h)."),
        tc: z
            .object({
                left: z.number().describe("SetTexCoord L (0..1)."),
                right: z.number().describe("SetTexCoord R (0..1)."),
                top: z.number().describe("SetTexCoord T (0..1)."),
                bottom: z.number().describe("SetTexCoord B (0..1)."),
            })
            .optional()
            .describe("Input as normalized coords (l, r, t, b)."),
    })
    .refine((d) => (d.px !== undefined) !== (d.tc !== undefined), {
        message: "Provide exactly one of px or tc.",
    });
export type BlpTcRequest = z.infer<typeof BlpTcRequestSchema>;

export const BlpTcResponseSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    px: z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
    }),
    tc: z.object({
        left: z.number(),
        right: z.number(),
        top: z.number(),
        bottom: z.number(),
    }),
    stc: z.string(),
});
export type BlpTcResponse = z.infer<typeof BlpTcResponseSchema>;

// ---------- file info ----------

/** Shape of the wago.tools /api/info/{fdid} response (passthrough + known keys). */
export const FileInfoSchema = z.record(z.string(), z.unknown()).and(
    z.object({
        filename: z.string().optional(),
        type: z.string().optional(),
        error: z.string().optional(),
        latest: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        chashes: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
);
export type FileInfo = z.infer<typeof FileInfoSchema>;

export const SearchHitSchema = z.object({
    filedata: z.number().int(),
    name: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * One vocabulary for the listfile index lifecycle, shared by /api/v1/search
 * (`SearchResultSchema.status`) and /api/v1/health
 * (`SearchCapabilitySchema.status`) so the two can never disagree:
 *   ready     — names loaded, hits are authoritative
 *   indexing  — first-run download in flight, retry shortly
 *   absent    — no index and auto-fetch is off or the download failed
 *   error     — a download was attempted and failed; `detail` says why
 */
export const SearchStatusSchema = z.enum(["ready", "indexing", "absent", "error"]);
export type SearchStatus = z.infer<typeof SearchStatusSchema>;

/**
 * Hard ceiling for the `?wait=` query parameter, in SECONDS, shared by the
 * HTTP route, the MCP tool schema and the MCP client's own request timeout.
 *
 * It lives here because this number is enforced in three processes that do not
 * import each other. Duplicating it is what let a seconds/milliseconds mix-up
 * ship once already; a single constant is the only thing that keeps the server
 * bound, the advertised advice and the client timeout from drifting apart.
 */
export const SEARCH_WAIT_MAX_SECONDS = 25;

export const SearchResultSchema = z.object({
    status: SearchStatusSchema,
    hits: z.array(SearchHitSchema),
    /** actionable next step; present unless status is "ready" */
    detail: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---------- normalized regions ----------

export const NormalizedRegionSchema = z.object({
    name: z.string(),
    u0: z.number(),
    u1: z.number(),
    v0: z.number(),
    v1: z.number(),
});
export type NormalizedRegion = z.infer<typeof NormalizedRegionSchema>;

export const AtlasRegionsResponseSchema = z.object({
    build: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    regions: z.array(NormalizedRegionSchema),
});
export type AtlasRegionsResponse = z.infer<typeof AtlasRegionsResponseSchema>;

// ---------- addon-code scan ----------

export const PixelRectSchema = z.object({
    left: z.number(),
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
});
export type PixelRect = z.infer<typeof PixelRectSchema>;

/** Member rects used to match scanned entries against an atlas sheet. */
export const ScanMemberRectSchema = z.object({
    name: z.string(),
    left: z.number().int(),
    top: z.number().int(),
    right: z.number().int(),
    bottom: z.number().int(),
});
export type ScanMemberRect = z.infer<typeof ScanMemberRectSchema>;

/** Optional sheet context to normalize scanned entries against. */
export const ScanSheetSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    members: z.array(ScanMemberRectSchema).optional(),
});
export type ScanSheet = z.infer<typeof ScanSheetSchema>;

/** POST /api/v1/scan body: addon code + optional sheet for normalization. */
export const ScanRequestSchema = z.object({
    code: z.string().min(1),
    sheet: ScanSheetSchema.optional(),
});
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export const ScanEntrySchema = z.object({
    key: z.string(),
    source: z.enum(["table", "stc", "xml"]),
    line: z.number().int(),
    texture: z.string().nullable(),
    u0: z.number(),
    u1: z.number(),
    v0: z.number(),
    v1: z.number(),
    flipX: z.boolean(),
    flipY: z.boolean(),
    px: PixelRectSchema.nullable(),
    dw: z.number(),
    dh: z.number(),
    err: z.number().nullable(),
    exact: z.boolean(),
    matched: z.number().int(),
    matchedName: z.string().nullable(),
    stc: z.string(),
    margin: z.string().nullable(),
});
export type ScanEntry = z.infer<typeof ScanEntrySchema>;

export const ScanResultSchema = z.object({
    entries: z.array(ScanEntrySchema),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

// ---------- health / errors ----------

/**
 * Liveness and readiness are different questions and this payload answers
 * both without conflating them:
 *   status      — process liveness only. A search that cannot load names does
 *                 NOT make the process unhealthy, so it stays "ok".
 *   capabilities— readiness, per feature. `status: "ok"` alone must never be
 *                 read as "every tool works" (it used to be, and it lied).
 */
export const SearchCapabilitySchema = z.object({
    status: SearchStatusSchema,
    /** names currently indexed (0 unless status is "ready") */
    entries: z.number().int().nonnegative(),
    /** actionable next step; present unless status is "ready" */
    detail: z.string().optional(),
    /** release tag of the CSV on disk, e.g. "202609242243"; absent if unknown */
    release: z.string().optional(),
    /** ISO date the CSV was downloaded, from the provenance sidecar */
    fetchedAt: z.string().optional(),
    /** newest release seen by the periodic check; absent if never checked */
    latestRelease: z.string().optional(),
    /** true when latestRelease is known and differs from the stored release */
    updateAvailable: z.boolean().optional(),
    /** ISO timestamp of the last freshness check */
    checkedAt: z.string().optional(),
    /** true while a consent-gated download runs behind an already-usable index */
    refreshing: z.boolean().optional(),
});
export type SearchCapability = z.infer<typeof SearchCapabilitySchema>;

/** Body of POST /api/v1/listfile/fetch — the only way a download ever starts. */
export const ListfileFetchRequestSchema = z.object({
    /** seconds the caller is willing to block on the download */
    wait: z.coerce.number().int().nonnegative().max(SEARCH_WAIT_MAX_SECONDS).optional(),
});
export type ListfileFetchRequest = z.infer<typeof ListfileFetchRequestSchema>;

export const HealthSchema = z.object({
    status: z.literal("ok"),
    service: z.string(),
    version: z.string(),
    capabilities: z.object({
        search: SearchCapabilitySchema,
    }),
});
export type Health = z.infer<typeof HealthSchema>;

/** RFC 7807 problem+json error body. */
export const ProblemSchema = z.object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
