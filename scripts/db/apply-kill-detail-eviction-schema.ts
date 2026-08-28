/**
 * Kill detail eviction column + drop unused background_jobs.
 * Usage: npm run db:apply-kill-detail-eviction (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "kill_events" ALTER COLUMN "raw_payload" DROP NOT NULL;
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "detail_evicted_at" timestamp with time zone;
      CREATE INDEX IF NOT EXISTS "kill_events_detail_evict_idx"
        ON "kill_events" ("occurred_at", "detail_evicted_at");
      DROP TABLE IF EXISTS "background_jobs";
    `);
    console.log("Kill detail eviction schema applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
