import { describe, expect, it } from "vitest";
import {
    flippedX,
    flippedY,
    matchMemberRect,
    orderedRect,
    parseTableEntry,
    regionToPx,
    scanCode,
    scanLua,
    scanXml,
} from "../../src/shared/scan.js";

describe("scan", () => {
    describe("parseTableEntry", () => {
        it("parses coords-first positional {TEX, l, r, t, b}", () => {
            const e = parseTableEntry("'Interface\\Icons\\icon', 0, 0.25, 0, 0.25", new Map());
            expect(e).toMatchObject({
                texture: "Interface\\Icons\\icon",
                u0: 0,
                u1: 0.25,
                v0: 0,
                v1: 0.25,
                dw: null,
                dh: null,
                m: null,
            });
        });

        it("parses coords-first with display size and margins {TEX, l,r,t,b, dw,dh, mL,mT,mR,mB}", () => {
            const e = parseTableEntry(
                "'Interface\\Buttons\\btn', 0, 0.5, 0, 0.5, 64, 64, 8, 4, 8, 4",
                new Map(),
            );
            expect(e).toMatchObject({
                texture: "Interface\\Buttons\\btn",
                u0: 0,
                u1: 0.5,
                v0: 0,
                v1: 0.5,
                dw: 64,
                dh: 64,
                m: [8, 4, 8, 4],
            });
        });

        it("parses dims-first positional {TEX, dw, dh, l, r, t, b}", () => {
            const e = parseTableEntry(
                "'Interface\\Buttons\\btn', 128, 64, 0, 0.5, 0.25, 0.75",
                new Map(),
            );
            expect(e).toMatchObject({ texture: "Interface\\Buttons\\btn", dw: 128, dh: 64, u0: 0, u1: 0.5, v0: 0.25, v1: 0.75, m: null });
        });

        it("parses keyed entries with left/right/top/bottom", () => {
            const e = parseTableEntry(
                "left = 0, top = 0.1, right = 0.9, bottom = 0.8, texture = 'X'",
                new Map(),
            );
            expect(e).toMatchObject({ texture: "X", u0: 0, u1: 0.9, v0: 0.1, v1: 0.8 });
        });

        it("parses nested coords = { ... } with a file key", () => {
            const e = parseTableEntry(
                "file = 'Y', coords = { 0, 0.5, 0, 0.5 }, width = 32, height = 32",
                new Map(),
            );
            expect(e).toMatchObject({ texture: "Y", u0: 0, u1: 0.5, v0: 0, v1: 0.5, dw: 32, dh: 32 });
        });

        it("supports a/b fractions in coords", () => {
            const e = parseTableEntry("'Interface\\Buttons\\btn', 2/256, 10/256, 4/128, 12/128", new Map());
            expect(e).toMatchObject({ u0: 2 / 256, u1: 10 / 256, v0: 4 / 128, v1: 12 / 128 });
        });

        it("supports symbol resolution for coords", () => {
            const syms = new Map<string, string>([["L", "0.25"], ["TM", "0.5"]]);
            const e = parseTableEntry("'Interface\\Buttons\\btn', L, 0.5, TM, 1", syms);
            expect(e).toMatchObject({ texture: "Interface\\Buttons\\btn", u0: 0.25, v0: 0.5, v1: 1 });
        });
    });

    describe("scanLua", () => {
        it("collects inline SetTexCoord with a resolved texture symbol", () => {
            const code = [
                'local TEX = "Interface\\Buttons\\foo"',
                'TEX:SetTexCoord(0, 0.5, 0, 0.5)',
            ].join("\n");
            const out = scanLua(code);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({ source: "stc", key: "TEX", texture: "Interface\\Buttons\\foo", line: 2 });
        });

        it("skips commented-out blocks and preserves line numbers", () => {
            const code = [
                "--[[",
                "local X = 'Interface\\a'",
                "X:SetTexCoord(0, 1, 0, 1)",
                "]]",
                "local Y = 'Interface\\b'",
                "Y:SetTexCoord(0.25, 0.75, 0.5, 1)",
            ].join("\n");
            const out = scanLua(code);
            expect(out).toHaveLength(1);
            expect(out[0]!.line).toBe(6);
        });

        it("finds sparse table region entries", () => {
            const code = [
                "local T = {}",
                "T['icon_a'] = { 'Interface\\Icons\\a', 0, 0.25, 0, 0.25 }",
                "T['icon_b'] = { 'Interface\\Icons\\b', 0.25, 1, 0, 1, 64, 64 }",
                "T['icon_c'] = { 'Interface\\Icons\\c', 0, 0.5, 0, 0.5, 32, 32, 4, 4, 4, 4 }",
            ].join("\n");
            const out = scanLua(code);
            expect(out.map((e) => e.key)).toEqual(["icon_a", "icon_b", "icon_c"]);
            expect(out[1]).toMatchObject({ dw: 64, dh: 64, m: null });
            expect(out[2]).toMatchObject({ dw: 32, dh: 32, m: [4, 4, 4, 4] });
        });

        it("resolves a texture symbol used as a table value", () => {
            const code = [
                'local MAINTEX = "Interface\\Common"',
                "T['x'] = { MAINTEX, 0, 0.25, 0, 0.25 }",
            ].join("\n");
            const out = scanLua(code);
            expect(out[0]).toMatchObject({ texture: "Interface\\Common" });
        });
    });

    describe("scanXml", () => {
        it("parses a Texture with a TexCoords child", () => {
            const code = [
                '<Texture name="Button" file="Interface\\Buttons\\ui">',
                '    <TexCoords left="0" right="0.5" top="0" bottom="0.5"/>',
                "</Texture>",
            ].join("\n");
            const out = scanXml(code);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({
                source: "xml",
                key: "Button",
                texture: "Interface\\Buttons\\ui",
                line: 1,
            });
            expect(out[0]!.v1).toBe(0.5);
        });

        it("skips blocks without a recognizable texture path", () => {
            const code = '<Texture name="X" file="Interface\\Good"><TexCoords left="0" right="1" top="0" bottom="1"/></Texture>' +
                '<Texture name="Y"><TexCoords left="0" right="1" top="0" bottom="1"/></Texture>';
            const out = scanXml(code);
            expect(out).toHaveLength(1);
            expect(out[0]!.key).toBe("X");
        });
    });

    describe("scanCode dialect detection", () => {
        it("routes XML-looking input to the XML scanner", () => {
            const out = scanCode("<Texture file=\"Interface\\a\"><TexCoords left=\"0\" right=\"0.5\" top=\"0\" bottom=\"0.5\"/></Texture>");
            expect(out[0]!.source).toBe("xml");
        });

        it("routes Lua input to the Lua scanner", () => {
            const out = scanCode("T['k'] = { 'Interface\\a', 0, 0.5, 0, 0.5 }");
            expect(out[0]!.source).toBe("table");
        });
    });

    describe("geometry helpers", () => {
        it("detects flips without normalizing away", () => {
            expect(flippedX({ u0: 1, u1: 0 })).toBe(true);
            expect(flippedX({ u0: 0, u1: 1 })).toBe(false);
            expect(flippedY({ v0: 0.5, v1: 0 })).toBe(true);
        });

        it("returns an ordered rect for flipped input", () => {
            expect(orderedRect({ u0: 0.75, u1: 0.25, v0: 0.5, v1: 0 })).toEqual({ u0: 0.25, u1: 0.75, v0: 0, v1: 0.5 });
        });

        it("converts normalized to pixel rect on a sheet", () => {
            expect(regionToPx({ u0: 0.25, u1: 0.5, v0: 0, v1: 0.5 }, 256, 128)).toEqual({
                left: 64,
                top: 0,
                right: 128,
                bottom: 64,
            });
        });

        it("matches the member with the largest overlap", () => {
            const members = [
                { left: 0, top: 0, right: 32, bottom: 32 },
                { left: 64, top: 64, right: 128, bottom: 128 },
            ];
            const hit = matchMemberRect({ u0: 0.24, u1: 0.27, v0: 0.24, v1: 0.27 }, 256, 256, members);
            expect(hit).toBe(1);
            const miss = matchMemberRect({ u0: 0.9, u1: 0.95, v0: 0.9, v1: 0.95 }, 256, 256, members);
            expect(miss).toBe(-1);
        });
    });
});