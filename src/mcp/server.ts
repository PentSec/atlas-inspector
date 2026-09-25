/**
 * MCP server factory — shared by the stdio entry (opencode / Claude Desktop)
 * and the optional streamable-HTTP entry. Everything routes through an
 * AtlasApiClient pointed at the running app.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version } from "../server/version.js";
import type { AtlasApiClient } from "./client.js";
import { registerAtlasTools } from "./tools.js";

export const MCP_SERVER_NAME = "atlas-inspector-mcp-server";

export function createMcpServer(client: AtlasApiClient): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version });
    registerAtlasTools(server, client);
    return server;
}
