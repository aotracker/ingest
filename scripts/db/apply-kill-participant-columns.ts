/**
 * Participant denormalized cols + drop unused kill_items.participant_id FK.
 * Ingest writes participant_id without restoring that FK (retention deletes by event_id).
 * Usage: npm run db:apply-kill-participant-columns (from ingest/, OVH VM or local)
 */
import { withDatabaseUrl } from "./with-database-url";

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "kill_participants" ADD COLUMN IF NOT EXISTS "guild_albion_id" text;
      ALTER TABLE "kill_participants" ADD COLUMN IF NOT EXISTS "alliance_id" text;
      ALTER TABLE "kill_participants" ADD COLUMN IF NOT EXISTS "alliance_tag" text;
      CREATE INDEX IF NOT EXISTS "kill_participants_guild_albion_id_idx"
        ON "kill_participants" ("guild_albion_id");
      ALTER TABLE "kill_items" DROP CONSTRAINT IF EXISTS "kill_items_participant_id_kill_participants_id_fk";
    `);
    console.log("kill_participants storage columns and kill_items FK drop applied.");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
