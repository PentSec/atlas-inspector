/**
 * @pinta365/blp adapter (ADR-008). Lazy import keeps the library off the
 * startup path; the whole module is swappable behind `BlpDecoder`.
 */
import type { BlpDecoder, DecodedBlp } from "./blpDecoder.js";
import { pngSize } from "./blpDecoder.js";

export class Pinta365BlpDecoder implements BlpDecoder {
    async decodeToPng(input: Buffer): Promise<DecodedBlp> {
        const { decodeBlpData, encodeToPNGAuto } = await import("@pinta365/blp");
        const decoded = decodeBlpData(new Uint8Array(input));
        const png = Buffer.from(await encodeToPNGAuto(decoded));
        const { w, h } = pngSize(png);
        return { width: w, height: h, png };
    }
}
