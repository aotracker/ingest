import { and, eq, sql, sum } from "drizzle-orm";
import type { AlbionRegion, GuildBattleSummary } from "../albion/types";
import {
  isGuildBattleCacheComplete,
  wrapGuildBattleListCache,
} from "../albion/battles";
import { db, schema } from "./index";

export async function getGuildByAlbionId(
  region: AlbionRegion,
  albionId: string
) {
  return db.query.guilds.findFirst({
    where: and(
      eq(schema.guilds.region, region),
      eq(schema.guilds.albionId, albionId)
    ),
  });
}

export async function getAllianceByAlbionId(
  region: AlbionRegion,
  albionId: string
) {
  return db.query.alliances.findFirst({
    where: and(
      eq(schema.alliances.region, region),
      eq(schema.alliances.albionId, albionId)
    ),
  });
}

export async function cacheAllianceBattleLists(
  region: AlbionRegion,
  allianceId: string,
  lists: {
    topBattles?: GuildBattleSummary[];
    recentBattles?: GuildBattleSummary[];
  }
): Promise<void> {
  const existing = await getAllianceByAlbionId(region, allianceId);
  if (!existing) return;

  const topDefined = lists.topBattles !== undefined;
  const recentDefined = lists.recentBattles !== undefined;
  if (!topDefined && !recentDefined) return;

  const now = new Date();
  const topBattlesPayload = topDefined
    ? wrapGuildBattleListCache(lists.topBattles!)
    : existing.topBattlesPayload;
  const recentBattlesPayload = recentDefined
    ? wrapGuildBattleListCache(lists.recentBattles!)
    : existing.recentBattlesPayload;

  const cacheComplete = isGuildBattleCacheComplete(
    recentBattlesPayload,
    topBattlesPayload,
    { requireAlliancePreview: true }
  );

  await db
    .update(schema.alliances)
    .set({
      ...(topDefined ? { topBattlesPayload } : {}),
      ...(recentDefined ? { recentBattlesPayload } : {}),
      ...(cacheComplete ? { battlesLastSyncedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(schema.alliances.id, existing.id));
}

/** Sum kill/death fame from current member guilds (membership-now). */
export async function getAllianceFameFromMemberGuilds(
  region: AlbionRegion,
  allianceAlbionId: string
): Promise<{ killFame: number; deathFame: number }> {
  const rows = await db
    .select({
      killFame: sum(schema.guilds.killFame),
      deathFame: sum(schema.guilds.deathFame),
    })
    .from(schema.guilds)
    .where(
      and(
        eq(schema.guilds.region, region),
        eq(schema.guilds.allianceId, allianceAlbionId)
      )
    );

  return {
    killFame: Number(rows[0]?.killFame ?? 0),
    deathFame: Number(rows[0]?.deathFame ?? 0),
  };
}

export async function incrementEventsIngested(
  region: AlbionRegion,
  count: number
) {
  await db
    .update(schema.apiSyncState)
    .set({
      eventsIngestedLastHour: sql`${schema.apiSyncState.eventsIngestedLastHour} + ${count}`,
      updatedAt: new Date(),
    })
    .where(eq(schema.apiSyncState.region, region));
}
