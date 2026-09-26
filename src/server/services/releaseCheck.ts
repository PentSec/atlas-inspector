/**
 * Periodic listfile freshness check (ADR-020).
 *
 * A 146 MB index goes stale silently: names get added and renamed every build,
 * and a search that returns zero hits for a file that was renamed two patches
 * ago reads as "no such texture". That is a dangerous kind of wrong, so the
 * server tracks staleness — but it must do so *cheaply*.
 *
 * Hence: one ~14 KB read of the release metadata, no bytes of listfile ever
 * downloaded from here. The CSV only moves when a human consents, and this
 * module's whole job is to make sure the app tells them there is something new
 * to consent to. It records the tag it saw; the index compares it against the
 * tag stored next to the CSV and publishes `updateAvailable`.
 *
 * Two rules, both learned the hard way:
 *
 *  - A failed check is not an error. GitHub rate-limits unauthenticated
 *    callers to 60/hour; an offline laptop should keep searching. The check
 *    swallows everything and leaves the previous answer in place.
 *  - Nothing here is allowed to hold the event loop open. Every timer is
 *    `unref()`ed and every handle is stoppable, so a test or a shutdown does
 *    not wait out a 7-hour interval.
 */
import type { FastifyBaseLogger } from "fastify";

import { resolveLatestRelease, type FetchLike, type ListfileRelease } from "./listfileFetch.js";
import type { ListfileIndex } from "./search.js";

/**
 * Floor for the check interval. There is no reason to poll a third-party API
 * more than ~3x a day, and no benefit: the listfile ships with the game build,
 * not on a web cadence.
 */
export const LISTFILE_CHECK_MIN_INTERVAL_HOURS = 7;

const MS_PER_HOUR = 3_600_000;

export interface ReleaseCheckOptions {
    /** index whose capability should learn about the newest release */
    index: ListfileIndex;
    /** release metadata endpoint (not the asset URL) */
    apiUrl: string;
    intervalMs: number;
    /** delay before the very first check; keeps boot from waiting on the network */
    initialDelayMs?: number;
    fetchImpl?: FetchLike;
    log?: Pick<FastifyBaseLogger, "debug" | "warn">;
    onCheck?: (release: ListfileRelease | null) => void;
}

export interface ReleaseCheckHandle {
    /** run a check now, outside the schedule; never throws */
    checkNow(): Promise<void>;
    /** cancel the schedule; safe to call more than once */
    stop(): void;
}

/**
 * Start the schedule. The first check is deliberately deferred: `/health` must
 * stay fast and side-effect free, and a user who just started the app should
 * not see startup latency for a freshness nag.
 *
 * Throws if the interval is below LISTFILE_CHECK_MIN_INTERVAL_HOURS — an
 * "optimization" that hammers someone else's API is a bug, not a setting.
 */
export function startReleaseCheck(opts: ReleaseCheckOptions): ReleaseCheckHandle {
    const { index, apiUrl, intervalMs, initialDelayMs = 30_000, fetchImpl, log, onCheck } = opts;

    if (intervalMs < LISTFILE_CHECK_MIN_INTERVAL_HOURS * MS_PER_HOUR) {
        throw new RangeError(
            `release check interval must be at least ${LISTFILE_CHECK_MIN_INTERVAL_HOURS}h, got ${intervalMs}ms`,
        );
    }

    let stopped = false;

    const checkNow = async (): Promise<void> => {
        if (stopped) return;
        const release = await resolveLatestRelease(apiUrl, fetchImpl);
        // Always record the attempt; only a successful lookup replaces the
        // known release. Keeping the previous tag across a network blip is the
        // difference between "up to date" and "we stopped checking".
        index.noteCheck(release?.tag ?? null);
        if (release) {
            log?.debug({ release: release.tag, stored: index.release }, "listfile release check");
        } else {
            log?.debug("listfile release check inconclusive");
        }
        onCheck?.(release);
    };

    const timer = setInterval(() => {
        void checkNow();
    }, intervalMs);
    timer.unref();

    const kickoff = setTimeout(() => {
        void checkNow();
    }, initialDelayMs);
    kickoff.unref();

    return {
        checkNow,
        stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(timer);
            clearTimeout(kickoff);
        },
    };
}
