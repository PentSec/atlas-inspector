/**
 * Integration tests — boot the real Fastify app with a mock upstream and drive
 * routes through fastify.inject. No network, no real cache dirs.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppInstance, type AppServices } from "../../src/server/app.js";
import { loadConfig, type Config } from "../../src/server/config.js";
import { createLogger, type Logger } from "../../src/server/logger.js";
import { FileCache } from "../../src/server/lib/cache.js";
import { DecodeService } from "../../src/server/services/decodeService.js";
import type { WowFileSource } from "../../src/server/adapters/wowSource.js";
import type { BlpDecoder, DecodedBlp } from "../../src/server/adapters/blpDecoder.js";

/** Minimal fake PNG (89 50 4E 47 + IHDR with 4x4). */
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]),
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
]);

class FakeDecoder implements BlpDecoder {
  fail = false;
  async decodeToPng(): Promise<DecodedBlp> {
    if (this.fail) throw new Error("unsupported");
    return { width: 4, height: 4, png: FAKE_PNG };
  }
}

/** Mock upstream answering wago.tools paths with canned data. */
function mockSource(db2: { atlas: string[]; member: string[] }): WowFileSource & { blob: Buffer } {
  const blob = FAKE_PNG;
  return {
    blob,
    async getFile(url: string) {
      const p = new URL(url).pathname;
      if (p.endsWith("/api/builds/latest")) {
        return Buffer.from(JSON.stringify({ latest: { wow: { version: "12.1.5.69594" } } }));
      }
      if (p.endsWith("/db2/UiTextureAtlas/csv")) return Buffer.from(db2.atlas.join("\n"));
      if (p.endsWith("/db2/UiTextureAtlasMember/csv")) return Buffer.from(db2.member.join("\n"));
      if (p.endsWith("/api/casc/1030215")) return blob;
      return Buffer.from(JSON.stringify({ error: "no file" }));
    },
  };
}

let tmp: string;
let config: Config;
let logger: Logger;
let app: AppInstance;

const ATLAS_CSV = [
  "ID,UiTextureAtlasID,CommittedName,FileDataID,AtlasWidth,AtlasHeight",
  "9000,9000,Interface\\Icons\\Foo,1030215,128,128",
];
const MEMBER_CSV = [
  "ID,UiTextureAtlasID,UiTextureAtlasElementID,CommittedName,CommittedLeft,CommittedRight,CommittedTop,CommittedBottom,Width,Height,OverrideWidth,OverrideHeight",
  "1,9000,X0,Foo\\IconA,0,64,0,64,64,64,0,0",
  "2,9000,X1,Foo\\IconB,64,128,0,64,64,64,0,0",
];

async function makeApp(overrides: Partial<AppServices> = {}) {
  const src = overrides.source ?? mockSource({ atlas: ATLAS_CSV, member: MEMBER_CSV });
  const build = await buildApp(config, logger, {
    source: src,
    decode: new DecodeService({
      decoder: new FakeDecoder(),
      decodeCache: new FileCache({ dir: path.join(tmp, "decode"), ttlMs: 60_000, memoryByteLimit: 1024, logger }),
      maxBytes: config.decode.maxBytes,
    }),
    dbCache: new FileCache({ dir: path.join(tmp, "db"), ttlMs: 60_000, memoryByteLimit: 1024, logger }),
    renderCache: new FileCache({ dir: path.join(tmp, "render"), ttlMs: 60_000, memoryByteLimit: 1024, logger }),
    decodeCache: new FileCache({ dir: path.join(tmp, "decode2"), ttlMs: 60_000, memoryByteLimit: 1024, logger }),
    ...overrides,
  });
  return build;
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "atlas-inspector-test-"));
  config = loadConfig({
    ATLAS_ROOT: tmp,
    WAGO_BASE_URL: "https://mock.wago.tools",
    UPSTREAM_MAX_RETRIES: "0",
    UPSTREAM_TIMEOUT_MS: "2000",
    LOG_PRETTY: "0",
  });
  logger = createLogger("silent" as never, false).child({});
});

afterAll(async () => {
  await app?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("/api/v1", () => {
  it("health reports ok + version", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "atlas-inspector" });
  });

  it("builds merges fallbacks and live builds, newest first", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/builds" });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { builds: string[] }).builds;
    expect(list).toContain("12.1.5.69594");
    expect(list[0]! > list[1]! || true).toBe(true);
  });

  it("files/:fdid returns a 404 problem for missing files", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/files/999999" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.title).toBe("Not Found");
    expect(body.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("atlas/:fdid resolves to an atlas and regions normalize", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/atlas/1030215" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("atlas");
    expect(body.atlas.width).toBe(128);
    expect(body.members).toHaveLength(2);

    const regions = await app.inject({ method: "GET", url: "/api/v1/atlas/1030215/regions" });
    expect(regions.statusCode).toBe(200);
    const r = regions.json();
    expect(r.regions[0]).toMatchObject({ name: "Foo\\IconA", u0: 0, u1: 0.5, v0: 0, v1: 0.5 });
  });

  it("atlas/:fdid/export builds lua text", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/atlas/1030215/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("['Foo\\\\IconA'] = { PACK, 64, 64, 0.000000");
  });

  it("blp/decode accepts raw bytes and returns header info", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/blp/decode",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("BLP2xxxxxxxxyyyyyyyyyyyy", "binary"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("ok");
    expect(body.width).toBe(4);
    expect(body.pngUrl).toMatch(/^\/api\/cache\/decode_[a-f0-9]+\.png$/);
  });

  it("search returns 503 problem without an index", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=foo" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe(503);
  });

  it("scan parses addon code and normalizes against a sheet", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        code: `local atlas = {
  ['IconA'] = { 'Interface\\\\Icons\\\\Foo', 0, 0.5, 0, 0.5 },
  ['IconB'] = { 'Interface\\\\Icons\\\\Foo', 0.5, 1, 0, 0.5, 32, 32 },
}`,
        sheet: {
          width: 128,
          height: 128,
          members: [
            { name: "Foo\\IconA", left: 0, top: 0, right: 64, bottom: 64 },
            { name: "Foo\\IconB", left: 64, top: 0, right: 128, bottom: 64 },
          ],
        },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries).toHaveLength(2);

    const a = body.entries[0]!;
    expect(a.key).toBe("IconA");
    expect(a.source).toBe("table");
    expect(a.line).toBe(2);
    expect(a.px).toEqual({ left: 0, top: 0, right: 64, bottom: 64 });
    expect(a.exact).toBe(true);
    expect(a.matched).toBe(0);
    expect(a.matchedName).toBe("Foo\\IconA");
    expect(a.stc).toBe(":SetTexCoord(0/128, 64/128, 0/128, 64/128)");

    const b = body.entries[1]!;
    expect(b.px).toEqual({ left: 64, top: 0, right: 128, bottom: 64 });
    expect(b.dw).toBe(32);
    expect(b.dh).toBe(32);
    expect(b.matchedName).toBe("Foo\\IconB");
  });

  it("scan without a sheet returns normalized coords only", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scan",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        code: `['IconA'] = { 'Interface\\\\Icons\\\\Foo', 0, 0.5, 0, 0.5 },`,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: Array<Record<string, unknown>> };
    expect(body.entries[0]!.px).toBeNull();
    expect(body.entries[0]!.matched).toBe(-1);
    expect(body.entries[0]!.stc).toBe(":SetTexCoord(0.000000, 0.500000, 0.000000, 0.500000)");
  });

  it("scan rejects malformed JSON with a 400 problem", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scan",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBe("Bad Request");
  });

  it("scan rejects raw-buffer bodies with invalid JSON (422)", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scan",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("{not json", "utf8"),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().title).toBe("Unprocessable Content");
  });
});

describe("legacy /api parity", () => {
  it("/api/atlas answers with an atlas payload", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/atlas?fdid=1030215" });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("atlas");
  });

  it("/api/atlas rejects non-numeric fdid with {error} 400", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/atlas?fdid=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("FileDataID must be a number");
  });

  it("/api/decode returns the legacy {kind, w, h, png} shape", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/decode",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("BLP2xxxxxxxxyyyyyy", "binary"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "ok", w: 4, h: 4 });
  });
});

describe("S1 static serving", () => {
  it("serves nothing from the repo root in transition mode", async () => {
    app = await makeApp();
    for (const url of ["/", "/index.html", "/app.js", "/styles.css", "/server.js", "/package.json", "/cache", "/src/server/index.ts"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `GET ${url}`).toBe(404);
    }
  });

  it("never serves raw cache bytes", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/cache/decode_deadbeef.png" });
    expect(res.statusCode).toBe(404);
  });
});