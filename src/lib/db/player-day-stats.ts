/**
 * Increment per-player UTC-day kill count / fame when a kill is first persisted.
 * Homepage and player leaderboards SUM this table instead of scanning kill_events.
 */
import { lt, sql } from "drizzle-orm";
import type { AlbionRegion, ContentType } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import { RETAIN_FULL_DAYS, retainFullCutoff } from "@aotracker/core/db/retention";

type DayStatsTx = Pick<typeof db, "insert">;

export function utcDate(occurredAt: Date): string {
  return occurredAt.toISOString().slice(0, 10);
}

export async function recordPlayerDayKill(
  tx: DayStatsTx,
  input: {
    region: AlbionRegion;
    playerId: string | null;
    occurredAt: Date;
    contentType: ContentType;
    killFame: number;
  }
): Promise<void> {
  if (!input.playerId || input.killFame <= 0) return;

  await tx
    .insert(schema.playerDayStats)
    .values({
      region: input.region,
      playerId: input.playerId,
      utcDate: utcDate(input.occurredAt),
      contentType: input.contentType,
      killCount: 1,
      killFame: input.killFame,
    })
    .onConflictDoUpdate({
      target: [
        schema.playerDayStats.region,
        schema.playerDayStats.playerId,
        schema.playerDayStats.utcDate,
        schema.playerDayStats.contentType,
      ],
      set: {
        killCount: sql`${schema.playerDayStats.killCount} + 1`,
        killFame: sql`${schema.playerDayStats.killFame} + excluded.kill_fame`,
      },
    });
}

export async function purgeExpiredPlayerDayStats(options?: {
  olderThanDays?: number;
  dryRun?: boolean;
}): Promise<{ deleted: number }> {
  const olderThanDays = options?.olderThanDays ?? RETAIN_FULL_DAYS;
  const dryRun = options?.dryRun === true;
  const cutoffDate = (
    options?.olderThanDays != null
      ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
      : retainFullCutoff()
  )
    .toISOString()
    .slice(0, 10);

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.playerDayStats)
    .where(lt(schema.playerDayStats.utcDate, cutoffDate));
  const deleted = countRow?.n ?? 0;

  if (dryRun || deleted === 0) {
    return { deleted };
  }

  await db
    .delete(schema.playerDayStats)
    .where(lt(schema.playerDayStats.utcDate, cutoffDate));

  return { deleted };
}
