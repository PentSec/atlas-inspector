import { describe, expect, it } from "vitest";
import {
    buildGte,
    buildInRange,
    buildParts,
    cmpBuild,
    newestFirst,
    newestOf,
} from "../../src/shared/buildVersion.js";

describe("buildVersion", () => {
    it("parses 4-part builds", () => {
        expect(buildParts("10.2.5.52646")).toEqual([10, 2, 5, 52646]);
    });

    it("defaults missing parts to zero", () => {
        expect(buildParts("10.2")).toEqual([10, 2, 0, 0]);
        expect(buildParts("12.0.5")).toEqual([12, 0, 5, 0]);
    });

    it("handles null/undefined/empty like zeros", () => {
        expect(buildParts(null)).toEqual([0, 0, 0, 0]);
        expect(buildParts(undefined)).toEqual([0, 0, 0, 0]);
        expect(buildParts("")).toEqual([0, 0, 0, 0]);
    });

    it("parses non-numeric parts as zero", () => {
        expect(buildParts("x.y.z.w")).toEqual([0, 0, 0, 0]);
        expect(buildParts("10.dev.5.1")).toEqual([10, 0, 5, 1]);
    });

    it("compares across all four parts", () => {
        expect(cmpBuild("10.2.5.52646", "10.2.5.52646")).toBe(0);
        expect(cmpBuild("10.2.5.52646", "10.2.5.52645")).toBeGreaterThan(0);
        expect(cmpBuild("10.2.5.52646", "10.2.6.0")).toBeLessThan(0);
        expect(cmpBuild("10.2.5.52646", "10.3.0.0")).toBeLessThan(0);
        expect(cmpBuild("10.2.5.52646", "11.0.0.0")).toBeLessThan(0);
        expect(cmpBuild("12.1.5.69594", "10.2.5.52646")).toBeGreaterThan(0);
    });

    it("buildGte", () => {
        expect(buildGte("10.2.5.52646", "10.0.0.0")).toBe(true);
        expect(buildGte("10.0.0.0", "10.0.0.0")).toBe(true);
        expect(buildGte("9.2.5.1", "10.0.0.0")).toBe(false);
    });

    it("buildInRange is half-open [lo, hi)", () => {
        expect(buildInRange("10.5.0.1", [10, 0, 0, 0], [11, 0, 0, 0])).toBe(true);
        expect(buildInRange("10.0.0.0", [10, 0, 0, 0], [11, 0, 0, 0])).toBe(true);
        expect(buildInRange("11.0.0.0", [10, 0, 0, 0], [11, 0, 0, 0])).toBe(false);
        expect(buildInRange("9.9.9.9", [10, 0, 0, 0], [11, 0, 0, 0])).toBe(false);
    });

    it("finds the newest version and sorts newest-first", () => {
        const list = ["10.2.5.52646", "12.1.5.69594", "12.1.0.69027"];
        expect(newestOf(list)).toBe("12.1.5.69594");
        expect(newestOf([])).toBeNull();
        expect(newestFirst(list)).toEqual(["12.1.5.69594", "12.1.0.69027", "10.2.5.52646"]);
    });

    it("deduplicates when sorting", () => {
        expect(newestFirst(["10.0.0.0", "10.0.0.0"])).toEqual(["10.0.0.0"]);
    });
});
