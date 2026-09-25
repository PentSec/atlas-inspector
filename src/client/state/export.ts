/**
 * Atlas -> Lua export (DOM-free, directly testable). Shared formatter with the
 * server's /atlas/:fdid/export; the client copies this text to the clipboard.
 */
import {
    displaySizeFallback,
    luaExportStyled,
    luaRegionEntry,
    type LuaExportStyle,
} from "../../shared/lua.js";
import type { AtlasResultOk, Region } from "../../shared/schemas.js";

export function memberEntry(m: Region, atlas: AtlasResultOk): string {
    const { dispW, dispH } = displaySizeFallback(m);
    return luaRegionEntry({
        name: m.name,
        left: m.left,
        right: m.right,
        top: m.top,
        bottom: m.bottom,
        dispW,
        dispH,
        sheetW: atlas.atlas.width,
        sheetH: atlas.atlas.height,
    });
}

export function atlasLuaFragment(atlas: AtlasResultOk): string {
    return atlas.members.map((m) => memberEntry(m, atlas)).join("\n");
}

/** Style-aware variant; `default` is byte-identical to atlasLuaFragment. */
export function atlasLuaStyled(atlas: AtlasResultOk, style: LuaExportStyle): string {
    if (style === "default") return atlasLuaFragment(atlas);
    const inputs = atlas.members.map((m) => {
        const { dispW, dispH } = displaySizeFallback(m);
        return {
            name: m.name,
            left: m.left,
            right: m.right,
            top: m.top,
            bottom: m.bottom,
            dispW,
            dispH,
            sheetW: atlas.atlas.width,
            sheetH: atlas.atlas.height,
        };
    });
    return luaExportStyled(inputs, style);
}

export function atlasJson(atlas: AtlasResultOk): string {
    return JSON.stringify(atlas, null, 1);
}
