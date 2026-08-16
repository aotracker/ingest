/** UI leaderboards / analytics / builds / guild activity lookback. */
export const UI_LOOKBACK_DAYS = 30;

/**
 * Full kill/battle JSON + hour-stat retention.
 * A few days past {@link UI_LOOKBACK_DAYS} so the weekly job cannot clip the UI window.
 */
export const RETAIN_FULL_DAYS = 35;

/** After this, compacted kill stubs are deleted. */
export const KILL_STUB_TTL_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export function retainFullCutoff(now = new Date()): Date {
  return new Date(now.getTime() - RETAIN_FULL_DAYS * DAY_MS);
}

export function uiLookbackCutoff(now = new Date()): Date {
  return new Date(now.getTime() - UI_LOOKBACK_DAYS * DAY_MS);
}

export function killStubTtlCutoff(now = new Date()): Date {
  return new Date(now.getTime() - KILL_STUB_TTL_DAYS * DAY_MS);
}

export function isWithinRetainFullWindow(
  occurredAt: Date,
  now = new Date()
): boolean {
  return occurredAt.getTime() >= retainFullCutoff(now).getTime();
}
