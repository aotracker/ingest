import type { AlbionRegion } from "@aotracker/core/albion/types";
import { enqueueJob } from "../jobs/enqueue";
import { QUEUE_NAMES } from "../jobs/types";

export async function enqueueNotifyDiscord(input: {
  feedId: string;
  region: AlbionRegion;
  eventId: number;
}): Promise<void> {
  await enqueueJob({
    queue: QUEUE_NAMES.DISCORD,
    name: "notify-discord",
    dedupeKey: `notify-discord-${input.feedId}-${input.region}-${input.eventId}`,
    payload: {
      region: input.region,
      eventId: input.eventId,
      feedId: input.feedId,
    },
    maxAttempts: 5,
  });
}

export async function enqueueNotifyDiscordBattle(input: {
  feedId: string;
  region: AlbionRegion;
  battleId: number;
  delayMs?: number;
}): Promise<void> {
  const delayMs = input.delayMs ?? 0;
  await enqueueJob({
    queue: QUEUE_NAMES.DISCORD,
    name: "notify-discord",
    dedupeKey:
      delayMs > 0
        ? `notify-discord-battle-wait-${input.feedId}-${input.region}-${input.battleId}-${Date.now()}`
        : `notify-discord-battle-${input.feedId}-${input.region}-${input.battleId}`,
    payload: {
      region: input.region,
      battleId: input.battleId,
      feedId: input.feedId,
    },
    delayMs,
    maxAttempts: 5,
  });
}

export async function enqueueNotifyDiscordLive(input: {
  channelId: string;
  startedAt: string;
}): Promise<void> {
  await enqueueJob({
    queue: QUEUE_NAMES.DISCORD,
    name: "notify-discord-live",
    dedupeKey: `notify-discord-live-${input.channelId}-${input.startedAt}`,
    payload: {
      twitchChannelId: input.channelId,
      streamStartedAt: input.startedAt,
    },
    maxAttempts: 5,
  });
}
