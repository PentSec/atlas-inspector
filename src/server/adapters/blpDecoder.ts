/**
 * BLP decoding contract (ADR-008). Swap targets hide behind this interface —
 * today `@pinta365/blp`, tomorrow `wow-blp-web` if goldens fail.
 */
import { inflateSync } from "node:zlib";
export interface DecodedBlp {
    width: number;
    height: number;
    /** encoded PNG bytes of the decoded sheet */
    png: Buffer;
}

/** BLP magic numbers (verified against @pinta365/blp, the reference decoder). */
export const BLP1_MAGIC = "BLP1";
export const BLP2_MAGIC = "BLP2";

export interface BlpHeader {
    /** BLP2 `compression` byte: 0=JPEG, 1=palette(RAW1), 2=DXTC, 3=RAW3 (ARGB). */
    compressionId: number;
    /** BLP2 `alpha size` byte (0x09). */
    alphaSize: number;
    /** BLP2 `preferred format` byte (0x0A) — selects DXT1/3/5 when DXTC. */
    preferredFormat: number;
    /** How many mip offsets are nonzero (the real mipmap count). */
    mipmaps: number;
    width: number;
    height: number;
}

/**
 * Parse a BLP header (BLP1 or BLP2) using the same offsets @pinta365/blp reads.
 * Throws when the input is not a BLP.
 */
export function parseBlpHeader(buf: Buffer): BlpHeader {
    if (buf.length < 0x9c) throw new Error("BLP truncated");
    const magic = buf.toString("latin1", 0, 4);
    if (magic === BLP2_MAGIC) return parseBlp2Header(buf);
    if (magic === BLP1_MAGIC) return parseBlp1Header(buf);
    throw new Error("not a BLP file");
}

/** BLP2 header: offsets 0x08..0x14, LE dims, 16 mip offsets at 0x14. */
function parseBlp2Header(buf: Buffer): BlpHeader {
    const compressionId = buf.readUInt8(0x08);
    const alphaSize = buf.readUInt8(0x09);
    const preferredFormat = buf.readUInt8(0x0a);
    let mipmaps = 0;
    for (let i = 0; i < 16; i++) {
        if (buf.readUInt32LE(0x14 + i * 4) !== 0) mipmaps++;
    }
    return {
        compressionId,
        alphaSize,
        preferredFormat,
        mipmaps,
        width: buf.readUInt32LE(0x0c),
        height: buf.readUInt32LE(0x10),
    };
}

/** BLP1 header: content at 0x04, alphaBitDepth at 0x08, dims at 0x0c/0x10.
 *  Renderable variants are 0 (JPEG) and 1 (paletted, RAW1). */
function parseBlp1Header(buf: Buffer): BlpHeader {
    const content = buf.readUInt32LE(0x04);
    const alphaBitDepth = buf.readUInt32LE(0x08);
    let mipmaps = 0;
    for (let i = 0; i < 16; i++) {
        if (buf.readUInt32LE(0x1c + i * 4) !== 0) mipmaps++;
    }
    return {
        compressionId: content,
        alphaSize: alphaBitDepth,
        preferredFormat: 0,
        mipmaps,
        width: buf.readUInt32LE(0x0c),
        height: buf.readUInt32LE(0x10),
    };
}

const COMPRESSION_LABELS: Record<number, string> = {
    0: "jpeg",
    1: "raw1",
    2: "dxt1",
    3: "raw3",
};
const DXT_LABELS: Record<number, "dxt1" | "dxt3" | "dxt5"> = {
    1: "dxt3",
    7: "dxt5",
};

/** Human label for a BLP header (ADR-008 naming, aligned with @pinta365/blp). */
export function compressionLabel(header: BlpHeader): string {
    const label = COMPRESSION_LABELS[header.compressionId];
    if (label === undefined) return "unknown";
    if (header.compressionId === 2) {
        // DXTC flavour lives in the preferred-format byte: 1 -> DXT3, 7 -> DXT5,
        // anything else (usually 0) -> DXT1.
        return DXT_LABELS[header.preferredFormat] ?? label;
    }
    return label;
}

export interface BlpDecoder {
    /** Decode a BLP buffer to PNG bytes. Throws when unsupported/corrupt. */
    decodeToPng(input: Buffer): Promise<DecodedBlp>;
}

/** Best-effort alpha bit depth for a parsed header (not stored as such in BLP2). */
export function blpAlphaDepth(header: BlpHeader): number {
    switch (header.compressionId) {
        case 1: // paletted RAW1: alpha channel width lives in alphaSize
            return Math.min(8, header.alphaSize);
        case 2: // DXTC: DXT1 has 1 mask bit, DXT3/5 have explicit 8-bit alpha
            return header.preferredFormat === 1 || header.preferredFormat === 7 ? 8 : 1;
        case 3: // RAW3 is A8R8G8B8
            return 8;
        default:
            return 0;
    }
}

/** Read dimensions straight from the PNG IHDR (16..24), not from library fields. */
export function pngSize(buf: Buffer): { w: number; h: number } {
    if (buf.length < 24) throw new Error("invalid PNG");
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function unfilter(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number): void {
    switch (filter) {
        case 0:
            return;
        case 1:
            for (let i = bpp; i < row.length; i++) row[i] = (row[i]! + row[i - bpp]!) & 255;
            return;
        case 2:
            for (let i = 0; i < row.length; i++) row[i] = (row[i]! + (prev[i] ?? 0)) & 255;
            return;
        case 3:
            for (let i = 0; i < row.length; i++) {
                const left = i >= bpp ? row[i - bpp]! : 0;
                row[i] = (row[i]! + Math.floor((left + (prev[i] ?? 0)) / 2)) & 255;
            }
            return;
        case 4:
            for (let i = 0; i < row.length; i++) {
                const left = i >= bpp ? row[i - bpp]! : 0;
                const up = prev[i] ?? 0;
                const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
                row[i] = (row[i]! + paeth(left, up, upLeft)) & 255;
            }
            return;
        default:
            throw new Error("invalid PNG");
    }
}

/**
 * One alpha byte per pixel from a decoded PNG (IHDR + IDAT). RGB sheets are
 * treated as fully opaque. Throws when the buffer is not a supported PNG.
 */
export function pngAlphaChannel(buf: Buffer): Uint8Array {
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("invalid PNG");

    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];
    const compression = buf[26];
    const filter = buf[27];
    const interlace = buf[28];
    if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("invalid PNG");
    }
    const channels =
        colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
    if (channels === 0 || w < 1 || h < 1) throw new Error("invalid PNG");

    const idats: Buffer[] = [];
    let off = 8;
    while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString("latin1", off + 4, off + 8);
        const start = off + 8;
        const end = start + len;
        if (end + 4 > buf.length) throw new Error("invalid PNG");
        if (type === "IDAT") idats.push(buf.subarray(start, end));
        if (type === "IEND") break;
        off = end + 4;
    }
    if (idats.length === 0) throw new Error("invalid PNG");

    const raw = inflateSync(Buffer.concat(idats));
    const stride = w * channels;
    const rowBytes = stride + 1;
    if (raw.length < h * rowBytes) throw new Error("invalid PNG");

    const alpha = new Uint8Array(w * h);
    const prev = new Uint8Array(stride);
    const row = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
        const base = y * rowBytes;
        const filterType = raw[base]!;
        row.set(raw.subarray(base + 1, base + 1 + stride));
        unfilter(filterType, row, prev, channels);
        prev.set(row);
        for (let x = 0; x < w; x++) {
            if (colorType === 6) alpha[y * w + x] = row[x * 4 + 3]!;
            else if (colorType === 4) alpha[y * w + x] = row[x * 2 + 1]!;
            else alpha[y * w + x] = 255;
        }
    }
    return alpha;
}
