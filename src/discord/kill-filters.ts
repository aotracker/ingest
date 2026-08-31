import type { KillSnapshot } from "./kill-data";
import { estimateItemsSilver } from "./silver";
import { parseFilters } from "./types";

export type FeedFilterSource = {
  createdAt: Date;
  filters: unknown;
};

export function notifyCutoff(feed: FeedFilterSource): Date {
  const filters = parseFilters(feed.filters);
  if (filters.notifyAfter) {
    const stamped = new Date(filters.notifyAfter);
    if (!Number.isNaN(stamped.getTime())) return stamped;
  }
  return feed.createdAt;
}

export type KillSyncFilterInput = {
  fame: number;
  occurredAt: Date;
  contentType?: string | null;
};

/** Sync gates only — silver stays on the poster/replay path. */
export function feedPassesSyncFilters(
  feed: FeedFilterSource,
  input: KillSyncFilterInput
): { ok: true } | { ok: false; reason: string } {
  const filters = parseFilters(feed.filters);
  if (filters.paused) return { ok: false, reason: "paused" };

  if (filters.minFame != null && input.fame < filters.minFame) {
    return { ok: false, reason: "min-fame" };
  }

  if (
    filters.contentTypes?.length &&
    input.contentType &&
    !filters.contentTypes.includes(input.contentType)
  ) {
    return { ok: false, reason: "content-type" };
  }

  if (input.occurredAt < notifyCutoff(feed)) {
    return { ok: false, reason: "notify-after" };
  }

  return { ok: true };
}

export async function killMeetsFeedFilters(
  feed: FeedFilterSource & { region?: string },
  snapshot: KillSnapshot
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (snapshot.isOrangeZone) return { ok: false, reason: "orange-zone" };

  const sync = feedPassesSyncFilters(feed, {
    fame: snapshot.totalVictimKillFame ?? 0,
    occurredAt: snapshot.occurredAt,
    contentType: snapshot.contentType,
  });
  if (!sync.ok) return sync;

  const filters = parseFilters(feed.filters);
  if (filters.minSilver != null && filters.minSilver > 0) {
    const silver = await estimateItemsSilver(snapshot.region, snapshot.items);
    if (silver < filters.minSilver) {
      return { ok: false, reason: "min-silver" };
    }
  }

  return { ok: true };
}
