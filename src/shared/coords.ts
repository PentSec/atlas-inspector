/**
 * Region/coordinate math.
 *
 * Convention (shared, fixed): pixel origin top-left, +y down,
 * `left`/`top` inclusive, `right`/`bottom` exclusive.
 * Normalized rects use `u` for the horizontal axis and `v` for vertical.
 */

import type { Region } from "./types.js";

export interface NormalizedRect {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
}

export function regionWidth(r: Pick<Region, "left" | "right">): number {
    return r.right - r.left;
}

export function regionHeight(r: Pick<Region, "top" | "bottom">): number {
    return r.bottom - r.top;
}

/**
 * Normalize a region onto a sheet. `u0 = left/width`, `u1 = right/width`, etc.
 * Returns null when the sheet has no area.
 */
export function normalizedRect(
    r: Pick<Region, "left" | "right" | "top" | "bottom">,
    sheetW: number,
    sheetH: number,
): NormalizedRect | null {
    if (sheetW <= 0 || sheetH <= 0) return null;
    return {
        u0: r.left / sheetW,
        u1: r.right / sheetW,
        v0: r.top / sheetH,
        v1: r.bottom / sheetH,
    };
}

/** True when the point is inside the region (right/bottom exclusive). */
export function containsPoint(
    r: Pick<Region, "left" | "right" | "top" | "bottom">,
    x: number,
    y: number,
): boolean {
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

export interface ClampedRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/**
 * Clamp a rectangle to the sheet and enforce minimum width/height.
 * Returns null when the rectangle is degenerate after clamping.
 */
export function clampRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    sheetW: number,
    sheetH: number,
): ClampedRect | null {
    const left = Math.max(0, Math.min(Math.round(x1), Math.round(x2)));
    const right = Math.min(sheetW, Math.max(Math.round(x1), Math.round(x2)));
    const top = Math.max(0, Math.min(Math.round(y1), Math.round(y2)));
    const bottom = Math.min(sheetH, Math.max(Math.round(y1), Math.round(y2)));
    if (right - left < 1 || bottom - top < 1) return null;
    return { left, top, right, bottom };
}
