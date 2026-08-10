/**
 * Apply battle detail sync unavailable columns.
 * Usage: npm run db:apply-battle-detail-unavailable (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "detail_sync_unavailable" integer DEFAULT 0;
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "detail_sync_give_up_at" timestamp with time zone;
      ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "detail_sync_last_error" text;
      CREATE INDEX IF NOT EXISTS "battles_detail_sync_unavailable_idx"
        ON "battles" ("detail_sync_unavailable")
        WHERE "detail_sync_unavailable" = 1;
    `);
    console.log("Battle detail sync unavailable columns applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
