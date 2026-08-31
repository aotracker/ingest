/**
 * Kill fame helpers — mirror {@link hasBattleKillFame} for events.
 *
 * In lethal PvP, victim kill fame includes dropped gear. In orange PvP it is
 * inventory-only. Zero-fame kills (empty bags) are excluded from public lists;
 * orange kills with bag loot are excluded separately via `isOrangeZone`.
 */

/** Kills with no victim kill fame are noise on public lists. */
export function hasKillFame(event: {
  totalVictimKillFame?: number | null;
}): boolean {
  return (event.totalVictimKillFame ?? 0) > 0;
}

/** Public kill feeds hide orange-zone (inventory-only) deaths. */
export function isPublicKillFeedEvent(event: {
  totalVictimKillFame?: number | null;
  isOrangeZone?: boolean | null;
}): boolean {
  return hasKillFame(event) && event.isOrangeZone !== true;
}
