/**
 * Region list (render-all, legacy parity), legend and single/all export copy.
 * Rows are rebuilt on filter changes; hover/active mirrors the canvas.
 */
import type { Region } from "../../shared/schemas.js";
import { filteredMembers } from "../state/select.js";
import type { AppStore } from "../state/store.js";
import { grpColor } from "../state/store.js";
import { atlasJson, atlasLuaStyled, memberEntry } from "../state/export.js";
import { copyText, debounce, q } from "./dom.js";

export function clearRows(): void {
    q<HTMLTableSectionElement>("#rows").innerHTML = "";
}

function groupKey(name: string): string {
    return (name || "").split("-").slice(0, 2).join("-") || "other";
}

function dispLabel(m: Region): string {
    return m.displayW && m.displayH
        ? `${m.displayW}×${m.displayH}`
        : `${m.overrideW || m.width}×${m.overrideH || m.height}`;
}

export function renderTable(store: AppStore): void {
    clearRows();
    const s = store.getState();
    const atlas = s.atlas;
    const tbody = q<HTMLTableSectionElement>("#rows");
    const qText = s.filterQuery;
    const frag = document.createDocumentFragment();
    const seenGroups = new Set<string>();
    let shown = 0;

    if (atlas) {
        for (const { midx, m } of filteredMembers(atlas, qText)) {
            shown++;
            seenGroups.add(groupKey(m.name));
            const tr = document.createElement("tr");
            tr.tabIndex = 0;
            tr.dataset.midx = String(midx);

            const tdName = document.createElement("td");
            tdName.style.color = grpColor(store, m.name);
            tdName.textContent = m.name;
            const tdRect = document.createElement("td");
            tdRect.className = "px";
            tdRect.textContent = `${m.left}-${m.right} ${m.top}-${m.bottom}`;
            const tdDisp = document.createElement("td");
            tdDisp.className = "px";
            tdDisp.textContent = dispLabel(m);
            tr.append(tdName, tdRect, tdDisp);

            tr.addEventListener("click", () => selectRegion(store, midx));
            tr.addEventListener("mouseenter", () => {
                store.setState({ hoverIndex: midx });
            });
            tr.addEventListener("mouseleave", () => {
                const cur = store.getState();
                if (cur.hoverIndex === midx) store.setState({ hoverIndex: -1 });
            });
            tr.addEventListener("keydown", (e) => onRowKeydown(store, e, tr, midx));
            frag.appendChild(tr);
        }
    }

    if (shown === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 3;
        td.id = "empty-row";
        td.textContent = atlas
            ? qText
                ? `No regions match "${qText}".`
                : "No regions."
            : "No atlas loaded yet — type a FileDataID and press Enter.";
        tr.appendChild(td);
        frag.appendChild(tr);
    }
    tbody.appendChild(frag);

    q<HTMLSpanElement>("#rowcount").textContent = atlas
        ? qText
            ? `${shown} of ${atlas.members.length} regions`
            : `${shown} regions`
        : "";
    renderLegend(store, seenGroups);
    markRows(store);
}

function renderLegend(store: AppStore, groupNames: ReadonlySet<string>): void {
    const legend = q<HTMLDivElement>("#legend");
    legend.innerHTML = "";
    const names = [...groupNames].slice(0, 12);
    const frag = document.createDocumentFragment();
    for (const name of names) {
        const color = grpColor(store, name);
        const span = document.createElement("span");
        span.textContent = name;
        span.style.color = color;
        span.style.borderColor = color;
        span.title = name;
        frag.appendChild(span);
    }
    if (groupNames.size > names.length) {
        const more = document.createElement("span");
        more.className = "more";
        more.textContent = `+${groupNames.size - names.length} more`;
        frag.appendChild(more);
    }
    legend.appendChild(frag);
}

export function markRows(store: AppStore): void {
    const active = store.getState().activeIndex;
    const rows = q<HTMLTableSectionElement>("#rows");
    for (const tr of rows.children) {
        const midx = Number((tr as HTMLElement).dataset.midx ?? -1);
        tr.classList.toggle("active", midx === active);
    }
}

export function selectRegion(store: AppStore, midx: number): void {
    const wasActive = store.getState().activeIndex === midx;
    store.setState({ activeIndex: wasActive ? -1 : midx });
    markRows(store);
    if (!wasActive) {
        const atlas = store.getState().atlas;
        const member = atlas && atlas.members[midx];
        if (member) copyText(memberEntry(member, atlas), `Copied ${member.name} (Lua)`);
    }
}

function onRowKeydown(store: AppStore, e: KeyboardEvent, tr: HTMLElement, midx: number): void {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectRegion(store, midx);
        return;
    }
    if (e.key === "Escape") {
        store.setState({ activeIndex: -1, hoverIndex: -1 });
        markRows(store);
        tr.blur();
        return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const rows = [...q<HTMLTableSectionElement>("#rows").children] as HTMLElement[];
        const idx = rows.indexOf(tr);
        const next = rows[idx + dir];
        if (next) next.focus();
    }
}

/** Copy the whole atlas as Lua in the selected export style. */
export function copyAllLua(store: AppStore): void {
    const s = store.getState();
    const atlas = s.atlas;
    if (!atlas) return;
    const text = atlasLuaStyled(atlas, s.exportStyle);
    copyText(
        text,
        s.exportStyle === "default"
            ? "Lua entries copied"
            : `Lua entries copied (${s.exportStyle})`,
    );
}

export function copyAllJson(store: AppStore): void {
    const atlas = store.getState().atlas;
    if (!atlas) return;
    copyText(atlasJson(atlas), "JSON copied");
}

/** Debounced filter: re-render the table when the query settles. */
export function bindFilter(store: AppStore): void {
    const filterEl = q<HTMLInputElement>("#filter");
    filterEl.addEventListener(
        "input",
        debounce(() => {
            store.setState({ filterQuery: filterEl.value.trim().toLowerCase() });
            if (store.getState().atlas) renderTable(store);
        }, 120),
    );
}
