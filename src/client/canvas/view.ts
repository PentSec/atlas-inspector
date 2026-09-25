/**
 * View transform math + canvas sizing (DPR-aware). Pure helpers: callers
 * trigger redraws; keeps view.ts free of drawing/define imports.
 */
import type { AppStore } from "../state/store.js";

export interface StageBox {
  w: number;
  h: number;
  dpr: number;
}

export function stageSize(): StageBox {
  const stage = document.getElementById("stage");
  const r = stage ? stage.getBoundingClientRect() : { width: 0, height: 0 };
  return {
    w: Math.max(10, Math.round(r.width || (stage ? stage.clientWidth : 0))),
    h: Math.max(10, Math.round(r.height || (stage ? stage.clientHeight : 0))),
    dpr: window.devicePixelRatio || 1,
  };
}

/** Match the canvas backing store to the CSS size (device pixel ratio aware). */
export function syncCanvasSize(): { w: number; h: number } {
  const cv = document.getElementById("cv") as HTMLCanvasElement | null;
  const ctx = cv?.getContext("2d");
  const { w, h, dpr } = stageSize();
  if (!cv || !ctx) return { w, h };
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/** Fit the sheet centered with a 3% margin. Mutates store.view only. */
export function fit(store: AppStore, cw: number, ch: number): void {
  const image = store.getState().image;
  if (!image) return;
  const v = { ...store.getState().view };
  v.scale = Math.min(cw / image.w, ch / image.h) * 0.97;
  v.ox = (cw - image.w * v.scale) / 2;
  v.oy = (ch - image.h * v.scale) / 2;
  store.setState({ view: v });
}

/** Screen px -> image px (inverse view transform). */
export function toImg(store: AppStore, sx: number, sy: number): { x: number; y: number } {
  const v = store.getState().view;
  return { x: (sx - v.ox) / v.scale, y: (sy - v.oy) / v.scale };
}

/** Image px -> screen px (used by the define region labels). */
export function toScreen(store: AppStore, ix: number, iy: number): { x: number; y: number } {
  const v = store.getState().view;
  return { x: ix * v.scale + v.ox, y: iy * v.scale + v.oy };
}