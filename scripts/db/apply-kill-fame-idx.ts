/**
 * Apply partial index for positive-fame kill list queries.
 * Usage: npm run db:apply-kill-fame-idx (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "kill_events_region_occurred_fame_idx"
        ON "kill_events" ("region", "occurred_at" DESC)
        WHERE "total_victim_kill_fame" > 0;
    `);
    console.log("kill_events_region_occurred_fame_idx applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
