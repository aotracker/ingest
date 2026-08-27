/**
 * Re-fetch AODP prices into item_market_prices using median aggregation
 * (drops troll sell orders like Thetford 100m T4_RUNE).
 * Usage: npm run db:refresh-item-market-prices (from ingest/)
 */
import postgres from "postgres";
import {
  aggregateUnitPrices,
  priceKey,
  type AodpPriceRow,
} from "../../src/lib/market/aggregate-unit-prices";

const AODP_BASE_URLS: Record<string, string> = {
  americas: "https://west.albion-online-data.com",
  europe: "https://europe.albion-online-data.com",
  asia: "https://east.albion-online-data.com",
};

const MAX_URL_LENGTH = 4096;
const QUALITIES = [1, 2, 3, 4, 5];

function buildPricesUrl(
  baseUrl: string,
  itemIds: string[],
  qualities: number[]
): string {
  const itemsPath = itemIds.map(encodeURIComponent).join(",");
  return `${baseUrl}/api/v2/stats/prices/${itemsPath}.json?qualities=${qualities.join(",")}`;
}

function batchItemIds(
  baseUrl: string,
  itemIds: string[],
  qualities: number[]
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const itemId of itemIds) {
    const candidate = [...current, itemId];
    const url = buildPricesUrl(baseUrl, candidate, qualities);
    if (url.length > MAX_URL_LENGTH && current.length > 0) {
      batches.push(current);
      current = [itemId];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function fetchBatch(
  baseUrl: string,
  itemIds: string[]
): Promise<AodpPriceRow[]> {
  const url = buildPricesUrl(baseUrl, itemIds, QUALITIES);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`AODP HTTP ${response.status}: ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as AodpPriceRow[]) : [];
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    const regions = Object.keys(AODP_BASE_URLS);
    for (const region of regions) {
      const itemRows = await sql<{ item_id: string }[]>`
        SELECT DISTINCT item_id
        FROM item_market_prices
        WHERE region = ${region}
      `;
      const itemIds = itemRows.map((row) => row.item_id).filter(Boolean);
      if (itemIds.length === 0) continue;

      const baseUrl = AODP_BASE_URLS[region];
      const allRows: AodpPriceRow[] = [];
      for (const batch of batchItemIds(baseUrl, itemIds, QUALITIES)) {
        allRows.push(...(await fetchBatch(baseUrl, batch)));
      }

      const prices = aggregateUnitPrices(allRows);
      const updatedAt = new Date();
      const upserts = [...prices.entries()].map(([key, unitPrice]) => {
        const [itemId, qualityStr] = key.split(":");
        return {
          region,
          item_id: itemId,
          quality: parseInt(qualityStr, 10),
          unit_price: unitPrice,
          updated_at: updatedAt,
        };
      });

      if (upserts.length === 0) {
        console.log(`${region}: no AODP prices`);
        continue;
      }

      for (const row of upserts) {
        await sql`
          INSERT INTO item_market_prices (region, item_id, quality, unit_price, updated_at)
          VALUES (${row.region}, ${row.item_id}, ${row.quality}, ${row.unit_price}, ${row.updated_at})
          ON CONFLICT (region, item_id, quality)
          DO UPDATE SET
            unit_price = EXCLUDED.unit_price,
            updated_at = EXCLUDED.updated_at
        `;
      }

      const rune = prices.get(priceKey("T4_RUNE", 1));
      console.log(
        `${region}: upserted ${upserts.length} prices` +
          (rune != null ? ` (T4_RUNE=${rune})` : "")
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
