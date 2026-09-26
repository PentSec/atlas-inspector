/**
 * Debug log — console + on-screen panel (toggle with "D"). Mirrors the legacy
 * dbg() incl. its 100-line ring buffer and error/rejection logging.
 */

const DBG: string[] = [];

function dbgLine(value: string): string {
    return "[" + new Date().toISOString().slice(11, 19) + "] " + value;
}

export function dbg(...args: unknown[]): void {
    const line = dbgLine(
        args
            .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
            .join(" "),
    );
    DBG.push(line);
    if (DBG.length > 100) DBG.shift();
    console.log(line);
    const el = document.getElementById("debugbox");
    if (el) {
        el.textContent = DBG.join("\n");
        el.scrollTop = el.scrollHeight;
    }
}

export function dbgSize(): number {
    return DBG.length;
}

export function installErrorLoggers(): void {
    window.addEventListener("error", (e) => {
        dbg("!! window.onerror:", e.message, "at", `${e.filename}:${e.lineno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
        dbg("!! rejection:", (e.reason && (e.reason as Error).message) || String(e.reason));
    });
}
