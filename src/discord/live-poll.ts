import {
  ENABLED_REGIONS,
  type AlbionRegion,
} from "@aotracker/core/albion/types";
import { getAlbionClient } from "@aotracker/core/albion/client";
import {
  CircuitOpenError,
  isCircuitOpenError,
} from "@aotracker/core/db/api-state";
import { ingestEvent } from "../ingest";

export async function ingestLiveRegionEvents(
  region: AlbionRegion
): Promise<number> {
  const client = getAlbionClient();
  const events = await client.getRecentEvents(region, 50, 0);
  let ingested = 0;

  for (const event of events) {
    try {
      const isNew = await ingestEvent(region, event, {
        fetchBattleDetail: false,
        notifyDiscord: true,
      });
      if (isNew) ingested += 1;
    } catch (err) {
      if (isCircuitOpenError(err) || err instanceof CircuitOpenError) throw err;
      console.error(
        `[live-events] ${region} event ${event.EventId} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return ingested;
}

export async function runLiveEventsPoll(): Promise<void> {
  await Promise.all(
    ENABLED_REGIONS.map(async (region) => {
      try {
        const ingested = await ingestLiveRegionEvents(region);
        if (ingested > 0) {
          console.log(`[live-events] ${region}: ${ingested} new event(s)`);
        }
      } catch (err) {
        if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
          console.warn(`[live-events] ${region} skipped — circuit open`);
          return;
        }
        console.error(`[live-events] ${region} failed:`, err);
      }
    })
  );
}
