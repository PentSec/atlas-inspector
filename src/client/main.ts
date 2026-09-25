/**
 * Boot — wires the store to the DOM, mirrors the legacy client's event flow.
 * Theming of view/define interactions is handled here; per-domain logic lives
 * in canvas/, define/, ui/ and api/.
 */
import * as api from "./api/client.js";
import {
    EDGE_CURSOR,
    applyDefDrag,
    autoDefineRegions,
    commitSketch,
    exportDefineLua,
    hitDefHandle,
    renderDefine,
    resetDef,
    selectDef,
} from "./define/regions.js";
import { drawFrame, showTip } from "./canvas/draw.js";
import { fit, syncCanvasSize, toImg } from "./canvas/view.js";
import type { LuaExportStyle } from "../shared/lua.js";
import { createAppStore, type AppStore } from "./state/store.js";
import { dbg, dbgSize, installErrorLoggers } from "./ui/debug.js";
import { debounce, isTypingTarget, q, triggerDownload } from "./ui/dom.js";
import { autoPreview, handleDroppedFile } from "./ui/load.js";
import { bindScanPanel, renderScan, scanFromFile } from "./ui/scan.js";
import { renderMeta, renderTexture, updateExportButtons, writeStatus } from "./ui/meta.js";
import {
    bindFilter,
    clearRows,
    copyAllJson,
    copyAllLua,
    markRows,
    renderTable,
} from "./ui/list.js";

const store: AppStore = createAppStore();

// ---------- DOM refs ----------
const fdEl = q<HTMLInputElement>("#fdid");
const buildEl = q<HTMLSelectElement>("#build");
const goBtn = q<HTMLButtonElement>("#go");
const dropEl = q<HTMLDivElement>("#drop");
const fileInput = q<HTMLInputElement>("#fileInput");
const cv = q<HTMLCanvasElement>("#cv");
const stageEl = q<HTMLElement>("#stage");
const debugEl = q<HTMLDivElement>("#debugbox");
const mInspect = q<HTMLButtonElement>("#mInspect");
const mScan = q<HTMLButtonElement>("#mScan");
const mDefine = q<HTMLButtonElement>("#mDefine");
const tlInspect = q<HTMLElement>("#tlInspect");
const definePanel = q<HTMLDivElement>("#definePanel");
const scanPanel = q<HTMLDivElement>("#scanPanel");
const fdField = q<HTMLDivElement>("#fdField");
const buildField = q<HTMLDivElement>("#buildField");
const metaEl = q<HTMLElement>("#meta");
const filterEl = q<HTMLInputElement>("#filter");
const legendEl = q<HTMLDivElement>("#legend");
const rowcountEl = q<HTMLElement>("#rowcount");
const tableEl = q<HTMLTableElement>("table");

// ---------- mode switch ----------
function setMode(m: "inspect" | "scan" | "define"): void {
    store.setState({ mode: m, hoverIndex: -1, activeIndex: -1 });
    const inspect = m === "inspect";
    const scan = m === "scan";
    const define = m === "define";
    document.body.classList.toggle("mode-define", define);
    mInspect.classList.toggle("on", inspect);
    mScan.classList.toggle("on", scan);
    mDefine.classList.toggle("on", define);
    mInspect.setAttribute("aria-selected", String(inspect));
    mScan.setAttribute("aria-selected", String(scan));
    mDefine.setAttribute("aria-selected", String(define));
    tlInspect.hidden = !inspect && !scan;
    definePanel.hidden = !define;
    scanPanel.hidden = !scan;
    fdField.hidden = !inspect;
    buildField.hidden = !inspect;
    goBtn.hidden = !inspect;
    metaEl.hidden = !inspect;
    filterEl.hidden = !inspect;
    legendEl.hidden = !inspect;
    rowcountEl.hidden = !inspect;
    tableEl.hidden = !inspect;
    markRows(store);
    if (define) {
        dropEl.querySelector("strong")!.textContent = "No sheet loaded";
        dropEl.querySelector("span")!.textContent =
            "Drop your custom PNG or BLP sheet to define its regions.";
        dropEl.querySelector(".hint")!.textContent =
            "click to browse · wheel = zoom · drag = draw regions · hover = coords";
        if (!store.getState().image) {
            dropEl.style.display = "flex";
            writeStatus(store, "drop your sheet to define regions");
        }
    } else if (scan) {
        dropEl.querySelector("strong")!.textContent = "No sheet loaded";
        dropEl.querySelector("span")!.textContent =
            "Drop a PNG/BLP sheet here to preview scanned regions on it.";
        dropEl.querySelector(".hint")!.textContent =
            "click to browse · wheel = zoom · drag = pan · hover = inspect";
        if (!store.getState().image) {
            dropEl.style.display = "flex";
            writeStatus(store, "scan addon code to begin (paste or open a file)");
        }
    } else {
        dropEl.querySelector("strong")!.textContent = "No atlas loaded";
        dropEl.querySelector("span")!.textContent =
            "Type a FileDataID above, or drop a PNG/BLP sheet here to preview your own.";
        dropEl.querySelector(".hint")!.textContent =
            "click to browse · wheel = zoom · drag = pan · hover = inspect";
    }
    drawFrame(store);
}

// ---------- atlas lookup ----------
async function findAtlas(): Promise<void> {
    const fdid = fdEl.value.trim();
    if (!/^\d+$/.test(fdid)) {
        writeStatus(store, "FDID must be a number", "err");
        fdEl.focus();
        return;
    }
    dbg("findAtlas fdid=" + fdid + " build=" + (buildEl.value || "default"));
    goBtn.disabled = true;
    writeStatus(store, "querying…");
    try {
        const j = await api.atlas(Number(fdid), buildEl.value || undefined);
        if (j.kind === "texture") {
            store.setState({
                atlas: null,
                texture: j,
                file: { fdid: j.filedata, version: j.version || "" },
                activeIndex: -1,
                hoverIndex: -1,
                groups: Object.create(null),
            });
            clearRows();
            renderTexture(store, j);
            renderTable(store);
            renderScan(store);
            updateExportButtons(store);
            writeStatus(store, "✓ texture found — not an atlas", "ok");
            void autoPreview(store, j.filedata, j.version || "");
            return;
        }
        if (j.kind === "missing") {
            writeStatus(store, "✗ " + (j.error || "not found"), "err");
            setMetaDetail(j.error || "not found");
            clearAtlas();
            return;
        }
        store.setState({
            atlas: j,
            texture: null,
            file: { fdid: j.filedata, version: j.build === "default" ? "" : j.build },
            activeIndex: -1,
            hoverIndex: -1,
            groups: Object.create(null),
        });
        renderMeta(store);
        renderTable(store);
        renderScan(store);
        updateExportButtons(store);
        writeStatus(store, `✓ ${j.members.length} regions · build ${j.build}`, "ok");
        void autoPreview(store, j.filedata, j.build === "default" ? "" : j.build);
    } catch (e) {
        writeStatus(store, "✗ " + ((e as Error).message || "not found"), "err");
        setMetaDetail((e as Error).message || "not found");
        clearAtlas();
    } finally {
        goBtn.disabled = false;
    }
}

function setMetaDetail(text: string): void {
    const el = q<HTMLElement>("#meta");
    el.innerHTML = "";
    el.textContent = text;
}

function clearAtlas(): void {
    store.setState({
        atlas: null,
        texture: null,
        file: null,
        activeIndex: -1,
        hoverIndex: -1,
    });
    clearRows();
    q<HTMLDivElement>("#legend").innerHTML = "";
    rowcountEl.textContent = "";
    renderTable(store);
    renderScan(store);
    updateExportButtons(store);
    drawFrame(store);
}

// ---------- image point helpers ----------
function imgPointFromEvent(e: MouseEvent): { x: number; y: number } {
    const rect = cv.getBoundingClientRect();
    return toImg(store, e.clientX - rect.left, e.clientY - rect.top);
}

// ---------- canvas / pointer interaction ----------
let dragPan = false;
let lastX = 0;
let lastY = 0;

cv.addEventListener("mousedown", (e) => {
    if (!store.getState().image) return;
    e.preventDefault();
    const p = imgPointFromEvent(e);
    if (store.getState().mode === "define") {
        const hit = hitDefHandle(store, p);
        if (hit) {
            store.setState({ defDrag: hit });
            return;
        }
        const click = store
            .getState()
            .defRegions.findIndex(
                (r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom,
            );
        if (click >= 0) {
            selectDef(store, click);
            return;
        }
        store.setState({ defSel: -1 });
        renderDefine(store);
        store.setState({ defSketch: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } });
        writeStatus(
            store,
            `drawing region — release to finish (${Math.round(p.x)}, ${Math.round(p.y)})`,
        );
        drawFrame(store);
        return;
    }
    dragPan = true;
    lastX = e.clientX;
    lastY = e.clientY;
});

window.addEventListener("mousemove", (e) => {
    const s = store.getState();
    if (s.mode === "define" && s.image) {
        const rect = cv.getBoundingClientRect();
        const inside =
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
        if (!inside) {
            cv.style.cursor = "";
            return;
        }
        const p = imgPointFromEvent(e);
        if (s.defDrag) {
            applyDefDrag(store, s.defDrag, p);
            const r = store.getState().defRegions[s.defDrag.idx];
            if (r) {
                writeStatus(
                    store,
                    `adjusting — ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}`,
                );
            }
            drawFrame(store);
            return;
        }
        if (s.defSketch) {
            store.setState({ defSketch: { ...s.defSketch, x2: p.x, y2: p.y } });
            drawFrame(store);
            showTip(store, e.clientX, e.clientY);
            return;
        }
        const hit = hitDefHandle(store, p);
        cv.style.cursor = hit ? EDGE_CURSOR[hit.handle] || "crosshair" : "crosshair";
        showTip(store, e.clientX, e.clientY);
        return;
    }
    if (dragPan) {
        const v = store.getState().view;
        store.setState({
            view: { ...v, ox: v.ox + (e.clientX - lastX), oy: v.oy + (e.clientY - lastY) },
        });
        lastX = e.clientX;
        lastY = e.clientY;
        drawFrame(store);
        showTip(store, e.clientX, e.clientY);
    } else {
        showTip(store, e.clientX, e.clientY);
    }
});

window.addEventListener("mouseup", () => {
    const s = store.getState();
    if (s.mode === "define") {
        if (s.defDrag) {
            store.setState({ defDrag: null });
            renderDefine(store);
            drawFrame(store);
            return;
        }
        if (s.defSketch) {
            commitSketch(store);
            drawFrame(store);
        }
        return;
    }
    dragPan = false;
});

cv.addEventListener("dblclick", () => {
    const { w, h } = syncCanvasSize();
    fit(store, w, h);
    drawFrame(store);
});

stageEl.addEventListener(
    "wheel",
    (e) => {
        if (!store.getState().image) return;
        e.preventDefault();
        const rect = cv.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const v = store.getState().view;
        const k = Math.exp(-e.deltaY * 0.0015);
        const ns = Math.min(40, Math.max(0.02, v.scale * k));
        store.setState({
            view: {
                scale: ns,
                ox: mx - (mx - v.ox) * (ns / v.scale),
                oy: my - (my - v.oy) * (ns / v.scale),
            },
        });
        drawFrame(store);
    },
    { passive: false },
);

window.addEventListener(
    "resize",
    debounce(() => {
        if (store.getState().image) {
            const { w, h } = syncCanvasSize();
            fit(store, w, h);
            drawFrame(store);
        }
    }, 80),
);

// ---------- filter ----------
bindFilter(store);

// ---------- drag & drop / browse ----------
["dragenter", "dragover"].forEach((evt) =>
    stageEl.addEventListener(evt, (e) => {
        e.preventDefault();
        stageEl.classList.add("dragging");
    }),
);
["dragleave", "drop"].forEach((evt) =>
    stageEl.addEventListener(evt, (e) => {
        e.preventDefault();
        stageEl.classList.remove("dragging");
    }),
);
stageEl.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /\.(lua|xml|txt|toc)$/i.test(f.name)) void scanFromFile(store, f);
    else void handleDroppedFile(store, f);
});
dropEl.addEventListener("click", () => fileInput.click());
dropEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
    }
});
fileInput.addEventListener(
    "change",
    () => void handleDroppedFile(store, fileInput.files && fileInput.files[0]),
);

// ---------- export ----------
const expStyleEl = q<HTMLSelectElement>("#expStyle");
expStyleEl.value = store.getState().exportStyle;
expStyleEl.addEventListener("change", () => {
    store.setState({ exportStyle: expStyleEl.value as LuaExportStyle });
});
q<HTMLButtonElement>("#btlua").addEventListener("click", () => copyAllLua(store));
q<HTMLButtonElement>("#btjson").addEventListener("click", () => copyAllJson(store));
q<HTMLButtonElement>("#btdl").addEventListener("click", () => {
    const f = store.getState().file;
    if (!f) return;
    triggerDownload(api.blpDownloadUrl(f.fdid, f.version || undefined), `${f.fdid}.blp`);
});
q<HTMLButtonElement>("#btreset").addEventListener("click", () => {
    const { w, h } = syncCanvasSize();
    fit(store, w, h);
    drawFrame(store);
});

// ---------- define mode ----------
q<HTMLInputElement>("#dName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        cv.focus();
    }
});
q<HTMLButtonElement>("#dAuto").addEventListener("click", () => autoDefineRegions(store));
q<HTMLButtonElement>("#dCopyAll").addEventListener("click", () => exportDefineLua(store));
q<HTMLButtonElement>("#dClear").addEventListener("click", () => {
    resetDef(store);
    writeStatus(store, "regions cleared");
    drawFrame(store);
});

// ---------- hotkeys ----------
window.addEventListener("keydown", (e) => {
    const s = store.getState();
    if (e.key === "Escape" && s.mode === "define" && !isTypingTarget()) {
        if (s.defSketch) {
            store.setState({ defSketch: null });
            drawFrame(store);
            return;
        }
        if (s.defSel >= 0) {
            store.setState({ defSel: -1 });
            renderDefine(store);
            drawFrame(store);
            return;
        }
    }
    if (e.key.toLowerCase() === "f" && !isTypingTarget()) {
        const { w, h } = syncCanvasSize();
        fit(store, w, h);
        drawFrame(store);
        dbg("reset view");
    }
    if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.metaKey && !isTypingTarget()) {
        if (!dbgSize()) dbg("debug log empty — run a Find first");
        debugEl.classList.toggle("show");
        dbg("debug panel " + (debugEl.classList.contains("show") ? "shown" : "hidden"));
    }
});

// ---------- header actions ----------
goBtn.addEventListener("click", () => void findAtlas());
fdEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void findAtlas();
});
mScan.addEventListener("click", () => setMode("scan"));
mDefine.addEventListener("click", () => setMode("define"));
mInspect.addEventListener("click", () => setMode("inspect"));

// ---------- boot ----------
installErrorLoggers();
bindScanPanel(store);
store.subscribe((s, prev) => {
    if (s.hoverIndex !== prev.hoverIndex || s.activeIndex !== prev.activeIndex) {
        drawFrame(store);
    }
});
dbg("boot: Atlas Inspector client");

async function loadBuilds(): Promise<void> {
    try {
        const j = await api.builds();
        for (const b of j.builds) {
            const o = document.createElement("option");
            o.value = b;
            o.textContent = b;
            buildEl.appendChild(o);
        }
    } catch {
        /* build list is a convenience; degrade to "default" only */
    }
}

void loadBuilds();
void api
    .health()
    .then((h) => {
        const tag = document.getElementById("buildTag");
        if (tag) tag.textContent = `v${h.version}`;
    })
    .catch(() => {
        /* server version tag is cosmetic */
    });

export { store };
