/**
 * Decode service — BLP -> PNG with content-hash caching and size limits.
 * The /api/decode legacy contract (md5) is replaced by SHA-256 for the key and
 * the cache name now includes the checksum paradigm (ADR-008/ADR-013).
 */
import { createHash } from "node:crypto";
import type { BlpDecodeResult } from "../../shared/types.js";
import type { BlpDecoder, BlpHeader, DecodedBlp } from "../adapters/blpDecoder.js";
import {
    blpAlphaDepth,
    compressionLabel,
    parseBlpHeader,
    pngAlphaChannel,
    pngSize,
} from "../adapters/blpDecoder.js";
import { BadRequestError, PayloadTooLargeError, UnprocessableError } from "../errors.js";
import type { FileCache } from "../lib/cache.js";

export interface DecodeServiceOptions {
    decoder: BlpDecoder;
    decodeCache: FileCache;
    maxBytes: number;
}

/**
 * Turn a decoder failure into a 422 that names the REAL cause.
 *
 * A blanket `catch {}` here used to report "BLP format not supported" for
 * anything that went wrong — including a multipart envelope, a truncated
 * upload, or a base64 string that was never decoded. That message is a lie
 * about the most common failure (garbage in), and it is expensive: it sent an
 * agent hunting for a nonexistent "BLP2 is not supported" decoder bug while the
 * payload never contained a BLP at all. Distinguish "these bytes are not a BLP"
 * from "this is a BLP but the codec failed" so the caller can act.
 */
function describeDecodeFailure(input: Buffer, error: unknown): string {
    const magic = input.subarray(0, 4).toString("latin1");
    const cause = error instanceof Error ? error.message : String(error);

    if (magic !== "BLP1" && magic !== "BLP2") {
        const shown = magic.replace(/[^\x20-\x7e]/g, ".");
        return (
            `Body is not a BLP file: it starts with "${shown}" (${input.length} bytes). ` +
            `POST raw BLP bytes with Content-Type: application/octet-stream — a multipart form ` +
            `upload (curl -F) sends the form envelope, not the texture. This is a bad payload, not an unsupported BLP version.`
        );
    }

    return (
        `BLP decode failed for a valid ${magic} header: ${cause}. ` +
        `The bytes are a BLP; the codec could not expand this particular one.`
    );
}

export class DecodeService {
    private readonly opts: DecodeServiceOptions;

    constructor(opts: DecodeServiceOptions) {
        this.opts = opts;
    }

    assertRawBlp(input: unknown): Buffer {
        if (!Buffer.isBuffer(input) || input.length === 0) {
            throw new BadRequestError("body must be raw BLP bytes");
        }
        if (input.length > this.opts.maxBytes) {
            throw new PayloadTooLargeError(`BLP exceeds the ${this.opts.maxBytes}-byte limit`);
        }
        return input;
    }

    async decodeToPngOrThrow(input: Buffer): Promise<DecodedBlp> {
        try {
            return await this.opts.decoder.decodeToPng(input);
        } catch (error) {
            throw new UnprocessableError(describeDecodeFailure(input, error));
        }
    }

    /**
     * Decode a BLP and return one alpha byte per pixel (from the PNG adapter).
     * Islands use threshold 128; margin measurement uses threshold 1.
     */
    async alphaChannel(
        input: Buffer,
    ): Promise<{ width: number; height: number; alpha: Uint8Array }> {
        const decoded = await this.decodeToPngOrThrow(input);
        let alpha: Uint8Array;
        try {
            alpha = pngAlphaChannel(decoded.png);
        } catch (error) {
            throw new UnprocessableError(
                `Decoded PNG could not be read for alpha analysis: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        const { w, h } = pngSize(decoded.png);
        return { width: w, height: h, alpha };
    }

    async decode(input: Buffer): Promise<BlpDecodeResult> {
        if (input.length === 0) throw new BadRequestError("bad body size");
        if (input.length > this.opts.maxBytes) {
            throw new PayloadTooLargeError(`BLP exceeds the ${this.opts.maxBytes}-byte limit`);
        }

        const contentHash = createHash("sha256").update(input).digest("hex");
        const entry = `decode_${contentHash}.png`;

        let png = await this.opts.decodeCache.getFromDisk(entry);
        if (!png) {
            let decoded;
            try {
                decoded = await this.opts.decoder.decodeToPng(input);
            } catch (error) {
                throw new UnprocessableError(describeDecodeFailure(input, error));
            }
            png = decoded.png;
            await this.opts.decodeCache.setFromBuffer(entry, png);
        }

        let header: BlpHeader;
        try {
            header = parseBlpHeader(input);
        } catch {
            // decode succeeded but the header is unreadable — extremely unlikely;
            // report what we know and let the client use the PNG itself.
            header = {
                compressionId: -1,
                alphaSize: 0,
                preferredFormat: 0,
                mipmaps: 0,
                width: 0,
                height: 0,
            };
        }
        const { w, h } = pngSize(png);

        return {
            kind: "ok",
            width: w,
            height: h,
            compression: compressionLabel(header) as BlpDecodeResult["compression"],
            compressionId: header.compressionId,
            alphaSize: header.alphaSize,
            alphaDepth: blpAlphaDepth(header),
            mipmaps: header.mipmaps,
            contentHash,
            pngUrl: `/api/cache/${entry}`,
        };
    }
}
