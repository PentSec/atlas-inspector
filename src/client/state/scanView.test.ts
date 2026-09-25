import { describe, expect, it } from "vitest";
import type { ScannedRegion } from "../../shared/scan.js";
import { scanExact, scanLuaText, scanRows } from "./scanView.js";

const scans: ScannedRegion[] = [
    {
        source: "table",
        key: "BUTTON_UP",
        texture: "Interface\\Addons\\A\\UI\\buttons8x8",
        u0: 0,
        u1: 0.25,
        v0: 0,
        v1: 0.5,
        dw: 32,
        dh: 32,
        m: [4, 4, 4, 4],
        line: 3,
    },
    {
        source: "stc",
        key: "myFrame",
        texture: null,
        u0: 0.5,
        u1: 0.25,
        v0: 0,
        v1: 0.25,
        dw: null,
        dh: null,
        m: null,
        line: 9,
    },
    {
        source: "xml",
        key: "icon",
        texture: "Interface\\Icons\\Foo",
        u0: 0.5 / 256,
        u1: 0.5,
        v0: 0,
        v1: 1,
        dw: null,
        dh: null,
        m: null,
        line: 2,
    },
];

const members = [
    { left: 0, top: 0, right: 64, bottom: 64 },
    { left: 128, top: 0, right: 192, bottom: 64 },
];

describe("scanRows", () => {
    it("maps normalized coords to sheet pixel rects and matches members", () => {
        const rows = scanRows(scans, 256, 128, members);
        const r0 = rows[0]!;
        expect(r0.px).toEqual({ left: 0, top: 0, right: 64, bottom: 64 });
        expect(r0.matched).toBe(0);
        expect(r0.flipX).toBe(false);
    });

    it("keeps declared display size when present, else uses the piece size", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(rows[0]!.dw).toBe(32);
        expect(rows[0]!.dh).toBe(32);
        expect(rows[1]!.dw).toBe(64);
        expect(rows[1]!.dh).toBe(32);
    });

    it("flags flipped entries without reordering the rect", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(rows[1]!.flipX).toBe(true);
        expect(rows[1]!.flipY).toBe(false);
        expect(rows[1]!.px).toEqual({ left: 64, top: 0, right: 128, bottom: 32 });
    });

    it("flags subpixel-exact entries and reports error in px otherwise", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(scanExact(rows[0]!)).toBe(true);
        expect(rows[0]!.err).toBe(0);
        expect(scanExact(rows[2]!)).toBe(false);
        expect(rows[2]!.err).toBeCloseTo(0.5);
    });

    it("keeps rows usable without a sheet (no px, norm coordinates)", () => {
        const rows = scanRows(scans, 0, 0, []);
        expect(rows[0]!.px).toBeNull();
        expect(rows[0]!.matched).toBe(-1);
        expect(rows[0]!.err).toBeNull();
        expect(rows[0]!.stcLine).toBe(":SetTexCoord(0.000000, 0.250000, 0.000000, 0.500000)");
    });

    it("exposes nine-slice margins as an L,T,R,B label", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(rows[0]!.marginLabel).toBe("4,4,4,4");
        expect(rows[1]!.marginLabel).toBeNull();
    });

    it("builds a SetTexCoord-ready pixel line", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(rows[0]!.stcLine).toBe(":SetTexCoord(0/256, 64/256, 0/128, 64/128)");
    });
});

describe("scanLuaText", () => {
    it("default style reproduces the legacy fragment format", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(scanLuaText(rows, 256, 128, "default")).toBe(
            `  ['BUTTON_UP'] = { PACK, 32, 32, 0.000000, 0.250000, 0.000000, 0.500000 },\n` +
                `  ['myFrame'] = { PACK, 64, 32, 0.250000, 0.500000, 0.000000, 0.250000 },\n` +
                `  ['icon'] = { PACK, 128, 128, 0.001953, 0.500000, 0.000000, 1.000000 },`,
        );
    });

    it("coords style writes integer fractions and the piece size comment", () => {
        const rows = scanRows(scans, 256, 128, members);
        expect(scanLuaText(rows, 256, 128, "coords")).toBe(
            `['BUTTON_UP'] = { 0/256, 64/256, 0/128, 64/128 }, -- 64x64 px\n` +
                `['myFrame'] = { 64/256, 128/256, 0/128, 32/128 }, -- 64x32 px\n` +
                `['icon'] = { 0.5/256, 128/256, 0/128, 128/128 }, -- 127.5x128 px`,
        );
    });
});
