/**
 * Connected-component (island) detection on a binary bitmap, used to auto-fill
 * define-mode regions from the sheet's alpha channel.
 *
 * Semantics (kept deliberately simple and pixel-exact): a run of set pixels is
 * merged into a component when it is within `1+gap` rows below an existing run
 * and its horizontal span touches within `1+gap` pixels. Reported boxes are
 * axis-aligned bounding boxes; `npx` counts set pixels.
 */

export interface Island {
    x: number;
    y: number;
    w: number;
    h: number;
    npx: number;
}

/**
 * @param binary 0/1 bitmap, row-major, length w*h
 * @param gap    0 keeps adjacent-row runs, >=1 merges runs separated by `gap`
 * @param minpx  components with fewer set pixels are dropped
 */
export function findIslands(
    binary: Uint8Array,
    w: number,
    h: number,
    gap = 1,
    minpx = 16,
): Island[] {
    const reach = 1 + gap;
    const parent: number[] = [];
    const runs: Array<[y: number, x0: number, x1: number]> = [];
    const rows: number[][] = [];

    const find = (i: number): number => {
        while (parent[i] !== i) {
            const p = parent[i]!;
            parent[i] = parent[p]!;
            i = p;
        }
        return i;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };

    for (let y = 0; y < h; y++) {
        const row: number[] = [];
        const base = y * w;
        let x = 0;
        while (x < w) {
            if (binary[base + x] === 1) {
                let x1 = x;
                while (x1 + 1 < w && binary[base + x1 + 1] === 1) x1++;
                const rid = runs.length;
                runs.push([y, x, x1]);
                parent.push(rid);
                row.push(rid);
                for (let dy = 1; dy <= reach; dy++) {
                    if (y - dy < 0) break;
                    for (const oid of rows[y - dy]!) {
                        const [, ox0, ox1] = runs[oid]!;
                        if (ox0 - reach <= x1 && x <= ox1 + reach) union(rid, oid);
                    }
                }
                if (gap > 0) {
                    for (const oid of row.slice(0, -1)) {
                        const [, , ox1] = runs[oid]!;
                        if (x - ox1 <= reach) union(rid, oid);
                    }
                }
                x = x1 + 1;
            } else {
                x++;
            }
        }
        rows.push(row);
    }

    const comp = new Map<
        number,
        [minX: number, minY: number, maxX: number, maxY: number, npx: number]
    >();
    for (let rid = 0; rid < runs.length; rid++) {
        const [y, x0, x1] = runs[rid]!;
        const root = find(rid);
        const n = x1 - x0 + 1;
        const b = comp.get(root);
        if (b) {
            b[0] = Math.min(b[0], x0);
            b[1] = Math.min(b[1], y);
            b[2] = Math.max(b[2], x1);
            b[3] = Math.max(b[3], y);
            b[4] += n;
        } else {
            comp.set(root, [x0, y, x1, y, n]);
        }
    }

    const out: Island[] = [];
    for (const r of comp.values()) {
        if (r[4] >= minpx) {
            out.push({ x: r[0], y: r[1], w: r[2] - r[0] + 1, h: r[3] - r[1] + 1, npx: r[4] });
        }
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    return out;
}
