import { describe, expect, it } from "vitest";
import { findIslands } from "../../src/shared/islands.js";

function bin(rows: string[]): Uint8Array {
    const h = rows.length;
    const w = Math.max(...rows.map((r) => r.length));
    const out = new Uint8Array(w * h);
    rows.forEach((r, y) => {
        for (let x = 0; x < r.length; x++) out[y * w + x] = r[x] === "#" ? 1 : 0;
    });
    return out;
}

describe("findIslands", () => {
    it("finds a single box", () => {
        const isl = findIslands(bin(["....", ".##.", ".##.", "...."]), 4, 4, 1, 1);
        expect(isl).toEqual([{ x: 1, y: 1, w: 2, h: 2, npx: 4 }]);
    });

    it("keeps separate components apart", () => {
        const isl = findIslands(bin(["##..##", "##..##", "##..##"]), 6, 3, 1, 1);
        expect(isl).toHaveLength(2);
        expect(isl[0]).toEqual({ x: 0, y: 0, w: 2, h: 3, npx: 6 });
        expect(isl[1]).toEqual({ x: 4, y: 0, w: 2, h: 3, npx: 6 });
    });

    it("merges components separated by a 1-pixel gap when gap=1", () => {
        const isl = findIslands(bin(["###", "...", "###"]), 3, 3, 1, 4);
        expect(isl).toEqual([{ x: 0, y: 0, w: 3, h: 3, npx: 6 }]);
    });

    it("keeps components split when gap=0", () => {
        const isl = findIslands(bin(["###", "...", "###"]), 3, 3, 0, 2);
        expect(isl).toHaveLength(2);
        expect(isl.every((i) => i.h === 1)).toBe(true);
    });

    it("filters small components by minpx", () => {
        const isl = findIslands(bin(["#.##", "...."]), 4, 2, 0, 16);
        expect(isl).toHaveLength(0);
    });

    it("sorts by (y, x)", () => {
        const isl = findIslands(bin(["#...#...", "........", "#...#...", "........"]), 8, 4, 0, 1);
        expect(isl.map((i) => [i.x, i.y])).toEqual([
            [0, 0],
            [4, 0],
            [0, 2],
            [4, 2],
        ]);
    });
});
