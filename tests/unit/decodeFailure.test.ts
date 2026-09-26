/**
 * A 422 must name the real cause.
 *
 * `decodeToPngOrThrow` used to swallow every decoder error and answer "BLP
 * format not supported". That single sentence launched a week-long hunt for a
 * decoder that could not read BLP2 — while the actual payload was a multipart
 * form envelope that had never contained a BLP. These tests pin the two
 * distinct diagnoses so the vague one can never come back.
 */
import { describe, expect, it } from "vitest";

import { Pinta365BlpDecoder } from "../../src/server/adapters/pinta365Blp.js";
import { DecodeService } from "../../src/server/services/decodeService.js";
import { UnprocessableError } from "../../src/server/errors.js";
import type { FileCache } from "../../src/server/lib/cache.js";
import type { BlpDecoder } from "../../src/server/adapters/blpDecoder.js";

const MAX = 64 * 1024 * 1024;

const noopCache: FileCache = {
    async getFromDisk() {
        return null;
    },
    async setFromBuffer() {},
} as unknown as FileCache;

function serviceWith(decoder: BlpDecoder): DecodeService {
    return new DecodeService({ decoder, decodeCache: noopCache, maxBytes: MAX });
}

async function detailOf(decode: (svc: DecodeService) => Promise<unknown>): Promise<string> {
    try {
        await decode(serviceWith(new Pinta365BlpDecoder()));
        throw new Error("expected a rejection");
    } catch (error) {
        if (error instanceof UnprocessableError) return error.toProblem().detail;
        throw error;
    }
}

describe("decode failures name the real cause", () => {
    it("says the body is not a BLP when the magic is wrong", async () => {
        const multipart = Buffer.from(
            '------X\r\nContent-Disposition: form-data; name="file"\r\n\r\nBLP2fake\r\n------X--\r\n',
        );
        const detail = await detailOf((svc) => svc.decodeToPngOrThrow(multipart));
        expect(detail).toMatch(/not a BLP file/i);
        expect(detail).toMatch(/application\/octet-stream/);
    });

    it("names multipart form uploads explicitly, since that is the real-world trap", async () => {
        const detail = await detailOf((svc) => svc.decodeToPngOrThrow(Buffer.from("--boundary--")));
        expect(detail).toMatch(/curl -F/);
        expect(detail).toMatch(/bad payload, not an unsupported BLP version/i);
    });

    it("never blames the BLP version for a payload that is not a BLP", async () => {
        const detail = await detailOf((svc) =>
            svc.decodeToPngOrThrow(Buffer.from("hello world, padding")),
        );
        expect(detail).not.toMatch(/^BLP format not supported$/);
    });

    it("still decodes a real BLP2 fixture, proving the guard is not over-eager", async () => {
        const real = await import("node:fs").then(({ readFileSync }) =>
            readFileSync(new URL("../fixtures/blp/5548240.blp", import.meta.url)),
        );
        const decoded = await serviceWith(new Pinta365BlpDecoder()).decodeToPngOrThrow(real);
        expect(decoded.width).toBe(1024);
        expect(decoded.height).toBe(1024);
    });
});
