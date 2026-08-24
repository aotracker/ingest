import { and, desc, eq, gt, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import {
  FEED_GUILD_DEATHS,
  FEED_GUILD_KILLS,
  parseFilters,
  type DiscordFeedFilters,
  type DiscordFeedType,
} from "./types";

export type DiscordFeedRow = typeof schema.discordFeeds.$inferSelect;

export async function upsertDiscordServer(
  discordGuildId: string,
  name: string | null,
  left = false
): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.discordServers)
    .values({
      discordGuildId,
      name,
      installedAt: now,
      leftAt: left ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.discordServers.discordGuildId,
      set: {
        name,
        leftAt: left ? now : null,
        updatedAt: now,
      },
    });
}

export async function listFeedsForServer(
  discordGuildId: string
): Promise<DiscordFeedRow[]> {
  return db
    .select()
    .from(schema.discordFeeds)
    .where(eq(schema.discordFeeds.discordGuildId, discordGuildId));
}

export async function findMatchingFeeds(input: {
  feedType: DiscordFeedType;
  targetAlbionId: string;
  region: AlbionRegion;
}): Promise<DiscordFeedRow[]> {
  return db
    .select()
    .from(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.feedType, input.feedType),
        eq(schema.discordFeeds.targetType, "guild"),
        eq(schema.discordFeeds.targetAlbionId, input.targetAlbionId),
        eq(schema.discordFeeds.region, input.region),
        eq(schema.discordFeeds.enabled, 1)
      )
    );
}

export async function findMatchingFeedsForKill(input: {
  region: AlbionRegion;
  killerGuildId: string | null;
  victimGuildId: string | null;
  includeKills: boolean;
}): Promise<DiscordFeedRow[]> {
  const typeMatches = [];
  if (input.includeKills && input.killerGuildId) {
    typeMatches.push(
      and(
        eq(schema.discordFeeds.feedType, FEED_GUILD_KILLS),
        eq(schema.discordFeeds.targetAlbionId, input.killerGuildId)
      )
    );
  }
  if (input.victimGuildId) {
    typeMatches.push(
      and(
        eq(schema.discordFeeds.feedType, FEED_GUILD_DEATHS),
        eq(schema.discordFeeds.targetAlbionId, input.victimGuildId)
      )
    );
  }
  if (typeMatches.length === 0) return [];

  return db
    .select()
    .from(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.targetType, "guild"),
        eq(schema.discordFeeds.region, input.region),
        eq(schema.discordFeeds.enabled, 1),
        or(...typeMatches)
      )
    );
}

export async function listActiveGuildFeedTargets(): Promise<
  { region: AlbionRegion; targetAlbionId: string }[]
> {
  const rows = await db
    .selectDistinct({
      region: schema.discordFeeds.region,
      targetAlbionId: schema.discordFeeds.targetAlbionId,
    })
    .from(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.targetType, "guild"),
        eq(schema.discordFeeds.enabled, 1),
        inArray(schema.discordFeeds.feedType, [
          FEED_GUILD_KILLS,
          FEED_GUILD_DEATHS,
        ])
      )
    );
  return rows;
}

export async function getFeedById(id: string): Promise<DiscordFeedRow | null> {
  const [row] = await db
    .select()
    .from(schema.discordFeeds)
    .where(eq(schema.discordFeeds.id, id))
    .limit(1);
  return row ?? null;
}

export async function searchGuildsForAutocomplete(
  query: string,
  region?: AlbionRegion
): Promise<{ albionId: string; name: string; region: AlbionRegion }[]> {
  const trimmed = query.trim();
  const filters = [];
  if (region) filters.push(eq(schema.guilds.region, region));
  if (trimmed) filters.push(ilike(schema.guilds.name, `%${trimmed}%`));

  const rows = await db
    .select({
      albionId: schema.guilds.albionId,
      name: schema.guilds.name,
      region: schema.guilds.region,
    })
    .from(schema.guilds)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(schema.guilds.name)
    .limit(25);

  return rows;
}

export { getGuildByAlbionId } from "@aotracker/core/db/queries-ingest";

export async function getGuildByName(region: AlbionRegion, name: string) {
  return db.query.guilds.findFirst({
    where: and(eq(schema.guilds.region, region), ilike(schema.guilds.name, name)),
  });
}

export async function trackGuildFeeds(input: {
  discordGuildId: string;
  discordGuildName: string | null;
  region: AlbionRegion;
  albionGuildId: string;
  albionGuildName: string;
  createdByUserId: string;
}): Promise<{ replaced: boolean }> {
  await upsertDiscordServer(input.discordGuildId, input.discordGuildName);

  const existing = await listFeedsForServer(input.discordGuildId);
  const prior = existing.filter(
    (row) =>
      row.feedType === FEED_GUILD_KILLS || row.feedType === FEED_GUILD_DEATHS
  );
  const replaced =
    prior.length > 0 &&
    prior.some(
      (row) =>
        row.targetAlbionId !== input.albionGuildId ||
        row.region !== input.region
    );

  if (prior.length > 0) {
    await db
      .delete(schema.discordFeeds)
      .where(
        and(
          eq(schema.discordFeeds.discordGuildId, input.discordGuildId),
          inArray(schema.discordFeeds.feedType, [
            FEED_GUILD_KILLS,
            FEED_GUILD_DEATHS,
          ])
        )
      );
  }

  const now = new Date();
  await db.insert(schema.discordFeeds).values([
    {
      discordGuildId: input.discordGuildId,
      feedType: FEED_GUILD_KILLS,
      targetType: "guild",
      targetAlbionId: input.albionGuildId,
      region: input.region,
      targetName: input.albionGuildName,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    },
    {
      discordGuildId: input.discordGuildId,
      feedType: FEED_GUILD_DEATHS,
      targetType: "guild",
      targetAlbionId: input.albionGuildId,
      region: input.region,
      targetName: input.albionGuildName,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return { replaced };
}

export async function setFeedChannel(
  discordGuildId: string,
  feedType: DiscordFeedType,
  channelId: string
): Promise<DiscordFeedRow | null> {
  const feeds = await listFeedsForServer(discordGuildId);
  const feed = feeds.find((row) => row.feedType === feedType);
  if (!feed) return null;

  const now = new Date();
  const patch: {
    channelId: string;
    updatedAt: Date;
    filters?: DiscordFeedFilters;
  } = { channelId, updatedAt: now };

  if (!feed.channelId) {
    patch.filters = {
      ...feedFilters(feed),
      notifyAfter: now.toISOString(),
    };
  }

  const [updated] = await db
    .update(schema.discordFeeds)
    .set(patch)
    .where(eq(schema.discordFeeds.id, feed.id))
    .returning();
  return updated ?? null;
}

export async function untrackGuildFeeds(discordGuildId: string): Promise<number> {
  const deleted = await db
    .delete(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.discordGuildId, discordGuildId),
        inArray(schema.discordFeeds.feedType, [
          FEED_GUILD_KILLS,
          FEED_GUILD_DEATHS,
        ])
      )
    )
    .returning({ id: schema.discordFeeds.id });
  return deleted.length;
}

export async function tryClaimPost(
  feedId: string,
  eventKey: string
): Promise<boolean> {
  const inserted = await db
    .insert(schema.discordPostLog)
    .values({ feedId, eventKey })
    .onConflictDoNothing({
      target: [schema.discordPostLog.feedId, schema.discordPostLog.eventKey],
    })
    .returning({ id: schema.discordPostLog.id });
  return inserted.length > 0;
}

export async function recordPostedMessage(
  feedId: string,
  eventKey: string,
  discordMessageId: string | null
): Promise<void> {
  await db
    .update(schema.discordPostLog)
    .set({ discordMessageId })
    .where(
      and(
        eq(schema.discordPostLog.feedId, feedId),
        eq(schema.discordPostLog.eventKey, eventKey)
      )
    );
}

export async function hasPostedMessage(
  feedId: string,
  eventKey: string
): Promise<boolean> {
  const [row] = await db
    .select({ discordMessageId: schema.discordPostLog.discordMessageId })
    .from(schema.discordPostLog)
    .where(
      and(
        eq(schema.discordPostLog.feedId, feedId),
        eq(schema.discordPostLog.eventKey, eventKey)
      )
    )
    .limit(1);
  return Boolean(row?.discordMessageId);
}

export async function clearPostClaim(
  feedId: string,
  eventKey: string
): Promise<void> {
  await db
    .delete(schema.discordPostLog)
    .where(
      and(
        eq(schema.discordPostLog.feedId, feedId),
        eq(schema.discordPostLog.eventKey, eventKey)
      )
    );
}

export async function listPostableFeeds(): Promise<DiscordFeedRow[]> {
  return db
    .select()
    .from(schema.discordFeeds)
    .where(
      and(
        eq(schema.discordFeeds.enabled, 1),
        isNotNull(schema.discordFeeds.channelId)
      )
    );
}

export async function findLatestKillForFeeds(
  feeds: DiscordFeedRow[]
): Promise<{ region: AlbionRegion; eventId: number } | null> {
  if (feeds.length === 0) return null;

  const killer = alias(schema.killParticipants, "discord_replay_killer");
  const victim = alias(schema.killParticipants, "discord_replay_victim");
  const killerGuildId = sql`COALESCE(${killer.guildAlbionId}, ${killer.rawPayload}->>'GuildId')`;
  const victimGuildId = sql`COALESCE(${victim.guildAlbionId}, ${victim.rawPayload}->>'GuildId')`;
  const match = or(
    ...feeds.map((feed) => {
      if (feed.feedType === FEED_GUILD_KILLS) {
        return and(
          eq(schema.killEvents.region, feed.region),
          sql`${killerGuildId} = ${feed.targetAlbionId}`,
          sql`${killerGuildId} IS DISTINCT FROM ${victimGuildId}`
        );
      }
      return and(
        eq(schema.killEvents.region, feed.region),
        sql`${victimGuildId} = ${feed.targetAlbionId}`
      );
    })
  );

  const [row] = await db
    .select({
      region: schema.killEvents.region,
      eventId: schema.killEvents.eventId,
    })
    .from(schema.killEvents)
    .innerJoin(
      killer,
      and(eq(killer.eventId, schema.killEvents.id), eq(killer.role, "killer"))
    )
    .innerJoin(
      victim,
      and(eq(victim.eventId, schema.killEvents.id), eq(victim.role, "victim"))
    )
    .where(and(gt(schema.killEvents.totalVictimKillFame, 0), match))
    .orderBy(desc(schema.killEvents.occurredAt))
    .limit(1);

  return row ?? null;
}

export function feedFilters(feed: DiscordFeedRow): DiscordFeedFilters {
  return parseFilters(feed.filters);
}

export async function updateFeedFilters(
  discordGuildId: string,
  patch: DiscordFeedFilters
): Promise<number> {
  const feeds = await listFeedsForServer(discordGuildId);
  if (feeds.length === 0) return 0;

  const now = new Date();
  let updated = 0;
  for (const feed of feeds) {
    const next = { ...feedFilters(feed), ...patch };
    await db
      .update(schema.discordFeeds)
      .set({ filters: next, updatedAt: now })
      .where(eq(schema.discordFeeds.id, feed.id));
    updated += 1;
  }
  return updated;
}

export async function listPlayerAlbionIdsForGuild(
  region: AlbionRegion,
  guildAlbionId: string,
  limit = 40
): Promise<string[]> {
  const rows = await db
    .select({ albionId: schema.players.albionId })
    .from(schema.players)
    .innerJoin(schema.guilds, eq(schema.players.guildId, schema.guilds.id))
    .where(
      and(
        eq(schema.players.region, region),
        eq(schema.guilds.albionId, guildAlbionId)
      )
    )
    .limit(limit);
  return rows.map((row) => row.albionId);
}
