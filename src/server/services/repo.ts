/**
 * Repo — data access façade over the upstream (WowFileSource) with the same
 * caching folders/keys the legacy server used, plus TTLs and atomic writes.
 *
 * Faithful port of server.js's resolution logic:
 *  - 4-path atlas resolution kept verbatim (parity)
 *  - `newestVersion` / `texturePayload` with the exact legacy strings
 */
import { buildGte, buildInRange, cmpBuild } from "../../shared/buildVersion.js";
import type { AtlasMeta, AtlasResult, FileInfo, Region } from "../../shared/types.js";
import { parseDb2Csv } from "./csv.js";
import type { Logger } from "../logger.js";
import type { FileCache } from "../lib/cache.js";
import type { WowFileSource } from "../adapters/wowSource.js";
import type { Config } from "../config.js";

export type Db2Row = Record<string, string>;

/** Fallback build lists, curated to builds that host the UiTextureAtlas DB2. */
export const CURRENT_BUILDS = [
  "12.1.5.69594",
  "12.1.7.69775",
  "12.1.5.69760",
  "12.1.0.69587",
  "12.1.0.69027",
  "12.0.5.66521",
  "12.0.1.66220",
  "10.2.5.52646",
];
export const DF_BUILDS = [
  "10.2.7.55664",
  "10.2.6.54358",
  "10.2.5.53441",
  "10.2.0.52808",
  "10.1.7.51972",
  "10.1.5.51130",
  "10.1.0.50000",
  "10.0.7.49267",
  "10.0.5.48397",
  "10.0.2.47657",
  "10.0.0.46597",
];
export const ATLAS_ERA_PRODUCTS = new Set([
  "wow",
  "wow_beta",
  "wowt",
  "wowdev",
  "wowdev2",
  "wowdev3",
  "wowlivetest",
  "wowlivetest2",
  "wowv",
  "wowv2",
  "wowv3",
  "wowxptr",
]);

export interface AtlasHit {
  build: string;
  atlas: AtlasMeta;
  members: Region[];
}

export interface RepoOptions {
  source: WowFileSource;
  config: Config;
  logger: Logger;
  dbCache: FileCache;
}

type VersionedRec = { version?: unknown };

function asVersioned(value: unknown): VersionedRec | null {
  return value && typeof value === "object" ? (value as VersionedRec) : null;
}

export class Repo {
  private readonly opts: RepoOptions;

  constructor(opts: RepoOptions) {
    this.opts = opts;
  }

  get source(): WowFileSource {
    return this.opts.source;
  }

  url(pathname: string): string {
    return this.opts.config.upstream.baseUrl + pathname;
  }

  // ---------- builds ----------

  async fetchLiveBuilds(): Promise<string[]> {
    const entry = "builds_latest.json";
    let raw: string | null =
      (await this.opts.dbCache.getFromDisk(entry))?.toString("utf8") ?? null;

    const fresh = await this.source.getFile(this.url("/api/builds/latest"));
    if (fresh && fresh.length) {
      raw = fresh.toString("utf8");
      await this.opts.dbCache.setFromBuffer(entry, fresh);
    }
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];

    const source =
      (parsed as { latest?: unknown }).latest ??
      (parsed as { products?: unknown }).products ??
      parsed;
    const products = source as Record<string, unknown>;
    const live: string[] = [];
    for (const [prod, rec] of Object.entries(products)) {
      const recObj = asVersioned(rec);
      if (!recObj) continue;
      const ver = (recObj.version as string | undefined)?.trim() ?? "";
      if (!ver) continue;
      if (ATLAS_ERA_PRODUCTS.has(prod) || buildGte(ver, "10.0.0.0")) live.push(ver);
    }
    return live;
  }

  async getBuilds(): Promise<string[]> {
    const live = await this.fetchLiveBuilds();
    const merged = [...new Set([...CURRENT_BUILDS, ...DF_BUILDS, ...live])];
    return merged.sort((a, b) => cmpBuild(b, a));
  }

  /** Builds in the Dragonflight range [10.0.0.0, 11.0.0.0). */
  async scanBuilds(): Promise<string[]> {
    const builds = await this.getBuilds();
    return builds.filter((b) => buildInRange(b, [10, 0, 0, 0], [11, 0, 0, 0]));
  }

  // ---------- tables & file info ----------

  async db2Table(table: string, build: string | null): Promise<Db2Row[] | null> {
    const key = build || "default";
    const suffix = build ? `?build=${encodeURIComponent(build)}` : "";
    const entry = `${table}_${key}.csv`;

    let csv = await this.opts.dbCache.getFromDisk(entry);
    if (!csv) {
      const data = await this.source.getFile(this.url(`/db2/${table}/csv${suffix}`));
      if (!data || data.length === 0) return null;
      await this.opts.dbCache.setFromBuffer(entry, data);
      csv = data;
    }
    try {
      return parseDb2Csv(csv.toString("utf8"));
    } catch (err) {
      this.opts.logger.warn({ err, entry }, "failed to parse cached DB2 CSV");
      return null;
    }
  }

  async cachedTables(build: string | null): Promise<{ atl: Db2Row[] | null; mem: Db2Row[] | null }> {
    const atl = await this.db2Table("UiTextureAtlas", build);
    const mem = await this.db2Table("UiTextureAtlasMember", build);
    return { atl, mem };
  }

  async fileInfo(fdid: number): Promise<FileInfo | null> {
    const entry = `info_${fdid}.json`;
    const cached = await this.opts.dbCache.getFromDisk(entry);
    if (cached) {
      try {
        return JSON.parse(cached.toString("utf8")) as FileInfo;
      } catch {
        /* corrupt cache — refetch below */
      }
    }

    const data = await this.source.getFile(this.url(`/api/info/${fdid}`));
    if (!data || data.length === 0) return null;
    let parsed: FileInfo;
    try {
      parsed = JSON.parse(data.toString("utf8")) as FileInfo;
    } catch {
      return null;
    }
    if (parsed.error) return null;
    await this.opts.dbCache.setFromBuffer(entry, Buffer.from(JSON.stringify(parsed)));
    return parsed;
  }

  // ---------- atlas resolution (parity port of legacy resolve/atlasIn) ----------

  normMember(row: Db2Row): Region {
    const int = (v: string | undefined): number => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? 0 : n;
    };
    const width = int(row.OverrideWidth) || int(row.Width);
    const height = int(row.OverrideHeight) || int(row.Height);
    return {
      name: row.CommittedName || row.Name || "",
      left: int(row.CommittedLeft),
      right: int(row.CommittedRight),
      top: int(row.CommittedTop),
      bottom: int(row.CommittedBottom),
      width: int(row.Width),
      height: int(row.Height),
      overrideW: int(row.OverrideWidth),
      overrideH: int(row.OverrideHeight),
      displayW: width,
      displayH: height,
      elementId: row.UiTextureAtlasElementID || "",
    };
  }

  async atlasIn(filedata: number, build: string | null): Promise<AtlasHit | null> {
    const { atl, mem } = await this.cachedTables(build);
    if (!atl) return null;

    const atlasRow = atl.find((r) => (r.FileDataID || "").trim() === String(filedata));
    if (!atlasRow) return null;

    const aid = atlasRow.ID;
    const members = (mem ?? [])
      .filter((r) => (r.UiTextureAtlasID || "").trim() === aid)
      .map((r) => this.normMember(r))
      .sort((a, b) => a.name.localeCompare(b.name));

    const atlas: AtlasMeta = {
      id: Number.parseInt(aid ?? "", 10),
      filedata: Number(filedata),
      width: Number.parseInt(atlasRow.AtlasWidth || "0", 10),
      height: Number.parseInt(atlasRow.AtlasHeight || "0", 10),
    };
    return { build: build || "default", atlas, members };
  }

  /** Newest version that ships the file, per /api/info. */
  newestVersion(parsed: FileInfo): string | null {
    const cands: string[] = [];
    const latest = parsed.latest;
    if (latest && typeof latest === "object") {
      for (const rec of Object.values(latest as Record<string, unknown>)) {
        const recObj = asVersioned(rec);
        if (recObj && recObj.version) cands.push(String(recObj.version));
      }
    }
    for (const rec of parsed.chashes ?? []) {
      const recObj = asVersioned(rec);
      if (recObj && recObj.version) cands.push(String(recObj.version));
    }
    if (!cands.length) return null;
    return cands.reduce((best, v) => (cmpBuild(v, best) > 0 ? v : best));
  }

  texturePayload(filedata: number, info: FileInfo, build: string | null): Extract<AtlasResult, { kind: "texture" }> {
    const nv = this.newestVersion(info);
    const chashes = Array.isArray(info.chashes) ? (info.chashes as unknown[]) : [];
    const versions = [
      ...new Set(
        chashes
          .map((r) => asVersioned(r)?.version)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    ].sort((a, b) => cmpBuild(b, a));
    return {
      kind: "texture",
      filedata,
      filename: typeof info.filename === "string" ? info.filename : "",
      type: typeof info.type === "string" ? info.type : "",
      version: nv || build,
      versions,
      download: `/api/file?fdid=${filedata}${
        nv ? `&version=${encodeURIComponent(nv)}` : ""
      }`,
      error: "This file is not a texture atlas (no UiTextureAtlasMember regions).",
    };
  }

  async resolve(filedata: number, explicitBuild: string | null): Promise<AtlasResult> {
    if (explicitBuild) {
      const hit = await this.atlasIn(filedata, explicitBuild);
      if (hit)
        return {
          kind: "atlas",
          filedata,
          build: hit.build,
          atlas: hit.atlas,
          members: hit.members,
        };
      const info = await this.fileInfo(filedata);
      if (info && !info.error) return this.texturePayload(filedata, info, explicitBuild);
      return { kind: "missing", filedata, error: "File not found on wago.tools" };
    }

    const hit = await this.atlasIn(filedata, null);
    if (hit)
      return {
        kind: "atlas",
        filedata,
        build: hit.build,
        atlas: hit.atlas,
        members: hit.members,
      };

    const info = await this.fileInfo(filedata);
    if (!info || info.error)
      return { kind: "missing", filedata, error: "File not found on wago.tools" };

    const nv = this.newestVersion(info);
    if (nv && buildGte(nv, "10.0.0.0")) {
      const h2 = await this.atlasIn(filedata, nv);
      if (h2)
        return {
          kind: "atlas",
          filedata,
          build: h2.build,
          atlas: h2.atlas,
          members: h2.members,
        };
      // file exists in a DF-era build but has no atlas row there; a different
      // DF build might still define it (rare). Cheap safety scan, newest first.
      for (const b of await this.scanBuilds()) {
        if (b === nv) continue;
        const h3 = await this.atlasIn(filedata, b);
        if (h3)
          return {
            kind: "atlas",
            filedata,
            build: h3.build,
            atlas: h3.atlas,
            members: h3.members,
          };
      }
    }
    return this.texturePayload(filedata, info, null);
  }
}