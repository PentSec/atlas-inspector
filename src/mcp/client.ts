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
    SearchResultSchema,
} from "../shared/schemas.js";
import type { ScanRequestSchema } from "../shared/schemas.js";

const REQUEST_TIMEOUT_MS = 15_000;

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
}

export class AtlasApiClient {
    readonly baseUrl: string;
    #fetch: FetchLike;

    constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.#fetch = fetchImpl;
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

    async search(q: string, limit?: number) {
        return SearchResultSchema.parse(
            await this.#request({
                path: "/search",
                query: { q, ...(limit !== undefined ? { limit: String(limit) } : {}) },
            }),
        );
    }

    async scan(body: ScanRequestBody) {
        return ScanResultSchema.parse(
            await this.#request({ path: "/scan", method: "POST", json: body }),
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
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
