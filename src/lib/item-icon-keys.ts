export function parseItemType(type: string): {
  baseName: string;
  tier: number;
  enchantment: number;
} {
  const [base, enchant] = type.split("@");
  const tierMatch = base.match(/T(\d+)/);
  return {
    baseName: base,
    tier: tierMatch ? parseInt(tierMatch[1], 10) : 0,
    enchantment: enchant ? parseInt(enchant, 10) : 0,
  };
}

/** Albion quality: 1 Normal … 4 Excellent … 5 Masterpiece. */
export const ITEM_QUALITY_EXCELLENT = 4;

export function normalizeItemQuality(quality: number | null | undefined): number {
  const q = quality ?? 1;
  if (!Number.isFinite(q) || q < 1) return 1;
  if (q > 5) return 5;
  return Math.round(q);
}

/** Stable filename key for cached PNGs (tier/enchant/quality). */
export function itemIconCacheKey(
  type: string,
  quality: number | null | undefined = 1
): string {
  const { baseName, enchantment } = parseItemType(type);
  const q = normalizeItemQuality(quality);
  const enchantSuffix = enchantment > 0 ? `@${enchantment}` : "";
  return `${baseName}${enchantSuffix}_q${q}`;
}

export function itemIconIdentifier(type: string): string {
  const { baseName, enchantment } = parseItemType(type);
  return enchantment > 0 ? `${baseName}@${enchantment}` : baseName;
}
