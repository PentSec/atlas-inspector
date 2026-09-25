/**
 * Single source of truth for the client (ADR-007: zustand vanilla, no React).
 * UI modules subscribe to slices; canvas/list/meta re-render out of it.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

import type { LuaExportStyle } from "../../shared/lua.js";
import type { ScannedRegion } from "../../shared/scan.js";
import type { AtlasResultOk, Region, TextureResult } from "../../shared/types.js";

export type Mode = "inspect" | "scan" | "define";

export interface DefineRegion {
    name: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface DefDrag {
    idx: number;
    handle: string;
    startX: number;
    startY: number;
    orig: DefineRegion;
}

export interface View {
    scale: number;
    ox: number;
    oy: number;
}

/** The displayed sheet: decoded <img> plus its source pixels. */
export interface SheetImage {
    el: HTMLImageElement;
    url: string;
    w: number;
    h: number;
}

export interface UpstreamFile {
    fdid: number;
    version: string;
}

export interface Status {
    text: string;
    kind: "" | "ok" | "err";
}

export interface AppState {
    mode: Mode;

    healthVersion: string;
    builds: string[];

    atlas: AtlasResultOk | null;
    texture: TextureResult | null;
    image: SheetImage | null;
    file: UpstreamFile | null;

    /** member index into atlas.members, -1 when none */
    activeIndex: number;
    hoverIndex: number;
    focusIndex: number;
    filterQuery: string;

    /** color assigned per group prefix ("a-b" of "a-b-c"), shared by list+canvas */
    groups: Record<string, string>;

    view: View;

    status: Status;
    loading: boolean;
    loadingMsg: string;

    // define mode (parity with legacy `def` object)
    defRegions: DefineRegion[];
    defNext: number;
    defSel: number;
    defSketch: { x1: number; y1: number; x2: number; y2: number } | null;
    defDrag: DefDrag | null;

    /** Lua export style for Copy Lua / scan export */
    exportStyle: LuaExportStyle;

    // addon-code scan (table/SetTexCoord/XML entries from pasted/opened sources)
    scanOpen: boolean;
    scans: ScannedRegion[];
    /** selected scan entry, -1 none (drives the on-sheet locate guide) */
    scanSel: number;

    setStatus: (text: string, kind?: Status["kind"]) => void;
    setLoading: (msg: string) => void;
    hideLoading: () => void;

    setBuilds: (builds: string[]) => void;
    setHealthVersion: (v: string) => void;

    setMode: (m: Mode) => void;

    /** results of a completed atlas lookup (only one of atlas/texture set) */
    setResult: (
        atlas: AtlasResultOk | null,
        texture: TextureResult | null,
        file: UpstreamFile | null,
    ) => void;
    clearResult: () => void;

    setImage: (image: SheetImage | null) => void;
    setView: (v: View) => void;

    setActiveIndex: (i: number) => void;
    toggleActive: (i: number) => void;
    setHoverIndex: (i: number) => void;
    setFocusIndex: (i: number) => void;
    setFilterQuery: (q: string) => void;

    setDefRegions: (r: DefineRegion[]) => void;
    setDefSel: (i: number) => void;
    setDefNext: (n: number) => void;
    setDefSketch: (s: AppState["defSketch"]) => void;
    setDefDrag: (d: AppState["defDrag"]) => void;

    setExportStyle: (style: LuaExportStyle) => void;
    setScanOpen: (open: boolean) => void;
    setScans: (scans: ScannedRegion[]) => void;
    setScanSel: (i: number) => void;
}

const PALETTE = [
    "#ff7b72",
    "#79c0ff",
    "#3fb950",
    "#f0883e",
    "#d2a8ff",
    "#f2cc60",
    "#ffa657",
    "#7ee787",
    "#a5d6ff",
    "#f9f3d9",
];

export type AppStore = StoreApi<AppState>;

export function createAppStore(): AppStore {
    return createStore<AppState>()((set) => ({
        mode: "inspect",
        healthVersion: "",
        builds: [],
        atlas: null,
        texture: null,
        image: null,
        file: null,
        activeIndex: -1,
        hoverIndex: -1,
        focusIndex: -1,
        filterQuery: "",
        groups: Object.create(null),
        view: { scale: 1, ox: 0, oy: 0 },
        status: { text: "", kind: "" },
        loading: false,
        loadingMsg: "",
        defRegions: [],
        defNext: 1,
        defSel: -1,
        defSketch: null,
        defDrag: null,
        exportStyle: "default",
        scanOpen: false,
        scans: [],
        scanSel: -1,

        setStatus: (text, kind = "") => set({ status: { text, kind } }),
        setLoading: (msg) => set({ loading: true, loadingMsg: msg }),
        hideLoading: () => set({ loading: false }),

        setBuilds: (builds) => set({ builds }),
        setHealthVersion: (healthVersion) => set({ healthVersion }),

        setMode: (mode) => set({ mode, activeIndex: -1, hoverIndex: -1 }),

        setResult: (atlas, texture, file) =>
            set({
                atlas,
                texture,
                file,
                activeIndex: -1,
                hoverIndex: -1,
                focusIndex: -1,
                groups: Object.create(null),
            }),
        clearResult: () =>
            set({
                atlas: null,
                texture: null,
                file: null,
                activeIndex: -1,
                hoverIndex: -1,
                focusIndex: -1,
                groups: Object.create(null),
            }),

        setImage: (image) => set({ image }),
        setView: (view) => set({ view }),

        setActiveIndex: (activeIndex) => set({ activeIndex }),
        toggleActive: (i) => set((s) => ({ activeIndex: s.activeIndex === i ? -1 : i })),
        setHoverIndex: (hoverIndex) => set({ hoverIndex }),
        setFocusIndex: (focusIndex) => set({ focusIndex }),
        setFilterQuery: (filterQuery) => set({ filterQuery }),

        setDefRegions: (defRegions) => set({ defRegions }),
        setDefSel: (defSel) => set({ defSel }),
        setDefNext: (defNext) => set({ defNext }),
        setDefSketch: (defSketch) => set({ defSketch }),
        setDefDrag: (defDrag) => set({ defDrag }),

        setExportStyle: (exportStyle) => set({ exportStyle }),
        setScanOpen: (scanOpen) => set({ scanOpen }),
        setScans: (scans) => set({ scans, scanSel: -1 }),
        setScanSel: (scanSel) => set({ scanSel }),
    }));
}

/** Group color, assigned on first sight (parity with legacy). */
export function grpColor(store: AppStore, name: string): string {
    const key = (name || "").split("-").slice(0, 2).join("-") || "other";
    const groups = store.getState().groups;
    if (!(key in groups)) {
        const next: Record<string, string> = Object.assign({}, groups);
        next[key] = PALETTE[Object.keys(groups).length % PALETTE.length] ?? "#d2a8ff";
        store.setState({ groups: next });
    }
    return store.getState().groups[key] ?? "#fff";
}

export function memberAt(store: AppStore, index: number): Region | null {
    const { atlas } = store.getState();
    if (!atlas || index < 0) return null;
    const m = atlas.members[index];
    return m ?? null;
}
