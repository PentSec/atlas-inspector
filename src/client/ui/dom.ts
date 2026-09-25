/**
 * Tiny DOM helpers + shared UI side-effects (status line, toast, clipboard).
 * Imported by every module; keeps imperative DOM access in one place.
 */

/** Strict querySelector — throws when a required element is missing. */
export function q<T extends Element>(sel: string): T {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element #${sel.replace(/^#/, "")}`);
  return node;
}

const escapeDiv = document.createElement("div");
export function escapeHtml(s: unknown): string {
  escapeDiv.textContent = s == null ? "" : String(s);
  return escapeDiv.innerHTML;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** True while the user is typing in a field (skips global hotkeys). */
export function isTypingTarget(): boolean {
  const node = document.activeElement;
  return !!node && ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string, isError = false): void {
  const el = q<HTMLDivElement>("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

export function copyText(text: string, msg: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(msg))
    .catch(() => toast("✗ clipboard blocked", true));
}

/** Trigger an anchor-style download (used by the .blp button). */
export function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Downloading ${filename}…`);
}