/**
 * Apply battle detail eviction column + index.
 * Usage: npm run db:apply-battle-detail-eviction (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "detail_evicted_at" timestamp with time zone;
      CREATE INDEX IF NOT EXISTS "battles_detail_evict_idx"
        ON "battles" ("end_time", "detail_evicted_at");
    `);
    console.log("Battle detail eviction schema applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
