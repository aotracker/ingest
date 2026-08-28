/**
 * Apply alliance battles cache columns (drizzle migrate may conflict on older DBs).
 * Usage: npm run db:apply-alliance-battles (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "kill_fame" bigint DEFAULT 0;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "death_fame" bigint DEFAULT 0;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "top_battles_payload" jsonb;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "recent_battles_payload" jsonb;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "battles_last_synced_at" timestamp with time zone;
    `);
    console.log("Alliance battles columns applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
