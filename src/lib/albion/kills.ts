/**
 * Kill fame helpers — mirror {@link hasBattleKillFame} for events.
 *
 * Albion victim kill fame tracks dropped inventory value. Zero-fame kills are
 * usually empty-bag / protected-gear deaths (e.g. The Depths) and are excluded
 * from public kill lists and aggregates.
 */

/** Kills with no victim kill fame are noise on public lists. */
export function hasKillFame(event: {
  totalVictimKillFame?: number | null;
}): boolean {
  return (event.totalVictimKillFame ?? 0) > 0;
}
