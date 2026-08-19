/** Per-job wall-clock cap so one hung sync cannot freeze the worker loop. */
export const DEFAULT_JOB_TIMEOUT_MS = 120_000;
export const JOB_TIMEOUT_MS: Record<string, number> = {
  "sync-battle": 90_000,
  "sync-player": 180_000,
  "refresh-player": 180_000,
  "backfill-player-history": 180_000,
  "sync-guild": 180_000,
  "refresh-guild": 180_000,
  "backfill-guild-top-kills": 180_000,
  "refresh-alliance": 180_000,
  "entity-resolve": 30_000,
  "live-search": 90_000,
  "ingest-event": 120_000,
  "notify-discord": 90_000,
};

export class JobTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(jobName: string, timeoutMs: number) {
    super(`Job timed out after ${timeoutMs}ms: ${jobName}`);
    this.name = "JobTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isJobTimeoutError(error: unknown): error is JobTimeoutError {
  return (
    error instanceof JobTimeoutError ||
    (error instanceof Error && error.name === "JobTimeoutError")
  );
}

export function jobTimeoutMs(name: string): number {
  return JOB_TIMEOUT_MS[name] ?? DEFAULT_JOB_TIMEOUT_MS;
}

/**
 * Soft-defer schedule when Albion has not published battle detail yet (404 / not ready).
 */
export const BATTLE_NOT_READY_DELAYS_MS = [
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  60 * 60_000,
  60 * 60_000,
  60 * 60_000,
] as const;
export const BATTLE_NOT_READY_MAX_DEFERS = BATTLE_NOT_READY_DELAYS_MS.length;
/** Show a delayed-API notice on the battle page after this much waiting. */
export const BATTLE_API_DELAY_NOTICE_MS = 60 * 60 * 1000;

export function battleNotReadyDelayMs(notReadyDefers: number): number {
  const index = Math.min(
    Math.max(0, notReadyDefers - 1),
    BATTLE_NOT_READY_DELAYS_MS.length - 1
  );
  return BATTLE_NOT_READY_DELAYS_MS[index];
}

/** Cap in-flight sync-battle jobs per worker so large ZvZs cannot starve everything else. */
export const MAX_SYNC_BATTLE_PER_BATCH = 2;
export const SYNC_BATTLE_OVERFLOW_DELAY_MS = 2_000;

/**
 * User promote will not shorten backoffs longer than this (circuit / Albion-not-ready).
 */
export const MAX_USER_PROMOTE_REMAINING_MS = 15_000;

export const WARM_SYNC_DELAY_MS = 2000;
export const BATTLE_DETAIL_SYNC_DELAY_MS = 5_000;

/** User-promoted jobs get higher priority (lower number = sooner). */
export const JOB_PRIORITY_DEFAULT = 10;
export const JOB_PRIORITY_PROMOTED = 1;

/** BullMQ rejects priorities outside 0..2^21-1. */
export const BULLMQ_PRIORITY_MIN = 0;
export const BULLMQ_PRIORITY_MAX = 2_097_151;

export function clampBullmqPriority(priority: number): number {
  if (!Number.isFinite(priority)) return JOB_PRIORITY_DEFAULT;
  return Math.min(
    BULLMQ_PRIORITY_MAX,
    Math.max(BULLMQ_PRIORITY_MIN, Math.round(priority))
  );
}
