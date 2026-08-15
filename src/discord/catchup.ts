import { isDiscordEnabled } from "./enabled";
import { listActiveGuildFeedTargets, listPlayerAlbionIdsForGuild } from "./db";
import { ingestEvent } from "../ingest";
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

  let ingested = 0;
  for (const playerId of batch) {
    try {
      const { kills, deaths } = await fetchPlayerHistoryFromApi(
        target.region,
        playerId
      );
      for (const event of [...kills, ...deaths]) {
        const isNew = await ingestEvent(target.region, event, {
          fetchBattleDetail: false,
          notifyDiscord: true,
        });
        if (isNew) ingested += 1;
      }
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

  if (ingested > 0) {
    console.log(
      `[discord-catchup] ${target.region}/${target.targetAlbionId}: ${ingested} new event(s)`
    );
  }
}
