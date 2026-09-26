import type { BlpTcRequest, BlpTcResponse } from "./schemas.js";
import { texCoordLinePx } from "./lua.js";

export class BlpTcRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BlpTcRangeError";
    }
}

function pxToTc(
    width: number,
    height: number,
    px: { x: number; y: number; w: number; h: number },
): { left: number; right: number; top: number; bottom: number } {
    return {
        left: px.x / width,
        right: (px.x + px.w) / width,
        top: px.y / height,
        bottom: (px.y + px.h) / height,
    };
}

function tcToPx(
    width: number,
    height: number,
    tc: { left: number; right: number; top: number; bottom: number },
): { x: number; y: number; w: number; h: number } {
    return {
        x: Math.round(tc.left * width),
        y: Math.round(tc.top * height),
        w: Math.round((tc.right - tc.left) * width),
        h: Math.round((tc.bottom - tc.top) * height),
    };
}

function assertPxInSheet(
    width: number,
    height: number,
    px: { x: number; y: number; w: number; h: number },
): void {
    if (px.w < 1 || px.h < 1) throw new BlpTcRangeError("pixel rect must have positive size");
    if (px.x < 0 || px.y < 0) throw new BlpTcRangeError("pixel rect is outside the sheet");
    if (px.x + px.w > width || px.y + px.h > height) {
        throw new BlpTcRangeError("pixel rect is outside the sheet");
    }
}

function assertTcRange(tc: { left: number; right: number; top: number; bottom: number }): void {
    const vals = [tc.left, tc.right, tc.top, tc.bottom];
    if (vals.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
        throw new BlpTcRangeError("normalized coords must be in [0, 1]");
    }
    if (tc.right <= tc.left || tc.bottom <= tc.top) {
        throw new BlpTcRangeError("normalized coords must form a non-empty rect");
    }
}

/** Convert exactly one of `px` / `tc` into both representations plus a Lua snippet. */
export function convertBlpTc(req: BlpTcRequest): BlpTcResponse {
    const { width, height } = req;
    let px: { x: number; y: number; w: number; h: number };
    let tc: { left: number; right: number; top: number; bottom: number };

    if (req.px !== undefined) {
        px = req.px;
        assertPxInSheet(width, height, px);
        tc = pxToTc(width, height, px);
    } else if (req.tc !== undefined) {
        tc = req.tc;
        assertTcRange(tc);
        px = tcToPx(width, height, tc);
        assertPxInSheet(width, height, px);
    } else {
        throw new BlpTcRangeError("Provide exactly one of px or tc.");
    }

    return {
        width,
        height,
        px,
        tc,
        stc: texCoordLinePx(px.x, px.x + px.w, px.y, px.y + px.h, width, height),
    };
}
