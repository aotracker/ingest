/**
 * Add details jsonb column to api_request_logs for structured Albion API errors.
 * Usage: npm run db:apply-api-request-log-details (from ingest/, OVH VM or local dev)
 */
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`
      ALTER TABLE "api_request_logs" ADD COLUMN IF NOT EXISTS "details" jsonb DEFAULT '{}'::jsonb NOT NULL;
    `);
    console.log("api_request_logs.details column applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
