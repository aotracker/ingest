/**
 * Increment guild UTC-hour activity when a kill event is first persisted.
 *
 * Unique members are tracked in `guild_hour_players` (insert-if-new).
 * Kills / deaths / fame increment on `guild_hour_stats`.
 *
 * Coverage: live poll is 50 events / 25 min / region (~120/h). Player and guild
 * backfill add more, but peak ZvZ can still outrun discovery — hour ranks are
 * trustworthy for large PvP guilds, not for precise small-guild ordering.
 */
import { lt, sql } from "drizzle-orm";
import type { AlbionRegion, ContentType } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import { RETAIN_FULL_DAYS, retainFullCutoff } from "@aotracker/core/db/retention";

type HourStatsTx = Pick<typeof db, "insert">;

export type GuildHourParticipant = {
  role: "killer" | "victim" | "group_member" | "participant";
  playerAlbionId: string | null;
  guildAlbionId: string | null;
  guildName: string | null;
};

type GuildBucket = {
  guildName: string;
  playerIds: Set<string>;
  kills: number;
  deaths: number;
  fame: number;
};

function utcBucket(occurredAt: Date): { utcDate: string; utcHour: number } {
  return {
    utcDate: occurredAt.toISOString().slice(0, 10),
    utcHour: occurredAt.getUTCHours(),
  };
}

/** Stable unique-key order so concurrent upserts lock index rows the same way. */
export function comparePlayerRow(
  a: { guildAlbionId: string; playerAlbionId: string },
  b: { guildAlbionId: string; playerAlbionId: string }
): number {
  return (
    a.guildAlbionId.localeCompare(b.guildAlbionId) ||
    a.playerAlbionId.localeCompare(b.playerAlbionId)
  );
}

export function compareStatsRow(
  a: { guildAlbionId: string },
  b: { guildAlbionId: string }
): number {
  return a.guildAlbionId.localeCompare(b.guildAlbionId);
}

export async function recordGuildHourActivity(
  tx: HourStatsTx,
  input: {
    region: AlbionRegion;
    occurredAt: Date;
    contentType: ContentType;
    totalVictimKillFame: number;
    participants: GuildHourParticipant[];
  }
): Promise<void> {
  const { utcDate, utcHour } = utcBucket(input.occurredAt);
  const buckets = new Map<string, GuildBucket>();

  const ensure = (guildId: string, guildName: string | null): GuildBucket => {
    let bucket = buckets.get(guildId);
    if (!bucket) {
      bucket = {
        guildName: guildName?.trim() || guildId,
        playerIds: new Set(),
        kills: 0,
        deaths: 0,
        fame: 0,
      };
      buckets.set(guildId, bucket);
    } else if (guildName?.trim() && bucket.guildName === guildId) {
      bucket.guildName = guildName.trim();
    }
    return bucket;
  };

  for (const participant of input.participants) {
    const guildId = participant.guildAlbionId?.trim();
    if (!guildId) continue;
    const bucket = ensure(guildId, participant.guildName);
    const playerId = participant.playerAlbionId?.trim();
    if (playerId) bucket.playerIds.add(playerId);
    if (participant.role === "killer") {
      bucket.kills += 1;
      bucket.fame += input.totalVictimKillFame;
    } else if (participant.role === "victim") {
      bucket.deaths += 1;
    }
  }

  if (buckets.size === 0) return;

  const playerRows: {
    region: AlbionRegion;
    guildAlbionId: string;
    utcDate: string;
    utcHour: number;
    contentType: ContentType;
    playerAlbionId: string;
  }[] = [];

  for (const [guildAlbionId, bucket] of buckets) {
    for (const playerAlbionId of bucket.playerIds) {
      playerRows.push({
        region: input.region,
        guildAlbionId,
        utcDate,
        utcHour,
        contentType: input.contentType,
        playerAlbionId,
      });
    }
  }

  playerRows.sort(comparePlayerRow);

  const uniqueDelta = new Map<string, number>();
  if (playerRows.length > 0) {
    const inserted = await tx
      .insert(schema.guildHourPlayers)
      .values(playerRows)
      .onConflictDoNothing({
        target: [
          schema.guildHourPlayers.region,
          schema.guildHourPlayers.guildAlbionId,
          schema.guildHourPlayers.utcDate,
          schema.guildHourPlayers.utcHour,
          schema.guildHourPlayers.contentType,
          schema.guildHourPlayers.playerAlbionId,
        ],
      })
      .returning({ guildAlbionId: schema.guildHourPlayers.guildAlbionId });

    for (const row of inserted) {
      uniqueDelta.set(
        row.guildAlbionId,
        (uniqueDelta.get(row.guildAlbionId) ?? 0) + 1
      );
    }
  }

  const statsRows = [...buckets.entries()]
    .map(([guildAlbionId, bucket]) => ({
      region: input.region,
      guildAlbionId,
      guildName: bucket.guildName,
      utcDate,
      utcHour,
      contentType: input.contentType,
      uniquePlayers: uniqueDelta.get(guildAlbionId) ?? 0,
      kills: bucket.kills,
      deaths: bucket.deaths,
      fame: bucket.fame,
    }))
    .sort(compareStatsRow);

  await tx
    .insert(schema.guildHourStats)
    .values(statsRows)
    .onConflictDoUpdate({
      target: [
        schema.guildHourStats.region,
        schema.guildHourStats.guildAlbionId,
        schema.guildHourStats.utcDate,
        schema.guildHourStats.utcHour,
        schema.guildHourStats.contentType,
      ],
      set: {
        // Keep a real name if a later event only has the guild ID fallback.
        guildName: sql`CASE
          WHEN btrim(excluded.guild_name) <> ''
            AND excluded.guild_name IS DISTINCT FROM excluded.guild_albion_id
          THEN excluded.guild_name
          ELSE ${schema.guildHourStats.guildName}
        END`,
        uniquePlayers: sql`${schema.guildHourStats.uniquePlayers} + excluded.unique_players`,
        kills: sql`${schema.guildHourStats.kills} + excluded.kills`,
        deaths: sql`${schema.guildHourStats.deaths} + excluded.deaths`,
        fame: sql`${schema.guildHourStats.fame} + excluded.fame`,
      },
    });
}

export async function purgeExpiredGuildHourStats(options?: {
  olderThanDays?: number;
  dryRun?: boolean;
}): Promise<{ playersDeleted: number; statsDeleted: number }> {
  const olderThanDays = options?.olderThanDays ?? RETAIN_FULL_DAYS;
  const dryRun = options?.dryRun === true;
  const cutoffDate = (
    options?.olderThanDays != null
      ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
      : retainFullCutoff()
  )
    .toISOString()
    .slice(0, 10);

  const [playerCount, statsCount] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.guildHourPlayers)
      .where(lt(schema.guildHourPlayers.utcDate, cutoffDate)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.guildHourStats)
      .where(lt(schema.guildHourStats.utcDate, cutoffDate)),
  ]);
  const playersDeleted = playerCount[0]?.n ?? 0;
  const statsDeleted = statsCount[0]?.n ?? 0;

  if (dryRun) {
    return { playersDeleted, statsDeleted };
  }

  if (playersDeleted > 0) {
    await db
      .delete(schema.guildHourPlayers)
      .where(lt(schema.guildHourPlayers.utcDate, cutoffDate));
  }
  if (statsDeleted > 0) {
    await db
      .delete(schema.guildHourStats)
      .where(lt(schema.guildHourStats.utcDate, cutoffDate));
  }

  return { playersDeleted, statsDeleted };
}
