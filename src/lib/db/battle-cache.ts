import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { unwrapGuildBattleListCache } from "../albion/battles";
import type {
  AlbionBattle,
  AlbionBattleAllianceStats,
  AlbionBattleGuildStats,
  AlbionBattlePlayer,
  AlbionEvent,
  AlbionRegion,
} from "../albion/types";
import { RETAIN_FULL_DAYS } from "./retention";
import { battleMeetsRecentIngestThreshold } from "../battles-constants";
import { toBigInt } from "../utils";
import { db, schema } from "./index";

/** Clear heavy battle JSON older than this many days (stub columns kept). */
export const BATTLE_DETAIL_EVICT_AFTER_DAYS = RETAIN_FULL_DAYS;
const EVICT_BATCH_SIZE = 200;

function topFameBattleKey(region: AlbionRegion, albionBattleId: number): string {
  return `${region}:${albionBattleId}`;
}

/** Battles listed on a guild/alliance top-fame board must not be evicted. */
export async function loadTopFameProtectedBattleKeysForEviction(): Promise<
  Set<string>
> {
  const protectedKeys = new Set<string>();

  const [guildRows, allianceRows] = await Promise.all([
    db
      .select({
        region: schema.guilds.region,
        topBattlesPayload: schema.guilds.topBattlesPayload,
      })
      .from(schema.guilds)
      .where(isNotNull(schema.guilds.topBattlesPayload)),
    db
      .select({
        region: schema.alliances.region,
        topBattlesPayload: schema.alliances.topBattlesPayload,
      })
      .from(schema.alliances)
      .where(isNotNull(schema.alliances.topBattlesPayload)),
  ]);

  for (const row of [...guildRows, ...allianceRows]) {
    const battles = unwrapGuildBattleListCache(row.topBattlesPayload);
    if (!battles) continue;
    for (const battle of battles) {
      const id = battle?.id;
      if (typeof id === "number" && Number.isFinite(id) && id > 0) {
        protectedKeys.add(topFameBattleKey(row.region, id));
      }
    }
  }

  return protectedKeys;
}

export interface CachedBattleDetail {
  battle: AlbionBattle;
  alliances: AlbionBattleAllianceStats[];
  guilds: AlbionBattleGuildStats[];
  players: AlbionBattlePlayer[];
}

interface BattleDetailPayload {
  alliances: AlbionBattleAllianceStats[];
  guilds: AlbionBattleGuildStats[];
  players: AlbionBattlePlayer[];
}

export async function getBattleByAlbionId(
  region: AlbionRegion,
  albionBattleId: number
) {
  return db.query.battles.findFirst({
    where: and(
      eq(schema.battles.albionBattleId, albionBattleId),
      eq(schema.battles.region, region)
    ),
  });
}

export async function getCachedBattle(
  region: AlbionRegion,
  albionBattleId: number
): Promise<AlbionBattle | null> {
  const row = await getBattleByAlbionId(region, albionBattleId);
  if (!row) return null;

  if (row.rawPayload && typeof row.rawPayload === "object") {
    return row.rawPayload as AlbionBattle;
  }

  // Stub after detail eviction (or list-only ingest) — summary fields only.
  if (
    row.totalFame != null ||
    row.totalKills != null ||
    row.totalPlayers != null ||
    row.startTime != null
  ) {
    return {
      id: row.albionBattleId,
      startTime: row.startTime?.toISOString() ?? undefined,
      endTime: row.endTime?.toISOString() ?? undefined,
      totalFame: row.totalFame ?? undefined,
      totalKills: row.totalKills ?? undefined,
      totalPlayers: row.totalPlayers ?? undefined,
    };
  }

  return null;
}

export async function getCachedBattleDetail(
  region: AlbionRegion,
  albionBattleId: number
): Promise<CachedBattleDetail | null> {
  const row = await getBattleByAlbionId(region, albionBattleId);
  if (!row?.detailSyncedAt || !row.detailPayload || !row.rawPayload) return null;

  const detail = row.detailPayload as BattleDetailPayload;
  if (
    !Array.isArray(detail.alliances) ||
    !Array.isArray(detail.guilds) ||
    !Array.isArray(detail.players)
  ) {
    return null;
  }

  return {
    battle: row.rawPayload as AlbionBattle,
    alliances: detail.alliances,
    guilds: detail.guilds,
    players: detail.players,
  };
}

export async function cacheBattleDetail(
  region: AlbionRegion,
  albionBattleId: number,
  data: {
    battle: AlbionBattle;
    events: AlbionEvent[];
    alliances: AlbionBattleAllianceStats[];
    guilds: AlbionBattleGuildStats[];
    players: AlbionBattlePlayer[];
  }
): Promise<void> {
  const now = new Date();
  const startTime = data.battle.startTime ? new Date(data.battle.startTime) : null;
  const endTime = data.battle.endTime ? new Date(data.battle.endTime) : null;
  const totalPlayers =
    data.battle.totalPlayers ??
    (data.battle.players ? Object.keys(data.battle.players).length : null);

  const rowData = {
    startTime,
    endTime,
    totalFame: toBigInt(data.battle.totalFame) ?? undefined,
    totalKills: data.battle.totalKills,
    totalPlayers,
    rawPayload: data.battle as unknown as Record<string, unknown>,
    eventsPayload: data.events as unknown as Record<string, unknown>[],
    detailPayload: {
      alliances: data.alliances,
      guilds: data.guilds,
      players: data.players,
    } satisfies BattleDetailPayload as unknown as Record<string, unknown>,
    detailSyncedAt: now,
    detailEvictedAt: null,
    lastSyncedAt: now,
    detailSyncUnavailable: 0,
    detailSyncGiveUpAt: null,
    detailSyncLastError: null,
  };

  const existing = await getBattleByAlbionId(region, albionBattleId);

  if (existing) {
    await db
      .update(schema.battles)
      .set(rowData)
      .where(eq(schema.battles.id, existing.id));
    return;
  }

  await db.insert(schema.battles).values({
    albionBattleId,
    region,
    ...rowData,
  });
}

/** Minimum Albion battle board size to justify a sync-battle job. */
export const BATTLE_DETAIL_SYNC_MIN_PLAYERS = 3;
export const BATTLE_DETAIL_SYNC_MIN_KILLS = 3;

/**
 * True when Albion list stats show a real battle board worth syncing.
 * Kill-event participant counts must not be used — only `/battles/{id}` stats.
 */
export function battleMeetsDetailSyncThreshold(stats: {
  totalPlayers?: number | null;
  totalKills?: number | null;
}): boolean {
  const players = stats.totalPlayers;
  const kills = stats.totalKills;
  return (
    (players != null && players >= BATTLE_DETAIL_SYNC_MIN_PLAYERS) ||
    (kills != null && kills >= BATTLE_DETAIL_SYNC_MIN_KILLS)
  );
}

export const BATTLE_BELOW_SYNC_THRESHOLD_ERROR =
  "Battle below sync threshold (need ≥3 players or ≥3 kills from Albion API)";

export async function isBattleDetailSyncUnavailable(
  region: AlbionRegion,
  albionBattleId: number
): Promise<boolean> {
  const row = await getBattleByAlbionId(region, albionBattleId);
  return (row?.detailSyncUnavailable ?? 0) === 1;
}

export async function markBattleDetailUnavailable(
  region: AlbionRegion,
  albionBattleId: number,
  error: string
): Promise<void> {
  const now = new Date();
  const existing = await getBattleByAlbionId(region, albionBattleId);

  if (existing) {
    await db
      .update(schema.battles)
      .set({
        detailSyncUnavailable: 1,
        detailSyncGiveUpAt: now,
        detailSyncLastError: error,
        lastSyncedAt: now,
      })
      .where(eq(schema.battles.id, existing.id));
    return;
  }

  await db.insert(schema.battles).values({
    albionBattleId,
    region,
    detailSyncUnavailable: 1,
    detailSyncGiveUpAt: now,
    detailSyncLastError: error,
    lastSyncedAt: now,
  });
}

export async function clearBattleDetailUnavailable(
  region: AlbionRegion,
  albionBattleId: number
): Promise<void> {
  const existing = await getBattleByAlbionId(region, albionBattleId);
  if (!existing) return;

  await db
    .update(schema.battles)
    .set({
      detailSyncUnavailable: 0,
      detailSyncGiveUpAt: null,
      detailSyncLastError: null,
    })
    .where(eq(schema.battles.id, existing.id));
}

/**
 * Upsert list-board stats from Albion `/battles` (recent poll).
 * Stores raw list payload for feed previews when full detail is not cached yet.
 * Never overwrites an existing detailPayload / detailSyncedAt.
 * New rows are skipped below RECENT_BATTLES_MIN_PLAYERS; existing rows still update.
 */
export async function upsertBattleFromRecentList(
  region: AlbionRegion,
  battle: AlbionBattle
): Promise<number | null> {
  const albionBattleId = battle.id ?? battle.albionId;
  if (albionBattleId == null) return null;

  const now = new Date();
  const startTime = battle.startTime ? new Date(battle.startTime) : null;
  const endTime = battle.endTime ? new Date(battle.endTime) : null;
  const totalPlayers =
    battle.totalPlayers ??
    (battle.players ? Object.keys(battle.players).length : null);
  const totalFame = toBigInt(battle.totalFame) ?? undefined;
  const listPayload = battle as unknown as Record<string, unknown>;

  const existing = await getBattleByAlbionId(region, albionBattleId);

  if (
    !existing &&
    !battleMeetsRecentIngestThreshold(totalPlayers ?? 0)
  ) {
    return null;
  }

  if (existing) {
    const hasDetail = existing.detailPayload != null;
    await db
      .update(schema.battles)
      .set({
        startTime: startTime ?? existing.startTime,
        endTime: endTime ?? existing.endTime,
        totalFame: totalFame ?? existing.totalFame ?? undefined,
        totalKills: battle.totalKills ?? existing.totalKills,
        totalPlayers: totalPlayers ?? existing.totalPlayers,
        ...(hasDetail ? {} : { rawPayload: listPayload }),
        lastSyncedAt: now,
      })
      .where(eq(schema.battles.id, existing.id));
    return albionBattleId;
  }

  await db.insert(schema.battles).values({
    albionBattleId,
    region,
    startTime,
    endTime,
    totalFame,
    totalKills: battle.totalKills,
    totalPlayers,
    rawPayload: listPayload,
    lastSyncedAt: now,
  });

  return albionBattleId;
}

/**
 * Null out heavy battle JSON for ended battles older than `olderThanDays`.
 * Keeps stub columns (ids, times, totals) so visits can rehydrate via sync-battle.
 */
export async function evictStaleBattleDetails(options?: {
  olderThanDays?: number;
  limit?: number;
  dryRun?: boolean;
  /** Preloaded protection set (omit to load from guild/alliance top-fame lists). */
  protectedKeys?: Set<string>;
}): Promise<{
  candidates: number;
  skippedProtected: number;
  evicted: number;
}> {
  const olderThanDays = options?.olderThanDays ?? BATTLE_DETAIL_EVICT_AFTER_DAYS;
  const limit = options?.limit ?? 2_000;
  const dryRun = options?.dryRun === true;
  const protectedKeys =
    options?.protectedKeys ??
    (await loadTopFameProtectedBattleKeysForEviction());
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const hasHeavyJson = or(
    isNotNull(schema.battles.detailPayload),
    isNotNull(schema.battles.eventsPayload),
    isNotNull(schema.battles.rawPayload)
  );

  // Prefer end_time; fall back to start_time when end is missing.
  const isOldEnough = or(
    and(isNotNull(schema.battles.endTime), lt(schema.battles.endTime, cutoff)),
    and(
      isNull(schema.battles.endTime),
      isNotNull(schema.battles.startTime),
      lt(schema.battles.startTime, cutoff)
    )
  );

  const rows = await db
    .select({
      id: schema.battles.id,
      region: schema.battles.region,
      albionBattleId: schema.battles.albionBattleId,
    })
    .from(schema.battles)
    .where(and(hasHeavyJson, isOldEnough))
    .limit(limit);

  if (rows.length === 0) {
    return { candidates: 0, skippedProtected: 0, evicted: 0 };
  }

  const toEvict: string[] = [];
  let skippedProtected = 0;
  for (const row of rows) {
    const key = topFameBattleKey(row.region, row.albionBattleId);
    if (protectedKeys.has(key)) {
      skippedProtected += 1;
      continue;
    }
    toEvict.push(row.id);
  }

  if (toEvict.length === 0) {
    return { candidates: rows.length, skippedProtected, evicted: 0 };
  }

  if (dryRun) {
    return {
      candidates: rows.length,
      skippedProtected,
      evicted: 0,
    };
  }

  let evicted = 0;
  for (let i = 0; i < toEvict.length; i += EVICT_BATCH_SIZE) {
    const chunk = toEvict.slice(i, i + EVICT_BATCH_SIZE);
    await db
      .update(schema.battles)
      .set({
        detailPayload: null,
        eventsPayload: null,
        rawPayload: null,
        detailSyncedAt: null,
        detailEvictedAt: now,
        // Allow a future visit to retry Albion after cold storage.
        detailSyncUnavailable: 0,
        detailSyncGiveUpAt: null,
        detailSyncLastError: null,
      })
      .where(inArray(schema.battles.id, chunk));
    evicted += chunk.length;
  }

  return { candidates: rows.length, skippedProtected, evicted };
}

/** True when this battle stub had detail cleared for storage. */
export async function isBattleDetailEvicted(
  region: AlbionRegion,
  albionBattleId: number
): Promise<boolean> {
  const row = await getBattleByAlbionId(region, albionBattleId);
  return row?.detailEvictedAt != null;
}
