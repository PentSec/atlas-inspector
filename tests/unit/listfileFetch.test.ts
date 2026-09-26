import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    DEFAULT_LISTFILE_URL,
    fetchListfile,
    ListfileFetchError,
    metaPathFor,
    pinToRelease,
    readListfileMeta,
    resolveLatestRelease,
    writeListfileMeta,
    type FetchLike,
} from "../../src/server/services/listfileFetch.js";

const CSV = "134400;interface/icons/inv_misc_questionmark.blp\n";

function release(tag: string) {
    return new Response(JSON.stringify({ tag_name: tag, published_at: "2026-09-24T22:43:39Z" }), {
        headers: { "content-type": "application/json" },
    });
}

function download(body: string) {
    return new Response(body, { status: 200 });
}

describe("listfileFetch", () => {
    let dir: string;
    let target: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "listfile-fetch-"));
        target = path.join(dir, "nested", "listfile.csv");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe("resolveLatestRelease", () => {
        it("returns the tag, or null when the API is unreachable", async () => {
            const ok: FetchLike = async () => release("202609242243");
            expect(await resolveLatestRelease("https://api.example/rel", ok)).toEqual({
                tag: "202609242243",
                publishedAt: "2026-09-24T22:43:39Z",
            });

            const broken: FetchLike = async () => {
                throw new Error("offline");
            };
            // Freshness is information: a failed check must never throw into the
            // caller, because the caller is a 7-hourly timer and a search path.
            expect(await resolveLatestRelease("https://api.example/rel", broken)).toBeNull();
        });

        it("treats a non-2xx or tagless payload as unknown rather than guessing", async () => {
            const notFound: FetchLike = async () => new Response("nope", { status: 404 });
            expect(await resolveLatestRelease("https://api.example/rel", notFound)).toBeNull();

            const tagless: FetchLike = async () =>
                new Response(JSON.stringify({ message: "rate limited" }), { status: 200 });
            expect(await resolveLatestRelease("https://api.example/rel", tagless)).toBeNull();
        });
    });

    describe("pinToRelease", () => {
        it("replaces only the moving pointer", () => {
            expect(pinToRelease(DEFAULT_LISTFILE_URL, "202609242243")).toBe(
                "https://github.com/wowdev/wow-listfile/releases/download/202609242243/community-listfile.csv",
            );
        });

        it("returns an unrecognized URL untouched instead of inventing one", () => {
            const mirror = "https://mirror.internal/community-listfile.csv";
            expect(pinToRelease(mirror, "202609242243")).toBe(mirror);
        });
    });

    describe("fetchListfile", () => {
        it("pins the download to the resolved tag and reports it", async () => {
            const seen: string[] = [];
            const fetchImpl: FetchLike = async (url) => {
                seen.push(url);
                return url.includes("api.example") ? release("202609242243") : download(CSV);
            };

            const result = await fetchListfile({
                target,
                fetchImpl,
                releaseApiUrl: "https://api.example/rel",
            });

            expect(result).toMatchObject({ bytes: CSV.length, release: "202609242243" });
            expect(await readFile(target, "utf8")).toBe(CSV);
            expect(seen[1]).toContain("/releases/download/202609242243/");
            // The release API is configurable; a mirror must not silently fall
            // back to GitHub's answer and record the wrong provenance.
            expect(seen[0]).toBe("https://api.example/rel");
        });

        it("still installs the bytes when the release cannot be resolved", async () => {
            const fetchImpl: FetchLike = async (url) =>
                url.includes("api.example")
                    ? new Response("rate limited", { status: 403 })
                    : download(CSV);

            const result = await fetchListfile({
                target,
                fetchImpl,
                releaseApiUrl: "https://api.example/rel",
            });

            // A failed metadata call is not a reason to deny the user their
            // download; the provenance is simply unknown.
            expect(result.release).toBeUndefined();
            expect(await readFile(target, "utf8")).toBe(CSV);
        });

        it("leaves no partial file behind when the body is empty", async () => {
            const fetchImpl: FetchLike = async (url) =>
                url.includes("api.example") ? release("202609242243") : download("");

            await expect(fetchListfile({ target, fetchImpl })).rejects.toBeInstanceOf(
                ListfileFetchError,
            );
            await expect(stat(target)).rejects.toThrow();
            // An empty CSV would parse as a zero-entry index and answer every
            // search with zero hits, which reads as "no such texture".
            await expect(stat(`${target}.tmp`)).rejects.toThrow();
        });

        it("reports an actionable error for an HTTP failure", async () => {
            const fetchImpl: FetchLike = async (url) =>
                url.includes("api.github.com")
                    ? release("202609242243")
                    : new Response("", { status: 404 });

            await expect(fetchListfile({ target, fetchImpl })).rejects.toThrow(/HTTP 404/);
        });

        it("reports an actionable error when the release asset is rate-limited", async () => {
            const fetchImpl: FetchLike = async (url) =>
                url.includes("api.github.com")
                    ? release("202609242243")
                    : new Response("", { status: 403 });

            await expect(fetchListfile({ target, fetchImpl })).rejects.toThrow(/rate-limited/);
        });

        it("does not install anything when the transport fails", async () => {
            const fetchImpl: FetchLike = async (url) => {
                if (url.includes("api.github.com")) return release("202609242243");
                throw new Error("ENOTFOUND github.com");
            };

            await expect(fetchListfile({ target, fetchImpl })).rejects.toThrow(/ENOTFOUND/);
            await expect(stat(target)).rejects.toThrow();
        });
    });

    describe("provenance sidecar", () => {
        // The CSV always exists before its provenance does, so the directory is
        // a given here — the sidecar is never written ahead of the file.
        beforeEach(async () => {
            await mkdir(path.dirname(target), { recursive: true });
        });

        it("round-trips through read/write", async () => {
            await writeListfileMeta(target, {
                release: "202609242243",
                fetchedAt: "2026-09-25T00:00:00Z",
            });
            expect(await readListfileMeta(target)).toEqual({
                release: "202609242243",
                fetchedAt: "2026-09-25T00:00:00Z",
            });
        });

        it("treats a missing or corrupt sidecar as unknown, not as an error", async () => {
            expect(await readListfileMeta(target)).toBeNull();

            await writeFile(metaPathFor(target), "{not json", "utf8");
            expect(await readListfileMeta(target)).toBeNull();

            await writeFile(metaPathFor(target), JSON.stringify({ fetchedAt: "x" }), "utf8");
            expect(await readListfileMeta(target)).toBeNull();
        });

        it("lives next to the CSV, so it travels with a copied cache directory", () => {
            expect(metaPathFor(target)).toBe(`${target}.meta.json`);
        });
    });
});
