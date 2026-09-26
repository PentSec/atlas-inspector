/**
 * API client — talks exclusively to the /api/v1 surface (ADR-013).
 * The old client's /api/render preview is replaced by a two-step flow:
 *   GET  /api/v1/files/{fdid}/blp   -> raw BLP bytes
 *   POST /api/v1/blp/decode        -> { pngUrl } served by the decode cache
 */
import type {
    AtlasResult,
    BlpDecodeResult,
    BuildsResponse,
    FileInfo,
    Health,
    Problem,
} from "../../shared/schemas.js";

const V1 = "/api/v1";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await fetch(url, init);
    let json: unknown;
    try {
        json = await r.json();
    } catch {
        throw new Error(`bad response (${r.status})`);
    }
    if (!r.ok) {
        const problem = json as Partial<Problem>;
        throw new Error(problem.detail ?? problem.title ?? `request failed (${r.status})`);
    }
    return json as T;
}

export function health(): Promise<Health> {
    return fetchJson(`${V1}/health`);
}

export function builds(): Promise<BuildsResponse> {
    return fetchJson(`${V1}/builds`);
}

export function fileInfo(fdid: number): Promise<FileInfo> {
    return fetchJson(`${V1}/files/${fdid}`);
}

/** Atlas lookup — resolves `{kind:"atlas"}` or `{kind:"texture"}`, throws on missing. */
export function atlas(fdid: number, build?: string): Promise<AtlasResult> {
    const q = build ? `?build=${encodeURIComponent(build)}` : "";
    return fetchJson(`${V1}/atlas/${fdid}${q}`);
}

/** Raw BLP bytes for FileDataID + optional build version. */
export async function blpBytes(fdid: number, version?: string): Promise<ArrayBuffer> {
    const q = version ? `?version=${encodeURIComponent(version)}` : "";
    const r = await fetch(`${V1}/files/${fdid}/blp${q}`);
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    return r.arrayBuffer();
}

/** Decode a BLP buffer; the result carries a servable PNG `pngUrl`. */
export function decodeBlp(bytes: ArrayBuffer): Promise<BlpDecodeResult> {
    return fetchJson(`${V1}/blp/decode`, { method: "POST", body: bytes });
}

/** Direct download URL used by the "Download .blp" button. */
export function blpDownloadUrl(fdid: number, version?: string): string {
    const q = version ? `?version=${encodeURIComponent(version)}` : "";
    return `${V1}/files/${fdid}/blp${q}`;
}

/** Server-side Lua export for the whole atlas (same formatter the client uses). */
export function exportLua(fdid: number, build?: string): Promise<string> {
    const q = build ? `?build=${encodeURIComponent(build)}` : "";
    return fetch(`${V1}/atlas/${fdid}/export${q}`).then(async (r) => {
        if (!r.ok) {
            let detail = `export failed (${r.status})`;
            try {
                const problem = (await r.json()) as Partial<Problem>;
                detail = problem.detail ?? detail;
            } catch {
                /* keep status-based message */
            }
            throw new Error(detail);
        }
        return r.text();
    });
}
