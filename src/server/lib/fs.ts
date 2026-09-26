/**
 * Filesystem helpers: atomic writes (tmp + rename, ADR-005) and TTL reads.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Write `data` to `filePath` atomically (sidesteps the P2 TOCTOU bug). */
export async function atomicWrite(filePath: string, data: Buffer | Uint8Array): Promise<void> {
    const dir = path.dirname(filePath);
    const tmp = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    await writeFile(tmp, data);
    try {
        await rename(tmp, filePath);
    } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
    }
}

export interface FreshRead {
    data: Buffer | null;
    fresh: boolean;
}

/** Read a file, returning null when missing or older than `ttlMs`. */
export async function readFresh(filePath: string, ttlMs: number): Promise<FreshRead> {
    let st;
    try {
        st = await stat(filePath);
    } catch {
        return { data: null, fresh: false };
    }
    if (Date.now() - st.mtimeMs > ttlMs) {
        return { data: null, fresh: false };
    }
    const data = await readFile(filePath);
    return { data, fresh: true };
}
