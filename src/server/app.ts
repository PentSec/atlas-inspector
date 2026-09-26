/**
 * Application assembly — Fastify wiring, S1-safe static serving.
 */
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import Fastify from "fastify";
import type { FastifyError, FastifyInstance, RawServerDefault } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
    jsonSchemaTransform,
    serializerCompiler,
    validatorCompiler,
} from "fastify-type-provider-zod";

import { WagoSource } from "./adapters/wagoSource.js";
import type { WowFileSource } from "./adapters/wowSource.js";
import { Pinta365BlpDecoder } from "./adapters/pinta365Blp.js";
import type { Config } from "./config.js";
import { AppError, problemFromUnknown } from "./errors.js";
import { FileCache } from "./lib/cache.js";
import { createLogger, type Logger } from "./logger.js";
import { legacyRoutes } from "./routes/legacy.js";
import { v1Routes } from "./routes/v1.js";
import { DecodeService } from "./services/decodeService.js";
import { fetchListfile } from "./services/listfileFetch.js";
import { startReleaseCheck, type ReleaseCheckHandle } from "./services/releaseCheck.js";
import { ListfileIndex } from "./services/search.js";
import { Repo } from "./services/repo.js";
import { version } from "./version.js";
import type { SearchCapability } from "../shared/schemas.js";

export interface AppServices {
    logger: Logger;
    source: WowFileSource;
    repo: Repo;
    decode: DecodeService;
    renderCache: FileCache;
    decodeCache: FileCache;
    dbCache: FileCache;
    /** override the listfile index (tests inject a fixture-backed one) */
    listfile?: ListfileIndex;
}

/** The app instance once a pino logger is wired in (Fastify's 4th generic). */
export type AppInstance = FastifyInstance<
    RawServerDefault,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    Logger
>;

/** The listfile index is reachable from the instance so the process entry
 * point can report its state and start the freshness check — see
 * `reportListfileState` and `startListfileReleaseCheck`. */
export interface AppInstanceListfile {
    listfile: ListfileIndex;
}
declare module "fastify" {
    interface FastifyInstance {
        listfile: ListfileIndex;
    }
}

/** Build a fully-wired Fastify instance (no listen). */
export async function buildApp(
    config: Config,
    logger: Logger = createLogger(config.log.level, config.log.pretty),
    overrides: Partial<AppServices> = {},
): Promise<AppInstance> {
    // tiers named after legacy folder layout (db / render / decode)
    const dbCache =
        overrides.dbCache ??
        new FileCache({
            dir: config.dirs.db,
            ttlMs: config.cache.dbTtlMs,
            memoryByteLimit: 8 * 1024 * 1024,
            logger,
        });
    const renderCache =
        overrides.renderCache ??
        new FileCache({
            dir: config.dirs.render,
            ttlMs: config.cache.renderTtlMs,
            memoryByteLimit: 32 * 1024 * 1024,
            logger,
        });
    const decodeCache =
        overrides.decodeCache ??
        new FileCache({
            dir: config.dirs.decode,
            ttlMs: config.cache.diskTtlMs,
            memoryByteLimit: 64 * 1024 * 1024,
            logger,
        });

    const source =
        overrides.source ??
        new WagoSource({
            baseUrl: config.upstream.baseUrl,
            userAgent: config.upstream.userAgent,
            logger,
            timeoutMs: config.upstream.timeoutMs,
            maxRetries: config.upstream.maxRetries,
            minIntervalMs: config.upstream.minIntervalMs,
        });
    const repo = overrides.repo ?? new Repo({ source, config, logger, dbCache });
    const decode =
        overrides.decode ??
        new DecodeService({
            decoder: new Pinta365BlpDecoder(),
            decodeCache,
            maxBytes: config.decode.maxBytes,
        });
    const search =
        overrides.listfile ??
        new ListfileIndex({
            csvPath: config.listfilePath,
            // Reached only from POST /api/v1/listfile/fetch, which the MCP layer
            // calls after the user has explicitly authorized the download.
            fetch: async (target) => {
                logger.info(
                    { target, url: config.listfile.url },
                    "listfile download starting (user-authorized, ~146 MB)",
                );
                const result = await fetchListfile({
                    target,
                    url: config.listfile.url,
                    releaseApiUrl: config.listfile.releaseApi,
                    userAgent: config.upstream.userAgent,
                });
                logger.info(
                    { target, bytes: result.bytes, release: result.release },
                    "listfile downloaded",
                );
                return result;
            },
        });

    const app = Fastify({
        loggerInstance: logger,
        bodyLimit: config.decode.maxBytes,
        trustProxy: true,
    });

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("listfile", search);

    // Error handler MUST be installed before routes are registered: fastify binds
    // the current handler into each route's context at registration time.
    app.setErrorHandler((error: FastifyError | AppError, req, reply) => {
        const instance = `${req.method} ${req.url}`;
        const legacy = req.url.startsWith("/api/") && !req.url.startsWith("/api/v1/");

        if (legacy) {
            reply.code(legacyStatus(error)).send({ error: legacyDetail(error) });
            return;
        }

        const problem = problemFromUnknown(error, instance);
        if (problem.status === 500) {
            app.log.error({ err: error, instance }, "unhandled error");
        }
        reply.code(problem.status).type("application/problem+json").send(problem);
    });

    await app.register(cors, { origin: true });
    await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
    await app.register(fastifySwagger, {
        openapi: { info: { title: "Atlas Inspector", version }, paths: {} },
        transform: jsonSchemaTransform,
    });
    await app.register(fastifySwaggerUi, { routePrefix: "/documentation" });

    // Raw-binary request bodies for both decode endpoints (any content type).
    app.addContentTypeParser(
        /^.*$/,
        { parseAs: "buffer", bodyLimit: config.decode.maxBytes },
        (_req, body, done) => done(null, body),
    );

    await app.register(v1Routes, {
        prefix: "/api/v1",
        repo,
        decode,
        search,
        listfileWaitMaxMs: config.listfile.waitMaxMs,
        version,
    });
    await app.register(legacyRoutes, { prefix: "/api", repo, decode, renderCache, decodeCache });

    await registerStatic(app, config);

    return app;
}

/**
 * Start the periodic listfile freshness check without blocking the caller.
 *
 * Deliberately NOT called by `buildApp`: assembly must stay free of surprises
 * (an integration test would start a background timer and a network call), so
 * the process entry point opts in. Two properties matter here:
 *
 *  - it never downloads the listfile — it only reads ~14 KB of release
 *    metadata, so "the app told me there is an update" can never turn into
 *    "the app spent 146 MB without asking";
 *  - every timer is unref()ed, so a 7-hour interval can never hold the process
 *    open at shutdown.
 */
export function startListfileReleaseCheck(
    app: AppInstance,
    config: Config,
    logger: Logger,
): ReleaseCheckHandle {
    return startReleaseCheck({
        index: app.listfile,
        apiUrl: config.listfile.releaseApi,
        intervalMs: config.listfile.checkIntervalMs,
        log: logger,
    });
}

/** One-shot: is the index on disk, and is a newer release published? */
export async function reportListfileState(
    app: AppInstance,
    logger: Logger,
): Promise<SearchCapability> {
    const capability = await app.listfile.ensure();
    if (capability.status === "ready") {
        logger.info(
            { entries: capability.entries, release: capability.release },
            "listfile index ready",
        );
    } else {
        logger.warn(
            { status: capability.status, capability },
            "listfile index unavailable — atlas_search cannot resolve names",
        );
    }
    return capability;
}

/** Legacy surfaces speak `{ error }` with the old status codes (413 -> 400). */
function legacyStatus(error: FastifyError | AppError): number {
    if (error instanceof AppError) return error.status === 413 ? 400 : error.status;
    if (error.statusCode && error.statusCode >= 400 && error.statusCode <= 599) {
        return error.statusCode === 413 ? 400 : error.statusCode;
    }
    return 500;
}

function legacyDetail(error: FastifyError | AppError): string {
    if (error instanceof AppError) return error.message;
    if (error.validation?.length) return String(error.validation[0]);
    if (error.statusCode && error.statusCode >= 400 && error.statusCode <= 599) {
        return error.message;
    }
    return "internal error";
}

async function registerStatic(app: AppInstance, config: Config): Promise<void> {
    const dist = config.dirs.dist;
    try {
        await access(dist, constants.F_OK);
    } catch {
        // No build yet: no static serving at all (front-end routes 404 until the Vite build exists).
        return;
    }

    await app.register(fastifyStatic, {
        root: dist,
        prefix: "/",
        index: ["index.html"],
        cacheControl: true,
        maxAge: "1h",
        immutable: false,
    });
}

/** Ensure the cache dir layout + its README (legacy UX: safe to delete by hand). */
export async function ensureCacheLayout(config: Config, logger: Logger): Promise<void> {
    const dirs = [config.dirs.cache, config.dirs.render, config.dirs.decode, config.dirs.db];
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    await writeFile(
        path.join(config.dirs.cache, "README.txt"),
        "Atlas Inspector cache — safe to delete any folder; it regenerates on demand.\n" +
            "  render/  decoded preview PNGs (one per FileDataID x build)\n" +
            "  decode/  PNGs decoded from BLPs you dropped (named by content hash)\n" +
            "  db/      wago.tools lookups (build list, DB2 CSVs, file info)\n",
    ).catch((err) => logger.warn({ err }, "cache README write failed"));
}
