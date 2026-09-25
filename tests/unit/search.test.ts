/**
 * ListfileIndex — parser tolerates the real community listfile quirks:
 * CRLF endings, a header row, and junk lines.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ListfileIndex } from "../../src/server/services/search.js";

const sample = path.join(import.meta.dirname, "../../tests/fixtures/listfile/community-sample.csv");

describe("ListfileIndex", () => {
  it("loads the fixture and skips header/junk lines", async () => {
    const index = new ListfileIndex();
    expect(await index.load(sample)).toBe(true);
    expect(index.size).toBe(6);
  });

  it("search is case-insensitive substring over full paths", async () => {
    const index = new ListfileIndex();
    await index.load(sample);
    const hits = index.search("ICONS");
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({ filedata: 134400, name: "interface/icons/inv_misc_questionmark.blp" });
  });

  it("returns false when the file is absent (503 path)", async () => {
    const index = new ListfileIndex();
    expect(await index.load(path.join(import.meta.dirname, "nope.csv"))).toBe(false);
    expect(index.size).toBe(0);
  });
});