export type PriceKey = `${string}:${number}`;

export function priceKey(itemId: string, quality: number): PriceKey {
  return `${itemId}:${quality}`;
}

export interface AodpPriceRow {
  item_id: string;
  city: string;
  quality: number;
  sell_price_min: number;
  sell_price_min_date?: string;
  sell_price_max?: number;
  buy_price_min?: number;
  buy_price_max?: number;
}

/** Drop sell orders this many times above that city's buy order (troll 100m listings). */
const SELL_TO_BUY_OUTLIER_RATIO = 20;
/** Drop city sells this many times above the 25th percentile of the remaining sells. */
const P25_OUTLIER_RATIO = 10;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function rejectCityOutliers(prices: number[]): number[] {
  if (prices.length < 2) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25);
  if (p25 <= 0) return prices;
  const cap = p25 * P25_OUTLIER_RATIO;
  const kept = prices.filter((price) => price <= cap);
  return kept.length > 0 ? kept : prices;
}

/**
 * Typical unit silver across locations, keyed by item+quality.
 * Uses median of non-zero sell orders after dropping troll listings
 * (e.g. Thetford 100m Adept's Rune vs 7–12 silver elsewhere).
 */
export function aggregateUnitPrices(
  rows: AodpPriceRow[]
): Map<PriceKey, number> {
  const sells = new Map<PriceKey, number[]>();
  const buys = new Map<PriceKey, number[]>();

  for (const row of rows) {
    const key = priceKey(row.item_id, row.quality);
    const sell = row.sell_price_min;
    const buy = row.buy_price_max ?? 0;

    if (Number.isFinite(buy) && buy > 0) {
      const list = buys.get(key) ?? [];
      list.push(buy);
      buys.set(key, list);
    }

    if (!Number.isFinite(sell) || sell <= 0) continue;
    if (buy > 0 && sell > buy * SELL_TO_BUY_OUTLIER_RATIO) continue;

    const list = sells.get(key) ?? [];
    list.push(sell);
    sells.set(key, list);
  }

  const result = new Map<PriceKey, number>();
  const keys = new Set([...sells.keys(), ...buys.keys()]);
  for (const key of keys) {
    const filteredSells = rejectCityOutliers(sells.get(key) ?? []);
    if (filteredSells.length > 0) {
      result.set(key, Math.round(median(filteredSells)));
      continue;
    }
    const buyList = buys.get(key) ?? [];
    if (buyList.length > 0) {
      result.set(key, Math.round(median(buyList)));
    }
  }
  return result;
}
