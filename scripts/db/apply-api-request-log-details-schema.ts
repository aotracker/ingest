/**
 * Add details jsonb column to api_request_logs for structured Albion API errors.
 * Usage: npm run db:apply-api-request-log-details (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "api_request_logs" ADD COLUMN IF NOT EXISTS "details" jsonb DEFAULT '{}'::jsonb NOT NULL;
    `);
    console.log("api_request_logs.details column applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
