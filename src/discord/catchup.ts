import type { AlbionEvent } from "@aotracker/core/albion/types";
import { isDiscordEnabled } from "./enabled";
import { listActiveGuildFeedTargets, listPlayerAlbionIdsForGuild } from "./db";
import { ingestRegionEventBatch } from "../ingest";
import { sortEventsOldestFirst, uniqueEventsById } from "./order";
import { fetchPlayerHistoryFromApi } from "@aotracker/core/albion/player-history-api";
import {
  CircuitOpenError,
  isCircuitOpenError,
} from "@aotracker/core/db/api-state";

const MEMBERS_PER_GUILD = 4;
let cursor = 0;

export async function runDiscordGuildCatchup(): Promise<void> {
  if (!isDiscordEnabled()) return;

  const targets = await listActiveGuildFeedTargets();
  if (targets.length === 0) return;

  const target = targets[cursor % targets.length]!;
  cursor += 1;

  const memberIds = await listPlayerAlbionIdsForGuild(
    target.region,
    target.targetAlbionId,
    80
  );
  if (memberIds.length === 0) return;

  const start = (cursor * MEMBERS_PER_GUILD) % memberIds.length;
  const batch = [
    ...memberIds.slice(start, start + MEMBERS_PER_GUILD),
    ...memberIds.slice(
      0,
      Math.max(0, start + MEMBERS_PER_GUILD - memberIds.length)
    ),
  ].slice(0, MEMBERS_PER_GUILD);

  const events: AlbionEvent[] = [];
  for (const playerId of batch) {
    try {
      const { kills, deaths } = await fetchPlayerHistoryFromApi(
        target.region,
        playerId
      );
      events.push(...kills, ...deaths);
    } catch (err) {
      if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
        console.warn("[discord-catchup] skipped — circuit open");
        return;
      }
      console.warn(
        `[discord-catchup] ${target.region} player ${playerId} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const { ingested } = await ingestRegionEventBatch(
    target.region,
    sortEventsOldestFirst(uniqueEventsById(events)),
    {
      fetchBattleDetail: false,
      notifyDiscord: true,
      notifyExisting: true,
      logPrefix: "discord-catchup",
    }
  );

  if (ingested > 0) {
    console.log(
      `[discord-catchup] ${target.region}/${target.targetAlbionId}: ${ingested} new event(s)`
    );
  }
}
