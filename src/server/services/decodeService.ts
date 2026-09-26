/**
 * Decode service — BLP -> PNG with content-hash caching and size limits.
 * The /api/decode legacy contract (md5) is replaced by SHA-256 for the key and
 * the cache name now includes the checksum paradigm (ADR-008/ADR-013).
 */
import { createHash } from "node:crypto";
import type { BlpDecodeResult } from "../../shared/types.js";
import type { BlpDecoder, BlpHeader } from "../adapters/blpDecoder.js";
import {
    blpAlphaDepth,
    compressionLabel,
    parseBlpHeader,
    pngSize,
} from "../adapters/blpDecoder.js";
import { BadRequestError, PayloadTooLargeError, UnprocessableError } from "../errors.js";
import type { FileCache } from "../lib/cache.js";

export interface DecodeServiceOptions {
    decoder: BlpDecoder;
    decodeCache: FileCache;
    maxBytes: number;
}

export class DecodeService {
    private readonly opts: DecodeServiceOptions;

    constructor(opts: DecodeServiceOptions) {
        this.opts = opts;
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
            } catch {
                throw new UnprocessableError("BLP format not supported");
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
