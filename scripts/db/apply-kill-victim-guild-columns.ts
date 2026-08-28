/**
 * Denormalize victim guild onto kill_events and backfill from payload /
 * participant rows so compacted kill cards keep kill-time guilds.
 * Usage: npm run db:apply-kill-victim-guild-columns (from ingest/, OVH VM or local)
 */
import { withDatabaseUrl } from "./with-database-url";

const BACKFILL_BATCH = 2000;

async function main() {
  await withDatabaseUrl(async (sql) => {
    await sql.unsafe(`
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "victim_guild_albion_id" text;
      ALTER TABLE "kill_events" ADD COLUMN IF NOT EXISTS "victim_guild_name" text
    `);
    console.log("kill_events victim guild columns ready.");

    let payloadBackfilled = 0;
    for (;;) {
      const updated = await sql.unsafe(`
        WITH batch AS (
          SELECT id
          FROM kill_events
          WHERE raw_payload IS NOT NULL
            AND (
              (
                victim_guild_name IS NULL
                AND NULLIF(BTRIM(raw_payload->'Victim'->>'GuildName'), '') IS NOT NULL
              )
              OR (
                victim_guild_albion_id IS NULL
                AND NULLIF(BTRIM(raw_payload->'Victim'->>'GuildId'), '') IS NOT NULL
              )
            )
          LIMIT ${BACKFILL_BATCH}
        )
        UPDATE kill_events ke
        SET
          victim_guild_albion_id = COALESCE(
            ke.victim_guild_albion_id,
            NULLIF(BTRIM(ke.raw_payload->'Victim'->>'GuildId'), '')
          ),
          victim_guild_name = COALESCE(
            ke.victim_guild_name,
            NULLIF(BTRIM(ke.raw_payload->'Victim'->>'GuildName'), '')
          )
        FROM batch
        WHERE ke.id = batch.id
        RETURNING ke.id
      `);
      const count = updated.length;
      if (count === 0) break;
      payloadBackfilled += count;
      console.log(`victim guild payload backfill: ${payloadBackfilled} rows`);
    }

    let participantBackfilled = 0;
    for (;;) {
      const updated = await sql.unsafe(`
        WITH batch AS (
          SELECT ke.id
          FROM kill_events ke
          JOIN kill_participants kp
            ON kp.event_id = ke.id AND kp.role = 'victim'
          WHERE (
              (
                ke.victim_guild_name IS NULL
                AND NULLIF(BTRIM(kp.guild_name), '') IS NOT NULL
              )
              OR (
                ke.victim_guild_albion_id IS NULL
                AND NULLIF(BTRIM(kp.raw_payload->>'GuildId'), '') IS NOT NULL
              )
            )
          LIMIT ${BACKFILL_BATCH}
        )
        UPDATE kill_events ke
        SET
          victim_guild_albion_id = COALESCE(
            ke.victim_guild_albion_id,
            NULLIF(BTRIM(kp.raw_payload->>'GuildId'), '')
          ),
          victim_guild_name = COALESCE(
            ke.victim_guild_name,
            NULLIF(BTRIM(kp.guild_name), '')
          )
        FROM batch
        JOIN kill_participants kp
          ON kp.event_id = batch.id AND kp.role = 'victim'
        WHERE ke.id = batch.id
        RETURNING ke.id
      `);
      const count = updated.length;
      if (count === 0) break;
      participantBackfilled += count;
      console.log(
        `victim guild participant backfill: ${participantBackfilled} rows`
      );
    }
  }, { endTimeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
