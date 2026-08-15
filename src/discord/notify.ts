import type { AlbionRegion } from "@aotracker/core/albion/types";
import { isDiscordEnabled } from "./enabled";
import { getFeedById, hasPostedMessage } from "./db";
import { loadKillSnapshot } from "./kill-data";
import { postKillToFeed } from "./poster";
import { killEventKey } from "./types";

export async function handleNotifyDiscord(payload: {
  region?: AlbionRegion;
  eventId?: number;
  feedId?: string;
}): Promise<void> {
  if (!isDiscordEnabled()) return;
  if (!payload.region || payload.eventId == null || !payload.feedId) {
    throw new Error("notify-discord requires region, eventId, and feedId");
  }

  const feed = await getFeedById(payload.feedId);
  if (!feed || feed.enabled !== 1 || !feed.channelId) return;

  const eventKey = killEventKey(payload.region, payload.eventId);
  if (await hasPostedMessage(feed.id, eventKey)) return;

  const snapshot = await loadKillSnapshot(payload.region, payload.eventId);
  if (!snapshot?.detailSyncedAt) {
    throw new Error(
      `Kill ${payload.region}/${payload.eventId} is not in Postgres yet`
    );
  }
  if ((snapshot.totalVictimKillFame ?? 0) <= 0) return;

  await postKillToFeed({
    feedId: feed.id,
    feedType: feed.feedType,
    channelId: feed.channelId,
    eventKey,
    snapshot,
  });
}
