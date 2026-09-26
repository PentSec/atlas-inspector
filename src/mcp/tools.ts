/**
 * Tool registry for the Atlas Inspector MCP server — one tool per /api/v1
 * surface (ADR-013), all read-only wrappers over the running app. Text
 * summaries stay bounded for agent context efficiency while the full,
 * schema-validated payload ships in `structuredContent`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
    BlpAlphaResponseSchema,
    BlpIslandsResponseSchema,
    BlpTcResponseSchema,
    HealthSchema,
    ScanRequestSchema,
    SEARCH_WAIT_MAX_SECONDS,
    SearchCapabilitySchema,
    SearchResultSchema,
} from "../shared/schemas.js";
import type { Health, SearchCapability, SearchStatus } from "../shared/types.js";
import { BlpInputError, resolveBlpBytes } from "./blpInput.js";
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

/**
 * The one tool that is allowed to spend the user's bandwidth. It writes a
 * ~146 MB file, so it must not claim `readOnlyHint: true` — a client that
 * auto-approves read-only tools would otherwise approve a download silently.
 */
const Writes = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
} as const;

/**
 * How long to wait for a human to answer the consent prompt. Generous, because
 * a real person has to read it — but finite, and a timeout is treated as "no".
 * A tool call must never park forever on a prompt nobody will see.
 */
const ELICIT_TIMEOUT_MS = 180_000;

const LISTFILE_SIZE_HINT = "~146 MB (community-listfile.csv)";

const MANUAL_FETCH_HINT = "Run `npm run fetch:listfile` in the atlas-inspector repo instead.";

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
            : error instanceof BlpInputError
              ? `Invalid \`blp\` input: ${error.message}`
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

/**
 * Render health as an honest verdict instead of a bare "ok". An agent that only
 * sees `status: "ok"` will happily call atlas_search on a cold install and read
 * the empty result as "no such texture" — this line is what prevents that.
 */
function describeHealth(health: Health, baseUrl: string): string {
    const head = `Atlas Inspector ${health.version} at ${baseUrl}`;
    const search = health.capabilities.search;

    const provenance = describeProvenance(search);

    if (search.status === "ready") {
        return `${head} — all tools available. search: ready (${search.entries.toLocaleString("en-US")} names).${provenance}`;
    }

    const cause =
        search.status === "indexing"
            ? `a user-authorized ${LISTFILE_SIZE_HINT} download is in flight`
            : (search.detail ?? "no detail reported");

    const nextStep =
        search.status === "indexing"
            ? `Retry this call with wait: ${SEARCH_WAIT_MAX_SECONDS} to ride it out.`
            : `Call atlas_prepare_index to ask the user to authorize the ${LISTFILE_SIZE_HINT} download — it never happens on its own.`;

    return (
        `${head} — DEGRADED. search: ${search.status} (${cause}).${provenance}\n` +
        `Every tool except atlas_search already works. atlas_search returns zero hits and isError until the ` +
        `index is ready, so do not read that empty result as "no such file". ${nextStep} ` +
        `Poll atlas_server_status for the current capabilities.search state.`
    );
}

/** Release + freshness, only when we actually know something worth reporting. */
function describeProvenance(search: Health["capabilities"]["search"]): string {
    if (search.refreshing) {
        return ` A refresh of the ${LISTFILE_SIZE_HINT} index is downloading in the background; queries keep working from the current index.`;
    }
    if (search.updateAvailable) {
        const known = search.fetchedAt ? `, downloaded ${search.fetchedAt}` : "";
        return ` A newer listfile release is available (${search.release} on disk${known} → ${search.latestRelease}): call atlas_prepare_index to refresh.`;
    }
    if (search.latestRelease && search.release) {
        return ` Listfile is current (release ${search.release}).`;
    }
    if (search.status === "ready" && search.latestRelease && !search.release) {
        // An index that works but cannot be version-checked. Silence here would
        // read as "current", which is a claim we cannot support.
        return (
            ` Listfile is ready but records no release, so its currency cannot be verified ` +
            `(latest published is ${search.latestRelease}); atlas_prepare_index can re-download it to establish provenance.`
        );
    }
    return "";
}

const DECLINED = "the user declined";
const CANCELLED = "the user cancelled the prompt";
const UNSUPPORTED = "this client does not support permission prompts";
const UNANSWERED = "nobody answered the prompt in time";

/**
 * Ask the user, through MCP elicitation, whether to spend the bandwidth.
 *
 * The whole design rests on this function failing closed. Every path that is
 * not an explicit "accept + yes" is a refusal:
 *
 *   decline / cancel        → the user said no (or aborted)
 *   unsupported client      → we cannot ask, so we must not act
 *   timeout / any throw     → nobody answered, and silence is not consent
 *
 * Silently downloading on any of those is the one outcome this whole feature
 * exists to prevent, so the caller receives `granted: false` plus a reason it
 * can show the user.
 */
async function requestListfileConsent(
    server: McpServer,
    context: {
        mode: "build" | "update" | "unverifiable";
        release?: string;
        latestRelease?: string;
    },
): Promise<{ granted: boolean; reason: string }> {
    const reason =
        context.mode === "update"
            ? `refreshing the name index from release ${context.release} to ${context.latestRelease}`
            : context.mode === "unverifiable"
              ? // The only install that cannot answer "is my index current?" is one
                // whose CSV predates provenance. Re-downloading is the sole remedy
                // and it costs bandwidth, so it goes to the user like any other.
                `re-download the name index — the copy on disk records no release, so its currency cannot be verified ` +
                `(the current release is ${context.latestRelease})`
              : "building the name index so atlas_search can resolve texture names";

    try {
        const result = await server.server.elicitInput(
            {
                mode: "form",
                message:
                    `atlas_search needs the listfile index (${LISTFILE_SIZE_HINT}, downloaded from ` +
                    `github.com/wowdev/wow-listfile) in order to ${reason}.\n\n` +
                    `This is the only thing in the app that downloads a large file, and it only happens ` +
                    `if you approve it now.`,
                requestedSchema: {
                    type: "object",
                    properties: {
                        download: {
                            type: "boolean",
                            title: `Download ${LISTFILE_SIZE_HINT}`,
                            description:
                                "Leave this off to skip; nothing will be downloaded and you can run " +
                                "`npm run fetch:listfile` yourself later.",
                            default: false,
                        },
                    },
                    required: ["download"],
                },
            },
            { timeout: ELICIT_TIMEOUT_MS },
        );

        if (result.action === "cancel") return { granted: false, reason: CANCELLED };
        if (result.action === "decline") return { granted: false, reason: DECLINED };
        if (result.content?.download === true)
            return { granted: true, reason: "the user approved" };
        // Accepting the form without ticking the box is still a "no".
        return { granted: false, reason: "the user did not check the download box" };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not support/i.test(message)) return { granted: false, reason: UNSUPPORTED };
        return { granted: false, reason: UNANSWERED };
    }
}

/** Actionable text for every non-ready search status. */
function searchNotReadyText(status: SearchStatus, detail?: string): string {
    const head = `atlas_search cannot answer yet: the listfile index is "${status}", so the zero hits below are NOT a real answer.`;
    const tail = `\nAll other tools work normally. Poll atlas_server_status for the current capabilities.search state.`;

    if (status === "indexing") {
        return (
            `${head} A user-authorized ${LISTFILE_SIZE_HINT} download is in flight.\n` +
            `Next step: retry this call with wait: ${SEARCH_WAIT_MAX_SECONDS} to ride it out.${tail}`
        );
    }
    if (status === "absent") {
        return (
            `${head} Downloading the ${LISTFILE_SIZE_HINT} index requires the user's explicit approval, so ` +
            `retrying this call will NOT help — nothing downloads on its own.\n` +
            `Next step: call atlas_prepare_index, which asks the user first. If they decline, ${MANUAL_FETCH_HINT}${tail}`
        );
    }
    return `${head}\nNext step: ${detail ?? "inspect capabilities.search.detail"}.${tail}`;
}

export function registerAtlasTools(server: McpServer, client: AtlasApiClient): void {
    server.registerTool(
        "atlas_server_status",
        {
            title: "Atlas Server Status",
            description: `Report whether the Atlas Inspector app is reachable, its version, and which capabilities are actually usable.

Run this first when uncertain the app is running. Reachability alone does NOT mean every tool works: the payload separates process liveness (\`status\`, always "ok" while the process lives) from per-feature readiness (\`capabilities\`).

  - capabilities.search.status "ready"     → every tool works, including atlas_search.
  - capabilities.search.status "indexing"  → a user-authorized ~146 MB download is in flight. atlas_search
                                             returns no hits until it finishes; all other tools already work.
                                             Poll this tool to detect when it flips to "ready".
  - capabilities.search.status "absent"    → no index, and nothing was downloaded because nobody authorized
                                             it. atlas_search cannot resolve names; call atlas_prepare_index
                                             to ask the user.
  - capabilities.search.status "error"     → an authorized attempt failed; capabilities.search.detail says why.

When the index is ready the payload also carries its provenance: release, fetchedAt, and
updateAvailable/latestRelease when the 7-hourly check has seen a newer published release. A refresh
download that is running behind a usable index shows as refreshing: true and does NOT break searching.

Example outcomes:
  - Atlas Inspector 0.2.0 at http://127.0.0.1:8000 — all tools available. search: ready (2341203 names). Listfile is current (release 202609242243).
  - Atlas Inspector 0.2.0 at http://127.0.0.1:8000 — DEGRADED. search: absent (no listfile index yet). ...
  - failure: an actionable error telling you to run \`node start.mjs\` or fix ATLAS_URL.`,
            inputSchema: z.object({}),
            outputSchema: HealthSchema,
            annotations: { ...ReadOnly, openWorldHint: false },
        },
        async () => {
            try {
                const health = await client.health();
                return ok(describeHealth(health, client.baseUrl), health);
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
                    'Substring to match against listfile names, for example "uiminimap" or "unitframe". Matches substrings; case-insensitive.',
                ),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(25)
                .describe("Maximum hits to return (default 25)."),
            wait: z
                .number()
                .int()
                .min(0)
                .max(SEARCH_WAIT_MAX_SECONDS)
                .default(0)
                .describe(
                    `Seconds to wait for a first-run index build to finish (default 0, server caps at ${SEARCH_WAIT_MAX_SECONDS}). ` +
                        `Set ${SEARCH_WAIT_MAX_SECONDS} to ride out a nearly-finished download instead of polling. ` +
                        `Ignored once the index is ready.`,
                ),
        })
        .strict();

    server.registerTool(
        "atlas_search",
        {
            title: "Search Listfile",
            description: `Find a FileDataID by name — the entry point for exploring the game's texture database.

The name index is a ${LISTFILE_SIZE_HINT} download that is NEVER started automatically: it requires the user's explicit approval, which you request with atlas_prepare_index (it shows them a consent prompt). Until the index exists this call reports isError with status "absent" and zero hits — an empty hit list NEVER means "no such file". Once a download is authorized and in flight, status is "indexing": retry with wait: ${SEARCH_WAIT_MAX_SECONDS} to ride it out instead of polling.

Returns { status, hits, detail? } where status is "ready" only when hits are authoritative.`,
            inputSchema: SearchInput,
            outputSchema: SearchResultSchema,
            annotations: { ...ReadOnly, openWorldHint: true },
        },
        async ({ q, limit, wait }) => {
            try {
                const data = await client.search(q, limit, wait);
                if (data.status !== "ready") {
                    // An empty `hits` array that looks like a real answer is the
                    // most dangerous outcome here, so this is an error, not a
                    // successful empty result.
                    return {
                        isError: true,
                        content: [
                            { type: "text", text: searchNotReadyText(data.status, data.detail) },
                        ],
                        structuredContent: data,
                    };
                }
                const lines = data.hits.map((hit) => `${hit.name} (FileDataID ${hit.filedata})`);
                return ok(`${data.hits.length} hit(s) for "${q}"${bullets(lines, limit)}`, data);
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "atlas_prepare_index",
        {
            title: "Prepare Listfile Index (asks the user first)",
            description: `Ask the user for permission to download the ${LISTFILE_SIZE_HINT} name index, then download it.

atlas_search needs this index to turn a texture name into a FileDataID. The download is large and it is NEVER started automatically: this tool shows the user a consent prompt first, and a decline, a cancel, an unanswered prompt or a client with no elicitation support all mean "no download".

  - The user accepts  → the download starts and this call waits up to \`wait\` seconds for it.
  - The user declines → nothing is downloaded; the result names the manual command.

The app also checks the published release every 7 hours and reports \`updateAvailable\` without ever downloading on its own.

Re-running this tool when the index is already current returns immediately and does NOT prompt the user.`,
            inputSchema: z
                .object({
                    wait: z
                        .number()
                        .int()
                        .min(0)
                        .max(SEARCH_WAIT_MAX_SECONDS)
                        .default(SEARCH_WAIT_MAX_SECONDS)
                        .describe(
                            `Seconds to wait for the download to finish after the user accepts ` +
                                `(default ${SEARCH_WAIT_MAX_SECONDS}, the server cap).`,
                        ),
                })
                .strict(),
            outputSchema: SearchCapabilitySchema,
            annotations: { ...Writes, openWorldHint: true },
        },
        async ({ wait }) => {
            try {
                // Ask the app what it already has BEFORE asking the user. Consent
                // for a download that is already done is not a real question, and
                // prompting for it trains people to click through prompts.
                const before = (await client.health()).capabilities.search;

                // "Ready" is not the same as "verified current", and the two gaps
                // are not the same problem:
                //   - no latestRelease yet → the 7-hourly check has not run, so we
                //     simply have no information. Never prompt on absence of news.
                //   - latestRelease but no release → the check ran and the CSV on
                //     disk predates provenance. We cannot vouch for it at all,
                //     and re-downloading is the only way to fix that.
                const unverifiable =
                    before.status === "ready" &&
                    before.latestRelease !== undefined &&
                    before.release === undefined;

                if (before.status === "ready" && before.updateAvailable !== true && !unverifiable) {
                    return ok(
                        `The listfile index is already ready (${before.entries.toLocaleString("en-US")} names` +
                            `${before.release ? `, release ${before.release}` : ""}). Nothing to download, ` +
                            `so no permission was requested.`,
                        before,
                    );
                }
                if (before.refreshing) {
                    return ok(
                        `A ${LISTFILE_SIZE_HINT} refresh is already downloading (started earlier by ` +
                            `whoever authorized it). Joining it instead of prompting again.`,
                        before,
                    );
                }

                const consent = await requestListfileConsent(server, {
                    mode:
                        before.status !== "ready"
                            ? "build"
                            : before.updateAvailable
                              ? "update"
                              : "unverifiable",
                    release: before.release,
                    latestRelease: before.latestRelease,
                });

                if (!consent.granted) {
                    // isError, and structuredContent: a skipped download is a
                    // failed step the agent must react to, not a quiet success.
                    const capability: SearchCapability = {
                        status: before.status,
                        entries: before.entries,
                        detail: consent.reason,
                    };
                    // Refusing a refresh and refusing a first download are very
                    // different outcomes for the agent: one leaves search fully
                    // working, the other leaves it dead. Saying "unavailable"
                    // in both cases would teach agents to panic over nothing.
                    const consequence =
                        before.status === "ready"
                            ? `The existing index is untouched and atlas_search keeps working` +
                              `${before.release ? ` (still release ${before.release})` : ", though its release remains unknown"}.`
                            : `atlas_search stays unavailable, and its zero hits are NOT a real answer.`;
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text:
                                    `Not downloaded — the user did not authorize the ${LISTFILE_SIZE_HINT} download ` +
                                    `(${consent.reason}).\n` +
                                    `${consequence}\n` +
                                    `Next step: ${MANUAL_FETCH_HINT} If they approve that, ` +
                                    `call this tool again.`,
                            },
                        ],
                        structuredContent: capability,
                    };
                }

                const capability = await client.fetchListfile(wait);

                if (capability.status === "ready") {
                    return ok(
                        `Listfile index ready: ${capability.entries.toLocaleString("en-US")} names` +
                            `${capability.release ? ` (release ${capability.release})` : ""}. ` +
                            `atlas_search works now.`,
                        capability,
                    );
                }
                if (capability.status === "indexing") {
                    return ok(
                        `Download of the ${LISTFILE_SIZE_HINT} index is in flight and did not finish within ` +
                            `${wait}s. atlas_search returns isError until it lands — retry it with ` +
                            `wait: ${SEARCH_WAIT_MAX_SECONDS}, or poll atlas_server_status.`,
                        capability,
                    );
                }
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text:
                                `The authorized download did not produce a usable index (status "${capability.status}"). ` +
                                `${capability.detail ?? "No detail reported."} ${MANUAL_FETCH_HINT}`,
                        },
                    ],
                    structuredContent: capability,
                };
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

    server.registerTool(
        "atlas_blp_islands",
        {
            title: "Detect Texture Islands",
            description: `Give it a .blp file and get back every opaque island (connected alpha component) as a
pixel bounding box. No FileDataID needed — works on any local .blp file.

Pass \`blp\` as a filesystem path ("/home/you/textures/Atlas.blp") or as base64 bytes; a
path is read from disk for you, so you never have to encode it yourself. Both BLP1 and BLP2
are supported — a bad input is reported as an invalid-path/bad-base64 error, not as an
unsupported BLP version.

Returns { width, height, islands: [{ x, y, w, h, npx }] } sorted top-to-left.
Use the pixel rects directly with atlas_blp_tc to get SetTexCoord values, or pass them
to atlas_scan's sheet.members after computing right = x+w and bottom = y+h.

gap  (default 1): pixel gap between runs before they are considered separate islands.
minpx (default 16): ignore islands with fewer opaque pixels (removes 1-px noise).`,
            inputSchema: z
                .object({
                    blp: z
                        .string()
                        .describe(
                            "The .blp file: either a filesystem path (absolute, relative, or file:// URL) " +
                                "or base64-encoded raw bytes. A path is read from disk and encoded for you.",
                        ),
                    gap: z.number().int().min(0).max(32).default(1).optional(),
                    minpx: z.number().int().min(1).default(16).optional(),
                })
                .strict(),
            outputSchema: BlpIslandsResponseSchema,
            annotations: { ...ReadOnly, openWorldHint: false },
        },
        async ({ blp, gap, minpx }) => {
            try {
                const data = await client.blpIslands(resolveBlpBytes(blp), { gap, minpx });
                const lines = data.islands.map(
                    (isle, i) =>
                        `#${i + 1}: ${isle.w}×${isle.h} at (${isle.x},${isle.y}) — ${isle.npx}px`,
                );
                return ok(
                    `${data.width}×${data.height}, ${data.islands.length} island(s)${bullets(lines)}`,
                    data,
                );
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "atlas_blp_alpha",
        {
            title: "Measure Alpha Margins",
            description: `Give it a .blp file and get the first opaque row/column on each side of the sheet —
the minimum margin before any content starts. Useful for measuring nine-slice borders
without opening the file in an image editor.

Pass \`blp\` as a filesystem path or as base64 bytes; a path is read from disk for you.
Both BLP1 and BLP2 are supported.

Returns { width, height, top, right, bottom, left } where each value is the 0-based
pixel index of the first opaque content on that side (0 = content touches the edge,
equal to dimension = fully transparent on that side).`,
            inputSchema: z
                .object({
                    blp: z
                        .string()
                        .describe(
                            "The .blp file: either a filesystem path (absolute, relative, or file:// URL) " +
                                "or base64-encoded raw bytes. A path is read from disk and encoded for you.",
                        ),
                })
                .strict(),
            outputSchema: BlpAlphaResponseSchema,
            annotations: { ...ReadOnly, openWorldHint: false },
        },
        async ({ blp }) => {
            try {
                const data = await client.blpAlpha(resolveBlpBytes(blp));
                return ok(
                    `${data.width}×${data.height} — margins top:${data.top} right:${data.right} bottom:${data.bottom} left:${data.left}`,
                    data,
                );
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "atlas_blp_tc",
        {
            title: "Convert Texture Coordinates",
            description: `Convert between pixel rects and SetTexCoord [0,1] coordinates for a sheet of known size.
No BLP file required — only the sheet dimensions and either a pixel rect (x, y, w, h) or
normalized coords (left, right, top, bottom).

Returns both representations plus a ready-to-paste Lua :SetTexCoord(...) call using
integer-over-dimension fractions (e.g. :SetTexCoord(64/256, 96/256, 0/128, 32/128)).`,
            inputSchema: z
                .object({
                    width: z.number().int().positive(),
                    height: z.number().int().positive(),
                    px: z
                        .object({
                            x: z.number(),
                            y: z.number(),
                            w: z.number(),
                            h: z.number(),
                        })
                        .optional(),
                    tc: z
                        .object({
                            left: z.number(),
                            right: z.number(),
                            top: z.number(),
                            bottom: z.number(),
                        })
                        .optional(),
                })
                .strict(),
            outputSchema: BlpTcResponseSchema,
            annotations: { ...ReadOnly, openWorldHint: false },
        },
        async ({ width, height, px, tc }) => {
            if ((px !== undefined) === (tc !== undefined)) {
                return fail(new Error("Provide exactly one of px or tc."));
            }
            try {
                const data = await client.blpTc({ width, height, px, tc });
                const { px: p, tc: n, stc } = data;
                return ok(
                    `px (${p.x},${p.y} ${p.w}×${p.h}) → tc (${n.left.toFixed(4)},${n.right.toFixed(4)},${n.top.toFixed(4)},${n.bottom.toFixed(4)}) — ${stc}`,
                    data,
                );
            } catch (error) {
                return fail(error);
            }
        },
    );
}
