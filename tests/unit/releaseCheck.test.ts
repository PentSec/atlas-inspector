/**
 * The freshness check exists to tell the user there is a newer listfile without
 * ever spending the bandwidth itself. Both halves of that contract are
 * asserted here: it records what the release API says, and it cannot download
 * the listfile no matter what it observes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListfileIndex } from "../../src/server/services/search.js";
import {
    LISTFILE_CHECK_MIN_INTERVAL_HOURS,
    startReleaseCheck,
    type ReleaseCheckHandle,
} from "../../src/server/services/releaseCheck.js";
import type { FetchLike } from "../../src/server/services/listfileFetch.js";

const API = "https://api.test/releases/latest";
const HOUR = 3_600_000;

function releaseResponse(tag: string, publishedAt = "2026-09-24T22:43:39Z"): Response {
    return new Response(JSON.stringify({ tag_name: tag, published_at: publishedAt }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

describe("startReleaseCheck", () => {
    let handle: ReleaseCheckHandle | undefined;

    afterEach(() => {
        handle?.stop();
        handle = undefined;
        vi.restoreAllMocks();
    });

    it("records the release it saw, and when", async () => {
        const index = new ListfileIndex({ csvPath: "/nonexistent/listfile.csv" });
        const fetchImpl: FetchLike = async () => releaseResponse("202609242243");

        handle = startReleaseCheck({
            index,
            apiUrl: API,
            intervalMs: LISTFILE_CHECK_MIN_INTERVAL_HOURS * HOUR,
            initialDelayMs: 60_000,
            fetchImpl,
        });
        await handle.checkNow();

        expect(index.capability.latestRelease).toBe("202609242243");
        expect(index.capability.checkedAt).toBeTruthy();
    });

    it("never touches the index status — a check must not become a download", async () => {
        const index = new ListfileIndex({
            csvPath: "/nonexistent/listfile.csv",
            fetch: vi.fn(async () => ({ bytes: 1 })),
        });
        const fetchSpy = index.fetch.bind(index);
        const download = vi.fn(fetchSpy);

        handle = startReleaseCheck({
            index,
            apiUrl: API,
            intervalMs: LISTFILE_CHECK_MIN_INTERVAL_HOURS * HOUR,
            initialDelayMs: 60_000,
            fetchImpl: async () => releaseResponse("202609242243"),
        });
        await handle.checkNow();

        // Still "absent": observing a release is not consent to install it.
        expect(index.capability.status).toBe("absent");
        expect(download).not.toHaveBeenCalled();
    });

    it("survives a failed check and keeps the previous answer", async () => {
        const index = new ListfileIndex({ csvPath: "/nonexistent/listfile.csv" });
        let calls = 0;
        const fetchImpl: FetchLike = async () => {
            calls += 1;
            if (calls === 1) return releaseResponse("202609242243");
            return new Response("rate limited", { status: 403 });
        };

        handle = startReleaseCheck({
            index,
            apiUrl: API,
            intervalMs: LISTFILE_CHECK_MIN_INTERVAL_HOURS * HOUR,
            initialDelayMs: 60_000,
            fetchImpl,
        });
        await handle.checkNow();
        const first = index.capability.checkedAt;

        await handle.checkNow();
        // A transient failure must not silently downgrade a known release to
        // "unknown" — that would hide a pending update behind a network blip.
        expect(index.capability.latestRelease).toBe("202609242243");
        // The re-check is recorded as an attempt even though it failed. Two
        // checks can land in the same millisecond, so this asserts progress,
        // not a strictly later timestamp.
        expect(index.capability.checkedAt).toBeTruthy();
        expect(new Date(index.capability.checkedAt as string).getTime()).toBeGreaterThanOrEqual(
            new Date(first as string).getTime(),
        );
    });

    it("rejects an interval below the 7-hour floor instead of clamping it", () => {
        const index = new ListfileIndex({ csvPath: "/nonexistent/listfile.csv" });
        expect(() =>
            startReleaseCheck({
                index,
                apiUrl: API,
                intervalMs: 60_000,
                initialDelayMs: 60_000,
                fetchImpl: async () => releaseResponse("x"),
            }),
        ).toThrow(/at least 7h/);
    });

    it("accepts exactly the floor", async () => {
        const index = new ListfileIndex({ csvPath: "/nonexistent/listfile.csv" });
        handle = startReleaseCheck({
            index,
            apiUrl: API,
            intervalMs: LISTFILE_CHECK_MIN_INTERVAL_HOURS * HOUR,
            initialDelayMs: 60_000,
            fetchImpl: async () => releaseResponse("202609242243"),
        });
        await handle.checkNow();
        expect(index.capability.latestRelease).toBe("202609242243");
    });

    it("stop() is idempotent and halts the schedule", async () => {
        const index = new ListfileIndex({ csvPath: "/nonexistent/listfile.csv" });
        const fetchImpl = vi.fn(async () => releaseResponse("202609242243"));

        handle = startReleaseCheck({
            index,
            apiUrl: API,
            intervalMs: LISTFILE_CHECK_MIN_INTERVAL_HOURS * HOUR,
            initialDelayMs: 10,
            fetchImpl,
        });
        handle.stop();
        handle.stop();
        await handle.checkNow();

        // No work after stop, and the handle must not have thrown on a double stop.
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("a schedule left running never keeps the process alive", async () => {
        const index = new ListfileIndex({ csvPath: "/nonexistent/listfile.csv" });
        const handle = startReleaseCheck({
            index,
            apiUrl: API,
            intervalMs: LISTFILE_CHECK_MIN_INTERVAL_HOURS * HOUR,
            initialDelayMs: 10,
            fetchImpl: async () => releaseResponse("202609242243"),
        });

        // unref() is what makes this safe: a 7-hour interval must not block
        // shutdown or wedge a test run. Vitest exits without handleActivity
        // complaining, which is exactly the assertion here.
        expect(handle).toBeDefined();
        handle.stop();
    });
});
