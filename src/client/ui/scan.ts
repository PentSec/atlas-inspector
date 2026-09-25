/**
 * Addon-code scanner UI: opens .lua/.xml sources (pick or paste), runs the
 * shared scanner, renders the entry list and locates entries on the sheet.
 * Row derivation is pure logic in state/scanView.ts; this module only renders.
 */
import { scanCode } from "../../shared/scan.js";
import { drawFrame } from "../canvas/draw.js";
import type { AppStore } from "../state/store.js";
import { scanExact, scanLuaText, scanRows, type ScanRow } from "../state/scanView.js";
import { markRows } from "./list.js";
import { copyText, q } from "./dom.js";
import { writeStatus } from "./meta.js";

let lastLabel = "";

export function renderScan(store: AppStore): void {
    const s = store.getState();
    const sheetW = s.image ? s.image.w : 0;
    const sheetH = s.image ? s.image.h : 0;
    const members = s.atlas ? s.atlas.members : [];
    const rows = scanRows(s.scans, sheetW, sheetH, members);

    q<HTMLSpanElement>("#scanMeta").textContent =
        rows.length === 0
            ? "no scan yet — open or paste addon code"
            : `${rows.length} entr${rows.length === 1 ? "y" : "ies"}${lastLabel ? " from " + lastLabel : ""} — click to locate`;

    const list = q<HTMLDivElement>("#scanRows");
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
        frag.appendChild(scanRowEl(store, row, i));
    });
    list.appendChild(frag);

    q<HTMLButtonElement>("#scanCopy").disabled = rows.length === 0;
}

function scanRowEl(store: AppStore, row: ScanRow, i: number): HTMLElement {
    const s = store.getState();
    const wrap = document.createElement("div");
    wrap.className = "srow" + (i === s.scanSel ? " sel" : "");
    wrap.tabIndex = 0;

    const head = document.createElement("div");
    head.className = "shead";
    const badge = document.createElement("span");
    badge.className = "sbadge";
    badge.textContent = row.src.source;
    const key = document.createElement("span");
    key.className = "sname";
    key.textContent = row.src.key;
    key.title = `line ${row.src.line}${row.src.texture ? " · " + row.src.texture : ""}`;
    head.append(badge, key);
    wrap.appendChild(head);

    const sub = document.createElement("div");
    sub.className = "ssub";
    const parts: string[] = [];
    if (row.src.texture) {
        const base = row.src.texture.split(/[\\/]/).pop() || row.src.texture;
        parts.push(base);
    }
    if (row.px) {
        parts.push(
            `${Math.round(row.px.left)}-${Math.round(row.px.right)} × ${Math.round(row.px.top)}-${Math.round(row.px.bottom)}`,
        );
    } else {
        parts.push(
            `u${row.src.u0.toFixed(4)}..${row.src.u1.toFixed(4)} v${row.src.v0.toFixed(4)}..${row.src.v1.toFixed(4)}`,
        );
    }
    if (row.dw || row.dh) parts.push(`${row.dw}×${row.dh} disp`);
    sub.textContent = parts.join(" · ");
    wrap.appendChild(sub);

    const chips = document.createElement("div");
    chips.className = "schips";
    if (row.flipX) chips.appendChild(chip("flipX", "warn"));
    if (row.flipY) chips.appendChild(chip("flipY", "warn"));
    if (row.px && !scanExact(row)) chips.appendChild(chip(`±${row.err!.toFixed(2)}px`, "warn"));
    else if (row.px) chips.appendChild(chip("exact", "ok"));
    if (row.marginLabel) chips.appendChild(chip(`m ${row.marginLabel}`, "acc"));
    if (row.matched >= 0 && s.atlas) {
        const m = s.atlas.members[row.matched];
        chips.appendChild(chip(`→ ${m ? m.name : "?"}`, "ok"));
    } else if (row.px) {
        chips.appendChild(chip("not on sheet", "dim"));
    }
    wrap.appendChild(chips);

    const actions = document.createElement("div");
    actions.className = "sact";
    const copy = document.createElement("button");
    copy.className = "mini";
    copy.textContent = "coords";
    copy.title = "Copy SetTexCoord line";
    copy.addEventListener("click", (e) => {
        e.stopPropagation();
        copyText(row.stcLine, `Copied :SetTexCoord for ${row.src.key}`);
    });
    actions.appendChild(copy);
    wrap.appendChild(actions);

    const locate = () => {
        store.setState({
            scanSel: i,
            activeIndex: row.matched,
            hoverIndex: -1,
            scanOpen: true,
        });
        markRows(store);
        renderScan(store);
        drawFrame(store);
    };
    wrap.addEventListener("click", locate);
    wrap.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            locate();
        }
    });
    return wrap;
}

function chip(text: string, kind: "warn" | "ok" | "acc" | "dim"): HTMLElement {
    const el = document.createElement("span");
    el.className = "chip " + kind;
    el.textContent = text;
    return el;
}

export function runScan(store: AppStore, text: string, label: string): void {
    const scans = scanCode(text);
    lastLabel = label;
    store.setState({ scans, scanSel: -1, scanOpen: true });
    renderScan(store);
    store.setState({ activeIndex: -1, hoverIndex: -1 });
    markRows(store);
    drawFrame(store);
    if (scans.length === 0)
        writeStatus(store, "✗ no regions found in " + (label || "source"), "err");
    else writeStatus(store, `✓ ${scans.length} region${scans.length === 1 ? "" : "s"} found`, "ok");
}

export async function scanFromFile(store: AppStore, file: File): Promise<void> {
    try {
        const text = await file.text();
        runScan(store, text, file.name);
    } catch {
        writeStatus(store, "✗ could not read " + file.name, "err");
    }
}

export function resetScan(store: AppStore): void {
    lastLabel = "";
    store.setState({ scans: [], scanSel: -1, scanOpen: false });
    renderScan(store);
}

/** Copy the whole scan list in the selected export style. */
export function copyScanLua(store: AppStore): void {
    const s = store.getState();
    const sheet = s.image;
    if (!sheet) {
        writeStatus(store, "load a sheet to normalize coords first", "err");
        return;
    }
    const rows = scanRows(s.scans, sheet.w, sheet.h, s.atlas ? s.atlas.members : []);
    const text = scanLuaText(rows, sheet.w, sheet.h, s.exportStyle);
    if (!text) {
        writeStatus(store, "nothing scanned yet", "err");
        return;
    }
    copyText(text, `Scanned regions copied (${s.exportStyle})`);
}

export function bindScanPanel(store: AppStore): void {
    const scanBox = q<HTMLTextAreaElement>("#scanBox");
    q<HTMLButtonElement>("#btScan").addEventListener("click", () => {
        store.setState({ scanOpen: true });
        q<HTMLInputElement>("#scanFile").click();
    });
    q<HTMLInputElement>("#scanFile").addEventListener("change", () => {
        const f =
            q<HTMLInputElement>("#scanFile").files && q<HTMLInputElement>("#scanFile").files![0];
        if (f) void scanFromFile(store, f);
        q<HTMLInputElement>("#scanFile").value = "";
    });
    q<HTMLButtonElement>("#btPaste").addEventListener("click", () => {
        scanBox.hidden = !scanBox.hidden;
        q<HTMLButtonElement>("#btScanBox").hidden = scanBox.hidden;
        if (!scanBox.hidden) scanBox.focus();
    });
    q<HTMLButtonElement>("#btScanBox").addEventListener("click", () => {
        const text = scanBox.value;
        if (text.trim()) runScan(store, text, "paste");
    });
    scanBox.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            const text = scanBox.value;
            if (text.trim()) runScan(store, text, "paste");
        }
        if (e.key === "Escape") {
            scanBox.hidden = true;
            q<HTMLButtonElement>("#btScanBox").hidden = true;
        }
    });
    q<HTMLButtonElement>("#scanCopy").addEventListener("click", () => copyScanLua(store));
    q<HTMLButtonElement>("#scanClear").addEventListener("click", () => {
        resetScan(store);
        writeStatus(store, "scan cleared");
    });
}
