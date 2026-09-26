/**
 * Listfile index for /api/v1/search (ADR-020).
 *
 * Format parsed: `FileDataID;Path` (CRLF), matching the wowdev/wow-listfile
 * `community-listfile.csv` release artifact. Lines whose first column is not
 * numeric (header row, junk) are skipped.
 *
 * The index owns a four-state lifecycle (`SearchStatus`) instead of a boolean
 * `load()`, because callers — the HTTP route, the health payload and the MCP
 * tools — all need to tell "not built yet" apart from "built and empty", and
 * only one of those is a working install:
 *
 *   absent   → no CSV on disk, and nobody has authorized a download
 *   indexing → a consented download is in flight (single-flight: N callers, 1 fetch)
 *   ready    → names loaded
 *   error    → an authorized attempt failed; `detail` carries the next step
 *
 * `status` answers exactly one question: *can a search return a real answer
 * right now?* That is why a refresh of an already-usable index keeps reporting
 * "ready" — the old names are still being served, and downgrading them to
 * "indexing" would break a working search to describe a background download.
 * The `refreshing` flag exposes that download instead.
 *
 * Nothing in the read path downloads. `ensure()` only ever reads local disk;
 * bytes arrive exclusively through `fetch()`, which the MCP layer calls after
 * the user has explicitly authorized the ~146 MB fetch. A search that arrives
 * while an authorized download runs joins it and reports "indexing" — it never
 * starts one of its own.
 */
import { readFile } from "node:fs/promises";

import type { SearchCapability, SearchStatus } from "../../shared/schemas.js";
import { readListfileMeta, writeListfileMeta, type ListfileFetcher } from "./listfileFetch.js";

export type { ListfileFetcher, ListfileMeta } from "./listfileFetch.js";

export interface SearchHit {
    filedata: number;
    name: string;
}

export interface SearchResultBody {
    status: SearchStatus;
    hits: SearchHit[];
    detail?: string;
}

export interface ListfileIndexOptions {
    csvPath: string;
    /** performs the authorized download; without it `fetch()` cannot run */
    fetch?: ListfileFetcher;
}

const RETRY_HINT = "Retry atlas_prepare_index, or run `npm run fetch:listfile`.";

/**
 * How long `ensure()` will wait for the *local* parse before reporting
 * "indexing". Local disk, not the network, so this only ever trips on a
 * pathological filesystem — but it must be far below the download cost.
 */
const LOCAL_PARSE_BUDGET_MS = 30_000;

const ABSENT_DETAIL =
    "No listfile index yet. Downloading community-listfile.csv is ~146 MB and requires " +
    "explicit user authorization, so it never happens on its own: call atlas_prepare_index " +
    "to ask the user, or run `npm run fetch:listfile`.";

export class ListfileIndex {
    readonly csvPath: string;
    readonly #fetch: ListfileFetcher | undefined;

    #names: string[] = [];
    #filedata: number[] = [];
    #status: SearchStatus = "absent";
    #detail: string | undefined = ABSENT_DETAIL;
    /** true when a consent-gated download is in flight behind a usable index */
    #refreshing = false;
    #release: string | undefined;
    #fetchedAt: string | undefined;
    #latestRelease: string | undefined;
    #checkedAt: string | undefined;

    /** the single in-flight local parse; concurrent callers await this same promise */
    #parsing: Promise<void> | null = null;
    /** the single in-flight authorized download */
    #downloading: Promise<void> | null = null;

    constructor(opts: ListfileIndexOptions) {
        this.csvPath = opts.csvPath;
        this.#fetch = opts.fetch;
    }

    get size(): number {
        return this.#names.length;
    }

    /**
     * Current lifecycle state — the exact payload health publishes.
     *
     * `updateAvailable` is deliberately conservative: it is only true when we
     * know BOTH the stored release and a newer one. An unknown stored release
     * (a CSV fetched before provenance was recorded) is reported as unknown,
     * not as up to date.
     */
    get capability(): SearchCapability {
        const updateAvailable =
            this.#release !== undefined && this.#latestRelease !== undefined
                ? this.#release !== this.#latestRelease
                : undefined;

        const cap: SearchCapability = { status: this.#status, entries: this.#names.length };
        if (this.#status !== "ready" && this.#detail) cap.detail = this.#detail;
        if (this.#release) cap.release = this.#release;
        if (this.#fetchedAt) cap.fetchedAt = this.#fetchedAt;
        if (this.#latestRelease) cap.latestRelease = this.#latestRelease;
        if (updateAvailable !== undefined) cap.updateAvailable = updateAvailable;
        if (this.#checkedAt) cap.checkedAt = this.#checkedAt;
        if (this.#refreshing) cap.refreshing = true;
        return cap;
    }

    /** Synchronous search; only meaningful once `capability.status` is "ready". */
    search(query: string, limit = 50): SearchHit[] {
        const q = query.toLowerCase();
        const hits: SearchHit[] = [];
        for (let i = 0; i < this.#names.length && hits.length < limit; i++) {
            if (this.#names[i]!.toLowerCase().includes(q)) {
                hits.push({ filedata: this.#filedata[i]!, name: this.#names[i]! });
            }
        }
        return hits;
    }

    /**
     * Load whatever is already on disk and report the state. NEVER downloads.
     *
     * The local parse is always awaited (bounded by LOCAL_PARSE_BUDGET_MS):
     * without it a warm install answers "indexing" for the second it takes to
     * read the file it already has, and the tool looks flaky.
     *
     * `waitMs` only ever joins a download somebody else already authorized; it
     * cannot start one.
     */
    async ensure(waitMs = 0): Promise<SearchCapability> {
        if (this.#status === "ready") return this.capability;

        const parse = this.#startParse();
        await raceWithTimeout(parse, LOCAL_PARSE_BUDGET_MS);

        if (waitMs > 0 && this.#downloading) {
            await raceWithTimeout(this.#downloading, waitMs);
        }
        return this.capability;
    }

    /**
     * Start (or join) the single authorized download. This is the ONLY method
     * that puts bytes on disk; the caller is responsible for having obtained
     * the user's consent.
     *
     * `waitMs` bounds how long the caller blocks. It defaults to "block until
     * the download settles" — a caller that just obtained consent wants the
     * outcome, not a fire-and-forget acknowledgement. Pass a number (the HTTP
     * route always does) for a bounded wait; an explicit `0` returns
     * immediately with `indexing` and the download continues in the
     * background. A bounded wait never cancels the shared download, so an
     * impatient agent call cannot sabotage it for everyone else.
     */
    async fetch(waitMs?: number): Promise<SearchCapability> {
        const build = this.#startDownload();
        if (waitMs === undefined) {
            await build;
        } else if (waitMs > 0) {
            await raceWithTimeout(build, waitMs);
        }
        return this.capability;
    }

    /**
     * Record the outcome of one freshness check. Never downloads, never mutates
     * the index itself.
     *
     * `tag` is null when the check could not reach the release API. The
     * timestamp is recorded either way: an operator needs to distinguish "we
     * looked 5 minutes ago and the answer was 'nothing new'" from "we last
     * managed to look three days ago", and a failed attempt must not erase the
     * release we already knew about.
     */
    noteCheck(tag: string | null, at = new Date().toISOString()): void {
        this.#checkedAt = at;
        if (tag) this.#latestRelease = tag;
    }

    /** The release currently on disk, if provenance was recorded. */
    get release(): string | undefined {
        return this.#release;
    }

    /**
     * (Re)load from a CSV path. Returns false when the file is absent. Kept for
     * fixtures/tests and for callers that manage the CSV themselves.
     */
    async load(csvPath: string = this.csvPath): Promise<boolean> {
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
        this.#names = names;
        this.#filedata = filedata;
        this.#status = names.length > 0 ? "ready" : "error";
        this.#detail =
            names.length > 0
                ? undefined
                : `listfile at ${csvPath} parsed to zero names. ${RETRY_HINT}`;

        // Provenance travels with the CSV: without it "is my index stale?" has
        // no answer, which is exactly the question the check exists to answer.
        const meta = await readListfileMeta(csvPath);
        this.#release = meta?.release;
        this.#fetchedAt = meta?.fetchedAt || undefined;
        return names.length > 0;
    }

    /** Kick off (or join) the single local parse. Never rejects. */
    #startParse(): Promise<void> {
        this.#parsing ??= (async () => {
            if (await this.load()) {
                this.#detail = undefined;
                return;
            }
            // No usable CSV. Only a download already in flight keeps us out of
            // "absent" — `ensure()` itself will not start one.
            if (this.#downloading) {
                this.#status = "indexing";
                this.#detail = `downloading community-listfile.csv (~146 MB, user-authorized). ${RETRY_HINT}`;
                return;
            }
            this.#status = "absent";
            this.#detail = ABSENT_DETAIL;
        })().finally(() => {
            this.#parsing = null;
        });
        return this.#parsing;
    }

    /** Kick off (or join) the single authorized download. Never rejects. */
    #startDownload(): Promise<void> {
        this.#downloading ??= this.#download().finally(() => {
            this.#downloading = null;
            this.#refreshing = false;
        });
        return this.#downloading;
    }

    async #download(): Promise<void> {
        // "Do we already have a usable index?" is about whether queries can be
        // answered, not about whether a parse has happened yet. A CSV sitting on
        // disk that nobody has read still counts: a failed download must never
        // turn a warm install into "error".
        const hadIndex = this.#status === "ready" || this.#names.length > 0;
        // Refreshing behind a usable index must not downgrade a working search
        // to "indexing"; `refreshing` tells the truth without breaking queries.
        if (!hadIndex) {
            this.#status = "indexing";
            this.#detail = `downloading community-listfile.csv (~146 MB, user-authorized). ${RETRY_HINT}`;
        }
        this.#refreshing = hadIndex;

        if (!this.#fetch) {
            if (!hadIndex) {
                this.#status = "error";
                this.#detail = `this build cannot download the listfile. ${RETRY_HINT}`;
            }
            return;
        }

        let release: string | undefined;
        try {
            const result = await this.#fetch(this.csvPath);
            release = result?.release;
        } catch (err) {
            if (await this.#recoverFromDisk(hadIndex)) return;
            this.#status = "error";
            this.#detail = `listfile download failed: ${err instanceof Error ? err.message : String(err)} ${RETRY_HINT}`;
            return;
        }

        if (release) {
            // Provenance is a nice-to-have, not a reason to throw away a
            // completed 146 MB download: a read-only or full disk must degrade
            // to "release unknown", never to an unhandled rejection.
            await writeListfileMeta(this.csvPath, {
                release,
                fetchedAt: new Date().toISOString(),
            }).catch(() => {});
        }

        if (await this.load()) {
            this.#detail = undefined;
            return;
        }

        if (!hadIndex) {
            this.#status = "error";
            this.#detail = `listfile downloaded to ${this.csvPath} but could not be parsed. ${RETRY_HINT}`;
        }
    }

    /**
     * A failed download is only fatal if there is genuinely nothing to serve.
     * Re-reading the local file is what stops a transient network error from
     * disabling atlas_search on an install that already had the index.
     */
    async #recoverFromDisk(hadIndex: boolean): Promise<boolean> {
        if (hadIndex) return true;
        if (!(await this.load())) return false;
        this.#detail = undefined;
        return true;
    }
}

/** Await `promise`, but give up after `ms`. Never rejects, never cancels. */
async function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            promise.catch(() => {}),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
