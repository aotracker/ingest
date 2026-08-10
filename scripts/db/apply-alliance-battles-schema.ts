/**
 * Apply alliance battles cache columns (drizzle migrate may conflict on older DBs).
 * Usage: npm run db:apply-alliance-battles (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "kill_fame" bigint DEFAULT 0;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "death_fame" bigint DEFAULT 0;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "top_battles_payload" jsonb;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "recent_battles_payload" jsonb;
      ALTER TABLE "alliances" ADD COLUMN IF NOT EXISTS "battles_last_synced_at" timestamp with time zone;
    `);
    console.log("Alliance battles columns applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
