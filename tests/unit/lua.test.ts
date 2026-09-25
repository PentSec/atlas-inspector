import { describe, expect, it } from "vitest";
import {
    displaySizeFallback,
    luaEscape,
    luaExport,
    luaExportStyled,
    luaFracCoords,
    luaRegionEntry,
    luaStyledLine,
    texCoordLineNorm,
    texCoordLinePx,
} from "../../src/shared/lua.js";

const region = {
    name: "icon_a",
    left: 2,
    right: 10,
    top: 4,
    bottom: 12,
    dispW: 8,
    dispH: 8,
    sheetW: 256,
    sheetH: 128,
};

describe("lua", () => {
    it("escapes single quotes and backslashes", () => {
        expect(luaEscape("it's a \\ test")).toBe("it\\'s a \\\\ test");
        expect(luaEscape("plain")).toBe("plain");
    });

    it("emits the historical entry format with 6 decimals", () => {
        const entry = luaRegionEntry({
            name: "icon_yellow",
            left: 10,
            right: 42,
            top: 4,
            bottom: 36,
            dispW: 32,
            dispH: 32,
            sheetW: 256,
            sheetH: 128,
        });
        expect(entry).toBe(
            "  ['icon_yellow'] = { PACK, 32, 32, 0.039063, 0.164063, 0.031250, 0.281250 },",
        );
    });

    it("escapes names inside the entry", () => {
        const entry = luaRegionEntry({
            name: "a'b\\c",
            left: 0,
            right: 8,
            top: 0,
            bottom: 8,
            dispW: 8,
            dispH: 8,
            sheetW: 8,
            sheetH: 8,
        });
        expect(entry.startsWith("  ['a\\'b\\\\c'] = ")).toBe(true);
    });

    it("joins entries newline-separated", () => {
        const r = (name: string, x: number): Parameters<typeof luaRegionEntry>[0] => ({
            name,
            left: x,
            right: x + 8,
            top: 0,
            bottom: 8,
            dispW: 8,
            dispH: 8,
            sheetW: 8,
            sheetH: 8,
        });
        const out = luaExport([r("a", 0), r("b", 8)]);
        expect(out.split("\n")).toHaveLength(2);
        expect(out).toContain("['a']");
        expect(out).toContain("['b']");
    });

    it("falls back to half the rect when display size is unset (historical parity)", () => {
        const f = displaySizeFallback({
            displayW: 0,
            displayH: 0,
            left: 0,
            right: 100,
            top: 0,
            bottom: 40,
        });
        expect(f).toEqual({ dispW: 50, dispH: 20 });
    });

    it("keeps a real override over the fallback", () => {
        const f = displaySizeFallback({
            displayW: 12,
            displayH: 7,
            left: 0,
            right: 100,
            top: 0,
            bottom: 40,
        });
        expect(f).toEqual({ dispW: 12, dispH: 7 });
    });
});

describe("lua styles", () => {
    it("emits coords-only with an integer-fraction quad and px comment", () => {
        expect(luaStyledLine(region, "coords")).toBe(
            "['icon_a'] = { 2/256, 10/256, 4/128, 12/128 }, -- 8x8 px",
        );
    });

    it("emits atlasinfo", () => {
        expect(luaStyledLine(region, "atlasinfo")).toBe(
            "['icon_a'] = { PACK, 8, 8, 2/256, 10/256, 4/128, 12/128 },",
        );
    });

    it("emits sheetfirst", () => {
        expect(luaStyledLine(region, "sheetfirst")).toBe(
            "['icon_a'] = { PACK, 2/256, 10/256, 4/128, 12/128, 8, 8 },",
        );
    });

    it("emits a custom tex reference for sheet variants", () => {
        expect(luaStyledLine(region, "atlasinfo", "ATLAS")).toBe(
            "['icon_a'] = { ATLAS, 8, 8, 2/256, 10/256, 4/128, 12/128 },",
        );
    });

    it("emits xml TexCoords with 6 decimals and the px comment", () => {
        expect(luaStyledLine(region, "xml")).toBe(
            '<TexCoords left="0.007813" right="0.039063" top="0.031250" bottom="0.093750"/> <!-- icon_a 8x8 px -->',
        );
    });

    it("default style delegates to the legacy exporter", () => {
        expect(luaStyledLine(region, "default")).toBeNull();
        expect(luaExportStyled([region], "default")).toBe(luaExport([region]));
    });

    it("joins styled entries newline-separated", () => {
        const out = luaExportStyled([region, { ...region, name: "icon_b", right: 18 }], "coords");
        expect(out.split("\n")).toHaveLength(2);
        expect(out).toContain("['icon_a']");
        expect(out).toContain("['icon_b']");
    });

    it("builds integer-fraction coordinate quads", () => {
        expect(luaFracCoords(2, 10, 4, 12, 256, 128)).toBe("2/256, 10/256, 4/128, 12/128");
    });

    it("emits pixel-exact SetTexCoord lines", () => {
        expect(texCoordLinePx(2, 10, 4, 12, 256, 128)).toBe(":SetTexCoord(2/256, 10/256, 4/128, 12/128)");
    });

    it("emits raw SetTexCoord from a scanned region (no reordering)", () => {
        expect(texCoordLineNorm(0.0078125, 0.0390625, 0.03125, 0.09375)).toBe(
            ":SetTexCoord(0.007813, 0.039063, 0.031250, 0.093750)",
        );
    });
});
