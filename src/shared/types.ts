/**
 * Shared domain model for Atlas Inspector — facade over the zod wire schemas.
 * Server, client and (optionally) the MCP agent all import from here.
 */
export * from "./schemas.js";

export interface BuildItem {
  version: string;
}