/**
 * Canvas renderer — same drawing rules as the legacy client: regions stroked
 * by group color, hover/active highlighted with a one-line label, define-mode
 * overlay for sketch + selected region handles, plus the hover tooltip. In
 * inspect mode a located scan entry is drawn as a dashed guide with its
 * nine-slice margin lines when present.
 */
import { regionToPx } from "../../shared/scan.js";
import { grpColor, type AppStore } from "../state/store.js";
import { dbg } from "../ui/debug.js";
import { toImg } from "./view.js";

let ctx: CanvasRenderingContext2D;

function c2d(): CanvasRenderingContext2D {
    if (!ctx) {
        const cv = document.getElementById("cv") as HTMLCanvasElement | null;
        const got = cv && cv.getContext("2d");
        if (!cv || !got) throw new Error("canvas #cv unavailable");
        ctx = got;
    }
    return ctx;
}

export function drawFrame(store: AppStore): void {
    try {
        drawInner(store);
    } catch (e) {
        dbg("!! draw() threw:", (e as Error).name, (e as Error).message);
        console.error(e);
    }
}

function drawInner(store: AppStore): void {
    const c = c2d();
    const { w: cw, h: ch } = syncCanvas();
    c.clearRect(0, 0, cw, ch);
    const s = store.getState();
    if (!s.image) return;
    const v = s.view;
    c.drawImage(s.image.el, v.ox, v.oy, s.image.w * v.scale, s.image.h * v.scale);
    if (s.mode === "define") {
        drawDefineOverlay(store);
        return;
    }
    if (!s.atlas) {
        drawScanOverlay(store);
        return;
    }

    c.lineWidth = 1;
    s.atlas.members.forEach((m, midx) => {
        const x = m.left * v.scale + v.ox;
        const y = m.top * v.scale + v.oy;
        const w = (m.right - m.left) * v.scale;
        const h = (m.bottom - m.top) * v.scale;
        if (x + w < 0 || y + h < 0 || x > cw || y > ch) return;
        const hero = midx === s.activeIndex || midx === s.hoverIndex;
        c.strokeStyle = grpColor(store, m.name);
        c.globalAlpha = hero ? 1 : 0.55;
        c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (hero) {
            const labelY = y - 4 > 0 ? y - 4 : y + 12;
            c.font = `${Math.max(10, Math.min(13, v.scale * 0.35))}px monospace`;
            c.fillStyle = "#000c";
            c.fillText(m.name, x + 2, labelY);
            c.fillStyle = grpColor(store, m.name);
            c.fillText(m.name, x + 2, labelY);
        }
        c.globalAlpha = 1;
    });
    drawScanOverlay(store);
}

/** Locate guide for the selected scan entry, with nine-slice margin lines. */
function drawScanOverlay(store: AppStore): void {
    const s = store.getState();
    const img = s.image;
    if (s.mode !== "inspect" || s.scanSel < 0 || !img) return;
    const sc = s.scans[s.scanSel];
    if (!sc) return;
    const c = c2d();
    const v = s.view;
    const px = regionToPx(sc, img.w, img.h);
    const x = px.left * v.scale + v.ox;
    const y = px.top * v.scale + v.oy;
    const w = (px.right - px.left) * v.scale;
    const h = (px.bottom - px.top) * v.scale;
    c.setLineDash([7, 4]);
    c.strokeStyle = "#f2cc60";
    c.lineWidth = 2;
    c.globalAlpha = 0.95;
    c.strokeRect(x + 1, y + 1, w - 2, h - 2);
    if (sc.m) {
        const [mL, mT, mR, mB] = sc.m;
        if (mL > 0) hLine(x + mL * v.scale, y, y + h);
        if (mR > 0) hLine(x + w - mR * v.scale, y, y + h);
        if (mT > 0) vLine(x, x + w, y + mT * v.scale);
        if (mB > 0) vLine(x, x + w, y + h - mB * v.scale);
    }
    c.setLineDash([]);
    const flip = (sc.u1 - sc.u0 < -1e-9 ? " flipX" : "") + (sc.v1 - sc.v0 < -1e-9 ? " flipY" : "");
    const labelY = y - 4 > 0 ? y - 4 : y + 14;
    c.font = `12px monospace`;
    c.fillStyle = "#000c";
    c.fillText(sc.key + flip, x + 2, labelY);
    c.fillStyle = "#f2cc60";
    c.fillText(sc.key + flip, x + 2, labelY);
    c.globalAlpha = 1;
}

function hLine(x: number, y0: number, y1: number): void {
    const c = c2d();
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(x, y0);
    c.lineTo(x, y1);
    c.stroke();
}

function vLine(x0: number, x1: number, y: number): void {
    const c = c2d();
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(x0, y);
    c.lineTo(x1, y);
    c.stroke();
}

function syncCanvas(): { w: number; h: number } {
    const cv = document.getElementById("cv") as HTMLCanvasElement | null;
    const stage = document.getElementById("stage");
    const r = stage ? stage.getBoundingClientRect() : { width: 0, height: 0 };
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width || (stage ? stage.clientWidth : 0)));
    const h = Math.max(10, Math.round(r.height || (stage ? stage.clientHeight : 0)));
    if (cv) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = w + "px";
        cv.style.height = h + "px";
    }
    const c = c2d();
    if (cv) c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
}

/** Hover tooltip — coords always, region info when the pointer is over one. */
export function showTip(store: AppStore, clientX: number, clientY: number): void {
    const tip = document.getElementById("tooltip");
    const stage = document.getElementById("stage");
    if (!tip || !stage) return;
    const s = store.getState();
    if (!s.image) {
        tip.style.display = "none";
        return;
    }
    const rect = stage.getBoundingClientRect();
    const lx = clientX - rect.left;
    const ly = clientY - rect.top;
    const p = toImg(store, lx, ly);

    let text: string;
    if (s.mode === "define") {
        const hit = s.defRegions.find(
            (r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom,
        );
        text = hit
            ? `x${Math.round(p.x)}, y${Math.round(p.y)} · ${hit.name}`
            : `x${Math.round(p.x)}, y${Math.round(p.y)}`;
    } else {
        if (!s.atlas) {
            tip.style.display = "none";
            return;
        }
        const hit = s.atlas.members.find(
            (m) => p.x >= m.left && p.x <= m.right && p.y >= m.top && p.y <= m.bottom,
        );
        if (!hit) {
            tip.style.display = "none";
            return;
        }
        text = `${hit.name}  ·  x${hit.left}-${hit.right} y${hit.top}-${hit.bottom}  ·  disp ${hit.displayW}×${hit.displayH}`;
    }
    tip.textContent = text;
    tip.style.display = "block";
    tip.style.left = "0px";
    tip.style.top = "0px";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const maxX = rect.width - tw - 6;
    const maxY = rect.height - th - 6;
    tip.style.left = Math.max(0, Math.min(lx + 12, maxX)) + "px";
    tip.style.top = Math.max(0, Math.min(ly + 12, maxY)) + "px";
}

function drawDefineOverlay(store: AppStore): void {
    const c = c2d();
    const s = store.getState();
    const v = s.view;
    c.lineWidth = 1;
    for (let i = 0; i < s.defRegions.length; i++) {
        const r = s.defRegions[i];
        if (!r) continue;
        const x = r.left * v.scale + v.ox;
        const y = r.top * v.scale + v.oy;
        const w = (r.right - r.left) * v.scale;
        const h = (r.bottom - r.top) * v.scale;
        const sel = i === s.defSel;
        c.strokeStyle = sel ? "#58a6ff" : "#8b949e";
        c.globalAlpha = sel ? 1 : 0.55;
        if (sel) {
            c.fillStyle = "rgba(88,166,255,.08)";
            c.fillRect(x, y, w, h);
        }
        c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (!sel) continue;
        c.globalAlpha = 1;
        const hs = Math.max(3, Math.min(6, v.scale * 2));
        c.fillStyle = "#58a6ff";
        const pts: ReadonlyArray<readonly [number, number]> = [
            [r.left, r.top],
            [(r.left + r.right) / 2, r.top],
            [r.right, r.top],
            [r.left, (r.top + r.bottom) / 2],
            [r.right, (r.top + r.bottom) / 2],
            [r.left, r.bottom],
            [(r.left + r.right) / 2, r.bottom],
            [r.right, r.bottom],
        ];
        for (const [ix, iy] of pts) {
            c.fillRect(ix * v.scale + v.ox - hs / 2, iy * v.scale + v.oy - hs / 2, hs, hs);
        }
    }
    if (s.defSketch) {
        const sk = s.defSketch;
        const x1 = Math.min(sk.x1, sk.x2) * v.scale + v.ox;
        const y1 = Math.min(sk.y1, sk.y2) * v.scale + v.oy;
        const x2 = Math.max(sk.x1, sk.x2) * v.scale + v.ox;
        const y2 = Math.max(sk.y1, sk.y2) * v.scale + v.oy;
        c.setLineDash([4, 3]);
        c.strokeStyle = "#58a6ff";
        c.globalAlpha = 0.9;
        c.strokeRect(x1, y1, x2 - x1, y2 - y1);
        c.setLineDash([]);
    }
    c.globalAlpha = 1;
}
