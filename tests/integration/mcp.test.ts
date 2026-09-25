/**
 * MCP integration tests — full end-to-end chain: MCP tool → AtlasApiClient →
 * real HTTP → Fastify app → mock wago upstream. No real network; the MCP
 * conversation runs over InMemoryTransport in-process.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function text(res: Record<string, unknown>): string {
    const content = res.content as Array<{ type?: string; text?: string }> | undefined;
    return content?.[0]?.text ?? "";
}
import { buildApp, type AppInstance, type AppServices } from "../../src/server/app.js";
import { loadConfig, type Config } from "../../src/server/config.js";
import { createLogger, type Logger } from "../../src/server/logger.js";
import { FileCache } from "../../src/server/lib/cache.js";
import { DecodeService } from "../../src/server/services/decodeService.js";
import type { WowFileSource } from "../../src/server/adapters/wowSource.js";
import type { BlpDecoder, DecodedBlp } from "../../src/server/adapters/blpDecoder.js";
import { AtlasApiClient } from "../../src/mcp/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

const FAKE_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
    Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
]);

class FakeDecoder implements BlpDecoder {
    fail = false;
    async decodeToPng(): Promise<DecodedBlp> {
        if (this.fail) throw new Error("unsupported");
        return { width: 4, height: 4, png: FAKE_PNG };
    }
}

function mockSource(db2: { atlas: string[]; member: string[] }): WowFileSource & { blob: Buffer } {
    const blob = FAKE_PNG;
    return {
        blob,
        async getFile(url: string) {
            const p = new URL(url).pathname;
            if (p.endsWith("/api/builds/latest")) {
                return Buffer.from(
                    JSON.stringify({ latest: { wow: { version: "12.1.5.69594" } } }),
                );
            }
            if (p.endsWith("/db2/UiTextureAtlas/csv")) return Buffer.from(db2.atlas.join("\n"));
            if (p.endsWith("/db2/UiTextureAtlasMember/csv"))
                return Buffer.from(db2.member.join("\n"));
            if (p.endsWith("/api/casc/1030215")) return blob;
            return Buffer.from(JSON.stringify({ error: "no file" }));
        },
    };
}

const ATLAS_CSV = [
    "ID,UiTextureAtlasID,CommittedName,FileDataID,AtlasWidth,AtlasHeight",
    "9000,9000,Interface\\Icons\\Foo,1030215,128,128",
];
const MEMBER_CSV = [
    "ID,UiTextureAtlasID,UiTextureAtlasElementID,CommittedName,CommittedLeft,CommittedRight,CommittedTop,CommittedBottom,Width,Height,OverrideWidth,OverrideHeight",
    "1,9000,X0,Foo\\IconA,0,64,0,64,64,64,0,0",
    "2,9000,X1,Foo\\IconB,64,128,0,64,64,64,0,0",
];

let tmp: string;
let config: Config;
let logger: Logger;
let app: AppInstance;
let baseUrl: string;
let mcpClient: Client;

async function connectMcp(apiBaseUrl: string) {
    const server = createMcpServer(new AtlasApiClient(apiBaseUrl));
    const client = new Client({ name: "mcp-integration", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, server };
}

beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "atlas-inspector-mcp-test-"));
    config = loadConfig({
        ATLAS_ROOT: tmp,
        WAGO_BASE_URL: "https://mock.wago.tools",
        UPSTREAM_MAX_RETRIES: "0",
        UPSTREAM_TIMEOUT_MS: "2000",
        LOG_PRETTY: "0",
    });
    logger = createLogger("silent" as never, false).child({});

    const overrides: Partial<AppServices> = {
        source: mockSource({ atlas: ATLAS_CSV, member: MEMBER_CSV }),
        decode: new DecodeService({
            decoder: new FakeDecoder(),
            decodeCache: new FileCache({
                dir: path.join(tmp, "decode"),
                ttlMs: 60_000,
                memoryByteLimit: 1024,
                logger,
            }),
            maxBytes: config.decode.maxBytes,
        }),
        dbCache: new FileCache({
            dir: path.join(tmp, "db"),
            ttlMs: 60_000,
            memoryByteLimit: 1024,
            logger,
        }),
        renderCache: new FileCache({
            dir: path.join(tmp, "render"),
            ttlMs: 60_000,
            memoryByteLimit: 1024,
            logger,
        }),
        decodeCache: new FileCache({
            dir: path.join(tmp, "decode2"),
            ttlMs: 60_000,
            memoryByteLimit: 1024,
            logger,
        }),
    };
    app = await buildApp(config, logger, overrides);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const linked = await connectMcp(baseUrl);
    mcpClient = linked.client;
});

afterAll(async () => {
    await mcpClient?.close();
    await app?.close();
    await rm(tmp, { recursive: true, force: true });
});

describe("atlas MCP over the real v1 app", () => {
    it("atlas_get resolves a member pair from the fake wago CSV", async () => {
        const res = await mcpClient.callTool({ name: "atlas_get", arguments: { fdid: 1030215 } });
        expect(res.isError).toBeUndefined();
        const sc = res.structuredContent as {
            kind: string;
            build: string;
            atlas: { width: number; height: number };
            members: Array<{
                name: string;
                left: number;
                right: number;
                top: number;
                bottom: number;
            }>;
        };
        expect(sc.kind).toBe("atlas");
        expect(sc.atlas).toEqual({ id: 9000, filedata: 1030215, width: 128, height: 128 });
        expect(sc.members).toEqual([
            expect.objectContaining({ name: "Foo\\IconA", left: 0, top: 0, right: 64, bottom: 64 }),
            expect.objectContaining({
                name: "Foo\\IconB",
                left: 64,
                top: 0,
                right: 128,
                bottom: 64,
            }),
        ]);
        expect(text(res)).toContain("2 region(s)");
    });

    it("atlas_regions normalizes the same members to [0,1]", async () => {
        const res = await mcpClient.callTool({
            name: "atlas_regions",
            arguments: { fdid: 1030215 },
        });
        const sc = res.structuredContent as {
            regions: Array<{ name: string; u0: number; u1: number; v0: number; v1: number }>;
        };
        expect(sc.regions).toEqual([
            { name: "Foo\\IconA", u0: 0, u1: 0.5, v0: 0, v1: 0.5 },
            { name: "Foo\\IconB", u0: 0.5, u1: 1, v0: 0, v1: 0.5 },
        ]);
    });

    it("atlas_scan normalizes code against a sheet taken from atlas_get", async () => {
        const code =
            "atlas['Foo\\IconA'] = { 'Interface\\CharacterFrame\\TemporaryPortrait', 0, 0.5, 0, 0.5 }";
        const res = await mcpClient.callTool({
            name: "atlas_scan",
            arguments: {
                code,
                sheet: {
                    width: 128,
                    height: 128,
                    members: [
                        { name: "Foo\\IconA", left: 0, top: 0, right: 64, bottom: 64 },
                        { name: "Foo\\IconB", left: 64, top: 0, right: 128, bottom: 64 },
                    ],
                },
            },
        });
        const sc = res.structuredContent as {
            entries: Array<{ px: { left: number }; exact: boolean; matchedName: string }>;
        };
        expect(sc.entries).toEqual([
            expect.objectContaining({
                px: { left: 0, top: 0, right: 64, bottom: 64 },
                exact: true,
                matchedName: "Foo\\IconA",
            }),
        ]);
    });

    it("atlas_export streams the Lua table for a known member", async () => {
        const res = await mcpClient.callTool({
            name: "atlas_export",
            arguments: { fdid: 1030215 },
        });
        const sc = res.structuredContent as { filedata: number; lua: string };
        expect(sc.filedata).toBe(1030215);
        expect(sc.lua).toContain("Foo\\\\IconA");
        expect(sc.lua).toContain("{ PACK, 64, 64,");
    });

    it("an unknown FileDataID surfaces the problem detail as an error", async () => {
        const res = await mcpClient.callTool({ name: "atlas_get", arguments: { fdid: 999999 } });
        expect(res.isError).toBe(true);
        expect(text(res)).toMatch(/error/i);
    });

    it("atlas_server_status reflects the real app version", async () => {
        const res = await mcpClient.callTool({ name: "atlas_server_status", arguments: {} });
        const sc = res.structuredContent as { status: string; service: string };
        expect(sc).toMatchObject({ status: "ok", service: "atlas-inspector" });
    });
});
