/**
 * Re-fetch AODP prices into item_market_prices using median aggregation
 * (drops troll sell orders like Thetford 100m T4_RUNE).
 * Usage (from ingest/):
 *   npm run db:refresh-item-market-prices
 *   npm run db:refresh-item-market-prices -- --region=europe,asia
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
const BATCH_DELAY_MS = 400;
const REGION_DELAY_MS = 8_000;
const MAX_RETRIES = 8;

function parseRegionFilter(): string[] | null {
  const arg = process.argv.find((entry) => entry.startsWith("--region="));
  if (!arg) return null;
  return arg
    .slice("--region=".length)
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const fromHeader = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return Math.min(fromHeader * 1000, 120_000);
  }
  return Math.min(5_000 * 2 ** attempt, 60_000);
}

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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const data = (await response.json()) as unknown;
      return Array.isArray(data) ? (data as AodpPriceRow[]) : [];
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`AODP HTTP ${response.status}: ${response.statusText}`);
    }
    const waitMs = retryDelayMs(attempt, response.headers.get("retry-after"));
    console.log(
      `AODP ${response.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(waitMs / 1000)}s`
    );
    await sleep(waitMs);
  }
  throw new Error("AODP retries exhausted");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const regionFilter = parseRegionFilter();
  const sql = postgres(url, { max: 1 });
  try {
    const regions = Object.keys(AODP_BASE_URLS).filter(
      (region) => !regionFilter || regionFilter.includes(region)
    );
    if (regions.length === 0) {
      throw new Error(
        `No matching regions. Use --region=americas,europe,asia (got ${regionFilter?.join(",") ?? ""})`
      );
    }

    for (const [index, region] of regions.entries()) {
      if (index > 0) await sleep(REGION_DELAY_MS);

      const itemRows = await sql<{ item_id: string }[]>`
        SELECT DISTINCT item_id
        FROM item_market_prices
        WHERE region = ${region}
      `;
      const itemIds = itemRows.map((row) => row.item_id).filter(Boolean);
      if (itemIds.length === 0) continue;

      const baseUrl = AODP_BASE_URLS[region];
      const allRows: AodpPriceRow[] = [];
      const batches = batchItemIds(baseUrl, itemIds, QUALITIES);
      for (const [batchIndex, batch] of batches.entries()) {
        if (batchIndex > 0) await sleep(BATCH_DELAY_MS);
        allRows.push(...(await fetchBatch(baseUrl, batch)));
      }

      const prices = aggregateUnitPrices(allRows);
      const updatedAt = new Date();
      const upserts = [...prices.entries()].map(([key, unitPrice]) => {
        const sep = key.lastIndexOf(":");
        return {
          region,
          item_id: key.slice(0, sep),
          quality: parseInt(key.slice(sep + 1), 10),
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
