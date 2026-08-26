/**
 * Store estimated victim-inventory silver on kill_events, backfill from
 * kill_items + item_market_prices, then add the juicy-kills partial index.
 *
 * Walks 1-hour slices (newest first) so each UPDATE uses occurred_at range
 * scans instead of re-finding NULL rows from "now" every batch.
 *
 * Usage (from ingest/, OVH VM or local):
 *   npm run db:apply-kill-loot-silver
 *   npm run db:reprice-loot-silver
 */
import postgres from "postgres";

const LOOKBACK_HOURS = 40 * 24;
const HOUR_MS = 60 * 60 * 1000;
const reprice = process.argv.includes("--reprice");

async function createIndex(sql: postgres.Sql, statement: string) {
  try {
    await sql.unsafe(statement);
  } catch (err) {
    const msg = String(err);
    if (/concurrently/i.test(msg) && /transaction/i.test(msg)) {
      await sql.unsafe(statement.replace(/CONCURRENTLY\s+/i, ""));
      return;
    }
    throw err;
  }
}

async function priceHour(
  sql: postgres.Sql,
  hourStart: Date,
  hourEnd: Date,
  onlyNull: boolean
) {
  return sql<{ id: string }[]>`
    WITH priced AS (
      SELECT
        ke.id,
        COALESCE(SUM(
          COALESCE(ki.count, 1) * COALESCE(imp.unit_price, imp_q1.unit_price, 0)
        ), 0)::bigint AS total
      FROM kill_events ke
      LEFT JOIN kill_items ki
        ON ki.event_id = ke.id
        AND ki.owner_role = 'victim'
        AND ki.category = 'inventory'
      LEFT JOIN item_market_prices imp
        ON imp.region = ke.region
        AND imp.item_id = ki.item_type
        AND imp.quality = GREATEST(
          1,
          LEAST(5, COALESCE(NULLIF(ki.quality, 0), 1))
        )
      LEFT JOIN item_market_prices imp_q1
        ON imp_q1.region = ke.region
        AND imp_q1.item_id = ki.item_type
        AND imp_q1.quality = 1
      WHERE ke.detail_evicted_at IS NULL
        AND ke.occurred_at >= ${hourStart}
        AND ke.occurred_at < ${hourEnd}
        AND (${onlyNull} = false OR ke.loot_est_silver IS NULL)
      GROUP BY ke.id
    )
    UPDATE kill_events ke
    SET loot_est_silver = priced.total
    FROM priced
    WHERE ke.id = priced.id
    RETURNING ke.id
  `;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`SET statement_timeout = 0`);
    await sql.unsafe(`
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "loot_est_silver" bigint
    `);
    console.log("kill_events.loot_est_silver ready.");

    const [{ end_at: windowEnd }] = await sql<[{ end_at: Date }]>`
      SELECT date_trunc('hour', NOW()) + INTERVAL '1 hour' AS end_at
    `;
    const windowStart = new Date(windowEnd.getTime() - LOOKBACK_HOURS * HOUR_MS);
    const onlyNull = !reprice;
    let backfilled = 0;
    let hours = 0;

    if (reprice) {
      console.log(
        `loot silver reprice: ${LOOKBACK_HOURS} hour slices, newest first`
      );
    }

    for (
      let hourEnd = windowEnd;
      hourEnd > windowStart;
      hourEnd = new Date(hourEnd.getTime() - HOUR_MS)
    ) {
      const hourStart = new Date(
        Math.max(windowStart.getTime(), hourEnd.getTime() - HOUR_MS)
      );
      const updated = await priceHour(sql, hourStart, hourEnd, onlyNull);
      hours += 1;
      backfilled += updated.length;
      if (updated.length > 0 || hours % 24 === 0) {
        console.log(
          `loot silver backfill: ${backfilled} rows through ${hourStart.toISOString()} (${hours}/${LOOKBACK_HOURS}h)`
        );
      }
    }

    console.log(`loot silver backfill done: ${backfilled} rows`);

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_juicy_occurred_idx"
        ON "kill_events" ("occurred_at", "event_id")
        WHERE "total_victim_kill_fame" > 0
          AND "loot_est_silver" >= 20000000
      `
    );
    console.log("kill_events_juicy_occurred_idx applied.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
