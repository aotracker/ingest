/**
 * Add user.preferred_region for synced feed region preference.
 * Usage: npm run db:apply-user-preferred-region (from ingest/)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "user"
        ADD COLUMN IF NOT EXISTS "preferred_region" text;
    `);
    console.log('user.preferred_region ready.');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
