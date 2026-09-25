#!/usr/bin/env node
/**
 * Atlas Inspector MCP server — optional streamable-HTTP transport (stateless
 * JSON, per the MCP best practices). Useful for remote clients; local opencode
 * and Claude Desktop normally use the stdio entry instead (src/mcp/index.ts).
 *
 * `npm run start:mcp:http` → http://127.0.0.1:8087/mcp
 * Env: MCP_HOST (default 127.0.0.1), MCP_PORT (default 8087), ATLAS_URL.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify from "fastify";
import type { Config } from "../server/config.js";
import { loadConfig } from "../server/config.js";
import { createLogger } from "../server/logger.js";
import { AtlasApiClient } from "./client.js";
import { ensureAppRunning } from "./launch.js";
import { createMcpServer } from "./server.js";

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    const value = raw ? Number(raw) : NaN;
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

const config: Config = loadConfig();
const logger = createLogger(config.log.level, config.log.pretty);
const host = process.env.MCP_HOST?.trim() || "127.0.0.1";
const port = envInt("MCP_PORT", 8087);
const baseUrl = (process.env.ATLAS_URL?.trim() || "http://127.0.0.1:8000").replace(/\/+$/, "");

await ensureAppRunning({ baseUrl, onLog: (line) => logger.info(line) });

const server = createMcpServer(new AtlasApiClient(baseUrl));
const app = Fastify({ loggerInstance: logger, bodyLimit: 16 * 1024 * 1024 });

app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        reply.hijack();
        reply.raw.on("close", () => {
            void transport.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req.raw, reply.raw, req.body);
        } catch (err) {
            logger.error({ err }, "mcp request failed");
            if (!reply.raw.headersSent) {
                reply.raw.writeHead(500, { "content-type": "application/json" });
                reply.raw.end(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        error: { code: -32603, message: "internal error" },
                        id: null,
                    }),
                );
            } else {
                reply.raw.end();
            }
        }
    },
});

await app.listen({ host, port });
logger.info({ host, port, baseUrl }, "Atlas Inspector MCP (streamable HTTP) listening at /mcp");
