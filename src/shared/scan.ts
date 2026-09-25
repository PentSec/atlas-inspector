/**
 * Addon-source scanner — extracts normalized region coordinates from Lua
 * atlas tables / inline `:SetTexCoord` and from XML `<Texture>` blocks.
 *
 * Pure text in -> entries out, no DOM, so it is shared (server-side tests,
 * client-side paste analysis). Coordinates are normalized and kept in the
 * declared source order; a flipped entry (right < left) is reported as such
 * instead of being silently normalized.
 *
 * Background: region packs mostly store one of two numeric layouts after the
 * texture reference — coords-first `{ TEX, l,r,t,b [, dw,dh [, L,T,R,B]] }` or
 * dims-first `{ TEX, dw, dh, l, r, t, b }` — so the layout is disambiguated by
 * whether the first two numbers are out of the 0..1 range.
 */

export interface ScannedRegion {
    /** how the entry was found */
    source: "table" | "stc" | "xml";
    /** region key / SetTexCoord receiver / xml name-label */
    key: string;
    /** base texture path (`Interface\...`) or fileID, null when unresolvable */
    texture: string | null;
    /** normalized coords, source order (flip possible) */
    u0: number;
    u1: number;
    v0: number;
    v1: number;
    /** display size in px when present */
    dw: number | null;
    dh: number | null;
    /** nine-slice margins of the piece in px: [L, T, R, B] */
    m: [number, number, number, number] | null;
    line: number;
}

const MAX_LINE = 20000;
const in01 = (v: number): boolean => v >= -1e-9 && v <= 1 + 1e-9;
const isNum = (v: number | null): v is number => v !== null && Number.isFinite(v);

// ---------------------------------------------------------------------------
// string plumbing
// ---------------------------------------------------------------------------

function commentStart(line: string, from = 0): number {
    let i = from;
    while (i < line.length) {
        const c = line[i]!;
        if (c === '"' || c === "'") {
            const q = c;
            i++;
            while (i < line.length) {
                if (line[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (line[i] === q) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (c === "-" && line[i + 1] === "-") return i;
        i++;
    }
    return -1;
}

/** Blank `--[[ ]]` blocks (padding to a space) and `--` line comments. */
function blankBlockComments(lines: string[]): string[] {
    const out: string[] = [];
    let close: string | null = null;
    for (const ln of lines) {
        let res = "";
        let i = 0;
        while (i < ln.length) {
            if (close) {
                const j = ln.indexOf(close, i);
                if (j < 0) {
                    res += " ".repeat(ln.length - i);
                    break;
                }
                res += " ".repeat(j + close.length - i);
                i = j + close.length;
                close = null;
                continue;
            }
            const k = commentStart(ln, i);
            if (k < 0) {
                res += ln.slice(i);
                break;
            }
            const m = /^--\[(=*)\[/.exec(ln.slice(k));
            if (!m) {
                res += ln.slice(i, k);
                break;
            }
            res += ln.slice(i, k) + " ".repeat(m[0].length);
            i = k + m[0].length;
            close = "]" + m[1] + "]";
        }
        out.push(res);
    }
    return out;
}

function stripLineComment(ln: string): string {
    const k = commentStart(ln);
    return k < 0 ? ln : ln.slice(0, k);
}

function splitTop(expr: string, sep: string): string[] {
    const parts: string[] = [];
    let cur = "";
    let q: string | null = null;
    let depth = 0;
    let i = 0;
    while (i < expr.length) {
        const c = expr[i]!;
        if (q) {
            cur += c;
            if (c === "\\" && i + 1 < expr.length) {
                cur += expr[i + 1];
                i += 2;
                continue;
            }
            if (c === q) q = null;
        } else if (c === '"' || c === "'") {
            q = c;
            cur += c;
        } else if (expr.startsWith("[[", i)) {
            const j = expr.indexOf("]]", i);
            const end = j < 0 ? expr.length - 2 : j;
            cur += expr.slice(i, end + 2);
            i = end + 2;
            continue;
        } else if (c === "(" || c === "[" || c === "{") {
            depth++;
            cur += c;
        } else if (c === ")" || c === "]" || c === "}") {
            depth--;
            cur += c;
        } else if (depth === 0 && expr.startsWith(sep, i)) {
            parts.push(cur);
            cur = "";
            i += sep.length;
            continue;
        } else {
            cur += c;
        }
        i++;
    }
    parts.push(cur);
    return parts;
}

/** String/reference `lua_str`-equivalent: quoted literal or symbol lookup. */
function luaStr(expr: string, syms: ReadonlyMap<string, string>): string | null {
    let out = "";
    for (const p of splitTop(expr, "..")) {
        let s = p.trim().replace(/[;,]$/, "").trim();
        while (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
        const m =
            /^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\[\[((?:[^\]]|\](?!\]))*)\]\])$/.exec(s);
        if (m) {
            out += m[3] ?? m[1] ?? m[2] ?? "";
        } else if (syms.has(s)) {
            out += syms.get(s);
        } else {
            return null;
        }
    }
    return out;
}

function numVal(expr: string, syms: ReadonlyMap<string, string>): number | null {
    const s = (expr ?? "").trim().replace(/[;,]$/, "").trim();
    if (!s || s.length > 200 || s.includes("**")) return null;
    if (/\s+and\s+/.test(s) || /[a-z]/.test(s)) {
        return syms.has(s) ? Number(syms.get(s)) || null : null;
    }
    const frac = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*\/\s*([+-]?(?:\d+\.?\d*|\.\d+))$/.exec(s);
    if (frac) {
        const b = Number(frac[2]);
        return b === 0 ? null : Number(frac[1]) / b;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : syms.has(s) ? Number(syms.get(s)) || null : null;
}

function unquote(s: string): string {
    const t = s.trim();
    if (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === "'" || t[0] === '"'))
        return t.slice(1, -1);
    return t;
}

function isTexPath(s: string | null | undefined): boolean {
    if (!s) return false;
    const t = s.replace(/\\/g, "/").toLowerCase();
    return t.startsWith("interface/") || /^fileid\s+\d+$/.test(t);
}

// ---------------------------------------------------------------------------
// symbol collection
// ---------------------------------------------------------------------------

function collectSyms(lines: string[]): Map<string, string> {
    const syms = new Map<string, string>();
    for (const raw of lines) {
        const ln = raw.length > MAX_LINE ? "" : stripLineComment(raw);
        const m = /^(?:local\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(ln.trim());
        if (!m || "{" === m[2]!.trim()[0]) continue;
        const name = m[1]!;
        const val = m[2]!.trim().replace(/[;,]$/, "").trim();
        const s = luaStr(val, syms);
        if (s !== null && (isTexPath(s) || /^\d/.test(s) || s.startsWith("fileID")))
            syms.set(name, s);
        else {
            const n = numVal(val, syms);
            if (n !== null) syms.set(name, String(n));
        }
    }
    return syms;
}

// ---------------------------------------------------------------------------
// table entries
// ---------------------------------------------------------------------------

interface ParsedEntry {
    texture: string | null;
    dw: number | null;
    dh: number | null;
    u0: number;
    u1: number;
    v0: number;
    v1: number;
    m: [number, number, number, number] | null;
}

/** Text inside the braces opening at `i` in `code`, or null when unbalanced. */
function balanced(code: string, i: number): string | null {
    let depth = 0;
    let q: string | null = null;
    for (let j = i; j < code.length; j++) {
        const c = code[j]!;
        if (q) {
            if (c === "\\") j++;
            else if (c === q) q = null;
        } else if (c === "'" || c === '"') {
            q = c;
        } else if (c === "{") {
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0) return code.slice(i + 1, j);
        }
    }
    return null;
}

/** Parse a single `{...}` table body into a normalized region, or null. */
export function parseTableEntry(
    body: string,
    syms: ReadonlyMap<string, string>,
): ParsedEntry | null {
    const inner = body.trim();
    const fields = splitTop(inner, ",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0)
        .map((f) => f.replace(/[;,]$/, "").trim());
    const keyed = fields.some((f) => /^[A-Za-z_]\w*\s*=/.test(f));
    if (keyed) {
        const kv: Record<string, string> = {};
        for (const f of fields) {
            const m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(f);
            if (m) kv[m[1]!.toLowerCase()] = m[2]!.trim();
        }
        const tex = kv.file ?? kv.texture ?? kv.filename ?? kv.path ?? kv.tex;
        if (!tex) return null;
        const texture = unquote(tex);
        const width = kv.width;
        const height = kv.height;
        if (kv.coords) {
            const c = numList(kv.coords, syms);
            if (c.length >= 4) {
                return {
                    texture,
                    dw: width !== undefined ? numVal(width, syms) : null,
                    dh: height !== undefined ? numVal(height, syms) : null,
                    u0: c[0]!,
                    u1: c[1]!,
                    v0: c[2]!,
                    v1: c[3]!,
                    m: null,
                };
            }
        }
        const l = numVal(kv.left ?? "", syms);
        const r = numVal(kv.right ?? "", syms);
        const t = numVal(kv.top ?? "", syms);
        const b = numVal(kv.bottom ?? "", syms);
        if (![l, r, t, b].every(isNum)) return null;
        return {
            texture,
            dw: width !== undefined ? numVal(width, syms) : null,
            dh: height !== undefined ? numVal(height, syms) : null,
            u0: l!,
            u1: r!,
            v0: t!,
            v1: b!,
            m: null,
        };
    }
    // positional; first arg must be a texture reference
    if (fields.length < 5) return null;
    const wow = luaStr(fields[0]!, syms);
    if (!wow || !isTexPath(wow)) return null;
    const nums = fields.slice(1).map((a) => numVal(a, syms));
    if (nums.length < 4) return null;
    if (nums.slice(0, 4).every(isNum) && nums.slice(0, 4).every((v) => in01(v as number))) {
        // coords-first { TEX, l,r,t,b [, dw,dh [, mL,mT,mR,mB]] }
        const n4 = nums[4] ?? null;
        const n5 = nums[5] ?? null;
        const dw = nums.length >= 6 && isNum(n4) ? n4 : null;
        const dh = nums.length >= 6 && isNum(n5) ? n5 : null;
        const m =
            nums.length >= 10 && nums.slice(6, 10).every(isNum)
                ? (nums.slice(6, 10) as [number, number, number, number])
                : null;
        return { texture: wow, dw, dh, u0: nums[0]!, u1: nums[1]!, v0: nums[2]!, v1: nums[3]!, m };
    }
    const dim0 = nums[0] ?? null;
    const dim1 = nums[1] ?? null;
    if (
        nums.length >= 6 &&
        (dim0 === null || dim0 > 1 || dim1 === null || dim1 > 1) &&
        nums.slice(2, 6).every(isNum) &&
        nums.slice(2, 6).every((v) => in01(v as number))
    ) {
        // dims-first { TEX, dw, dh, l, r, t, b }
        return {
            texture: wow,
            dw: dim0,
            dh: dim1,
            u0: nums[2]!,
            u1: nums[3]!,
            v0: nums[4]!,
            v1: nums[5]!,
            m: null,
        };
    }
    return null;
}

function numList(s: string, syms: ReadonlyMap<string, string>): number[] {
    const inner = s.replace(/^\{/, "").replace(/\}$/, "").trim();
    if (!inner) return [];
    return splitTop(inner, ",")
        .map((a) => numVal(a, syms))
        .filter(isNum) as number[];
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

export function flippedX(e: Pick<ScannedRegion, "u0" | "u1">): boolean {
    return e.u1 - e.u0 < -1e-9;
}

export function flippedY(e: Pick<ScannedRegion, "v0" | "v1">): boolean {
    return e.v1 - e.v0 < -1e-9;
}

/** Ordered normalized rect (flips resolved) for hit-testing against a sheet. */
export function orderedRect(e: Pick<ScannedRegion, "u0" | "u1" | "v0" | "v1">): {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
} {
    return {
        u0: Math.min(e.u0, e.u1),
        u1: Math.max(e.u0, e.u1),
        v0: Math.min(e.v0, e.v1),
        v1: Math.max(e.v0, e.v1),
    };
}

/** Pixel rect of a normalized region on a W×H sheet (ordered, clamped). */
export function regionToPx(
    e: Pick<ScannedRegion, "u0" | "u1" | "v0" | "v1">,
    W: number,
    H: number,
): { left: number; top: number; right: number; bottom: number } {
    const o = orderedRect(e);
    return {
        left: Math.max(0, Math.min(W, o.u0 * W)),
        top: Math.max(0, Math.min(H, o.v0 * H)),
        right: Math.max(0, Math.min(W, o.u1 * W)),
        bottom: Math.max(0, Math.min(H, o.v1 * H)),
    };
}

function overlapArea(
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
): number {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : -1;
}

/** Member index whose pixel rect overlaps region's rect the most, else -1. */
export function matchMemberRect(
    region: Pick<ScannedRegion, "u0" | "u1" | "v0" | "v1">,
    W: number,
    H: number,
    members: ReadonlyArray<{ left: number; top: number; right: number; bottom: number }>,
): number {
    const px = regionToPx(region, W, H);
    let best = -1;
    let bestArea = -1;
    for (let i = 0; i < members.length; i++) {
        const a = overlapArea(px, members[i]!);
        if (a > bestArea) {
            bestArea = a;
            best = i;
        }
    }
    return bestArea < 0 ? -1 : best;
}

// ---------------------------------------------------------------------------
// scanners
// ---------------------------------------------------------------------------

/** Exact-pixel check: largest subpixel error of the 4 corners on a W×H sheet. */
export function pixelErr(
    e: Pick<ScannedRegion, "u0" | "u1" | "v0" | "v1">,
    W: number,
    H: number,
): number {
    const o = orderedRect(e);
    const corners = [o.u0 * W, o.u1 * W, o.v0 * H, o.v1 * H];
    return (
        (Math.max(...corners.map((v) => Math.abs(v - Math.round(v)))) / Math.sqrt(W * W + H * H)) *
        Math.max(W, H)
    );
}

const RX_HEAD = /\[\s*(['"])(.+?)\1\s*\]\s*=\s*\{|(?:^|[\s,{;(])([A-Za-z_][\w.]*)\s*=\s*\{/g;
const RX_STC = /([A-Za-z_][\w.]*|['"][^'"]+['"]|\[['"][^'"]+['"]\])\s*:\s*SetTexCoord\s*\(/g;

export function scanLua(code: string): ScannedRegion[] {
    const lines = blankBlockComments(code.split("\n"));
    const syms = collectSyms(lines);
    const out: ScannedRegion[] = [];

    for (let i = 0; i < lines.length; i++) {
        const ln = stripLineComment(lines[i]!);
        if (!ln.trim()) continue;
        let found = false;
        for (const m of ln.matchAll(RX_HEAD)) {
            const key = m[2] ?? m[3];
            if (!key) continue;
            const open = ln.indexOf("{", m.index!);
            if (open < 0) continue;
            let body = balanced(ln, open);
            if (body === null) {
                const joined =
                    ln +
                    " " +
                    lines
                        .slice(i + 1, i + 13)
                        .map(stripLineComment)
                        .join(" ");
                body = balanced(joined, open);
            }
            if (body === null) continue;
            const e = parseTableEntry(body, syms);
            if (e) {
                out.push({ source: "table", key: unquote(key), line: i + 1, ...e });
                found = true;
            }
        }
        if (found) continue;
        for (const m of ln.matchAll(RX_STC)) {
            const recv = m[1]!;
            const toc = ln.indexOf("SetTexCoord(", m.index!);
            const raw = callArgs(ln, toc);
            if (!raw) continue;
            const nums = splitTop(raw, ",")
                .map((a) => numVal(a, syms))
                .filter(isNum);
            let tex = null;
            if (/^[A-Za-z_][\w.]*$/.test(recv)) tex = syms.get(recv) ?? null;
            else {
                const t = /^\[(["'])(.*?)\1\]$/.exec(recv);
                if (t) tex = t[2]!;
            }
            if (!isTexPath(tex)) tex = null;
            if (nums.length === 4) {
                out.push({
                    source: "stc",
                    key: recv,
                    texture: tex,
                    u0: nums[0]!,
                    u1: nums[1]!,
                    v0: nums[2]!,
                    v1: nums[3]!,
                    dw: null,
                    dh: null,
                    m: null,
                    line: i + 1,
                });
            } else if (nums.length === 8) {
                const xs = [nums[0]!, nums[2]!, nums[4]!, nums[6]!];
                const ys = [nums[1]!, nums[3]!, nums[5]!, nums[7]!];
                out.push({
                    source: "stc",
                    key: recv,
                    texture: tex,
                    u0: Math.min(...xs),
                    u1: Math.max(...xs),
                    v0: Math.min(...ys),
                    v1: Math.max(...ys),
                    dw: null,
                    dh: null,
                    m: null,
                    line: i + 1,
                });
            }
        }
    }
    return out;
}

function callArgs(code: string, start: number): string | null {
    const open = code.indexOf("(", start);
    if (open < 0) return null;
    let depth = 0;
    let q: string | null = null;
    for (let j = open; j < code.length; j++) {
        const c = code[j]!;
        if (q) {
            if (c === "\\") j++;
            else if (c === q) q = null;
        } else if (c === "'" || c === '"') {
            q = c;
        } else if (c === "(") {
            depth++;
        } else if (c === ")") {
            depth--;
            if (depth === 0) return code.slice(open + 1, j);
        }
    }
    return null;
}

const RX_XTEX = /<([\w]*Texture)\b([^>]*?)(\/?)>/gi;

export function scanXml(code: string): ScannedRegion[] {
    const clean = code.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));
    const out: ScannedRegion[] = [];
    for (const m of clean.matchAll(RX_XTEX)) {
        if (m[3]) continue; // self-closing
        const attrs: Record<string, string> = {};
        for (const a of (m[2] ?? "").matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            attrs[(a[1] ?? "").toLowerCase()] = (a[2] ?? a[3] ?? "")!;
        }
        const wow = attrs["file"] ?? attrs["texture"];
        if (!wow || !isTexPath(wow)) continue;
        const tag = m[0]!;
        const end = clean.indexOf(`</${m[1]}>`, m.index! + tag.length);
        const body = clean.slice(
            m.index! + tag.length,
            end > 0 ? end : m.index! + tag.length + 2000,
        );
        const tm = /<TexCoords\b([^>]*)\/?>/i.exec(body);
        if (!tm) continue;
        const ta: Record<string, string> = {};
        for (const a of tm[1]!.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
            const k = (a[1] ?? "").toLowerCase();
            const v = a[2];
            if (v) ta[k] = v;
        }
        const l = numVal(ta.left ?? "0", new Map());
        const r = numVal(ta.right ?? "1", new Map());
        const t = numVal(ta.top ?? "0", new Map());
        const b = numVal(ta.bottom ?? "1", new Map());
        if (![l, r, t, b].every(isNum)) continue;
        const line = clean.slice(0, m.index).split("\n").length;
        out.push({
            source: "xml",
            key: unquote(attrs["name"] ?? attrs["parentkey"] ?? wow.split(/[\\/]/).pop() ?? ""),
            texture: wow,
            u0: l!,
            u1: r!,
            v0: t!,
            v1: b!,
            dw: null,
            dh: null,
            m: null,
            line,
        });
    }
    return out;
}

/** Auto-detect the source dialect and scan it. */
export function scanCode(code: string): ScannedRegion[] {
    return /<Texture\b/i.test(code.trimStart()) ? scanXml(code) : scanLua(code);
}
