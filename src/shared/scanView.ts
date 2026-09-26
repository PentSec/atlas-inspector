/**
 * Pure derivation for scanned addon entries (DOM-free, node-testable, shared by
 * the client scan panel and the POST /api/v1/scan endpoint).
 * Turns scanned entries into sheet-relative rows: pixel rects, member matches,
 * pixel-exactness, flip flags and SetTexCoord/export strings.
 */
import {
    flippedX,
    flippedY,
    matchMemberRect,
    orderedRect,
    regionToPx,
    type ScannedRegion,
} from "./scan.js";
import { luaExportStyled, texCoordLineNorm, texCoordLinePx, type LuaExportStyle } from "./lua.js";

export interface PixelRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ScanRow {
    src: ScannedRegion;
    /** pixel rect on the current sheet, null when no sheet is loaded */
    px: PixelRect | null;
    /** display size shown next to the entry (declared or piece size) */
    dw: number;
    dh: number;
    /** member index whose pixel rect overlaps most, -1 when none */
    matched: number;
    /** largest subpixel corner error in px, null without a sheet */
    err: number | null;
    flipX: boolean;
    flipY: boolean;
    /** SetTexCoord line for this entry (px when normalized is possible) */
    stcLine: string;
    /** "L,T,R,B" nine-slice margins in px, null when absent */
    marginLabel: string | null;
}

/** Exact-pixel threshold: corners must land within 1/100 px. */
const EXACT_EPS = 0.01;

export function scanRows(
    scans: ReadonlyArray<ScannedRegion>,
    sheetW: number,
    sheetH: number,
    members: ReadonlyArray<{ left: number; top: number; right: number; bottom: number }>,
): ScanRow[] {
    const hasSheet = sheetW > 0 && sheetH > 0;
    return scans.map((src) => {
        const px = hasSheet ? regionToPx(src, sheetW, sheetH) : null;
        const pw = px ? Math.abs(px.right - px.left) : 0;
        const ph = px ? Math.abs(px.bottom - px.top) : 0;
        const dw = src.dw ?? Math.round(pw);
        const dh = src.dh ?? Math.round(ph);
        const matched = px && members.length ? matchMemberRect(src, sheetW, sheetH, members) : -1;
        let err: number | null = null;
        if (px) {
            const o = orderedRect(src);
            const corners = [o.u0 * sheetW, o.u1 * sheetW, o.v0 * sheetH, o.v1 * sheetH];
            err = Math.max(...corners.map((v) => Math.abs(v - Math.round(v))));
        }
        const stcLine = px
            ? texCoordLinePx(px.left, px.right, px.top, px.bottom, sheetW, sheetH)
            : texCoordLineNorm(src.u0, src.u1, src.v0, src.v1);
        const marginLabel = src.m ? `${src.m[0]},${src.m[1]},${src.m[2]},${src.m[3]}` : null;
        return {
            src,
            px,
            dw,
            dh,
            matched,
            err,
            flipX: flippedX(src),
            flipY: flippedY(src),
            stcLine,
            marginLabel,
        };
    });
}

/** True when a row's corners land within the exact-pixel tolerance. */
export function scanExact(row: ScanRow): boolean {
    return row.px !== null && (row.err === null || row.err <= EXACT_EPS);
}

/** Whole scan as stylized Lua (default = legacy byte-compatible entries). */
export function scanLuaText(
    rows: ReadonlyArray<ScanRow>,
    sheetW: number,
    sheetH: number,
    style: LuaExportStyle,
    texRef = "PACK",
): string {
    const inputs = rows
        .filter((r) => r.px !== null)
        .map((r) => ({
            name: r.src.key,
            left: r.px!.left,
            right: r.px!.right,
            top: r.px!.top,
            bottom: r.px!.bottom,
            dispW: r.dw,
            dispH: r.dh,
            sheetW,
            sheetH,
        }));
    return luaExportStyled(inputs, style, texRef);
}
