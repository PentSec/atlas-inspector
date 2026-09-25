/**
 * Lua export — the ONE implementation shared by client, server and agent.
 * Reproduces the historical `.lua` output byte-for-byte except for a fixed
 * bug: backslashes are now escaped too (previously only `'` was).
 */

export interface LuaRegionInput {
    name: string;
    /** integer pixels; left/top inclusive, right/bottom exclusive */
    left: number;
    right: number;
    top: number;
    bottom: number;
    /** display size written into the exported entry */
    dispW: number;
    dispH: number;
    /** sheet size used to normalize coordinates */
    sheetW: number;
    sheetH: number;
}

/** Escape a string for a single-quoted Lua literal (handles `\` and `'`). */
export function luaEscape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const SIX = (v: number): string => v.toFixed(6);

/**
 * One entry:
 *   ['name'] = { PACK, dispW, dispH, left/W, right/W, top/H, bottom/H },
 * `PACK` is a placeholder for the caller's texture reference.
 */
export function luaRegionEntry(r: LuaRegionInput, indent = "  "): string {
    return (
        `${indent}['${luaEscape(r.name)}'] = { PACK, ${r.dispW}, ${r.dispH}, ` +
        `${SIX(r.left / r.sheetW)}, ${SIX(r.right / r.sheetW)}, ` +
        `${SIX(r.top / r.sheetH)}, ${SIX(r.bottom / r.sheetH)} },`
    );
}

export function luaExport(regions: ReadonlyArray<LuaRegionInput>): string {
    return regions.map((r) => luaRegionEntry(r)).join("\n");
}

/**
 * Display size fallback used when DB2 provides no override (historical parity:
 * the display is assumed to be half the source rect for sprite sheets).
 */
export function displaySizeFallback(region: {
    displayW: number;
    displayH: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}): { dispW: number; dispH: number } {
    return {
        dispW: region.displayW || Math.round((region.right - region.left) / 2),
        dispH: region.displayH || Math.round((region.bottom - region.top) / 2),
    };
}

// ---------------------------------------------------------------------------
// Export styles (coords / atlasinfo / sheetfirst / xml)
// ---------------------------------------------------------------------------

export type LuaExportStyle = "default" | "coords" | "atlasinfo" | "sheetfirst" | "xml";

export const LUA_EXPORT_STYLES: ReadonlyArray<{ id: LuaExportStyle; label: string }> = [
    { id: "default", label: "Default (legacy)" },
    { id: "coords", label: "Coords only" },
    { id: "atlasinfo", label: "AtlasInfo" },
    { id: "sheetfirst", label: "SheetFirst" },
    { id: "xml", label: "XML TexCoords" },
];

/** Integer-fraction coordinate quadruple, e.g. `2/256, 10/256, 4/128, 12/128`. */
export function luaFracCoords(
    l: number,
    r: number,
    t: number,
    b: number,
    W: number,
    H: number,
): string {
    return `${l}/${W}, ${r}/${W}, ${t}/${H}, ${b}/${H}`;
}

/**
 * One style line. Coordinates are written as exact integer fractions of the
 * sheet size (e.g. `2/256`) so pasting Lua never carries float error.
 */
export function luaStyledLine(
    s: LuaRegionInput & { name: string },
    style: LuaExportStyle,
    texRef = "PACK",
): string | null {
    const { name, left: l, right: r, top: t, bottom: b, dispW, dispH, sheetW: W, sheetH: H } = s;
    const fr = luaFracCoords(l, r, t, b, W, H);
    const pw = Math.abs(r - l);
    const ph = Math.abs(b - t);
    switch (style) {
        case "coords":
            return `['${luaEscape(name)}'] = { ${fr} }, -- ${pw}x${ph} px`;
        case "atlasinfo":
            return `['${luaEscape(name)}'] = { ${texRef}, ${g(dispW)}, ${g(dispH)}, ${fr} },`;
        case "sheetfirst":
            return `['${luaEscape(name)}'] = { ${texRef}, ${fr}, ${g(dispW)}, ${g(dispH)} },`;
        case "xml":
            return `<TexCoords left="${SIX(l / W)}" right="${SIX(r / W)}" top="${SIX(t / H)}" bottom="${SIX(b / H)}"/> <!-- ${name} ${pw}x${ph} px -->`;
        default:
            return null;
    }
}

export function luaExportStyled(
    regions: ReadonlyArray<LuaRegionInput>,
    style: LuaExportStyle,
    texRef = "PACK",
): string {
    if (style === "default") return luaExport(regions);
    return regions
        .map((r) => luaStyledLine(r, style, texRef))
        .filter((l): l is string => l !== null)
        .join("\n");
}

/** `%g`-style: shortest numeric decimal, integers without trailing `.0`. */
const g = (v: number): string => (Number.isInteger(v) ? String(v) : String(+v.toFixed(6)));

/**
 * SetTexCoord-ready line for a pixel rect on a W×H sheet, e.g.
 * `:SetTexCoord(2/256, 10/256, 4/128, 12/128)`.
 */
export function texCoordLinePx(
    l: number,
    r: number,
    t: number,
    b: number,
    W: number,
    H: number,
): string {
    return `:SetTexCoord(${luaFracCoords(l, r, t, b, W, H)})`;
}

/** SetTexCoord line from a scanned region's normalized coords, unnormalized. */
export function texCoordLineNorm(u0: number, u1: number, v0: number, v1: number): string {
    return `:SetTexCoord(${SIX(u0)}, ${SIX(u1)}, ${SIX(v0)}, ${SIX(v1)})`;
}
