import type { AlbionRegion } from "@aotracker/core/albion/types";

export const QUEUE_NAMES = {
  INGEST: "ingest",
  REFRESH: "refresh",
  SCHEDULER: "scheduler",
} as const;

export type JobQueue = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type JobPayload = {
  region?: AlbionRegion;
  albionId?: string;
  guildId?: string;
  allianceId?: string;
  eventId?: number;
  battleId?: number;
  /** When true, sync-guild refreshes profile, top kills, and top battles. */
  force?: boolean;
  /** Soft circuit defer count (does not burn attempts until the cap). */
  circuitDefers?: number;
  /** Soft "Albion not ready yet" defer count for sync-battle. */
  notReadyDefers?: number;
  /** Epoch ms when the first BattleNotReady soft-defer happened. */
  notReadySince?: number;
  /** Set when a user-facing page/retry asked to run this job ASAP. */
  userPromoted?: boolean;
};

export interface EnqueueJobInput {
  dedupeKey: string;
  queue: JobQueue;
  name: string;
  payload?: JobPayload;
  delayMs?: number;
  maxAttempts?: number;
}

/** Maps BullMQ job state to labels used by the status UI. */
export function toLegacyJobState(
  state: string | null | undefined,
  delayedUntil?: number | null
): string | null {
  if (!state) return null;
  if (state === "active") return "active";
  if (state === "failed") return "failed";
  if (state === "completed") return "completed";
  if (state === "delayed") return "delayed";
  if (state === "waiting" || state === "prioritized") {
    return delayedUntil != null && delayedUntil > Date.now() ? "delayed" : "waiting";
  }
  return null;
}

export function isActiveJobState(state: string | null | undefined): boolean {
  return state === "waiting" || state === "delayed" || state === "active";
}
