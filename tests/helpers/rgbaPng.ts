import { crc32, deflateSync } from "node:zlib";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head));
    return Buffer.concat([len, head, crc]);
}

/** Minimal 8-bit RGBA PNG encoder for tests (filter None). */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const stride = width * 4;
    const raw = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + stride)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
            raw,
            y * (1 + stride) + 1,
        );
    }
    return Buffer.concat([
        PNG_SIG,
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** 8×8 sheet: opaque 4×4 block at (2,2), rest transparent. */
export function islandSheetPng(): Buffer {
    const w = 8;
    const h = 8;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 2; y < 6; y++) {
        for (let x = 2; x < 6; x++) {
            const i = (y * w + x) * 4;
            rgba[i] = 255;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = 255;
        }
    }
    return encodeRgbaPng(w, h, rgba);
}
