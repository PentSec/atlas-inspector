/**
 * Runtime version — read from package.json at module load. `import.meta.dirname`
 * is the CJS-free ESM way to get the current file's directory; in the compiled
 * server the emit lives one level deeper (dist/server/server/) than in src
 * (src/server/), so instead of a fixed "../../package.json" we climb up until we
 * find a package.json with a matching name.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

function findPackageVersion(dir: string): string | undefined {
  for (let d = dir; d.length > 1; d = path.dirname(d)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(d, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "atlas-inspector") return pkg.version;
    } catch {
      // keep climbing
    }
  }
  return undefined;
}

export const version: string = findPackageVersion(import.meta.dirname) ?? "0.0.0-dev";