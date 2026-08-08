import { cache } from "../cache";
import type {
  AlbionBattle,
  AlbionBattleAllianceStats,
  AlbionBattleGuildStats,
  AlbionBattlePlayer,
  AlbionEvent,
  AlbionPlayerRef,
  AlbionRegion,
  GuildBattleSummary,
} from "./types";
import { isRegionEnabled } from "./types";
import { isSyncStale } from "../db/sync";
import { BATTLES_FEED_PREVIEW_LIMIT } from "../battles-constants";

const GUILD_BATTLES_REQUEST_OPTIONS = {
  maxRetries: 1,
  timeout: 20_000,
} as const;

const GUILD_RECENT_BATTLES_PAGE_SIZE = 25;
const GUILD_RECENT_BATTLES_MAX_PAGES = 4;

const BATTLE_EVENTS_PAGE_SIZE = 51;
const BATTLE_EVENTS_MAX = 2000;

type PlayerGearLookup = {
  killersAndAssists: Record<string, AlbionPlayerRef>;
  deaths: Record<string, AlbionPlayerRef>;
  groupGear: Record<
    string,
    {
      weaponType: string | null;
      weaponQuality: number | null;
      averageIp: number | null;
    }
  >;
};

function sortByFameThenKills<T extends { killFame: number; kills: number }>(
  items: T[]
): T[] {
  return [...items].sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
}

function battleGuildPreview(battle: AlbionBattle): {
  guilds: { id: string; name: string }[];
  guildCount: number;
} {
  const guilds = sortByFameThenKills(
    battle.guilds ? Object.values(battle.guilds) : []
  );

  return {
    guilds: guilds.slice(0, BATTLES_FEED_PREVIEW_LIMIT).map((g) => ({
      id: g.id,
      name: g.name,
    })),
    guildCount: guilds.length,
  };
}

export function toGuildBattleSummary(
  battle: AlbionBattle,
  guildId: string
): GuildBattleSummary {
  const players = battle.players;
  const guildMembers = players
    ? Object.values(players).filter((player) => player.guildId === guildId).length
    : 0;
  const guildEntry = battle.guilds?.[guildId];
  const guildPreview = battleGuildPreview(battle);

  return {
    id: battle.id ?? battle.albionId ?? 0,
    startTime: battle.startTime ?? null,
    totalFame: battle.totalFame ?? null,
    totalKills: battle.totalKills ?? null,
    totalPlayers:
      battle.totalPlayers ?? (players ? Object.keys(players).length : null),
    guildKillFame: guildEntry?.killFame ?? null,
    guildKills: guildEntry?.kills ?? null,
    guildDeaths: guildEntry?.deaths ?? null,
    guildMembers,
    ...guildPreview,
  };
}

/** Battles with no kill fame are noise on guild lists (see also `hasKillFame`). */
export function hasBattleKillFame(
  battle: Pick<GuildBattleSummary, "totalFame"> | Pick<AlbionBattle, "totalFame">
): boolean {
  return (battle.totalFame ?? 0) > 0;
}

/** Recent guild battles need more than one member from the guild. */
export function isMultiMemberGuildBattle(
  battle: Pick<GuildBattleSummary, "guildMembers">
): boolean {
  return battle.guildMembers > 1;
}

export function filterRecentGuildBattles(
  battles: GuildBattleSummary[]
): GuildBattleSummary[] {
  return battles.filter(isMultiMemberGuildBattle);
}

const GUILD_BATTLE_LIST_CACHE_VERSION = 1;

export type GuildBattleListCache = {
  v: typeof GUILD_BATTLE_LIST_CACHE_VERSION;
  battles: GuildBattleSummary[];
};

export function wrapGuildBattleListCache(
  battles: GuildBattleSummary[]
): GuildBattleListCache {
  return { v: GUILD_BATTLE_LIST_CACHE_VERSION, battles };
}

/** Read battles from v1 cache wrapper or legacy raw arrays. */
export function unwrapGuildBattleListCache(
  payload: unknown
): GuildBattleSummary[] | null {
  if (payload == null) return null;
  if (Array.isArray(payload)) return payload as GuildBattleSummary[];
  if (
    typeof payload === "object" &&
    (payload as GuildBattleListCache).v === GUILD_BATTLE_LIST_CACHE_VERSION &&
    Array.isArray((payload as GuildBattleListCache).battles)
  ) {
    return (payload as GuildBattleListCache).battles;
  }
  return null;
}

function battleListMissingGuildPreview(battles: GuildBattleSummary[]): boolean {
  return battles.some(
    (item) =>
      item != null && typeof item === "object" && !("guilds" in item)
  );
}

/** True when cached battle list should be refetched (null, malformed, or untrusted legacy empty). */
export function isGuildBattleListCacheMissing(
  payload: unknown,
  options?: { counterpartHasBattles?: boolean }
): boolean {
  if (payload == null) return true;

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return options?.counterpartHasBattles === true;
    }
    return battleListMissingGuildPreview(payload as GuildBattleSummary[]);
  }

  const cached = payload as Partial<GuildBattleListCache>;
  if (
    cached.v !== GUILD_BATTLE_LIST_CACHE_VERSION ||
    !Array.isArray(cached.battles)
  ) {
    return true;
  }

  if (cached.battles.length === 0) return false;

  return battleListMissingGuildPreview(cached.battles);
}

export function guildBattleListCacheHasBattles(payload: unknown): boolean {
  return (unwrapGuildBattleListCache(payload)?.length ?? 0) > 0;
}

export function canPersistGuildBattleSync(
  topError: string | null,
  recentError: string | null
): boolean {
  return topError == null && recentError == null;
}

/** True when a guild battle list should be refetched (missing, untrusted, or stale). */
export function guildBattleListNeedsRefresh(
  payload: unknown,
  counterpartPayload: unknown,
  battlesLastSyncedAt: Date | null | undefined,
  options?: { force?: boolean }
): boolean {
  if (options?.force) return true;
  if (!battlesLastSyncedAt || isSyncStale(battlesLastSyncedAt)) return true;
  return isGuildBattleListCacheMissing(payload, {
    counterpartHasBattles: guildBattleListCacheHasBattles(counterpartPayload),
  });
}

/** Both lists are present and trusted (verified empty or populated). */
export function isGuildBattleCacheComplete(
  recentPayload: unknown,
  topPayload: unknown
): boolean {
  const topHasBattles = guildBattleListCacheHasBattles(topPayload);
  const recentHasBattles = guildBattleListCacheHasBattles(recentPayload);
  return (
    !isGuildBattleListCacheMissing(recentPayload, {
      counterpartHasBattles: topHasBattles,
    }) &&
    !isGuildBattleListCacheMissing(topPayload, {
      counterpartHasBattles: recentHasBattles,
    })
  );
}

async function fetchRecentGuildBattles(
  region: AlbionRegion,
  guildId: string,
  targetCount: number
): Promise<GuildBattleSummary[]> {
  const { getAlbionClient } = await import("./client");
  const client = getAlbionClient();
  const requestOptions = GUILD_BATTLES_REQUEST_OPTIONS;

  const collected: GuildBattleSummary[] = [];
  const seenIds = new Set<number>();

  for (let page = 0; page < GUILD_RECENT_BATTLES_MAX_PAGES; page++) {
    const raw = await client.getBattlesRaw(region, {
      guildId,
      limit: GUILD_RECENT_BATTLES_PAGE_SIZE,
      offset: page * GUILD_RECENT_BATTLES_PAGE_SIZE,
      sort: "recent",
      range: "week",
      requestOptions,
    });

    if (raw.length === 0) break;

    for (const battle of filterRecentGuildBattles(
      summarizeGuildBattles(raw, guildId)
    )) {
      if (seenIds.has(battle.id)) continue;
      seenIds.add(battle.id);
      collected.push(battle);
      if (collected.length >= targetCount) {
        return collected.slice(0, targetCount);
      }
    }

    if (raw.length < GUILD_RECENT_BATTLES_PAGE_SIZE) break;
  }

  return collected;
}

export function summarizeGuildBattles(
  battles: AlbionBattle[],
  guildId: string
): GuildBattleSummary[] {
  return battles
    .filter(hasBattleKillFame)
    .map((battle) => toGuildBattleSummary(battle, guildId));
}

export async function getGuildTopBattles(
  region: AlbionRegion,
  guildId: string,
  limit = 10
): Promise<{ battles: GuildBattleSummary[]; battlesError: string | null }> {
  return getGuildBattlesBySort(region, guildId, "topfame", limit);
}

/** Worker helper: guild battles by sort (week window). */
export async function getGuildBattlesBySort(
  region: AlbionRegion,
  guildId: string,
  sort: "topfame" | "recent",
  limit = 10
): Promise<{ battles: GuildBattleSummary[]; battlesError: string | null }> {
  if (!isRegionEnabled(region)) {
    return { battles: [], battlesError: null };
  }
  const { getAlbionClient } = await import("./client");
  const client = getAlbionClient();
  const requestOptions = GUILD_BATTLES_REQUEST_OPTIONS;

  try {
    if (sort === "recent") {
      return {
        battles: await fetchRecentGuildBattles(region, guildId, limit),
        battlesError: null,
      };
    }

    const raw = await client.getBattlesRaw(region, {
      guildId,
      limit,
      sort,
      range: "week",
      requestOptions,
    });

    return {
      battles: summarizeGuildBattles(raw, guildId),
      battlesError: null,
    };
  } catch (err) {
    return {
      battles: [],
      battlesError:
        err instanceof Error
          ? err.message
          : `Failed to load ${sort === "recent" ? "recent" : "top"} battles`,
    };
  }
}

/** Alliance battles by sort (week window) — Albion summaries, no guild-member filter. */
export async function getAllianceBattlesBySort(
  region: AlbionRegion,
  allianceId: string,
  sort: "topfame" | "recent",
  limit = 10
): Promise<{ battles: GuildBattleSummary[]; battlesError: string | null }> {
  if (!isRegionEnabled(region)) {
    return { battles: [], battlesError: null };
  }
  const { getAlbionClient } = await import("./client");
  const client = getAlbionClient();

  try {
    const raw = await client.getBattlesRaw(region, {
      allianceId,
      limit,
      sort,
      range: "week",
      requestOptions: GUILD_BATTLES_REQUEST_OPTIONS,
    });

    const battles: GuildBattleSummary[] = raw
      .filter(hasBattleKillFame)
      .filter((battle): battle is AlbionBattle & { id: number } => battle.id != null)
      .map((battle) => {
        const guilds = battle.guilds
          ? Object.values(battle.guilds)
              .sort((a, b) => b.killFame - a.killFame || b.kills - a.kills)
              .slice(0, BATTLES_FEED_PREVIEW_LIMIT)
              .map((g) => ({ id: g.id, name: g.name }))
          : [];
        return {
          id: battle.id,
          startTime: battle.startTime ?? null,
          totalFame: battle.totalFame ?? 0,
          totalKills: battle.totalKills ?? 0,
          totalPlayers: battle.totalPlayers ?? 0,
          guildKillFame: 0,
          guildKills: 0,
          guildDeaths: 0,
          guildMembers: 0,
          guilds,
          guildCount: battle.guilds ? Object.keys(battle.guilds).length : 0,
        };
      });

    return { battles, battlesError: null };
  } catch (err) {
    return {
      battles: [],
      battlesError:
        err instanceof Error
          ? err.message
          : `Failed to load ${sort === "recent" ? "recent" : "top"} alliance battles`,
    };
  }
}

async function fetchBattleFromApi(
  region: AlbionRegion,
  battleId: number
): Promise<AlbionBattle | null> {
  if (!isRegionEnabled(region)) return null;
  const { getAlbionClient } = await import("./client");
  const { isCircuitOpenError } = await import("../db/api-state");
  const client = getAlbionClient();

  try {
    return await client.getBattle(region, battleId);
  } catch (err) {
    // Let the job queue soft-defer instead of treating an open circuit as "not found".
    if (isCircuitOpenError(err)) throw err;
    // Pages treat missing battles as null; sync-battle converts null → BattleNotReadyError.
    return null;
  }
}

async function resolveBattle(
  region: AlbionRegion,
  battleId: number
): Promise<AlbionBattle | null> {
  const { getCachedBattle } = await import("../db/battle-cache");
  const cached = await getCachedBattle(region, battleId);
  if (cached) return cached;
  return fetchBattleFromApi(region, battleId);
}

export const loadBattle = cache(resolveBattle);

export async function getAllBattleEvents(
  region: AlbionRegion,
  battleId: number
): Promise<AlbionEvent[]> {
  if (!isRegionEnabled(region)) return [];
  const { getAlbionClient } = await import("./client");
  const client = getAlbionClient();
  const events: AlbionEvent[] = [];

  for (
    let offset = 0;
    offset < BATTLE_EVENTS_MAX;
    offset += BATTLE_EVENTS_PAGE_SIZE
  ) {
    let batch: AlbionEvent[];
    try {
      batch = await client.getBattleEvents(region, battleId, {
        offset,
        limit: BATTLE_EVENTS_PAGE_SIZE,
        requestOptions: { maxRetries: 1 },
      });
    } catch (err) {
      const { isCircuitOpenError } = await import("../db/api-state");
      if (isCircuitOpenError(err)) throw err;
      break;
    }

    if (batch.length === 0) break;
    events.push(...batch);
    if (batch.length < BATTLE_EVENTS_PAGE_SIZE) break;
  }

  return events;
}

function collectParticipantGear(events: AlbionEvent[]): PlayerGearLookup {
  const killersAndAssists: Record<string, AlbionPlayerRef> = {};
  const deaths: Record<string, AlbionPlayerRef> = {};
  const groupGear: PlayerGearLookup["groupGear"] = {};

  for (const event of events) {
    if (event.Killer?.Id) {
      killersAndAssists[event.Killer.Id] = event.Killer;
    }
    if (event.Victim?.Id) {
      deaths[event.Victim.Id] = event.Victim;
    }
    for (const participant of event.Participants ?? []) {
      if (participant.Id) {
        killersAndAssists[participant.Id] = participant;
      }
    }
    for (const member of event.GroupMembers ?? []) {
      if (!member.Id) continue;
      const mainHand = member.Equipment?.MainHand;
      groupGear[member.Id] = {
        weaponType: mainHand?.Type ?? null,
        weaponQuality: mainHand?.Quality ?? null,
        averageIp: member.AverageItemPower ?? null,
      };
    }
  }

  return { killersAndAssists, deaths, groupGear };
}

function getPlayerGear(
  player: AlbionBattlePlayer,
  gear: PlayerGearLookup
): Pick<AlbionBattlePlayer, "weaponType" | "weaponQuality" | "averageIp"> {
  const source =
    player.killFame > 0
      ? gear.killersAndAssists[player.id]
      : gear.deaths[player.id];
  const mainHand = source?.Equipment?.MainHand;
  const fromEvent = {
    weaponType: mainHand?.Type ?? null,
    weaponQuality: mainHand?.Quality ?? null,
    averageIp: source?.AverageItemPower ?? null,
  };
  const fromGroup = gear.groupGear[player.id];

  return {
    weaponType: fromEvent.weaponType ?? fromGroup?.weaponType ?? null,
    weaponQuality: fromEvent.weaponQuality ?? fromGroup?.weaponQuality ?? null,
    averageIp: fromEvent.averageIp ?? fromGroup?.averageIp ?? null,
  };
}

export function enrichBattlePlayers(
  battle: AlbionBattle,
  events: AlbionEvent[]
): AlbionBattlePlayer[] {
  const players = getBattlePlayers(battle);
  if (players.length === 0 || events.length === 0) return players;

  const gear = collectParticipantGear(events);
  return players.map((player) => ({
    ...player,
    ...getPlayerGear(player, gear),
  }));
}

export function enrichBattleGuilds(
  guilds: AlbionBattleGuildStats[],
  players: AlbionBattlePlayer[]
): AlbionBattleGuildStats[] {
  return guilds.map((guild) => {
    const guildPlayers = players.filter((player) => player.guildId === guild.id);
    const playersWithIp = guildPlayers.filter(
      (player) => player.averageIp != null && player.averageIp > 0
    );
    const averageIp =
      playersWithIp.length > 0
        ? Math.round(
            playersWithIp.reduce((sum, player) => sum + (player.averageIp ?? 0), 0) /
              playersWithIp.length
          )
        : null;

    return { ...guild, players: guildPlayers.length, averageIp };
  });
}

export function enrichBattleAlliances(
  alliances: AlbionBattleAllianceStats[],
  players: AlbionBattlePlayer[]
): AlbionBattleAllianceStats[] {
  return alliances.map((alliance) => {
    const alliancePlayers = players.filter(
      (player) => player.allianceId === alliance.id
    );
    const playersWithIp = alliancePlayers.filter(
      (player) => player.averageIp != null && player.averageIp > 0
    );
    const averageIp =
      playersWithIp.length > 0
        ? Math.round(
            playersWithIp.reduce((sum, player) => sum + (player.averageIp ?? 0), 0) /
              playersWithIp.length
          )
        : null;

    return { ...alliance, players: alliancePlayers.length, averageIp };
  });
}

export const loadBattleDetailData = cache(async function loadBattleDetailData(
  region: AlbionRegion,
  battleId: number
): Promise<BattleDetailData | null> {
  return syncBattleDetailData(region, battleId);
});

/** Fetch and cache full battle detail (worker-safe; no React request cache). */
export async function syncBattleDetailData(
  region: AlbionRegion,
  battleId: number
): Promise<BattleDetailData | null> {
  const { getCachedBattleDetail, cacheBattleDetail } = await import(
    "../db/battle-cache"
  );

  const cached = await getCachedBattleDetail(region, battleId);
  if (cached) return cached;

  const battle = await resolveBattle(region, battleId);
  if (!battle) return null;

  let events: AlbionEvent[] = [];
  try {
    events = await getAllBattleEvents(region, battleId);
  } catch {
    // Degrade gracefully: battle stats still render without gear enrichment.
  }

  const players = enrichBattlePlayers(battle, events);
  const alliances = enrichBattleAlliances(getBattleAlliances(battle), players);
  const guilds = enrichBattleGuilds(getBattleGuilds(battle), players);

  const result = { battle, alliances, players, guilds };

  try {
    await cacheBattleDetail(region, battleId, { ...result, events });
  } catch {
    // Cache failure should not block the caller.
  }

  return result;
}

export function getBattleAlliances(battle: AlbionBattle) {
  if (!battle.alliances) return [];

  return Object.values(battle.alliances).sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
}

export function getBattleGuilds(battle: AlbionBattle) {
  if (!battle.guilds) return [];

  return Object.values(battle.guilds).sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
}

export function getBattlePlayers(battle: AlbionBattle) {
  if (!battle.players) return [];

  return Object.values(battle.players).sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
}

export type BattleDetailData = {
  battle: AlbionBattle;
  alliances: AlbionBattleAllianceStats[];
  players: AlbionBattlePlayer[];
  guilds: AlbionBattleGuildStats[];
};

function mergeNumericIp(
  a: number | null | undefined,
  b: number | null | undefined
): number | null {
  if (a != null && a > 0 && b != null && b > 0) {
    return Math.round((a + b) / 2);
  }
  return a != null && a > 0 ? a : b != null && b > 0 ? b : null;
}

function mergePlayers(details: BattleDetailData[]): AlbionBattlePlayer[] {
  const byId = new Map<string, AlbionBattlePlayer>();

  for (const detail of details) {
    for (const player of detail.players) {
      const existing = byId.get(player.id);
      if (!existing) {
        byId.set(player.id, { ...player });
        continue;
      }
      byId.set(player.id, {
        ...existing,
        name: player.name || existing.name,
        kills: existing.kills + player.kills,
        deaths: existing.deaths + player.deaths,
        killFame: existing.killFame + player.killFame,
        guildId: player.guildId ?? existing.guildId,
        guildName: player.guildName ?? existing.guildName,
        allianceId: player.allianceId ?? existing.allianceId,
        allianceName: player.allianceName ?? existing.allianceName,
        weaponType: player.weaponType ?? existing.weaponType,
        weaponQuality: player.weaponQuality ?? existing.weaponQuality,
        averageIp: mergeNumericIp(existing.averageIp, player.averageIp),
      });
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
}

function mergeGuilds(details: BattleDetailData[]): AlbionBattleGuildStats[] {
  const byId = new Map<string, AlbionBattleGuildStats>();

  for (const detail of details) {
    for (const guild of detail.guilds) {
      const existing = byId.get(guild.id);
      if (!existing) {
        byId.set(guild.id, { ...guild, players: undefined, averageIp: null });
        continue;
      }
      byId.set(guild.id, {
        ...existing,
        name: guild.name || existing.name,
        kills: existing.kills + guild.kills,
        deaths: existing.deaths + guild.deaths,
        killFame: existing.killFame + guild.killFame,
        alliance: guild.alliance ?? existing.alliance,
        allianceId: guild.allianceId ?? existing.allianceId,
      });
    }
  }

  return Array.from(byId.values());
}

function mergeAlliances(
  details: BattleDetailData[]
): AlbionBattleAllianceStats[] {
  const byId = new Map<string, AlbionBattleAllianceStats>();

  for (const detail of details) {
    for (const alliance of detail.alliances) {
      const existing = byId.get(alliance.id);
      if (!existing) {
        byId.set(alliance.id, {
          ...alliance,
          players: undefined,
          averageIp: null,
        });
        continue;
      }
      byId.set(alliance.id, {
        ...existing,
        name: alliance.name || existing.name,
        kills: existing.kills + alliance.kills,
        deaths: existing.deaths + alliance.deaths,
        killFame: existing.killFame + alliance.killFame,
      });
    }
  }

  return Array.from(byId.values());
}

function pickEarliestIso(values: (string | undefined | null)[]): string | undefined {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms < earliestMs) {
      earliestMs = ms;
      earliest = value;
    }
  }
  return earliest;
}

function pickLatestIso(values: (string | undefined | null)[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = value;
    }
  }
  return latest;
}

export function mergeBattleDetails(
  details: BattleDetailData[]
): BattleDetailData | null {
  if (details.length === 0) return null;

  const players = mergePlayers(details);
  const guilds = enrichBattleGuilds(mergeGuilds(details), players).sort(
    (a, b) => b.killFame - a.killFame || b.kills - a.kills
  );
  const alliances = enrichBattleAlliances(
    mergeAlliances(details),
    players
  ).sort((a, b) => b.killFame - a.killFame || b.kills - a.kills);

  const totalFame = details.reduce(
    (sum, d) => sum + (d.battle.totalFame ?? 0),
    0
  );
  const totalKills = details.reduce(
    (sum, d) => sum + (d.battle.totalKills ?? 0),
    0
  );

  const battle: AlbionBattle = {
    id: details[0]?.battle.id,
    startTime: pickEarliestIso(details.map((d) => d.battle.startTime)),
    endTime: pickLatestIso(details.map((d) => d.battle.endTime)),
    totalFame,
    totalKills,
    totalPlayers: players.length,
    players: Object.fromEntries(players.map((p) => [p.id, p])),
    guilds: Object.fromEntries(guilds.map((g) => [g.id, g])),
    alliances: Object.fromEntries(alliances.map((a) => [a.id, a])),
  };

  return { battle, players, guilds, alliances };
}
