/**
 * Applies api_sync_state health column migration (0014) idempotently.
 * Usage: npm run db:apply-api-sync-health (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  const statements = [
    `ALTER TABLE api_sync_state ADD COLUMN IF NOT EXISTS last_ingest_at timestamptz;`,
    `ALTER TABLE api_sync_state ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz;`,
    `ALTER TABLE api_sync_state ADD COLUMN IF NOT EXISTS last_health_check_ok integer DEFAULT 0;`,
    `UPDATE api_sync_state
     SET last_ingest_at = last_success_at
     WHERE last_ingest_at IS NULL
       AND last_success_at IS NOT NULL;`,
  ];

  await withDatabaseUrl(async (sql) => {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    console.log("[db] api_sync_state health columns applied");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
