/**
 * Meta panel, status line and export-button wiring. Parity with the legacy
 * client's renderMeta / renderTexture / updateExportButtons behaviour.
 */
import type { TextureResult } from "../../shared/schemas.js";
import type { AppStore } from "../state/store.js";
import { escapeHtml, q } from "./dom.js";

export function setMetaHTML(html: string): void {
  q<HTMLElement>("#meta").innerHTML = html;
}

export function writeStatus(store: AppStore, text: string, kind: "" | "ok" | "err" = ""): void {
  const el = q<HTMLSpanElement>("#status");
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  store.setState({ status: { text, kind } });
}

export function renderMeta(store: AppStore): void {
  const s = store.getState();
  const a = s.atlas?.atlas;
  if (!s.atlas || !a) return;
  setMetaHTML(
    `FDID <b>${a.filedata}</b> · atlas ${a.id} · ${a.width}×${a.height} · build <b>${escapeHtml(s.atlas.build)}</b><br>` +
      `${s.atlas.members.length} regions`,
  );
}

export function renderTexture(store: AppStore, j: TextureResult): void {
  const versions = j.versions && j.versions.length
    ? j.versions.slice(0, 5).join(", ")
    : j.version || "?";
  setMetaHTML(
    `✓ file <b>${escapeHtml(String(j.filedata))}</b> exists on wago.tools<br>` +
      `path <b style="color:#79c0ff">${escapeHtml(j.filename || "?")}</b><br>` +
      `type ${escapeHtml(j.type || "blp")} · latest version <b>${escapeHtml(j.version || "?")}</b><br>` +
      `<span style="color:var(--warn)">✗ ${escapeHtml(j.error || "")}</span><br>` +
      `versions: <span style="color:var(--dim)">${escapeHtml(versions)}</span>`,
  );
  const tbody = q<HTMLTableSectionElement>("#rows");
  tbody.innerHTML = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 3;
  td.innerHTML =
    `<span style="color:var(--dim)">Single-file texture, no UiTextureAtlasMember regions.</span> `;
  const a = document.createElement("a");
  a.href = j.download;
  a.download = `${j.filedata}.blp`;
  a.target = "_blank";
  a.style.color = "var(--ok)";
  a.textContent = `Download .blp (${j.version || "?"})`;
  td.appendChild(a);
  tr.appendChild(td);
  tbody.appendChild(tr);
}

export function updateExportButtons(store: AppStore): void {
  const s = store.getState();
  const lua = q<HTMLButtonElement>("#btlua");
  const json = q<HTMLButtonElement>("#btjson");
  lua.disabled = !s.atlas;
  json.disabled = !s.atlas;
  const dl = q<HTMLButtonElement>("#btdl");
  const f = s.file;
  dl.disabled = !f;
  dl.title = f
    ? `Download ${f.fdid}.blp${f.version ? ` (build ${f.version})` : ""}`
    : "";
}