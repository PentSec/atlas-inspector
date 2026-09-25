import { describe, expect, it } from "vitest";
import { memberEntry, atlasLuaFragment, atlasJson, atlasLuaStyled } from "./export.js";
import type { AtlasResultOk } from "../../shared/schemas.js";

const atlas: AtlasResultOk = {
    kind: "atlas",
    filedata: 5548240,
    build: "3.4.3.60000",
    atlas: {
        id: 101,
        filedata: 5548240,
        width: 256,
        height: 128,
    },
    members: [
        {
            name: "button_up",
            left: 0,
            right: 64,
            top: 0,
            bottom: 64,
            width: 64,
            height: 64,
            overrideW: 0,
            overrideH: 0,
            displayW: 0,
            displayH: 0,
            elementId: "",
        },
        {
            name: "icon_a'b\\c",
            left: 64,
            right: 128,
            top: 0,
            bottom: 64,
            width: 64,
            height: 64,
            overrideW: 128,
            overrideH: 64,
            displayW: 128,
            displayH: 64,
            elementId: "",
        },
    ],
};

const halfIdle: AtlasResultOk = {
    kind: "atlas",
    filedata: 1,
    build: "x",
    atlas: { id: 1, filedata: 1, width: 100, height: 50 },
    members: [
        {
            name: "half",
            left: 0,
            right: 50,
            top: 0,
            bottom: 25,
            width: 50,
            height: 25,
            overrideW: 0,
            overrideH: 0,
            displayW: 0,
            displayH: 0,
            elementId: "",
        },
    ],
};

describe("memberEntry", () => {
    it("uses the half-rect display size when no override (legacy displaySizeFallback)", () => {
        const line = memberEntry(halfIdle.members[0]!, halfIdle);
        expect(line).toBe(`  ['half'] = { PACK, 25, 13, 0.000000, 0.500000, 0.000000, 0.500000 },`);
    });

    it("formats full rect + packed coordinates (parity format)", () => {
        const line = memberEntry(atlas.members[0]!, atlas);
        expect(line).toBe(
            `  ['button_up'] = { PACK, 32, 32, 0.000000, 0.250000, 0.000000, 0.500000 },`,
        );
    });

    it("honours overrideW/overrideH display size", () => {
        const line = memberEntry(atlas.members[1]!, atlas);
        expect(line).toBe(
            `  ['icon_a\\'b\\\\c'] = { PACK, 128, 64, 0.250000, 0.500000, 0.000000, 0.500000 },`,
        );
    });
});

describe("atlasLuaFragment", () => {
    it("joins entries with newlines", () => {
        expect(atlasLuaFragment(atlas)).toBe(
            `  ['button_up'] = { PACK, 32, 32, 0.000000, 0.250000, 0.000000, 0.500000 },\n` +
                `  ['icon_a\\'b\\\\c'] = { PACK, 128, 64, 0.250000, 0.500000, 0.000000, 0.500000 },`,
        );
    });
});

describe("atlasJson", () => {
    it("serializes the atlas", () => {
        expect(JSON.parse(atlasJson(halfIdle)).atlas.width).toBe(100);
    });
});

describe("atlasLuaStyled", () => {
    it("default style is byte-identical to the legacy fragment", () => {
        expect(atlasLuaStyled(atlas, "default")).toBe(atlasLuaFragment(atlas));
    });

    it("coords style writes integer fractions without display size", () => {
        expect(atlasLuaStyled(halfIdle, "coords")).toBe(
            `['half'] = { 0/100, 50/100, 0/50, 25/50 }, -- 50x25 px`,
        );
    });

    it("atlasinfo style leads with the texture ref and display size", () => {
        expect(atlasLuaStyled(halfIdle, "atlasinfo")).toBe(
            `['half'] = { PACK, 25, 13, 0/100, 50/100, 0/50, 25/50 },`,
        );
    });

    it("xml style emits TexCoords with fixed decimals and a name comment", () => {
        expect(atlasLuaStyled(halfIdle, "xml")).toBe(
            `<TexCoords left="0.000000" right="0.500000" top="0.000000" bottom="0.500000"/> <!-- half 50x25 px -->`,
        );
    });
});
