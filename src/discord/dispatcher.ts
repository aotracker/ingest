import type { AlbionEvent, AlbionRegion } from "@aotracker/core/albion/types";
import { classifyContentType, extractEventCounts } from "@aotracker/core/albion/classify";
import { isDiscordEnabled } from "./enabled";
import {
  clearPostClaim,
  feedFilters,
  findMatchingBattleFeeds,
  findMatchingFeedsForKill,
  hasPostedMessage,
  tryClaimPost,
  type DiscordFeedRow,
} from "./db";
import { enqueueNotifyDiscord, enqueueNotifyDiscordBattle } from "./jobs";
import { DEFAULT_BATTLE_FEED_MIN_PLAYERS, killEventKey } from "./types";
import {
  guildInBattle,
  type BattleSnapshot,
} from "./battle-data";

function guildId(player: AlbionEvent["Killer"]): string | null {
  const id = player?.GuildId?.trim();
  return id || null;
}

function eventOccurredAt(event: AlbionEvent): Date | null {
  const occurred = new Date(event.TimeStamp);
  return Number.isNaN(occurred.getTime()) ? null : occurred;
}

function notifyCutoff(feed: DiscordFeedRow): Date {
  const filters = feedFilters(feed);
  if (filters.notifyAfter) {
    const stamped = new Date(filters.notifyAfter);
    if (!Number.isNaN(stamped.getTime())) return stamped;
  }
  return feed.createdAt;
}

function passesFilters(
  feed: DiscordFeedRow,
  fame: number,
  occurredAt: Date,
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
  if (occurredAt < notifyCutoff(feed)) return false;
  return true;
}

export async function emitKillIngested(
  region: AlbionRegion,
  event: AlbionEvent
): Promise<void> {
  if (!isDiscordEnabled()) return;

  const fame = event.TotalVictimKillFame ?? 0;
  if (fame <= 0) return;

  const killerGuildId = guildId(event.Killer);
  const victimGuildId = guildId(event.Victim);
  if (!killerGuildId && !victimGuildId) return;

  const friendlyFire =
    killerGuildId != null &&
    victimGuildId != null &&
    killerGuildId === victimGuildId;

  const matches: DiscordFeedRow[] = await findMatchingFeedsForKill({
    region,
    killerGuildId,
    victimGuildId,
    includeKills: Boolean(killerGuildId && !friendlyFire),
  });

  const occurredAt = eventOccurredAt(event);
  if (!occurredAt) return;

  const counts = extractEventCounts(event);
  const contentType = classifyContentType({
    killer: event.Killer,
    victim: event.Victim,
    participantCount: counts.participantCount,
    groupMemberCount: counts.groupMemberCount,
    groupMembers: event.GroupMembers,
    participants: event.Participants,
  });

  const eventKey = killEventKey(region, event.EventId);

  for (const feed of matches) {
    if (!feed.channelId) continue;
    if (!passesFilters(feed, fame, occurredAt, contentType)) continue;
    if (await hasPostedMessage(feed.id, eventKey)) continue;
    const claimed = await tryClaimPost(feed.id, eventKey);
    try {
      await enqueueNotifyDiscord({
        feedId: feed.id,
        region,
        eventId: event.EventId,
      });
    } catch (err) {
      if (claimed) await clearPostClaim(feed.id, eventKey);
      throw err;
    }
  }
}

function battleNotifyCutoff(feed: DiscordFeedRow): Date {
  const filters = feedFilters(feed);
  if (filters.notifyAfter) {
    const stamped = new Date(filters.notifyAfter);
    if (!Number.isNaN(stamped.getTime())) return stamped;
  }
  return feed.createdAt;
}

export async function emitBattleIngested(
  region: AlbionRegion,
  albionBattleId: number,
  hint?: BattleSnapshot
): Promise<void> {
  if (!isDiscordEnabled()) return;
  if (!Number.isFinite(albionBattleId) || albionBattleId <= 0) return;

  const feeds = await findMatchingBattleFeeds({ region });
  if (feeds.length === 0) return;

  const snapshot = hint ?? null;
  for (const feed of feeds) {
    if (!feed.channelId) continue;
    const filters = feedFilters(feed);
    if (filters.paused) continue;
    if (snapshot) {
      const minPlayers = filters.minPlayers ?? DEFAULT_BATTLE_FEED_MIN_PLAYERS;
      if (snapshot.totalPlayers < minPlayers) continue;
      if (!guildInBattle(snapshot, feed.targetAlbionId, feed.targetName)) {
        continue;
      }
      const occurredAt = snapshot.startTime ?? snapshot.endTime;
      if (occurredAt && occurredAt < battleNotifyCutoff(feed)) continue;
    }
    await enqueueNotifyDiscordBattle({
      feedId: feed.id,
      region,
      battleId: albionBattleId,
    });
  }
}
