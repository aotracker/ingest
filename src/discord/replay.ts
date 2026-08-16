import type { AlbionRegion } from "@aotracker/core/albion/types";
import { discordBotToken } from "./enabled";
import {
  clearPostClaim,
  feedFilters,
  findMatchingFeeds,
  hasPostedMessage,
  tryClaimPost,
  type DiscordFeedRow,
} from "./db";
import { loadKillSnapshot } from "./kill-data";
import { postKillToFeed } from "./poster";
import {
  FEED_GUILD_DEATHS,
  FEED_GUILD_KILLS,
  killEventKey,
  type DiscordFeedType,
} from "./types";

function feedAcceptsFame(
  feed: DiscordFeedRow,
  fame: number,
  contentType?: string
): boolean {
  const filters = feedFilters(feed);
  if (filters.paused) return false;
  if (filters.minFame != null && fame < filters.minFame) return false;
  if (
    filters.contentTypes?.length &&
    contentType &&
    !filters.contentTypes.includes(contentType)
  ) {
    return false;
  }
  return true;
}

export async function postKillToMatchingFeeds(input: {
  region: AlbionRegion;
  eventId: number;
  feedType?: DiscordFeedType;
  force?: boolean;
}): Promise<{
  posted: { feedType: string; channelId: string }[];
  skipped: string[];
}> {
  if (!discordBotToken()) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  const snapshot = await loadKillSnapshot(input.region, input.eventId);
  if (!snapshot?.detailSyncedAt) {
    throw new Error(
      `Kill ${input.region}/${input.eventId} is not in Postgres yet`
    );
  }

  const fame = snapshot.totalVictimKillFame ?? 0;
  if (fame <= 0) {
    throw new Error(
      `Kill ${input.region}/${input.eventId} has no kill fame (bot skips these)`
    );
  }

  const killerGuildId = snapshot.killer?.guildAlbionId ?? null;
  const victimGuildId = snapshot.victim?.guildAlbionId ?? null;
  const friendlyFire =
    killerGuildId != null &&
    victimGuildId != null &&
    killerGuildId === victimGuildId;

  const matches: DiscordFeedRow[] = [];
  if (killerGuildId && !friendlyFire) {
    matches.push(
      ...(await findMatchingFeeds({
        feedType: FEED_GUILD_KILLS,
        targetAlbionId: killerGuildId,
        region: input.region,
      }))
    );
  }
  if (victimGuildId) {
    matches.push(
      ...(await findMatchingFeeds({
        feedType: FEED_GUILD_DEATHS,
        targetAlbionId: victimGuildId,
        region: input.region,
      }))
    );
  }

  const eventKey = killEventKey(input.region, input.eventId);
  const posted: { feedType: string; channelId: string }[] = [];
  const skipped: string[] = [];

  for (const feed of matches) {
    if (input.feedType && feed.feedType !== input.feedType) continue;
    if (!feed.channelId) {
      skipped.push(`${feed.feedType}: no channel set`);
      continue;
    }
    if (!feedAcceptsFame(feed, fame, snapshot.contentType)) {
      skipped.push(`${feed.feedType}: filtered out`);
      continue;
    }

    if (input.force) {
      await clearPostClaim(feed.id, eventKey);
    } else if (await hasPostedMessage(feed.id, eventKey)) {
      skipped.push(`${feed.feedType}: already posted (pass --force to replay)`);
      continue;
    }

    await tryClaimPost(feed.id, eventKey);
    await postKillToFeed({
      feedId: feed.id,
      feedType: feed.feedType,
      channelId: feed.channelId,
      eventKey,
      snapshot,
    });
    posted.push({ feedType: feed.feedType, channelId: feed.channelId });
  }

  return { posted, skipped };
}
