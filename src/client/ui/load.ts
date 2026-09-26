/**
 * Sheet image loading. Replaces the legacy /api/render with the v1 flow
 * (download BLP -> decode -> PNG) and keeps the same drop-a-PNG/BLP fallback.
 * A monotonically increasing request id guards against out-of-order loads.
 */
import * as api from "../api/client.js";
import { resetDef } from "../define/regions.js";
import { fit, syncCanvasSize } from "../canvas/view.js";
import { drawFrame } from "../canvas/draw.js";
import { q } from "./dom.js";
import { writeStatus } from "./meta.js";
import type { AppStore } from "../state/store.js";

let previewReqId = 0;
/** Identifies which sheet is currently on screen (fdid#version or "local:*"). */
let currentSheetKey = "";

function showLoading(store: AppStore, msg: string): void {
    q<HTMLSpanElement>("#loadingMsg").textContent = msg;
    q<HTMLDivElement>("#loading").hidden = false;
}

function hideLoading(store: AppStore): void {
    store.setState({ loading: false });
    q<HTMLDivElement>("#loading").hidden = true;
}

export function installImage(store: AppStore, im: HTMLImageElement, url: string): void {
    const w = im.naturalWidth;
    const h = im.naturalHeight;
    store.setState({ image: { el: im, url, w, h } });
    q<HTMLDivElement>("#drop").style.display = "none";
    const { w: cw, h: ch } = syncCanvasSize();
    fit(store, cw, ch);
    drawFrame(store);
}

export async function loadFromUrl(store: AppStore, url: string, loadingMsg: string): Promise<void> {
    const reqId = ++previewReqId;
    showLoading(store, loadingMsg || "loading preview…");
    writeStatus(store, "loading preview…");
    const im = new Image();

    im.onload = async () => {
        if (reqId !== previewReqId) return;
        const w = im.naturalWidth;
        const h = im.naturalHeight;
        if (!w || !h) {
            hideLoading(store);
            writeStatus(store, "✗ preview decoded as a 0×0 image", "err");
            return;
        }
        if (typeof im.decode === "function") {
            try {
                await im.decode();
            } catch {
                if (reqId !== previewReqId) return;
                hideLoading(store);
                writeStatus(store, "✗ preview decode failed after load", "err");
                return;
            }
        }
        if (reqId !== previewReqId) return;
        installImage(store, im, url);
        hideLoading(store);
        writeStatus(store, `✓ preview ready · ${w}×${h} — hover a region`, "ok");
    };

    im.onerror = () => {
        if (reqId !== previewReqId) return;
        hideLoading(store);
        writeStatus(store, "✗ preview not supported — drop a PNG/BLP instead", "err");
        if (!store.getState().image) q<HTMLDivElement>("#drop").style.display = "flex";
    };

    im.src = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
}

/**
 * Auto-preview for an atlas in the current wago build: download the BLP,
 * decode it to a cached PNG and show it. Mirrors legacy autoPreview.
 */
export async function autoPreview(store: AppStore, fdid: number, version: string): Promise<void> {
    const key = `${fdid}#${version || "default"}`;
    if (currentSheetKey === key && store.getState().image) return;
    showLoading(store, "rendering preview…");
    writeStatus(store, "rendering preview…");
    try {
        const bytes = await api.blpBytes(fdid, version);
        const dec = await api.decodeBlp(bytes);
        currentSheetKey = key;
        await loadFromUrl(store, dec.pngUrl, "rendering preview…");
    } catch (e) {
        hideLoading(store);
        const stale = store.getState();
        writeStatus(store, `✗ ${(e as Error).message || "preview failed"}`, "err");
        if (!stale.image) q<HTMLDivElement>("#drop").style.display = "flex";
    }
}

/** Local drop / browse: try as an image; fall back to server BLP decode. */
export async function handleDroppedFile(
    store: AppStore,
    file: File | undefined | null,
): Promise<void> {
    if (!file) return;
    resetDef(store);
    currentSheetKey = "local:*";
    const reqId = ++previewReqId;
    showLoading(store, `loading ${file.name}…`);
    writeStatus(store, `loading ${file.name}…`);
    const objUrl = URL.createObjectURL(file);

    const tryBlpDecode = async () => {
        try {
            const buf = await file.arrayBuffer();
            const dec = await api.decodeBlp(buf);
            if (reqId !== previewReqId) return;
            const im = new Image();
            im.onload = () => {
                if (reqId !== previewReqId) return;
                installImage(store, im, "local:" + file.name);
                hideLoading(store);
                writeStatus(store, `✓ decoded ${file.name}`, "ok");
            };
            im.onerror = () => {
                hideLoading(store);
                writeStatus(store, "✗ could not render decoded image", "err");
            };
            im.src = dec.pngUrl + "?t=" + Date.now();
        } catch (e) {
            if (reqId !== previewReqId) return;
            hideLoading(store);
            writeStatus(store, `✗ ${(e as Error).message || "unsupported file"}`, "err");
        }
    };

    const im = new Image();
    im.onload = () => {
        if (reqId !== previewReqId) {
            URL.revokeObjectURL(objUrl);
            return;
        }
        installImage(store, im, "local:" + file.name);
        hideLoading(store);
        writeStatus(store, `✓ loaded ${file.name}`, "ok");
        URL.revokeObjectURL(objUrl);
    };
    im.onerror = () => {
        URL.revokeObjectURL(objUrl);
        void tryBlpDecode();
    };
    im.src = objUrl;
}
