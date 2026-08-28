/**
 * Apply partial indexes for guild/alliance feud and guild rivals queries.
 * Usage: npm run db:apply-kill-feud-idx (from ingest/, OVH VM or local)
 */
import postgres from "postgres";
import { withDatabaseUrl } from "./with-database-url";

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
    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_feud_guild_idx"
        ON "kill_events" ("region", "killer_guild_albion_id", "victim_guild_albion_id", "occurred_at" DESC)
        WHERE "total_victim_kill_fame" > 0
          AND "killer_guild_albion_id" IS NOT NULL
          AND "victim_guild_albion_id" IS NOT NULL
      `
    );
    console.log("kill_events_feud_guild_idx applied.");

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_feud_alliance_idx"
        ON "kill_events" ("region", "killer_alliance_albion_id", "victim_alliance_albion_id", "occurred_at" DESC)
        WHERE "total_victim_kill_fame" > 0
          AND "killer_alliance_albion_id" IS NOT NULL
          AND "victim_alliance_albion_id" IS NOT NULL
      `
    );
    console.log("kill_events_feud_alliance_idx applied.");

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_rivals_killer_guild_idx"
        ON "kill_events" ("region", "killer_guild_albion_id", "occurred_at" DESC)
        WHERE "total_victim_kill_fame" > 0
          AND "killer_guild_albion_id" IS NOT NULL
      `
    );
    console.log("kill_events_rivals_killer_guild_idx applied.");

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_rivals_victim_guild_idx"
        ON "kill_events" ("region", "victim_guild_albion_id", "occurred_at" DESC)
        WHERE "total_victim_kill_fame" > 0
          AND "victim_guild_albion_id" IS NOT NULL
      `
    );
    console.log("kill_events_rivals_victim_guild_idx applied.");
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
