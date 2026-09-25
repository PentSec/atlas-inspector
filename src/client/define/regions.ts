/**
 * Define-mode logic (parity with the legacy client): draw regions with a
 * sketch drag, select/move/resize them by edge handles, rename in the list
 * and export each one as a Lua entry. All mutations go through the store.
 */
import { findIslands } from "../../shared/islands.js";
import { luaRegionEntry } from "../../shared/lua.js";
import type { AppStore, DefineRegion, DefDrag } from "../state/store.js";
import { copyText, q } from "../ui/dom.js";
import { writeStatus } from "../ui/meta.js";

export const DEF_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export const EDGE_CURSOR: Record<string, string> = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
    move: "move",
};

export interface DefPoint {
    x: number;
    y: number;
}

export function resetDef(store: AppStore): void {
    store.setState({ defRegions: [], defSel: -1, defSketch: null, defDrag: null });
    renderDefine(store);
}

export function selectDef(store: AppStore, i: number): void {
    store.setState({ defSel: i });
    const list = q<HTMLDivElement>("#dList");
    [...list.children].forEach((row, k) => row.classList.toggle("sel", k === i));
}

/** Resize/move handle hit test for the selected region (tolerance in image px). */
export function hitDefHandle(store: AppStore, p: DefPoint): DefDrag | null {
    const s = store.getState();
    const r = s.defSel >= 0 ? s.defRegions[s.defSel] : null;
    if (!r) return null;
    const tol = 4 / s.view.scale;
    const near = (a: number, b: number) => Math.abs(a - b) <= tol;
    const onLeft = near(p.x, r.left);
    const onRight = near(p.x, r.right);
    const onTop = near(p.y, r.top);
    const onBottom = near(p.y, r.bottom);
    const inX = p.x >= r.left - tol && p.x <= r.right + tol;
    const inY = p.y >= r.top - tol && p.y <= r.bottom + tol;
    let handle: string | null = null;
    if (onLeft && onTop) handle = "nw";
    else if (onRight && onTop) handle = "ne";
    else if (onLeft && onBottom) handle = "sw";
    else if (onRight && onBottom) handle = "se";
    else if (onLeft && inY) handle = "w";
    else if (onRight && inY) handle = "e";
    else if (onTop && inX) handle = "n";
    else if (onBottom && inX) handle = "s";
    else if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) handle = "move";
    if (!handle) return null;
    return { idx: s.defSel, handle, startX: p.x, startY: p.y, orig: { ...r } };
}

export function applyDefDrag(store: AppStore, drag: DefDrag, p: DefPoint): void {
    const s = store.getState();
    const img = s.image;
    if (!img || drag.idx < 0 || drag.idx >= s.defRegions.length) return;
    const regions = s.defRegions.map((r) => ({ ...r }));
    const r = regions[drag.idx];
    if (!r) return;
    const iw = img.w;
    const ih = img.h;
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const o = drag.orig;
    if (drag.handle === "move") {
        r.left = clamp(o.left + dx, 0, iw - 1);
        r.right = clamp(o.right + dx, r.left + 1, iw);
        r.top = clamp(o.top + dy, 0, ih - 1);
        r.bottom = clamp(o.bottom + dy, r.top + 1, ih);
    } else {
        if (drag.handle.includes("e")) r.right = clamp(p.x, r.left + 1, iw);
        if (drag.handle.includes("w")) r.left = clamp(p.x, 0, r.right - 1);
        if (drag.handle.includes("s")) r.bottom = clamp(p.y, r.top + 1, ih);
        if (drag.handle.includes("n")) r.top = clamp(p.y, 0, r.bottom - 1);
    }
    store.setState({ defRegions: regions });
}

/** Turn a finished sketch into a region (clamped to the sheet bounds). */
export function commitSketch(store: AppStore): void {
    const s = store.getState();
    const sk = s.defSketch;
    const img = s.image;
    if (!sk || !img) return;
    const l = Math.max(0, Math.min(Math.round(sk.x1), Math.round(sk.x2)));
    const r = Math.min(img.w, Math.max(Math.round(sk.x1), Math.round(sk.x2)));
    const t = Math.max(0, Math.min(Math.round(sk.y1), Math.round(sk.y2)));
    const b = Math.min(img.h, Math.max(Math.round(sk.y1), Math.round(sk.y2)));
    store.setState({ defSketch: null });
    if (r - l < 1 || b - t < 1) return;
    const name = q<HTMLInputElement>("#dName").value.trim() || `region${s.defNext}`;
    const region: DefineRegion = { name, left: l, top: t, right: r, bottom: b };
    const regions = [...s.defRegions, region];
    store.setState({ defRegions: regions, defNext: s.defNext + 1, defSel: regions.length - 1 });
    renderDefine(store);
    writeStatus(store, `✓ ${name} · ${r - l}×${b - t}px`, "ok");
}

/** One region as a Lua entry, normalized against the current sheet size. */
export function defineLuaEntry(r: DefineRegion, imgW: number, imgH: number): string {
    const w = Math.max(1, Math.round(r.right - r.left));
    const h = Math.max(1, Math.round(r.bottom - r.top));
    return luaRegionEntry({
        name: r.name,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        dispW: w,
        dispH: h,
        sheetW: imgW,
        sheetH: imgH,
    });
}

export function exportDefineLua(store: AppStore): void {
    const s = store.getState();
    const img = s.image;
    if (!img || !s.defRegions.length) return;
    const text = s.defRegions.map((r) => defineLuaEntry(r, img.w, img.h)).join("\n");
    copyText(
        text,
        `${s.defRegions.length} region${s.defRegions.length === 1 ? "" : "s"} copied (Lua)`,
    );
}

const ALPHA_MIN = 16;

/**
 * Auto-fill define regions from the sheet's alpha channel: opaque pixels above
 * the threshold form islands which become one region each (kit-style defaults:
 * 1px gap merge, minimum 16 opaque px).
 */
export function autoDefineRegions(store: AppStore): void {
    const s = store.getState();
    const img = s.image;
    if (!img) {
        writeStatus(store, "load a sheet first", "err");
        return;
    }
    const { w, h } = img;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img.el, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = (data[i * 4 + 3] ?? 0) >= ALPHA_MIN ? 1 : 0;

    const islands = findIslands(bin, w, h, 1, 16);
    if (islands.length === 0) {
        writeStatus(store, "no opaque islands found on the sheet", "err");
        return;
    }
    let n = s.defNext;
    const added: DefineRegion[] = islands.map((is) => ({
        name: `region${n++}`,
        left: is.x,
        top: is.y,
        right: Math.min(w, is.x + is.w),
        bottom: Math.min(h, is.y + is.h),
    }));
    const regions = [...s.defRegions, ...added];
    store.setState({
        defRegions: regions,
        defNext: n,
        defSel: regions.length - 1,
        defSketch: null,
    });
    renderDefine(store);
    writeStatus(
        store,
        `✓ ${added.length} region${added.length === 1 ? "" : "s"} from alpha islands`,
        "ok",
    );
}

/** Rebuild the region list UI (names, rects, copy/delete buttons). */
export function renderDefine(store: AppStore): void {
    const s = store.getState();
    const list = q<HTMLDivElement>("#dList");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    s.defRegions.forEach((r, i) => {
        const row = document.createElement("div");
        row.className = "drow" + (i === s.defSel ? " sel" : "");

        const nm = document.createElement("input");
        nm.className = "dname";
        nm.value = r.name;
        nm.title = "rename";
        nm.addEventListener("input", () => {
            const regions = [...store.getState().defRegions];
            const cur = regions[i];
            if (!cur) return;
            regions[i] = { ...cur, name: nm.value };
            store.setState({ defRegions: regions });
        });

        const rect = document.createElement("span");
        rect.className = "px";
        rect.textContent = `${r.left},${r.top} ${Math.round(r.right - r.left)}×${Math.round(r.bottom - r.top)}`;

        const cp = document.createElement("button");
        cp.className = "mini";
        cp.textContent = "copy";
        cp.title = "Copy this region as Lua";
        cp.addEventListener("click", (e) => {
            e.stopPropagation();
            selectDef(store, i);
            const sheet = store.getState().image;
            if (sheet) copyText(defineLuaEntry(r, sheet.w, sheet.h), `Copied ${r.name} (Lua)`);
        });

        const del = document.createElement("button");
        del.className = "mini";
        del.textContent = "✕";
        del.title = "Delete region";
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            const cur = store.getState();
            const regions = cur.defRegions.filter((_, k) => k !== i);
            const sel = cur.defSel === i ? -1 : cur.defSel > i ? cur.defSel - 1 : cur.defSel;
            store.setState({ defRegions: regions, defSel: sel });
            renderDefine(store);
        });

        row.addEventListener("mousedown", () => selectDef(store, i));
        row.append(nm, rect, cp, del);
        frag.appendChild(row);
    });
    list.appendChild(frag);
    q<HTMLSpanElement>("#dCount").textContent =
        `${s.defRegions.length} region${s.defRegions.length === 1 ? "" : "s"}`;
    q<HTMLButtonElement>("#dCopyAll").disabled = s.defRegions.length === 0;
}
