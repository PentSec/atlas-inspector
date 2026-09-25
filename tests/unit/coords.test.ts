import { describe, expect, it } from "vitest";
import {
    clampRect,
    containsPoint,
    normalizedRect,
    regionHeight,
    regionWidth,
} from "../../src/shared/coords.js";
import type { Region } from "../../src/shared/types.js";

const region: Region = {
    name: "R",
    left: 10,
    top: 4,
    right: 42,
    bottom: 36,
    width: 32,
    height: 32,
    overrideW: 0,
    overrideH: 0,
    displayW: 32,
    displayH: 32,
    elementId: "e",
};

describe("coords", () => {
    it("region width/height", () => {
        expect(regionWidth(region)).toBe(32);
        expect(regionHeight(region)).toBe(32);
    });

    it("normalizes against the sheet", () => {
        const n = normalizedRect(region, 256, 128);
        expect(n).toEqual({ u0: 10 / 256, u1: 42 / 256, v0: 4 / 128, v1: 36 / 128 });
    });

    it("normalization yields null for a degenerate sheet", () => {
        expect(normalizedRect(region, 0, 128)).toBeNull();
        expect(normalizedRect(region, 256, 0)).toBeNull();
    });

    it("containsPoint is left/top inclusive, right/bottom exclusive", () => {
        expect(containsPoint(region, 10, 4)).toBe(true);
        expect(containsPoint(region, 41, 35)).toBe(true);
        expect(containsPoint(region, 42, 36)).toBe(false);
        expect(containsPoint(region, 9, 20)).toBe(false);
        expect(containsPoint(region, 20, 3)).toBe(false);
        expect(containsPoint(region, 20, 36)).toBe(false);
    });

    it("clampRect orders/swaps corners and clamps to the sheet", () => {
        expect(clampRect(50, 10, 10, 4, 256, 128)).toEqual({
            left: 10,
            top: 4,
            right: 50,
            bottom: 10,
        });
        expect(clampRect(-5, -5, 300, 200, 256, 128)).toEqual({
            left: 0,
            top: 0,
            right: 256,
            bottom: 128,
        });
    });

    it("clampRect returns null for a degenerate selection", () => {
        expect(clampRect(10, 10, 10, 20, 256, 128)).toBeNull();
        expect(clampRect(10, 10, 20, 10, 256, 128)).toBeNull();
        expect(clampRect(300, 300, 299, 299, 256, 128)).toBeNull();
    });
});
