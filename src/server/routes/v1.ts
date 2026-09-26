/**
 * /api/v1 — the normative, agent-friendly API (RFC 7807 errors, ADR-013).
 * Request/response contracts are zod schemas shared with the client and docs.
 */
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import {
    AtlasOkSchema,
    AtlasRegionsResponseSchema,
    BlpAlphaResponseSchema,
    BlpDecodeResultSchema,
    BlpIslandsResponseSchema,
    BlpTcRequestSchema,
    BlpTcResponseSchema,
    BuildsResponseSchema,
    FileInfoSchema,
    HealthSchema,
    ListfileFetchRequestSchema,
    ProblemSchema,
    ScanRequestSchema,
    ScanResultSchema,
    SEARCH_WAIT_MAX_SECONDS,
    SearchCapabilitySchema,
    SearchResultSchema,
    TextureResultSchema,
} from "../../shared/schemas.js";
import { scanCode } from "../../shared/scan.js";
import { scanExact, scanRows } from "../../shared/scanView.js";
import { normalizedRect } from "../../shared/coords.js";
import { displaySizeFallback, luaExport } from "../../shared/lua.js";
import { findIslands } from "../../shared/islands.js";
import { alphaMargins, alphaToBinary } from "../../shared/blpAlpha.js";
import { BlpTcRangeError, convertBlpTc } from "../../shared/blpTc.js";
import { BadRequestError, NotFoundError, UnprocessableError } from "../errors.js";
import type { DecodeService } from "../services/decodeService.js";
import type { ListfileIndex } from "../services/search.js";
import type { Repo } from "../services/repo.js";

const VersionParamsSchema = z.object({ fdid: z.coerce.number().int().positive() });
const AtlasQuerySchema = z.object({ build: z.string().optional() });
const BlpQuerySchema = z.object({ version: z.string().optional() });
const BlpIslandsQuerySchema = z.object({
    gap: z.coerce
        .number()
        .int()
        .min(0)
        .max(32)
        .default(1)
        .describe("Merge gap in pixels between runs (default 1)."),
    minpx: z.coerce
        .number()
        .int()
        .min(1)
        .default(16)
        .describe("Minimum opaque pixels for a component to be reported (default 16)."),
});
const SearchQuerySchema = z.object({
    q: z.string().min(1),
    limit: z.coerce.number().int().max(500).optional(),
    wait: z.coerce
        .number()
        .int()
        .nonnegative()
        .max(SEARCH_WAIT_MAX_SECONDS)
        .optional()
        .describe(
            "Seconds to wait for a first-run listfile index build to finish (default 0 = do not block).",
        ),
});

const AtlasOkOrTextureSchema = z.discriminatedUnion("kind", [AtlasOkSchema, TextureResultSchema]);

export interface V1RouteOptions {
    repo: Repo;
    decode: DecodeService;
    search: ListfileIndex;
    /** upper bound for the `wait` query param (LISTFILE_WAIT_MAX_MS) */
    listfileWaitMaxMs: number;
    version: string;
}

export const v1Routes: FastifyPluginAsyncZod<V1RouteOptions> = async (fastify, opts) => {
    const { repo, decode, search, listfileWaitMaxMs, version } = opts;

    fastify.get("/health", { schema: { response: { 200: HealthSchema } } }, async () => ({
        status: "ok" as const,
        service: "atlas-inspector",
        version,
        capabilities: { search: search.capability },
    }));

    fastify.get("/builds", { schema: { response: { 200: BuildsResponseSchema } } }, async () => ({
        builds: await repo.getBuilds(),
    }));

    fastify.get(
        "/files/:fdid",
        {
            schema: {
                params: VersionParamsSchema,
                response: { 200: FileInfoSchema, 404: ProblemSchema },
            },
        },
        async (req) => {
            const info = await repo.fileInfo(req.params.fdid);
            if (!info)
                throw new NotFoundError(`FileDataID ${req.params.fdid} not found on wago.tools`);
            return info;
        },
    );

    fastify.get(
        "/files/:fdid/blp",
        { schema: { params: VersionParamsSchema, querystring: BlpQuerySchema } },
        async (req, reply) => {
            const { fdid } = req.params;
            let versionParam = req.query.version?.trim() || null;
            if (!versionParam) {
                const info = await repo.fileInfo(fdid);
                versionParam = info ? repo.newestVersion(info) : null;
            }
            const url = repo.url(
                `/api/casc/${fdid}${versionParam ? `?version=${encodeURIComponent(versionParam)}` : ""}`,
            );
            const data = await repo.source.getFile(url);
            if (!data || data.length === 0) {
                throw new Error("Download failed"); // mapped to 502 by the error handler
            }
            reply
                .type("application/octet-stream")
                .header("Content-Disposition", `attachment; filename="${fdid}.blp"`)
                .send(data);
        },
    );

    fastify.post(
        "/blp/decode",
        {
            schema: {
                response: {
                    200: BlpDecodeResultSchema,
                    400: ProblemSchema,
                    413: ProblemSchema,
                    422: ProblemSchema,
                },
            },
        },
        async (req) => {
            const body = req.body;
            if (!Buffer.isBuffer(body)) throw new UnprocessableError("body must be raw BLP bytes");
            return decode.decode(body);
        },
    );

    fastify.post(
        "/blp/islands",
        {
            schema: {
                querystring: BlpIslandsQuerySchema,
                response: {
                    200: BlpIslandsResponseSchema,
                    400: ProblemSchema,
                    413: ProblemSchema,
                    422: ProblemSchema,
                },
            },
        },
        async (req) => {
            const raw = decode.assertRawBlp(req.body);
            const { width, height, alpha } = await decode.alphaChannel(raw);
            const islands = findIslands(
                alphaToBinary(alpha, 128),
                width,
                height,
                req.query.gap,
                req.query.minpx,
            );
            return BlpIslandsResponseSchema.parse({ width, height, islands });
        },
    );

    fastify.post(
        "/blp/alpha",
        {
            schema: {
                response: {
                    200: BlpAlphaResponseSchema,
                    400: ProblemSchema,
                    413: ProblemSchema,
                    422: ProblemSchema,
                },
            },
        },
        async (req) => {
            const raw = decode.assertRawBlp(req.body);
            const { width, height, alpha } = await decode.alphaChannel(raw);
            const margins = alphaMargins(alpha, width, height, 1);
            return BlpAlphaResponseSchema.parse({ width, height, ...margins });
        },
    );

    fastify.post(
        "/blp/tc",
        {
            schema: {
                response: {
                    200: BlpTcResponseSchema,
                    400: ProblemSchema,
                    422: ProblemSchema,
                },
            },
        },
        async (req) => {
            const body = req.body;
            let parsed: unknown = body;
            if (Buffer.isBuffer(body)) {
                try {
                    parsed = JSON.parse(body.toString("utf8"));
                } catch {
                    throw new UnprocessableError("invalid JSON body");
                }
            }
            const input = BlpTcRequestSchema.safeParse(parsed);
            if (!input.success) {
                const issue = input.error.issues[0];
                const message = issue
                    ? issue.message === "Provide exactly one of px or tc."
                        ? issue.message
                        : `invalid request: ${issue.path.join(".") || "body"} ${issue.message}`
                    : "invalid request";
                throw new BadRequestError(message);
            }
            try {
                return BlpTcResponseSchema.parse(convertBlpTc(input.data));
            } catch (err) {
                if (err instanceof BlpTcRangeError) throw new UnprocessableError(err.message);
                throw err;
            }
        },
    );

    fastify.get(
        "/atlas/:fdid",
        {
            schema: {
                params: VersionParamsSchema,
                querystring: AtlasQuerySchema,
                response: { 200: AtlasOkOrTextureSchema, 404: ProblemSchema },
            },
        },
        async (req) => {
            const { fdid } = req.params;
            const raw = req.query.build?.trim() || null;
            const explicitBuild = raw && raw !== "default" ? raw : null;
            const result = await repo.resolve(fdid, explicitBuild);
            if (result.kind === "missing") {
                throw new NotFoundError(`FileDataID ${fdid}: ${result.error}`);
            }
            return result;
        },
    );

    fastify.get(
        "/atlas/:fdid/regions",
        {
            schema: {
                params: VersionParamsSchema,
                querystring: AtlasQuerySchema,
                response: { 200: AtlasRegionsResponseSchema, 404: ProblemSchema },
            },
        },
        async (req) => {
            const { fdid } = req.params;
            const raw = req.query.build?.trim() || null;
            const explicitBuild = raw && raw !== "default" ? raw : null;
            const result = await repo.resolve(fdid, explicitBuild);
            if (result.kind !== "atlas") {
                throw new UnprocessableError(
                    result.kind === "texture"
                        ? `FileDataID ${fdid} is not an atlas: ${result.error}`
                        : `FileDataID ${fdid} not found`,
                );
            }
            return {
                build: result.build,
                width: result.atlas.width,
                height: result.atlas.height,
                regions: result.members
                    .map((m) => {
                        const rect = normalizedRect(m, result.atlas.width, result.atlas.height);
                        return rect ? { name: m.name, ...rect } : null;
                    })
                    .filter((r): r is NonNullable<typeof r> => r !== null),
            };
        },
    );

    fastify.get(
        "/atlas/:fdid/export",
        { schema: { params: VersionParamsSchema, querystring: AtlasQuerySchema } },
        async (req, reply) => {
            const { fdid } = req.params;
            const raw = req.query.build?.trim() || null;
            const explicitBuild = raw && raw !== "default" ? raw : null;
            const result = await repo.resolve(fdid, explicitBuild);
            if (result.kind !== "atlas") {
                throw new UnprocessableError(
                    result.kind === "texture"
                        ? `FileDataID ${fdid} is not an atlas: ${result.error}`
                        : `FileDataID ${fdid} not found`,
                );
            }
            const text = luaExport(
                result.members.map((m) => ({
                    name: m.name,
                    left: m.left,
                    right: m.right,
                    top: m.top,
                    bottom: m.bottom,
                    ...displaySizeFallback(m),
                    sheetW: result.atlas.width,
                    sheetH: result.atlas.height,
                })),
            );
            reply
                .type("text/plain; charset=utf-8")
                .header("Content-Disposition", `attachment; filename="atlas_${fdid}.lua"`)
                .send(text);
        },
    );

    fastify.get(
        "/search",
        { schema: { querystring: SearchQuerySchema, response: { 200: SearchResultSchema } } },
        async (req) => {
            // `wait` is SECONDS on the wire, milliseconds inside ListfileIndex.ensure().
            // The schema already caps it at 25s; LISTFILE_WAIT_MAX_MS can lower that.
            const waitSeconds = Math.min(req.query.wait ?? 0, listfileWaitMaxMs / 1000);
            const capability = await search.ensure(waitSeconds * 1000);

            if (capability.status !== "ready") {
                // 200, not 503: "not built yet" is a state, not a transport failure.
                // The old 503 forced callers into a human-only recovery path, which an
                // MCP agent could not execute. `hits: []` with an explicit `status` and
                // an actionable `detail` is machine-readable and honest.
                return { status: capability.status, hits: [], detail: capability.detail };
            }

            return {
                status: "ready" as const,
                hits: search.search(req.query.q, req.query.limit ?? 50),
            };
        },
    );

    // The ONLY route that can put listfile bytes on disk. Consent is enforced one
    // layer up (the MCP tool asks the user before calling this), so this handler
    // stays a plain, idempotent trigger: no body means "wait for whatever is in
    // flight", `wait` bounds how long *this caller* blocks. It cannot cancel a
    // download another caller started.
    fastify.post(
        "/listfile/fetch",
        {
            schema: {
                body: ListfileFetchRequestSchema,
                response: { 200: SearchCapabilitySchema, 400: ProblemSchema },
            },
        },
        async (req) => {
            const waitSeconds = Math.min(req.body?.wait ?? 0, listfileWaitMaxMs / 1000);
            // Seconds on the wire, milliseconds inside ListfileIndex.fetch().
            await search.fetch(waitSeconds * 1000);
            return search.capability;
        },
    );

    // application/json arrives pre-parsed (Fastify's default JSON parser wins
    // over the app-level buffer parser for that exact content type); other
    // content types arrive as raw buffers — handle both and validate manually.
    fastify.post(
        "/scan",
        {
            schema: {
                response: {
                    200: ScanResultSchema,
                    400: ProblemSchema,
                    422: ProblemSchema,
                    413: ProblemSchema,
                },
            },
        },
        async (req) => {
            const body = req.body;
            let parsed: unknown = body;
            if (Buffer.isBuffer(body)) {
                try {
                    parsed = JSON.parse(body.toString("utf8"));
                } catch {
                    throw new UnprocessableError("invalid JSON body");
                }
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new UnprocessableError("body must be a JSON object");
            }
            const input = ScanRequestSchema.safeParse(parsed);
            if (!input.success) {
                const issue = input.error.issues[0];
                throw new UnprocessableError(
                    issue
                        ? `invalid scan request: ${issue.path.join(".") || "body"} ${issue.message}`
                        : "invalid scan request",
                );
            }
            const { code, sheet } = input.data;
            const members = sheet?.members ?? [];
            const rows = scanRows(scanCode(code), sheet?.width ?? 0, sheet?.height ?? 0, members);
            return {
                entries: rows.map((r) => {
                    const idx = r.matched;
                    return {
                        key: r.src.key,
                        source: r.src.source,
                        line: r.src.line,
                        texture: r.src.texture,
                        u0: r.src.u0,
                        u1: r.src.u1,
                        v0: r.src.v0,
                        v1: r.src.v1,
                        flipX: r.flipX,
                        flipY: r.flipY,
                        px: r.px,
                        dw: r.dw,
                        dh: r.dh,
                        err: r.err,
                        exact: scanExact(r),
                        matched: idx,
                        matchedName: idx >= 0 ? (members[idx] ? members[idx]!.name : null) : null,
                        stc: r.stcLine,
                        margin: r.marginLabel,
                    };
                }),
            };
        },
    );
};
