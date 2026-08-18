import { BATTLES_FEED_PREVIEW_LIMIT } from "../battles-constants";

export interface BattlesFeedPreviewParticipant {
  id: string;
  name: string;
}

export interface BattlesFeedPreview {
  alliances: BattlesFeedPreviewParticipant[];
  guilds: BattlesFeedPreviewParticipant[];
  allianceCount: number;
  guildCount: number;
}

const EMPTY_FEED_PREVIEW: BattlesFeedPreview = {
  alliances: [],
  guilds: [],
  allianceCount: 0,
  guildCount: 0,
};

function sortParticipantsByFame<T extends { killFame: number; kills: number }>(
  items: T[]
): T[] {
  return [...items].sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
}

function readPreviewText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

type PreviewStat = {
  id: string;
  name: string;
  killFame: number;
  kills: number;
};

function previewId(explicitId: string, key: string, name: string): string {
  if (explicitId) return explicitId;
  // Array indexes are not Albion ids; dict keys usually are.
  if (/^\d+$/.test(key)) return name;
  return key || name;
}

function previewStatsFromUnknown(value: unknown): PreviewStat[] {
  if (!value) return [];
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];

  const stats: PreviewStat[] = [];
  for (const [key, item] of entries) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = readPreviewText(row.name, row.Name);
    if (!name) continue;
    stats.push({
      id: previewId(readPreviewText(row.id, row.Id), key, name),
      name,
      killFame: Number(row.killFame ?? row.KillFame ?? 0) || 0,
      kills: Number(row.kills ?? row.Kills ?? 0) || 0,
    });
  }
  return stats;
}

function previewStatsFromPlayers(players: unknown): {
  alliances: PreviewStat[];
  guilds: PreviewStat[];
} {
  const guilds = new Map<string, PreviewStat>();
  const alliances = new Map<string, PreviewStat>();
  const playerEntries: unknown[] = Array.isArray(players)
    ? players
    : players && typeof players === "object"
      ? Object.values(players as Record<string, unknown>)
      : [];

  for (const item of playerEntries) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const killFame = Number(row.killFame ?? row.KillFame ?? 0) || 0;
    const kills = Number(row.kills ?? row.Kills ?? 0) || 0;

    const guildName = readPreviewText(row.guildName, row.GuildName);
    const guildId = readPreviewText(row.guildId, row.GuildId) || guildName;
    if (guildName && guildId) {
      const existing = guilds.get(guildId) ?? {
        id: guildId,
        name: guildName,
        killFame: 0,
        kills: 0,
      };
      existing.killFame += killFame;
      existing.kills += kills;
      guilds.set(guildId, existing);
    }

    const allianceName = readPreviewText(row.allianceName, row.AllianceName);
    const allianceId =
      readPreviewText(row.allianceId, row.AllianceId) || allianceName;
    if (allianceName && allianceId) {
      const existing = alliances.get(allianceId) ?? {
        id: allianceId,
        name: allianceName,
        killFame: 0,
        kills: 0,
      };
      existing.killFame += killFame;
      existing.kills += kills;
      alliances.set(allianceId, existing);
    }
  }

  return {
    alliances: [...alliances.values()],
    guilds: [...guilds.values()],
  };
}

function toFeedPreview(
  alliances: PreviewStat[],
  guilds: PreviewStat[]
): BattlesFeedPreview {
  if (alliances.length === 0 && guilds.length === 0) return EMPTY_FEED_PREVIEW;
  const sortedAlliances = sortParticipantsByFame(alliances);
  const sortedGuilds = sortParticipantsByFame(guilds);
  return {
    alliances: sortedAlliances
      .slice(0, BATTLES_FEED_PREVIEW_LIMIT)
      .map((a) => ({ id: a.id, name: a.name })),
    guilds: sortedGuilds
      .slice(0, BATTLES_FEED_PREVIEW_LIMIT)
      .map((g) => ({ id: g.id, name: g.name })),
    allianceCount: sortedAlliances.length,
    guildCount: sortedGuilds.length,
  };
}

function hasNamedParticipants(preview: BattlesFeedPreview): boolean {
  return preview.guilds.length > 0 || preview.alliances.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Slim list-card payload so the battles feed does not TOAST full JSON. */
export function buildBattlesFeedPreview(
  rawPayload: unknown,
  detailPayload: unknown
): BattlesFeedPreview {
  const detail = asRecord(detailPayload);
  const raw = asRecord(rawPayload);

  const fromDetailGroups = toFeedPreview(
    previewStatsFromUnknown(detail?.alliances ?? detail?.Alliances),
    previewStatsFromUnknown(detail?.guilds ?? detail?.Guilds)
  );
  if (hasNamedParticipants(fromDetailGroups)) return fromDetailGroups;

  const fromRawGroups = toFeedPreview(
    previewStatsFromUnknown(raw?.alliances ?? raw?.Alliances),
    previewStatsFromUnknown(raw?.guilds ?? raw?.Guilds)
  );
  if (hasNamedParticipants(fromRawGroups)) return fromRawGroups;

  const fromDetailPlayers = previewStatsFromPlayers(
    detail?.players ?? detail?.Players
  );
  const fromDetailPlayerPreview = toFeedPreview(
    fromDetailPlayers.alliances,
    fromDetailPlayers.guilds
  );
  if (hasNamedParticipants(fromDetailPlayerPreview)) {
    return fromDetailPlayerPreview;
  }

  const fromRawPlayers = previewStatsFromPlayers(raw?.players ?? raw?.Players);
  return toFeedPreview(fromRawPlayers.alliances, fromRawPlayers.guilds);
}

function asFeedParticipant(value: unknown): BattlesFeedPreviewParticipant | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const name = readPreviewText(row.name, row.Name);
  if (!name) return null;
  const id = readPreviewText(row.id, row.Id) || name;
  return { id, name };
}

export function parseBattlesFeedPreview(value: unknown): BattlesFeedPreview {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== "object") return EMPTY_FEED_PREVIEW;
  const raw = parsed as Partial<BattlesFeedPreview>;
  const alliances = Array.isArray(raw.alliances)
    ? raw.alliances
        .map(asFeedParticipant)
        .filter((a): a is BattlesFeedPreviewParticipant => a != null)
    : [];
  const guilds = Array.isArray(raw.guilds)
    ? raw.guilds
        .map(asFeedParticipant)
        .filter((g): g is BattlesFeedPreviewParticipant => g != null)
    : [];
  return {
    alliances,
    guilds,
    allianceCount:
      typeof raw.allianceCount === "number" ? raw.allianceCount : alliances.length,
    guildCount: typeof raw.guildCount === "number" ? raw.guildCount : guilds.length,
  };
}
