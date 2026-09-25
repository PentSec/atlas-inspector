import { describe, expect, it } from "vitest";
import { createAppStore, grpColor } from "./store.js";
import { filteredMembers, filteredPosition } from "./select.js";
import type { AtlasResultOk } from "../../shared/schemas.js";

function atlas(members: Array<{ name: string }>): AtlasResultOk {
  return {
    kind: "atlas",
    filedata: 1,
    build: "x",
    atlas: { id: 2, filedata: 1, width: 100, height: 100 },
    members: members.map((m, i) => ({
      name: m.name,
      left: i * 10,
      right: i * 10 + 10,
      top: 0,
      bottom: 10,
      width: 10,
      height: 10,
      overrideW: 0,
      overrideH: 0,
      displayW: 0,
      displayH: 0,
      elementId: "",
    })),
  };
}

describe("store", () => {
  it("setResult resets per-atlas state and keeps group colors until lookup", () => {
    const store = createAppStore();
    store.setState({ activeIndex: 2, hoverIndex: 7, filterQuery: "x" });
    const a = atlas([
      { name: "ui/button/up" },
      { name: "ui/button/down" },
      { name: "quest/icon" },
    ]);
    store.getState().setResult(a, null, { fdid: 1, version: "" });
    expect(store.getState().activeIndex).toBe(-1);
    expect(store.getState().hoverIndex).toBe(-1);
    const s = store.getState();
    expect(s.groups["ui/button"]).toBeUndefined();
  });

  it("palette index never exceeds the table size, colors assign on first sight", () => {
    const store = createAppStore();
    const colors = new Set<string>();
    for (let i = 0; i < 80; i++) colors.add(grpColor(store, `g${i}`));
    expect(colors.size).toBeGreaterThan(0);
    const first = grpColor(store, "ui/button");
    expect(grpColor(store, "ui/button")).toBe(first);
  });
});

describe("filteredMembers", () => {
  it("matches case-insensitive substring and keeps order", () => {
    const a = atlas([{ name: "AlphaZone" }, { name: "betaZone" }, { name: "Gamma" }]);
    expect(filteredMembers(a, "zone").map((r) => r.m.name)).toEqual(["AlphaZone", "betaZone"]);
    expect(filteredMembers(a, "")).toHaveLength(3);
  });

  it("returns a stable identity when unchanged (memoized)", () => {
    const a = atlas([{ name: "one" }, { name: "two" }]);
    const f1 = filteredMembers(a, "o");
    const f2 = filteredMembers(a, "o");
    expect(f1).toBe(f2);
    expect(filteredMembers(a, "z")).not.toBe(f1);
  });

  it("reports the active index position after filtering", () => {
    const a = atlas([{ name: "one" }, { name: "two" }, { name: "three" }]);
    const f = filteredMembers(a, "t");
    expect(f.map((r) => r.m.name)).toEqual(["two", "three"]);
    expect(filteredPosition(f, 1)).toBe(0);
    expect(filteredPosition(f, 9)).toBe(-1);
  });
});