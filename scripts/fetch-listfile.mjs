// fetch-listfile.mjs — download the community listfile for /api/v1/search.
//
// Source: wowdev/wow-listfile release artifact `community-listfile.csv`
// (https://github.com/wowdev/wow-listfile/releases/latest/download/...).
// Format: one `FileDataID;path` per line, CRLF, lowercase paths — exactly what
// ListfileIndex.load() parses (it also tolerates a header row and junk).
//
// Use:
//   node scripts/fetch-listfile.mjs                -> cache/listfile.csv (repo default)
//   ATLAS_ROOT=/p npm run fetch:listfile           -> /p/cache/listfile.csv
//   LISTFILE_PATH=/x/listfile.csv npm run fetch:listfile
//
// The file is ~150 MB and grows each build; it is gitignored runtime data.
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const DEFAULT_URL =
  "https://github.com/wowdev/wow-listfile/releases/latest/download/community-listfile.csv";
const USER_AGENT = "atlas-inspector/0.2.0 (https://github.com/)";

function resolveTarget() {
  const envListfile = process.env.LISTFILE_PATH?.trim();
  if (envListfile) return path.resolve(envListfile);
  const root = process.env.ATLAS_ROOT?.trim()
    ? path.resolve(process.env.ATLAS_ROOT)
    : path.resolve(import.meta.dirname, "..");
  return path.join(root, "cache", "listfile.csv");
}

async function main() {
  const target = resolveTarget();
  const url = process.env.LISTFILE_URL?.trim() || DEFAULT_URL;
  await mkdir(path.dirname(target), { recursive: true });

  process.stdout.write(`→ ${url}\n→ ${target}\n`);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`listfile download failed: HTTP ${res.status}`);
  }

  const tmp = `${target}.tmp`;
  const out = createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(res.body).pipe(out);
    out.on("error", reject);
    out.on("finish", resolve);
  });
  await rename(tmp, target);

  const bytes = (await stat(target)).size;
  process.stdout.write(`✓ ${target} (${bytes.toLocaleString()} bytes)\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-listfile: ${err.message}\n`);
  process.exit(2);
});