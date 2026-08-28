/**
 * Battles feed: slim feed_preview column + partial start_time index.
 * Backfills preview JSON from existing payloads so list queries can skip TOAST.
 * Re-run to rebuild rows whose stored preview has no guild/alliance names.
 * Usage: npm run db:apply-battles-feed-optimization (from ingest/, OVH VM or local)
 */
import postgres from "postgres";
import { withDatabaseUrl } from "./with-database-url";
import { buildBattlesFeedPreview } from "../../src/lib/db/battles-feed-preview";

const BACKFILL_BATCH = 200;

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
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "feed_preview" jsonb
    `);
    console.log("battles.feed_preview column ready.");

    let backfilled = 0;
    let lastId = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = await sql<
        { id: string; raw_payload: unknown; detail_payload: unknown }[]
      >`
        SELECT id, raw_payload, detail_payload
        FROM battles
        WHERE id > ${lastId}::uuid
          AND (raw_payload IS NOT NULL OR detail_payload IS NOT NULL)
          AND (
            feed_preview IS NULL
            OR (
              COALESCE(jsonb_array_length(feed_preview->'alliances'), 0) = 0
              AND COALESCE(jsonb_array_length(feed_preview->'guilds'), 0) = 0
            )
          )
        ORDER BY id
        LIMIT ${BACKFILL_BATCH}
      `;
      if (rows.length === 0) break;

      for (const row of rows) {
        const preview = buildBattlesFeedPreview(
          row.raw_payload,
          row.detail_payload
        );
        await sql`
          UPDATE battles
          SET feed_preview = ${preview as never}
          WHERE id = ${row.id}
        `;
      }
      lastId = rows[rows.length - 1].id;
      backfilled += rows.length;
      console.log(`feed_preview backfill: ${backfilled} rows`);
    }

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "battles_feed_start_time_idx"
        ON "battles" ("start_time" DESC NULLS LAST, "created_at" DESC)
        WHERE "total_fame" IS NOT NULL
          AND "total_kills" IS NOT NULL
          AND "total_players" >= 10
      `
    );
    console.log("battles_feed_start_time_idx applied.");
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
