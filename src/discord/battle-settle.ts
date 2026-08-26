import { BATTLE_SETTLE_MS } from "./types";

export function remainingBattleSettleMs(
  seenAtIso: string | null | undefined,
  nowMs = Date.now()
): number {
  if (!seenAtIso) return BATTLE_SETTLE_MS;
  const seen = Date.parse(seenAtIso);
  if (Number.isNaN(seen)) return BATTLE_SETTLE_MS;
  return Math.max(0, BATTLE_SETTLE_MS - (nowMs - seen));
}

export function isBattleSettled(
  seenAtIso: string | null | undefined,
  nowMs = Date.now()
): boolean {
  return remainingBattleSettleMs(seenAtIso, nowMs) <= 0;
}
