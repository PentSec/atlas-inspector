/**
 * The `blp` tool argument: a path OR base64, never a silent failure.
 *
 * Regression guard for the exact bug that sent an agent hunting for a phantom
 * "BLP2 is not supported" bug. The old code did `Buffer.from(blp, "base64")`
 * unconditionally, so a path string became garbage bytes, the API answered
 * 422 "BLP format not supported", and the only visible evidence was a format
 * error naming a format that was in fact never present in the payload.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlpInputError, MAX_BLP_BYTES, resolveBlpBytes } from "../../src/mcp/blpInput.js";

/** A 1x1 BLP2: 4-byte magic plus padding up to the 0x9c header minimum. */
const BLP2_BYTES = Buffer.concat([Buffer.from("BLP2", "latin1"), Buffer.alloc(0xa0)]);
const BLP1_BYTES = Buffer.concat([Buffer.from("BLP1", "latin1"), Buffer.alloc(0xa0)]);

let dir: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "atlas-blp-input-"));
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("resolveBlpBytes — paths", () => {
    it("reads an absolute path", () => {
        const path = join(dir, "abs.blp");
        writeFileSync(path, BLP2_BYTES);
        expect(resolveBlpBytes(path).equals(BLP2_BYTES)).toBe(true);
    });

    it("resolves a relative path against cwd", () => {
        writeFileSync(join(dir, "rel.blp"), BLP1_BYTES);
        expect(resolveBlpBytes("rel.blp", dir).equals(BLP1_BYTES)).toBe(true);
    });

    it("treats a bare filename as a path, not base64 (the real-world case)", () => {
        writeFileSync(join(dir, "RarityGemAtlas.blp"), BLP2_BYTES);
        expect(resolveBlpBytes("RarityGemAtlas.blp", dir).equals(BLP2_BYTES)).toBe(true);
    });

    it("accepts a file:// URL", () => {
        const path = join(dir, "url.blp");
        writeFileSync(path, BLP2_BYTES);
        expect(resolveBlpBytes(`file://${path}`).equals(BLP2_BYTES)).toBe(true);
    });

    it("rejects a directory", () => {
        expect(() => resolveBlpBytes(dir)).toThrow(BlpInputError);
        expect(() => resolveBlpBytes(dir)).toThrow(/not a file/);
    });

    it("names the unreadable path instead of blaming the format", () => {
        const missing = join(dir, "nope.blp");
        expect(() => resolveBlpBytes(missing)).toThrow(/cannot be read/);
        expect(() => resolveBlpBytes(missing)).toThrow(missing);
    });
});

describe("resolveBlpBytes — base64", () => {
    it("accepts base64 with no newline", () => {
        expect(resolveBlpBytes(BLP2_BYTES.toString("base64")).equals(BLP2_BYTES)).toBe(true);
    });

    it("accepts wrapped base64", () => {
        const wrapped = BLP2_BYTES.toString("base64").replace(/(.{64})/g, "$1\n");
        expect(resolveBlpBytes(wrapped).equals(BLP2_BYTES)).toBe(true);
    });
});

describe("resolveBlpBytes — refuses to fake a format error", () => {
    it("rejects a path that does not exist with a path error, not a format error", () => {
        const result = (() => {
            try {
                resolveBlpBytes("./does-not-exist-anywhere.blp");
                return null;
            } catch (error) {
                return error as Error;
            }
        })();
        expect(result).toBeInstanceOf(BlpInputError);
        expect(result?.message).not.toMatch(/unsupported/i);
    });

    it("rejects non-BLP bytes and says the payload is not a texture", () => {
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]);
        expect(() => resolveBlpBytes(png.toString("base64"))).toThrow(/not a WoW texture/);
    });

    it('never says "unsupported" for a bad magic', () => {
        try {
            resolveBlpBytes(Buffer.from("NOTABLP____________________").toString("base64"));
            expect.unreachable("should have thrown");
        } catch (error) {
            expect((error as Error).message).toMatch(/do not report this as an unsupported/i);
        }
    });

    it("rejects empty input", () => {
        expect(() => resolveBlpBytes("   ")).toThrow(/empty/);
    });

    it("rejects base64 that decodes to almost nothing", () => {
        expect(() => resolveBlpBytes("QUJD")).toThrow(/cannot be a BLP/);
    });

    it("rejects text that is neither a path nor base64, naming both remedies", () => {
        const run = () => resolveBlpBytes("not base64!! not a path");
        expect(run).toThrow(/cannot be read/);
        expect(run).toThrow(/base64/);
    });
});

describe("resolveBlpBytes — bounds", () => {
    it("caps oversized files", () => {
        expect(MAX_BLP_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
    });

    it("accepts a BLP1 magic just as readily as BLP2", () => {
        expect(resolveBlpBytes(BLP1_BYTES.toString("base64")).toString("latin1", 0, 4)).toBe(
            "BLP1",
        );
        expect(resolveBlpBytes(BLP2_BYTES.toString("base64")).toString("latin1", 0, 4)).toBe(
            "BLP2",
        );
    });
});
