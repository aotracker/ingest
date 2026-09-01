import type {
  AlbionEquipment,
  AlbionEvent,
  AlbionItem,
  AlbionPlayerRef,
  EquipmentSlot,
} from "./types";
import {
  computeRawItemPower,
  reportedItemPower,
} from "./item-power";

/**
 * Official Orange PvP (Depths + yellow-portal Ancient Lands): 1200 IP, 20% above cap.
 * Black Ancient Lands uses 35% — treat that curve as lethal, not orange.
 * Tolerance / min-gap from albion-killbot; prefer missing orange over hiding lethal kills.
 */
export const ORANGE_SOFTCAP = 1200;
export const ORANGE_SOFTCAP_RATE = 0.2;
export const LETHAL_ANCIENT_LANDS_SOFTCAP_RATE = 0.35;
export const SOFTCAP_TOLERANCE = 50;
export const SOFTCAP_MIN_GAP = 100;

/** Combat set must be at least this tier for the fame-vs-gear fallback. */
export const MIN_COMBAT_TIER = 5;

/** Ignore Path B unless equipped gear is worth at least this much silver. */
export const MIN_COMBAT_GEAR_SILVER = 500_000;

/**
 * Lethal kills almost always produce fame above gearSilver / this divisor.
 * Orange fame ignores equipped gear, so expensive sets can fall below it.
 */
export const LETHAL_FAME_GEAR_DIVISOR = 400;

export type OrangeZoneInput = {
  totalVictimKillFame?: number | null;
  lootEstSilver?: number | null;
  gearEstSilver?: number | null;
  killer?: AlbionPlayerRef | null;
  victim?: AlbionPlayerRef | null;
  participants?: AlbionPlayerRef[] | null;
};

export type KillItemLoadout = {
  ownerRole?: string | null;
  category?: string | null;
  slot?: string | null;
  itemType?: string | null;
  quality?: number | null;
};

function itemTier(type: string | null | undefined): number {
  if (!type) return 0;
  const match = type.match(/^T(\d)_/);
  return match ? Number(match[1]) : 0;
}

export function hasCombatSet(
  equipment: AlbionEquipment | null | undefined
): boolean {
  return (
    itemTier(equipment?.MainHand?.Type) >= MIN_COMBAT_TIER &&
    itemTier(equipment?.Armor?.Type) >= MIN_COMBAT_TIER
  );
}

function expectedCappedIp(raw: number, rate: number): number {
  return ORANGE_SOFTCAP + (raw - ORANGE_SOFTCAP) * rate;
}

export type SoftcapMatch = {
  orange: boolean;
  lethal: boolean;
};

/** Whether reported IP sits on the 1200/20% and/or 1200/35% curves. */
export function playerSoftcapMatch(
  player: AlbionPlayerRef | null | undefined
): SoftcapMatch {
  const none = { orange: false, lethal: false };
  const reported = reportedItemPower(player);
  const raw = computeRawItemPower(player?.Equipment);
  if (reported == null || raw == null || raw <= ORANGE_SOFTCAP) return none;
  if (raw - reported < SOFTCAP_MIN_GAP) return none;

  const expectedOrange = expectedCappedIp(raw, ORANGE_SOFTCAP_RATE);
  const expectedLethal = expectedCappedIp(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE);
  return {
    orange: Math.abs(reported - expectedOrange) <= SOFTCAP_TOLERANCE,
    lethal:
      Math.abs(reported - expectedLethal) <= SOFTCAP_TOLERANCE,
  };
}

/** Closer matching softcap rate, or null if neither curve fits. */
export function playerSoftcapRate(
  player: AlbionPlayerRef | null | undefined
): 0.2 | 0.35 | null {
  const reported = reportedItemPower(player);
  const raw = computeRawItemPower(player?.Equipment);
  if (reported == null || raw == null || raw <= ORANGE_SOFTCAP) return null;
  if (raw - reported < SOFTCAP_MIN_GAP) return null;

  const expectedOrange = expectedCappedIp(raw, ORANGE_SOFTCAP_RATE);
  const expectedLethal = expectedCappedIp(raw, LETHAL_ANCIENT_LANDS_SOFTCAP_RATE);
  const deltaOrange = Math.abs(reported - expectedOrange);
  const deltaLethal = Math.abs(reported - expectedLethal);
  const match = {
    orange: deltaOrange <= SOFTCAP_TOLERANCE,
    lethal: deltaLethal <= SOFTCAP_TOLERANCE,
  };

  if (match.lethal && (!match.orange || deltaLethal <= deltaOrange)) {
    return LETHAL_ANCIENT_LANDS_SOFTCAP_RATE;
  }
  if (match.orange) return ORANGE_SOFTCAP_RATE;
  return null;
}

function eventPlayers(input: OrangeZoneInput): AlbionPlayerRef[] {
  const players: AlbionPlayerRef[] = [];
  if (input.killer) players.push(input.killer);
  if (input.victim) players.push(input.victim);
  for (const participant of input.participants ?? []) {
    if (participant) players.push(participant);
  }
  return players;
}

export function fameLooksInventoryOnly(input: OrangeZoneInput): boolean {
  const fame = input.totalVictimKillFame ?? 0;
  const combatSet = hasCombatSet(input.victim?.Equipment);
  const gear = input.gearEstSilver ?? 0;

  if (fame <= 0) {
    return combatSet || gear >= MIN_COMBAT_GEAR_SILVER;
  }
  if (gear < MIN_COMBAT_GEAR_SILVER) return false;
  return fame < gear / LETHAL_FAME_GEAR_DIVISOR;
}

/**
 * Fame that cannot include equipped gear — bag loot only, gear still worn.
 * Empty-bag (fame 0) stays on {@link fameLooksInventoryOnly} so a 35% IP
 * match can still mark lethal empty drops as not orange.
 */
export function fameExcludesEquippedGear(input: OrangeZoneInput): boolean {
  const fame = input.totalVictimKillFame ?? 0;
  return fame > 0 && fameLooksInventoryOnly(input);
}

export function isOrangeZoneKill(input: OrangeZoneInput): boolean {
  const matches = eventPlayers(input).map(playerSoftcapMatch);
  const clearOrange = matches.some((m) => m.orange && !m.lethal);
  const clearLethal = matches.some((m) => m.lethal && !m.orange);

  // A unique 20% match wins even if another player is closer to 35%
  // inside the overlap window (reconstruction noise).
  if (clearOrange) return true;
  // Inventory-only fame vs expensive worn gear is stronger than a 35% veto.
  if (fameExcludesEquippedGear(input)) return true;
  if (clearLethal) return false;
  return fameLooksInventoryOnly(input);
}

export function isOrangeZoneEvent(event: AlbionEvent): boolean {
  return isOrangeZoneKill({
    totalVictimKillFame: event.TotalVictimKillFame,
    killer: event.Killer,
    victim: event.Victim,
    participants: event.Participants,
  });
}

export function equipmentFromKillItems(
  items: KillItemLoadout[],
  ownerRole: string
): AlbionEquipment {
  const equipment: AlbionEquipment = {};
  for (const item of items) {
    if (item.ownerRole && item.ownerRole !== ownerRole) continue;
    if (item.category && item.category !== "equipment") continue;
    const slot = item.slot as EquipmentSlot | undefined;
    const type = item.itemType?.trim();
    if (!slot || !type) continue;
    const equipped: AlbionItem = {
      Type: type,
      Quality: item.quality && item.quality > 0 ? item.quality : 1,
      Count: 1,
    };
    equipment[slot] = equipped;
  }
  return equipment;
}

export function playerRefFromLoadout(input: {
  averageItemPower?: number | string | null;
  items: KillItemLoadout[];
  ownerRole: string;
}): AlbionPlayerRef {
  const ip =
    typeof input.averageItemPower === "number"
      ? input.averageItemPower
      : typeof input.averageItemPower === "string"
        ? Number(input.averageItemPower)
        : null;
  return {
    AverageItemPower:
      ip != null && Number.isFinite(ip) ? ip : undefined,
    Equipment: equipmentFromKillItems(input.items, input.ownerRole),
  };
}
