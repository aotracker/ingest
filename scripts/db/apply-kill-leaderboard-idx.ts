/**
 * Covering indexes for killer/fame leaderboard aggregations.
 * Usage: npm run db:apply-kill-leaderboard-idx (from ingest/, OVH VM or local)
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
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_lb_killer_idx"
        ON "kill_events" ("occurred_at" DESC, "killer_id")
        INCLUDE ("total_victim_kill_fame", "region", "content_type")
        WHERE "total_victim_kill_fame" > 0 AND "killer_id" IS NOT NULL
      `
    );
    console.log("kill_events_lb_killer_idx applied.");

    await createIndex(
      sql,
      `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "kill_events_lb_fame_idx"
        ON "kill_events" ("total_victim_kill_fame" DESC, "occurred_at")
        WHERE "total_victim_kill_fame" > 0
      `
    );
    console.log("kill_events_lb_fame_idx applied.");
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
