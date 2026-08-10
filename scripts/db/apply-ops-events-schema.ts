/**
 * Apply ops_events table for centralized admin error logging.
 * Usage: npm run db:apply-ops-events (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "ops_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "source" text NOT NULL,
        "severity" text NOT NULL,
        "category" text,
        "region" "region",
        "message" text NOT NULL,
        "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "ops_events_created_idx" ON "ops_events" ("created_at");
      CREATE INDEX IF NOT EXISTS "ops_events_source_severity_idx" ON "ops_events" ("source", "severity", "created_at");
    `);
    console.log("ops_events schema applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
