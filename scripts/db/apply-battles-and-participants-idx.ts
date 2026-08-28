/**
 * Apply battles feed + player-analytics indexes.
 * Usage: npm run db:apply-battles-and-participants-idx (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "battles_region_start_time_idx"
        ON "battles" ("region", "start_time" DESC NULLS LAST);
      CREATE INDEX IF NOT EXISTS "kill_participants_player_idx"
        ON "kill_participants" ("player_id");
    `);
    console.log("battles_region_start_time_idx and kill_participants_player_idx applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
