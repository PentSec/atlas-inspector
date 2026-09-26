/**
 * WagoSource — real upstream over HTTP(S).
 *
 * Keeps the legacy retry policy byte-for-byte (5 tries, linear backoff
 * 1500 + n*1000 ms) but adds two explicit fixes approved in the audit:
 *  - an honest User-Agent (was a spoofed Chrome UA)
 *  - a request timeout and a minimum interval between requests (E1)
 */
import { fetch } from "undici";

import type { Logger } from "../logger.js";
import { UpstreamConnectionError, type WowFileSource } from "./wowSource.js";

export interface WagoSourceOptions {
    baseUrl: string;
    userAgent: string;
    logger: Logger;
    timeoutMs?: number;
    maxRetries?: number;
    minIntervalMs?: number;
}

export class WagoSource implements WowFileSource {
    static readonly defaultTimeoutMs = 30_000;
    static readonly defaultMaxRetries = 5;
    static readonly defaultMinIntervalMs = 150;

    private readonly opts: WagoSourceOptions;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly minIntervalMs: number;
    private lastRequestAt = 0;

    constructor(opts: WagoSourceOptions) {
        this.opts = opts;
        this.timeoutMs = opts.timeoutMs ?? WagoSource.defaultTimeoutMs;
        this.maxRetries = opts.maxRetries ?? WagoSource.defaultMaxRetries;
        this.minIntervalMs = opts.minIntervalMs ?? WagoSource.defaultMinIntervalMs;
    }

    url(pathOrUrl: string): string {
        return this.opts.baseUrl + pathOrUrl;
    }

    async getFile(url: string): Promise<Buffer | null> {
        let cause: unknown;
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            await this.throttle();
            try {
                return await this.once(url);
            } catch (err) {
                cause = err;
                if (attempt === this.maxRetries - 1) {
                    this.opts.logger.warn(
                        { err: String(cause), url, attempts: this.maxRetries },
                        "upstream request gave up",
                    );
                    return null;
                }
                const backoff = 1500 + attempt * 1000;
                this.opts.logger.debug(
                    { err: String(cause), url, attempt, backoff },
                    "upstream retry",
                );
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
        return null;
    }

    private async throttle(): Promise<void> {
        const since = Date.now() - this.lastRequestAt;
        const wait = this.minIntervalMs - since;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastRequestAt = Date.now();
    }

    private async once(url: string): Promise<Buffer> {
        let res: Awaited<ReturnType<typeof fetch>>;
        try {
            res = await fetch(url, {
                headers: { "User-Agent": this.opts.userAgent },
                redirect: "follow",
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            if (err instanceof Error && err.name === "TimeoutError") {
                throw new UpstreamConnectionError("upstream request timed out", err);
            }
            throw new UpstreamConnectionError("upstream request failed", err);
        }
        if (res.status === 400 || res.status === 404) return Buffer.alloc(0);
        if (!res.ok) throw new UpstreamConnectionError(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
}
