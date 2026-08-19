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
