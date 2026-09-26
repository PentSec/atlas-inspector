/**
 * FileCache — two-tier cache (in-memory LRU + atomic disk files) with TTL.
 *
 * Missing/expired entries re-fetch upstream; every write lands on disk via
 * tmp+rename so a crash never leaves a torn file that could poison the cache.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { LRUCache } from "lru-cache";

import { atomicWrite, readFresh } from "./fs.js";
import type { Logger } from "../logger.js";

export interface FileCacheOptions {
    dir: string;
    /** disk entries older than this are considered stale */
    ttlMs: number;
    /** upper bound of bytes held in the in-memory LRU */
    memoryByteLimit: number;
    logger: Logger;
}

export class FileCache {
    private readonly mem: LRUCache<string, Buffer>;
    private readonly dir: string;
    private readonly ttlMs: number;
    private readonly logger: Logger;
    private readonly memoryByteLimit: number;
    private ready: Promise<void> | null = null;

    constructor(opts: FileCacheOptions) {
        this.dir = opts.dir;
        this.ttlMs = opts.ttlMs;
        this.logger = opts.logger;
        this.memoryByteLimit = opts.memoryByteLimit;
        this.mem = new LRUCache({
            maxSize: opts.memoryByteLimit,
            sizeCalculation: (buf) => buf.length,
            ttl: opts.ttlMs,
            noDisposeOnSet: true,
        });
    }

    /** Lazily create the cache dir once (idempotent). */
    init(): Promise<void> {
        this.ready ??= mkdir(this.dir, { recursive: true }).then(() => {});
        return this.ready;
    }

    get(entryName: string): Buffer | undefined {
        return this.mem.get(entryName);
    }

    has(entryName: string): boolean {
        return this.mem.has(entryName);
    }

    async getFromDisk(entryName: string): Promise<Buffer | undefined> {
        const cached = this.mem.get(entryName);
        if (cached) return cached;
        await this.init();
        const filePath = path.join(this.dir, entryName);
        const { data, fresh } = await readFresh(filePath, this.ttlMs);
        if (!fresh || data === null) return undefined;
        this.mem.set(entryName, data);
        return data;
    }

    async setFromBuffer(entryName: string, data: Buffer): Promise<void> {
        this.mem.set(entryName, data, { size: data.length });
        await this.init();
        await atomicWrite(path.join(this.dir, entryName), data).catch((err) => {
            this.logger.warn({ err, entryName }, "cache disk write failed");
        });
    }
}
