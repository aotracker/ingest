import type {
  AlbionAllianceInfo,
  AlbionRegion,
  NormalizedAllianceInfo,
} from "./types";

export interface AllianceGuildEntry {
  id: string;
  name: string;
}

export interface AllianceLiveInfo {
  info: NormalizedAllianceInfo | null;
  error: string | null;
  guilds: AllianceGuildEntry[];
  memberCount: number | null;
}

export function normalizeAllianceInfo(
  raw: AlbionAllianceInfo | null | undefined
): NormalizedAllianceInfo | null {
  if (!raw) return null;

  const id = raw.Id?.trim() || raw.AllianceId?.trim();
  const name = raw.Name?.trim() || raw.AllianceName?.trim();
  if (!id || !name) return null;

  const tag = raw.Tag?.trim() || raw.AllianceTag?.trim() || null;

  return {
    id,
    name,
    tag,
    founderId: raw.FounderId ?? null,
    founderName: raw.FounderName ?? null,
    founded: raw.Founded ?? null,
    memberCount: raw.MemberCount ?? raw.NumPlayers ?? null,
    guilds: raw.Guilds,
  };
}

function normalizeGuildName(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.Name === "string" && record.Name.trim()) return record.Name.trim();
    if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
  }
  return "Unknown Guild";
}

export function parseAllianceGuilds(info: NormalizedAllianceInfo): AllianceGuildEntry[] {
  const guilds = info.guilds;
  if (!guilds || typeof guilds !== "object") return [];

  const entries: AllianceGuildEntry[] = [];

  if (Array.isArray(guilds)) {
    for (const item of guilds) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id =
        typeof record.Id === "string"
          ? record.Id
          : typeof record.id === "string"
            ? record.id
            : null;
      if (!id) continue;
      entries.push({ id, name: normalizeGuildName(record) });
    }
  } else {
    for (const [id, value] of Object.entries(guilds as Record<string, unknown>)) {
      if (!id) continue;
      entries.push({ id, name: normalizeGuildName(value) });
    }
  }

  return entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** Worker-only: fetch alliance from Albion API. */
export async function fetchAllianceInfoFromApi(
  region: AlbionRegion,
  allianceId: string
): Promise<AllianceLiveInfo> {
  const { getAlbionClient } = await import("./client");

  const client = getAlbionClient();
  let error: string | null = null;

  const raw = await client.getAllianceInfo(region, allianceId).catch((err) => {
    error = err instanceof Error ? err.message : "Failed to load alliance info";
    return null as AlbionAllianceInfo | null;
  });

  const info = normalizeAllianceInfo(raw);
  if (!info) {
    return { info: null, error, guilds: [], memberCount: null };
  }

  return {
    info,
    error: null,
    guilds: parseAllianceGuilds(info),
    memberCount: info.memberCount,
  };
}

export interface AllianceDisplayInfo {
  id: string;
  name: string;
  tag: string | null;
}

export async function resolveAllianceDisplay(
  region: AlbionRegion,
  allianceId: string
): Promise<AllianceDisplayInfo | null> {
  if (!allianceId.trim()) return null;

  const { getAllianceByAlbionId } = await import("../db/queries-ingest");

  const cached = await getAllianceByAlbionId(region, allianceId);
  if (cached) {
    return {
      id: cached.albionId,
      name: cached.name,
      tag: cached.tag,
    };
  }

  return null;
}
