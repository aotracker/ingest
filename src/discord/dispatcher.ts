import type { AlbionEvent, AlbionRegion } from "@aotracker/core/albion/types";
import { isDiscordEnabled } from "./enabled";
import {
  feedFilters,
  findMatchingFeedsForKill,
  tryClaimPost,
  type DiscordFeedRow,
} from "./db";
import { enqueueNotifyDiscord } from "./jobs";
import { FEED_GUILD_DEATHS, FEED_GUILD_KILLS, killEventKey } from "./types";

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
  occurredAt: Date
): boolean {
  const filters = feedFilters(feed);
  if (filters.paused) return false;
  if (filters.minFame != null && fame < filters.minFame) return false;
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

  const eventKey = killEventKey(region, event.EventId);

  for (const feed of matches) {
    if (!feed.channelId) continue;
    if (!passesFilters(feed, fame, occurredAt)) continue;
    const claimed = await tryClaimPost(feed.id, eventKey);
    if (!claimed) continue;
    await enqueueNotifyDiscord({
      feedId: feed.id,
      region,
      eventId: event.EventId,
    });
  }
}
