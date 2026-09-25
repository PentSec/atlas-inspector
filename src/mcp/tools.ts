/**
 * Tool registry for the Atlas Inspector MCP server — one tool per /api/v1
 * surface (ADR-013), all read-only wrappers over the running app. Text
 * summaries stay bounded for agent context efficiency while the full,
 * schema-validated payload ships in `structuredContent`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ScanRequestSchema } from "../shared/schemas.js";
import { AtlasApiError } from "./client.js";
import type { AtlasApiClient } from "./client.js";

const CHARACTER_LIMIT = 25_000;
const LIST_PREVIEW = 12;

const APP_HINT =
    " Start the app with `node start.mjs` in the atlas-inspector repo, or point ATLAS_URL at a running instance.";

const ReadOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
} as const;

const FdidInput = z
    .number()
    .int()
    .positive()
    .describe("FileDataID of the atlas (numeric, for example 878877). Find it with atlas_search.");
const BuildInput = z
    .string()
    .min(1)
    .describe(
        'Explicit game build to resolve against, for example "12.1.5.69594". Omit it for the latest build (also accepts "default").',
    )
    .optional();

function fail(error: unknown): CallToolResult {
    const message =
        error instanceof AtlasApiError
            ? `Atlas Inspector error (${error.status}): ${error.message}${error.status === 0 ? APP_HINT : ""}`
            : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
    return { content: [{ type: "text", text }], structuredContent };
}

function capped(value: string): string {
    return value.length > CHARACTER_LIMIT
        ? `${value.slice(0, CHARACTER_LIMIT)}\n… truncated`
        : value;
}

function bullets(items: string[], max = LIST_PREVIEW): string {
    if (!items.length) return "";
    const shown = items.slice(0, max);
    const suffix = items.length > shown.length ? ` (… +${items.length - shown.length} more)` : "";
    return `\n${shown.map((line) => `- ${line}`).join("\n")}${suffix}`;
}

export function registerAtlasTools(server: McpServer, client: AtlasApiClient): void {
    server.registerTool(
        "atlas_server_status",
        {
            title: "Atlas Server Status",
            description: `Report whether the Atlas Inspector app is reachable and its version.

Run this first when uncertain the app is running. Returns the /api/v1/health payload: { status, service, version }.

Example outcome:
  - ok: Atlas Inspector 0.2.0 is healthy at http://127.0.0.1:8000
  - failure: an actionable error telling you to run \`node start.mjs\` or fix ATLAS_URL.`,
            inputSchema: z.object({}),
            annotations: { ...ReadOnly, openWorldHint: false },
        },
        async () => {
            try {
                const health = await client.health();
                return ok(
                    `Atlas Inspector ${health.version} is healthy at ${client.baseUrl}`,
                    health,
                );
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "atlas_list_builds",
        {
            title: "List Game Builds",
            description: `List the game builds the app can resolve atlases against (current + previous each patch).

Useful to pin a build for atlas_get/atlas_regions/atlas_export when the latest build lacks a given FileDataID.`,
            inputSchema: z.object({}),
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async () => {
            try {
                const data = await client.builds();
                const preview = data.builds.slice(0, LIST_PREVIEW).join(", ");
                const suffix =
                    data.builds.length > LIST_PREVIEW
                        ? ` (+${data.builds.length - LIST_PREVIEW} more)`
                        : "";
                return ok(`${data.builds.length} build(s): ${preview}${suffix}`, data);
            } catch (error) {
                return fail(error);
            }
        },
    );

    const SearchInput = z
        .object({
            q: z
                .string()
                .min(1)
                .describe(
                    'Substring to match against listfile names, for example "AzerothMinimap" or "playerportrait". Matches substrings; case-insensitive.',
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(25)
                .describe("Maximum hits to return (default 25)."),
        })
        .strict();

    server.registerTool(
        "atlas_search",
        {
            title: "Search Listfile",
            description: `Find a FileDataID by name — the entry point for exploring the game's texture database.

Requires the listfile index; if missing, the result explains how to build it (\`npm run fetch:listfile\`).`,
            inputSchema: SearchInput,
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async ({ q, limit }) => {
            try {
                const data = await client.search(q, limit);
                const lines = data.hits.map((hit) => `${hit.name} (FileDataID ${hit.filedata})`);
                return ok(`${data.hits.length} hit(s) for "${q}"${bullets(lines, limit)}`, data);
            } catch (error) {
                return fail(error);
            }
        },
    );

    const FdidInputSchema = z.object({ fdid: FdidInput }).strict();

    server.registerTool(
        "atlas_file_info",
        {
            title: "File Info",
            description: `Fetch wago.tools metadata for a FileDataID (filename, type, available versions, content hashes).

Cheap probe before deciding whether a FileDataID is worth resolving as an atlas.`,
            inputSchema: FdidInputSchema,
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async ({ fdid }) => {
            try {
                const info = await client.fileInfo(fdid);
                return ok(capped(JSON.stringify(info, null, 2)), info);
            } catch (error) {
                return fail(error);
            }
        },
    );

    const AtlasLookupInput = z
        .object({
            fdid: FdidInput,
            build: BuildInput,
        })
        .strict();

    server.registerTool(
        "atlas_get",
        {
            title: "Resolve Atlas Regions",
            description: `Resolve a FileDataID into its sheet info and region list (pixel rects + display sizes).

This is the core tool for atlas inspection:
  - kind "atlas": the sheet is an atlas — { atlas: { width, height }, members: [{ name, left, top, right, bottom, displayW, displayH }] }.
  - kind "texture": the FileDataID is a plain texture, not a sheet atlas — no region list.
  - kind "missing": the FileDataID could not be resolved on wago.tools.

Negative rect coordinates indicate padding/mirroring (bottom/right can exceed the sheet, or lie on the negative side).

Example: atlas_get { "fdid": 878877 } → Interface\\PetBattles\\PetBattleHUDAtlas sheet with 27 members.

To normalize scanned addon-code rects against this sheet, pass the atlas members into atlas_scan's sheet param.`,
            inputSchema: AtlasLookupInput,
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async ({ fdid, build }) => {
            try {
                const result = await client.atlas(fdid, build);
                if (result.kind === "atlas") {
                    const lines = result.members.map(
                        (m) =>
                            `${m.name} (${m.left},${m.top},${m.right},${m.bottom}) ${m.displayW}×${m.displayH}`,
                    );
                    return ok(
                        `atlas ${result.filedata} (build ${result.build}): ${result.atlas.width}×${result.atlas.height}, ` +
                            `${result.members.length} region(s)${bullets(lines)}`,
                        result,
                    );
                }
                if (result.kind === "texture") {
                    return ok(
                        `FileDataID ${result.filedata} is a texture, not a sheet atlas: ${result.filename} (${result.type}). ` +
                            `${result.error}`,
                        result,
                    );
                }
                return ok(`FileDataID ${result.filedata} missing: ${result.error}`, result);
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "atlas_regions",
        {
            title: "Atlas Normalized Regions",
            description: `Resolve a FileDataID and return its regions normalized to [0,1] texture coordinates.

Lighter than atlas_get: only { name, u0, u1, v0, v1 } per region plus sheet width/height. Use it to map
an atlas member into texture space for SetTexCoord-style lookups.`,
            inputSchema: AtlasLookupInput,
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async ({ fdid, build }) => {
            try {
                const data = await client.regions(fdid, build);
                const lines = data.regions.map(
                    (r) => `${r.name}  u0=${r.u0} u1=${r.u1} v0=${r.v0} v1=${r.v1}`,
                );
                return ok(
                    `${data.width}×${data.height}, ${data.regions.length} region(s) in build ${data.build}${bullets(lines)}`,
                    data,
                );
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "atlas_export",
        {
            title: "Export Atlas as Lua",
            description:
                `Export a whole atlas as Lua tables (default export style) — the same bytes the web UI's copy button emits.

Each region line is ` +
                "`['name'] = { PACK, dispW, dispH, left, right, top, bottom }`" +
                ` with normalized [0,1] coords (use a real texture reference in place of PACK). The ` +
                "`lua`" +
                ` field of the structured result holds the full escaped text.

Example use: paste the result into an addon to hardcode a sheet's entries.`,
            inputSchema: AtlasLookupInput,
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async ({ fdid, build }) => {
            try {
                const lua = await client.exportLua(fdid, build);
                const output = { filedata: fdid, build: build ?? null, lua };
                return ok(capped(lua), output);
            } catch (error) {
                return fail(error);
            }
        },
    );

    const ScanInput = ScanRequestSchema.strict();

    server.registerTool(
        "atlas_scan",
        {
            title: "Scan Addon Code",
            description: `Parse addon Lua/XML code (tables + SetTexCoord calls) into normalized region entries — the server-side twin of the web UI's scan panel.

Body: { code, sheet? } where:
  - code: raw addon source text (any mix of Lua and XML).
  - sheet: optional { width, height, members: [{ name, left, top, right, bottom }] } to normalize entries into
    pixel rects, corner-exactness and matching against known atlas members. Grab the pixel members from atlas_get
    and convert them to { left, top, right, bottom } (leave out width/height/displayW/displayH).

Each entry: key, source, texture, normalized coords, flipX/Y, px (null when no sheet/match), dw/dh, exact boolean,
matched index + matchedName, ready-to-paste \`stc\` Lua line, and margin for nine-slice pixels.

Example: scan addon code containing atlas["Foo"] = { "Interface\\Buttons\\Foo", 0, 0.5, 0, 0.5 } with a
128×128 sheet → px { 0,0,64,64 }, stc ":SetTexCoord(0/128, 64/128, 0/128, 64/128)".`,
            inputSchema: ScanInput,
            annotations: { ...ReadOnly, openWorldHint: false },
        },
        async (body) => {
            try {
                const data = await client.scan(body);
                const lines = data.entries.map((entry) => {
                    const px = entry.px
                        ? `px ${entry.px.left},${entry.px.top},${entry.px.right},${entry.px.bottom}`
                        : "no px (no sheet match)";
                    const matched = entry.matchedName ?? "unmatched";
                    const flip = entry.flipX || entry.flipY ? " (flipped)" : "";
                    return `${entry.key} → ${px} matched=${matched} exact=${entry.exact}${flip}`;
                });
                const sheetText = body.sheet
                    ? ` against sheet ${body.sheet.width}×${body.sheet.height}`
                    : "";
                return ok(
                    `${data.entries.length} region entry(ies) found${sheetText}${bullets(lines)}`,
                    data,
                );
            } catch (error) {
                return fail(error);
            }
        },
    );
}
