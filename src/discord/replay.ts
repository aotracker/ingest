import type { AlbionRegion } from "@aotracker/core/albion/types";
import { discordBotToken } from "./enabled";
import {
  clearPostClaim,
  feedFilters,
  findMatchingBattleFeeds,
  findMatchingFeeds,
  getPostedMessage,
  hasPostedMessage,
  listPostableFeeds,
  recordPostedMessage,
  tryClaimPost,
  type DiscordFeedRow,
} from "./db";
import { killMeetsFeedFilters, notifyCutoff } from "./kill-filters";
import { loadKillSnapshot } from "./kill-data";
import { postKillToFeed } from "./poster";
import {
  DEFAULT_BATTLE_FEED_MIN_PLAYERS,
  FEED_GUILD_BATTLES,
  FEED_GUILD_DEATHS,
  FEED_GUILD_KILLS,
  battleEventKey,
  battleThreadKey,
  isPostedDiscordMessageId,
  killEventKey,
  skippedFilterMessageId,
  type DiscordFeedType,
} from "./types";
import {
  guildInBattle,
  loadBattleSnapshot,
  refreshBattleListFromAlbion,
  sampleBattleSnapshot,
} from "./battle-data";
import { postBattleToFeed, postOrEditBattlePreview } from "./battle-poster";

function recordSkippedFilter(
  feedId: string,
  eventKey: string,
  reason: string
): Promise<void> {
  return recordPostedMessage(feedId, eventKey, skippedFilterMessageId(reason));
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
    const accepted = await killMeetsFeedFilters(feed, snapshot);
    if (!accepted.ok) {
      skipped.push(`${feed.feedType}: filtered out (${accepted.reason})`);
      if (!input.force) {
        await tryClaimPost(feed.id, eventKey);
        await recordSkippedFilter(feed.id, eventKey, accepted.reason);
      }
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
      pingRoleId: feedFilters(feed).pingRoleId,
    });
    posted.push({ feedType: feed.feedType, channelId: feed.channelId });
  }

  return { posted, skipped };
}

export async function postBattleToMatchingFeeds(input: {
  region: AlbionRegion;
  battleId: number;
  force?: boolean;
}): Promise<{
  posted: { feedType: string; channelId: string }[];
  skipped: string[];
}> {
  if (!discordBotToken()) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  const snapshot =
    (await loadBattleSnapshot(input.region, input.battleId)) ??
    (await refreshBattleListFromAlbion(input.region, input.battleId));
  if (!snapshot) {
    throw new Error(
      `Battle ${input.region}/${input.battleId} is not in Postgres yet`
    );
  }

  const feeds = await findMatchingBattleFeeds({ region: input.region });
  const eventKey = battleEventKey(input.region, input.battleId);
  const threadKey = battleThreadKey(input.region, input.battleId);
  const posted: { feedType: string; channelId: string }[] = [];
  const skipped: string[] = [];

  for (const feed of feeds) {
    if (!feed.channelId) {
      skipped.push(`${feed.feedType}: no channel set`);
      continue;
    }

    const filters = feedFilters(feed);
    if (filters.paused) {
      skipped.push(`${feed.feedType}: filtered out (paused)`);
      continue;
    }

    const tracked = guildInBattle(
      snapshot,
      feed.targetAlbionId,
      feed.targetName
    );
    if (!tracked) {
      skipped.push(`${feed.feedType}: tracked guild not in this battle`);
      continue;
    }

    const minPlayers = filters.minPlayers ?? DEFAULT_BATTLE_FEED_MIN_PLAYERS;
    if (tracked.players < minPlayers) {
      skipped.push(
        `${feed.feedType}: filtered out (min-players ${tracked.players} < ${minPlayers})`
      );
      if (!input.force) {
        await tryClaimPost(feed.id, eventKey);
        await recordSkippedFilter(feed.id, eventKey, "min-players");
      }
      continue;
    }

    const occurredAt = snapshot.startTime ?? snapshot.endTime;
    if (
      !input.force &&
      occurredAt &&
      occurredAt < notifyCutoff(feed)
    ) {
      skipped.push(`${feed.feedType}: filtered out (too-old)`);
      await tryClaimPost(feed.id, eventKey);
      await recordSkippedFilter(feed.id, eventKey, "too-old");
      continue;
    }

    if (input.force) {
      await clearPostClaim(feed.id, eventKey);
    } else if (await hasPostedMessage(feed.id, eventKey)) {
      skipped.push(`${feed.feedType}: already posted (pass --force to replay)`);
      continue;
    }

    await tryClaimPost(feed.id, eventKey);
    await postBattleToFeed({
      feedId: feed.id,
      channelId: feed.channelId,
      eventKey,
      snapshot,
      trackedGuildId: feed.targetAlbionId,
      trackedGuildName: feed.targetName,
      pingRoleId: filters.pingRoleId,
      createThread:
        Boolean(filters.createThread) &&
        !isPostedDiscordMessageId(await getPostedMessage(feed.id, threadKey)),
      threadEventKey: threadKey,
    });
    posted.push({ feedType: feed.feedType, channelId: feed.channelId });
  }

  return { posted, skipped };
}

export async function postBattlePreviewToMatchingFeeds(input?: {
  feedType?: DiscordFeedType;
}): Promise<{
  posted: { feedType: string; channelId: string; edited: boolean }[];
  skipped: string[];
}> {
  if (!discordBotToken()) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }

  const feeds = (await listPostableFeeds()).filter(
    (feed) => feed.feedType === FEED_GUILD_BATTLES
  );
  const posted: { feedType: string; channelId: string; edited: boolean }[] = [];
  const skipped: string[] = [];

  for (const feed of feeds) {
    if (input?.feedType && feed.feedType !== input.feedType) continue;
    if (!feed.channelId) {
      skipped.push(`${feed.feedType}: no channel set`);
      continue;
    }
    const snapshot = sampleBattleSnapshot({
      region: feed.region,
      trackedGuildId: feed.targetAlbionId,
      trackedGuildName: feed.targetName,
    });
    const result = await postOrEditBattlePreview({
      feedId: feed.id,
      channelId: feed.channelId,
      snapshot,
      trackedGuildId: feed.targetAlbionId,
      trackedGuildName: feed.targetName,
    });
    posted.push({
      feedType: feed.feedType,
      channelId: feed.channelId,
      edited: result.edited,
    });
  }

  return { posted, skipped };
}
