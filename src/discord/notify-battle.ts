import type { AlbionRegion } from "@aotracker/core/albion/types";
import { isDiscordEnabled } from "./enabled";
import {
  clearPostClaim,
  feedFilters,
  getFeedById,
  getPostedMessage,
  tryClaimPost,
  upsertPostedMessage,
} from "./db";
import {
  battleFingerprint,
  guildInBattle,
  loadBattleSnapshot,
} from "./battle-data";
import { isBattleSettled, remainingBattleSettleMs } from "./battle-settle";
import { postBattleToFeed } from "./battle-poster";
import { enqueueNotifyDiscordBattle } from "./jobs";
import {
  DEFAULT_BATTLE_FEED_MIN_PLAYERS,
  battleEventKey,
  battleFingerprintKey,
  battleSeenKey,
  battleThreadKey,
  isPostedDiscordMessageId,
  skippedFilterMessageId,
} from "./types";
import { notifyCutoff } from "./kill-filters";

async function rememberFingerprint(
  feedId: string,
  fpKey: string,
  seenKey: string,
  fingerprint: string,
  previousFp: string | null
): Promise<string> {
  if (previousFp === fingerprint) {
    const seenAt = await getPostedMessage(feedId, seenKey);
    if (seenAt) return seenAt;
  }
  const seenAt = new Date().toISOString();
  await upsertPostedMessage(feedId, fpKey, fingerprint);
  await upsertPostedMessage(feedId, seenKey, seenAt);
  return seenAt;
}

async function refreshBattleListFromAlbion(
  region: AlbionRegion,
  battleId: number
): Promise<void> {
  try {
    const { getAlbionClient } = await import("@aotracker/core/albion/client");
    const { upsertBattleFromRecentList } = await import(
      "@aotracker/core/db/battle-cache"
    );
    const battle = await getAlbionClient().getBattle(region, battleId);
    if (battle) await upsertBattleFromRecentList(region, battle);
  } catch (err) {
    console.warn(
      `[discord] battle recap refresh skipped for ${region}/${battleId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export async function handleNotifyDiscordBattle(payload: {
  region?: AlbionRegion;
  battleId?: number;
  feedId?: string;
}): Promise<void> {
  if (!isDiscordEnabled()) return;
  if (!payload.region || payload.battleId == null || !payload.feedId) {
    throw new Error("notify-discord battle requires region, battleId, and feedId");
  }

  const feed = await getFeedById(payload.feedId);
  if (!feed || feed.enabled !== 1 || !feed.channelId) return;

  let snapshot = await loadBattleSnapshot(payload.region, payload.battleId);
  if (!snapshot) {
    throw new Error(
      `Battle ${payload.region}/${payload.battleId} is not in Postgres yet`
    );
  }

  const filters = feedFilters(feed);
  if (filters.paused) return;

  const tracked = guildInBattle(
    snapshot,
    feed.targetAlbionId,
    feed.targetName
  );
  if (!tracked) return;

  const minPlayers = filters.minPlayers ?? DEFAULT_BATTLE_FEED_MIN_PLAYERS;
  if (snapshot.totalPlayers < minPlayers) return;

  const occurredAt = snapshot.startTime ?? snapshot.endTime;
  if (occurredAt && occurredAt < notifyCutoff(feed)) {
    const eventKey = battleEventKey(payload.region, payload.battleId);
    await upsertPostedMessage(
      feed.id,
      eventKey,
      skippedFilterMessageId("too-old")
    );
    return;
  }

  const eventKey = battleEventKey(payload.region, payload.battleId);
  const fpKey = battleFingerprintKey(payload.region, payload.battleId);
  const seenKey = battleSeenKey(payload.region, payload.battleId);
  const threadKey = battleThreadKey(payload.region, payload.battleId);
  const existingMessageId = await getPostedMessage(feed.id, eventKey);
  if (existingMessageId?.startsWith("skipped:")) return;
  if (isPostedDiscordMessageId(existingMessageId)) return;

  let fingerprint = battleFingerprint(snapshot);
  const previousFp = await getPostedMessage(feed.id, fpKey);
  let seenAt = await rememberFingerprint(
    feed.id,
    fpKey,
    seenKey,
    fingerprint,
    previousFp
  );

  if (!isBattleSettled(seenAt)) {
    await enqueueNotifyDiscordBattle({
      feedId: feed.id,
      region: payload.region,
      battleId: payload.battleId,
      delayMs: remainingBattleSettleMs(seenAt) + 2_000,
    });
    return;
  }

  await refreshBattleListFromAlbion(payload.region, payload.battleId);
  snapshot = (await loadBattleSnapshot(payload.region, payload.battleId)) ?? snapshot;
  if (!guildInBattle(snapshot, feed.targetAlbionId, feed.targetName)) return;
  if (snapshot.totalPlayers < minPlayers) return;
  fingerprint = battleFingerprint(snapshot);
  seenAt = await rememberFingerprint(
    feed.id,
    fpKey,
    seenKey,
    fingerprint,
    await getPostedMessage(feed.id, fpKey)
  );
  if (!isBattleSettled(seenAt)) {
    await enqueueNotifyDiscordBattle({
      feedId: feed.id,
      region: payload.region,
      battleId: payload.battleId,
      delayMs: remainingBattleSettleMs(seenAt) + 2_000,
    });
    return;
  }

  const claimed = await tryClaimPost(feed.id, eventKey);
  if (!claimed) return;

  try {
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
  } catch (err) {
    await clearPostClaim(feed.id, eventKey);
    throw err;
  }
}
