/**
 * Apply external_feed_cache table for ingest-owned RSS/JSON feed snapshots.
 * Usage: npm run db:apply-external-feed-cache (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "external_feed_cache" (
        "feed_key" text PRIMARY KEY NOT NULL,
        "items" jsonb NOT NULL,
        "fetched_at" timestamp with time zone,
        "last_error" text,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
    console.log("external_feed_cache schema applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
