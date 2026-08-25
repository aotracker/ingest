import type { KillSnapshot } from "./kill-data";
import { estimateItemsSilver } from "./silver";
import { feedFilters, type DiscordFeedRow } from "./db";

export async function killMeetsFeedFilters(
  feed: DiscordFeedRow,
  snapshot: KillSnapshot
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const filters = feedFilters(feed);
  if (filters.paused) return { ok: false, reason: "paused" };

  const fame = snapshot.totalVictimKillFame ?? 0;
  if (filters.minFame != null && fame < filters.minFame) {
    return { ok: false, reason: "min-fame" };
  }

  if (
    filters.contentTypes?.length &&
    snapshot.contentType &&
    !filters.contentTypes.includes(snapshot.contentType)
  ) {
    return { ok: false, reason: "content-type" };
  }

  if (filters.minSilver != null && filters.minSilver > 0) {
    const silver = await estimateItemsSilver(snapshot.region, snapshot.items);
    if (silver < filters.minSilver) {
      return { ok: false, reason: "min-silver" };
    }
  }

  return { ok: true };
}
