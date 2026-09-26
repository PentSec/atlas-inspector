#!/usr/bin/env node
/**
 * One-shot launcher — starts the Atlas Inspector server on any platform that
 * has Node.js installed (Windows / macOS / Linux).
 *
 *   node start.mjs                 # prod build (auto-builds if missing), then run
 *   node start.mjs --dev           # run straight from source with tsx (hot reload)
 *   PORT=9000 node start.mjs       # env vars pass through, see README
 *
 * Exits non-zero with a friendly message if the runtime prerequisites are
 * missing. No shell commands are used on Windows beyond spawning `npm` for the
 * optional build step.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === "win32";

const DIST_ENTRY = path.join(root, "dist", "server", "server", "index.js");
const SRC_ENTRY = path.join(root, "src", "server", "index.ts");
const NPM = isWin ? "npm.cmd" : "npm";

const env = { ...process.env, PORT: process.env.PORT || "8000" };
const args = process.argv.slice(2).filter((a) => a !== "node");

function log(msg) {
    // eslint-disable-next-line no-console
    console.log(`[atlas-inspector] ${msg}`);
}

function run(cmd, cmdArgs, opts = {}) {
    const child = spawn(cmd, cmdArgs, {
        cwd: root,
        env,
        stdio: "inherit",
        shell: isWin,
        ...opts,
    });
    child.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error(`[atlas-inspector] failed to start: ${err.message}`);
        process.exit(1);
    });
    return child;
}

function buildOnce() {
    log("build not found — running `npm run build` once…");
    const r = spawnSync(NPM, ["run", "build"], { cwd: root, env, stdio: "inherit", shell: isWin });
    if (r.status !== 0 || !existsSync(DIST_ENTRY)) {
        // eslint-disable-next-line no-console
        console.error(
            "[atlas-inspector] build failed and no compiled server was produced.\n" +
                "  Install dependencies first:  npm install\n" +
                "  Then retry:                  node start.mjs " +
                (args.join(" ") || ""),
        );
        process.exit(r.status ?? 1);
    }
    return true;
}

function isTsxAvailable() {
    return existsSync(path.join(root, "node_modules", "tsx", "dist", "cli.mjs"));
}

if (args.includes("--dev")) {
    if (!isTsxAvailable()) {
        // eslint-disable-next-line no-console
        console.error("[atlas-inspector] --dev needs tsx (install with `npm install`).");
        process.exit(1);
    }
    log("dev mode — running from source (change files and the server restarts)");
    run(process.execPath, [
        path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
        "watch",
        SRC_ENTRY,
    ]);
} else if (existsSync(DIST_ENTRY) || buildOnce()) {
    log(`serving on http://${env.HOST || "127.0.0.1"}:${env.PORT}  (API docs at /documentation)`);
    run(process.execPath, ["--env-file-if-exists=.env", DIST_ENTRY]);
} else {
    // eslint-disable-next-line no-console
    console.error("[atlas-inspector] nothing to run. Install deps (`npm install`) and retry.");
    process.exit(1);
}
