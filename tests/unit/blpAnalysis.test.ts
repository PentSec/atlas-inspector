import { describe, expect, it } from "vitest";
import { pngAlphaChannel, pngSize } from "../../src/server/adapters/blpDecoder.js";
import { alphaMargins, alphaToBinary } from "../../src/shared/blpAlpha.js";
import { BlpTcRangeError, convertBlpTc } from "../../src/shared/blpTc.js";
import {
    BlpAlphaResponseSchema,
    BlpIslandsResponseSchema,
    BlpTcRequestSchema,
    BlpTcResponseSchema,
} from "../../src/shared/schemas.js";
import { encodeRgbaPng, islandSheetPng } from "../helpers/rgbaPng.js";

describe("BLP analysis schemas", () => {
    it("parses a valid islands payload and rejects a bad box", () => {
        const ok = {
            width: 8,
            height: 8,
            islands: [{ x: 2, y: 2, w: 4, h: 4, npx: 16 }],
        };
        expect(BlpIslandsResponseSchema.parse(ok)).toEqual(ok);
        expect(
            BlpIslandsResponseSchema.safeParse({
                width: 8,
                height: 8,
                islands: [{ x: 0, y: 0, w: 0, h: 1, npx: 1 }],
            }).success,
        ).toBe(false);
    });

    it("parses alpha margins and rejects negatives", () => {
        const ok = { width: 8, height: 8, top: 2, right: 2, bottom: 2, left: 2 };
        expect(BlpAlphaResponseSchema.parse(ok)).toEqual(ok);
        expect(BlpAlphaResponseSchema.safeParse({ ...ok, top: -1 }).success).toBe(false);
    });

    it("parses a tc response", () => {
        const ok = {
            width: 256,
            height: 128,
            px: { x: 64, y: 0, w: 32, h: 32 },
            tc: { left: 0.25, right: 0.375, top: 0, bottom: 0.25 },
            stc: ":SetTexCoord(64/256, 96/256, 0/128, 32/128)",
        };
        expect(BlpTcResponseSchema.parse(ok)).toEqual(ok);
    });

    it("requires exactly one of px or tc", () => {
        const base = { width: 256, height: 128 };
        const px = { x: 64, y: 0, w: 32, h: 32 };
        const tc = { left: 0.25, right: 0.375, top: 0, bottom: 0.25 };
        expect(BlpTcRequestSchema.safeParse({ ...base, px }).success).toBe(true);
        expect(BlpTcRequestSchema.safeParse({ ...base, tc }).success).toBe(true);
        expect(BlpTcRequestSchema.safeParse(base).success).toBe(false);
        expect(BlpTcRequestSchema.safeParse({ ...base, px, tc }).success).toBe(false);
    });
});

describe("convertBlpTc", () => {
    it("round-trips px → tc → px", () => {
        const first = convertBlpTc({
            width: 256,
            height: 128,
            px: { x: 64, y: 0, w: 32, h: 32 },
        });
        expect(first.tc).toEqual({ left: 64 / 256, right: 96 / 256, top: 0, bottom: 32 / 128 });
        expect(first.stc).toBe(":SetTexCoord(64/256, 96/256, 0/128, 32/128)");
        const back = convertBlpTc({ width: 256, height: 128, tc: first.tc });
        expect(back.px).toEqual({ x: 64, y: 0, w: 32, h: 32 });
    });

    it("round-trips tc → px → tc", () => {
        const tc = { left: 0.5, right: 0.75, top: 0.25, bottom: 0.5 };
        const first = convertBlpTc({ width: 64, height: 64, tc });
        expect(first.px).toEqual({ x: 32, y: 16, w: 16, h: 16 });
        const back = convertBlpTc({ width: 64, height: 64, px: first.px });
        expect(back.tc).toEqual(tc);
    });

    it("rejects a rect that leaves the sheet", () => {
        expect(() =>
            convertBlpTc({ width: 16, height: 16, px: { x: 12, y: 0, w: 8, h: 4 } }),
        ).toThrow(BlpTcRangeError);
        expect(() =>
            convertBlpTc({
                width: 16,
                height: 16,
                tc: { left: 0, right: 1.1, top: 0, bottom: 1 },
            }),
        ).toThrow(BlpTcRangeError);
    });
});

describe("pngAlphaChannel + margins", () => {
    it("reads alpha from a real RGBA PNG", () => {
        const png = islandSheetPng();
        expect(pngSize(png)).toEqual({ w: 8, h: 8 });
        const alpha = pngAlphaChannel(png);
        expect(alpha.length).toBe(64);
        expect(alpha[2 * 8 + 2]).toBe(255);
        expect(alpha[0]).toBe(0);
        const bin = alphaToBinary(alpha, 128);
        expect(bin[2 * 8 + 2]).toBe(1);
        expect(alphaMargins(alpha, 8, 8, 1)).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
    });

    it("treats fully transparent sheets as dimension-sized margins", () => {
        const png = encodeRgbaPng(4, 4, new Uint8Array(4 * 4 * 4));
        const alpha = pngAlphaChannel(png);
        expect(alphaMargins(alpha, 4, 4, 1)).toEqual({ top: 4, right: 4, bottom: 4, left: 4 });
    });
});
