import type { AlbionRegion } from "@aotracker/core/albion/types";
import { getBattleByAlbionId } from "@aotracker/core/db/battle-cache";

export type BattleGuildScore = {
  id: string;
  name: string;
  alliance?: string | null;
  kills: number;
  deaths: number;
  killFame: number;
  players: number;
  averageIp?: number | null;
};

export type BattleSnapshot = {
  region: AlbionRegion;
  albionBattleId: number;
  startTime: Date | null;
  endTime: Date | null;
  totalPlayers: number;
  totalKills: number;
  totalFame: number;
  guilds: BattleGuildScore[];
};

function readText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function guildIdFrom(explicitId: string, key: string, name: string): string {
  if (explicitId) return explicitId;
  if (/^\d+$/.test(key)) return name;
  return key || name;
}

export function parseBattleGuildScores(value: unknown): BattleGuildScore[] {
  if (!value) return [];
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];

  const scores: BattleGuildScore[] = [];
  for (const [key, item] of entries) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = readText(row.name, row.Name);
    if (!name) continue;
    const alliance =
      readText(row.alliance, row.Alliance, row.allianceName, row.AllianceName) ||
      null;
    const averageIp = Number(row.averageIp ?? row.AverageIp ?? 0) || 0;
    scores.push({
      id: guildIdFrom(readText(row.id, row.Id), key, name),
      name,
      alliance,
      kills: Number(row.kills ?? row.Kills ?? 0) || 0,
      deaths: Number(row.deaths ?? row.Deaths ?? 0) || 0,
      killFame: Number(row.killFame ?? row.KillFame ?? 0) || 0,
      players: Number(row.players ?? row.Players ?? 0) || 0,
      averageIp: averageIp > 0 ? averageIp : null,
    });
  }
  return scores.sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills || a.name.localeCompare(b.name)
  );
}

export function guildInBattle(
  snapshot: BattleSnapshot,
  guildAlbionId: string,
  guildName?: string | null
): BattleGuildScore | null {
  const id = guildAlbionId.trim();
  const byId = snapshot.guilds.find((guild) => guild.id === id);
  if (byId) return byId;
  const name = guildName?.trim().toLowerCase();
  if (!name) return null;
  return (
    snapshot.guilds.find((guild) => guild.name.trim().toLowerCase() === name) ??
    null
  );
}

export function battleFingerprint(snapshot: BattleSnapshot): string {
  const top = snapshot.guilds
    .slice(0, 12)
    .map(
      (guild) =>
        `${guild.id}:${guild.kills}:${guild.deaths}:${guild.killFame}:${guild.players}:${guild.alliance ?? ""}:${guild.averageIp ?? 0}`
    )
    .join(",");
  return [
    snapshot.totalPlayers,
    snapshot.totalKills,
    snapshot.totalFame,
    top,
  ].join("|");
}

const SCOREBOARD_IMAGE_ROWS = 4;

/** Top guilds for the recap image, always including the tracked guild. */
export function battleScoreboardRows(
  snapshot: BattleSnapshot,
  trackedGuildId: string,
  trackedGuildName?: string | null,
  limit = SCOREBOARD_IMAGE_ROWS
): BattleGuildScore[] {
  const tracked = guildInBattle(snapshot, trackedGuildId, trackedGuildName);
  const top = snapshot.guilds.slice(0, limit);
  if (!tracked) return top;
  if (
    top.some(
      (guild) => guild.id === tracked.id || guild.name === tracked.name
    )
  ) {
    return top;
  }
  if (limit <= 1) return [tracked];
  return [...top.slice(0, limit - 1), tracked];
}

export async function loadBattleSnapshot(
  region: AlbionRegion,
  albionBattleId: number
): Promise<BattleSnapshot | null> {
  const row = await getBattleByAlbionId(region, albionBattleId);
  if (!row) return null;

  const detail = asRecord(row.detailPayload);
  const raw = asRecord(row.rawPayload);
  const fromDetail = parseBattleGuildScores(detail?.guilds ?? detail?.Guilds);
  const fromRaw = parseBattleGuildScores(raw?.guilds ?? raw?.Guilds);
  const guilds = fromDetail.length > 0 ? fromDetail : fromRaw;

  const totalPlayers =
    row.totalPlayers ??
    (raw?.players && typeof raw.players === "object"
      ? Object.keys(raw.players as object).length
      : 0);

  return {
    region,
    albionBattleId,
    startTime: row.startTime,
    endTime: row.endTime,
    totalPlayers: totalPlayers ?? 0,
    totalKills: row.totalKills ?? 0,
    totalFame: row.totalFame ?? 0,
    guilds,
  };
}

export function snapshotFromAlbionBattle(
  region: AlbionRegion,
  albionBattleId: number,
  battle: {
    startTime?: string | Date | null;
    endTime?: string | Date | null;
    totalPlayers?: number | null;
    totalKills?: number | null;
    totalFame?: number | null;
    players?: unknown;
    guilds?: unknown;
  }
): BattleSnapshot {
  const start =
    battle.startTime instanceof Date
      ? battle.startTime
      : battle.startTime
        ? new Date(battle.startTime)
        : null;
  const end =
    battle.endTime instanceof Date
      ? battle.endTime
      : battle.endTime
        ? new Date(battle.endTime)
        : null;
  const fromPlayers =
    battle.players && typeof battle.players === "object"
      ? Object.keys(battle.players as object).length
      : 0;
  return {
    region,
    albionBattleId,
    startTime: start && !Number.isNaN(start.getTime()) ? start : null,
    endTime: end && !Number.isNaN(end.getTime()) ? end : null,
    totalPlayers: battle.totalPlayers ?? fromPlayers,
    totalKills: battle.totalKills ?? 0,
    totalFame: battle.totalFame ?? 0,
    guilds: parseBattleGuildScores(battle.guilds),
  };
}

/** Sample scoreboard for Discord preview posts (dev / test-post). */
export function sampleBattleSnapshot(input: {
  region: AlbionRegion;
  trackedGuildId: string;
  trackedGuildName?: string | null;
}): BattleSnapshot {
  const name = input.trackedGuildName?.trim() || "Your guild";
  return {
    region: input.region,
    albionBattleId: 0,
    startTime: new Date(),
    endTime: null,
    totalPlayers: 84,
    totalKills: 61,
    totalFame: 2_450_000,
    guilds: [
      {
        id: input.trackedGuildId,
        name,
        alliance: "POE",
        kills: 18,
        deaths: 11,
        killFame: 820_000,
        players: 22,
        averageIp: 1410,
      },
      {
        id: "preview-rivals",
        name: "Rivals",
        alliance: "BADD",
        kills: 16,
        deaths: 14,
        killFame: 710_000,
        players: 20,
        averageIp: 1380,
      },
      {
        id: "preview-third",
        name: "Third Party",
        alliance: null,
        kills: 9,
        deaths: 12,
        killFame: 390_000,
        players: 15,
        averageIp: 1290,
      },
      {
        id: "preview-fourth",
        name: "Free Company",
        alliance: "ARCH",
        kills: 7,
        deaths: 10,
        killFame: 280_000,
        players: 12,
        averageIp: 1240,
      },
    ],
  };
}
