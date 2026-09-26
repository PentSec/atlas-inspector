/**
 * `atlas_prepare_index` — the consent gate.
 *
 * This is the only path in the entire app that downloads ~146 MB, so these
 * tests are written from one assumption: silence is NOT consent. Every branch
 * that is not an explicit "the user accepted AND said yes" must leave the disk
 * untouched, and the assertion in each of those cases is the same — the
 * listfile fetch endpoint was never called.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { AtlasApiClient, type FetchLike } from "../../src/mcp/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

const ABSENT = { status: "absent", entries: 0, detail: "no index yet" };
const READY_CURRENT = { status: "ready", entries: 6, release: "202609242243" };
const READY_STALE = {
    status: "ready",
    entries: 6,
    release: "202609242243",
    latestRelease: "202610010000",
    updateAvailable: true,
};

type Consent = "accept-yes" | "accept-no" | "decline" | "cancel" | "unsupported" | "hang";

const FETCH_ROUTE = "/api/v1/listfile/fetch";

function healthOf(capability: Record<string, unknown>): Record<string, unknown> {
    return {
        status: "ok",
        service: "atlas-inspector",
        version: "0.2.0",
        capabilities: { search: capability },
    };
}

/**
 * Stub HTTP that records every path it was asked for, so a test can prove a
 * download was never even attempted.
 */
function recordingFetch(capability: Record<string, unknown>) {
    const calls: string[] = [];
    const impl: FetchLike = async (input, _init) => {
        const url = input instanceof URL ? input : new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === "/api/v1/health") {
            return json(healthOf(capability));
        }
        if (url.pathname === FETCH_ROUTE) {
            return json({ status: "ready", entries: 6, release: "202609242243" });
        }
        throw new Error(`unexpected request: ${url.pathname}`);
    };
    return { impl, calls };
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

/**
 * Connect a tool client, optionally able to answer elicitation prompts.
 * `unsupported` deliberately omits the capability so the server sees a client
 * that cannot be asked — the case that must fail closed.
 */
async function connect(client: AtlasApiClient, consent: Consent) {
    const server = createMcpServer(client);
    const prompts: unknown[] = [];

    const supportsElicitation = consent !== "unsupported";
    const mcpClient = new Client(
        { name: "consent-harness", version: "0.0.0" },
        { capabilities: supportsElicitation ? { elicitation: {} } : {} },
    );

    if (supportsElicitation) {
        mcpClient.setRequestHandler(ElicitRequestSchema, async (request) => {
            prompts.push(request);
            switch (consent) {
                case "accept-yes":
                    return { action: "accept", content: { download: true } };
                case "accept-no":
                    return { action: "accept", content: { download: false } };
                case "decline":
                    return { action: "decline" };
                case "cancel":
                    return { action: "cancel" };
                default:
                    return { action: "decline" };
            }
        });
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    return { mcpClient, server, prompts };
}

function text(res: Record<string, unknown>): string {
    const content = res.content as Array<{ text?: string }> | undefined;
    return content?.[0]?.text ?? "";
}

describe("atlas_prepare_index — consent required", () => {
    it("downloads when the user explicitly accepts", async () => {
        const { impl, calls } = recordingFetch(ABSENT);
        const { mcpClient, server, prompts } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBeFalsy();
            expect(prompts).toHaveLength(1);
            // The prompt must state the size; a user cannot consent to an unknown cost.
            expect(JSON.stringify(prompts[0])).toMatch(/146 MB/);
            expect(calls).toContain(FETCH_ROUTE);
            expect(text(res as never)).toMatch(/ready/i);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does NOT download when the user declines", async () => {
        const { impl, calls } = recordingFetch(ABSENT);
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "decline",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBe(true);
            expect(calls).not.toContain(FETCH_ROUTE);
            // A refusal must still leave the agent with a way forward.
            expect(text(res as never)).toMatch(/fetch:listfile/);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does NOT download when the user cancels the prompt", async () => {
        const { impl, calls } = recordingFetch(ABSENT);
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "cancel",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBe(true);
            expect(calls).not.toContain(FETCH_ROUTE);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does NOT download when the prompt is accepted but left unticked", async () => {
        // "Accept" the form without consenting to the download is still a no.
        // Reading `action === "accept"` as consent is the bug this test exists for.
        const { impl, calls } = recordingFetch(ABSENT);
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-no",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBe(true);
            expect(calls).not.toContain(FETCH_ROUTE);
            expect(text(res as never)).toMatch(/did not check/i);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does NOT download when the client cannot be asked at all", async () => {
        const { impl, calls } = recordingFetch(ABSENT);
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "unsupported",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBe(true);
            expect(calls).not.toContain(FETCH_ROUTE);
            expect(text(res as never)).toMatch(/does not support/i);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("is not read-only, so a client cannot auto-approve it as harmless", async () => {
        const { impl } = recordingFetch(ABSENT);
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const list = await mcpClient.listTools();
            const tool = list.tools.find((t) => t.name === "atlas_prepare_index");
            expect(tool?.annotations?.readOnlyHint).toBe(false);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });
});

describe("atlas_prepare_index — does not nag", () => {
    it("returns immediately with no prompt when the index is already current", async () => {
        const { impl, calls } = recordingFetch(READY_CURRENT);
        const { mcpClient, server, prompts } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBeFalsy();
            // Asking permission for a download that would not happen trains the
            // user to approve blindly. This must stay a no-op.
            expect(prompts).toHaveLength(0);
            expect(calls).not.toContain(FETCH_ROUTE);
            expect(text(res as never)).toMatch(/already ready/i);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does prompt when the freshness check found a newer release", async () => {
        const { impl, calls } = recordingFetch(READY_STALE);
        const { mcpClient, server, prompts } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBeFalsy();
            expect(prompts).toHaveLength(1);
            expect(JSON.stringify(prompts[0])).toMatch(/202610010000/);
            expect(calls).toContain(FETCH_ROUTE);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does not prompt when the index is ready and the checker has not run yet", async () => {
        // No latestRelease means absence of news, not staleness. Prompting here
        // would nag every install in the 30s before its first check.
        const { impl, calls } = recordingFetch({
            status: "ready",
            entries: 6,
            release: "202609242243",
        });
        const { mcpClient, server, prompts } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBeFalsy();
            expect(prompts).toHaveLength(0);
            expect(calls).not.toContain(FETCH_ROUTE);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("prompts when a ready index cannot be version-verified at all", async () => {
        // The CSV predates provenance. This is the state of every install that
        // existed before the sidecar, and it must not be reported as "current".
        const { impl, calls } = recordingFetch({
            status: "ready",
            entries: 6,
            latestRelease: "202609242243",
        });
        const { mcpClient, server, prompts } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBeFalsy();
            expect(prompts).toHaveLength(1);
            // The prompt must admit the uncertainty instead of inventing a diff.
            expect(JSON.stringify(prompts[0])).toMatch(/records no release|cannot be verified/i);
            expect(calls).toContain(FETCH_ROUTE);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("declining the unverifiable refresh keeps the existing index serving", async () => {
        const { impl, calls } = recordingFetch({
            status: "ready",
            entries: 6,
            latestRelease: "202609242243",
        });
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "decline",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBe(true);
            // The index we already have is not destroyed by a refusal: search
            // must keep working from it, and the answer must say so.
            expect(calls).not.toContain(FETCH_ROUTE);
            expect(text(res as never)).toMatch(/Not downloaded/i);
            expect(text(res as never)).toMatch(/keeps working/i);
            expect(text(res as never)).not.toMatch(/stays unavailable/i);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("declining the FIRST download says search is still dead", async () => {
        const { impl, calls } = recordingFetch(ABSENT);
        const { mcpClient, server } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "decline",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBe(true);
            expect(calls).not.toContain(FETCH_ROUTE);
            // With nothing on disk, the agent must know its empty results are
            // meaningless — this is the dangerous direction.
            expect(text(res as never)).toMatch(/stays unavailable/i);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });

    it("does not prompt again while a refresh is already downloading", async () => {
        const { impl, calls } = recordingFetch({ ...READY_CURRENT, refreshing: true });
        const { mcpClient, server, prompts } = await connect(
            new AtlasApiClient("http://127.0.0.1:8000", impl),
            "accept-yes",
        );
        try {
            const res = await mcpClient.callTool({ name: "atlas_prepare_index", arguments: {} });
            expect(res.isError).toBeFalsy();
            expect(prompts).toHaveLength(0);
            expect(calls).not.toContain(FETCH_ROUTE);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    });
});
