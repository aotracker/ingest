/**
 * Apply kill_events battle + alliance lookup indexes.
 * Usage: npm run db:apply-kill-events-battle-idx (from ingest/, OVH VM or local dev)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS "kill_events_battle_id_idx"
        ON "kill_events" ("battle_id");
      CREATE INDEX IF NOT EXISTS "kill_events_region_albion_battle_idx"
        ON "kill_events" ("region", "albion_battle_id")
        WHERE "albion_battle_id" IS NOT NULL;
      CREATE INDEX IF NOT EXISTS "guilds_alliance_idx"
        ON "guilds" ("region", "alliance_id");
      CREATE INDEX IF NOT EXISTS "players_alliance_idx"
        ON "players" ("alliance_id");
      CREATE INDEX IF NOT EXISTS "battles_detail_sync_unavailable_idx"
        ON "battles" ("detail_sync_unavailable")
        WHERE "detail_sync_unavailable" = 1;
    `);
    console.log(
      "kill_events battle, guild/player alliance, and battles unavailable indexes applied."
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
