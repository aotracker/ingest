import { and, eq, inArray } from "drizzle-orm";
import { classifyContentType, extractEventCounts } from "@aotracker/core/albion/classify";
import { getAlbionClient } from "@aotracker/core/albion/client";
import { isHttpNotFoundError } from "@aotracker/core/albion/errors";
import { normalizeAllianceInfo } from "@aotracker/core/albion/alliance-info";
import {
  getAllianceBattlesBySort,
  getGuildBattlesBySort,
  guildBattleListNeedsRefresh,
  isGuildBattleCacheComplete,
  wrapGuildBattleListCache,
} from "@aotracker/core/albion/battles";
import { fetchPlayerHistoryFromApi } from "@aotracker/core/albion/player-history-api";
import type {
  AlbionEvent,
  AlbionAllianceInfo,
  AlbionGuildInfo,
  AlbionPlayerRef,
  AlbionRegion,
  AlbionEquipment,
  AlbionItem,
  EquipmentSlot,
} from "@aotracker/core/albion/types";
import {
  EQUIPMENT_SLOTS,
  ENABLED_REGIONS,
  isRegionEnabled,
} from "@aotracker/core/albion/types";
import {
  battleMeetsRecentIngestThreshold,
  RECENT_BATTLES_MIN_FAME,
  RECENT_BATTLES_POLL_LIMIT,
} from "@aotracker/core/battles-constants";
import { recordGuildHourActivity } from "@aotracker/core/db/guild-hour-stats";
import { db, schema } from "@aotracker/core/db";
import { formatPgError, withTxRetry } from "@aotracker/core/db/pg-errors";
import {
  battleMeetsDetailSyncThreshold,
  BATTLE_BELOW_SYNC_THRESHOLD_ERROR,
  isBattleDetailSyncUnavailable,
  markBattleDetailUnavailable,
  upsertBattleFromRecentList,
} from "@aotracker/core/db/battle-cache";
import { isKillEventCached } from "@aotracker/core/db/kill-cache";
import {
  cacheAllianceBattleLists,
  getAllianceFameFromMemberGuilds,
  incrementEventsIngested,
} from "@aotracker/core/db/queries-ingest";
import {
  HISTORY_SYNC_STALE_MS,
  shouldUpdateEntity,
  isSyncStale,
  profileFieldsChanged,
} from "@aotracker/core/db/sync";
import { isWithinRetainFullWindow } from "@aotracker/core/db/retention";
import {
  CircuitOpenError,
  isCircuitOpenError,
} from "@aotracker/core/db/api-state";
import { toBigInt } from "@aotracker/core/utils";
import { ensureBattleDetailQueued } from "./jobs/enqueue";
import { sortEventsOldestFirst } from "./discord/order";

const DEFAULT_EVENT_BATCH_CONCURRENCY = 3;

export type IngestEntityCache = {
  guilds: Map<string, Promise<string | null>>;
  players: Map<string, Promise<string | null>>;
};

export function createIngestEntityCache(): IngestEntityCache {
  return {
    guilds: new Map(),
    players: new Map(),
  };
}

function entityCacheKey(region: AlbionRegion, albionId: string): string {
  return `${region}:${albionId}`;
}

function memoizeEntity(
  cache: Map<string, Promise<string | null>> | undefined,
  key: string,
  load: () => Promise<string | null>
): Promise<string | null> {
  if (!cache) return load();
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

type ExistingKillEventRow = {
  id: string;
  detailSyncedAt: Date | null;
  detailEvictedAt: Date | null;
};

async function loadExistingKillEvents(
  region: AlbionRegion,
  eventIds: number[]
): Promise<Map<number, ExistingKillEventRow>> {
  const uniqueIds = [...new Set(eventIds.filter((id) => Number.isFinite(id)))];
  const found = new Map<number, ExistingKillEventRow>();
  if (uniqueIds.length === 0) return found;

  const rows = await db
    .select({
      eventId: schema.killEvents.eventId,
      id: schema.killEvents.id,
      detailSyncedAt: schema.killEvents.detailSyncedAt,
      detailEvictedAt: schema.killEvents.detailEvictedAt,
    })
    .from(schema.killEvents)
    .where(
      and(
        eq(schema.killEvents.region, region),
        inArray(schema.killEvents.eventId, uniqueIds)
      )
    );

  for (const row of rows) {
    found.set(row.eventId, {
      id: row.id,
      detailSyncedAt: row.detailSyncedAt,
      detailEvictedAt: row.detailEvictedAt,
    });
  }
  return found;
}

type GuildRef = {
  GuildId?: string;
  GuildName?: string;
  AllianceId?: string;
  AllianceName?: string;
  AllianceTag?: string;
};

function nonempty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** True for `/guilds/{id}` payloads. Search hits only have id/name/alliance. */
function isCompleteGuildInfo(info: AlbionGuildInfo): boolean {
  return (
    info.MemberCount != null ||
    Boolean(nonempty(info.FounderId)) ||
    Boolean(nonempty(info.Founded))
  );
}

export async function upsertGuild(
  region: AlbionRegion,
  ref: GuildRef,
  cache?: IngestEntityCache
) {
  if (!ref.GuildId || !ref.GuildName) return null;

  return memoizeEntity(cache?.guilds, entityCacheKey(region, ref.GuildId), () =>
    upsertGuildRow(region, ref as GuildRef & { GuildId: string; GuildName: string })
  );
}

async function upsertGuildRow(
  region: AlbionRegion,
  ref: GuildRef & { GuildId: string; GuildName: string }
) {
  const existing = await db.query.guilds.findFirst({
    where: and(
      eq(schema.guilds.albionId, ref.GuildId),
      eq(schema.guilds.region, region)
    ),
    columns: {
      id: true,
      name: true,
      allianceId: true,
      allianceName: true,
      allianceTag: true,
    },
  });

  if (existing) {
    const incoming = {
      name: ref.GuildName,
      allianceId: nonempty(ref.AllianceId) ?? existing.allianceId,
      allianceName: nonempty(ref.AllianceName) ?? existing.allianceName,
      allianceTag: nonempty(ref.AllianceTag) ?? existing.allianceTag,
    };
    if (
      !profileFieldsChanged(
        {
          name: existing.name,
          allianceId: existing.allianceId,
          allianceName: existing.allianceName,
          allianceTag: existing.allianceTag,
        },
        incoming,
        ["name", "allianceId", "allianceName", "allianceTag"]
      )
    ) {
      return existing.id;
    }

    await db
      .update(schema.guilds)
      .set({
        ...incoming,
        updatedAt: new Date(),
      })
      .where(eq(schema.guilds.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(schema.guilds)
    .values({
      albionId: ref.GuildId,
      region,
      name: ref.GuildName,
      allianceId: nonempty(ref.AllianceId),
      allianceName: nonempty(ref.AllianceName),
      allianceTag: nonempty(ref.AllianceTag),
    })
    .returning({ id: schema.guilds.id });

  return inserted.id;
}

export async function upsertGuildFromInfo(
  region: AlbionRegion,
  info: AlbionGuildInfo
): Promise<string | null> {
  if (!info.Id || !info.Name) return null;

  // Search / live-search hits are not full profiles. Writing them through this
  // path stamps lastSyncedAt and skips the real `/guilds/{id}` fetch.
  if (!isCompleteGuildInfo(info)) {
    return upsertGuild(region, {
      GuildId: info.Id,
      GuildName: info.Name,
      AllianceId: info.AllianceId,
      AllianceName: info.AllianceName,
      AllianceTag: info.AllianceTag,
    });
  }

  const existing = await db.query.guilds.findFirst({
    where: and(
      eq(schema.guilds.albionId, info.Id),
      eq(schema.guilds.region, region)
    ),
  });

  const now = new Date();
  const incomingScalars = {
    name: info.Name,
    allianceId: nonempty(info.AllianceId),
    allianceName: nonempty(info.AllianceName),
    allianceTag: nonempty(info.AllianceTag),
    killFame: toBigInt(info.KillFame ?? info.killFame) ?? 0,
    deathFame: toBigInt(info.DeathFame) ?? 0,
    memberCount: info.MemberCount ?? null,
  };

  const { changed } = shouldUpdateEntity(
    existing,
    info,
    existing
      ? {
          name: existing.name,
          allianceId: existing.allianceId,
          allianceName: existing.allianceName,
          allianceTag: existing.allianceTag,
          killFame: existing.killFame,
          deathFame: existing.deathFame,
          memberCount: existing.memberCount,
        }
      : {},
    incomingScalars,
    ["name", "allianceId", "allianceName", "allianceTag", "killFame", "deathFame", "memberCount"]
  );

  if (existing && !changed) {
    await db
      .update(schema.guilds)
      .set({ lastSyncedAt: now, lastCheckedAt: now, updatedAt: now })
      .where(eq(schema.guilds.id, existing.id));
    return existing.id;
  }

  const guildData = {
    ...incomingScalars,
    rawPayload: info as unknown as Record<string, unknown>,
    lastSyncedAt: now,
    lastCheckedAt: now,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(schema.guilds)
      .set(guildData)
      .where(eq(schema.guilds.id, existing.id));

    return existing.id;
  }

  const [inserted] = await db
    .insert(schema.guilds)
    .values({
      albionId: info.Id,
      region,
      ...guildData,
    })
    .returning({ id: schema.guilds.id });

  return inserted.id;
}

export async function upsertAllianceFromInfo(
  region: AlbionRegion,
  raw: AlbionAllianceInfo
): Promise<string | null> {
  const info = normalizeAllianceInfo(raw);
  if (!info) return null;

  const existing = await db.query.alliances.findFirst({
    where: and(
      eq(schema.alliances.albionId, info.id),
      eq(schema.alliances.region, region)
    ),
  });

  const now = new Date();
  const incomingScalars = {
    name: info.name,
    tag: info.tag,
    memberCount: info.memberCount,
    founderId: info.founderId,
    founderName: info.founderName,
    founded: info.founded,
    guildsJson: info.guilds ?? null,
  };

  const { changed } = shouldUpdateEntity(
    existing,
    raw,
    existing
      ? {
          name: existing.name,
          tag: existing.tag,
          memberCount: existing.memberCount,
          founderId: existing.founderId,
          founderName: existing.founderName,
          founded: existing.founded,
          guildsJson: existing.guildsJson,
        }
      : {},
    incomingScalars,
    ["name", "tag", "memberCount", "founderId", "founderName", "founded", "guildsJson"]
  );

  if (existing && !changed) {
    await db
      .update(schema.alliances)
      .set({ lastCheckedAt: now, updatedAt: now })
      .where(eq(schema.alliances.id, existing.id));
    return existing.id;
  }

  const allianceData = {
    ...incomingScalars,
    rawPayload: raw as unknown as Record<string, unknown>,
    lastSyncedAt: now,
    lastCheckedAt: now,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(schema.alliances)
      .set(allianceData)
      .where(eq(schema.alliances.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(schema.alliances)
    .values({
      albionId: info.id,
      region,
      ...allianceData,
    })
    .returning({ id: schema.alliances.id });

  return inserted.id;
}

export async function upsertPlayer(
  region: AlbionRegion,
  ref: AlbionPlayerRef,
  cache?: IngestEntityCache
): Promise<string | null> {
  if (!ref.Id || !ref.Name) return null;

  return memoizeEntity(cache?.players, entityCacheKey(region, ref.Id), () =>
    upsertPlayerRow(
      region,
      ref as AlbionPlayerRef & { Id: string; Name: string },
      cache
    )
  );
}

async function upsertPlayerRow(
  region: AlbionRegion,
  ref: AlbionPlayerRef & { Id: string; Name: string },
  cache?: IngestEntityCache
): Promise<string | null> {
  let guildId: string | null = null;
  if (ref.GuildId && ref.GuildName) {
    guildId = await upsertGuild(region, ref, cache);
  }

  const existing = await db.query.players.findFirst({
    where: and(
      eq(schema.players.albionId, ref.Id),
      eq(schema.players.region, region)
    ),
    columns: {
      id: true,
      name: true,
      guildId: true,
      allianceId: true,
      allianceName: true,
      avatar: true,
      avatarRing: true,
    },
  });

  // Event participant refs may include KillFame/DeathFame, but those are per-event
  // values (e.g. victim gear fame), not lifetime totals. Only refreshPlayerProfile
  // should write kill_fame/death_fame on the players table.
  const playerData = {
    name: ref.Name,
    guildId,
    allianceId: ref.AllianceId ?? null,
    allianceName: ref.AllianceName ?? null,
    avatar: ref.Avatar ?? null,
    avatarRing: ref.AvatarRing ?? null,
  };

  if (existing) {
    if (
      !profileFieldsChanged(
        {
          name: existing.name,
          guildId: existing.guildId,
          allianceId: existing.allianceId,
          allianceName: existing.allianceName,
          avatar: existing.avatar,
          avatarRing: existing.avatarRing,
        },
        playerData,
        ["name", "guildId", "allianceId", "allianceName", "avatar", "avatarRing"]
      )
    ) {
      return existing.id;
    }

    await db
      .update(schema.players)
      .set({ ...playerData, updatedAt: new Date() })
      .where(eq(schema.players.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(schema.players)
    .values({
      albionId: ref.Id,
      region,
      ...playerData,
      killFame: 0,
      deathFame: 0,
    })
    .onConflictDoNothing({
      target: [schema.players.albionId, schema.players.region],
    })
    .returning({ id: schema.players.id });

  if (inserted) return inserted.id;

  const raced = await db.query.players.findFirst({
    where: and(
      eq(schema.players.albionId, ref.Id),
      eq(schema.players.region, region)
    ),
  });
  return raced?.id ?? null;
}

async function queueBattleDetailSync(
  region: AlbionRegion,
  albionBattleId: number
): Promise<void> {
  try {
    if (await isBattleDetailSyncUnavailable(region, albionBattleId)) return;

    await ensureBattleDetailQueued(region, albionBattleId);
  } catch (err) {
    console.error(
      `[ingest] Failed to queue battle detail sync for ${region}/${albionBattleId}:`,
      err
    );
  }
}

async function findBattleUuid(
  region: AlbionRegion,
  albionBattleId: number
): Promise<string | null> {
  const existing = await db.query.battles.findFirst({
    where: and(
      eq(schema.battles.albionBattleId, albionBattleId),
      eq(schema.battles.region, region)
    ),
    columns: { id: true },
  });
  return existing?.id ?? null;
}

/**
 * Upsert a battle row confirmed via Albion `/battles/{id}`.
 * New rows below RECENT_BATTLES_MIN_PLAYERS are not inserted.
 * Only queues detail sync when `queueDetailSync` is true and the battle meets
 * the size threshold (≥3 players or ≥3 kills).
 */
async function upsertBattle(
  region: AlbionRegion,
  albionBattleId: number,
  battleData?: { totalPlayers?: number; totalKills?: number; totalFame?: number },
  options?: { queueDetailSync?: boolean }
): Promise<string | null> {
  const queueDetailSync = options?.queueDetailSync === true;
  const existing = await db.query.battles.findFirst({
    where: and(
      eq(schema.battles.albionBattleId, albionBattleId),
      eq(schema.battles.region, region)
    ),
    columns: {
      id: true,
      totalFame: true,
      totalKills: true,
      totalPlayers: true,
      detailPayload: true,
    },
  });

  if (
    !existing &&
    !battleMeetsRecentIngestThreshold(battleData?.totalPlayers ?? 0)
  ) {
    return null;
  }

  if (existing) {
    const mergedPlayers = existing.totalPlayers ?? battleData?.totalPlayers;
    const mergedKills = existing.totalKills ?? battleData?.totalKills;
    const eligible = battleMeetsDetailSyncThreshold({
      totalPlayers: mergedPlayers,
      totalKills: mergedKills,
    });

    const shouldBackfillStats =
      battleData != null &&
      (existing.totalFame == null ||
        existing.totalKills == null ||
        existing.totalPlayers == null) &&
      (battleData.totalFame != null ||
        battleData.totalKills != null ||
        battleData.totalPlayers != null);

    if (shouldBackfillStats) {
      await db
        .update(schema.battles)
        .set({
          totalPlayers: mergedPlayers,
          totalKills: mergedKills,
          totalFame:
            existing.totalFame ?? toBigInt(battleData.totalFame) ?? undefined,
          lastSyncedAt: new Date(),
          // Only clear give-up when this battle is large enough to sync.
          ...(eligible
            ? {
                detailSyncUnavailable: 0,
                detailSyncGiveUpAt: null,
                detailSyncLastError: null,
              }
            : {}),
        })
        .where(eq(schema.battles.id, existing.id));
    }

    const needsDetail =
      existing.totalFame == null || existing.detailPayload == null;
    if (queueDetailSync && needsDetail && eligible) {
      await queueBattleDetailSync(region, albionBattleId);
    }

    return existing.id;
  }

  const eligible = battleMeetsDetailSyncThreshold({
    totalPlayers: battleData?.totalPlayers,
    totalKills: battleData?.totalKills,
  });

  const [inserted] = await db
    .insert(schema.battles)
    .values({
      albionBattleId,
      region,
      totalPlayers: battleData?.totalPlayers,
      totalKills: battleData?.totalKills,
      totalFame: toBigInt(battleData?.totalFame) ?? undefined,
      lastSyncedAt: new Date(),
    })
    .returning({ id: schema.battles.id });

  if (queueDetailSync && eligible) {
    await queueBattleDetailSync(region, albionBattleId);
  }

  return inserted.id;
}

function extractItemsFromEquipment(
  equipment: AlbionEquipment | undefined,
  ownerRole: "killer" | "victim" | "group_member" | "participant"
) {
  const items: {
    ownerRole: typeof ownerRole;
    category: "equipment";
    slot: string;
    itemType: string;
    quality: number;
    count: number;
    spells: { active: string[]; passive: string[] };
  }[] = [];

  if (!equipment) return items;

  for (const slot of EQUIPMENT_SLOTS) {
    const item = equipment[slot as EquipmentSlot];
    if (item?.Type) {
      items.push({
        ownerRole,
        category: "equipment",
        slot,
        itemType: item.Type,
        quality: item.Quality ?? 0,
        count: item.Count ?? 1,
        spells: {
          active: item.ActiveSpells ?? [],
          passive: item.PassiveSpells ?? [],
        },
      });
    }
  }

  return items;
}

function extractInventoryItems(
  inventory: (AlbionItem | null)[] | undefined,
  ownerRole: "killer" | "victim" | "group_member" | "participant"
) {
  const items: {
    ownerRole: typeof ownerRole;
    category: "inventory";
    slot: string | null;
    itemType: string;
    quality: number;
    count: number;
    spells: { active: string[]; passive: string[] };
  }[] = [];

  if (!inventory) return items;

  inventory.forEach((item, index) => {
    if (item?.Type) {
      items.push({
        ownerRole,
        category: "inventory",
        slot: `slot_${index}`,
        itemType: item.Type,
        quality: item.Quality ?? 0,
        count: item.Count ?? 1,
        spells: {
          active: item.ActiveSpells ?? [],
          passive: item.PassiveSpells ?? [],
        },
      });
    }
  });

  return items;
}

type KillEventItemInsert = {
  ownerRole: "killer" | "victim" | "group_member" | "participant";
  category: "equipment" | "inventory";
  slot: string | null;
  itemType: string;
  quality: number;
  count: number;
  spells: { active: string[]; passive: string[] };
};

type KillEventParticipantInsert = {
  role: "killer" | "victim" | "group_member" | "participant";
  ref: AlbionPlayerRef;
};

function collectKillEventRelations(event: AlbionEvent): {
  allItems: KillEventItemInsert[];
  participantInserts: KillEventParticipantInsert[];
} {
  const allItems: KillEventItemInsert[] = [];
  const participantInserts: KillEventParticipantInsert[] = [];

  if (event.Killer) {
    allItems.push(
      ...extractItemsFromEquipment(event.Killer.Equipment, "killer"),
      ...extractInventoryItems(event.Killer.Inventory, "killer")
    );
    participantInserts.push({ role: "killer", ref: event.Killer });
  }
  if (event.Victim) {
    allItems.push(
      ...extractItemsFromEquipment(event.Victim.Equipment, "victim"),
      ...extractInventoryItems(event.Victim.Inventory, "victim")
    );
    participantInserts.push({ role: "victim", ref: event.Victim });
  }
  for (const member of event.GroupMembers ?? []) {
    participantInserts.push({ role: "group_member", ref: member });
    allItems.push(
      ...extractItemsFromEquipment(member.Equipment, "group_member"),
      ...extractInventoryItems(member.Inventory, "group_member")
    );
  }
  for (const participant of event.Participants ?? []) {
    participantInserts.push({ role: "participant", ref: participant });
    allItems.push(
      ...extractItemsFromEquipment(participant.Equipment, "participant"),
      ...extractInventoryItems(participant.Inventory, "participant")
    );
  }

  return { allItems, participantInserts };
}

type KillParticipantRow = {
  playerId: string | null;
  role: KillEventParticipantInsert["role"];
  name: string | null;
  guildName: string | null;
  averageItemPower: string | null;
  killFame: number | null;
  deathFame: number | null;
  supportHealingDone: number | null;
  rawPayload: AlbionPlayerRef;
};

async function resolveKillParticipantRows(
  region: AlbionRegion,
  participantInserts: KillEventParticipantInsert[],
  cache?: IngestEntityCache
): Promise<{
  rows: KillParticipantRow[];
  killerId: string | null;
  victimId: string | null;
}> {
  const rows: KillParticipantRow[] = [];
  let killerId: string | null = null;
  let victimId: string | null = null;

  for (const { role, ref } of participantInserts) {
    const playerId = ref.Id ? await upsertPlayer(region, ref, cache) : null;
    if (role === "killer") killerId = playerId;
    if (role === "victim") victimId = playerId;
    rows.push({
      playerId,
      role,
      name: ref.Name ?? null,
      guildName: ref.GuildName ?? null,
      averageItemPower: ref.AverageItemPower?.toString() ?? null,
      killFame: toBigInt(ref.KillFame),
      deathFame: toBigInt(ref.DeathFame),
      supportHealingDone: toBigInt(ref.SupportHealingDone),
      rawPayload: ref,
    });
  }

  return { rows, killerId, victimId };
}

async function insertKillEventChildren(
  tx: Pick<typeof db, "insert">,
  killEventUuid: string,
  participantRows: KillParticipantRow[],
  allItems: KillEventItemInsert[]
) {
  if (participantRows.length > 0) {
    await tx.insert(schema.killParticipants).values(
      participantRows.map((row) => ({
        eventId: killEventUuid,
        playerId: row.playerId,
        role: row.role,
        name: row.name,
        guildName: row.guildName,
        averageItemPower: row.averageItemPower,
        killFame: row.killFame,
        deathFame: row.deathFame,
        supportHealingDone: row.supportHealingDone,
        rawPayload: row.rawPayload,
      }))
    );
  }

  if (allItems.length > 0) {
    await tx.insert(schema.killItems).values(
      allItems.map((item) => ({
        eventId: killEventUuid,
        ownerRole: item.ownerRole,
        category: item.category,
        slot: item.slot,
        itemType: item.itemType,
        quality: item.quality,
        count: item.count,
        spells: item.spells,
      }))
    );
  }
}

/** Lightweight battle stats used for ZvZ classification during ingest. */
export type IngestBattleStats = {
  totalPlayers?: number;
  totalKills?: number;
  totalFame?: number;
} | null;

/**
 * Resolve battle stats for ingest, reusing an in-batch cache and DB rows before
 * calling the Albion API (avoids N identical /battles/{id} fetches per ZvZ).
 * On HTTP 404, marks the battle unavailable so we never soft-defer-loop it.
 */
async function resolveBattleStatsForIngest(
  region: AlbionRegion,
  battleId: number,
  cache?: Map<number, IngestBattleStats>
): Promise<IngestBattleStats> {
  if (cache?.has(battleId)) {
    return cache.get(battleId) ?? null;
  }

  const existing = await db.query.battles.findFirst({
    where: and(
      eq(schema.battles.albionBattleId, battleId),
      eq(schema.battles.region, region)
    ),
    columns: {
      totalPlayers: true,
      totalKills: true,
      totalFame: true,
      detailSyncUnavailable: true,
    },
  });

  if (existing?.detailSyncUnavailable === 1) {
    cache?.set(battleId, null);
    return null;
  }

  if (existing?.totalPlayers != null) {
    const stats: IngestBattleStats = {
      totalPlayers: existing.totalPlayers,
      totalKills: existing.totalKills ?? undefined,
      totalFame: existing.totalFame ?? undefined,
    };
    cache?.set(battleId, stats);
    return stats;
  }

  try {
    const client = getAlbionClient();
    const battle = await client.getBattle(region, battleId);
    const stats: IngestBattleStats = {
      totalPlayers: battle.totalPlayers,
      totalKills: battle.totalKills,
      totalFame: battle.totalFame,
    };
    cache?.set(battleId, stats);
    return stats;
  } catch (err) {
    cache?.set(battleId, null);
    if (isHttpNotFoundError(err)) {
      await markBattleDetailUnavailable(
        region,
        battleId,
        err instanceof Error ? err.message : "HTTP 404 from Albion battles API"
      ).catch(() => undefined);
    }
    return null;
  }
}

export async function upsertKillEventDetail(
  region: AlbionRegion,
  event: AlbionEvent,
  options?: {
    fetchBattleDetail?: boolean;
    battleDetailCache?: Map<number, IngestBattleStats>;
    entityCache?: IngestEntityCache;
    existingByEventId?: Map<number, ExistingKillEventRow>;
  }
): Promise<boolean> {
  const existing = options?.existingByEventId
    ? (options.existingByEventId.get(event.EventId) ?? null)
    : await db.query.killEvents.findFirst({
        where: and(
          eq(schema.killEvents.eventId, event.EventId),
          eq(schema.killEvents.region, region)
        ),
        columns: { id: true, detailSyncedAt: true, detailEvictedAt: true },
      });

  if (existing?.detailEvictedAt) return false;
  if (existing?.detailSyncedAt) return false;

  const occurredAt = new Date(event.TimeStamp);
  if (
    !Number.isNaN(occurredAt.getTime()) &&
    !isWithinRetainFullWindow(occurredAt)
  ) {
    return false;
  }

  // History backfills skip battle fetches (rate limit) and never auto-queue
  // sync-battle — kill events only store albionBattleId; detail loads on visit
  // or when live ingest confirms `/battles/{id}` exists.
  const fetchBattleDetail = options?.fetchBattleDetail !== false;
  let battleDetail: IngestBattleStats = null;
  if (fetchBattleDetail && event.BattleId) {
    battleDetail = await resolveBattleStatsForIngest(
      region,
      event.BattleId,
      options?.battleDetailCache
    );
  }

  const counts = extractEventCounts(event);
  const contentType = classifyContentType({
    killer: event.Killer,
    victim: event.Victim,
    participantCount: counts.participantCount,
    groupMemberCount: counts.groupMemberCount,
    groupMembers: event.GroupMembers,
    participants: event.Participants,
    battleTotalPlayers: battleDetail?.totalPlayers,
  });

  const { allItems, participantInserts } = collectKillEventRelations(event);
  const { rows: participantRows, killerId, victimId } =
    await resolveKillParticipantRows(
      region,
      participantInserts,
      options?.entityCache
    );

  let battleUuid: string | null = null;
  if (event.BattleId) {
    if (battleDetail) {
      const eligible = battleMeetsDetailSyncThreshold(battleDetail);
      // Insert/link only at the ingest player floor; keep albionBattleId on the kill either way.
      battleUuid = await upsertBattle(
        region,
        event.BattleId,
        {
          totalPlayers: battleDetail.totalPlayers,
          totalKills: battleDetail.totalKills,
          totalFame: battleDetail.totalFame,
        },
        { queueDetailSync: eligible }
      );
      // Skip stubbing unavailable for battles we refused to insert (< ingest floor).
      if (!eligible && battleUuid) {
        await markBattleDetailUnavailable(
          region,
          event.BattleId,
          BATTLE_BELOW_SYNC_THRESHOLD_ERROR
        ).catch(() => undefined);
      }
    } else {
      // History, 404 ghost, or transient miss: keep albionBattleId on the kill;
      // link FK only if a battles row already exists. Do not stub+queue.
      battleUuid = await findBattleUuid(region, event.BattleId);
    }
  }

  const now = new Date();
  const eventRow = {
    occurredAt,
    contentType,
    battleId: battleUuid,
    albionBattleId: event.BattleId ?? null,
    killerId,
    victimId,
    totalVictimKillFame: toBigInt(event.TotalVictimKillFame),
    participantCount: counts.participantCount,
    groupMemberCount: counts.groupMemberCount,
    killerGuildAlbionId: event.Killer?.GuildId?.trim() || null,
    killerGuildName: event.Killer?.GuildName?.trim() || null,
    killerAllianceAlbionId: event.Killer?.AllianceId?.trim() || null,
    killerAllianceName: event.Killer?.AllianceName?.trim() || null,
    victimGuildAlbionId: event.Victim?.GuildId?.trim() || null,
    victimGuildName: event.Victim?.GuildName?.trim() || null,
    victimAllianceAlbionId: event.Victim?.AllianceId?.trim() || null,
    victimAllianceName: event.Victim?.AllianceName?.trim() || null,
    rawPayload: event,
    detailSyncedAt: now,
  };

  return withTxRetry(() =>
    db.transaction(async (tx) => {
      let killEventUuid: string;

      if (existing) {
        await tx
          .delete(schema.killParticipants)
          .where(eq(schema.killParticipants.eventId, existing.id));
        await tx
          .delete(schema.killItems)
          .where(eq(schema.killItems.eventId, existing.id));
        await tx
          .update(schema.killEvents)
          .set(eventRow)
          .where(eq(schema.killEvents.id, existing.id));
        killEventUuid = existing.id;
      } else {
        const [killEvent] = await tx
          .insert(schema.killEvents)
          .values({
            eventId: event.EventId,
            region,
            ...eventRow,
          })
          .onConflictDoNothing({
            target: [schema.killEvents.eventId, schema.killEvents.region],
          })
          .returning({ id: schema.killEvents.id });

        if (!killEvent) return false;
        killEventUuid = killEvent.id;
      }

      await insertKillEventChildren(tx, killEventUuid, participantRows, allItems);
      await recordGuildHourActivity(tx, {
        region,
        occurredAt: eventRow.occurredAt,
        contentType,
        totalVictimKillFame: eventRow.totalVictimKillFame ?? 0,
        participants: participantRows.map((row) => ({
          role: row.role,
          playerAlbionId: row.rawPayload.Id?.trim() || null,
          guildAlbionId: row.rawPayload.GuildId?.trim() || null,
          guildName:
            row.guildName?.trim() || row.rawPayload.GuildName?.trim() || null,
        })),
      });
      return true;
    })
  );
}

async function emitDiscordForEvent(
  region: AlbionRegion,
  event: AlbionEvent
): Promise<void> {
  try {
    const { emitKillIngested } = await import("./discord/dispatcher");
    await emitKillIngested(region, event);
  } catch (err) {
    console.warn(
      `[discord] emit failed for ${region}/${event.EventId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export async function ingestEvent(
  region: AlbionRegion,
  event: AlbionEvent,
  options?: {
    fetchBattleDetail?: boolean;
    battleDetailCache?: Map<number, IngestBattleStats>;
    entityCache?: IngestEntityCache;
    existingByEventId?: Map<number, ExistingKillEventRow>;
    notifyDiscord?: boolean;
  }
): Promise<boolean> {
  const isNew = await upsertKillEventDetail(region, event, options);
  if (isNew && options?.notifyDiscord) {
    await emitDiscordForEvent(region, event);
  }
  return isNew;
}

export type IngestRegionEventBatchOptions = {
  fetchBattleDetail?: boolean;
  notifyDiscord?: boolean;
  /** Also Discord-notify already-ingested events (catch-up retries unposted claims). */
  notifyExisting?: boolean;
  battleDetailCache?: Map<number, IngestBattleStats>;
  entityCache?: IngestEntityCache;
  concurrency?: number;
  logPrefix?: string;
};

export type IngestRegionEventBatchResult = {
  ingested: number;
  skipped: number;
  errors: number;
  lastError: string | null;
};

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, concurrency);
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
}

/** Shared live-poll / main-poll / history path: batch-load existing events, reuse caches. */
export async function ingestRegionEventBatch(
  region: AlbionRegion,
  events: AlbionEvent[],
  options?: IngestRegionEventBatchOptions
): Promise<IngestRegionEventBatchResult> {
  const battleDetailCache =
    options?.battleDetailCache ?? new Map<number, IngestBattleStats>();
  const entityCache = options?.entityCache ?? createIngestEntityCache();
  const existingByEventId = await loadExistingKillEvents(
    region,
    events.map((event) => event.EventId)
  );
  const concurrency = options?.concurrency ?? DEFAULT_EVENT_BATCH_CONCURRENCY;
  const logPrefix = options?.logPrefix ?? "ingest";
  const notifyDiscord = options?.notifyDiscord === true;
  const notifyExisting = options?.notifyExisting === true;
  const fetchBattleDetail = options?.fetchBattleDetail;
  const debug = process.env.INGEST_DEBUG === "1";

  let ingested = 0;
  let skipped = 0;
  let errors = 0;
  let lastError: string | null = null;
  const startedAt = Date.now();
  let done = 0;
  const total = events.length;
  const newlyIngested: AlbionEvent[] = [];
  const existingForNotify: AlbionEvent[] = [];

  if (debug) {
    console.log(`[${logPrefix}] ${region} events: processing ${total}`);
  }

  await mapPool(events, concurrency, async (event) => {
    if (existingByEventId.get(event.EventId)?.detailSyncedAt) {
      skipped += 1;
      if (notifyDiscord && notifyExisting) existingForNotify.push(event);
    } else {
      try {
        const isNew = await ingestEvent(region, event, {
          fetchBattleDetail,
          battleDetailCache,
          entityCache,
          existingByEventId,
          notifyDiscord: false,
        });
        if (isNew) {
          ingested += 1;
          if (notifyDiscord) newlyIngested.push(event);
        } else skipped += 1;
      } catch (err) {
        if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
          throw err;
        }
        errors += 1;
        lastError = formatPgError(err);
        console.error(
          `[${logPrefix}] Failed event ${event.EventId} in ${region}:`,
          lastError
        );
      }
    }

    done += 1;
    if (debug && (done === total || done % 10 === 0)) {
      console.log(
        `[${logPrefix}] ${region} events: ${done}/${total} ` +
          `(new=${ingested} skipped=${skipped} errors=${errors} ` +
          `${Math.round((Date.now() - startedAt) / 1000)}s)`
      );
    }
  });

  if (notifyDiscord) {
    const toNotify = sortEventsOldestFirst([
      ...newlyIngested,
      ...existingForNotify,
    ]);
    for (const event of toNotify) {
      await emitDiscordForEvent(region, event);
    }
  }

  return { ingested, skipped, errors, lastError };
}

export async function ingestPlayerHistoryEvents(
  region: AlbionRegion,
  events: AlbionEvent[]
): Promise<{ ingested: number; skipped: number; failed: number }> {
  const uniqueById = new Map<number, AlbionEvent>();
  for (const event of events) {
    if (event?.EventId) uniqueById.set(event.EventId, event);
  }

  const uniqueEvents = [...uniqueById.values()];
  const result = await ingestRegionEventBatch(region, uniqueEvents, {
    fetchBattleDetail: false,
    notifyDiscord: false,
  });

  return {
    ingested: result.ingested,
    skipped: result.skipped,
    failed: result.errors,
  };
}

export async function ensureKillEventInDb(
  region: AlbionRegion,
  eventId: number
): Promise<boolean> {
  if (!isRegionEnabled(region)) return false;
  if (await isKillEventCached(region, eventId)) return true;

  try {
    const client = getAlbionClient();
    const event = await client.getEvent(region, eventId);
    await upsertKillEventDetail(region, event);
    return true;
  } catch (err) {
    console.error(
      `[ingest] Failed to fetch event ${eventId} in ${region}:`,
      err
    );
    return false;
  }
}

export async function ingestRegionEvents(
  region: AlbionRegion,
  options?: { battleDetailCache?: Map<number, IngestBattleStats> }
): Promise<number> {
  if (!isRegionEnabled(region)) return 0;
  const client = getAlbionClient();

  let syncState = await db.query.apiSyncState.findFirst({
    where: eq(schema.apiSyncState.region, region),
  });

  if (!syncState) {
    const [created] = await db
      .insert(schema.apiSyncState)
      .values({ region })
      .returning();
    syncState = created;
  }

  try {
    const events = await client.getRecentEvents(region, 50, 0);
    const battleDetailCache =
      options?.battleDetailCache ?? new Map<number, IngestBattleStats>();
    const { ingested, errors: eventErrors, lastError: lastEventError } =
      await ingestRegionEventBatch(region, events, {
        battleDetailCache,
        notifyDiscord: true,
      });

    const maxEventId =
      events.length > 0
        ? events.reduce(
            (max, e) => Math.max(max, e.EventId),
            syncState.lastSeenEventId ?? 0
          )
        : syncState.lastSeenEventId ?? 0;

    const warningNote =
      region === "asia" && events.length === 0
        ? `[${region}] Asia events feed returned no data (404 or empty)`
        : eventErrors > 0
          ? `[${region}] ${eventErrors} event(s) failed to ingest${lastEventError ? `: ${lastEventError}` : ""}`
          : null;

    await db
      .update(schema.apiSyncState)
      .set({
        lastSeenEventId: maxEventId,
        lastSuccessAt: new Date(),
        lastIngestAt: new Date(),
        consecutiveFailures: 0,
        circuitOpen: 0,
        lastErrorMessage: warningNote,
        updatedAt: new Date(),
      })
      .where(eq(schema.apiSyncState.region, region));

    if (ingested > 0) {
      await incrementEventsIngested(region, ingested);
    }

    return ingested;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.apiSyncState)
      .set({
        lastErrorAt: new Date(),
        lastErrorMessage: message,
        consecutiveFailures: (syncState.consecutiveFailures ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.apiSyncState.region, region));
    throw err;
  }
}

export async function refreshPlayerProfile(
  region: AlbionRegion,
  albionId: string
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const client = getAlbionClient();
  const info = await client.getPlayerInfo(region, albionId);

  let guildId: string | null = null;
  if (info.GuildId && info.GuildName) {
    guildId = await upsertGuild(region, info);
  }

  const existing = await db.query.players.findFirst({
    where: and(
      eq(schema.players.albionId, albionId),
      eq(schema.players.region, region)
    ),
  });

  const now = new Date();
  const incomingScalars = {
    name: info.Name!,
    guildId,
    allianceId: info.AllianceId ?? null,
    allianceName: info.AllianceName ?? null,
    avatar: info.Avatar ?? null,
    avatarRing: info.AvatarRing ?? null,
    killFame: toBigInt(info.KillFame) ?? 0,
    deathFame: toBigInt(info.DeathFame) ?? 0,
    fameRatio: info.FameRatio?.toString() ?? null,
    lifetimeStats: info.LifetimeStatistics ?? null,
  };

  const { changed } = shouldUpdateEntity(
    existing ? { rawPayload: existing.lifetimeStats } : null,
    info.LifetimeStatistics ?? null,
    existing
      ? {
          name: existing.name,
          guildId: existing.guildId,
          allianceId: existing.allianceId,
          allianceName: existing.allianceName,
          avatar: existing.avatar,
          avatarRing: existing.avatarRing,
          killFame: existing.killFame,
          deathFame: existing.deathFame,
          fameRatio: existing.fameRatio,
          lifetimeStats: existing.lifetimeStats,
        }
      : {},
    incomingScalars,
    [
      "name",
      "guildId",
      "allianceId",
      "allianceName",
      "avatar",
      "avatarRing",
      "killFame",
      "deathFame",
      "fameRatio",
      "lifetimeStats",
    ]
  );

  if (existing && !changed) {
    await db
      .update(schema.players)
      .set({
        lastSyncedAt: now,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.players.id, existing.id));
    return;
  }

  const data = {
    ...incomingScalars,
    lastSyncedAt: now,
    lastCheckedAt: now,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(schema.players)
      .set(data)
      .where(eq(schema.players.id, existing.id));
  } else {
    await db.insert(schema.players).values({
      albionId,
      region,
      ...data,
    });
  }
}

export async function refreshGuildProfile(
  region: AlbionRegion,
  guildId: string
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const client = getAlbionClient();
  try {
    const info = await client.getGuildInfo(region, guildId);
    if (info) {
      await upsertGuildFromInfo(region, info);
    }
  } catch {
    // Guild may not exist or API unavailable
  }
}

export async function refreshAllianceProfile(
  region: AlbionRegion,
  allianceId: string
): Promise<void> {
  if (!isRegionEnabled(region)) return;
  const client = getAlbionClient();
  try {
    const raw = await client.getAllianceInfo(region, allianceId);
    await upsertAllianceFromInfo(region, raw);
  } catch {
    // Alliance may not exist or API unavailable
  }

  const existing = await db.query.alliances.findFirst({
    where: and(
      eq(schema.alliances.albionId, allianceId),
      eq(schema.alliances.region, region)
    ),
    columns: {
      recentBattlesPayload: true,
      topBattlesPayload: true,
      battlesLastSyncedAt: true,
    },
  });

  const needRecentBattles = guildBattleListNeedsRefresh(
    existing?.recentBattlesPayload,
    existing?.topBattlesPayload,
    existing?.battlesLastSyncedAt,
    { requireAlliancePreview: true }
  );
  const needTopBattles = guildBattleListNeedsRefresh(
    existing?.topBattlesPayload,
    existing?.recentBattlesPayload,
    existing?.battlesLastSyncedAt,
    { requireAlliancePreview: true }
  );

  if (!needRecentBattles && !needTopBattles) return;

  const fetches: Array<
    Promise<
      | { sort: "recent"; result: Awaited<ReturnType<typeof getAllianceBattlesBySort>> }
      | { sort: "topfame"; result: Awaited<ReturnType<typeof getAllianceBattlesBySort>> }
    >
  > = [];

  if (needRecentBattles) {
    fetches.push(
      getAllianceBattlesBySort(region, allianceId, "recent", 10).then(
        (result) => ({ sort: "recent" as const, result })
      )
    );
  }
  if (needTopBattles) {
    fetches.push(
      getAllianceBattlesBySort(region, allianceId, "topfame", 10).then(
        (result) => ({ sort: "topfame" as const, result })
      )
    );
  }

  const results = await Promise.all(fetches);
  const lists: {
    topBattles?: Awaited<ReturnType<typeof getAllianceBattlesBySort>>["battles"];
    recentBattles?: Awaited<ReturnType<typeof getAllianceBattlesBySort>>["battles"];
  } = {};

  for (const entry of results) {
    if (entry.result.battlesError) continue;
    if (entry.sort === "recent") lists.recentBattles = entry.result.battles;
    else lists.topBattles = entry.result.battles;
  }

  if (lists.topBattles || lists.recentBattles) {
    await cacheAllianceBattleLists(region, allianceId, lists);
  }

  try {
    const fame = await getAllianceFameFromMemberGuilds(region, allianceId);
    await db
      .update(schema.alliances)
      .set({
        killFame: fame.killFame,
        deathFame: fame.deathFame,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.alliances.albionId, allianceId),
          eq(schema.alliances.region, region)
        )
      );
  } catch {
    // Fame rollup is best-effort
  }
}

/** Profile and/or kill/death history — only fetches stale legs. */
export async function syncPlayerProfile(
  region: AlbionRegion,
  albionId: string
): Promise<void> {
  if (!isRegionEnabled(region)) return;

  const existing = await db.query.players.findFirst({
    where: and(
      eq(schema.players.albionId, albionId),
      eq(schema.players.region, region)
    ),
    columns: {
      lastSyncedAt: true,
      historyLastSyncedAt: true,
    },
  });

  const needProfile =
    !existing ||
    !existing.lastSyncedAt ||
    isSyncStale(existing.lastSyncedAt);
  const needHistory =
    !existing ||
    !existing.historyLastSyncedAt ||
    isSyncStale(existing.historyLastSyncedAt, HISTORY_SYNC_STALE_MS);

  if (needProfile) {
    await refreshPlayerProfile(region, albionId);
  }

  if (needHistory) {
    const { kills, deaths } = await fetchPlayerHistoryFromApi(region, albionId);
    await ingestPlayerHistoryEvents(region, [...kills, ...deaths]);

    const now = new Date();
    await db
      .update(schema.players)
      .set({ historyLastSyncedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.players.albionId, albionId),
          eq(schema.players.region, region)
        )
      );
  }
}

/** Guild info and/or top kills + top battles — only fetches stale legs unless forced. */
export async function syncGuildProfile(
  region: AlbionRegion,
  guildId: string,
  options?: { force?: boolean }
): Promise<void> {
  if (!isRegionEnabled(region)) return;

  const force = options?.force === true;
  const existing = await db.query.guilds.findFirst({
    where: and(
      eq(schema.guilds.albionId, guildId),
      eq(schema.guilds.region, region)
    ),
    columns: {
      lastSyncedAt: true,
      historyLastSyncedAt: true,
      battlesLastSyncedAt: true,
      recentBattlesPayload: true,
      topBattlesPayload: true,
      memberCount: true,
    },
  });

  const needProfile =
    force ||
    !existing ||
    !existing.lastSyncedAt ||
    existing.memberCount == null ||
    isSyncStale(existing.lastSyncedAt);
  const needHistory =
    force ||
    !existing ||
    !existing.historyLastSyncedAt ||
    isSyncStale(existing.historyLastSyncedAt, HISTORY_SYNC_STALE_MS);
  const needRecentBattles =
    force ||
    !existing ||
    guildBattleListNeedsRefresh(
      existing?.recentBattlesPayload,
      existing?.topBattlesPayload,
      existing?.battlesLastSyncedAt,
      { force }
    );
  const needTopBattles =
    force ||
    !existing ||
    guildBattleListNeedsRefresh(
      existing?.topBattlesPayload,
      existing?.recentBattlesPayload,
      existing?.battlesLastSyncedAt,
      { force }
    );
  const needBattles = needRecentBattles || needTopBattles;

  if (needProfile) {
    await refreshGuildProfile(region, guildId);
  }

  if (needHistory) {
    const client = getAlbionClient();
    const topKills = await client
      .getGuildTopKills(region, guildId, { limit: 10 })
      .catch(() => []);
    await ingestPlayerHistoryEvents(region, topKills);

    const now = new Date();
    await db
      .update(schema.guilds)
      .set({ historyLastSyncedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.guilds.albionId, guildId),
          eq(schema.guilds.region, region)
        )
      );
  }

  if (needBattles) {
    const fetches: Array<
      Promise<
        | { sort: "recent"; result: Awaited<ReturnType<typeof getGuildBattlesBySort>> }
        | { sort: "topfame"; result: Awaited<ReturnType<typeof getGuildBattlesBySort>> }
      >
    > = [];

    if (needRecentBattles) {
      fetches.push(
        getGuildBattlesBySort(region, guildId, "recent", 10).then((result) => ({
          sort: "recent" as const,
          result,
        }))
      );
    }
    if (needTopBattles) {
      fetches.push(
        getGuildBattlesBySort(region, guildId, "topfame", 10).then((result) => ({
          sort: "topfame" as const,
          result,
        }))
      );
    }

    const results = await Promise.all(fetches);
    const now = new Date();
    const updates: {
      topBattlesPayload?: ReturnType<typeof wrapGuildBattleListCache>;
      recentBattlesPayload?: ReturnType<typeof wrapGuildBattleListCache>;
      battlesLastSyncedAt?: Date;
      updatedAt: Date;
    } = { updatedAt: now };

    let recentFetchOk = !needRecentBattles;
    let topFetchOk = !needTopBattles;

    for (const entry of results) {
      if (entry.sort === "recent") {
        if (!entry.result.battlesError) {
          updates.recentBattlesPayload = wrapGuildBattleListCache(
            entry.result.battles
          );
          recentFetchOk = true;
        }
      } else if (!entry.result.battlesError) {
        updates.topBattlesPayload = wrapGuildBattleListCache(
          entry.result.battles
        );
        topFetchOk = true;
      }
    }

    const finalRecentPayload =
      updates.recentBattlesPayload ?? existing?.recentBattlesPayload;
    const finalTopPayload =
      updates.topBattlesPayload ?? existing?.topBattlesPayload;

    if (
      recentFetchOk &&
      topFetchOk &&
      isGuildBattleCacheComplete(finalRecentPayload, finalTopPayload)
    ) {
      updates.battlesLastSyncedAt = now;
    }

    if (updates.topBattlesPayload || updates.recentBattlesPayload) {
      await db
        .update(schema.guilds)
        .set(updates)
        .where(
          and(
            eq(schema.guilds.albionId, guildId),
            eq(schema.guilds.region, region)
          )
        );
    }
  }
}

/** @deprecated Prefer syncPlayerProfile — kept for in-flight legacy jobs. */
export async function backfillPlayerHistory(
  region: AlbionRegion,
  albionId: string
): Promise<void> {
  await syncPlayerProfile(region, albionId);
}

/** @deprecated Prefer syncGuildProfile — kept for in-flight legacy jobs. */
export async function backfillGuildTopKills(
  region: AlbionRegion,
  guildId: string
): Promise<void> {
  await syncGuildProfile(region, guildId);
}

export async function ensureSyncStates() {
  for (const region of ENABLED_REGIONS) {
    const existing = await db.query.apiSyncState.findFirst({
      where: eq(schema.apiSyncState.region, region),
    });
    if (!existing) {
      await db.insert(schema.apiSyncState).values({ region });
    }
  }
}

/**
 * Poll Albion recent battles: persist rows at ≥ RECENT_BATTLES_MIN_PLAYERS,
 * return list stats (including sub-threshold fights) so event ingest can
 * classify without `/battles/{id}`, then queue detail sync for fame > 0
 * fights that meet the player floor.
 */
export async function ingestRecentBattles(region: AlbionRegion): Promise<{
  fetched: number;
  kept: number;
  statsCache: Map<number, IngestBattleStats>;
}> {
  const statsCache = new Map<number, IngestBattleStats>();
  if (!isRegionEnabled(region)) {
    return { fetched: 0, kept: 0, statsCache };
  }

  const client = getAlbionClient();
  const battles = await client.getBattlesRaw(region, {
    sort: "recent",
    limit: RECENT_BATTLES_POLL_LIMIT,
    offset: 0,
  });

  let kept = 0;

  for (const battle of battles) {
    const albionBattleId = battle.id ?? battle.albionId;
    if (albionBattleId == null) continue;

    const fame = battle.totalFame ?? 0;
    const players =
      battle.totalPlayers ??
      (battle.players ? Object.keys(battle.players).length : 0);

    statsCache.set(albionBattleId, {
      totalPlayers: players,
      totalKills: battle.totalKills,
      totalFame: battle.totalFame,
    });

    await upsertBattleFromRecentList(region, battle);

    if (
      fame <= RECENT_BATTLES_MIN_FAME ||
      !battleMeetsRecentIngestThreshold(players)
    ) {
      continue;
    }

    kept++;

    try {
      await ensureBattleDetailQueued(region, albionBattleId);
    } catch (err) {
      console.error(
        `[ingest] Failed to queue battle detail sync for ${region}/${albionBattleId}:`,
        err
      );
    }
  }

  console.log(
    `[ingest] ${region} recent battles: fetched=${battles.length} kept=${kept}`
  );

  return { fetched: battles.length, kept, statsCache };
}
