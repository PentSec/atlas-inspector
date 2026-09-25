/**
 * Auto-start the Atlas Inspector app when the MCP boots.
 *
 * The MCP talks to the app's /api/v1 over HTTP (ATLAS_URL). Instead of
 * requiring the user to run `node start.mjs` by hand before every agent
 * session, the MCP spawns it lazily when it is not reachable yet. `start.mjs`
 * remains the manual path (its workflow is untouched).
 *
 * Behavior:
 *   - Health-check ATLAS_URL (GET /api/v1/health). Reachable  → nothing.
 *   - Loopback URL and not reachable → spawn the detached launcher, then poll
 *     until the app answers (data dir dirtied by first-time npm build etc.).
 *   - Non-loopback URL (remote host)     → never spawn, log a hint instead.
 *   - ATLAS_AUTOSTART=0                  → opt out entirely.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

interface EnsureAppOptions {
    baseUrl?: string;
    root?: string;
    timeoutMs?: number;
    ping?: (baseUrl: string) => Promise<boolean>;
    spawnNode?: typeof spawn;
    onLog?: (line: string) => void;
}

export interface EnsureAppResult {
    started: boolean;
    ok: boolean;
    pid?: number;
}

const logToStderr = (line: string) => {
    console.error(`[atlas-inspector] ${line}`);
};

function findRoot(start: string): string {
    let cur = start;
    for (;;) {
        if (existsSync(path.join(cur, "package.json"))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) throw new Error("could not locate project root");
        cur = parent;
    }
}

async function healthReachable(baseUrl: string): Promise<boolean> {
    try {
        const res = await fetch(`${baseUrl}/api/v1/health`, {
            signal: AbortSignal.timeout(2_000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function childLog(child: ChildProcess, filename: string): void {
    const stream = createWriteStream(filename, { flags: "a" });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    child.on("error", () => {
        /* spawn failure is surfaced by the health poll timing out */
    });
}

export async function ensureAppRunning(opts: EnsureAppOptions = {}): Promise<EnsureAppResult> {
    const baseUrl = (opts.baseUrl ?? process.env.ATLAS_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
    const ping = opts.ping ?? healthReachable;
    const log = opts.onLog ?? logToStderr;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (await ping(baseUrl)) return { started: false, ok: true };

    if (process.env.ATLAS_AUTOSTART === "0") {
        log("ATLAS_AUTOSTART=0 and the app is not reachable — tools will report connection errors.");
        return { started: false, ok: false };
    }

    const url = new URL(baseUrl);
    if (!LOOPBACK.has(url.hostname)) {
        log(`ATLAS_URL points at a remote host (${baseUrl}) — not launching a local app.`);
        return { started: false, ok: false };
    }

    const root = opts.root ?? findRoot(path.dirname(fileURLToPath(import.meta.url)));
    const startEntry = path.join(root, "start.mjs");
    const port = url.port || "8000";
    log(`app not reachable — spawning \`node start.mjs\` on port ${port}…`);

    const spawnNode = opts.spawnNode ?? spawn;
    const child = spawnNode(process.execPath, [startEntry], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: port },
    });
    child.unref();
    childLog(child, path.join(root, "cache", "mcp-app.log"));

    const deadline = Date.now() + timeoutMs;
    for (;;) {
        await delay(POLL_INTERVAL_MS);
        if (await ping(baseUrl)) return { started: true, ok: true, pid: child.pid };
        if (Date.now() >= deadline) {
            log(`app did not answer within ${timeoutMs}ms (pid ${child.pid}) — check cache/mcp-app.log.`);
            return { started: true, ok: false, pid: child.pid };
        }
    }
}

export function isReachableBackend(baseUrl: string): Promise<boolean> {
    return healthReachable(baseUrl.replace(/\/+$/, ""));
}