/**
 * Listfile index for /api/v1/search (ADR note; wago.tools has no public search
 * API, so the community listfile is indexed locally).
 *
 * Format parsed: `FileDataID;Path` (CRLF), matching the wowdev/wow-listfile
 * `community-listfile.csv` release artifact. Lines whose first column is not
 * numeric (header row, junk) are skipped.
 */
import { readFile } from "node:fs/promises";

export interface SearchHit {
  filedata: number;
  name: string;
}

export type SearchStatus = "indexed" | "missing";

export interface SearchResult {
  status: SearchStatus;
  hits: SearchHit[];
}

export class ListfileIndex {
  private names: string[] = [];
  private filedata: number[] = [];

  /** (Re)load from the given CSV path. Returns false when the file is absent. */
  async load(csvPath: string): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(csvPath, "utf8");
    } catch {
      return false;
    }
    const names: string[] = [];
    const filedata: number[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.length || line.startsWith("#")) continue;
      const idx = line.indexOf(";");
      if (idx <= 0) continue;
      const first = line.slice(0, idx).trim();
      const fdid = Number(first);
      if (Number.isNaN(fdid)) continue; // header row or junk
      const name = line.slice(idx + 1);
      if (name.length === 0) continue;
      names.push(name);
      filedata.push(fdid);
    }
    this.names = names;
    this.filedata = filedata;
    return true;
  }

  get size(): number {
    return this.names.length;
  }

  /** Case-insensitive substring search, capped at `limit` hits. */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (let i = 0; i < this.names.length && hits.length < limit; i++) {
      if (this.names[i]!.toLowerCase().includes(q)) {
        hits.push({ filedata: this.filedata[i]!, name: this.names[i]! });
      }
    }
    return hits;
  }
}