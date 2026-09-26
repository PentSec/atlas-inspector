/**
 * Legacy /api/* aliases — byte-for-byte parity with the old server.js responses
 * and status codes so the pre-Fase-3 client keeps working untouched.
 * These go away once the client is migrated; the /api/v1 surface replaces them.
 */
import type { FastifyPluginAsync } from "fastify";
import { BadRequestError, PayloadTooLargeError, UnprocessableError } from "../errors.js";
import type { DecodeService } from "../services/decodeService.js";
import type { Repo } from "../services/repo.js";
import type { FileCache } from "../lib/cache.js";

export interface LegacyRouteOptions {
    repo: Repo;
    decode: DecodeService;
    renderCache: FileCache;
    decodeCache: FileCache;
}

const FDID_RE = /^\d+$/;

export const legacyRoutes: FastifyPluginAsync<LegacyRouteOptions> = async (fastify, opts) => {
    const { repo, decode, renderCache, decodeCache } = opts;

    fastify.get("/atlas", async (req, reply) => {
        const raw = String((req.query as { fdid?: string }).fdid ?? "").trim();
        const build = String((req.query as { build?: string }).build ?? "").trim() || null;
        if (!FDID_RE.test(raw)) {
            return reply.code(400).send({ error: "FileDataID must be a number" });
        }
        const result = await repo.resolve(Number(raw), build && build !== "default" ? build : null);
        if (!result) {
            return reply
                .code(404)
                .send({ kind: "missing", filedata: Number(raw), error: "Could not resolve FDID" });
        }
        const status = result.kind === "atlas" || result.kind === "texture" ? 200 : 404;
        return reply.code(status).send(result);
    });

    fastify.get("/info", async (req, reply) => {
        const fdid = String((req.query as { fdid?: string }).fdid ?? "").trim();
        if (!FDID_RE.test(fdid)) {
            return reply.code(400).send({ error: "FileDataID must be a number" });
        }
        const info = await repo.fileInfo(Number(fdid));
        if (!info) return reply.code(404).send({ error: "File not found" });
        return reply.send(info);
    });

    fastify.get("/file", async (req, reply) => {
        const fdid = String((req.query as { fdid?: string }).fdid ?? "").trim();
        let version = String((req.query as { version?: string }).version ?? "").trim();
        if (!FDID_RE.test(fdid)) {
            return reply.code(400).send({ error: "FileDataID must be a number" });
        }
        if (!version) {
            const info = await repo.fileInfo(Number(fdid));
            version = info ? (repo.newestVersion(info) ?? "") : "";
        }
        const url = repo.url(
            `/api/casc/${fdid}${version ? `?version=${encodeURIComponent(version)}` : ""}`,
        );
        const data = await repo.source.getFile(url);
        if (!data || data.length === 0) {
            return reply.code(502).send({ error: "Download failed" });
        }
        reply
            .header("Content-Type", "application/octet-stream")
            .header("Content-Disposition", `attachment; filename="${fdid}.blp"`)
            .send(data);
    });

    fastify.get("/builds", async () => ({ builds: await repo.getBuilds() }));

    fastify.get("/render", async (req, reply) => {
        const fdid = String((req.query as { fdid?: string }).fdid ?? "").trim();
        const version = String((req.query as { version?: string }).version ?? "").trim();
        if (!FDID_RE.test(fdid)) {
            return reply.code(400).send({ error: "FileDataID must be a number" });
        }
        const key = version || "default";
        const entry = `render_${fdid}_${key.replace(/\./g, "_")}.png`;

        let data = await renderCache.getFromDisk(entry);
        if (!data) {
            const url = repo.url(
                `/api/casc/${fdid}${version ? `?version=${encodeURIComponent(version)}` : ""}`,
            );
            const raw = await repo.source.getFile(url);
            if (!raw || raw.length === 0) {
                return reply.code(502).send({ error: "file download failed" });
            }
            let dec;
            try {
                dec = await decode.decode(raw);
            } catch (err) {
                if (err instanceof UnprocessableError) {
                    return reply.code(422).send({
                        kind: "render",
                        error: "BLP format not supported for preview — drop a PNG of the sheet instead",
                    });
                }
                throw err;
            }
            data = await decodeCache.getFromDisk(dec.pngUrl.replace(/^\/api\/cache\//, ""));
            if (!data) return reply.code(502).send({ error: "file download failed" });
            await renderCache.setFromBuffer(entry, data);
        }
        reply
            .header("Content-Type", "image/png")
            .header("Cache-Control", "public, max-age=86400")
            .send(data);
    });

    fastify.get("/cache/:name", async (req, reply) => {
        const name = String((req.params as { name?: string }).name ?? "");
        // Legacy handleCache: basename, `decode_` prefix, `.png` suffix, must exist.
        if (!/^decode_[a-f0-9]+\.png$/.test(name)) {
            return reply.code(404).send({ error: "not cached" });
        }
        const data = await decodeCache.getFromDisk(name);
        if (!data) return reply.code(404).send({ error: "not cached" });
        reply
            .header("Content-Type", "image/png")
            .header("Cache-Control", "public, max-age=86400")
            .send(data);
    });

    fastify.post("/decode", async (req, reply) => {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
            return reply.code(400).send({ error: "bad body size" });
        }
        try {
            const result = await decode.decode(body);
            return reply.send({
                kind: "ok",
                w: result.width,
                h: result.height,
                png: result.pngUrl,
            });
        } catch (err) {
            if (err instanceof BadRequestError) {
                return reply.code(400).send({ error: "bad body size" });
            }
            if (err instanceof PayloadTooLargeError) {
                return reply.code(400).send({ error: "bad body size" });
            }
            if (err instanceof UnprocessableError) {
                return reply.code(422).send({ error: "BLP format not supported" });
            }
            throw err;
        }
    });
};
