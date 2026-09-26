/**
 * Canonical community-listfile downloader (ADR-020).
 *
 * This is the ONLY place that knows how to fetch the listfile. Nothing in the
 * request path calls it: a download only ever starts from an explicit,
 * user-consented `POST /api/v1/listfile/fetch`, or from
 * `scripts/fetch-listfile.mjs`. `scripts/fetch-listfile.mjs` delegates here for
 * the manual case.
 *
 * Source: wowdev/wow-listfile release artifact `community-listfile.csv`
 * (https://github.com/wowdev/wow-listfile/releases/latest/download/...).
 * Format is `FileDataID;path` per line, CRLF, lowercase paths — exactly what
 * ListfileIndex.load() parses. It is ~150 MB, gitignored, and grows per build.
 *
 * The write is atomic: bytes stream to `<target>.tmp` and only then rename, so
 * a crashed or cancelled download can never leave a half-written index that
 * later loads as a corrupt (but "present") listfile.
 *
 * Provenance is recorded, not assumed. `releases/latest/download/...` is a
 * moving pointer, so a CSV on disk cannot say which release it came from — which
 * makes "is my index stale?" unanswerable. `resolveLatestRelease` reads the
 * release metadata (~14 KB) first, the download is pinned to that tag, and the
 * tag lands in a sidecar next to the CSV.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const DEFAULT_LISTFILE_URL =
    "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";

/** ~14 KB of JSON. The only network call that is allowed to happen on a timer. */
export const DEFAULT_RELEASE_API =
    "https://api.github.com/repos/wowdev/wow-listfile/releases/latest";

/** ~150 MB on a cold link; generous, but a stalled socket must still die. */
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** Release metadata is tiny; 15s is generous. */
const RELEASE_TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Provenance sidecar, written next to the CSV: `<csv>.meta.json`. */
export interface ListfileMeta {
    release: string;
    fetchedAt: string;
}

export interface ListfileRelease {
    tag: string;
    publishedAt?: string;
}

export interface FetchListfileOptions {
    /** absolute destination path, e.g. `<root>/cache/listfile.csv` */
    target: string;
    url?: string;
    /** where release metadata comes from, used to pin `url` to a concrete tag */
    releaseApiUrl?: string;
    userAgent?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    /** called after the file lands, before it is renamed into place */
    onProgress?: (bytes: number) => void;
    signal?: AbortSignal;
}

export interface FetchListfileResult {
    bytes: number;
    /** the release actually downloaded, or undefined when it could not be resolved */
    release?: string;
}

/** Performs an authorized download; resolves with the bytes and their provenance. */
export type ListfileFetcher = (target: string) => Promise<FetchListfileResult>;

export class ListfileFetchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ListfileFetchError";
    }
}

export function metaPathFor(csvPath: string): string {
    return `${csvPath}.meta.json`;
}

/** Read the provenance sidecar. A missing or corrupt file is not an error. */
export async function readListfileMeta(csvPath: string): Promise<ListfileMeta | null> {
    try {
        const raw = JSON.parse(
            await readFile(metaPathFor(csvPath), "utf8"),
        ) as Partial<ListfileMeta>;
        if (typeof raw.release !== "string" || raw.release.length === 0) return null;
        return {
            release: raw.release,
            fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
        };
    } catch {
        return null;
    }
}

export async function writeListfileMeta(csvPath: string, meta: ListfileMeta): Promise<void> {
    await writeFile(metaPathFor(csvPath), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/**
 * Ask the release API which release is current. Returns null instead of
 * throwing: freshness is information, and a failed check must never take the
 * app down or block a search that already works.
 */
export async function resolveLatestRelease(
    apiUrl = DEFAULT_RELEASE_API,
    fetchImpl: FetchLike = fetch as FetchLike,
): Promise<ListfileRelease | null> {
    try {
        const res = await fetchImpl(apiUrl, {
            headers: { accept: "application/vnd.github+json", "User-Agent": "atlas-inspector" },
            signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { tag_name?: unknown; published_at?: unknown };
        if (typeof body.tag_name !== "string" || body.tag_name.length === 0) return null;
        return {
            tag: body.tag_name,
            publishedAt: typeof body.published_at === "string" ? body.published_at : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Pin a `releases/latest/download/...` URL to a concrete tag so the bytes we
 * store can be traced. Returns the original URL when the shape is unexpected
 * rather than guessing at a URL we cannot verify.
 */
export function pinToRelease(downloadUrl: string, tag: string): string {
    return downloadUrl.replace("/releases/latest/download/", `/releases/download/${tag}/`);
}

/**
 * Stream the listfile to `target`. Resolves with the byte count and the release
 * it came from; rejects with a `ListfileFetchError` on any transport, HTTP, or
 * filesystem failure so callers can report one actionable message instead of
 * three failure modes.
 */
export async function fetchListfile(opts: FetchListfileOptions): Promise<FetchListfileResult> {
    const {
        target,
        url = DEFAULT_LISTFILE_URL,
        releaseApiUrl,
        userAgent = "atlas-inspector",
        timeoutMs = DOWNLOAD_TIMEOUT_MS,
        fetchImpl = fetch as FetchLike,
        onProgress,
        signal,
    } = opts;

    const tmp = `${target}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });

    const timeout = AbortSignal.timeout(timeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // Resolve the moving pointer to a tag first, so the stored CSV is traceable
    // and the freshness check has something concrete to compare against.
    const release = await resolveLatestRelease(releaseApiUrl, fetchImpl);
    const source = release ? pinToRelease(url, release.tag) : url;

    let res: Response;
    try {
        res = await fetchImpl(source, {
            headers: { "User-Agent": userAgent },
            redirect: "follow",
            signal: composite,
        });
    } catch (err) {
        throw new ListfileFetchError(
            `listfile download failed (${describe(err)}). Check network access to ${hostOf(source)} and retry.`,
        );
    }

    if (!res.ok || !res.body) {
        throw new ListfileFetchError(
            `listfile download failed: HTTP ${res.status} from ${source}. ` +
                (res.status === 404 || res.status === 403
                    ? "The community-listfile release asset is missing or rate-limited — retry later."
                    : "Retry later."),
        );
    }

    try {
        await new Promise<void>((resolve, reject) => {
            const out = createWriteStream(tmp);
            const onAbort = () => out.destroy(new ListfileFetchError("listfile download aborted"));
            composite.addEventListener("abort", onAbort, { once: true });
            out.on("error", reject);
            out.on("finish", resolve);
            Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(out);
        });
    } catch (err) {
        await unlink(tmp).catch(() => {});
        throw new ListfileFetchError(
            `listfile download interrupted (${describe(err)}). Nothing was installed — retry when ready.`,
        );
    }

    // A 0-byte body means a truncated/proxy response, not an empty index: an
    // empty listfile would look "ready" and silently answer every search with
    // zero hits, which is worse than an honest failure.
    const bytes = (await stat(tmp)).size;
    if (bytes === 0) {
        await unlink(tmp).catch(() => {});
        throw new ListfileFetchError("listfile download produced an empty file — retry later.");
    }

    await rename(tmp, target);
    onProgress?.(bytes);
    return { bytes, release: release?.tag };
}

function describe(err: unknown): string {
    if (err instanceof Error) {
        return err.name === "TimeoutError" || err.name === "AbortError" ? "timed out" : err.message;
    }
    return String(err);
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
