/**
 * Apply battle detail eviction column + index.
 * Usage: npm run db:apply-battle-detail-eviction (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "detail_evicted_at" timestamp with time zone;
      CREATE INDEX IF NOT EXISTS "battles_detail_evict_idx"
        ON "battles" ("end_time", "detail_evicted_at");
    `);
    console.log("Battle detail eviction schema applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
