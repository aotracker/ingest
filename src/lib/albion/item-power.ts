import type { AlbionEquipment, AlbionItem, AlbionPlayerRef } from "./types";
import itemPowerFile from "../../../data/item-power.json";

type ItemPowerCatalog = {
  items: Record<string, number>;
};

const CATALOG = itemPowerFile as ItemPowerCatalog;

/** Quality 1–5 → normal … masterpiece, added on top of base+enchant IP. */
export const QUALITY_BONUS: Record<number, number> = {
  1: 0,
  2: 20,
  3: 40,
  4: 60,
  5: 100,
};

/** Slots Albion averages for AverageItemPower (2H weapon fills OffHand). */
export const COMBAT_IP_SLOTS = [
  "MainHand",
  "OffHand",
  "Head",
  "Armor",
  "Shoes",
  "Cape",
] as const;

/**
 * Median raw−reported gap on uncapped events (killbot, ~500 samples).
 * Spec/mastery is not in the kill payload.
 */
export const MASTERY_BONUS_OFFSET = 157.8;

export function parseItemTypeId(
  type: string
): { baseId: string; enchant: number } | null {
  const match = type.match(/^(T\d_[A-Z0-9_]+?)(?:@(\d))?$/);
  if (!match?.[1]) return null;
  return { baseId: match[1], enchant: Number(match[2] || 0) };
}

function parseTraitItemPower(item: AlbionItem | null | undefined): number {
  const traits = item?.LegendarySoul?.traits;
  if (!traits?.length) return 0;
  return traits
    .filter((trait) => trait.trait === "TRAIT_ITEM_POWER")
    .reduce((sum, trait) => sum + (trait.value ?? 0), 0);
}

export function parseEquippedItemPower(
  item: AlbionItem | null | undefined
): number | null {
  if (!item?.Type) return null;
  const parsed = parseItemTypeId(item.Type);
  if (!parsed) return null;
  const basePower = CATALOG.items[parsed.baseId];
  if (basePower === undefined) return null;
  const qualityBonus = QUALITY_BONUS[item.Quality] ?? 0;
  return basePower + parsed.enchant * 100 + qualityBonus;
}

/** Uncompressed average IP for a loadout, matching killboard AverageItemPower. */
export function computeRawItemPower(
  equipment: AlbionEquipment | null | undefined
): number | null {
  if (!equipment) return null;

  const mainHand = equipment.MainHand;
  const isTwoHanded = Boolean(mainHand?.Type?.includes("2H"));

  let total = 0;
  let counted = 0;
  for (const slot of COMBAT_IP_SLOTS) {
    const item =
      slot === "OffHand" && !equipment.OffHand && isTwoHanded
        ? mainHand
        : equipment[slot];
    const power = parseEquippedItemPower(item ?? null);
    if (power === null) continue;
    total += power + parseTraitItemPower(item ?? null);
    counted += 1;
  }

  if (counted < COMBAT_IP_SLOTS.length) return null;
  return total / COMBAT_IP_SLOTS.length + MASTERY_BONUS_OFFSET;
}

export function reportedItemPower(
  player: AlbionPlayerRef | null | undefined
): number | null {
  const value = player?.AverageItemPower;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
