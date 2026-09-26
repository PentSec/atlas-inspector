/**
 * ListfileIndex — parser tolerates the real community listfile quirks (CRLF, a
 * header row, junk lines) AND the lifecycle states that replaced the old
 * boolean `load()` + HTTP 503 contract (ADR-014).
 *
 * The central invariant of the current design: `ensure()` NEVER downloads.
 * Downloading is a consent-gated act (`fetch()`, reached only through
 * POST /api/v1/listfile/fetch, which the MCP tool calls after the user
 * approves), and a test that lets `ensure()` move a byte is a security bug, not
 * a feature. Most of the cases below exist to hold that line.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeListfileMeta } from "../../src/server/services/listfileFetch.js";
import { ListfileIndex } from "../../src/server/services/search.js";

const sample = path.join(import.meta.dirname, "../../tests/fixtures/listfile/community-sample.csv");

describe("ListfileIndex — parsing", () => {
    it("loads the fixture and skips header/junk lines", async () => {
        const index = new ListfileIndex({ csvPath: sample });
        expect(await index.load()).toBe(true);
        expect(index.size).toBe(6);
        expect(index.capability).toEqual({ status: "ready", entries: 6 });
    });

    it("search is case-insensitive substring over full paths", async () => {
        const index = new ListfileIndex({ csvPath: sample });
        await index.load();
        const hits = index.search("ICONS");
        expect(hits.length).toBe(1);
        expect(hits[0]).toEqual({
            filedata: 134400,
            name: "interface/icons/inv_misc_questionmark.blp",
        });
    });

    it("reports an error state (not a silent empty index) for a missing file", async () => {
        const index = new ListfileIndex({ csvPath: path.join(import.meta.dirname, "nope.csv") });
        expect(await index.load()).toBe(false);
        expect(index.size).toBe(0);
    });

    it("refuses a CSV that parses to zero names", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "atlas-lf-"));
        const csv = path.join(dir, "junk.csv");
        await writeFile(csv, "not,a,listfile\n#comment only\n");
        try {
            const index = new ListfileIndex({ csvPath: csv });
            expect(await index.load()).toBe(false);
            // "ready with 0 entries" would answer every search with zero hits and
            // look like a legitimate "no such file".
            expect(index.capability.status).toBe("error");
            expect(index.capability.detail).toMatch(/zero names/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("ListfileIndex — the read path never downloads", () => {
    let dir: string;
    let csv: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "atlas-lf-"));
        csv = path.join(dir, "listfile.csv");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("stays absent and names the consented path, even with a fetcher available", async () => {
        const fetchImpl = vi.fn(async () => ({ bytes: 1 }));
        const index = new ListfileIndex({ csvPath: csv, fetch: fetchImpl });

        const cap = await index.ensure();
        expect(cap.status).toBe("absent");
        expect(cap.entries).toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
        // The detail has to name the real next step, otherwise an agent retries
        // forever or tells the user to run a command that does not exist.
        expect(cap.detail).toMatch(/atlas_prepare_index/);
        expect(cap.detail).toMatch(/fetch:listfile/);
    });

    it("does not fetch on repeated ensure() calls either", async () => {
        const fetchImpl = vi.fn(async () => ({ bytes: 1 }));
        const index = new ListfileIndex({ csvPath: csv, fetch: fetchImpl });
        for (let i = 0; i < 5; i++) expect((await index.ensure()).status).toBe("absent");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("ensure(wait) cannot start a download — it only joins one in flight", async () => {
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                calls += 1;
                await gate;
                await writeFile(csv, await readFile(sample));
                return { bytes: 6 };
            },
        });

        // One authorized caller starts the download; a search joins it.
        const downloading = index.fetch();
        await vi.waitFor(() => expect(calls).toBe(1));

        const joined = await index.ensure(2_000);
        expect(joined.status).toBe("indexing");
        expect(calls).toBe(1);

        release();
        expect((await downloading).status).toBe("ready");
    });

    it("resolves the local parse without waiting for the network when the CSV is warm", async () => {
        await writeFile(csv, await readFile(sample));
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const fetchImpl = vi.fn(async () => {
            await gate;
            return { bytes: 1 };
        });
        const index = new ListfileIndex({ csvPath: csv, fetch: fetchImpl });

        // A warm install must answer immediately even with wait=0, otherwise
        // every tool looks flaky for the first second.
        expect(await index.ensure()).toEqual({ status: "ready", entries: 6 });
        expect(fetchImpl).not.toHaveBeenCalled();
        release();
    });
});

describe("ListfileIndex — the consent-gated download", () => {
    let dir: string;
    let csv: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "atlas-lf-"));
        csv = path.join(dir, "listfile.csv");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const installFixture = async (): Promise<{ bytes: number }> => {
        const raw = await readFile(sample);
        await writeFile(csv, raw);
        return { bytes: raw.byteLength };
    };

    it("fetch() downloads, then becomes ready, and records provenance", async () => {
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => ({ ...(await installFixture()), release: "202609242243" }),
        });
        const cap = await index.fetch();
        expect(cap.status).toBe("ready");
        expect(cap.entries).toBe(6);
        expect(cap.release).toBe("202609242243");
        expect(cap.fetchedAt).toBeTruthy();
    });

    it("is single-flight: concurrent callers trigger exactly one download", async () => {
        let calls = 0;
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                calls += 1;
                await new Promise((r) => setTimeout(r, 20));
                return installFixture();
            },
        });

        const caps = await Promise.all([
            index.fetch(),
            index.fetch(),
            index.fetch(),
            index.fetch(),
        ]);
        expect(calls).toBe(1);
        for (const cap of caps) expect(cap.status).toBe("ready");
    });

    it("surfaces a failed download as `error` with an actionable detail", async () => {
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                throw new Error("listfile download failed: HTTP 404 from https://example.test");
            },
        });
        const cap = await index.fetch();
        expect(cap.status).toBe("error");
        expect(cap.detail).toMatch(/HTTP 404/);
    });

    it("retries after a failure instead of latching the error", async () => {
        let attempt = 0;
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                attempt += 1;
                if (attempt === 1) throw new Error("network down");
                return installFixture();
            },
        });
        expect((await index.fetch()).status).toBe("error");
        expect((await index.fetch()).status).toBe("ready");
        expect(attempt).toBe(2);
    });

    it("without a fetcher it fails closed instead of pretending", async () => {
        const index = new ListfileIndex({ csvPath: csv });
        const cap = await index.fetch();
        expect(cap.status).toBe("error");
        expect(cap.detail).toMatch(/cannot download/);
    });

    it("fetch(wait) actually blocks, then returns the finished index", async () => {
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                await new Promise((r) => setTimeout(r, 50));
                return installFixture();
            },
        });
        const started = Date.now();
        const cap = await index.fetch(5_000);
        expect(cap.status).toBe("ready");
        expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    });

    it("fetch(wait) gives up on a slow download without cancelling it", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                await gate;
                return installFixture();
            },
        });

        const impatient = await index.fetch(10);
        expect(impatient.status).toBe("indexing");
        expect(impatient.detail).toMatch(/146 MB/);

        release();
        expect((await index.fetch()).status).toBe("ready");
    });

    it("refreshing a ready index keeps it usable and flags the download", async () => {
        await installFixture();
        await writeListfileMeta(csv, {
            release: "202609242243",
            fetchedAt: "2026-09-25T00:00:00Z",
        });

        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                await gate;
                return { ...(await installFixture()), release: "202610010000" };
            },
        });
        expect((await index.ensure()).release).toBe("202609242243");

        // Downgrading a working index to "indexing" would break searching just
        // to describe a background download. The names must stay queryable.
        const refreshing = index.fetch();
        await vi.waitFor(() => expect(index.capability.refreshing).toBe(true));
        expect(index.capability.status).toBe("ready");
        expect(index.search("ICONS")).toHaveLength(1);

        release();
        await refreshing;
        expect(index.capability.status).toBe("ready");
        expect(index.capability.release).toBe("202610010000");
    });

    it("a failed refresh leaves the working index and its release intact", async () => {
        await installFixture();
        await writeListfileMeta(csv, {
            release: "202609242243",
            fetchedAt: "2026-09-25T00:00:00Z",
        });

        const index = new ListfileIndex({
            csvPath: csv,
            fetch: async () => {
                throw new Error("connection reset");
            },
        });
        const cap = await index.fetch();
        expect(cap.status).toBe("ready");
        expect(cap.entries).toBe(6);
        expect(cap.release).toBe("202609242243");
    });
});

describe("ListfileIndex — freshness", () => {
    let dir: string;
    let csv: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "atlas-lf-"));
        csv = path.join(dir, "listfile.csv");
        await writeFile(csv, await readFile(sample));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("reports an available update only when both releases are known", async () => {
        // No provenance sidecar: we cannot claim "up to date" nor "outdated",
        // and the honest answer is "unknown".
        const unknown = new ListfileIndex({ csvPath: csv });
        await unknown.load();
        unknown.noteCheck("202609242243");
        expect(unknown.capability.updateAvailable).toBeUndefined();
        expect(unknown.capability.latestRelease).toBe("202609242243");
        expect(unknown.capability.checkedAt).toBeTruthy();

        await writeListfileMeta(csv, {
            release: "202609242243",
            fetchedAt: "2026-09-25T00:00:00Z",
        });

        const current = new ListfileIndex({ csvPath: csv });
        await current.load();
        current.noteCheck("202609242243");
        expect(current.capability.release).toBe("202609242243");
        expect(current.capability.updateAvailable).toBe(false);

        const stale = new ListfileIndex({ csvPath: csv });
        await stale.load();
        stale.noteCheck("202610010000");
        expect(stale.capability.updateAvailable).toBe(true);
    });
});
