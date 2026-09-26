#!/usr/bin/env node
/**
 * Pre-download the community listfile used by /api/v1/search.
 *
 * The server NEVER downloads on its own (ADR-020): the ~146 MB fetch requires
 * the user's explicit approval, which an agent obtains through the
 * `atlas_prepare_index` MCP tool. This script is the manual equivalent — for
 * offline installs, for pre-warming an image, or for a user who declined the
 * in-app prompt. It is also the path a copied `cache/` directory comes from.
 *
 * The download itself lives in the server so there is exactly one
 * implementation — see src/server/services/listfileFetch.ts. We import the
 * compiled copy here, which means a build must exist.
 *
 * Use:
 *   node scripts/fetch-listfile.mjs                -> cache/listfile.csv (repo default)
 *   ATLAS_ROOT=/p npm run fetch:listfile           -> /p/cache/listfile.csv
 *   LISTFILE_PATH=/x/listfile.csv npm run fetch:listfile
 *   LISTFILE_URL=/mirror/community-listfile.csv npm run fetch:listfile
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiled = path.join(root, "dist", "server", "server", "services", "listfileFetch.js");

if (!existsSync(compiled)) {
    process.stderr.write(
        "fetch-listfile needs the compiled server module.\n" +
            "  Build first:   npm run build:server\n" +
            "  Or start the app and use the atlas_prepare_index MCP tool, which asks the user first.\n",
    );
    process.exit(1);
}

const { DEFAULT_LISTFILE_URL, fetchListfile, metaPathFor, writeListfileMeta } = await import(
    `file://${compiled}`
);

function resolveTarget() {
    const envListfile = process.env.LISTFILE_PATH?.trim();
    if (envListfile) return path.resolve(envListfile);
    const envRoot = process.env.ATLAS_ROOT?.trim();
    return path.join(envRoot ? path.resolve(envRoot) : root, "cache", "listfile.csv");
}

const target = resolveTarget();
const url = process.env.LISTFILE_URL?.trim() || DEFAULT_LISTFILE_URL;
const releaseApi = process.env.LISTFILE_RELEASE_API?.trim() || undefined;

process.stdout.write(`→ ${url}\n→ ${target}\n`);

try {
    const result = await fetchListfile({
        target,
        url,
        releaseApiUrl: releaseApi,
        userAgent: "atlas-inspector/fetch-listfile (https://github.com/)",
    });

    // Same sidecar the server writes, so a manually pre-seeded install reports
    // its release and can be checked for updates like any other.
    if (result.release) {
        await writeListfileMeta(target, {
            release: result.release,
            fetchedAt: new Date().toISOString(),
        });
    }

    process.stdout.write(
        `✓ ${target} (${result.bytes.toLocaleString("en-US")} bytes)\n` +
            (result.release
                ? `  release ${result.release} → ${metaPathFor(target)}\n`
                : "  release tag unavailable — freshness will report an unknown update state\n"),
    );
} catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
}
