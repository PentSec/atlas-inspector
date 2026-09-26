/**
 * MCP server unit tests — full protocol exchange over InMemoryTransport with a
 * stubbed HTTP layer, so the tool surface and handlers are exercised without
 * any server or DOM.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
    AtlasApiClient,
    AtlasApiError,
    requestTimeoutMs,
    type FetchLike,
} from "../../src/mcp/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

function text(res: Record<string, unknown>): string {
    const content = res.content as Array<{ type?: string; text?: string }> | undefined;
    return content?.[0]?.text ?? "";
}

const ATLAS_PAYLOAD = {
    kind: "atlas",
    filedata: 1030215,
    build: "12.1.5.69594",
    atlas: { id: 9000, filedata: 1030215, width: 128, height: 128 },
    members: [
        {
            name: "Foo\\IconA",
            left: 0,
            right: 64,
            top: 0,
            bottom: 64,
            width: 64,
            height: 64,
            overrideW: 0,
            overrideH: 0,
            displayW: 64,
            displayH: 64,
            elementId: "X0",
        },
        {
            name: "Foo\\IconB",
            left: 64,
            right: 128,
            top: 0,
            bottom: 64,
            width: 64,
            height: 64,
            overrideW: 0,
            overrideH: 0,
            displayW: 64,
            displayH: 64,
            elementId: "X1",
        },
    ],
};

const SCAN_PAYLOAD = {
    entries: [
        {
            key: "Foo\\IconA",
            source: "table",
            line: 2,
            texture: "Interface\\CharacterFrame\\TemporaryPortrait",
            u0: 0,
            u1: 0.5,
            v0: 0,
            v1: 0.5,
            flipX: false,
            flipY: false,
            px: { left: 0, top: 0, right: 64, bottom: 64 },
            dw: 16,
            dh: 16,
            err: null,
            exact: true,
            matched: 0,
            matchedName: "Foo\\IconA",
            stc: ":SetTexCoord(0/128, 64/128, 0/128, 64/128)",
            margin: null,
        },
    ],
};

const HEALTH_PAYLOAD = {
    status: "ok",
    service: "atlas-inspector",
    version: "0.2.0",
    capabilities: { search: { status: "ready", entries: 2_341_203 } },
};
/** Cold install: the process is alive but atlas_search cannot answer yet. */
const HEALTH_INDEXING_PAYLOAD = {
    status: "ok",
    service: "atlas-inspector",
    version: "0.2.0",
    capabilities: {
        search: {
            status: "indexing",
            entries: 0,
            detail: "building the listfile index (about 150 MB, one time).",
        },
    },
};
const BUILDS_PAYLOAD = { builds: ["12.1.5.69594", "12.0.2.57020"] };

function stubFetch(routes: Record<string, unknown>): FetchLike {
    return async (input, _init) => {
        const url = input instanceof URL ? input : new URL(String(input));
        const key = url.pathname + url.search;
        const payload = routes[key];
        if (payload === undefined) {
            throw new Error(`unexpected request: ${key}`);
        }
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
}

async function connectToolClient(client: AtlasApiClient) {
    const server = createMcpServer(client);
    const mcpClient = new Client({ name: "test-harness", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    return { mcpClient, server };
}

describe("atlas MCP server", () => {
    it("exposes the full v1 tool surface under an atlas_ prefix", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient("http://127.0.0.1:8000", stubFetch({})),
        );
        try {
            const list = await mcpClient.listTools();
            const names = list.tools.map((t) => t.name).sort();
            expect(names).toEqual(
                [
                    "atlas_export",
                    "atlas_file_info",
                    "atlas_get",
                    "atlas_list_builds",
                    "atlas_prepare_index",
                    "atlas_regions",
                    "atlas_scan",
                    "atlas_search",
                    "atlas_server_status",
                ].sort(),
            );
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("atlas_get returns the validated atlas payload", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient(
                "http://127.0.0.1:8000",
                stubFetch({ "/api/v1/atlas/1030215": ATLAS_PAYLOAD }),
            ),
        );
        try {
            const res = await mcpClient.callTool({
                name: "atlas_get",
                arguments: { fdid: 1030215 },
            });
            const sc = res.structuredContent as typeof ATLAS_PAYLOAD;
            expect(sc.kind).toBe("atlas");
            expect(sc.members).toHaveLength(2);
            expect(sc.members[0]!.name).toBe("Foo\\IconA");
            expect(text(res)).toContain("128×128");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("atlas_scan forwards code + sheet and returns normalized entries", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient(
                "http://127.0.0.1:8000",
                stubFetch({ "/api/v1/scan": SCAN_PAYLOAD }),
            ),
        );
        try {
            const res = await mcpClient.callTool({
                name: "atlas_scan",
                arguments: {
                    code: "atlas['Foo\\IconA'] = { 'Interface\\CharacterFrame\\TemporaryPortrait', 0, 0.5, 0, 0.5 }",
                    sheet: {
                        width: 128,
                        height: 128,
                        members: [{ name: "Foo\\IconA", left: 0, top: 0, right: 64, bottom: 64 }],
                    },
                },
            });
            const entries = (res.structuredContent as typeof SCAN_PAYLOAD).entries;
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ matchedName: "Foo\\IconA", exact: true });
            expect(text(res)).toContain("matched=Foo\\IconA");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("atlas_export returns the Lua text in content and structured output", async () => {
        const lua =
            "atlas.tiles = {\n  ['Foo\\IconA'] = { left=0, right=0.5, top=0, bottom=0.5 },\n}";
        const fetchImpl: FetchLike = async (_input) => {
            return new Response(lua, {
                status: 200,
                headers: { "content-type": "text/plain; charset=utf-8" },
            });
        };
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient("http://127.0.0.1:8000", fetchImpl),
        );
        try {
            const res = await mcpClient.callTool({
                name: "atlas_export",
                arguments: { fdid: 1030215 },
            });
            const sc = res.structuredContent as { filedata: number; lua: string };
            expect(sc.filedata).toBe(1030215);
            expect(sc.lua).toContain("Foo\\IconA");
            expect(text(res)).toContain("atlas.tiles");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("atlas_server_status surfaces the health payload and builds listing works", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient(
                "http://127.0.0.1:8000",
                stubFetch({ "/api/v1/health": HEALTH_PAYLOAD, "/api/v1/builds": BUILDS_PAYLOAD }),
            ),
        );
        try {
            const health = await mcpClient.callTool({ name: "atlas_server_status", arguments: {} });
            expect((health.structuredContent as typeof HEALTH_PAYLOAD).version).toBe("0.2.0");
            expect(text(health)).toContain("all tools available");
            expect(text(health)).toContain("2,341,203");

            const builds = await mcpClient.callTool({ name: "atlas_list_builds", arguments: {} });
            expect((builds.structuredContent as typeof BUILDS_PAYLOAD).builds).toHaveLength(2);
            expect(text(builds)).toContain("12.1.5.69594");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("atlas_server_status says DEGRADED instead of healthy on a cold install", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient(
                "http://127.0.0.1:8000",
                stubFetch({ "/api/v1/health": HEALTH_INDEXING_PAYLOAD }),
            ),
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_server_status", arguments: {} });
            const out = text(res);

            // The regression this whole change exists for: "healthy" while
            // atlas_search could not answer a single query.
            expect(out).not.toContain("all tools available");
            expect(out).toContain("DEGRADED");
            expect(out).toContain("indexing");
            expect(out).toContain("atlas_search");
            expect(out).toMatch(/wait: 25|poll/);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("atlas_search refuses to present a cold index as 'no such file'", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient(
                "http://127.0.0.1:8000",
                stubFetch({
                    "/api/v1/search?q=tooltip&limit=25&wait=0": {
                        status: "indexing",
                        hits: [],
                        detail: "building the listfile index (about 150 MB, one time).",
                    },
                }),
            ),
        );
        try {
            const res = await mcpClient.callTool({
                name: "atlas_search",
                arguments: { q: "tooltip" },
            });

            // Zero hits from an unbuilt index must be an error, never a
            // successful empty result the agent reads as ground truth.
            expect(res.isError).toBe(true);
            expect(text(res)).toContain("indexing");
            expect(text(res)).toMatch(/NOT a real answer/);
            expect(text(res)).toMatch(/wait: 25/);
            expect((res.structuredContent as { hits: unknown[] }).hits).toEqual([]);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("unreachable app becomes an actionable, non-fatal tool result", async () => {
        const fetchImpl: FetchLike = async () => {
            throw new TypeError("fetch failed");
        };
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient("http://127.0.0.1:8000", fetchImpl),
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_server_status", arguments: {} });
            expect(res.isError).toBe(true);
            expect(text(res)).toContain("node start.mjs");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("maps a 404 problem body into the tool error text", async () => {
        const fetchImpl: FetchLike = async (_input) => {
            return new Response(
                JSON.stringify({
                    type: "about:blank",
                    title: "Not Found",
                    status: 404,
                    detail: "FileDataID 999999 not found on wago.tools",
                    instance: "GET /api/v1/atlas/999999",
                }),
                { status: 404, headers: { "content-type": "application/problem+json" } },
            );
        };
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient("http://127.0.0.1:8000", fetchImpl),
        );
        try {
            const res = await mcpClient.callTool({
                name: "atlas_get",
                arguments: { fdid: 999999 },
            });
            expect(res.isError).toBe(true);
            expect(text(res)).toContain("FileDataID 999999 not found");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("validates inputs through the zod inputSchema", async () => {
        const { mcpClient, server } = await connectToolClient(
            new AtlasApiClient("http://127.0.0.1:8000", stubFetch({})),
        );
        try {
            const badFdid = await mcpClient.callTool({
                name: "atlas_get",
                arguments: { fdid: -1 },
            });
            expect(badFdid).toMatchObject({ isError: true });
            expect(text(badFdid)).toContain("Input validation error");

            const badScan = await mcpClient.callTool({
                name: "atlas_scan",
                arguments: { code: "" },
            });
            expect(badScan).toMatchObject({ isError: true });
            expect(text(badScan)).toContain("Input validation error");
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });
});

/** A fetch that answers after `delayMs` but rejects as soon as the signal aborts. */
function slowFetch(delayMs: number, payload: unknown): FetchLike {
    return (_input, init) =>
        new Promise<Response>((resolve, reject) => {
            const signal = init?.signal ?? null;
            const timer = setTimeout(() => {
                resolve(
                    new Response(JSON.stringify(payload), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            }, delayMs);
            signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(signal.reason ?? new Error("aborted"));
            });
        });
}

describe("requestTimeoutMs", () => {
    it("keeps the fast-fail baseline for calls that do not wait", () => {
        expect(requestTimeoutMs(undefined)).toBe(15_000);
        expect(requestTimeoutMs(undefined, 250)).toBe(250);
    });

    it("never returns less than the baseline", () => {
        expect(requestTimeoutMs(0)).toBe(15_000);
        expect(requestTimeoutMs(1)).toBe(15_000);
    });

    it("adds headroom over the wait the caller asked for", () => {
        expect(requestTimeoutMs(20)).toBe(25_000);
        expect(requestTimeoutMs(25)).toBe(30_000);
    });

    it("clamps out-of-range and non-finite input instead of trusting it", () => {
        expect(requestTimeoutMs(99)).toBe(30_000);
        expect(requestTimeoutMs(-5)).toBe(15_000);
        expect(requestTimeoutMs(Number.NaN)).toBe(15_000);
    });

    it("honours a custom baseline", () => {
        expect(requestTimeoutMs(2, 50)).toBe(7_000);
    });

    it("grants no headroom when the caller did not ask to wait", () => {
        // A small baseline is what exposes this: with the 15s default, a stray
        // 5s headroom on wait=0 stays hidden below the baseline.
        expect(requestTimeoutMs(0, 50)).toBe(50);
        expect(requestTimeoutMs(-1, 50)).toBe(50);
    });
});

describe("AtlasApiClient timeout derivation", () => {
    // Regression: a real first-run ~150 MB download takes ~19s, longer than the
    // old fixed 15s client timeout, so the advertised `wait: 25` could never be
    // honoured — the caller got an opaque AbortError instead of the server's
    // "still indexing" answer.
    const INDEXING_SEARCH = {
        status: "indexing",
        hits: [],
        detail: "building the listfile index (about 150 MB, one time).",
    };

    it("survives a response that outlasts the baseline when the caller asked to wait", async () => {
        const client = new AtlasApiClient(
            "http://127.0.0.1:8000",
            slowFetch(400, INDEXING_SEARCH),
            {
                baseTimeoutMs: 50,
            },
        );
        const result = await client.search("tooltip", 25, 2);
        expect(result.status).toBe("indexing");
    });

    it("still fails fast when the caller did not ask to wait", async () => {
        const client = new AtlasApiClient(
            "http://127.0.0.1:8000",
            slowFetch(400, INDEXING_SEARCH),
            {
                baseTimeoutMs: 50,
            },
        );
        await expect(client.search("tooltip", 25, 0)).rejects.toThrow(AtlasApiError);
    });

    it("still fails fast for calls that never take a wait", async () => {
        const client = new AtlasApiClient("http://127.0.0.1:8000", slowFetch(400, ATLAS_PAYLOAD), {
            baseTimeoutMs: 50,
        });
        await expect(client.atlas(1030215)).rejects.toThrow(AtlasApiError);
    });
});
