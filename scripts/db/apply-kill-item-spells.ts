/**
 * Drop the unused kill_items.spells column.
 * Usage: npm run db:apply-kill-item-spells (from ingest/, OVH VM or local dev)
 *
 * The bounded lock timeout prevents this migration from waiting indefinitely
 * behind ingest, retention, or other long-running database work.
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      SET lock_timeout = '5s';
      ALTER TABLE "kill_items"
        DROP COLUMN IF EXISTS "spells";
    `);
    console.log("kill_items.spells removed.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
