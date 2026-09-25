/**
 * WoW build-version handling.
 *
 * Builds are 4-part numeric versions: `10.2.5.52646` (MAJOR.MINOR.PATCH.BUILD).
 * Standard SemVer (`semver`) can not parse 4 numeric parts and Prerelease/
 * Build metadata semantics do not apply, so this small module replaces it.
 */

export type BuildParts = readonly [number, number, number, number];

const ZERO: BuildParts = [0, 0, 0, 0];

/** Parse a version string into 4 numeric parts; malformed/missing -> zeros. */
export function buildParts(v: string | null | undefined): BuildParts {
    if (!v) return ZERO;
    const out: number[] = [];
    for (const part of v.split(".").slice(0, 4)) {
        const n = Number.parseInt(part, 10);
        out.push(Number.isNaN(n) ? 0 : n);
    }
    while (out.length < 4) out.push(0);
    return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/** Compare version strings. Returns &lt;0 / 0 / &gt;0. */
export function cmpBuild(a: string | null | undefined, b: string | null | undefined): number {
    return cmpParts(buildParts(a), buildParts(b));
}

/** Compare parsed parts. Returns &lt;0 / 0 / &gt;0. */
export function cmpParts(a: BuildParts, b: BuildParts): number {
    for (let i = 0; i < 4; i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** True when `a` &gt;= `b`. */
export function buildGte(a: string, b: string): boolean {
    return cmpBuild(a, b) >= 0;
}

/** True when `lo <= v < hi` (half-open). */
export function buildInRange(v: string, lo: BuildParts, hi: BuildParts): boolean {
    const k = buildParts(v);
    return cmpParts(k, lo) >= 0 && cmpParts(k, hi) < 0;
}

/** Returns the newest of a list of version strings. */
export function newestOf(versions: Iterable<string>): string | null {
    let best: string | null = null;
    for (const v of versions) {
        if (best === null || cmpBuild(v, best) > 0) best = v;
    }
    return best;
}

/** Sort a list of version strings, newest first. */
export function newestFirst(versions: Iterable<string>): string[] {
    return [...new Set(versions)].sort((a, b) => cmpBuild(b, a));
}
