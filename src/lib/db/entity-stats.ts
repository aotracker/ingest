/**
 * Snapshot per-region entity counts and latest-kill time onto api_sync_state.
 * The health job runs this on the VM so Vercel never COUNT(*) / MAX() kill_events.
 */
import { count, eq, inArray, max } from "drizzle-orm";
import { ENABLED_REGIONS, type AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";

function countByRegion(
  rows: { region: AlbionRegion; count: number }[]
): Map<AlbionRegion, number> {
  return new Map(rows.map((row) => [row.region, row.count]));
}

export async function refreshRegionEntityStats(): Promise<void> {
  if (ENABLED_REGIONS.length === 0) return;

  const [playerRows, guildRows, killRows, battleRows] = await Promise.all([
    db
      .select({
        region: schema.players.region,
        count: count(),
      })
      .from(schema.players)
      .where(inArray(schema.players.region, ENABLED_REGIONS))
      .groupBy(schema.players.region),
    db
      .select({
        region: schema.guilds.region,
        count: count(),
      })
      .from(schema.guilds)
      .where(inArray(schema.guilds.region, ENABLED_REGIONS))
      .groupBy(schema.guilds.region),
    db
      .select({
        region: schema.killEvents.region,
        count: count(),
        latestKillAt: max(schema.killEvents.occurredAt),
      })
      .from(schema.killEvents)
      .where(inArray(schema.killEvents.region, ENABLED_REGIONS))
      .groupBy(schema.killEvents.region),
    db
      .select({
        region: schema.battles.region,
        count: count(),
      })
      .from(schema.battles)
      .where(inArray(schema.battles.region, ENABLED_REGIONS))
      .groupBy(schema.battles.region),
  ]);

  const players = countByRegion(playerRows);
  const guilds = countByRegion(guildRows);
  const battles = countByRegion(battleRows);
  const kills = new Map(
    killRows.map((row) => [
      row.region,
      { count: row.count, latestKillAt: row.latestKillAt },
    ])
  );

  const now = new Date();
  await Promise.all(
    ENABLED_REGIONS.map((region) => {
      const kill = kills.get(region);
      return db
        .update(schema.apiSyncState)
        .set({
          playerCount: players.get(region) ?? 0,
          guildCount: guilds.get(region) ?? 0,
          killCount: kill?.count ?? 0,
          battleCount: battles.get(region) ?? 0,
          latestKillAt: kill?.latestKillAt ?? null,
          updatedAt: now,
        })
        .where(eq(schema.apiSyncState.region, region));
    })
  );
}
