/**
 * Decoder + header-parsing tests on REAL BLP fixtures (tests/fixtures/blp).
 * These are the ADR-008 groundwork: the metadata parser must read the same
 * offsets @pinta365/blp reads, and every fixture must decode to a PNG.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { Pinta365BlpDecoder } from "../../src/server/adapters/pinta365Blp.js";
import {
    blpAlphaDepth,
    compressionLabel,
    parseBlpHeader,
    pngSize,
} from "../../src/server/adapters/blpDecoder.js";

const fixture = (name: string) =>
    readFileSync(path.join(import.meta.dirname, "../../tests/fixtures/blp", name));

describe("parseBlpHeader (real BLP2 fixtures)", () => {
    it("reads the 1024x1024 DXT5-with-alpha atlas", () => {
        const h = parseBlpHeader(fixture("5548240.blp"));
        expect(h).toMatchObject({
            compressionId: 2,
            alphaSize: 8,
            preferredFormat: 7,
            mipmaps: 1,
            width: 1024,
            height: 1024,
        });
        expect(compressionLabel(h)).toBe("dxt5");
        expect(blpAlphaDepth(h)).toBe(8);
    });

    it("reads the 64x64 DXT1 icon with 7 mipmaps", () => {
        const h = parseBlpHeader(fixture("134400.blp"));
        expect(h).toMatchObject({
            compressionId: 2,
            preferredFormat: 0,
            mipmaps: 7,
            width: 64,
            height: 64,
        });
        expect(compressionLabel(h)).toBe("dxt1");
        expect(blpAlphaDepth(h)).toBe(1);
    });

    it("reads the 8x8 plain texture", () => {
        const h = parseBlpHeader(fixture("130871.blp"));
        expect(h).toMatchObject({
            compressionId: 2,
            preferredFormat: 0,
            mipmaps: 4,
            width: 8,
            height: 8,
        });
        expect(compressionLabel(h)).toBe("dxt1");
        expect(blpAlphaDepth(h)).toBe(1);
    });

    it("rejects non-BLP input", () => {
        expect(() => parseBlpHeader(Buffer.from("hello, definitely not a blp"))).toThrow();
        expect(() => parseBlpHeader(Buffer.alloc(8))).toThrow();
    });
});

describe("Pinta365BlpDecoder (real fixtures)", () => {
    const decoder = new Pinta365BlpDecoder();

    it("decodes every fixture to a PNG with honest dimensions", async () => {
        const cases = [
            ["5548240.blp", 1024, 1024],
            ["134400.blp", 64, 64],
            ["130871.blp", 8, 8],
        ] as const;
        for (const [file, w, h] of cases) {
            const png = await decoder.decodeToPng(fixture(file));
            expect(pngSize(png.png)).toEqual({ w, h });
            expect(png.png.subarray(0, 8)).toEqual(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            );
        }
    });
});
