/**
 * Denormalize killer guild/alliance onto kill_events, backfill from JSONB,
 * then add covering indexes for guild/alliance leaderboards.
 * Usage: npm run db:apply-kill-leaderboard-columns (from ingest/, OVH VM or local)
 */
import postgres from "postgres";
import { withDatabaseUrl } from "./with-database-url";

const BACKFILL_BATCH = 2000;

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
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "killer_guild_albion_id" text;
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "killer_guild_name" text;
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "killer_alliance_albion_id" text;
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "killer_alliance_name" text
    `);
    console.log("kill_events killer guild/alliance columns ready.");

    let backfilled = 0;
    for (;;) {
      const updated = await sql.unsafe(`
        WITH batch AS (
          SELECT id
          FROM kill_events
          WHERE raw_payload IS NOT NULL
            AND killer_guild_albion_id IS NULL
            AND killer_alliance_albion_id IS NULL
            AND (
              NULLIF(BTRIM(raw_payload->'Killer'->>'GuildId'), '') IS NOT NULL
              OR NULLIF(BTRIM(raw_payload->'Killer'->>'AllianceId'), '') IS NOT NULL
            )
          LIMIT ${BACKFILL_BATCH}
        )
        UPDATE kill_events ke
        SET
          killer_guild_albion_id = NULLIF(BTRIM(ke.raw_payload->'Killer'->>'GuildId'), ''),
          killer_guild_name = NULLIF(BTRIM(ke.raw_payload->'Killer'->>'GuildName'), ''),
          killer_alliance_albion_id = NULLIF(BTRIM(ke.raw_payload->'Killer'->>'AllianceId'), ''),
          killer_alliance_name = NULLIF(BTRIM(ke.raw_payload->'Killer'->>'AllianceName'), '')
        FROM batch
        WHERE ke.id = batch.id
        RETURNING ke.id
      `);
      const count = updated.length;
      if (count === 0) break;
      backfilled += count;
      console.log(`killer org backfill: ${backfilled} rows`);
    }

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_lb_guild_idx"
        ON "kill_events" ("occurred_at" DESC, "killer_guild_albion_id", "region")
        INCLUDE ("total_victim_kill_fame", "killer_guild_name", "content_type")
        WHERE "total_victim_kill_fame" > 0 AND "killer_guild_albion_id" IS NOT NULL
      `
    );
    console.log("kill_events_lb_guild_idx applied.");

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_lb_alliance_idx"
        ON "kill_events" ("occurred_at" DESC, "killer_alliance_albion_id", "region")
        INCLUDE ("total_victim_kill_fame", "killer_alliance_name", "content_type")
        WHERE "total_victim_kill_fame" > 0 AND "killer_alliance_albion_id" IS NOT NULL
      `
    );
    console.log("kill_events_lb_alliance_idx applied.");
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
