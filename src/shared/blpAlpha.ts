/**
 * Alpha-channel measurements on a decoded sheet (one byte per pixel).
 */

export interface AlphaMargins {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

function opaque(
    alpha: Uint8Array,
    width: number,
    x: number,
    y: number,
    threshold: number,
): boolean {
    return (alpha[y * width + x] ?? 0) >= threshold;
}

/**
 * Minimum transparent inset on each side before any pixel meets `threshold`.
 * `0` means content touches that edge; the matching dimension means the sheet
 * is fully transparent from that side.
 */
export function alphaMargins(
    alpha: Uint8Array,
    width: number,
    height: number,
    threshold = 1,
): AlphaMargins {
    let top = height;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (opaque(alpha, width, x, y, threshold)) {
                top = y;
                y = height;
                break;
            }
        }
    }

    let bottom = height;
    for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
            if (opaque(alpha, width, x, y, threshold)) {
                bottom = height - 1 - y;
                y = -1;
                break;
            }
        }
    }

    let left = width;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (opaque(alpha, width, x, y, threshold)) {
                left = x;
                x = width;
                break;
            }
        }
    }

    let right = width;
    for (let x = width - 1; x >= 0; x--) {
        for (let y = 0; y < height; y++) {
            if (opaque(alpha, width, x, y, threshold)) {
                right = width - 1 - x;
                x = -1;
                break;
            }
        }
    }

    return { top, right, bottom, left };
}

/** Binary 0/1 mask: 1 when alpha ≥ `threshold`. */
export function alphaToBinary(alpha: Uint8Array, threshold = 128): Uint8Array {
    const out = new Uint8Array(alpha.length);
    for (let i = 0; i < alpha.length; i++) out[i] = (alpha[i] ?? 0) >= threshold ? 1 : 0;
    return out;
}
