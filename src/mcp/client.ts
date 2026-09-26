/**
 * Thin HTTP client for the Atlas Inspector /api/v1 surface used by the MCP
 * server. Every response is validated against the shared zod schemas (AGENTS
 * rule 1), so agent bindings can never drift from the wire contract.
 */
import type { z } from "zod";
import {
    AtlasRegionsResponseSchema,
    AtlasResultSchema,
    BuildsResponseSchema,
    FileInfoSchema,
    HealthSchema,
    ProblemSchema,
    ScanResultSchema,
    SEARCH_WAIT_MAX_SECONDS,
    SearchCapabilitySchema,
    SearchResultSchema,
} from "../shared/schemas.js";
import type { ScanRequestSchema } from "../shared/schemas.js";

const REQUEST_TIMEOUT_MS = 15_000;

/** Headroom over the server's own `?wait=` bound so its answer always arrives. */
const WAIT_HEADROOM_MS = 5_000;

/**
 * Per-request timeout, derived from the `wait` the caller asked for.
 *
 * The server caps `?wait=` at SEARCH_WAIT_MAX_SECONDS and always answers inside
 * that bound, so giving the client exactly that much plus headroom guarantees
 * the caller receives the server's clear "still indexing" payload instead of an
 * opaque AbortError. A fixed 15s timeout used to be shorter than a real first-run
 * ~150 MB download, which made the advertised `wait: 25` advice impossible to
 * honour on a cold install.
 *
 * Calls that do not ask to wait keep the fast-fail baseline, so a hung upstream
 * on atlas_get or atlas_scan still surfaces in 15s.
 */
export function requestTimeoutMs(waitSeconds?: number, baseMs = REQUEST_TIMEOUT_MS): number {
    // `wait: 0` is an explicit "do not block", so it must not buy headroom.
    if (waitSeconds === undefined || !Number.isFinite(waitSeconds) || waitSeconds <= 0)
        return baseMs;
    const bounded = Math.min(waitSeconds, SEARCH_WAIT_MAX_SECONDS);
    return Math.max(baseMs, bounded * 1000 + WAIT_HEADROOM_MS);
}

/** API failure — holds the HTTP status (0 = the app is unreachable). */
export class AtlasApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "AtlasApiError";
        this.status = status;
    }
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type ScanRequestBody = z.infer<typeof ScanRequestSchema>;

interface RequestOptions {
    method?: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    json?: unknown;
    text?: boolean;
    /** Overrides the baseline timeout; used by `search` to honour `wait`. */
    timeoutMs?: number;
}

export interface AtlasApiClientOptions {
    /** Baseline fast-fail timeout for calls that do not opt into a longer wait. */
    baseTimeoutMs?: number;
}

export class AtlasApiClient {
    readonly baseUrl: string;
    #fetch: FetchLike;
    #baseTimeoutMs: number;

    constructor(
        baseUrl: string,
        fetchImpl: FetchLike = fetch,
        options: AtlasApiClientOptions = {},
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.#fetch = fetchImpl;
        this.#baseTimeoutMs = options.baseTimeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    async health() {
        return HealthSchema.parse(await this.#request({ path: "/health" }));
    }

    async builds() {
        return BuildsResponseSchema.parse(await this.#request({ path: "/builds" }));
    }

    async fileInfo(fdid: number) {
        return FileInfoSchema.parse(await this.#request({ path: `/files/${fdid}` }));
    }

    async atlas(fdid: number, build?: string) {
        return AtlasResultSchema.parse(
            await this.#request({ path: `/atlas/${fdid}`, query: build ? { build } : undefined }),
        );
    }

    async regions(fdid: number, build?: string) {
        return AtlasRegionsResponseSchema.parse(
            await this.#request({
                path: `/atlas/${fdid}/regions`,
                query: build ? { build } : undefined,
            }),
        );
    }

    async exportLua(fdid: number, build?: string): Promise<string> {
        const body = await this.#request({
            path: `/atlas/${fdid}/export`,
            query: build ? { build } : undefined,
            text: true,
        });
        return String(body);
    }

    async search(q: string, limit?: number, waitSeconds?: number) {
        return SearchResultSchema.parse(
            await this.#request({
                path: "/search",
                timeoutMs: requestTimeoutMs(waitSeconds, this.#baseTimeoutMs),
                query: {
                    q,
                    ...(limit !== undefined ? { limit: String(limit) } : {}),
                    ...(waitSeconds !== undefined ? { wait: String(waitSeconds) } : {}),
                },
            }),
        );
    }

    async scan(body: ScanRequestBody) {
        return ScanResultSchema.parse(
            await this.#request({ path: "/scan", method: "POST", json: body }),
        );
    }

    /**
     * Start (or join) the authorized listfile download.
     *
     * Callers MUST have obtained the user's consent first — this is the only
     * path that writes ~146 MB, and it deliberately has no default. The
     * `waitSeconds` bound keeps the response inside the derived timeout so a
     * slow link degrades into "still indexing" rather than a client-side abort.
     */
    async fetchListfile(waitSeconds?: number) {
        return SearchCapabilitySchema.parse(
            await this.#request({
                path: "/listfile/fetch",
                method: "POST",
                json: { ...(waitSeconds !== undefined ? { wait: waitSeconds } : {}) },
                timeoutMs: requestTimeoutMs(waitSeconds, this.#baseTimeoutMs),
            }),
        );
    }

    async #request(opts: RequestOptions): Promise<unknown> {
        const base = new URL("/api/v1/", new URL(this.baseUrl));
        const url = new URL(opts.path.replace(/^\/+/, ""), base);
        for (const [key, value] of Object.entries(opts.query ?? {}))
            url.searchParams.set(key, value);

        const init: RequestInit = {
            method: opts.method ?? "GET",
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(opts.timeoutMs ?? this.#baseTimeoutMs),
        };
        if (opts.json !== undefined) {
            init.headers = { ...init.headers, "content-type": "application/json" };
            init.body = JSON.stringify(opts.json);
        }

        let res: Response;
        try {
            res = await this.#fetch(url, init);
        } catch (err) {
            throw new AtlasApiError(
                `cannot reach Atlas Inspector at ${this.baseUrl} — start it with \`node start.mjs\` and check ATLAS_URL. ` +
                    `(${err instanceof Error ? err.message : String(err)})`,
                0,
            );
        }

        if (!res.ok) await this.#throwProblem(res);

        const contentType = res.headers.get("content-type") ?? "";
        if (opts.text || !contentType.includes("application/json")) return res.text();
        return res.json();
    }

    async #throwProblem(res: Response): Promise<never> {
        const path = res.url ? new URL(res.url).pathname : this.baseUrl;
        let detail = `HTTP ${res.status} from ${path}`;
        try {
            const problem = ProblemSchema.safeParse(await res.json());
            if (problem.success) detail = problem.data.detail;
        } catch {
            // not a problem+json body — keep the generic detail
        }
        throw new AtlasApiError(detail, res.status);
    }
}
