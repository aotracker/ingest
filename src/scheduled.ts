import { ENABLED_REGIONS } from "@aotracker/core/albion/types";
import { getAlbionClient } from "@aotracker/core/albion/client";
import { recordHealthCheck } from "@aotracker/core/db/api-state";
import {
  CircuitOpenError,
  isCircuitOpenError,
} from "@aotracker/core/db/api-state";
import {
  ingestRegionEvents,
  ingestRecentBattles,
  ensureSyncStates,
} from "./ingest";

export async function runIngestPoll(): Promise<void> {
  await ensureSyncStates();

  for (const region of ENABLED_REGIONS) {
    try {
      await ingestRegionEvents(region);
    } catch (err) {
      if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
        console.warn(`[ingest] ${region} events skipped — circuit open`);
      } else {
        console.error(`[ingest] ${region} events failed:`, err);
      }
    }

    try {
      await ingestRecentBattles(region);
    } catch (err) {
      if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
        console.warn(`[ingest] ${region} recent battles skipped — circuit open`);
      } else {
        console.error(`[ingest] ${region} recent battles failed:`, err);
      }
    }
  }
}

export async function runHealthChecks(): Promise<void> {
  const client = getAlbionClient();

  for (const region of ENABLED_REGIONS) {
    try {
      const result = await client.ping(region);
      await recordHealthCheck(region, {
        ok: result.ok,
        latencyMs: result.latencyMs,
        note: result.note,
        details: result.details,
      });
      if (!result.ok && result.note?.includes("Circuit open")) {
        console.warn(`[health] ${region} skipped — circuit open`);
      } else if (!result.ok) {
        console.warn(`[health] ${region} unreachable (${result.latencyMs}ms)`);
      }
    } catch (err) {
      if (isCircuitOpenError(err) || err instanceof CircuitOpenError) {
        console.warn(`[health] ${region} skipped — circuit open`);
        await recordHealthCheck(region, {
          ok: false,
          latencyMs: 0,
          note: "Circuit open — cooling down",
        }).catch(() => undefined);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[health] ${region} failed:`, message);
      await recordHealthCheck(region, {
        ok: false,
        latencyMs: 0,
        note: message,
      }).catch(() => undefined);
    }
  }
}
