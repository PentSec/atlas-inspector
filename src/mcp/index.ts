#!/usr/bin/env node
/**
 * Atlas Inspector MCP server — stdio transport for local clients.
 *
 * opencode:  "atlas-inspector": { "type": "local", "command": ["node", "<repo>/dist/mcp/index.js"] }
 * Claude:    "atlas-inspector": { "command": "node", "args": ["<repo>/dist/mcp/index.js"] }
 *
 * ATLAS_URL (default http://127.0.0.1:8000) points at the running app.
 * Log only to stderr — stdout is the MCP protocol channel.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AtlasApiClient } from "./client.js";
import { ensureAppRunning } from "./launch.js";
import { createMcpServer } from "./server.js";

const baseUrl = (process.env.ATLAS_URL?.trim() || "http://127.0.0.1:8000").replace(/\/+$/, "");

await ensureAppRunning({ baseUrl });

const server = createMcpServer(new AtlasApiClient(baseUrl));
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`atlas-inspector mcp server (stdio) ready → ${baseUrl}`);
