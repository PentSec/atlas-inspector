/**
 * Filtered view of atlas members (single computation shared by the
 * virtualized list, the legend and the row counter).
 */
import type { AtlasResultOk, Region } from "../../shared/types.js";

export interface MemberRef {
  midx: number;
  m: Region;
}

let cacheKey = "";
let cacheMembers: MemberRef[] = [];

/** Filtered members in atlas order; memoized on `atlas` identity + query. */
export function filteredMembers(atlas: AtlasResultOk | null, query: string): MemberRef[] {
  const key = atlas ? `${atlas.filedata}:${query}` : "";
  if (key === cacheKey) return cacheMembers;
  cacheKey = key;
  if (!atlas) {
    cacheMembers = [];
    return cacheMembers;
  }
  const q = query.trim().toLowerCase();
  const out: MemberRef[] = [];
  atlas.members.forEach((m, midx) => {
    if (!q || m.name.toLowerCase().includes(q)) out.push({ midx, m });
  });
  cacheMembers = out;
  return cacheMembers;
}

/** Member index -> position in the filtered list, or -1 when filtered out. */
export function filteredPosition(members: MemberRef[], midx: number): number {
  for (let i = 0; i < members.length; i++) {
    if (members[i]?.midx === midx) return i;
  }
  return -1;
}