/**
 * Store estimated victim-inventory silver on kill_events, backfill from
 * kill_items + item_market_prices, then add the juicy-kills partial index.
 * Usage: npm run db:apply-kill-loot-silver (from ingest/, OVH VM or local)
 */
import postgres from "postgres";

const BACKFILL_BATCH = 2000;
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "loot_est_silver" bigint
    `);
    console.log("kill_events.loot_est_silver ready.");

    if (reprice) {
      const reset = await sql.unsafe(`
        UPDATE kill_events ke
        SET loot_est_silver = NULL
        WHERE ke.detail_evicted_at IS NULL
          AND ke.occurred_at >= NOW() - INTERVAL '40 days'
          AND EXISTS (
            SELECT 1
            FROM kill_items ki
            WHERE ki.event_id = ke.id
              AND ki.owner_role = 'victim'
              AND ki.category = 'inventory'
          )
      `);
      console.log(`loot silver reprice: reset ${reset.count} rows`);
    }

    let backfilled = 0;
    for (;;) {
      const updated = await sql.unsafe(`
        WITH batch AS (
          SELECT ke.id
          FROM kill_events ke
          WHERE ke.loot_est_silver IS NULL
            AND ke.detail_evicted_at IS NULL
            AND ke.occurred_at >= NOW() - INTERVAL '40 days'
            AND EXISTS (
              SELECT 1
              FROM kill_items ki
              WHERE ki.event_id = ke.id
                AND ki.owner_role = 'victim'
                AND ki.category = 'inventory'
            )
          ORDER BY ke.occurred_at DESC
          LIMIT ${BACKFILL_BATCH}
        ),
        priced AS (
          SELECT
            batch.id,
            COALESCE(SUM(
              COALESCE(ki.count, 1) * COALESCE(imp.unit_price, imp_q1.unit_price, 0)
            ), 0)::bigint AS total
          FROM batch
          LEFT JOIN kill_items ki
            ON ki.event_id = batch.id
            AND ki.owner_role = 'victim'
            AND ki.category = 'inventory'
          LEFT JOIN kill_events ke
            ON ke.id = batch.id
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
          GROUP BY batch.id
        )
        UPDATE kill_events ke
        SET loot_est_silver = priced.total
        FROM priced
        WHERE ke.id = priced.id
        RETURNING ke.id
      `);
      const count = updated.length;
      if (count === 0) break;
      backfilled += count;
      console.log(`loot silver backfill: ${backfilled} rows`);
    }

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
