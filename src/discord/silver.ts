import { and, eq, inArray } from "drizzle-orm";
import type { AlbionRegion } from "@aotracker/core/albion/types";
import { db, schema } from "@aotracker/core/db";
import { itemIconIdentifier, normalizeItemQuality } from "./format";
import type { KillSnapshotItem } from "./kill-data";

function priceKey(itemId: string, quality: number): string {
  return `${itemId}:${quality}`;
}

/** Postgres cache only — Discord never calls AODP or Albion. */
export async function estimateItemsSilver(
  region: AlbionRegion,
  items: KillSnapshotItem[]
): Promise<number> {
  if (items.length === 0) return 0;

  const lookups = items.map((item) => ({
    itemId: itemIconIdentifier(item.itemType),
    quality: normalizeItemQuality(item.quality),
    count: Math.max(item.count ?? 1, 1),
  }));

  const itemIds = [...new Set(lookups.map((l) => l.itemId))];
  const cached = await db
    .select()
    .from(schema.itemMarketPrices)
    .where(
      and(
        eq(schema.itemMarketPrices.region, region),
        inArray(schema.itemMarketPrices.itemId, itemIds)
      )
    );

  const prices = new Map<string, number>();
  for (const row of cached) {
    prices.set(priceKey(row.itemId, row.quality), row.unitPrice);
  }

  let total = 0;
  for (const lookup of lookups) {
    let unit = prices.get(priceKey(lookup.itemId, lookup.quality)) ?? 0;
    if (unit <= 0 && lookup.quality !== 1) {
      unit = prices.get(priceKey(lookup.itemId, 1)) ?? 0;
    }
    if (unit > 0) total += unit * lookup.count;
  }
  return total;
}
